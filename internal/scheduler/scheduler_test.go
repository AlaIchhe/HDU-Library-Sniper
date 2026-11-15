package scheduler

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"reflect"
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

func newTestSyncScheduler(t *testing.T, handler func(w http.ResponseWriter, r *http.Request)) (*Scheduler, *store.Store) {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content/index/startUp/openid/test_openid/":
			w.WriteHeader(http.StatusOK)
		case "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "测试"}},
			})
		default:
			handler(w, r)
		}
	}))
	t.Cleanup(srv.Close)

	authSvc := auth.NewServiceWithEndpoints(st, nil, auth.Endpoints{Library: srv.URL})
	if res := authSvc.LoginOpenID(context.Background(), "test_openid"); !res.Success {
		t.Fatalf("LoginOpenID failed: %+v", res)
	}
	sched := New(st, authSvc, booking.NewExecutor(st))
	sched.SetAutoCheckIn(true, true)
	return sched, st
}

func TestSyncPeakDelay(t *testing.T) {
	cases := []struct {
		name string
		now  time.Time
		want time.Duration
	}{
		{
			name: "before anchor",
			now:  time.Date(2026, 11, 15, 19, 59, 59, 0, core.Shanghai),
			want: 0,
		},
		{
			name: "at anchor",
			now:  time.Date(2026, 11, 15, 20, 0, 0, 0, core.Shanghai),
			want: 60 * time.Second,
		},
		{
			name: "inside peak",
			now:  time.Date(2026, 11, 15, 20, 0, 11, 491_000_000, core.Shanghai),
			want: 48*time.Second + 509*time.Millisecond,
		},
		{
			name: "at peak end",
			now:  time.Date(2026, 11, 15, 20, 1, 0, 0, core.Shanghai),
			want: 0,
		},
		{
			name: "off peak",
			now:  time.Date(2026, 11, 15, 12, 0, 0, 0, core.Shanghai),
			want: 0,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := syncPeakDelay(tc.now, checkInSyncPeakWindow); got != tc.want {
				t.Fatalf("syncPeakDelay(%v) = %v, want %v", tc.now, got, tc.want)
			}
		})
	}
}

func TestSyncCheckInsDefersPeakAndRecoversQuietly(t *testing.T) {
	var attempts int
	bookingTime := time.Now().Add(2 * time.Hour).Unix()
	sched, st := newTestSyncScheduler(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Seat/Index/myBookingList" {
			http.NotFound(w, r)
			return
		}
		attempts++
		if attempts == 1 {
			w.WriteHeader(http.StatusNotFound)
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"content": map[string]any{
				"defaultItems": []map[string]any{
					{
						"id":            "sync-b1",
						"time":          bookingTime,
						"limitSignBack": 900,
						"status":        "0",
					},
				},
			},
		})
	})

	var sleeps []time.Duration
	sched.nowFn = func() time.Time {
		return time.Date(2026, 11, 15, 20, 0, 11, 491_000_000, core.Shanghai)
	}
	sched.sleepFn = func(_ context.Context, d time.Duration) bool {
		sleeps = append(sleeps, d)
		return true
	}

	sched.SyncCheckIns(context.Background())

	wantSleeps := []time.Duration{48*time.Second + 509*time.Millisecond, syncRetryDelays[0]}
	if !reflect.DeepEqual(sleeps, wantSleeps) {
		t.Fatalf("sleeps = %v, want %v", sleeps, wantSleeps)
	}
	if attempts != 2 {
		t.Fatalf("attempts = %d, want 2", attempts)
	}
	if bid, _, ok := sched.NextCheckIn(); !ok || bid != "sync-b1" {
		t.Fatalf("expected sync-b1 queued after recovery, got bid=%q ok=%v", bid, ok)
	}
	audits, err := st.ListAudit(10)
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range audits {
		if a.Event == "checkin_sync_failed" {
			t.Fatalf("unexpected transient checkin_sync_failed audit: %+v", a)
		}
	}
}

func TestSyncCheckInsAuditsTerminalFailures(t *testing.T) {
	cases := []struct {
		name         string
		statusOnTry  func(attempt int) int
		wantAttempts int
		wantSleeps   []time.Duration
	}{
		{
			name:         "exhausts retries",
			statusOnTry:  func(int) int { return http.StatusNotFound },
			wantAttempts: 1 + len(syncRetryDelays),
			wantSleeps:   syncRetryDelays,
		},
		{
			name: "non-retryable error during retry stops and audits",
			statusOnTry: func(attempt int) int {
				if attempt == 1 {
					return http.StatusNotFound
				}
				return http.StatusBadRequest
			},
			wantAttempts: 2,
			wantSleeps:   syncRetryDelays[:1],
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			var attempts int
			sched, st := newTestSyncScheduler(t, func(w http.ResponseWriter, r *http.Request) {
				attempts++
				w.WriteHeader(tc.statusOnTry(attempts))
			})
			var sleeps []time.Duration
			sched.nowFn = func() time.Time { return time.Date(2026, 11, 15, 12, 0, 0, 0, core.Shanghai) }
			sched.sleepFn = func(_ context.Context, d time.Duration) bool {
				sleeps = append(sleeps, d)
				return true
			}

			sched.SyncCheckIns(context.Background())

			if attempts != tc.wantAttempts {
				t.Fatalf("attempts = %d, want %d", attempts, tc.wantAttempts)
			}
			if !reflect.DeepEqual(sleeps, tc.wantSleeps) {
				t.Fatalf("sleeps = %v, want %v", sleeps, tc.wantSleeps)
			}
			audits, err := st.ListAudit(10)
			if err != nil {
				t.Fatal(err)
			}
			var failed int
			for _, a := range audits {
				if a.Event == "checkin_sync_failed" {
					failed++
				}
			}
			if failed != 1 {
				t.Fatalf("checkin_sync_failed count = %d, want 1", failed)
			}
		})
	}
}
