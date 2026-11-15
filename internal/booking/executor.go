package booking

import (
	"context"
	"fmt"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"hdu-library-sniper/internal/core"
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
	writeInterval atomic.Int64 // nanoseconds
	sleepFn       func(context.Context, time.Duration)

	mu          sync.Mutex
	writeSlot   time.Time
	lockedSeats []Lock
}

func NewExecutor(st *store.Store) *Executor {
	return NewExecutorWithSleep(st, sleepContext)
}

func NewExecutorWithSleep(st *store.Store, sleepFn func(context.Context, time.Duration)) *Executor {
	e := &Executor{
		store:     st,
		sleepFn:   sleepFn,
		writeSlot: time.Now(),
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

func (e *Executor) pacedWrite(ctx context.Context, fn func() (map[string]any, error)) (map[string]any, error) {
	now := time.Now()
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
			return nil, ctx.Err()
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
		_ = e.store.WriteAudit("booking_run_finished", map[string]any{
			"planId":  res.PlanID,
			"kind":    res.Kind,
			"success": res.Success,
			"members": len(res.Members),
			"message": res.Message,
		})
	}
	return res
}

// RunBurst polls at PollInterval after 20:00 while write pacing limits write submissions.
func (e *Executor) RunBurst(ctx context.Context, client Client, timeout time.Duration) RunResult {
	deadline := time.Now().Add(timeout)
	finished := make(map[string]MemberResult)
	unverified := make(map[string]int)
	var busyRounds uint32
	var busySince time.Time

	for {
		res := e.runAttempt(ctx, client, false, finished)
		for _, m := range res.Members {
			if m.Blocked {
				res.Success = false
				res.Message = m.Message
				e.clearLocks()
				e.auditRunFinished(res)
				return res
			}
			if m.Success || m.Terminal {
				if _, ok := finished[m.PlanID]; !ok {
					finished[m.PlanID] = m
				}
			} else if m.Unverified {
				unverified[m.PlanID]++
				if unverified[m.PlanID] >= 3 {
					if _, ok := finished[m.PlanID]; !ok {
						term := m
						term.Terminal = true
						term.Message = m.Message + "（多次未能确认，停止重试）"
						finished[m.PlanID] = term
					}
				}
			}
		}

		pending := false
		for _, m := range res.Members {
			if !m.Success && !m.Terminal {
				if _, done := finished[m.PlanID]; !done {
					pending = true
					break
				}
			}
		}
		if res.Success || !pending || !time.Now().Before(deadline) || ctx.Err() != nil {
			e.clearLocks()
			e.auditRunFinished(res)
			return res
		}

		seatQueryBusy := false
		for _, m := range res.Members {
			if m.SeatQueryBusy {
				seatQueryBusy = true
				break
			}
		}
		if seatQueryBusy {
			busyRounds++
			if busySince.IsZero() {
				busySince = time.Now()
				_ = e.store.WriteAudit("booking_seat_query_busy", map[string]any{
					"reason": "座位图不可用（404 并发保护或请求超时）",
					"at":     "first",
				})
			}
			e.mu.Lock()
			e.writeSlot = time.Now()
			e.mu.Unlock()
		} else if !busySince.IsZero() {
			_ = e.store.WriteAudit("booking_seat_query_recovered", map[string]any{
				"busyRounds": busyRounds,
				"busyMs":     time.Since(busySince).Milliseconds(),
			})
			busySince = time.Time{}
			busyRounds = 0
		}

		rem := time.Until(deadline)
		if rem > PollInterval {
			rem = PollInterval
		}
		e.sleepFn(ctx, rem)
	}
}

func (e *Executor) auditRunFinished(res RunResult) {
	_ = e.store.WriteAudit("booking_run_finished", map[string]any{
		"planId":  res.PlanID,
		"kind":    res.Kind,
		"success": res.Success,
		"members": len(res.Members),
		"message": res.Message,
	})
}

func (e *Executor) runAttempt(ctx context.Context, client Client, dryRun bool, finished map[string]MemberResult) RunResult {
	enabled, ok := e.findEnabledItem()
	if !ok {
		return RunResult{Message: "没有启用的预约方案", Members: []MemberResult{}}
	}
	planID, kind, members := planMembers(enabled)
	booked := e.bookedBeginTimes(ctx, client)
	now := time.Now()
	results := make([]MemberResult, 0, len(members))

	for i := range members {
		plan := members[i]
		if settled, done := finished[plan.ID]; done {
			results = append(results, settled)
			continue
		}
		begin, validDay := MemberBegin(&plan, now)
		if !validDay {
			continue
		}
		beginSec := begin.Unix()
		var res MemberResult
		if booked != nil && booked[beginSec] {
			res = MemberResult{
				PlanID:  plan.ID,
				SeatNum: plan.SeatNum,
				Success: true,
				Message: "该时段已有预约，跳过重复提交",
			}
		} else {
			preferred := e.findLock(plan.ID, beginSec)
			res = e.executePlan(ctx, client, &plan, begin, dryRun, preferred, "", booked)
			if preferred != nil && !res.Success && !res.Terminal && !res.Unverified && !res.SeatQueryBusy &&
				isSeatUnavailableMessage(res.Message) {
				e.removeLock(plan.ID, beginSec)
				skip := preferred.SeatNum
				if plan.SeatNum == preferred.SeatNum && len(plan.FallbackSeats) == 0 {
					skip = ""
				}
				res = e.executePlan(ctx, client, &plan, begin, dryRun, nil, skip, booked)
			}
		}
		if res.Success {
			e.removeLock(plan.ID, beginSec)
		}
		_ = e.store.WriteAudit("booking_member_finished", map[string]any{
			"planId":  plan.ID,
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
		PlanID:  planID,
		Kind:    kind,
		Success: allOK,
		Message: msg,
		Members: results,
	}
}

func (e *Executor) executePlan(
	ctx context.Context,
	client Client,
	plan *core.BookingPlan,
	begin time.Time,
	dryRun bool,
	preferred *Lock,
	skipSeat string,
	snapshot map[int64]bool,
) MemberResult {
	var candidates []string
	if preferred != nil {
		candidates = []string{preferred.SeatNum}
	} else {
		all := append([]string{plan.SeatNum}, plan.FallbackSeats...)
		for _, s := range all {
			if skipSeat == "" || skipSeat != s {
				candidates = append(candidates, s)
			}
		}
	}

	last := MemberResult{PlanID: plan.ID, Message: "未找到可用座位"}
	seatQueryBusy := false
	floors, err := client.Floors(ctx, plan.RoomQuery, begin, plan.DurationHours)
	if err != nil {
		seatQueryBusy = isSeatQueryBlocked(err)
		last = MemberResult{
			PlanID:        plan.ID,
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
			seatID, hasID = seatIDFromFloors(floors, plan, seatNum)
		}
		if !hasID {
			if floors == nil {
				continue
			}
			last = MemberResult{
				PlanID:  plan.ID,
				SeatNum: seatNum,
				Message: "找不到座位 " + seatNum,
			}
			continue
		}
		if floors != nil && !seatIsFree(floors, plan, seatNum) {
			last = MemberResult{
				PlanID:  plan.ID,
				SeatNum: seatNum,
				Message: fmt.Sprintf("座位 %s 已被占用", seatNum),
			}
			continue
		}
		if dryRun {
			return MemberResult{
				PlanID:        plan.ID,
				SeatNum:       seatNum,
				Success:       true,
				Message:       "预演成功，未提交预约请求",
				SeatQueryBusy: seatQueryBusy,
			}
		}

		resp, bookErr := e.pacedWrite(ctx, func() (map[string]any, error) {
			return client.BookSeat(ctx, seatID, begin, plan.DurationHours)
		})
		var res MemberResult
		if bookErr != nil {
			res = e.bookingFailure(ctx, client, plan, begin, seatNum, bookErr, snapshot)
		} else {
			res = e.finalizeBooking(ctx, client, plan, begin, seatNum, resp, snapshot)
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
	plan *core.BookingPlan,
	begin time.Time,
	seatNum string,
	err error,
	snapshot map[int64]bool,
) MemberResult {
	if hdu.IsAuthExpired(err) {
		return MemberResult{PlanID: plan.ID, SeatNum: seatNum, Message: err.Error()}
	}
	if hdu.IsRequestTimeout(err) {
		state, item := e.confirmBooking(ctx, client, begin, snapshot)
		switch state {
		case confirmFound:
			foundSeat := core.ToString(item["seatNum"])
			if foundSeat == "" {
				foundSeat = seatNum
			}
			return MemberResult{
				PlanID:  plan.ID,
				SeatNum: foundSeat,
				Success: true,
				Message: "预约已生效（响应超时，以预约列表为准）",
			}
		case confirmUnknown:
			return MemberResult{
				PlanID:     plan.ID,
				SeatNum:    seatNum,
				Unverified: true,
				Message:    "请求超时，且预约列表暂不可用，结果未确认",
			}
		default:
			return MemberResult{
				PlanID:     plan.ID,
				SeatNum:    seatNum,
				Unverified: true,
				Message:    "请求超时，预约列表尚未显示该预约，结果未确认",
			}
		}
	}
	return MemberResult{PlanID: plan.ID, SeatNum: seatNum, Message: err.Error()}
}

func (e *Executor) finalizeBooking(
	ctx context.Context,
	client Client,
	plan *core.BookingPlan,
	begin time.Time,
	seatNum string,
	resp map[string]any,
	snapshot map[int64]bool,
) MemberResult {
	if bookingSucceeded(resp) {
		return MemberResult{
			PlanID:  plan.ID,
			SeatNum: seatNum,
			Success: true,
			Message: "预约成功",
		}
	}
	msg := responseMessage(resp)
	switch classifyFailure(msg) {
	case "ban":
		return MemberResult{
			PlanID:   plan.ID,
			SeatNum:  seatNum,
			Terminal: true,
			Blocked:  true,
			Message:  fmt.Sprintf("账号已被馆方限流，需等待 %d 分钟：%s", int(AccountBan.Minutes()), msg),
		}
	case "throttle", "flow":
		return MemberResult{PlanID: plan.ID, SeatNum: seatNum, Message: msg}
	}

	state, item := e.confirmBooking(ctx, client, begin, snapshot)
	switch state {
	case confirmFound:
		foundSeat := core.ToString(item["seatNum"])
		if foundSeat == "" {
			foundSeat = seatNum
		}
		return MemberResult{
			PlanID:  plan.ID,
			SeatNum: foundSeat,
			Success: true,
			Message: "预约已生效（以预约列表为准）",
		}
	case confirmUnknown:
		return MemberResult{
			PlanID:     plan.ID,
			SeatNum:    seatNum,
			Unverified: true,
			Message:    "预约结果未确认（预约列表暂不可用）：" + msg,
		}
	default:
		if isDuplicateMessage(msg) {
			return MemberResult{
				PlanID:   plan.ID,
				SeatNum:  seatNum,
				Terminal: true,
				Message:  "存在时间冲突的预约，请先取消后再试：" + msg,
			}
		}
		return MemberResult{PlanID: plan.ID, SeatNum: seatNum, Message: msg}
	}
}

func (e *Executor) confirmBooking(
	ctx context.Context,
	client Client,
	begin time.Time,
	snapshot map[int64]bool,
) (confirmState, map[string]any) {
	target := begin.Unix()
	for attempt := 0; attempt < 2; attempt++ {
		items, err := client.Bookings(ctx)
		if err == nil {
			for _, item := range items {
				if core.ToInt64(item["time"]) == target {
					return confirmFound, item
				}
			}
			return confirmAbsent, nil
		}
		if hdu.IsAuthExpired(err) {
			return confirmUnknown, nil
		}
		if attempt == 0 {
			e.sleepFn(ctx, 400*time.Millisecond)
		}
	}
	if snapshot != nil && snapshot[target] {
		return confirmFound, map[string]any{"time": target}
	}
	return confirmUnknown, nil
}

func (e *Executor) bookedBeginTimes(ctx context.Context, client Client) map[int64]bool {
	items, err := client.Bookings(ctx)
	if err != nil {
		return nil
	}
	out := make(map[int64]bool, len(items))
	for _, it := range items {
		out[core.ToInt64(it["time"])] = true
	}
	return out
}

// LockOnce runs the 19:59:00 single-shot prelock for each member of the active plan.
func (e *Executor) LockOnce(ctx context.Context, client Client) LockResult {
	enabled, ok := e.findEnabledItem()
	if !ok {
		return LockResult{Message: "没有启用的预约方案", Locks: []Lock{}}
	}
	planID, kind, members := planMembers(enabled)
	if len(members) == 0 {
		return LockResult{PlanID: planID, Kind: kind, Message: "方案没有成员", Locks: []Lock{}}
	}

	started := time.Now()
	now := time.Now()
	locks := make([]Lock, 0, len(members))
	var failures []string
	attempted := 0

	for i := range members {
		plan := members[i]
		begin, validDay := MemberBegin(&plan, now)
		if !validDay {
			failures = append(failures, plan.SeatNum+"：今日不在重复日期内")
			continue
		}
		attempted++
		lk, reason := e.prelockAttempt(ctx, client, &plan, begin)
		if reason != "" {
			failures = append(failures, plan.SeatNum+"："+reason)
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
		"planId":    planID,
		"kind":      kind,
		"success":   success,
		"members":   len(members),
		"attempted": attempted,
		"elapsedMs": time.Since(started).Milliseconds(),
		"locks":     len(locks),
		"held":      held,
		"message":   msg,
	})

	return LockResult{
		PlanID:  planID,
		Kind:    kind,
		Success: success,
		Message: msg,
		Locks:   locks,
	}
}

func (e *Executor) prelockAttempt(ctx context.Context, client Client, plan *core.BookingPlan, begin time.Time) (Lock, string) {
	floors, err := client.Floors(ctx, plan.RoomQuery, begin, plan.DurationHours)
	if err != nil {
		return Lock{}, fmt.Sprintf("座位查询失败: %v", err)
	}
	seatID, ok := seatIDFromFloors(floors, plan, plan.SeatNum)
	if !ok {
		return Lock{}, fmt.Sprintf("座位 %s 不在座位图中", plan.SeatNum)
	}
	if !seatIsFree(floors, plan, plan.SeatNum) {
		return Lock{}, fmt.Sprintf("座位 %s 已被占用", plan.SeatNum)
	}
	resp, err := e.pacedWrite(ctx, func() (map[string]any, error) {
		return client.LockSeat(ctx, seatID, begin, plan.DurationHours)
	})
	if err != nil {
		return Lock{}, fmt.Sprintf("锁座失败: %v", err)
	}
	if !lockAccepted(resp) {
		return Lock{}, "锁座被拒: " + responseMessage(resp)
	}
	return Lock{
		PlanID:        plan.ID,
		SeatID:        seatID,
		SeatNum:       plan.SeatNum,
		BeginSeconds:  begin.Unix(),
		DurationHours: plan.DurationHours,
		Locked:        lockEffective(resp),
	}, ""
}

func (e *Executor) findEnabledItem() (core.PlanListItem, bool) {
	items, err := e.store.ListPlanItems()
	if err != nil {
		return core.PlanListItem{}, false
	}
	for _, it := range items {
		if it.IsEnabled() {
			return it, true
		}
	}
	return core.PlanListItem{}, false
}

func (e *Executor) findLock(planID string, beginSec int64) *Lock {
	e.mu.Lock()
	defer e.mu.Unlock()
	for i := range e.lockedSeats {
		if e.lockedSeats[i].PlanID == planID && e.lockedSeats[i].BeginSeconds == beginSec {
			lk := e.lockedSeats[i]
			return &lk
		}
	}
	return nil
}

func (e *Executor) removeLock(planID string, beginSec int64) {
	e.mu.Lock()
	defer e.mu.Unlock()
	kept := e.lockedSeats[:0]
	for _, lk := range e.lockedSeats {
		if lk.PlanID == planID && lk.BeginSeconds == beginSec {
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
