package server

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"testing/fstest"
	"time"

	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
	"hdu-library-sniper/internal/events"
	"hdu-library-sniper/internal/scheduler"
	"hdu-library-sniper/internal/store"
)

func testRouter(t *testing.T) (*Server, http.Handler) {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	bus := events.NewBus()
	authSvc := auth.NewService(st, nil)
	exec := booking.NewExecutor(st, bus)
	sched := scheduler.New(st, authSvc, exec, bus)
	webFS := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}
	srv := NewWithOptions(st, authSvc, exec, sched, bus, webFS, Options{})
	return srv, srv.Handler()
}

func TestRouterAuthOriginGuardAndSecurityBoundaries(t *testing.T) {
	_, h := testRouter(t)

	// Unauthenticated protected route -> 401
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/plans", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Health is public
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d", rec.Code)
	}

	// Cross-origin domain & arbitrary external IP rejected
	for _, origin := range []string{"https://evil.example", "http://198.51.100.20:8080"} {
		rec = httptest.NewRecorder()
		xReq := httptest.NewRequest(http.MethodGet, "/api/session", nil)
		xReq.Header.Set("Origin", origin)
		h.ServeHTTP(rec, xReq)
		if rec.Code != http.StatusForbidden {
			t.Fatalf("expected 403 for untrusted origin %q, got %d", origin, rec.Code)
		}
	}

	// Dev CORS trusted origin allowed
	rec = httptest.NewRecorder()
	devReq := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	devReq.Header.Set("Origin", "http://localhost:5173")
	h.ServeHTTP(rec, devReq)
	if rec.Code != http.StatusOK || rec.Header().Get("Access-Control-Allow-Origin") != "http://localhost:5173" {
		t.Fatalf("dev origin failed: code=%d cors=%q", rec.Code, rec.Header().Get("Access-Control-Allow-Origin"))
	}

	// SPA fallback
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/plans", nil))
	if rec.Code != http.StatusOK || rec.Body.String() != "<html>spa</html>" {
		t.Fatalf("SPA fallback = %d %q", rec.Code, rec.Body.String())
	}
}

func TestPanelPasswordAndDesktopTokenAuth(t *testing.T) {
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = st.Close() }()
	bus := events.NewBus()
	authSvc := auth.NewService(st, nil)
	exec := booking.NewExecutor(st, bus)
	sched := scheduler.New(st, authSvc, exec, bus)

	// 1. Panel password mode
	panelSrv := NewWithOptions(st, authSvc, exec, sched, bus, nil, Options{PanelPassword: "top-secret"})
	ph := panelSrv.Handler()

	rec := httptest.NewRecorder()
	ph.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/session", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without panel auth, got %d", rec.Code)
	}

	loginRec := httptest.NewRecorder()
	ph.ServeHTTP(loginRec, httptest.NewRequest(http.MethodPost, "/api/panel/auth/login", strings.NewReader(`{"password":"top-secret"}`)))
	if loginRec.Code != http.StatusOK || len(loginRec.Result().Cookies()) == 0 {
		t.Fatalf("panel login failed: code=%d cookies=%v", loginRec.Code, loginRec.Result().Cookies())
	}

	authedReq := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	for _, c := range loginRec.Result().Cookies() {
		authedReq.AddCookie(c)
	}
	authedRec := httptest.NewRecorder()
	ph.ServeHTTP(authedRec, authedReq)
	if authedRec.Code != http.StatusOK {
		t.Fatalf("expected 200 with panel cookie, got %d", authedRec.Code)
	}

	// 2. Desktop per-launch token mode
	deskSrv := NewWithOptions(st, authSvc, exec, sched, bus, nil, Options{DesktopToken: "desk-tok-123"})
	dh := deskSrv.Handler()

	rec = httptest.NewRecorder()
	dh.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/session", nil))
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401 without desktop token, got %d", rec.Code)
	}

	tokReq := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	tokReq.Header.Set("Authorization", "Bearer desk-tok-123")
	rec = httptest.NewRecorder()
	dh.ServeHTTP(rec, tokReq)
	if rec.Code != http.StatusOK {
		t.Fatalf("expected 200 with desktop bearer token, got %d", rec.Code)
	}
}

