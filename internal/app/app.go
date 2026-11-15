package app

import (
	"context"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
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
	return &Runtime{
		Store:     st,
		Auth:      authSvc,
		Booking:   exec,
		Scheduler: sched,
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
	return r.Store.Close()
}
