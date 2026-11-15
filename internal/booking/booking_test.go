package booking

import (
	"context"
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
	st101 := "0"
	if s, ok := f.seatStates["101"]; ok {
		st101 = s
	}
	st102 := "0"
	if s, ok := f.seatStates["102"]; ok {
		st102 = s
	}
	return []map[string]any{
		{
			"seatMap": map[string]any{
				"info": map[string]any{"id": 3, "name": "三楼"},
				"POIs": []any{
					map[string]any{"id": "seat-101", "title": "101", "state": st101},
					map[string]any{"id": "seat-102", "title": "102", "state": st102},
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
	res := f.lockResult
	if res == "" {
		res = "fail"
	}
	return map[string]any{"CODE": "ok", "DATA": map[string]any{"result": res}}, nil
}

func (f *fakeClient) UnlockAllSeats(context.Context) (map[string]any, error) {
	return map[string]any{"CODE": "ok"}, nil
}

func newTestPlan(st *store.Store, t *testing.T) {
	t.Helper()
	err := st.SavePlan(&core.BookingPlan{
		ID:            "p1",
		Kind:          core.PlanKindSingle,
		RoomType:      "自习室",
		RoomQuery:     "q=1",
		FloorID:       3,
		FloorName:     "三楼",
		SeatNum:       "101",
		FallbackSeats: []string{"102"},
		StartHour:     8,
		DurationHours: 4,
		Weekdays:      []int{1, 2, 3, 4, 5, 6, 7},
		Enabled:       true,
		CreatedAt:     "2026-01-01T00:00:00.000Z",
		UpdatedAt:     "2026-01-01T00:00:00.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestPrelockConsumedDuring404AndFallbackOnUnavailable(t *testing.T) {
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	newTestPlan(st, t)

	exec := NewExecutorWithSleep(st, func(context.Context, time.Duration) {})
	exec.SetWriteInterval(0)

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

	// Simulate 404 on first round of burst: prelocked seat-101 is still submitted, rejected, dropped,
	// and second round (when floors returns 200) still has candidate or falls back.
	// Note on round 1 when floors is 404, skip fallback fails because floors==nil so seat-102 has no ID yet;
	// round 2 sees floors==200 and books fallback seat-102 (since 101 failed or primary).
	res := exec.RunBurst(ctx, fake, 2*time.Second)
	if !res.Success || fake.bookCalls < 2 {
		t.Fatalf("RunBurst failed: %+v bookCalls=%d bookedSeats=%v", res, fake.bookCalls, fake.bookedSeats)
	}
	if fake.bookedSeats[0] != "seat-101" {
		t.Fatalf("expected prelocked seat-101 attempted first during 404, got %v", fake.bookedSeats)
	}
}