func TestUnifiedPlanLifecycle(t *testing.T) {
	srv, _ := testRouter(t)
	hduMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content/index/startUp/openid/abcdef_123/":
			w.WriteHeader(http.StatusOK)
		case "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
			})
		}
	}))
	defer hduMock.Close()

	srv.Auth = auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{Library: hduMock.URL})
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking, srv.Events)
	h := srv.Handler()

	do := func(method, path string, payload any) *httptest.ResponseRecorder {
		var body []byte
		if payload != nil {
			body, _ = json.Marshal(payload)
		}
		rec := httptest.NewRecorder()
		req := httptest.NewRequest(method, path, bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		h.ServeHTTP(rec, req)
		return rec
	}

	if res := do(http.MethodPost, "/api/session/openid", map[string]string{"openid": "abcdef_123"}); res.Code != 200 {
		t.Fatalf("openid login = %d %s", res.Code, res.Body.String())
	}

	// Overlapping slots rejected with 400
	overlapRes := do(http.MethodPost, "/api/plans", map[string]any{
		"name": "重叠方案",
		"slots": []map[string]any{
			{"roomType": "自习室", "roomQuery": "q=1", "floorId": 3, "seatNum": "101", "startHour": 8, "durationHours": 3},
			{"roomType": "自习室", "roomQuery": "q=1", "floorId": 3, "seatNum": "102", "startHour": 10, "durationHours": 2},
		},
		"weekdays": []int{1, 2},
	})
	if overlapRes.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for overlapping slots, got %d %s", overlapRes.Code, overlapRes.Body.String())
	}

	// Valid multi-slot plan created
	createRes := do(http.MethodPost, "/api/plans", map[string]any{
		"name": "早中联排",
		"slots": []map[string]any{
			{"roomType": "自习室", "roomQuery": "q=1", "floorId": 3, "seatNum": "101", "startHour": 8, "durationHours": 2},
			{"roomType": "自习室", "roomQuery": "q=1", "floorId": 3, "seatNum": "102", "startHour": 10, "durationHours": 2},
		},
		"weekdays": []int{1, 2},
	})
	if createRes.Code != http.StatusCreated {
		t.Fatalf("createPlan = %d %s", createRes.Code, createRes.Body.String())
	}
	var out struct {
		Plan struct {
			ID string `json:"id"`
		} `json:"plan"`
	}
	_ = json.Unmarshal(createRes.Body.Bytes(), &out)
	if res := do(http.MethodDelete, "/api/plans/"+out.Plan.ID, nil); res.Code != http.StatusOK {
		t.Fatalf("deletePlan = %d %s", res.Code, res.Body.String())
	}
}

