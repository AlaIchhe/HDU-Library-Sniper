package scheduler

import (
	"context"
	"testing"
	"time"

	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/store"
)

func TestObserveBookingsAndNextTarget(t *testing.T) {
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()

	authSvc := auth.NewService(st, nil)
	exec := booking.NewExecutor(st)
	sched := New(st, authSvc, exec)
	sched.SetAutoCheckIn(true, true)

	now := time.Now()
	sched.ObserveBookingsAt([]map[string]any{
		{
			"id":            "b1",
			"time":          now.Add(2 * time.Minute).Unix(),
			"limitSignBack": 900,
			"status":        "0",
		},
		{
			"id":            "b2",
			"time":          now.Unix(),
			"limitSignBack": 900,
			"status":        "1", // in use, ignored
		},
	}, now)

	bid, _, ok := sched.NextCheckIn()
	if !ok || bid != "b1" {
		t.Fatalf("expected b1 pending check-in, got bid=%q ok=%v", bid, ok)
	}
	target := sched.NextExecutionTarget()
	if target.Kind != core.NextTargetCheckIn || target.BookingID != "b1" {
		t.Fatalf("NextExecutionTarget = %+v", target)
	}
	sched.NoteCheckedIn("b1")
	if _, _, ok := sched.NextCheckIn(); ok {
		t.Fatal("expected pending queue cleared after NoteCheckedIn")
	}
	// Disabled auto-checkin clears queued polls.
	sched.SetAutoCheckIn(false, false)
	sched.SyncCheckIns(context.Background())
	if _, _, ok := sched.NextCheckIn(); ok {
		t.Fatal("expected empty pending queue when auto-checkin disabled")
	}
}
