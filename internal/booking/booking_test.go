package booking

import (
	"context"
	"slices"
	"sync"
	"testing"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
	"hdu-library-sniper/internal/store"
)

type fakeClient struct {
	mu          sync.Mutex
	bookings    []map[string]any
	floorErrs   []error
	seatStates  map[string]string
	lockResult  string
	lockResps   []map[string]any
	lockErrs    []error
	bookResps   []map[string]any
	bookErrs    []error
	bookedSeats []string
	floorsCalls int
	bookCalls   int
	lockCalls   int
}

func (f *fakeClient) Bookings(context.Context) ([]map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bookings, nil
}

func (f *fakeClient) Floors(context.Context, string, time.Time, int64) ([]map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.floorsCalls++
	if len(f.floorErrs) > 0 {
		err := f.floorErrs[0]
		f.floorErrs = f.floorErrs[1:]
		if err != nil {
			return nil, err
		}
	}
	stateFor := func(seat string) string {
		if s, ok := f.seatStates[seat]; ok {
			return s
		}
		return "0"
	}
	return []map[string]any{
		{
			"seatMap": map[string]any{
				"info": map[string]any{"id": 3, "name": "三楼"},
				"POIs": []any{
					map[string]any{"id": "seat-101", "title": "101", "state": stateFor("101")},
					map[string]any{"id": "seat-102", "title": "102", "state": stateFor("102")},
				},
			},
		},
	}, nil
}

func (f *fakeClient) BookSeat(_ context.Context, seatID string, _ time.Time, _ int64) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bookCalls++
	f.bookedSeats = append(f.bookedSeats, seatID)
	if len(f.bookErrs) > 0 {
		err := f.bookErrs[0]
		f.bookErrs = f.bookErrs[1:]
		if err != nil {
			return nil, err
		}
	}
	if len(f.bookResps) > 0 {
		r := f.bookResps[0]
		f.bookResps = f.bookResps[1:]
		return r, nil
	}
	return map[string]any{"CODE": "ok", "DATA": map[string]any{"result": "success"}}, nil
}

func (f *fakeClient) LockSeat(context.Context, string, time.Time, int64) (map[string]any, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lockCalls++
	if len(f.lockErrs) > 0 {
		err := f.lockErrs[0]
		f.lockErrs = f.lockErrs[1:]
		if err != nil {
			return nil, err
		}
	}
	if len(f.lockResps) > 0 {
		r := f.lockResps[0]
		f.lockResps = f.lockResps[1:]
		return r, nil
	}
	res := f.lockResult
	if res == "" {
		res = "fail"
	}
	return map[string]any{"CODE": "ok", "DATA": map[string]any{"result": res}}, nil
}

func (f *fakeClient) UnlockAllSeats(context.Context) (map[string]any, error) {
	return map[string]any{"CODE": "ok"}, nil
}

func newBookingFixture(t *testing.T, weekdays []int, saveGroup bool) (*store.Store, *Executor) {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	save := func(id, seat string, fallbacks []string, start int64, enabled bool) {
		if err := st.SavePlan(&core.BookingPlan{
			ID: id, Kind: core.PlanKindSingle, RoomType: "自习室", RoomQuery: "q=1",
			FloorID: 3, FloorName: "三楼", SeatNum: seat, FallbackSeats: fallbacks,
			StartHour: start, DurationHours: 4, Weekdays: weekdays, Enabled: enabled,
			CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
		}); err != nil {
			t.Fatal(err)
		}
	}

	save("p1", "101", []string{"102"}, 8, !saveGroup)
	if saveGroup {
		save("p2", "102", nil, 12, false)
		if err := st.SaveGroup(&core.BookingGroup{
			ID: "g1", Kind: core.PlanKindGroup, Name: "组合", MemberPlanIDs: []string{"p1", "p2"},
			Weekdays: weekdays, Enabled: true,
			CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
		}); err != nil {
			t.Fatal(err)
		}
	}

	exec := NewExecutorWithSleep(st, func(context.Context, time.Duration) {})
	exec.SetWriteInterval(0)
	return st, exec
}

