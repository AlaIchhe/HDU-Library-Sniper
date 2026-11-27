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
	bookings    []hdu.RawBooking
	floorErrs   []error
	seatStates  map[string]string
	lockResult  string
	lockResps   []hdu.ActionResult
	lockErrs    []error
	bookResps   []hdu.ActionResult
	bookErrs    []error
	bookedSeats []string
	floorsCalls int
	bookCalls   int
	lockCalls   int
}

func (f *fakeClient) Bookings(context.Context) ([]hdu.RawBooking, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.bookings, nil
}

func (f *fakeClient) Floors(context.Context, string, time.Time, int64) ([]hdu.FloorNode, error) {
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
	stateFor := func(seat string) hdu.FlexString {
		if s, ok := f.seatStates[seat]; ok {
			return hdu.FlexString(s)
		}
		return "0"
	}
	return []hdu.FloorNode{
		{
			RoomName: "三楼",
			SeatMap: &struct {
				Info *hdu.FloorInfo `json:"info"`
				POIs []hdu.SeatPOI  `json:"POIs"`
			}{
				Info: &hdu.FloorInfo{ID: 3, Name: "三楼"},
				POIs: []hdu.SeatPOI{
					{ID: "seat-101", Title: "101", State: stateFor("101")},
					{ID: "seat-102", Title: "102", State: stateFor("102")},
				},
			},
		},
	}, nil
}

func (f *fakeClient) BookSeat(_ context.Context, seatID string, _ time.Time, _ int64) (hdu.ActionResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.bookCalls++
	f.bookedSeats = append(f.bookedSeats, seatID)
	if len(f.bookErrs) > 0 {
		err := f.bookErrs[0]
		f.bookErrs = f.bookErrs[1:]
		if err != nil {
			return hdu.ActionResult{}, err
		}
	}
	if len(f.bookResps) > 0 {
		r := f.bookResps[0]
		f.bookResps = f.bookResps[1:]
		return r, nil
	}
	return hdu.ActionResult{OK: true, Result: "success"}, nil
}

