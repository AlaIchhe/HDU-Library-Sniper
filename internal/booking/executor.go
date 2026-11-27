package booking

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/events"
	"hdu-library-sniper/internal/hdu"
	"hdu-library-sniper/internal/store"
)

type confirmState int

const (
	confirmUnknown confirmState = iota
	confirmAbsent
	confirmFound
)

// Executor runs immediate, dry-run, 19:59 prelock, and 20:00 burst seat reservations.
type Executor struct {
	store         *store.Store
	bus           *events.Bus
	clock         core.Clock
	writeInterval atomic.Int64 // nanoseconds
	sleepFn       func(context.Context, time.Duration)

	mu          sync.Mutex
	writeSlot   time.Time
	lockedSeats []Lock
}

func NewExecutor(st *store.Store, bus *events.Bus) *Executor {
	return NewExecutorWithOptions(st, bus, core.RealClock{}, sleepContext)
}

func NewExecutorWithOptions(st *store.Store, bus *events.Bus, clock core.Clock, sleepFn func(context.Context, time.Duration)) *Executor {
	if clock == nil {
		clock = core.RealClock{}
	}
	if sleepFn == nil {
		sleepFn = sleepContext
	}
	e := &Executor{
		store:     st,
		bus:       bus,
		clock:     clock,
		sleepFn:   sleepFn,
		writeSlot: clock.Now(),
	}
	e.writeInterval.Store(int64(WriteInterval))
	return e
}

func (e *Executor) SetWriteInterval(d time.Duration) {
	e.writeInterval.Store(int64(d))
}

func sleepContext(ctx context.Context, d time.Duration) {
	if d <= 0 {
		return
	}
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
	case <-t.C:
	}
}

func (e *Executor) pacedWrite(ctx context.Context, fn func() (hdu.ActionResult, error)) (hdu.ActionResult, error) {
	now := e.clock.Now()
	interval := time.Duration(e.writeInterval.Load())

	e.mu.Lock()
	target := e.writeSlot
	if now.After(target) {
		target = now
	}
	e.writeSlot = target.Add(interval)
	e.mu.Unlock()

	if wait := target.Sub(now); wait > 0 {
		e.sleepFn(ctx, wait)
		if ctx.Err() != nil {
			return hdu.ActionResult{}, ctx.Err()
		}
	}
	return fn()
}

func (e *Executor) Run(ctx context.Context, client Client) RunResult {
	return e.RunDry(ctx, client, false)
}

func (e *Executor) RunDry(ctx context.Context, client Client, dryRun bool) RunResult {
	res := e.runAttempt(ctx, client, dryRun, nil)
	if !dryRun {
		e.finishRun(res)
	}
	return res
}

// RunBurst polls at PollInterval after 20:00 while write pacing limits write submissions.
func (e *Executor) RunBurst(ctx context.Context, client Client, timeout time.Duration) RunResult {
	deadline := e.clock.Now().Add(timeout)
	finished := make(map[string]SlotResult)
	unverified := make(map[string]int)
	var busyRounds uint32
	var busySince time.Time

	for {
		res := e.runAttempt(ctx, client, false, finished)
		for _, m := range res.Slots {
			if m.Blocked {
				res.Success = false
				res.Message = m.Message
				e.clearLocks()
				e.finishRun(res)
				return res
			}
			if m.Success || m.Terminal {
				if _, ok := finished[m.SlotID]; !ok {
					finished[m.SlotID] = m
				}
			} else if m.Unverified {
				unverified[m.SlotID]++
				if unverified[m.SlotID] >= 3 {
					if _, ok := finished[m.SlotID]; !ok {
						term := m
						term.Terminal = true
						term.Message = m.Message + "（多次未能确认，停止重试）"
						finished[m.SlotID] = term
					}
				}
			}
		}

		pending := false
		for _, m := range res.Slots {
			if !m.Success && !m.Terminal {
				if _, done := finished[m.SlotID]; !done {
					pending = true
					break
				}
			}
		}
		if res.Success || !pending || !e.clock.Now().Before(deadline) || ctx.Err() != nil {
			e.clearLocks()
			e.finishRun(res)
			return res
		}

		seatQueryBusy := false
		for _, m := range res.Slots {
			if m.SeatQueryBusy {
				seatQueryBusy = true
				break
			}
		}
		if seatQueryBusy {
			busyRounds++
			if busySince.IsZero() {
				busySince = e.clock.Now()
				_ = e.store.WriteAudit("booking_seat_query_busy", map[string]any{
					"reason": "座位图不可用（404 并发保护或请求超时）",
					"at":     "first",
				})
			}
			e.mu.Lock()
			e.writeSlot = e.clock.Now()
			e.mu.Unlock()
		} else if !busySince.IsZero() {
			_ = e.store.WriteAudit("booking_seat_query_recovered", map[string]any{
				"busyRounds": busyRounds,
				"busyMs":     e.clock.Now().Sub(busySince).Milliseconds(),
			})
			busySince = time.Time{}
			busyRounds = 0
		}

		rem := deadline.Sub(e.clock.Now())
		if rem > PollInterval {
			rem = PollInterval
		}
		e.sleepFn(ctx, rem)
	}
}