func TestPrelockConsumedDuring404AndFallbackOnUnavailable(t *testing.T) {
	_, exec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	fake := &fakeClient{
		lockResult: "fail", // mirrors real HDU server behavior on free seats
		floorErrs:  []error{nil, hdu.HTTPError(404), nil},
		bookResps: []map[string]any{
			{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "选择的座位无法预约，可能座位不可用"}},
			{"CODE": "ok", "DATA": map[string]any{"result": "success"}},
		},
	}

	ctx := context.Background()
	lr := exec.LockOnce(ctx, fake)
	if !lr.Success || len(lr.Locks) != 1 || lr.Locks[0].SeatID != "seat-101" {
		t.Fatalf("LockOnce = %+v", lr)
	}

	res := exec.RunBurst(ctx, fake, 2*time.Second)
	if !res.Success || fake.bookCalls < 2 {
		t.Fatalf("RunBurst failed: %+v bookCalls=%d bookedSeats=%v", res, fake.bookCalls, fake.bookedSeats)
	}
	if fake.bookedSeats[0] != "seat-101" {
		t.Fatalf("expected prelocked seat-101 attempted first during 404, got %v", fake.bookedSeats)
	}
}

func TestSkipsOccupiedSeatAndAlreadyBookedSlot(t *testing.T) {
	_, exec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)

	// Primary occupied -> skips 101 and books fallback 102 without wasting write quota.
	fake := &fakeClient{seatStates: map[string]string{"101": "1", "102": "0"}}
	res := exec.Run(context.Background(), fake)
	if !res.Success || !slices.Equal(fake.bookedSeats, []string{"seat-102"}) {
		t.Fatalf("expected fallback seat-102 only, got res=%+v booked=%v", res, fake.bookedSeats)
	}

	// All seats occupied -> zero write calls.
	fakeAllBusy := &fakeClient{seatStates: map[string]string{"101": "1", "102": "3"}}
	resBusy := exec.Run(context.Background(), fakeAllBusy)
	if resBusy.Success || fakeAllBusy.bookCalls != 0 {
		t.Fatalf("expected 0 write calls when all seats occupied, got res=%+v calls=%d", resBusy, fakeAllBusy.bookCalls)
	}

	// Slot already exists in Bookings -> zero write calls.
	begin, ok := MemberBegin(&core.BookingPlan{RoomType: "自习室", StartHour: 8, Weekdays: []int{1, 2, 3, 4, 5, 6, 7}}, time.Now())
	if !ok {
		t.Fatal("expected valid MemberBegin")
	}
	fakeBooked := &fakeClient{bookings: []map[string]any{{"time": begin.Unix()}}}
	resBooked := exec.Run(context.Background(), fakeBooked)
	if !resBooked.Success || fakeBooked.bookCalls != 0 {
		t.Fatalf("expected existing slot skipped with 0 writes, got res=%+v calls=%d", resBooked, fakeBooked.bookCalls)
	}
}

func TestLockContracts(t *testing.T) {
	// Rejected by CODE != ok keeps no seatId.
	_, exec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	rejected := &fakeClient{lockResps: []map[string]any{{"CODE": 1, "MESSAGE": "请求过于频繁"}}}
	lr := exec.LockOnce(context.Background(), rejected)
	if lr.Success || len(lr.Locks) != 0 || rejected.lockCalls != 1 {
		t.Fatalf("expected rejected lock without retry, got %+v calls=%d", lr, rejected.lockCalls)
	}

	// Group prelock covers every member once and continues after member 1 fails.
	_, gExec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, true)
	groupClient := &fakeClient{seatStates: map[string]string{"101": "1", "102": "0"}, lockResult: "fail"}
	glr := gExec.LockOnce(context.Background(), groupClient)
	if glr.Success || len(glr.Locks) != 1 || glr.Locks[0].SeatNum != "102" || groupClient.lockCalls != 1 {
		t.Fatalf("expected member 2 locked even after member 1 occupied, got %+v lockCalls=%d", glr, groupClient.lockCalls)
	}
}

