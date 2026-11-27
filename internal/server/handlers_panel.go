package server

import (
	"crypto/subtle"
	"encoding/json"
	"net/http"
	"strings"

	"hdu-library-sniper/internal/api"
)

func (s *Server) handlePanelAuthStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, api.PanelAuthStatusResponse{
		Required:      s.panelPassword != "",
		Authenticated: s.isPanelAuthenticated(r),
	})
}

func (s *Server) handlePanelAuthLogin(w http.ResponseWriter, r *http.Request) {
	if s.panelPassword == "" {
		writeJSON(w, http.StatusOK, api.PanelAuthStatusResponse{
			Required:      false,
			Authenticated: true,
		})
		return
	}
	var body api.PanelAuthRequest
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		writeError(w, http.StatusBadRequest, "请求格式错误")
		return
	}
	given := strings.TrimSpace(body.Password)
	if len(given) != len(s.panelPassword) ||
		subtle.ConstantTimeCompare([]byte(given), []byte(s.panelPassword)) != 1 {
		writeError(w, http.StatusUnauthorized, "访问密码错误")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     panelCookieName,
		Value:    s.panelCookieToken(),
		Path:     "/api",
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
		Secure:   r.TLS != nil || strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https"),
		MaxAge:   30 * 24 * 3600,
	})
	writeJSON(w, http.StatusOK, api.PanelAuthStatusResponse{
		Required:      true,
		Authenticated: true,
	})
}