func (e *Executor) finishRun(res RunResult) {
	_ = e.store.WriteAudit("booking_run_finished", map[string]any{
		"planId":  res.PlanID,
		"slots":   len(res.Slots),
		"success": res.Success,
		"message": res.Message,
	})
	if e.bus == nil {
		return
	}
	notif := &core.Notification{
		Level:     core.NotifyError,
		Title:     "预约失败",
		Body:      res.Message,
		Celebrate: false,
	}
	if res.Success {
		notif.Level = core.NotifySuccess
		notif.Title = "预约成功"
		notif.Celebrate = true
	}
	e.bus.Publish(events.TopicAppEvent, api.AppEvent{
		Kind:         api.AppEventNotification,
		Invalidate:   []api.InvalidateTarget{api.InvalidateBookings, api.InvalidateNextTarget},
		Notification: notif,
	})
}

func (e *Executor) runAttempt(ctx context.Context, client Client, dryRun bool, finished map[string]SlotResult) RunResult {
	plan, err := e.store.EnabledPlan()
	if err != nil || plan == nil {
		return RunResult{Message: "没有启用的预约方案", Slots: []SlotResult{}}
	}
	slots := sortedSlots(plan)
	booked := e.bookedBeginTimes(ctx, client)
	now := e.clock.Now()
	results := make([]SlotResult, 0, len(slots))

	for i := range slots {
		slot := slots[i]
		if settled, done := finished[slot.ID]; done {
			results = append(results, settled)
			continue
		}
		begin, validDay := SlotBegin(&slot, plan.Weekdays, now)
		if !validDay {
			continue
		}
		beginSec := begin.Unix()
		var res SlotResult
		if booked != nil && booked[beginSec] {
			res = SlotResult{
				SlotID:  slot.ID,
				SeatNum: slot.SeatNum,
				Success: true,
				Message: "该时段已有预约，跳过重复提交",
			}
		} else {
			preferred := e.findLock(slot.ID, beginSec)
			res = e.executeSlot(ctx, client, &slot, begin, dryRun, preferred, "", booked)
			if preferred != nil && !res.Success && !res.Terminal && !res.Unverified &&
				hdu.IsSeatUnavailable(hdu.LibraryError(res.Message)) {
				e.removeLock(slot.ID, beginSec)
				skip := preferred.SeatNum
				if slot.SeatNum == preferred.SeatNum && len(slot.FallbackSeats) == 0 {
					skip = ""
				}
				res = e.executeSlot(ctx, client, &slot, begin, dryRun, nil, skip, booked)
			}
		}
		if res.Success {
			e.removeLock(slot.ID, beginSec)
		}
		_ = e.store.WriteAudit("booking_slot_finished", map[string]any{
			"planId":  plan.ID,
			"slotId":  slot.ID,
			"success": res.Success,
			"seatNum": res.SeatNum,
			"message": res.Message,
		})
		results = append(results, res)
	}

	allOK := len(results) > 0
	for _, r := range results {
		if !r.Success {
			allOK = false
			break
		}
	}

	msg := ""
	switch {
	case dryRun:
		msg = "预约预演完成，未提交预约请求"
	case allOK:
		msg = "预约任务完成"
	case len(results) == 0:
		msg = "今日不在方案的重复日期内，无需预约"
	default:
		msgs := make([]string, len(results))
		for i, r := range results {
			msgs[i] = r.Message
		}
		msg = "预约失败：" + strings.Join(msgs, "；")
	}

	return RunResult{
		PlanID:  plan.ID,
		Success: allOK,
		Message: msg,
		Slots:   results,
	}
}

