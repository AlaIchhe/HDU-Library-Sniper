package server

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

const catalogStaleAfter = 30 * 24 * time.Hour

var errNoFloorsAvailable = errors.New("该房间类型当前没有可预约楼层（可能尚未开放预约，请尝试其他房间类型）")

// catalogFlights coalesces concurrent cold loads and background refreshes per cache key.
type catalogFlights struct {
	mu         sync.Mutex
	locks      map[string]*sync.Mutex
	refreshing map[string]bool
}

func newCatalogFlights() *catalogFlights {
	return &catalogFlights{
		locks:      make(map[string]*sync.Mutex),
		refreshing: make(map[string]bool),
	}
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

func (f *catalogFlights) tryStartRefresh(key string) bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.refreshing[key] {
		return false
	}
	f.refreshing[key] = true
	return true
}

func (f *catalogFlights) finishRefresh(key string) {
	f.mu.Lock()
	delete(f.refreshing, key)
	f.mu.Unlock()
}

func saveCatalogCache(s *Server, key string, val any, fetchedAt int64) {
	if s.Store == nil {
		return
	}
	raw, err := json.Marshal(val)
	if err != nil {
		return
	}
	_ = s.Store.SetCatalogCache(key, string(raw), fetchedAt)
}

func loadCatalog[T any](
	s *Server,
	reqCtx context.Context,
	key string,
	fetch func(ctx context.Context) (T, error),
) (T, error) {
	var zero T
	readStore := func() (T, bool, bool) {
		if s.Store == nil {
			return zero, false, false
		}
		raw, fetchedAt, ok, err := s.Store.GetCatalogCache(key)
		if err != nil || !ok || raw == "" {
			return zero, false, false
		}
		var val T
		if json.Unmarshal([]byte(raw), &val) != nil {
			return zero, false, false
		}
		stale := fetchedAt <= 0 || time.Now().Unix()-fetchedAt >= int64(catalogStaleAfter/time.Second)
		return val, stale, true
	}

	if stored, stale, ok := readStore(); ok {
		if stale {
			scheduleCatalogRefresh(s, key, fetch)
		}
		return stored, nil
	}

	if s.catalog != nil {
		lk := s.catalog.lock(key)
		lk.Lock()
		defer lk.Unlock()
		if stored, stale, ok := readStore(); ok {
			if stale {
				scheduleCatalogRefresh(s, key, fetch)
			}
			return stored, nil
		}
	}

	fresh, err := fetch(reqCtx)
	if err != nil {
		return zero, err
	}
	saveCatalogCache(s, key, fresh, time.Now().Unix())
	return fresh, nil
}

func scheduleCatalogRefresh[T any](s *Server, key string, fetch func(ctx context.Context) (T, error)) {
	if s.catalog == nil || s.Store == nil || !s.catalog.tryStartRefresh(key) {
		return
	}
	go func() {
		defer s.catalog.finishRefresh(key)
		if s.Auth != nil && !s.Auth.Authenticated() {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), core.WriteTimeout)
		defer cancel()
		fresh, err := fetch(ctx)
		if err != nil {
			return
		}
		saveCatalogCache(s, key, fresh, time.Now().Unix())
	}()
}

func (s *Server) handleRoomTypes(w http.ResponseWriter, r *http.Request) {
	opts, err := loadCatalog(
		s,
		r.Context(),
		"room_types",
		func(ctx context.Context) ([]core.RoomTypeOption, error) {
			return s.Auth.Client.RoomTypes(ctx)
		},
	)
	if err != nil {
		writeHDUError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, api.RoomTypesResponse{Options: core.NonNil(opts)})
}

func (s *Server) handleFloors(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	roomQuery := strings.TrimSpace(q.Get("roomQuery"))
	if roomQuery == "" {
		writeError(w, http.StatusBadRequest, "缺少房间查询参数")
		return
	}
	roomType := q.Get("roomType")

	payload, err := loadCatalog(
		s,
		r.Context(),
		"floors:"+roomQuery,
		func(ctx context.Context) (api.FloorsResponse, error) {
			s.Auth.Client.ClearRoomMeta(roomQuery)
			br, err := s.Auth.Client.BookingRange(ctx, roomQuery)
			if err != nil {
				return api.FloorsResponse{}, err
			}
			nowLocal := time.Now().In(core.Shanghai)
			targetDate := nowLocal.AddDate(0, 0, core.BookingDayOffsetFor(roomType))
			lookup := time.Date(targetDate.Year(), targetDate.Month(), targetDate.Day(), 10, 0, 0, 0, core.Shanghai).UTC()

			rawFloors, err := s.Auth.Client.Floors(ctx, roomQuery, lookup, 1)
			if err != nil {
				return api.FloorsResponse{}, err
			}
			opts := make([]core.FloorOption, 0, len(rawFloors))
			for _, rf := range rawFloors {
				if opt := hdu.FloorOptionFromRaw(rf); opt != nil {
					opts = append(opts, *opt)
				}
			}
			if len(opts) == 0 {
				return api.FloorsResponse{}, errNoFloorsAvailable
			}
			saveCatalogCache(s, "range:"+roomQuery, br, time.Now().Unix())
			return api.FloorsResponse{Options: opts, Range: br}, nil
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
	br, err := loadCatalog(
		s,
		r.Context(),
		"range:"+roomQuery,
		func(ctx context.Context) (core.BookingRange, error) {
			s.Auth.Client.ClearRoomMeta(roomQuery)
			return s.Auth.Client.BookingRange(ctx, roomQuery)
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
