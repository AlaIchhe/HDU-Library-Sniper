package hdu

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestEncryptPasswordAndApiToken(t *testing.T) {
	// AES-128 key "0123456789abcdef" in base64 = "MDEyMzQ1Njc4OWFiY2RlZg=="
	enc, err := EncryptPassword("MDEyMzQ1Njc4OWFiY2RlZg==", "secret")
	if err != nil || enc == "" {
		t.Fatalf("EncryptPassword failed: %v", err)
	}
	tok := ApiToken("42", "304174", 1700000000, 3600, 1699900000)
	if len(tok) != 44 { // base64(32 hex chars) = 44 bytes
		t.Fatalf("unexpected ApiToken %q (len=%d)", tok, len(tok))
	}
	oid, err := ExtractOpenID("https://hdu.huitu.zhishulib.com/content/index/startUp/openid/abcDEF_123/?foo=bar")
	if err != nil || oid != "abcDEF_123" {
		t.Fatalf("ExtractOpenID = %q, %v", oid, err)
	}
}

func TestClientAuthRefreshBookingsCatalogAndActions(t *testing.T) {
	var refreshed atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/User/Center/baseInfo":
			http.SetCookie(w, &http.Cookie{Name: "sid", Value: "abc", Path: "/"})
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{
					"is_login":  true,
					"uid":       "304174",
					"user_info": map[string]any{"name": "陈同学"},
				},
			})
		case "/Seat/Index/myBookingList":
			if refreshed.Load() == 0 {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"ui_type": "com.Redirect",
					"href":    "/User/Index/hduCASLogin",
				})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"content": map[string]any{
					"defaultItems": []any{
						map[string]any{"id": "b1", "roomName": "自习室", "seatNum": "101", "status": "0", "time": float64(time.Now().Unix())},
					},
				},
			})
		case "/Space/Category/list":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"content": map[string]any{
					"children": []any{
						map[string]any{"name": "空", "defaultItems": []any{}},
						map[string]any{"children": []any{
							map[string]any{"defaultItems": []any{
								map[string]any{
									"id":   "93",
									"name": "自习室",
									"link": map[string]any{"url": "/Seat/Index/searchSeats?space_category%5Bcategory_id%5D=3&space_category%5Bcontent_id%5D=93"},
								},
							}},
						}},
					},
				},
			})
		case "/Seat/Index/searchSeats":
			if r.Header.Get("User-Agent") != MobileUserAgent {
				t.Errorf("expected MobileUserAgent, got %q", r.Header.Get("User-Agent"))
			}
			if r.Method == http.MethodGet {
				_ = json.NewEncoder(w).Encode(map[string]any{
					"data": map[string]any{
						"space_category": map[string]any{"category_id": "3", "content_id": "93"},
						"range":          map[string]any{"minBeginTime": 7, "maxEndTime": 22, "min_duration": 1, "max_duration": 15},
					},
				})
				return
			}
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
											"info": map[string]any{"id": 1559, "title": "杭韵数阁（六楼）"},
											"POIs": []any{
												map[string]any{"id": "43", "title": "102", "state": "0"},
												map[string]any{"id": "42", "title": "101", "state": "0"},
												map[string]any{"id": "42", "title": "101", "state": "0"},
											},
										},
									},
								},
							},
						},
					},
				},
			})
		case "/Seat/Index/cancelBooking":
			_ = json.NewEncoder(w).Encode(map[string]any{"CODE": "ok", "DATA": map[string]any{}})
		case "/Seat/Index/stepOutLatestComeBackTime":
			_ = json.NewEncoder(w).Encode(map[string]any{"CODE": "ok", "DATA": map[string]any{"result": "success", "latest_come_back_time": 1800}})
		case "/Seat/Index/stepOut":
			_ = json.NewEncoder(w).Encode(map[string]any{"CODE": "ok", "DATA": map[string]any{"result": "success"}})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	client := NewClientWithBaseURL(srv.URL)
	client.SetHooks(func(ctx context.Context) bool {
		refreshed.Add(1)
		return true
	}, nil)

	ctx := context.Background()
	if !client.Validate(ctx) || client.UID() != "304174" || client.Name() != "陈同学" {
		t.Fatalf("Validate failed: uid=%q name=%q", client.UID(), client.Name())
	}
	items, err := client.Bookings(ctx)
	if err != nil || len(items) != 1 || refreshed.Load() != 1 {
		t.Fatalf("Bookings after refresh = %v, %v, refreshed=%d", items, err, refreshed.Load())
	}
	rts, err := client.RoomTypes(ctx)
	if err != nil || len(rts) != 1 || rts[0].Name != "自习室" || rts[0].Query != "space_category[category_id]=3&space_category[content_id]=93" {
		t.Fatalf("RoomTypes = %+v, %v", rts, err)
	}
	rg, err := client.BookingRange(ctx, rts[0].Query)
	if err != nil || rg.MaxEndTime != 22 {
		t.Fatalf("BookingRange = %+v, %v", rg, err)
	}
	floors, err := client.Floors(ctx, rts[0].Query, time.Now(), 2)
	if err != nil || len(floors) != 1 {
		t.Fatalf("Floors = %+v, %v", floors, err)
	}
	opt := FloorOptionFromRaw(floors[0])
	if opt == nil || opt.ID != 1559 || opt.Name != "杭韵数阁（六楼）" || opt.SeatCount != 2 || len(opt.SeatTitles) != 2 || opt.SeatTitles[0] != "101" {
		t.Fatalf("FloorOptionFromRaw = %+v", opt)
	}
	if _, err := client.Action(ctx, ActionCancel, "b1"); err != nil {
		t.Fatalf("Cancel tolerates empty DATA.result: %v", err)
	}
	if _, err := client.Action(ctx, ActionLeave, "b1"); err != nil {
		t.Fatalf("Leave failed: %v", err)
	}
}