func (e *Executor) executeSlot(
	ctx context.Context,
	client Client,
	slot *core.PlanSlot,
	begin time.Time,
	dryRun bool,
	preferred *Lock,
	skipSeat string,
	snapshot map[int64]bool,
) SlotResult {
	var candidates []string
	if preferred != nil {
		candidates = []string{preferred.SeatNum}
	} else {
		all := append([]string{slot.SeatNum}, slot.FallbackSeats...)
		for _, s := range all {
			if skipSeat == "" || skipSeat != s {
				candidates = append(candidates, s)
			}
		}
	}

	last := SlotResult{SlotID: slot.ID, Message: "未找到可用座位"}
	seatQueryBusy := false
	floors, err := client.Floors(ctx, slot.RoomQuery, begin, slot.DurationHours)
	if err != nil {
		seatQueryBusy = hdu.IsSeatQueryBlocked(err)
		last = SlotResult{
			SlotID:        slot.ID,
			Message:       fmt.Sprintf("房间或座位查询失败: %v", err),
			SeatQueryBusy: seatQueryBusy,
		}
	}

	for _, seatNum := range candidates {
		var seatID string
		var hasID bool
		if preferred != nil && preferred.SeatNum == seatNum {
			seatID, hasID = preferred.SeatID, true
		} else if floors != nil {
			seatID, hasID = seatIDFromFloors(floors, slot.FloorID, seatNum)
		}
		if !hasID {
			if floors == nil {
				continue
			}
			last = SlotResult{
				SlotID:  slot.ID,
				SeatNum: seatNum,
				Message: "找不到座位 " + seatNum,
			}
			continue
		}
		if floors != nil && !seatIsFree(floors, slot.FloorID, seatNum) {
			last = SlotResult{
				SlotID:  slot.ID,
				SeatNum: seatNum,
				Message: fmt.Sprintf("座位 %s 已被占用", seatNum),
			}
			continue
		}
		if dryRun {
			return SlotResult{
				SlotID:        slot.ID,
				SeatNum:       seatNum,
				Success:       true,
				Message:       "预演成功，未提交预约请求",
				SeatQueryBusy: seatQueryBusy,
			}
		}

		resp, bookErr := e.pacedWrite(ctx, func() (hdu.ActionResult, error) {
			return client.BookSeat(ctx, seatID, begin, slot.DurationHours)
		})
		var res SlotResult
		if bookErr != nil {
			res = e.bookingFailure(ctx, client, slot, begin, seatNum, bookErr, snapshot)
		} else {
			res = e.finalizeBooking(ctx, client, slot, begin, seatNum, resp, snapshot)
		}
		res.SeatQueryBusy = seatQueryBusy
		if res.Success || res.Terminal || res.Unverified {
			return res
		}
		last = res
	}
	last.SeatQueryBusy = seatQueryBusy
	return last
}

func (e *Executor) bookingFailure(
	ctx context.Context,
	client Client,
	slot *core.PlanSlot,
	begin time.Time,
	seatNum string,
	err error,
	snapshot map[int64]bool,
) SlotResult {
	if hdu.IsAuthExpired(err) {
		return SlotResult{SlotID: slot.ID, SeatNum: seatNum, Message: err.Error()}
	}
	if hdu.IsRequestTimeout(err) {
		state, item := e.confirmBooking(ctx, client, begin, snapshot)
		switch state {
		case confirmFound:
			foundSeat := strings.TrimSpace(item.SeatNum.String())
			if foundSeat == "" {
				foundSeat = seatNum
			}
			return SlotResult{
				SlotID:  slot.ID,
				SeatNum: foundSeat,
				Success: true,
				Message: "预约已生效（响应超时，以预约列表为准）",
			}
		case confirmUnknown:
			return SlotResult{
				SlotID:     slot.ID,
				SeatNum:    seatNum,
				Unverified: true,
				Message:    "请求超时，且预约列表暂不可用，结果未确认",
			}
		default:
			return SlotResult{
				SlotID:     slot.ID,
				SeatNum:    seatNum,
				Unverified: true,
				Message:    "请求超时，预约列表尚未显示该预约，结果未确认",
			}
		}
	}
	return SlotResult{SlotID: slot.ID, SeatNum: seatNum, Message: err.Error()}
}

