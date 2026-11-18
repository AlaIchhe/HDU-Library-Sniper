package app

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/events"
	"hdu-library-sniper/internal/scheduler"
	"hdu-library-sniper/internal/server"
	"hdu-library-sniper/internal/store"
)

// Runtime bundles the shared backend services used by both cmd/server and the MyGo desktop app.
type Runtime struct {
	Store     *store.Store
	Auth      *auth.Service
	Booking   *booking.Executor
	Scheduler *scheduler.Scheduler
	Events    *events.Bus
	Handler   http.Handler
}

// ResolveHomeDir returns HDU_SNIPER_HOME, fallbackDir when non-empty, or $HOME/.hdu-library-sniper.
func ResolveHomeDir(fallbackDir string) string {
	if env := strings.TrimSpace(os.Getenv("HDU_SNIPER_HOME")); env != "" {
		return env
	}
	if strings.TrimSpace(fallbackDir) != "" {
		return fallbackDir
	}
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return "."
	}
	return filepath.Join(home, ".hdu-library-sniper")
}

func Open(homeDir string, frontend fs.FS) (*Runtime, error) {
	dataDir := filepath.Join(ResolveHomeDir(homeDir), "data")
	st, err := store.Open(filepath.Join(dataDir, "sniper.db"))
	if err != nil {
		return nil, err
	}
	secrets := auth.OpenSecretStore(dataDir)
	authSvc := auth.NewService(st, secrets)
	exec := booking.NewExecutor(st)
	sched := scheduler.New(st, authSvc, exec)
	srv := server.New(st, authSvc, exec, sched, frontend)
	wireEventBus(st, authSvc, sched, srv.Events)
	return &Runtime{
		Store:     st,
		Auth:      authSvc,
		Booking:   exec,
		Scheduler: sched,
		Events:    srv.Events,
		Handler:   srv.Handler(),
	}, nil
}

func wireEventBus(st *store.Store, authSvc *auth.Service, sched *scheduler.Scheduler, bus *events.Bus) {
	st.SetOnAudit(func(event string, payload map[string]any) {
		var invalidate []api.InvalidateTarget
		switch event {
		case "booking_run_finished":
			invalidate = []api.InvalidateTarget{api.InvalidateBookings, api.InvalidateNextTarget}
		case "checkin_succeeded", "checkin_missed":
			invalidate = []api.InvalidateTarget{api.InvalidateBookings, api.InvalidateNextTarget, api.InvalidateCheckIn}
		case "checkin_failed":
			if !core.ToBool(payload["terminal"]) {
				return
			}
			invalidate = []api.InvalidateTarget{api.InvalidateBookings, api.InvalidateNextTarget, api.InvalidateCheckIn}
		default:
			return
		}
		bus.Publish(events.TopicAppEvent, api.AppEvent{
			Kind:       api.AppEventAudit,
			Invalidate: invalidate,
			Audit: &api.AuditNotification{
				Event:   event,
				Payload: payload,
			},
		})
	})

	authSvc.SetOnSessionChange(func(status core.SessionStatus) {
		stCopy := status
		bus.Publish(events.TopicAppEvent, api.AppEvent{
			Kind:    api.AppEventSession,
			Session: &stCopy,
		})
	})

	authSvc.SetOnQrChange(func(uuid string, qrStatus core.QrLoginStatus) {
		if qrStatus.Status == string(api.QrLoginSuccess) {
			sched.ClearAuthRequired()
			sched.SyncAsync()
		}
		bus.Publish(events.TopicQrStatus, api.QrStatusEvent{
			UUID:    uuid,
			Status:  api.QrLoginPhase(qrStatus.Status),
			Message: qrStatus.Message,
			Session: qrStatus.Session,
		})
	})

	sched.SetOnChange(func(rtStatus core.RuntimeStatus, rawTargets []string) {
		stCopy := rtStatus
		targets := make([]api.InvalidateTarget, 0, len(rawTargets))
		for _, t := range rawTargets {
			targets = append(targets, api.InvalidateTarget(t))
		}
		bus.Publish(events.TopicAppEvent, api.AppEvent{
			Kind:       api.AppEventRuntime,
			Runtime:    &stCopy,
			Invalidate: targets,
		})
	})
}

func (r *Runtime) Start(ctx context.Context) {
	go func() {
		r.Auth.Restore(ctx)
		r.Scheduler.Start(ctx)
	}()
}

func (r *Runtime) Close() error {
	if r.Events != nil {
		r.Events.Close()
	}
	return r.Store.Close()
}
