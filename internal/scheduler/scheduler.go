package scheduler

import (
	"context"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
	"hdu-library-sniper/internal/store"
)

const (
	ConsentVersion = "2026-08-02.1"

	checkInOffset         = 60 * time.Second
	checkInWritePoll      = 10 * time.Second
	checkInAuthRetry      = 10 * time.Minute
	checkInBan            = 10 * time.Minute
	checkInSyncPeakWindow = 60 * time.Second
)

var syncRetryDelays = []time.Duration{
	5 * time.Second,
	15 * time.Second,
	30 * time.Second,
	60 * time.Second,
	60 * time.Second,
}

type pendingCheckIn struct {
	bookingID  string
	beginMs    int64
	deadlineMs int64
	attempts   uint32
	nextAtMs   int64
}

// Scheduler drives 19:59 prelock, 20:00 burst booking, and auto check-in polling.
type Scheduler struct {
	store   *store.Store
	auth    *auth.Service
	booking *booking.Executor
	running atomic.Bool

	nowFn   func() time.Time
	sleepFn func(context.Context, time.Duration) bool

	mu          sync.Mutex
	baseCtx     context.Context
	scheduler   string
	state       string
	lastRunAt   string
	lastMessage string
	pending     map[string]*pendingCheckIn
	onChange    func(core.RuntimeStatus, []string)
}

func New(st *store.Store, authSvc *auth.Service, exec *booking.Executor) *Scheduler {
	return &Scheduler{
		store:     st,
		auth:      authSvc,
		booking:   exec,
		nowFn:     time.Now,
		sleepFn:   sleepWithContext,
		scheduler: "running",
		state:     "idle",
		pending:   make(map[string]*pendingCheckIn),
	}
}

// SetOnChange registers a listener invoked when runtime status or scheduled targets change.
func (s *Scheduler) SetOnChange(fn func(core.RuntimeStatus, []string)) {
	s.mu.Lock()
	s.onChange = fn
	s.mu.Unlock()
}

func (s *Scheduler) notifyChange(invalidate ...string) {
	s.mu.Lock()
	fn := s.onChange
	s.mu.Unlock()
	if fn != nil {
		fn(s.Status(), invalidate)
	}
}

func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	s.baseCtx = ctx
	s.mu.Unlock()
	go s.SyncCheckIns(ctx)
	go s.bookingLoop(ctx)
	go s.checkinLoop(ctx)
}

func (s *Scheduler) AutoCheckInEnabled() bool {
	val, err := s.store.GetMeta("auto_checkin_enabled")
	return err == nil && val == "1"
}

func (s *Scheduler) ConsentedAt() string {
	val, _ := s.store.GetMeta("auto_checkin_consented_at")
	return val
}

func (s *Scheduler) SetAutoCheckIn(enabled, agreed bool) {
	val := "0"
	if enabled {
		val = "1"
	}
	_ = s.store.SetMeta("auto_checkin_enabled", val)
	if enabled && agreed {
		_ = s.store.SetMeta("auto_checkin_consented_at", core.FormatISO(time.Now()))
	}
	if !enabled {
		s.mu.Lock()
		s.pending = make(map[string]*pendingCheckIn)
		s.mu.Unlock()
	}
	s.notifyChange("checkin", "nextTarget")
}

func (s *Scheduler) CheckInStatus() core.CheckInStatus {
	return core.CheckInStatus{
		Enabled:        s.AutoCheckInEnabled(),
		ConsentVersion: ConsentVersion,
		ConsentedAt:    s.ConsentedAt(),
	}
}

func (s *Scheduler) Status() core.RuntimeStatus {
	bookingID, nextMs, hasNext := s.NextCheckIn()
	_ = bookingID

	s.mu.Lock()
	st := core.RuntimeStatus{
		Scheduler:   s.scheduler,
		State:       s.state,
		LastRunAt:   s.lastRunAt,
		LastMessage: s.lastMessage,
		CheckInPolling: &core.CheckInPolling{
			Active: hasNext,
		},
	}
	s.mu.Unlock()

	if hasNext {
		st.CheckInPolling.NextPollAt = core.FormatISOMillis(nextMs)
	}
	return st
}

func (s *Scheduler) NextCheckIn() (bookingID string, nextAtMs int64, ok bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, p := range s.pending {
		if !ok || p.nextAtMs < nextAtMs {
			ok = true
			bookingID = p.bookingID
			nextAtMs = p.nextAtMs
		}
	}
	return bookingID, nextAtMs, ok
}

