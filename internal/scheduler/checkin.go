package scheduler

import (
	"context"
	"strings"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

func (s *Scheduler) AutoCheckInEnabled() bool {
	val, err := s.store.GetSetting("auto_checkin_enabled")
	return err == nil && val == "1"
}

func (s *Scheduler) ConsentedAt() string {
	val, _ := s.store.GetSetting("auto_checkin_consented_at")
	return val
}

func (s *Scheduler) SetAutoCheckIn(enabled, agreed bool) {
	val := "0"
	if enabled {
		val = "1"
	}
	_ = s.store.SetSetting("auto_checkin_enabled", val)
	if enabled && agreed {
		_ = s.store.SetSetting("auto_checkin_consented_at", core.FormatISO(s.clock.Now()))
	}
	if !enabled {
		s.clearPending()
	}
	s.signalCheckInLoop()
	s.publishRuntime(api.InvalidateCheckIn, api.InvalidateNextTarget)
}

func (s *Scheduler) CheckInStatus() core.CheckInStatus {
	return core.CheckInStatus{
		Enabled:        s.AutoCheckInEnabled(),
		ConsentVersion: ConsentVersion,
		ConsentedAt:    s.ConsentedAt(),
	}
}

func (s *Scheduler) NextCheckIn() (bookingID string, nextAtMs int64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.pending {
		if !ok || p.NextAtMs < nextAtMs {
			ok = true
			bookingID = p.BookingID
			nextAtMs = p.NextAtMs
		}
	}
	return bookingID, nextAtMs, ok
}

func (s *Scheduler) ObserveBookings(bookings []hdu.RawBooking) {
	s.ObserveBookingsAt(bookings, s.clock.Now())
}

func (s *Scheduler) ObserveBookingsAt(bookings []hdu.RawBooking, now time.Time) {
	if !s.AutoCheckInEnabled() {
		s.clearPending()
		return
	}
	nowMs := now.UnixMilli()
	changed := false
	var toUpsert []core.PendingCheckIn
	var toDelete []string

	s.mu.Lock()
	seen := make(map[string]bool)
	for _, b := range bookings {
		id := strings.TrimSpace(b.ID.String())
		beginMs := int64(b.Time) * 1000
		deadlineMs := beginMs + int64(b.LimitSignBack)*1000
		if id == "" || beginMs <= 0 || deadlineMs <= nowMs {
			continue
		}
		if strings.TrimSpace(b.Status.String()) != "0" {
			continue
		}
		seen[id] = true
		nextAt := beginMs + checkInOffset.Milliseconds()
		if nextAt < nowMs+500 {
			nextAt = nowMs + 500
		}
		if existing, ok := s.pending[id]; ok {
			updated := false
			if existing.BeginMs != beginMs || existing.DeadlineMs != deadlineMs {
				existing.BeginMs = beginMs
				existing.DeadlineMs = deadlineMs
				updated = true
			}
			if nextAt < existing.NextAtMs {
				existing.NextAtMs = nextAt
				updated = true
			}
			if updated {
				changed = true
				toUpsert = append(toUpsert, *existing)
			}
		} else {
			entry := &core.PendingCheckIn{
				BookingID:  id,
				BeginMs:    beginMs,
				DeadlineMs: deadlineMs,
				NextAtMs:   nextAt,
			}
			s.pending[id] = entry
			changed = true
			toUpsert = append(toUpsert, *entry)
		}
	}
	for id := range s.pending {
		if !seen[id] {
			delete(s.pending, id)
			changed = true
			toDelete = append(toDelete, id)
		}
	}
	s.mu.Unlock()

	if s.store != nil {
		for _, p := range toUpsert {
			_ = s.store.UpsertPendingCheckIn(p)
		}
		for _, id := range toDelete {
			_ = s.store.DeletePendingCheckIn(id)
		}
	}
	if changed {
		s.signalCheckInLoop()
		s.publishRuntime(api.InvalidateNextTarget)
	}
}

func (s *Scheduler) NoteCheckedIn(bookingID string) {
	s.mu.Lock()
	_, existed := s.pending[bookingID]
	delete(s.pending, bookingID)
	s.mu.Unlock()
	if s.store != nil {
		_ = s.store.DeletePendingCheckIn(bookingID)
	}
	if existed {
		_ = s.store.WriteAudit("checkin_succeeded", map[string]any{
			"bookingId": bookingID,
			"source":    "manual",
		})
		s.signalCheckInLoop()
		s.publishRuntime(api.InvalidateNextTarget)
	}
}

func (s *Scheduler) Forget(bookingID string) {
	s.mu.Lock()
	_, existed := s.pending[bookingID]
	delete(s.pending, bookingID)
	s.mu.Unlock()
	if s.store != nil {
		_ = s.store.DeletePendingCheckIn(bookingID)
	}
	if existed {
		s.signalCheckInLoop()
		s.publishRuntime(api.InvalidateNextTarget)
	}
}

// ClearPending drops all queued auto check-ins and notifies listeners if any existed.
func (s *Scheduler) ClearPending() {
	s.clearPending()
}

func (s *Scheduler) clearPending() {
	s.mu.Lock()
	had := len(s.pending) > 0
	s.pending = make(map[string]*core.PendingCheckIn)
	s.mu.Unlock()
	if s.store != nil {
		_ = s.store.ClearPendingCheckIns()
	}
	if had {
		s.signalCheckInLoop()
		s.publishRuntime(api.InvalidateNextTarget)
	}
}

// SyncAsync triggers check-in synchronization in the background under the scheduler's lifecycle context.
func (s *Scheduler) SyncAsync() {
	go s.SyncCheckIns(s.lifecycleCtx())
}

func (s *Scheduler) SyncCheckIns(ctx context.Context) {
	if !s.AutoCheckInEnabled() {
		s.clearPending()
		return
	}
	if delay := syncPeakDelay(s.clock.Now(), checkInSyncPeakWindow); delay > 0 {
		if !s.sleep(ctx, delay) {
			return
		}
	}
	for i := 0; i <= len(syncRetryDelays); i++ {
		if i > 0 && !s.sleep(ctx, syncRetryDelays[i-1]) {
			return
		}
		if s.syncCheckInsOnce(ctx, i < len(syncRetryDelays)) {
			return
		}
	}
}

func syncPeakDelay(now time.Time, window time.Duration) time.Duration {
	if window <= 0 {
		return 0
	}
	t := now.In(core.Shanghai)
	anchor := time.Date(t.Year(), t.Month(), t.Day(), core.BookingAnchorHour, 0, 0, 0, core.Shanghai)
	end := anchor.Add(window)
	if !t.Before(anchor) && t.Before(end) {
		return end.Sub(t)
	}
	return 0
}

func (s *Scheduler) syncCheckInsOnce(ctx context.Context, allowRetry bool) bool {
	if !s.AutoCheckInEnabled() {
		s.clearPending()
		return true
	}
	if !s.auth.Authenticated() && !s.auth.Restore(ctx) {
		s.setState("auth_required")
		return true
	}
	items, err := s.auth.Client.Bookings(ctx)
	if err == nil {
		s.ObserveBookings(items)
		s.setState("idle")
		s.touchLastRunAt()
		return true
	}
	if ctx.Err() != nil {
		return true
	}
	if hdu.IsAuthExpired(err) {
		if s.auth.Restore(ctx) {
			if !allowRetry {
				s.auditSyncFailure("登录状态已刷新，同步重试已耗尽")
			}
			return !allowRetry
		}
		s.setState("auth_required")
		s.auditSyncFailure("登录状态已失效")
		return true
	}
	willRetry := allowRetry && hdu.IsRetryableSyncError(err)
	if !willRetry {
		s.auditSyncFailure(err.Error())
	}
	return !willRetry
}

func (s *Scheduler) auditSyncFailure(msg string) {
	_ = s.store.WriteAudit("checkin_sync_failed", map[string]any{
		"error":     msg,
		"willRetry": false,
	})
}

func (s *Scheduler) checkinLoop(ctx context.Context) {
	for {
		var wait time.Duration
		if !s.AutoCheckInEnabled() {
			wait = 30 * time.Second
		} else if _, nextMs, ok := s.NextCheckIn(); !ok {
			wait = 300 * time.Second
		} else {
			wait = max(time.Duration(nextMs-s.clock.Now().UnixMilli())*time.Millisecond, 250*time.Millisecond)
		}

		t := time.NewTimer(wait)
		select {
		case <-ctx.Done():
			t.Stop()
			return
		case <-s.wakeCheckIn:
			t.Stop()
			continue
		case <-t.C:
		}
		s.checkinTick(ctx)
	}
}

func (s *Scheduler) checkinTick(ctx context.Context) {
	if !s.AutoCheckInEnabled() {
		s.clearPending()
		return
	}
	nowMs := s.clock.Now().UnixMilli()
	s.mu.Lock()
	var due []core.PendingCheckIn
	for _, p := range s.pending {
		if p.NextAtMs <= nowMs {
			due = append(due, *p)
		}
	}
	s.mu.Unlock()
	if len(due) == 0 {
		return
	}
	if !s.auth.Authenticated() && !s.auth.Restore(ctx) {
		for _, item := range due {
			s.updateNextAt(item.BookingID, nowMs+checkInAuthRetry.Milliseconds())
		}
		return
	}

	for _, item := range due {
		if nowMs > item.DeadlineMs {
			s.finishMissed(item, "已过签到窗口")
			continue
		}
		_, err := s.auth.Client.Action(ctx, hdu.ActionCheckIn, item.BookingID)
		if err == nil {
			s.finishCheckInSuccess(item.BookingID, "")
			continue
		}

		msg := err.Error()
		switch {
		case hdu.IsAlreadyCheckedIn(err):
			s.finishCheckInSuccess(item.BookingID, msg)
		case hdu.IsNotPending(err):
			s.reconcileNonPending(ctx, item.BookingID, msg, nowMs)
		case hdu.IsBanned(err):
			s.updateNextAt(item.BookingID, nowMs+checkInBan.Milliseconds())
			_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": item.BookingID, "error": msg})
		case hdu.IsAuthExpired(err):
			nextDelay := checkInAuthRetry
			if s.auth.Restore(ctx) {
				nextDelay = checkInWritePoll
			}
			s.updateNextAt(item.BookingID, nowMs+nextDelay.Milliseconds())
			_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": item.BookingID, "error": msg})
		default:
			s.updateNextAt(item.BookingID, nowMs+checkInWritePoll.Milliseconds())
			_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": item.BookingID, "error": msg})
		}
	}
}

func (s *Scheduler) finishCheckInSuccess(bookingID, msg string) {
	s.Forget(bookingID)
	s.setMessage("已自动签到：" + bookingID)
	payload := map[string]any{"bookingId": bookingID}
	if msg != "" {
		payload["message"] = msg
	}
	_ = s.store.WriteAudit("checkin_succeeded", payload)
	s.publishNotification(core.Notification{
		Level: core.NotifySuccess,
		Title: "自动签到成功",
		Body:  "预约 " + bookingID + " 已完成签到",
	}, api.InvalidateBookings, api.InvalidateNextTarget, api.InvalidateCheckIn)
}

func (s *Scheduler) reconcileNonPending(ctx context.Context, bookingID, msg string, nowMs int64) {
	items, err := s.auth.Client.Bookings(ctx)
	if err != nil {
		s.updateNextAt(bookingID, nowMs+checkInWritePoll.Milliseconds())
		_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": bookingID, "error": msg})
		return
	}
	s.ObserveBookings(items)
	var status string
	for _, it := range items {
		if strings.TrimSpace(it.ID.String()) == bookingID {
			status = strings.TrimSpace(it.Status.String())
			break
		}
	}
	if status == "1" || status == "2" {
		s.setMessage("已自动签到：" + bookingID)
		_ = s.store.WriteAudit("checkin_succeeded", map[string]any{
			"bookingId": bookingID,
			"source":    "synced",
			"message":   msg,
		})
		s.publishNotification(core.Notification{
			Level: core.NotifySuccess,
			Title: "自动签到成功",
			Body:  "预约 " + bookingID + " 已完成签到",
		}, api.InvalidateBookings, api.InvalidateNextTarget, api.InvalidateCheckIn)
		return
	}
	s.mu.Lock()
	_, stillPending := s.pending[bookingID]
	s.mu.Unlock()
	if stillPending && status == "0" {
		s.updateNextAt(bookingID, nowMs+checkInWritePoll.Milliseconds())
		_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": bookingID, "error": msg})
		return
	}
	s.Forget(bookingID)
	s.setMessage("签到已停止（" + bookingID + "）：" + msg)
	_ = s.store.WriteAudit("checkin_failed", map[string]any{
		"bookingId": bookingID,
		"error":     msg,
		"terminal":  true,
	})
	s.publishNotification(core.Notification{
		Level: core.NotifyError,
		Title: "自动签到已停止",
		Body:  msg,
	}, api.InvalidateBookings, api.InvalidateNextTarget, api.InvalidateCheckIn)
}

func (s *Scheduler) updateNextAt(bookingID string, nextAtMs int64) {
	var updated *core.PendingCheckIn
	s.mu.Lock()
	if p, ok := s.pending[bookingID]; ok {
		p.Attempts++
		p.NextAtMs = nextAtMs
		cp := *p
		updated = &cp
	}
	s.mu.Unlock()
	if updated != nil {
		if s.store != nil {
			_ = s.store.UpsertPendingCheckIn(*updated)
		}
		s.signalCheckInLoop()
		s.publishRuntime(api.InvalidateNextTarget)
	}
}

func (s *Scheduler) finishMissed(item core.PendingCheckIn, reason string) {
	s.Forget(item.BookingID)
	s.setMessage("未签到：" + reason)
	_ = s.store.WriteAudit("checkin_missed", map[string]any{
		"bookingId": item.BookingID,
		"begin":     item.BeginMs,
		"deadline":  item.DeadlineMs,
		"attempts":  item.Attempts,
		"reason":    reason,
	})
	s.publishNotification(core.Notification{
		Level: core.NotifyWarning,
		Title: "自动签到超时",
		Body:  reason,
	}, api.InvalidateBookings, api.InvalidateNextTarget, api.InvalidateCheckIn)
}
