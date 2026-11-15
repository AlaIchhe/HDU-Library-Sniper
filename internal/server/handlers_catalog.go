package server

import (
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

var errNoFloorsAvailable = errors.New("该房间类型当前没有可预约楼层（可能尚未开放预约，请尝试其他房间类型）")

type floorsPayload struct {
	Options []core.FloorOption `json:"options"`
	Range   core.BookingRange  `json:"range"`
}

// catalogFlights coalesces concurrent cold loads or lazy refreshes per SQLite key.
type catalogFlights struct {
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func newCatalogFlights() *catalogFlights {
	return &catalogFlights{locks: make(map[string]*sync.Mutex)}
}

func (f *catalogFlights) lock(key string) *sync.Mutex {
	f.mu.Lock()
	defer f.mu.Unlock()
	m, ok := f.locks[key]
	if !ok {
		m = &sync.Mutex{}
		f.locks[key] = m
	}
	return m
}

func decodePersistedCatalog[T any](raw string) (T, bool) {
	var zero T
	if raw == "" {
		return zero, false
	}
	// Tolerate legacy TTL envelopes so existing SQLite rows don't decode into zero structs.
	var wrapped struct {
		ExpiresAt *int64          `json:"expiresAt"`
		Data      json.RawMessage `json:"data"`
	}
	payload := []byte(raw)
	if json.Unmarshal(payload, &wrapped) == nil && wrapped.ExpiresAt != nil && len(wrapped.Data) > 0 {
		payload = wrapped.Data
	}
	var val T
	if json.Unmarshal(payload, &val) != nil {
		return zero, false
	}
	return val, true
}

func savePersistedCatalog(s *Server, key string, val any) {
	if s.Store == nil {
		return
	}
	if raw, err := json.Marshal(val); err == nil {
		_ = s.Store.SetMeta(key, string(raw))
	}
}

func loadOrFetchCatalog[T any](
	s *Server,
	key string,
	forceRefresh bool,
	fetch func() (T, error),
) (T, error) {
	var zero T
	readStore := func() (T, bool) {
		if s.Store == nil {
			return zero, false
		}
		raw, err := s.Store.GetMeta(key)
		if err != nil {
			return zero, false
		}
		return decodePersistedCatalog[T](raw)
	}

	if !forceRefresh {
		if stored, ok := readStore(); ok {
			return stored, nil
		}
	}

	if s.catalog != nil {
		lk := s.catalog.lock(key)
		lk.Lock()
		defer lk.Unlock()
		if !forceRefresh {
			if stored, ok := readStore(); ok {
				return stored, nil
			}
		}
	}

	fresh, err := fetch()
	if err != nil {
		return zero, err
	}
	savePersistedCatalog(s, key, fresh)
	return fresh, nil
}

func wantsRefresh(r *http.Request) bool {
	v := strings.TrimSpace(r.URL.Query().Get("refresh"))
	return v == "1" || strings.EqualFold(v, "true")
}

func (s *Server) handleRoomTypes(w http.ResponseWriter, r *http.Request) {
	opts, err := loadOrFetchCatalog(
		s,
		"catalog:room_types",
		wantsRefresh(r),
		func() ([]core.RoomTypeOption, error) {
			return s.Auth.Client.RoomTypes(r.Context())
		},
	)
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
	refresh := wantsRefresh(r)

	payload, err := loadOrFetchCatalog(
		s,
		"catalog:floors:"+roomQuery,
		refresh,
		func() (floorsPayload, error) {
			if refresh {
				s.Auth.Client.ClearRoomMeta()
			}
			br, err := s.Auth.Client.BookingRange(r.Context(), roomQuery)
			if err != nil {
				return floorsPayload{}, err
			}
			nowLocal := time.Now().In(core.Shanghai)
			targetDate := nowLocal.AddDate(0, 0, core.BookingDayOffsetFor(roomType))
			lookup := time.Date(targetDate.Year(), targetDate.Month(), targetDate.Day(), 10, 0, 0, 0, core.Shanghai).UTC()

			rawFloors, err := s.Auth.Client.Floors(r.Context(), roomQuery, lookup, 1)
			if err != nil {
				return floorsPayload{}, err
			}
			opts := make([]core.FloorOption, 0, len(rawFloors))
			for _, rf := range rawFloors {
				if opt := hdu.FloorOptionFromRaw(rf); opt != nil {
					opts = append(opts, *opt)
				}
			}
			if len(opts) == 0 {
				return floorsPayload{}, errNoFloorsAvailable
			}
			savePersistedCatalog(s, "catalog:range:"+roomQuery, br)
			return floorsPayload{Options: opts, Range: br}, nil
		},
	)
	if err != nil {
		if errors.Is(err, errNoFloorsAvailable) {
			writeError(w, http.StatusBadGateway, err.Error())
			return
		}
		writeHDUError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, payload)
}

func (s *Server) handleDurations(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	roomQuery := strings.TrimSpace(q.Get("roomQuery"))
	if roomQuery == "" {
		writeError(w, http.StatusBadRequest, "缺少房间查询参数")
		return
	}
	startHour, err := strconv.ParseInt(q.Get("startHour"), 10, 64)
	if err != nil || startHour < 0 || startHour > 23 {
		writeError(w, http.StatusBadRequest, "开始时间无效")
		return
	}
	refresh := wantsRefresh(r)
	br, err := loadOrFetchCatalog(
		s,
		"catalog:range:"+roomQuery,
		refresh,
		func() (core.BookingRange, error) {
			if refresh {
				s.Auth.Client.ClearRoomMeta()
			}
			return s.Auth.Client.BookingRange(r.Context(), roomQuery)
		},
	)
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
