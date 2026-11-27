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

// Options configures optional runtime behaviors such as desktop bearer token or panel password auth.
type Options struct {
	DesktopToken  string
	PanelPassword string
}

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

func Open(homeDir string, frontend fs.FS, opts ...Options) (*Runtime, error) {
	var cfg Options
	if len(opts) > 0 {
		cfg = opts[0]
	}
	if cfg.PanelPassword == "" {
		cfg.PanelPassword = strings.TrimSpace(os.Getenv("HDU_PANEL_PASSWORD"))
	}

	dataDir := filepath.Join(ResolveHomeDir(homeDir), "data")
	st, err := store.Open(filepath.Join(dataDir, "sniper.db"))
	if err != nil {
		return nil, err
	}
	secrets, err := auth.OpenSecretStore(dataDir)
	if err != nil {
		_ = st.Close()
		return nil, err
	}
	bus := events.NewBus()
	authSvc := auth.NewService(st, secrets)
	exec := booking.NewExecutor(st, bus)
	sched := scheduler.New(st, authSvc, exec, bus)
	srv := server.NewWithOptions(st, authSvc, exec, sched, bus, frontend, server.Options{
		DesktopToken:  cfg.DesktopToken,
		PanelPassword: cfg.PanelPassword,
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

	return &Runtime{
		Store:     st,
		Auth:      authSvc,
		Booking:   exec,
		Scheduler: sched,
		Events:    bus,
		Handler:   srv.Handler(),
	}, nil
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
