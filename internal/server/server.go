package server

import (
	"crypto/rand"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
	"hdu-library-sniper/internal/events"
	"hdu-library-sniper/internal/scheduler"
	"hdu-library-sniper/internal/store"
)

// Options configures optional server security boundaries.
type Options struct {
	// DesktopToken enforces per-launch Bearer/query token authentication for local desktop WebViews.
	DesktopToken string
	// PanelPassword enables independent HttpOnly cookie authentication for Web/Container deployments.
	PanelPassword string
}

// Server wires the REST API router and optional embedded SPA assets.
type Server struct {
	Store         *store.Store
	Auth          *auth.Service
	Booking       *booking.Executor
	Scheduler     *scheduler.Scheduler
	Events        *events.Bus
	Frontend      fs.FS
	desktopToken  string
	panelPassword string
	panelSignKey  []byte
	limiter       *RateLimiter
	catalog       *catalogFlights
}

func New(st *store.Store, authSvc *auth.Service, exec *booking.Executor, sched *scheduler.Scheduler, frontend fs.FS) *Server {
	return NewWithOptions(st, authSvc, exec, sched, events.NewBus(), frontend, Options{})
}

func NewWithOptions(
	st *store.Store,
	authSvc *auth.Service,
	exec *booking.Executor,
	sched *scheduler.Scheduler,
	bus *events.Bus,
	frontend fs.FS,
	opts Options,
) *Server {
	if bus == nil {
		bus = events.NewBus()
	}
	signKey := make([]byte, 32)
	_, _ = rand.Read(signKey)
	return &Server{
		Store:         st,
		Auth:          authSvc,
		Booking:       exec,
		Scheduler:     sched,
		Events:        bus,
		Frontend:      frontend,
		desktopToken:  strings.TrimSpace(opts.DesktopToken),
		panelPassword: strings.TrimSpace(opts.PanelPassword),
		panelSignKey:  signKey,
		limiter:       NewRateLimiter(),
		catalog:       newCatalogFlights(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public health & panel auth routes
	mux.HandleFunc("GET "+api.PathHealth, func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, api.HealthResponse{Status: "ok"})
	})
	mux.HandleFunc("GET "+api.PathPanelAuthStatus, s.handlePanelAuthStatus)
	mux.HandleFunc("POST "+api.PathPanelAuthLogin, s.handlePanelAuthLogin)

	// Session routes (require panel auth when enabled, public wrt HDU session)
	mux.HandleFunc("GET "+api.PathSessionStatus, s.handleSessionStatus)
	mux.HandleFunc("POST "+api.PathSessionLogin, s.handleSessionLogin)
	mux.HandleFunc("POST "+api.PathSessionOpenID, s.handleSessionOpenID)
	mux.HandleFunc("POST "+api.PathSessionQR, s.handleSessionCreateQR)
	mux.HandleFunc("GET "+api.PathSessionQRStatus, s.handleSessionQRStatus)
	mux.HandleFunc("GET "+api.PathSessionQREvents, s.handleSessionQREvents)
	mux.HandleFunc("POST "+api.PathSessionQRCancel, s.handleSessionQRCancel)
	mux.HandleFunc("POST "+api.PathSessionLogout, s.handleSessionLogout)

	// Protected workspace routes (require HDU session)
	mux.HandleFunc("GET "+api.PathEvents, s.requireAuth(s.handleEvents))
	mux.HandleFunc("GET "+api.PathAudit, s.requireAuth(s.handleListAudit))
	mux.HandleFunc("GET "+api.PathPlans, s.requireAuth(s.handleListPlans))
	mux.HandleFunc("POST "+api.PathPlans, s.requireAuth(s.handleCreatePlan))
	mux.HandleFunc("GET "+api.PathPlanByID, s.requireAuth(s.handleGetPlan))
	mux.HandleFunc("PATCH "+api.PathPlanByID, s.requireAuth(s.handleUpdatePlan))
	mux.HandleFunc("DELETE "+api.PathPlanByID, s.requireAuth(s.handleDeletePlan))
	mux.HandleFunc("POST "+api.PathPlanToggle, s.requireAuth(s.handleTogglePlan))

	mux.HandleFunc("GET "+api.PathCatalogRoomTypes, s.requireAuth(s.handleRoomTypes))
	mux.HandleFunc("GET "+api.PathCatalogFloors, s.requireAuth(s.handleFloors))
	mux.HandleFunc("GET "+api.PathCatalogDurations, s.requireAuth(s.handleDurations))

	mux.HandleFunc("GET "+api.PathBookingsCurrent, s.requireAuth(s.handleCurrentBookings))
	mux.HandleFunc("POST "+api.PathBookingAction, s.requireAuth(s.handleBookingAction))

	mux.HandleFunc("POST "+api.PathBookingRun, s.requireAuth(s.handleBookingRun))
	mux.HandleFunc("GET "+api.PathRuntimeStatus, s.requireAuth(s.handleRuntimeStatus))
	mux.HandleFunc("GET "+api.PathRuntimeNextTarget, s.requireAuth(s.handleNextTarget))
	mux.HandleFunc("GET "+api.PathCheckIn, s.requireAuth(s.handleGetCheckIn))
	mux.HandleFunc("POST "+api.PathCheckInEnable, s.requireAuth(s.handleEnableCheckIn))
	mux.HandleFunc("POST "+api.PathCheckInDisable, s.requireAuth(s.handleDisableCheckIn))

	// Fallback for unknown /api/*
	mux.HandleFunc("/api/", func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusNotFound, "not found")
	})

	// Optional embedded SPA static handler (container server mode)
	if s.Frontend != nil {
		fileServer := http.FileServerFS(s.Frontend)
		mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
			clean := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
			if clean != "" {
				if info, err := fs.Stat(s.Frontend, clean); err == nil && !info.IsDir() {
					fileServer.ServeHTTP(w, r)
					return
				}
			}
			f, err := s.Frontend.Open("index.html")
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer f.Close()
			w.Header().Set("Content-Type", "text/html; charset=utf-8")
			_, _ = io.Copy(w, f)
		})
	}

	return s.withMiddleware(mux)
}
