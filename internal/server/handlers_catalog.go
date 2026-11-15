package server

import (
	"net/http"
	"strconv"
	"strings"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

func (s *Server) handleRoomTypes(w http.ResponseWriter, r *http.Request) {
	opts, err := s.Auth.Client.RoomTypes(r.Context())
	if err != nil {
		writeHDUError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"options": core.NonNil(opts)})
}

func (s *Server) handleFloors(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	roomQuery := strings.TrimSpace(q.Get("roomQuery"))
	if roomQuery == "" {
		writeError(w, http.StatusBadRequest, "缺少房间查询参数")
		return
	}
	roomType := q.Get("roomType")

	br, err := s.Auth.Client.BookingRange(r.Context(), roomQuery)
	if err != nil {
		writeHDUError(w, err)
		return
	}
	offset := core.BookingDayOffsetFor(roomType)
	nowLocal := time.Now().In(core.Shanghai)
	targetDate := nowLocal.AddDate(0, 0, offset)
	lookup := time.Date(targetDate.Year(), targetDate.Month(), targetDate.Day(), 10, 0, 0, 0, core.Shanghai).UTC()

	rawFloors, err := s.Auth.Client.Floors(r.Context(), roomQuery, lookup, 1)
	if err != nil {
		writeHDUError(w, err)
		return
	}
	opts := make([]core.FloorOption, 0, len(rawFloors))
	for _, rf := range rawFloors {
		if opt := hdu.FloorOptionFromRaw(rf); opt != nil {
			opts = append(opts, *opt)
		}
	}
	if len(opts) == 0 {
		writeError(w, http.StatusBadGateway, "该房间类型当前没有可预约楼层（可能尚未开放预约，请尝试其他房间类型）")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"options": opts,
		"range":   br,
	})
}

func (s *Server) handleDurations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	roomQuery := strings.TrimSpace(q.Get("roomQuery"))
	startHour, err := strconv.ParseInt(q.Get("startHour"), 10, 64)
	if err != nil || startHour < 0 || startHour > 23 {
		writeError(w, http.StatusBadRequest, "开始时间无效")
		return
	}
	br, err := s.Auth.Client.BookingRange(r.Context(), roomQuery)
	if err != nil {
		writeHDUError(w, err)
		return
	}
	maxDur := br.MaxDuration
	if br.MaxEndTime > startHour && br.MaxEndTime-startHour < maxDur {
		maxDur = br.MaxEndTime - startHour
	}
	opts := make([]int64, 0)
	for d := br.MinDuration; d <= maxDur; d++ {
		opts = append(opts, d)
	}
	writeJSON(w, http.StatusOK, core.DurationOptions{
		RoomQuery: roomQuery,
		StartHour: startHour,
		Options:   opts,
	})
}