func TestFloorsSurfacesLibraryErrorMessage(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet {
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{"space_category": map[string]any{"category_id": "591", "content_id": "3"}},
			})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{
			"CODE":    1,
			"MESSAGE": "当前校外网络请求过于频繁，请10分钟后再试",
		})
	}))
	defer srv.Close()

	client := NewClientWithBaseURL(srv.URL)
	_, err := client.Floors(context.Background(), "space_category[category_id]=591&space_category[content_id]=3", time.Now(), 1)
	if err == nil || err.Error() != "当前校外网络请求过于频繁，请10分钟后再试" {
		t.Fatalf("expected HDU rate-limit error message, got: %v", err)
	}
}

func TestRoomMetaSharedCacheAndLiveFloors(t *testing.T) {
	var getSeats, postSeats atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/Seat/Index/searchSeats" {
			http.NotFound(w, r)
			return
		}
		if r.Method == http.MethodGet {
			getSeats.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"data": map[string]any{
					"space_category": map[string]any{"category_id": "591", "content_id": "3"},
					"range":          map[string]any{"minBeginTime": 7, "maxEndTime": 22, "min_duration": 1, "max_duration": 15},
				},
			})
			return
		}
		postSeats.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{
			"allContent": map[string]any{
				"children": []any{
					map[string]any{}, map[string]any{},
					map[string]any{
						"children": map[string]any{
							"children": []any{
								map[string]any{
									"roomName": "自习一楼",
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
	}))
	defer srv.Close()

	client := NewClientWithBaseURL(srv.URL)
	ctx := context.Background()
	q := "space_category[category_id]=591&space_category[content_id]=3"

	if _, err := client.BookingRange(ctx, q); err != nil {
		t.Fatalf("BookingRange 1: %v", err)
	}
	if _, err := client.BookingRange(ctx, q); err != nil {
		t.Fatalf("BookingRange 2: %v", err)
	}
	if _, err := client.Floors(ctx, q, time.Now(), 2); err != nil {
		t.Fatalf("Floors 1: %v", err)
	}
	if _, err := client.Floors(ctx, q, time.Now(), 2); err != nil {
		t.Fatalf("Floors 2: %v", err)
	}

	if got := getSeats.Load(); got != 1 {
		t.Fatalf("expected 1 cached GET searchSeats across BookingRange+Floors, got %d", got)
	}
	if got := postSeats.Load(); got != 2 {
		t.Fatalf("expected 2 live POST searchSeats for Floors (used by booking executor), got %d", got)
	}
}
