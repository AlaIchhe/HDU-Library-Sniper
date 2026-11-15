package server

import (
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"

	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
	"hdu-library-sniper/internal/scheduler"
	"hdu-library-sniper/internal/store"
)

// Server wires the REST API router and optional embedded SPA assets.
type Server struct {
	Store     *store.Store
	Auth      *auth.Service
	Booking   *booking.Executor
	Scheduler *scheduler.Scheduler
	Frontend  fs.FS
	limiter   *RateLimiter
	catalog   *catalogCache
}

func New(st *store.Store, authSvc *auth.Service, exec *booking.Executor, sched *scheduler.Scheduler, frontend fs.FS) *Server {
	return &Server{
		Store:     st,
		Auth:      authSvc,
		Booking:   exec,
		Scheduler: sched,
		Frontend:  frontend,
		limiter:   NewRateLimiter(),
		catalog:   newCatalogCache(),
	}
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public session & health routes
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	mux.HandleFunc("GET /api/session", s.handleSessionStatus)
	mux.HandleFunc("POST /api/session/login", s.handleSessionLogin)
	mux.HandleFunc("POST /api/session/openid", s.handleSessionOpenID)
	mux.HandleFunc("POST /api/session/qr", s.handleSessionCreateQR)
	mux.HandleFunc("GET /api/session/qr/{uuid}/status", s.handleSessionQRStatus)
	mux.HandleFunc("POST /api/session/qr/{uuid}/cancel", s.handleSessionQRCancel)
	mux.HandleFunc("POST /api/session/logout", s.handleSessionLogout)

	// Protected workspace routes
	mux.HandleFunc("GET /api/audit", s.requireAuth(s.handleListAudit))
	mux.HandleFunc("GET /api/plans", s.requireAuth(s.handleListPlans))
	mux.HandleFunc("POST /api/plans", s.requireAuth(s.handleCreatePlan))
	mux.HandleFunc("GET /api/plans/{id}", s.requireAuth(s.handleGetPlan))
	mux.HandleFunc("PATCH /api/plans/{id}", s.requireAuth(s.handleUpdatePlan))
	mux.HandleFunc("DELETE /api/plans/{id}", s.requireAuth(s.handleDeletePlan))
	mux.HandleFunc("POST /api/plans/{id}/{action}", s.requireAuth(s.handleTogglePlan))

	mux.HandleFunc("POST /api/groups", s.requireAuth(s.handleCreateGroup))
	mux.HandleFunc("GET /api/groups/{id}", s.requireAuth(s.handleGetGroup))
	mux.HandleFunc("PATCH /api/groups/{id}", s.requireAuth(s.handleUpdateGroup))
	mux.HandleFunc("DELETE /api/groups/{id}", s.requireAuth(s.handleDeleteGroup))

	mux.HandleFunc("GET /api/catalog/room-types", s.requireAuth(s.handleRoomTypes))
	mux.HandleFunc("GET /api/catalog/floors", s.requireAuth(s.handleFloors))
	mux.HandleFunc("GET /api/catalog/durations", s.requireAuth(s.handleDurations))

	mux.HandleFunc("GET /api/bookings/current", s.requireAuth(s.handleCurrentBookings))
	mux.HandleFunc("POST /api/bookings/{id}/{action}", s.requireAuth(s.handleBookingAction))

	mux.HandleFunc("POST /api/booking/run", s.requireAuth(s.handleBookingRun))
	mux.HandleFunc("GET /api/runtime/status", s.requireAuth(s.handleRuntimeStatus))
	mux.HandleFunc("GET /api/runtime/next-target", s.requireAuth(s.handleNextTarget))
	mux.HandleFunc("GET /api/checkin", s.requireAuth(s.handleGetCheckIn))
	mux.HandleFunc("POST /api/checkin/enable", s.requireAuth(s.handleEnableCheckIn))
	mux.HandleFunc("POST /api/checkin/disable", s.requireAuth(s.handleDisableCheckIn))

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