func (e *Executor) finalizeBooking(
	ctx context.Context,
	client Client,
	slot *core.PlanSlot,
	begin time.Time,
	seatNum string,
	resp hdu.ActionResult,
	snapshot map[int64]bool,
) SlotResult {
	if resp.OK {
		return SlotResult{
			SlotID:  slot.ID,
			SeatNum: seatNum,
			Success: true,
			Message: "预约成功",
		}
	}
	msg := resp.Message
	libErr := hdu.LibraryError(msg)
	if hdu.IsBanned(libErr) {
		return SlotResult{
			SlotID:   slot.ID,
			SeatNum:  seatNum,
			Terminal: true,
			Blocked:  true,
			Message:  fmt.Sprintf("账号已被馆方限流，需等待 %d 分钟：%s", int(AccountBan.Minutes()), msg),
		}
	}
	if hdu.IsThrottled(libErr) || hdu.IsFlowError(libErr) {
		return SlotResult{SlotID: slot.ID, SeatNum: seatNum, Message: msg}
	}

	state, item := e.confirmBooking(ctx, client, begin, snapshot)
	switch state {
	case confirmFound:
		foundSeat := strings.TrimSpace(item.SeatNum.String())
		if foundSeat == "" {
			foundSeat = seatNum
		}
		return SlotResult{
			SlotID:  slot.ID,
			SeatNum: foundSeat,
			Success: true,
			Message: "预约已生效（以预约列表为准）",
		}
	case confirmUnknown:
		return SlotResult{
			SlotID:     slot.ID,
			SeatNum:    seatNum,
			Unverified: true,
			Message:    "预约结果未确认（预约列表暂不可用）：" + msg,
		}
	default:
		if hdu.IsDuplicate(libErr) {
			return SlotResult{
				SlotID:   slot.ID,
				SeatNum:  seatNum,
				Terminal: true,
				Message:  "存在时间冲突的预约，请先取消后再试：" + msg,
			}
		}
		return SlotResult{SlotID: slot.ID, SeatNum: seatNum, Message: msg}
	}
}

func (e *Executor) confirmBooking(
	ctx context.Context,
	client Client,
	begin time.Time,
	snapshot map[int64]bool,
) (confirmState, hdu.RawBooking) {
	target := begin.Unix()
	for attempt := 0; attempt < 2; attempt++ {
		items, err := client.Bookings(ctx)
		if err == nil {
			for _, item := range items {
				if int64(item.Time) == target {
					return confirmFound, item
				}
			}
			return confirmAbsent, hdu.RawBooking{}
		}
		if hdu.IsAuthExpired(err) {
			return confirmUnknown, hdu.RawBooking{}
		}
		if attempt == 0 {
			e.sleepFn(ctx, 400*time.Millisecond)
		}
	}
	if snapshot != nil && snapshot[target] {
		return confirmFound, hdu.RawBooking{Time: hdu.FlexInt64(target)}
	}
	return confirmUnknown, hdu.RawBooking{}
}

func (e *Executor) bookedBeginTimes(ctx context.Context, client Client) map[int64]bool {
	items, err := client.Bookings(ctx)
	if err != nil {
		return nil
	}
	out := make(map[int64]bool, len(items))
	for _, it := range items {
		out[int64(it.Time)] = true
	}
	return out
}

