package server

import (
	"encoding/json"
	"net/http"
)

func (s *Server) handleSessionStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Auth.Status())
}

func (s *Server) handleSessionLogin(w http.ResponseWriter, r *http.Request) {
	var body struct {
		StudentID string `json:"studentId"`
		Password  string `json:"password"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	res := s.Auth.LoginPassword(r.Context(), body.StudentID, body.Password)
	if res.Success {
		go s.Scheduler.SyncCheckIns(r.Context())
	}
	writeJSON(w, http.StatusOK, res)
}

func (s *Server) handleSessionOpenID(w http.ResponseWriter, r *http.Request) {
	var body struct {
		OpenID string `json:"openid"`
	}
	_ = json.NewDecoder(r.Body).Decode(&body)
	res := s.Auth.LoginOpenID(r.Context(), body.OpenID)
	if res.Success {
		go s.Scheduler.SyncCheckIns(r.Context())
	}
	writeJSON(w, http.StatusOK, res)
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
	if st.Status == "success" {
		go s.Scheduler.SyncCheckIns(r.Context())
	}
	writeJSON(w, http.StatusOK, st)
}

func (s *Server) handleSessionQRCancel(w http.ResponseWriter, r *http.Request) {
	uuid := r.PathValue("uuid")
	writeJSON(w, http.StatusOK, map[string]bool{"cancelled": s.Auth.CancelQrLogin(uuid)})
}

func (s *Server) handleSessionLogout(w http.ResponseWriter, r *http.Request) {
	_ = s.Auth.Logout()
	writeJSON(w, http.StatusOK, map[string]bool{"success": true})
}