func (s *Scheduler) NextExecutionTarget() core.NextExecutionTarget {
	now := time.Now()
	var bookingCandidate *core.NextExecutionTarget
	var bookingMs int64

	if items, err := s.store.ListPlanItems(); err == nil {
		for _, it := range items {
			if !it.IsEnabled() {
				continue
			}
			delay := core.BookingAnchorDelaySeconds(core.ShanghaiSecondsOfDay(now))
			targetTime := now.Add(time.Duration(delay) * time.Second)
			bookingMs = targetTime.UnixMilli()
			bookingCandidate = &core.NextExecutionTarget{
				Kind:   core.NextTargetBooking,
				Label:  "预约",
				At:     core.FormatZh(targetTime),
				PlanID: it.ItemID(),
			}
			break
		}
	}

	var checkInCandidate *core.NextExecutionTarget
	var checkInMs int64
	if s.AutoCheckInEnabled() {
		if bid, atMs, ok := s.NextCheckIn(); ok {
			checkInMs = atMs
			checkInCandidate = &core.NextExecutionTarget{
				Kind:      core.NextTargetCheckIn,
				Label:     "签到",
				At:        core.FormatZh(time.UnixMilli(atMs)),
				BookingID: bid,
			}
		}
	}

	switch {
	case bookingCandidate != nil && checkInCandidate != nil:
		if bookingMs <= checkInMs {
			return *bookingCandidate
		}
		return *checkInCandidate
	case bookingCandidate != nil:
		return *bookingCandidate
	case checkInCandidate != nil:
		return *checkInCandidate
	default:
		return core.NextExecutionTarget{
			Kind:  core.NextTargetNone,
			Label: "暂无待执行任务",
		}
	}
}

func (s *Scheduler) ObserveBookings(bookings []map[string]any) {
	s.ObserveBookingsAt(bookings, time.Now())
}

func (s *Scheduler) ObserveBookingsAt(bookings []map[string]any, now time.Time) {
	if !s.AutoCheckInEnabled() {
		s.clearPending()
		return
	}
	nowMs := now.UnixMilli()
	changed := false
	s.mu.Lock()
	seen := make(map[string]bool)
	for _, b := range bookings {
		id := strings.TrimSpace(core.ToString(b["id"]))
		beginMs := core.ToInt64(b["time"]) * 1000
		deadlineMs := beginMs + core.ToInt64(b["limitSignBack"])*1000
		if id == "" || beginMs <= 0 || deadlineMs <= nowMs {
			continue
		}
		if strings.TrimSpace(core.ToString(b["status"])) != "0" {
			continue
		}
		seen[id] = true
		nextAt := beginMs + checkInOffset.Milliseconds()
		if nextAt < nowMs+500 {
			nextAt = nowMs + 500
		}
		if existing, ok := s.pending[id]; ok {
			if existing.beginMs != beginMs || existing.deadlineMs != deadlineMs {
				existing.beginMs = beginMs
				existing.deadlineMs = deadlineMs
				changed = true
			}
			if nextAt < existing.nextAtMs {
				existing.nextAtMs = nextAt
				changed = true
			}
		} else {
			s.pending[id] = &pendingCheckIn{
				bookingID:  id,
				beginMs:    beginMs,
				deadlineMs: deadlineMs,
				nextAtMs:   nextAt,
			}
			changed = true
		}
	}
	for id := range s.pending {
		if !seen[id] {
			delete(s.pending, id)
			changed = true
		}
	}
	s.mu.Unlock()
	if changed {
		s.notifyChange("nextTarget")
	}
}

func (s *Scheduler) NoteCheckedIn(bookingID string) {
	s.mu.Lock()
	_, existed := s.pending[bookingID]
	delete(s.pending, bookingID)
	s.mu.Unlock()
	if existed {
		_ = s.store.WriteAudit("checkin_succeeded", map[string]any{
			"bookingId": bookingID,
			"source":    "manual",
		})
		s.notifyChange("nextTarget")
	}
}

func (s *Scheduler) Forget(bookingID string) {
	s.mu.Lock()
	_, existed := s.pending[bookingID]
	delete(s.pending, bookingID)
	s.mu.Unlock()
	if existed {
		s.notifyChange("nextTarget")
	}
}

// SyncAsync triggers check-in synchronization in the background under the scheduler's
// lifecycle context so HTTP response completion does not cancel waits or retries.
func (s *Scheduler) SyncAsync() {
	go s.SyncCheckIns(s.lifecycleCtx())
}