// LockOnce runs the 19:59:00 single-shot prelock for each slot of the enabled plan.
func (e *Executor) LockOnce(ctx context.Context, client Client) LockResult {
	plan, err := e.store.EnabledPlan()
	if err != nil || plan == nil {
		return LockResult{Message: "没有启用的预约方案", Locks: []Lock{}}
	}
	slots := sortedSlots(plan)
	if len(slots) == 0 {
		return LockResult{PlanID: plan.ID, Message: "方案没有预约时段", Locks: []Lock{}}
	}

	started := e.clock.Now()
	locks := make([]Lock, 0, len(slots))
	var failures []string
	attempted := 0

	for i := range slots {
		slot := slots[i]
		begin, validDay := SlotBegin(&slot, plan.Weekdays, started)
		if !validDay {
			failures = append(failures, slot.SeatNum+"：今日不在重复日期内")
			continue
		}
		attempted++
		lk, reason := e.prelockAttempt(ctx, client, &slot, begin)
		if reason != "" {
			failures = append(failures, slot.SeatNum+"："+reason)
		} else {
			locks = append(locks, lk)
		}
	}

	success := attempted > 0 && len(failures) == 0
	held := 0
	for _, lk := range locks {
		if lk.Locked {
			held++
		}
	}

	msg := "今日无需预锁"
	if success {
		msg = fmt.Sprintf("座位号已就绪（%d/%d，其中锁住 %d）", len(locks), attempted, held)
	} else if len(failures) > 0 {
		msg = fmt.Sprintf("预锁 %d/%d 成功（失败不重试）：%s", len(locks), attempted, strings.Join(failures, "；"))
	}

	e.mu.Lock()
	e.lockedSeats = slices.Clone(locks)
	e.mu.Unlock()

	_ = e.store.WriteAudit("booking_prelock_finished", map[string]any{
		"planId":    plan.ID,
		"success":   success,
		"slots":     len(slots),
		"attempted": attempted,
		"elapsedMs": e.clock.Now().Sub(started).Milliseconds(),
		"locks":     len(locks),
		"held":      held,
		"message":   msg,
	})

	return LockResult{
		PlanID:  plan.ID,
		Success: success,
		Message: msg,
		Locks:   locks,
	}
}

func (e *Executor) prelockAttempt(ctx context.Context, client Client, slot *core.PlanSlot, begin time.Time) (Lock, string) {
	floors, err := client.Floors(ctx, slot.RoomQuery, begin, slot.DurationHours)
	if err != nil {
		return Lock{}, fmt.Sprintf("座位查询失败: %v", err)
	}
	seatID, ok := seatIDFromFloors(floors, slot.FloorID, slot.SeatNum)
	if !ok {
		return Lock{}, fmt.Sprintf("座位 %s 不在座位图中", slot.SeatNum)
	}
	if !seatIsFree(floors, slot.FloorID, slot.SeatNum) {
		return Lock{}, fmt.Sprintf("座位 %s 已被占用", slot.SeatNum)
	}
	resp, err := e.pacedWrite(ctx, func() (hdu.ActionResult, error) {
		return client.LockSeat(ctx, seatID, begin, slot.DurationHours)
	})
	if err != nil {
		return Lock{}, fmt.Sprintf("锁座失败: %v", err)
	}
	if !resp.OK {
		return Lock{}, "锁座被拒: " + resp.Message
	}
	return Lock{
		SlotID:        slot.ID,
		SeatID:        seatID,
		SeatNum:       slot.SeatNum,
		BeginSeconds:  begin.Unix(),
		DurationHours: slot.DurationHours,
		Locked:        lockEffective(resp),
	}, ""
}

func (e *Executor) findLock(slotID string, beginSec int64) *Lock {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i := range e.lockedSeats {
		if e.lockedSeats[i].SlotID == slotID && e.lockedSeats[i].BeginSeconds == beginSec {
			lk := e.lockedSeats[i]
			return &lk
		}
	}
	return nil
}

func (e *Executor) removeLock(slotID string, beginSec int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	kept := e.lockedSeats[:0]
	for _, lk := range e.lockedSeats {
		if lk.SlotID == slotID && lk.BeginSeconds == beginSec {
			continue
		}
		kept = append(kept, lk)
	}
	e.lockedSeats = kept
}

func (e *Executor) clearLocks() {
	e.mu.Lock()
	e.lockedSeats = nil
	e.mu.Unlock()
}
