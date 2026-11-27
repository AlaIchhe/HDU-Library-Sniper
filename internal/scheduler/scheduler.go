package scheduler

import (
	"context"
	"sync"
	"sync/atomic"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/events"
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

// Scheduler coordinates 19:59 prelock, 20:00 burst booking, and persistent auto check-in execution.
type Scheduler struct {
	store   *store.Store
	auth    *auth.Service
	booking *booking.Executor
	bus     *events.Bus
	clock   core.Clock
	sleepFn func(context.Context, time.Duration) bool
	running atomic.Bool

	wakeCheckIn chan struct{}

	mu          sync.Mutex
	baseCtx     context.Context
	scheduler   string
	state       string
	lastRunAt   string
	lastMessage string
	pending     map[string]*core.PendingCheckIn
}

func New(st *store.Store, authSvc *auth.Service, exec *booking.Executor, bus *events.Bus) *Scheduler {
	return NewWithClock(st, authSvc, exec, bus, core.RealClock{})
}

func NewWithClock(st *store.Store, authSvc *auth.Service, exec *booking.Executor, bus *events.Bus, clock core.Clock) *Scheduler {
	if clock == nil {
		clock = core.RealClock{}
	}
	s := &Scheduler{
		store:       st,
		auth:        authSvc,
		booking:     exec,
		bus:         bus,
		clock:       clock,
		sleepFn:     sleepWithContext,
		wakeCheckIn: make(chan struct{}, 1),
		scheduler:   "running",
		state:       "idle",
		pending:     make(map[string]*core.PendingCheckIn),
	}
	if st != nil {
		if rows, err := st.ListPendingCheckIns(); err == nil {
			for i := range rows {
				p := rows[i]
				s.pending[p.BookingID] = &p
			}
		}
	}
	return s
}

func (s *Scheduler) Start(ctx context.Context) {
	s.mu.Lock()
	s.baseCtx = ctx
	s.mu.Unlock()
	go s.SyncCheckIns(ctx)
	go s.bookingLoop(ctx)
	go s.checkinLoop(ctx)
}

func (s *Scheduler) publishRuntime(invalidate ...api.InvalidateTarget) {
	if s.bus == nil {
		return
	}
	st := s.Status()
	s.bus.Publish(events.TopicAppEvent, api.AppEvent{
		Kind:       api.AppEventRuntime,
		Runtime:    &st,
		Invalidate: invalidate,
	})
}

func (s *Scheduler) publishNotification(notif core.Notification, invalidate ...api.InvalidateTarget) {
	if s.bus == nil {
		return
	}
	n := notif
	s.bus.Publish(events.TopicAppEvent, api.AppEvent{
		Kind:         api.AppEventNotification,
		Invalidate:   invalidate,
		Notification: &n,
	})
}

func (s *Scheduler) signalCheckInLoop() {
	select {
	case s.wakeCheckIn <- struct{}{}:
	default:
	}
}

func (s *Scheduler) Status() core.RuntimeStatus {
	_, nextMs, hasNext := s.NextCheckIn()

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

// NextExecutionTarget computes the earliest upcoming booking anchor (respecting weekdays) or pending check-in.
func (s *Scheduler) NextExecutionTarget() core.NextExecutionTarget {
	now := s.clock.Now()
	var bookingCandidate *core.NextExecutionTarget
	var bookingMs int64

	if plan, err := s.store.EnabledPlan(); err == nil && plan != nil {
		if targetTime, ok := core.NextPlanAnchor(now, plan); ok {
			bookingMs = targetTime.UnixMilli()
			bookingCandidate = &core.NextExecutionTarget{
				Kind:   core.NextTargetBooking,
				Label:  "预约",
				At:     core.FormatZh(targetTime),
				PlanID: plan.ID,
			}
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

// ClearAuthRequired resets scheduler state from "auth_required" to "idle" after authentication updates.
func (s *Scheduler) ClearAuthRequired() {
	s.mu.Lock()
	changed := s.state == "auth_required"
	if changed {
		s.state = "idle"
	}
	s.mu.Unlock()
	if changed {
		s.publishRuntime()
	}
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
			if !s.sleep(ctx, 60*time.Second) {
				return
			}
			continue
		}
		prelock := core.BookingPrelockDelaySeconds(core.ShanghaiSecondsOfDay(s.clock.Now()), core.BookingPrelockLeadSeconds)
		if prelock > 0 {
			if !s.sleep(ctx, time.Duration(prelock)*time.Second) {
				return
			}
			s.prelockOnce(ctx)
		}
		anchor := core.BookingAnchorDelaySeconds(core.ShanghaiSecondsOfDay(s.clock.Now()))
		if !s.sleep(ctx, time.Duration(anchor)*time.Second) {
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

func (s *Scheduler) hasEnabledPlan() bool {
	plan, err := s.store.EnabledPlan()
	return err == nil && plan != nil
}

func (s *Scheduler) setState(state string) {
	s.mu.Lock()
	changed := s.state != state
	s.state = state
	s.mu.Unlock()
	if changed {
		s.publishRuntime()
	}
}

func (s *Scheduler) touchLastRunAt() {
	s.mu.Lock()
	s.lastRunAt = core.FormatISO(s.clock.Now())
	s.mu.Unlock()
	s.publishRuntime()
}

func (s *Scheduler) setMessage(msg string) {
	s.mu.Lock()
	s.lastRunAt = core.FormatISO(s.clock.Now())
	s.lastMessage = msg
	s.mu.Unlock()
	s.publishRuntime()
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

func (s *Scheduler) sleep(ctx context.Context, d time.Duration) bool {
	if s.sleepFn != nil {
		return s.sleepFn(ctx, d)
	}
	return sleepWithContext(ctx, d)
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
