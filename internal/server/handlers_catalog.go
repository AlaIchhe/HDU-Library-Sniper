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
	"hdu-library-sniper/internal/store"
)

const (
	catalogRoomTypesTTL = 24 * time.Hour
	catalogDetailsTTL   = 12 * time.Hour
)

var errNoFloorsAvailable = errors.New("该房间类型当前没有可预约楼层（可能尚未开放预约，请尝试其他房间类型）")

type floorsPayload struct {
	Options []core.FloorOption `json:"options"`
	Range   core.BookingRange  `json:"range"`
}

type catalogMemoryEntry struct {
	expiresAt int64
	value     any
}

type catalogPersistedEnvelope struct {
	ExpiresAt int64           `json:"expiresAt"`
	Data      json.RawMessage `json:"data"`
}

type catalogCache struct {
	mu       sync.Mutex
	entries  map[string]catalogMemoryEntry
	inflight map[string]*sync.Mutex
}

func newCatalogCache() *catalogCache {
	return &catalogCache{
		entries:  make(map[string]catalogMemoryEntry),
		inflight: make(map[string]*sync.Mutex),
	}
}

func (c *catalogCache) clear() {
	c.mu.Lock()
	c.entries = make(map[string]catalogMemoryEntry)
	c.mu.Unlock()
}

func (c *catalogCache) flightLock(key string) *sync.Mutex {
	c.mu.Lock()
	defer c.mu.Unlock()
	m, ok := c.inflight[key]
	if !ok {
		m = &sync.Mutex{}
		c.inflight[key] = m
	}
	return m
}

func (c *catalogCache) put(st *store.Store, key string, val any, ttl time.Duration) {
	exp := time.Now().Add(ttl).Unix()
	c.mu.Lock()
	c.entries[key] = catalogMemoryEntry{expiresAt: exp, value: val}
	c.mu.Unlock()

	if st == nil {
		return
	}
	if dataRaw, err := json.Marshal(val); err == nil {
		if envRaw, err := json.Marshal(catalogPersistedEnvelope{ExpiresAt: exp, Data: dataRaw}); err == nil {
			_ = st.SetMeta(key, string(envRaw))
		}
	}
}

func fetchCachedCatalog[T any](
	s *Server,
	key string,
	ttl time.Duration,
	forceRefresh bool,
	fetch func() (T, error),
) (T, error) {
	var zero T
	if s.catalog == nil {
		return fetch()
	}
	now := time.Now().Unix()

	if !forceRefresh {
		s.catalog.mu.Lock()
		entry, ok := s.catalog.entries[key]
		s.catalog.mu.Unlock()
		if ok && now < entry.expiresAt {
			if typed, match := entry.value.(T); match {
				return typed, nil
			}
		}
	}

	// Coalesce concurrent cold-cache fetches per key to avoid bursting Huitu upstream.
	lk := s.catalog.flightLock(key)
	lk.Lock()
	defer lk.Unlock()

	now = time.Now().Unix()
	if !forceRefresh {
		s.catalog.mu.Lock()
		entry, ok := s.catalog.entries[key]
		s.catalog.mu.Unlock()
		if ok && now < entry.expiresAt {
			if typed, match := entry.value.(T); match {
				return typed, nil
			}
		}

		if s.Store != nil {
			if raw, err := s.Store.GetMeta(key); err == nil && raw != "" {
				var env catalogPersistedEnvelope
				if json.Unmarshal([]byte(raw), &env) == nil && now < env.ExpiresAt {
					var decoded T
					if json.Unmarshal(env.Data, &decoded) == nil {
						s.catalog.mu.Lock()
						s.catalog.entries[key] = catalogMemoryEntry{expiresAt: env.ExpiresAt, value: decoded}
						s.catalog.mu.Unlock()
						return decoded, nil
					}
				}
			}
		}
	}

	fresh, err := fetch()
	if err != nil {
		return zero, err
	}
	s.catalog.put(s.Store, key, fresh, ttl)
	return fresh, nil
}

func wantsRefresh(r *http.Request) bool {
	v := strings.TrimSpace(r.URL.Query().Get("refresh"))
	return v == "1" || strings.EqualFold(v, "true")
}

func (s *Server) handleRoomTypes(w http.ResponseWriter, r *http.Request) {
	opts, err := fetchCachedCatalog(
		s,
		"catalog:room_types",
		catalogRoomTypesTTL,
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
	offset := core.BookingDayOffsetFor(roomType)
	key := "catalog:floors:" + roomQuery + ":" + strconv.Itoa(offset)

	payload, err := fetchCachedCatalog(
		s,
		key,
		catalogDetailsTTL,
		wantsRefresh(r),
		func() (floorsPayload, error) {
			br, err := s.Auth.Client.BookingRange(r.Context(), roomQuery)
			if err != nil {
				return floorsPayload{}, err
			}
			nowLocal := time.Now().In(core.Shanghai)
			targetDate := nowLocal.AddDate(0, 0, offset)
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
			if s.catalog != nil {
				s.catalog.put(s.Store, "catalog:range:"+roomQuery, br, catalogDetailsTTL)
			}
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
	br, err := fetchCachedCatalog(
		s,
		"catalog:range:"+roomQuery,
		catalogDetailsTTL,
		wantsRefresh(r),
		func() (core.BookingRange, error) {
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
