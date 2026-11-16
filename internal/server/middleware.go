package server

import (
	"encoding/json"
	"net"
	"net/http"
	"net/url"
	"os"
	"strings"
	"sync"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/hdu"
)

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, api.ErrorResponse{Detail: msg})
}

func writeHDUError(w http.ResponseWriter, err error) {
	if hdu.IsRequestTimeout(err) {
		writeError(w, http.StatusGatewayTimeout, err.Error())
		return
	}
	writeError(w, http.StatusBadGateway, err.Error())
}

// RateLimiter enforces fixed 1-minute buckets per key (login/qr/checkin/api).
type RateLimiter struct {
	mu      sync.Mutex
	buckets map[string]rateBucket
}

type rateBucket struct {
	count   int
	resetAt time.Time
}

func NewRateLimiter() *RateLimiter {
	return &RateLimiter{buckets: make(map[string]rateBucket)}
}

func (rl *RateLimiter) Allow(bucket string, maxPerMin int) bool {
	now := time.Now()
	rl.mu.Lock()
	defer rl.mu.Unlock()
	b := rl.buckets[bucket]
	if now.After(b.resetAt) {
		b = rateBucket{count: 0, resetAt: now.Add(time.Minute)}
	}
	if b.count >= maxPerMin {
		rl.buckets[bucket] = b
		return false
	}
	b.count++
	rl.buckets[bucket] = b
	return true
}

func (s *Server) withMiddleware(next http.Handler) http.Handler {
	allowedHosts := parseAllowedHosts(os.Getenv("HDU_ALLOWED_HOSTS"))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		path := r.URL.Path
		if !strings.HasPrefix(path, "/api/") {
			next.ServeHTTP(w, r)
			return
		}

		origin := strings.TrimSpace(r.Header.Get("Origin"))
		if origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173" {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") {
			writeError(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		if origin != "" && !isTrustedOrigin(origin, r.Host, allowedHosts) {
			writeError(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}

		if path != api.PathHealth {
			bucket, limit := rateBucketFor(path)
			if !s.limiter.Allow(bucket, limit) {
				writeError(w, http.StatusTooManyRequests, "请求过于频繁，请稍后再试")
				return
			}
		}

		next.ServeHTTP(w, r)
	})
}

func (s *Server) requireAuth(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !s.Auth.Authenticated() {
			writeError(w, http.StatusUnauthorized, "authentication required")
			return
		}
		next(w, r)
	}
}

func rateBucketFor(path string) (string, int) {
	switch path {
	case api.PathSessionLogin, api.PathSessionOpenID:
		return "login", 5
	case api.PathSessionQR:
		return "qr", 3
	case api.PathCheckInEnable, api.PathCheckInDisable:
		return "checkin", 10
	default:
		if strings.Contains(path, "/bookings/") && strings.HasSuffix(path, "/"+string(api.BookingActionCheckIn)) {
			return "checkin", 10
		}
		return "api", 240
	}
}

func parseAllowedHosts(raw string) map[string]bool {
	out := make(map[string]bool)
	for _, item := range strings.Split(raw, ",") {
		h := strings.ToLower(strings.TrimSpace(item))
		if h != "" {
			out[h] = true
		}
	}
	return out
}

func isTrustedOrigin(origin, reqHost string, extra map[string]bool) bool {
	if origin == "mygo://localhost" || origin == "http://mygo.localhost" ||
		origin == "http://localhost:5173" || origin == "http://127.0.0.1:5173" {
		return true
	}
	u, err := url.Parse(origin)
	if err != nil {
		return false
	}
	originHost := strings.ToLower(u.Hostname())
	if originHost == "" {
		return false
	}
	if originHost == "localhost" || originHost == "127.0.0.1" || originHost == "::1" || net.ParseIP(originHost) != nil {
		return true
	}
	reqHostname := strings.ToLower(stripPort(reqHost))
	if reqHostname != "" && originHost == reqHostname {
		return true
	}
	return extra[originHost]
}

func stripPort(hostport string) string {
	if host, _, err := net.SplitHostPort(hostport); err == nil {
		return host
	}
	return hostport
}
