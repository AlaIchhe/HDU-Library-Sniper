package server

import (
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
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

const panelCookieName = "hdu_panel_session"

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
		if isCORSAllowedOrigin(origin) {
			w.Header().Set("Access-Control-Allow-Origin", origin)
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Content-Type, Authorization")
			w.Header().Set("Access-Control-Allow-Credentials", "true")
			w.Header().Set("Vary", "Origin")
		}
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}

		if origin != "" && !isTrustedOrigin(origin, r.Host, allowedHosts) {
			writeError(w, http.StatusForbidden, "cross-origin request rejected")
			return
		}
		if strings.EqualFold(r.Header.Get("Sec-Fetch-Site"), "cross-site") && !isDesktopOrigin(origin) {
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

		// Desktop mode: every API call except /api/health must carry the per-launch token.
		if s.desktopToken != "" && path != api.PathHealth {
			if !s.hasValidDesktopToken(r) {
				writeError(w, http.StatusUnauthorized, "invalid desktop token")
				return
			}
		}

		// Container/Web mode: when HDU_PANEL_PASSWORD is set, gate all API routes behind panel auth.
		if s.panelPassword != "" && path != api.PathHealth && path != api.PathPanelAuthStatus && path != api.PathPanelAuthLogin {
			if !s.isPanelAuthenticated(r) {
				writeError(w, http.StatusUnauthorized, "panel authentication required")
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

func (s *Server) hasValidDesktopToken(r *http.Request) bool {
	if s.desktopToken == "" {
		return true
	}
	token := ""
	if authz := strings.TrimSpace(r.Header.Get("Authorization")); strings.HasPrefix(authz, "Bearer ") {
		token = strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
	} else if q := strings.TrimSpace(r.URL.Query().Get("token")); q != "" {
		token = q
	}
	return len(token) == len(s.desktopToken) &&
		subtle.ConstantTimeCompare([]byte(token), []byte(s.desktopToken)) == 1
}

func (s *Server) panelCookieToken() string {
	mac := hmac.New(sha256.New, s.panelSignKey)
	_, _ = mac.Write([]byte("panel:" + s.panelPassword))
	return hex.EncodeToString(mac.Sum(nil))
}

func (s *Server) isPanelAuthenticated(r *http.Request) bool {
	if s.panelPassword == "" {
		return true
	}
	expected := s.panelCookieToken()
	if c, err := r.Cookie(panelCookieName); err == nil {
		if len(c.Value) == len(expected) && subtle.ConstantTimeCompare([]byte(c.Value), []byte(expected)) == 1 {
			return true
		}
	}
	if authz := strings.TrimSpace(r.Header.Get("Authorization")); strings.HasPrefix(authz, "Bearer ") {
		raw := strings.TrimSpace(strings.TrimPrefix(authz, "Bearer "))
		if len(raw) == len(s.panelPassword) && subtle.ConstantTimeCompare([]byte(raw), []byte(s.panelPassword)) == 1 {
			return true
		}
	}
	return false
}

func rateBucketFor(path string) (string, int) {
	switch path {
	case api.PathSessionLogin, api.PathSessionOpenID, api.PathPanelAuthLogin:
		return "login", 5
	case api.PathSessionQR:
		return "qr", 10
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

func isDesktopOrigin(origin string) bool {
	return origin == "mygo://localhost" || origin == "http://mygo.localhost"
}

func isCORSAllowedOrigin(origin string) bool {
	return isDesktopOrigin(origin) ||
		origin == "http://localhost:5173" ||
		origin == "http://127.0.0.1:5173"
}

func isTrustedOrigin(origin, reqHost string, extra map[string]bool) bool {
	if isCORSAllowedOrigin(origin) {
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
	if originHost == "localhost" || originHost == "127.0.0.1" || originHost == "::1" {
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
