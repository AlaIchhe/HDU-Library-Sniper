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

	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/booking"
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
	authSvc := auth.NewService(st, nil)
	exec := booking.NewExecutor(st)
	sched := scheduler.New(st, authSvc, exec)
	webFS := fstest.MapFS{"index.html": &fstest.MapFile{Data: []byte("<html>spa</html>")}}
	srv := New(st, authSvc, exec, sched, webFS)
	return srv, srv.Handler()
}

func TestRouterAuthPlansGroupsAndOriginGuard(t *testing.T) {
	srv, h := testRouter(t)

	// Unauthenticated protected route -> 401
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodGet, "/api/plans", nil)
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("expected 401, got %d", rec.Code)
	}

	// Authenticate directly via test helper endpoint simulation (Restore / internal test)
	// We verify login lockout / public routes first.
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "/api/health", nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("health = %d", rec.Code)
	}

	// Cross-origin rejection
	rec = httptest.NewRecorder()
	xReq := httptest.NewRequest(http.MethodGet, "/api/session", nil)
	xReq.Header.Set("Origin", "https://evil.example")
	h.ServeHTTP(rec, xReq)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("expected 403 for cross-origin, got %d", rec.Code)
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
	_ = srv
}

func TestPlanAndGroupLifecycle(t *testing.T) {
	srv, h := testRouter(t)
	// Bypass HDU external network call by testing group validation on stored plans directly + HTTP handlers via Restore/login mock
	// Actually let's stand up a mock HDU server for Auth so protected routes run end-to-end!
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
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)
	h = srv.Handler()

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

	createPlan := func(start int64) string {
		res := do(http.MethodPost, "/api/plans", map[string]any{
			"roomType": "自习室", "roomQuery": "q=1", "floorId": 3, "floorName": "三楼",
			"seatNum": "101", "startHour": start, "durationHours": 2, "weekdays": []int{1, 2},
		})
		if res.Code != http.StatusCreated {
			t.Fatalf("createPlan = %d %s", res.Code, res.Body.String())
		}
		var out struct {
			Plan struct {
				ID string `json:"id"`
			} `json:"plan"`
		}
		_ = json.Unmarshal(res.Body.Bytes(), &out)
		return out.Plan.ID
	}

	id1 := createPlan(8)
	id2 := createPlan(10)
	// Overlap test: 9..11 overlaps 8..10
	id3 := createPlan(9)
	if res := do(http.MethodPost, "/api/groups", map[string]any{"name": "重叠", "memberPlanIds": []string{id1, id3}}); res.Code != 400 {
		t.Fatalf("expected 400 for overlapping group, got %d", res.Code)
	}

	// Valid group: 8..10 + 10..12
	gRes := do(http.MethodPost, "/api/groups", map[string]any{"name": "早中", "memberPlanIds": []string{id1, id2}})
	if gRes.Code != http.StatusCreated {
		t.Fatalf("createGroup = %d %s", gRes.Code, gRes.Body.String())
	}
	// Referenced single plan cannot be deleted
	if res := do(http.MethodDelete, "/api/plans/"+id1, nil); res.Code != http.StatusConflict {
		t.Fatalf("expected 409 deleting plan referenced by group, got %d", res.Code)
	}
}

func TestCatalogPersistenceAndLazyRefresh(t *testing.T) {
	srv, _ := testRouter(t)
	var roomListHits, searchGetHits, searchPostHits atomic.Int32

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
											"POIs": []any{map[string]any{"id": "1", "title": "101", "state": "0"}},
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
		authSvc := auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{Library: hduMock.URL})
		exec := booking.NewExecutor(srv.Store)
		sched := scheduler.New(srv.Store, authSvc, exec)
		s := New(srv.Store, authSvc, exec, sched, nil)
		_ = authSvc.LoginOpenID(t.Context(), "abcdef_123")
		return s.Handler()
	}

	h := makeHandler()
	req := func(handler http.Handler, method, target string) *httptest.ResponseRecorder {
		rec := httptest.NewRecorder()
		handler.ServeHTTP(rec, httptest.NewRequest(method, target, nil))
		return rec
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

	// Legacy expired {expiresAt, data} rows still resolve cleanly without re-polling upstream.
	_ = srv.Store.SetMeta("catalog:range:"+roomQuery, `{"expiresAt":1,"data":{"minBeginTime":7,"maxEndTime":22,"minDuration":1,"maxDuration":15}}`)
	r := req(h2, http.MethodGet, dur8Path)
	if r.Code != 200 {
		t.Fatalf("legacy envelope durations = %d %s", r.Code, r.Body.String())
	}
	if !strings.Contains(r.Body.String(), `"options":[1,2,`) || searchGetHits.Load() != 1 {
		t.Fatalf("expected legacy range unwrapped without upstream hit, body=%s getHits=%d", r.Body.String(), searchGetHits.Load())
	}

	// Logout preserves persisted institutional catalog data in SQLite.
	if r := req(h2, http.MethodPost, "/api/session/logout"); r.Code != 200 {
		t.Fatalf("logout = %d", r.Code)
	}
	if v, err := srv.Store.GetMeta("catalog:room_types"); err != nil || v == "" {
		t.Fatalf("expected catalog:room_types preserved on logout, got %q, err=%v", v, err)
	}

	// Explicit lazy refresh bypasses persistence and refreshes both roomMeta and floors.
	h3 := makeHandler()
	if r := req(h3, http.MethodGet, floorsPath+"&refresh=1"); r.Code != 200 {
		t.Fatalf("refresh floors = %d %s", r.Code, r.Body.String())
	}
	if searchGetHits.Load() != 2 || searchPostHits.Load() != 2 {
		t.Fatalf("expected GET/POST searchSeats hits=2/2 after ?refresh=1, got %d/%d",
			searchGetHits.Load(), searchPostHits.Load())
	}
}
