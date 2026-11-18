package app

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"testing"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/events"
)

func TestResolveHomeDirPrecedence(t *testing.T) {
	t.Setenv("HDU_SNIPER_HOME", "/tmp/hdu-env-home")
	if got := ResolveHomeDir("/tmp/fallback"); got != "/tmp/hdu-env-home" {
		t.Fatalf("ResolveHomeDir with env = %q", got)
	}

	t.Setenv("HDU_SNIPER_HOME", "")
	if got := ResolveHomeDir("/tmp/fallback"); got != "/tmp/fallback" {
		t.Fatalf("ResolveHomeDir with fallback = %q", got)
	}
}

func TestOpenCreatesDatabaseAndServesHealth(t *testing.T) {
	t.Setenv("HDU_SNIPER_HOME", "")
	home := t.TempDir()
	rt, err := Open(home, nil)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer func() { _ = rt.Close() }()

	if _, err := os.Stat(filepath.Join(home, "data", "sniper.db")); err != nil {
		t.Fatalf("expected sniper.db in data dir: %v", err)
	}

	rec := httptest.NewRecorder()
	rt.Handler.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health status = %d", rec.Code)
	}
}

func TestWireEventBusPublishesDomainEvents(t *testing.T) {
	t.Setenv("HDU_SNIPER_HOME", "")
	rt, err := Open(t.TempDir(), nil)
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}
	defer func() { _ = rt.Close() }()

	ch, unsub := rt.Events.Subscribe()
	defer unsub()

	nextEvent := func() events.Message {
		t.Helper()
		select {
		case msg := <-ch:
			return msg
		case <-time.After(2 * time.Second):
			t.Fatal("timed out waiting for event on bus")
			return events.Message{}
		}
	}

	// Non-terminal checkin_failed and unrelated audits must not publish AppEvent.
	if err := rt.Store.WriteAudit("booking_prelock_skipped", map[string]any{"reason": "test"}); err != nil {
		t.Fatal(err)
	}
	if err := rt.Store.WriteAudit("checkin_failed", map[string]any{"bookingId": "b1", "terminal": false}); err != nil {
		t.Fatal(err)
	}
	time.Sleep(30 * time.Millisecond)
	select {
	case msg := <-ch:
		t.Fatalf("unexpected event for non-notifiable audit: %+v", msg)
	default:
	}

	// Terminal booking_run_finished publishes AppEventAudit with bookings + nextTarget invalidations.
	if err := rt.Store.WriteAudit("booking_run_finished", map[string]any{"success": true, "message": "已预约"}); err != nil {
		t.Fatal(err)
	}
	msg := nextEvent()
	if msg.Name != events.TopicAppEvent {
		t.Fatalf("unexpected topic: %q", msg.Name)
	}
	var ev api.AppEvent
	if err := json.Unmarshal(msg.RawJSON, &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Kind != api.AppEventAudit || ev.Audit == nil || ev.Audit.Event != "booking_run_finished" ||
		!slices.Contains(ev.Invalidate, api.InvalidateBookings) || !slices.Contains(ev.Invalidate, api.InvalidateNextTarget) {
		t.Fatalf("unexpected audit event: %+v", ev)
	}

	// Scheduler change publishes AppEventRuntime.
	rt.Scheduler.SetAutoCheckIn(true, true)
	msg = nextEvent()
	if err := json.Unmarshal(msg.RawJSON, &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Kind != api.AppEventRuntime || ev.Runtime == nil || !slices.Contains(ev.Invalidate, api.InvalidateCheckIn) {
		t.Fatalf("unexpected runtime event: %+v", ev)
	}

	// Auth MarkLost publishes AppEventSession when state transitions.
	rt.Auth.MarkLost()
	msg = nextEvent()
	if err := json.Unmarshal(msg.RawJSON, &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Kind != api.AppEventSession || ev.Session == nil || ev.Session.Authenticated || ev.Session.LastError == "" {
		t.Fatalf("unexpected session event: %+v", ev)
	}
}