func (s *Scheduler) SyncCheckIns(ctx context.Context) {
	if !s.AutoCheckInEnabled() {
		s.clearPending()
		return
	}
	if delay := syncPeakDelay(s.now(), checkInSyncPeakWindow); delay > 0 {
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

// ClearPending drops all queued auto check-ins and notifies listeners if any existed.
func (s *Scheduler) ClearPending() {
	s.clearPending()
}

// ClearAuthRequired resets scheduler state from "auth_required" to "idle" after authentication updates.
func (s *Scheduler) ClearAuthRequired() {
	s.mu.Lock()
	changed := s.state == "auth_required"
	if changed {
		s.state = "idle"
	}
	s.mu.Unlock()
	if changed {
		s.notifyChange()
	}
}

func (s *Scheduler) clearPending() {
	s.mu.Lock()
	had := len(s.pending) > 0
	s.pending = make(map[string]*pendingCheckIn)
	s.mu.Unlock()
	if had {
		s.notifyChange("nextTarget")
	}
}

func (s *Scheduler) auditSyncFailure(msg string) {
	_ = s.store.WriteAudit("checkin_sync_failed", map[string]any{
		"error":     msg,
		"willRetry": false,
	})
}

func (s *Scheduler) now() time.Time {
	if s.nowFn != nil {
		return s.nowFn()
	}
	return time.Now()
}

func (s *Scheduler) sleep(ctx context.Context, d time.Duration) bool {
	if s.sleepFn != nil {
		return s.sleepFn(ctx, d)
	}
	return sleepWithContext(ctx, d)
}

func (s *Scheduler) lifecycleCtx() context.Context {
	s.mu.Lock()
	ctx := s.baseCtx
	s.mu.Unlock()
	if ctx != nil {
		return ctx
	}
	return context.Background()
}

// syncPeakDelay waits out the 20:00:00–20:01:00 Asia/Shanghai opening surge so
// post-booking sync does not collide with campus-wide snatch traffic.
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

// syncCheckInsOnce returns true if syncing is done (either succeeded or permanently stopped).
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

func (s *Scheduler) RunNow(ctx context.Context) (bool, string) {
	if !s.running.CompareAndSwap(false, true) {
		return false, "已有任务正在运行"
	}
	defer s.running.Store(false)

	if !s.auth.Authenticated() && !s.auth.Restore(ctx) {
		s.setState("auth_required")
		return false, "登录状态已失效，请重新登录"
	}
	s.setState("running")
	res := s.booking.Run(ctx, s.auth.Client)
	s.setMessage(res.Message)
	s.setState("idle")
	if res.Success {
		s.SyncAsync()
	}
	return res.Success, res.Message
}

func (s *Scheduler) bookingLoop(ctx context.Context) {
	for {
		if !s.hasEnabledPlan() {
			if !sleepWithContext(ctx, 60*time.Second) {
				return
			}
			continue
		}
		prelock := core.BookingPrelockDelaySeconds(core.ShanghaiSecondsOfDay(time.Now()), core.BookingPrelockLeadSeconds)
		if prelock > 0 {
			if !sleepWithContext(ctx, time.Duration(prelock)*time.Second) {
				return
			}
			s.prelockOnce(ctx)
		}
		anchor := core.BookingAnchorDelaySeconds(core.ShanghaiSecondsOfDay(time.Now()))
		if !sleepWithContext(ctx, time.Duration(anchor)*time.Second) {
			return
		}
		if !s.hasEnabledPlan() {
			continue
		}
		if !s.auth.Authenticated() && !s.auth.Restore(ctx) {
			s.setState("auth_required")
			continue
		}
		s.setState("running")
		res := s.booking.RunBurst(ctx, s.auth.Client, 10*time.Minute)
		s.setMessage(res.Message)
		s.setState("idle")
		if res.Success {
			go s.SyncCheckIns(ctx)
		}
	}
}

func (s *Scheduler) prelockOnce(ctx context.Context) {
	if !s.hasEnabledPlan() {
		return
	}
	if !s.auth.Authenticated() && !s.auth.Restore(ctx) {
		_ = s.store.WriteAudit("booking_prelock_skipped", map[string]any{"reason": "登录态失效"})
		return
	}
	res := s.booking.LockOnce(ctx, s.auth.Client)
	s.setMessage(res.Message)
}

func (s *Scheduler) checkinLoop(ctx context.Context) {
	for {
		if !s.AutoCheckInEnabled() {
			if !sleepWithContext(ctx, 30*time.Second) {
				return
			}
			continue
		}
		_, nextMs, ok := s.NextCheckIn()
		if !ok {
			if !sleepWithContext(ctx, 300*time.Second) {
				return
			}
			continue
		}
		delay := max(time.Duration(nextMs-time.Now().UnixMilli())*time.Millisecond, 250*time.Millisecond)
		if !sleepWithContext(ctx, delay) {
			return
		}
		s.checkinTick(ctx)
	}
}

func (s *Scheduler) checkinTick(ctx context.Context) {
	if !s.AutoCheckInEnabled() {
		s.clearPending()
		return
	}
	nowMs := time.Now().UnixMilli()
	s.mu.Lock()
	var due []pendingCheckIn
	for _, p := range s.pending {
		if p.nextAtMs <= nowMs {
			due = append(due, *p)
		}
	}
	s.mu.Unlock()
	if len(due) == 0 {
		return
	}
	if !s.auth.Authenticated() && !s.auth.Restore(ctx) {
		for _, item := range due {
			s.updateNextAt(item.bookingID, nowMs+checkInAuthRetry.Milliseconds())
		}
		return
	}

	for _, item := range due {
		if nowMs > item.deadlineMs {
			s.finishMissed(item, "已过签到窗口")
			continue
		}
		_, err := s.auth.Client.Action(ctx, hdu.ActionCheckIn, item.bookingID)
		if err == nil {
			s.Forget(item.bookingID)
			s.setMessage("已自动签到：" + item.bookingID)
			_ = s.store.WriteAudit("checkin_succeeded", map[string]any{"bookingId": item.bookingID})
			continue
		}

		msg := err.Error()
		switch {
		case strings.Contains(msg, "已签到") || strings.Contains(msg, "重复签到"):
			s.Forget(item.bookingID)
			s.setMessage("已自动签到：" + item.bookingID)
			_ = s.store.WriteAudit("checkin_succeeded", map[string]any{
				"bookingId": item.bookingID,
				"message":   msg,
			})
		case strings.Contains(msg, "非待签到"):
			s.reconcileNonPending(ctx, item.bookingID, msg, nowMs)
		case strings.Contains(msg, "请求过于频繁"):
			s.updateNextAt(item.bookingID, nowMs+checkInBan.Milliseconds())
			_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": item.bookingID, "error": msg})
		case hdu.IsAuthExpired(err):
			nextDelay := checkInAuthRetry
			if s.auth.Restore(ctx) {
				nextDelay = checkInWritePoll
			}
			s.updateNextAt(item.bookingID, nowMs+nextDelay.Milliseconds())
			_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": item.bookingID, "error": msg})
		default:
			s.updateNextAt(item.bookingID, nowMs+checkInWritePoll.Milliseconds())
			_ = s.store.WriteAudit("checkin_failed", map[string]any{"bookingId": item.bookingID, "error": msg})
		}
	}
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
		if core.ToString(it["id"]) == bookingID {
			status = core.ToString(it["status"])
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
}

func (s *Scheduler) updateNextAt(bookingID string, nextAtMs int64) {
	s.mu.Lock()
	p, ok := s.pending[bookingID]
	if ok {
		p.attempts++
		p.nextAtMs = nextAtMs
	}
	s.mu.Unlock()
	if ok {
		s.notifyChange("nextTarget")
	}
}

func (s *Scheduler) finishMissed(item pendingCheckIn, reason string) {
	s.Forget(item.bookingID)
	s.setMessage("未签到：" + reason)
	_ = s.store.WriteAudit("checkin_missed", map[string]any{
		"bookingId": item.bookingID,
		"begin":     item.beginMs,
		"deadline":  item.deadlineMs,
		"attempts":  item.attempts,
		"reason":    reason,
	})
}

func (s *Scheduler) hasEnabledPlan() bool {
	items, err := s.store.ListPlanItems()
	if err != nil {
		return false
	}
	for _, it := range items {
		if it.IsEnabled() {
			return true
		}
	}
	return false
}

func (s *Scheduler) setState(state string) {
	s.mu.Lock()
	changed := s.state != state
	s.state = state
	s.mu.Unlock()
	if changed {
		s.notifyChange()
	}
}

func (s *Scheduler) touchLastRunAt() {
	s.mu.Lock()
	s.lastRunAt = core.FormatISO(time.Now())
	s.mu.Unlock()
	s.notifyChange()
}

func (s *Scheduler) setMessage(msg string) {
	s.mu.Lock()
	s.lastRunAt = core.FormatISO(time.Now())
	s.lastMessage = msg
	s.mu.Unlock()
	s.notifyChange()
}

func sleepWithContext(ctx context.Context, d time.Duration) bool {
	if d <= 0 {
		return ctx.Err() == nil
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}