func TestCatalogPersistenceAndLongHorizonSWR(t *testing.T) {
	srv, _ := testRouter(t)
	var roomListHits, searchGetHits, searchPostHits atomic.Int32
	var seatTitle atomic.Value
	seatTitle.Store("101")

	hduMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content/index/startUp/openid/abcdef_123/":
			w.WriteHeader(http.StatusOK)
		case "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
			})
		case "/Space/Category/list":
			roomListHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"content": map[string]any{
					"defaultItems": []any{
						map[string]any{
							"name": "自习室",
							"link": map[string]any{"url": "/Seat/Index/searchSeats?space_category%5Bcategory_id%5D=591&space_category%5Bcontent_id%5D=3"},
						},
					},
				},
			})
		case "/Seat/Index/searchSeats":
			if r.Method == http.MethodGet {
				searchGetHits.Add(1)
				_ = json.NewEncoder(w).Encode(map[string]any{
					"data": map[string]any{
						"space_category": map[string]any{"category_id": "591", "content_id": "3"},
						"range":          map[string]any{"minBeginTime": 7, "maxEndTime": 22, "min_duration": 1, "max_duration": 15},
					},
				})
				return
			}
			searchPostHits.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"allContent": map[string]any{
					"children": []any{
						map[string]any{}, map[string]any{},
						map[string]any{
							"children": map[string]any{
								"children": []any{
									map[string]any{
										"roomName": "杭韵数阁（六楼）",
										"seatMap": map[string]any{
											"info": map[string]any{"id": 1559},
											"POIs": []any{map[string]any{"id": "1", "title": seatTitle.Load().(string), "state": "0"}},
										},
									},
								},
							},
						},
					},
				},
			})
		}
	}))
	defer hduMock.Close()

	makeHandler := func() http.Handler {
		bus := events.NewBus()
		authSvc := auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{Library: hduMock.URL})
		exec := booking.NewExecutor(srv.Store, bus)
		sched := scheduler.New(srv.Store, authSvc, exec, bus)
		s := NewWithOptions(srv.Store, authSvc, exec, sched, bus, nil, Options{})
		_ = authSvc.LoginOpenID(t.Context(), "abcdef_123")
		return s.Handler()
	}

	h := makeHandler()
	req := func(handler http.Handler, method, target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
		return rec
	}
	waitCacheContains := func(key, substr string) {
		t.Helper()
		deadline := time.Now().Add(2 * time.Second)
		for time.Now().Before(deadline) {
			if v, _, ok, err := srv.Store.GetCatalogCache(key); err == nil && ok && strings.Contains(v, substr) {
				return
			}
			time.Sleep(5 * time.Millisecond)
		}
		v, _, _, _ := srv.Store.GetCatalogCache(key)
		t.Fatalf("timed out waiting for catalog_cache %s to contain %q, got %s", key, substr, v)
	}

	roomQuery := "space_category[category_id]=591&space_category[content_id]=3"
	floorsPath := "/api/catalog/floors?roomQuery=" + url.QueryEscape(roomQuery) + "&roomType=" + url.QueryEscape("自习室")
	dur8Path := "/api/catalog/durations?roomQuery=" + url.QueryEscape(roomQuery) + "&startHour=8"
	dur10Path := "/api/catalog/durations?roomQuery=" + url.QueryEscape(roomQuery) + "&startHour=10"

	for range 3 {
		if r := req(h, http.MethodGet, "/api/catalog/room-types"); r.Code != 200 {
			t.Fatalf("room-types = %d %s", r.Code, r.Body.String())
		}
		if r := req(h, http.MethodGet, floorsPath); r.Code != 200 {
			t.Fatalf("floors = %d %s", r.Code, r.Body.String())
		}
	}
	if r := req(h, http.MethodGet, dur8Path); r.Code != 200 {
		t.Fatalf("durations 8 = %d %s", r.Code, r.Body.String())
	}
	if r := req(h, http.MethodGet, dur10Path); r.Code != 200 {
		t.Fatalf("durations 10 = %d %s", r.Code, r.Body.String())
	}
	if roomListHits.Load() != 1 || searchGetHits.Load() != 1 || searchPostHits.Load() != 1 {
		t.Fatalf("expected 1/1/1 upstream hits, got %d/%d/%d",
			roomListHits.Load(), searchGetHits.Load(), searchPostHits.Load())
	}

	// Simulate fresh server restart on the same SQLite store: zero new upstream requests.
	h2 := makeHandler()
	if r := req(h2, http.MethodGet, "/api/catalog/room-types"); r.Code != 200 {
		t.Fatalf("restarted room-types = %d", r.Code)
	}
	if r := req(h2, http.MethodGet, floorsPath); r.Code != 200 {
		t.Fatalf("restarted floors = %d", r.Code)
	}
	if r := req(h2, http.MethodGet, dur8Path); r.Code != 200 {
		t.Fatalf("restarted durations = %d", r.Code)
	}
	if roomListHits.Load() != 1 || searchGetHits.Load() != 1 || searchPostHits.Load() != 1 {
		t.Fatalf("expected 0 extra hits on restarted server via SQLite persistence, got %d/%d/%d",
			roomListHits.Load(), searchGetHits.Load(), searchPostHits.Load())
	}

	// Logout preserves persisted institutional catalog data in SQLite.
	if r := req(h2, http.MethodPost, "/api/session/logout"); r.Code != 200 {
		t.Fatalf("logout = %d", r.Code)
	}
	if v, _, ok, err := srv.Store.GetCatalogCache("room_types"); err != nil || !ok || v == "" {
		t.Fatalf("expected catalog_cache room_types preserved on logout, got %q ok=%v err=%v", v, ok, err)
	}

	// Entries older than catalogStaleAfter (30d) serve old data immediately while triggering one background SWR refresh.
	h3 := makeHandler()
	seatTitle.Store("202")
	staleTime := time.Now().Add(-31 * 24 * time.Hour).Unix()
	oldRaw, _, _, _ := srv.Store.GetCatalogCache("floors:" + roomQuery)
	_ = srv.Store.SetCatalogCache("floors:"+roomQuery, oldRaw, staleTime)

	beforePost := searchPostHits.Load()
	for range 3 {
		resp := req(h3, http.MethodGet, floorsPath)
		if resp.Code != 200 || !strings.Contains(resp.Body.String(), `"101"`) {
			t.Fatalf("expected immediate stale-while-revalidate response with old seat 101, got %d %s", resp.Code, resp.Body.String())
		}
	}
	waitCacheContains("floors:"+roomQuery, `"202"`)
	if searchPostHits.Load() != beforePost+1 {
		t.Fatalf("expected exactly 1 coalesced background SWR POST, got delta=%d", searchPostHits.Load()-beforePost)
	}
	freshResp := req(h3, http.MethodGet, floorsPath)
	if !strings.Contains(freshResp.Body.String(), `"202"`) {
		t.Fatalf("expected subsequent request to return updated SQLite seat 202, got %s", freshResp.Body.String())
	}
}