func TestRunBurstTerminationAndPollInterval(t *testing.T) {
	// Non-matching weekday ends immediately with 0 floors queries.
	targetDate := time.Now().In(core.Shanghai).AddDate(0, 0, core.BookingDayOffset)
	wd := int(targetDate.Weekday())
	if wd == 0 {
		wd = 7
	}
	otherDay := (wd % 7) + 1
	_, idleExec := newBookingFixture(t, []int{otherDay}, false)
	idleFake := &fakeClient{}
	idleRes := idleExec.RunBurst(context.Background(), idleFake, 2*time.Second)
	if idleRes.Success || idleFake.floorsCalls != 0 {
		t.Fatalf("expected immediate stop on non-actionable weekday, got %+v floorsCalls=%d", idleRes, idleFake.floorsCalls)
	}

	// Account ban stops polling immediately.
	_, banExec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	banFake := &fakeClient{bookResps: []map[string]any{{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "请求过于频繁，请10分钟后再试"}}}}
	banRes := banExec.RunBurst(context.Background(), banFake, 2*time.Second)
	if banRes.Success || banFake.bookCalls != 1 {
		t.Fatalf("expected immediate stop on ban, got %+v bookCalls=%d", banRes, banFake.bookCalls)
	}

	// Duplicate booking is terminal and stops immediately.
	_, dupExec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	dupFake := &fakeClient{bookResps: []map[string]any{{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "已有预约，请勿重复预约！"}}}}
	dupRes := dupExec.RunBurst(context.Background(), dupFake, 2*time.Second)
	if dupRes.Success || dupFake.bookCalls != 1 {
		t.Fatalf("expected immediate stop on duplicate, got %+v bookCalls=%d", dupRes, dupFake.bookCalls)
	}

	// Throttle keeps prelocked seatId and polls at fixed PollInterval without backoff.
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	if err := st.SavePlan(&core.BookingPlan{
		ID: "p1", Kind: core.PlanKindSingle, RoomType: "自习室", RoomQuery: "q=1",
		FloorID: 3, SeatNum: "101", StartHour: 8, DurationHours: 4,
		Weekdays: []int{1, 2, 3, 4, 5, 6, 7}, Enabled: true,
		CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
	}); err != nil {
		t.Fatal(err)
	}
	var sleeps []time.Duration
	pollExec := NewExecutorWithSleep(st, func(_ context.Context, d time.Duration) {
		sleeps = append(sleeps, d)
	})
	pollExec.SetWriteInterval(0)
	throttleFake := &fakeClient{
		floorErrs: []error{nil, hdu.HTTPError(404), hdu.HTTPError(404)},
		bookResps: []map[string]any{
			{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "请求太频繁了"}},
			{"CODE": "ok", "DATA": map[string]any{"result": "success"}},
		},
	}
	_ = pollExec.LockOnce(context.Background(), throttleFake)
	tRes := pollExec.RunBurst(context.Background(), throttleFake, 5*time.Second)
	if !tRes.Success || throttleFake.bookCalls != 2 || !slices.Equal(sleeps, []time.Duration{PollInterval}) {
		t.Fatalf("expected prelock preserved across throttle & fixed 300ms poll, res=%+v calls=%d sleeps=%v", tRes, throttleFake.bookCalls, sleeps)
	}
}

func TestRunBurstReadTimeoutIsNotRecoveryAndBusyRoundsPerWindow(t *testing.T) {
	st, exec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	fake := &fakeClient{
		floorErrs: []error{
			hdu.HTTPError(404),
			hdu.RequestTimeout(context.DeadlineExceeded),
			nil,
			hdu.HTTPError(404),
			nil,
			nil,
		},
		bookResps: []map[string]any{
			{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "未到预约时间"}},
			{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "未到预约时间"}},
			{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "未到预约时间"}},
			{"CODE": "ok", "DATA": map[string]any{"result": "fail", "msg": "未到预约时间"}},
			{"CODE": "ok", "DATA": map[string]any{"result": "success"}},
		},
	}

	res := exec.RunBurst(context.Background(), fake, 5*time.Second)
	if !res.Success {
		t.Fatalf("expected eventual success, got %+v", res)
	}

	audits, err := st.ListAudit(50)
	if err != nil {
		t.Fatal(err)
	}
	var recoveredRounds []float64
	for i := len(audits) - 1; i >= 0; i-- {
		if audits[i].Event == "booking_seat_query_recovered" {
			if r, ok := audits[i].Payload["busyRounds"].(float64); ok {
				recoveredRounds = append(recoveredRounds, r)
			}
		}
	}
	if !slices.Equal(recoveredRounds, []float64{2, 1}) {
		t.Fatalf("expected per-window busyRounds [2 1] (timeout counted as busy), got %v", recoveredRounds)
	}
}