func (f *fakeClient) LockSeat(context.Context, string, time.Time, int64) (hdu.ActionResult, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.lockCalls++
	if len(f.lockErrs) > 0 {
		err := f.lockErrs[0]
		f.lockErrs = f.lockErrs[1:]
		if err != nil {
			return hdu.ActionResult{}, err
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
	return hdu.ActionResult{OK: true, Result: res}, nil
}

func (f *fakeClient) UnlockAllSeats(context.Context) (hdu.ActionResult, error) {
	return hdu.ActionResult{OK: true}, nil
}

func newBookingFixture(t *testing.T, weekdays []int, multiSlot bool) (*store.Store, *Executor) {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	slots := []core.PlanSlot{
		{
			ID: "s1", RoomType: "自习室", RoomQuery: "q=1",
			FloorID: 3, FloorName: "三楼", SeatNum: "101", FallbackSeats: []string{"102"},
			StartHour: 8, DurationHours: 4,
		},
	}
	if multiSlot {
		slots = append(slots, core.PlanSlot{
			ID: "s2", RoomType: "自习室", RoomQuery: "q=1",
			FloorID: 3, FloorName: "三楼", SeatNum: "102",
			StartHour: 12, DurationHours: 4,
		})
	}
	if err := st.SavePlan(&core.BookingPlan{
		ID: "p1", Name: "自习室", Slots: slots, Weekdays: weekdays, Enabled: true,
		CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
	}); err != nil {
		t.Fatal(err)
	}

	exec := NewExecutorWithOptions(st, nil, core.RealClock{}, func(context.Context, time.Duration) {})
	exec.SetWriteInterval(0)
	return st, exec
}

func TestPrelockConsumedDuring404AndFallbackOnUnavailable(t *testing.T) {
	_, exec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	fake := &fakeClient{
		lockResult: "fail", // mirrors real HDU server behavior on free seats
		floorErrs:  []error{nil, hdu.HTTPError(404), nil},
		bookResps: []hdu.ActionResult{
			{OK: false, Result: "fail", Message: "该座位无法预约"},
			{OK: true, Result: "success"},
		},
	}
	lr := exec.LockOnce(context.Background(), fake)
	if !lr.Success || len(lr.Locks) != 1 {
		t.Fatalf("expected prelock seatId ready, got %+v", lr)
	}
	res := exec.Run(context.Background(), fake)
	if !res.Success || len(fake.bookedSeats) < 2 {
		t.Fatalf("expected fallback booking success, got res=%+v booked=%v", res, fake.bookedSeats)
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
	begin, ok := SlotBegin(&core.PlanSlot{RoomType: "自习室", StartHour: 8}, []int{1, 2, 3, 4, 5, 6, 7}, time.Now())
	if !ok {
		t.Fatal("expected valid SlotBegin")
	}
	fakeBooked := &fakeClient{bookings: []hdu.RawBooking{{Time: hdu.FlexInt64(begin.Unix())}}}
	resBooked := exec.Run(context.Background(), fakeBooked)
	if !resBooked.Success || fakeBooked.bookCalls != 0 {
		t.Fatalf("expected existing slot skipped with 0 writes, got res=%+v calls=%d", resBooked, fakeBooked.bookCalls)
	}
}

func TestLockContracts(t *testing.T) {
	// Rejected by CODE != ok keeps no seatId.
	_, exec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	rejected := &fakeClient{lockResps: []hdu.ActionResult{{OK: false, Message: "请求过于频繁"}}}
	lr := exec.LockOnce(context.Background(), rejected)
	if lr.Success || len(lr.Locks) != 0 || rejected.lockCalls != 1 {
		t.Fatalf("expected rejected lock without retry, got %+v calls=%d", lr, rejected.lockCalls)
	}

	// Multi-slot prelock covers every slot once and continues after slot 1 fails.
	_, gExec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, true)
	groupClient := &fakeClient{seatStates: map[string]string{"101": "1", "102": "0"}, lockResult: "fail"}
	glr := gExec.LockOnce(context.Background(), groupClient)
	if glr.Success || len(glr.Locks) != 1 || glr.Locks[0].SeatNum != "102" || groupClient.lockCalls != 1 {
		t.Fatalf("expected slot 2 locked even after slot 1 occupied, got %+v lockCalls=%d", glr, groupClient.lockCalls)
	}
}

func TestRunBurstTerminationAndPollInterval(t *testing.T) {
	// Non-matching weekday ends immediately with 0 floors queries.
	targetDate := time.Now().In(core.Shanghai).AddDate(0, 0, core.BookingDayOffset)
	otherDay := (core.ISOWeekday(targetDate) % 7) + 1
	_, idleExec := newBookingFixture(t, []int{otherDay}, false)
	idleFake := &fakeClient{}
	idleRes := idleExec.RunBurst(context.Background(), idleFake, 2*time.Second)
	if idleRes.Success || idleFake.floorsCalls != 0 {
		t.Fatalf("expected immediate stop on non-actionable weekday, got %+v floorsCalls=%d", idleRes, idleFake.floorsCalls)
	}

	// Account ban stops polling immediately.
	_, banExec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	banFake := &fakeClient{bookResps: []hdu.ActionResult{{OK: false, Result: "fail", Message: "请求过于频繁，请10分钟后再试"}}}
	banRes := banExec.RunBurst(context.Background(), banFake, 2*time.Second)
	if banRes.Success || banFake.bookCalls != 1 {
		t.Fatalf("expected immediate stop on ban, got %+v bookCalls=%d", banRes, banFake.bookCalls)
	}

	// Duplicate booking is terminal and stops immediately.
	_, dupExec := newBookingFixture(t, []int{1, 2, 3, 4, 5, 6, 7}, false)
	dupFake := &fakeClient{bookResps: []hdu.ActionResult{{OK: false, Result: "fail", Message: "已有预约，请勿重复预约！"}}}
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
		ID: "p1", Name: "自习室",
		Slots: []core.PlanSlot{
			{ID: "s1", RoomType: "自习室", RoomQuery: "q=1", FloorID: 3, SeatNum: "101", StartHour: 8, DurationHours: 4},
		},
		Weekdays: []int{1, 2, 3, 4, 5, 6, 7}, Enabled: true,
		CreatedAt: "2026-01-01T00:00:00.000Z", UpdatedAt: "2026-01-01T00:00:00.000Z",
	}); err != nil {
		t.Fatal(err)
	}
	var sleeps []time.Duration
	pollExec := NewExecutorWithOptions(st, nil, core.RealClock{}, func(_ context.Context, d time.Duration) {
		sleeps = append(sleeps, d)
	})
	pollExec.SetWriteInterval(0)
	throttleFake := &fakeClient{
		floorErrs: []error{nil, hdu.HTTPError(404), hdu.HTTPError(404)},
		bookResps: []hdu.ActionResult{
			{OK: false, Result: "fail", Message: "请求太频繁了"},
			{OK: true, Result: "success"},
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
		bookResps: []hdu.ActionResult{
			{OK: false, Result: "fail", Message: "未到预约时间"},
			{OK: false, Result: "fail", Message: "未到预约时间"},
			{OK: false, Result: "fail", Message: "未到预约时间"},
			{OK: false, Result: "fail", Message: "未到预约时间"},
			{OK: true, Result: "success"},
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
