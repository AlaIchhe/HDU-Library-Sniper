package server

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

func (s *Server) handleCurrentBookings(w http.ResponseWriter, r *http.Request) {
	raw, err := s.Auth.Client.Bookings(r.Context())
	if err != nil {
		writeHDUError(w, err)
		return
	}
	s.Scheduler.ObserveBookings(raw)
	now := time.Now()
	bookings := make([]core.Booking, 0, len(raw))
	for _, it := range raw {
		if b := hdu.BookingFromRaw(it, now); b != nil {
			bookings = append(bookings, *b)
		}
	}
	writeJSON(w, http.StatusOK, api.BookingsListResponse{Bookings: bookings})
}

func (s *Server) handleBookingAction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	action := hdu.Action(r.PathValue("action"))
	switch api.BookingAction(action) {
	case api.BookingActionCancel, api.BookingActionCheckIn, api.BookingActionComeBack, api.BookingActionSignOut, api.BookingActionLeave:
	default:
		writeError(w, http.StatusNotFound, "不支持的预约操作")
		return
	}
	if _, err := s.Auth.Client.Action(r.Context(), action, id); err != nil {
		writeHDUError(w, err)
		return
	}
	if action == hdu.ActionCheckIn {
		s.Scheduler.NoteCheckedIn(id)
	} else if action == hdu.ActionCancel {
		s.Scheduler.Forget(id)
	}
	writeJSON(w, http.StatusOK, api.ActionResponse{Success: true, Message: "操作成功"})
}

func (s *Server) handleBookingRun(w http.ResponseWriter, r *http.Request) {
	ok, msg := s.Scheduler.RunNow(r.Context())
	writeJSON(w, http.StatusOK, api.ActionResponse{Success: ok, Message: msg})
}

func (s *Server) handleRuntimeStatus(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Scheduler.Status())
}

func (s *Server) handleNextTarget(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Scheduler.NextExecutionTarget())
}

func (s *Server) handleGetCheckIn(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.Scheduler.CheckInStatus())
}

func (s *Server) handleEnableCheckIn(w http.ResponseWriter, r *http.Request) {
	var in api.EnableCheckInRequest
	_ = json.NewDecoder(r.Body).Decode(&in)
	if !in.Agreed {
		writeError(w, http.StatusBadRequest, "请先阅读并同意自动签到确认声明")
		return
	}
	s.Scheduler.SetAutoCheckIn(true, true)
	s.Scheduler.SyncAsync()
	writeJSON(w, http.StatusOK, s.Scheduler.CheckInStatus())
}

func (s *Server) handleDisableCheckIn(w http.ResponseWriter, r *http.Request) {
	s.Scheduler.SetAutoCheckIn(false, false)
	writeJSON(w, http.StatusOK, s.Scheduler.CheckInStatus())
}

func (s *Server) handleListAudit(w http.ResponseWriter, r *http.Request) {
	limit := 20
	if raw := r.URL.Query().Get("limit"); raw != "" {
		if n, err := strconv.Atoi(raw); err == nil && n > 0 {
			limit = n
		}
	}
	events, err := s.Store.ListAudit(limit)
	if err != nil {
		writeError(w, http.StatusInternalServerError, err.Error())
		return
	}
	writeJSON(w, http.StatusOK, api.AuditListResponse{Events: core.NonNil(events)})
}
