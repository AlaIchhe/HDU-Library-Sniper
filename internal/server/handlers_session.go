package server

import (
	"encoding/json"
	"net/http"

	"hdu-library-sniper/internal/api"
)

func (s *Server) handleSessionStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Auth.Status())
}

func (s *Server) handleSessionLogin(w http.ResponseWriter, r *http.Request) {
	var body api.LoginPasswordRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	res := s.Auth.LoginPassword(r.Context(), body.StudentID, body.Password)
	if res.Success {
		s.Scheduler.SyncAsync()
	}
	writeJSON(w, http.StatusOK, api.LoginResponse{
		Success: res.Success,
		Message: res.Message,
		Session: res.Session,
	})
}

func (s *Server) handleSessionOpenID(w http.ResponseWriter, r *http.Request) {
	var body api.LoginOpenIDRequest
	_ = json.NewDecoder(r.Body).Decode(&body)
	res := s.Auth.LoginOpenID(r.Context(), body.OpenID)
	if res.Success {
		s.Scheduler.SyncAsync()
	}
	writeJSON(w, http.StatusOK, api.LoginResponse{
		Success: res.Success,
		Message: res.Message,
		Session: res.Session,
	})
}

func (s *Server) handleSessionCreateQR(w http.ResponseWriter, r *http.Request) {
	start, err := s.Auth.CreateQrLogin(r.Context())
	if err != nil {
		if err.Error() == "当前扫码请求过多，请稍后再试" {
			writeError(w, http.StatusTooManyRequests, "已有二维码等待扫码，请稍后再试")
			return
		}
		writeError(w, http.StatusBadGateway, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, start)
}

func (s *Server) handleSessionQRStatus(w http.ResponseWriter, r *http.Request) {
	uuid := r.PathValue("uuid")
	st := s.Auth.PollQrLogin(uuid)
	if st.Status == string(api.QrLoginSuccess) {
		s.Scheduler.SyncAsync()
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleSessionQRCancel(w http.ResponseWriter, r *http.Request) {
	uuid := r.PathValue("uuid")
	writeJSON(w, http.StatusOK, api.QrCancelResponse{Cancelled: s.Auth.CancelQrLogin(uuid)})
}

func (s *Server) handleSessionLogout(w http.ResponseWriter, r *http.Request) {
	_ = s.Auth.Logout()
	writeJSON(w, http.StatusOK, api.SuccessResponse{Success: true})
}
