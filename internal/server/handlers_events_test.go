package server

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/auth"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/events"
	"hdu-library-sniper/internal/scheduler"
)

type sseFrame struct {
	event string
	data  string
}

func readNextSSEFrame(t *testing.T, r *bufio.Reader, timeout time.Duration) (sseFrame, error) {
	t.Helper()
	type result struct {
		frame sseFrame
		err   error
	}
	ch := make(chan result, 1)
	go func() {
		var cur sseFrame
		for {
			line, err := r.ReadString('\n')
			if err != nil {
				ch <- result{err: err}
				return
			}
			line = strings.TrimRight(line, "\r\n")
			if line == "" {
				if cur.event != "" || cur.data != "" {
					ch <- result{frame: cur}
					return
				}
				continue
			}
			if strings.HasPrefix(line, ":") {
				continue
			}
			if v, ok := strings.CutPrefix(line, "event:"); ok {
				cur.event = strings.TrimSpace(v)
			} else if v, ok := strings.CutPrefix(line, "data:"); ok {
				cur.data = strings.TrimSpace(v)
			}
		}
	}()

	select {
	case res := <-ch:
		return res.frame, res.err
	case <-time.After(timeout):
		t.Fatalf("timed out waiting for SSE frame after %v", timeout)
		return sseFrame{}, nil
	}
}

func TestHandleEventsAuthSnapshotsInvalidationsAndClose(t *testing.T) {
	srv, _ := testRouter(t)
	hduMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content/index/startUp/openid/abcdef_123/":
			w.WriteHeader(http.StatusOK)
		case "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
			})
		case "/Seat/Index/checkIn":
			_ = json.NewEncoder(w).Encode(map[string]any{"CODE": "ok", "MESSAGE": "ok"})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"CODE": "ok", "MESSAGE": "ok"})
		}
	}))
	defer hduMock.Close()

	srv.Auth = auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{Library: hduMock.URL})
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Unauthenticated /api/events must return 401.
	resp, err := http.Get(ts.URL + api.PathEvents)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("unauthenticated /api/events = %d, want 401", resp.StatusCode)
	}

	// Authenticate first.
	loginBody, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	loginResp, err := http.Post(ts.URL+api.PathSessionOpenID, "application/json", bytes.NewReader(loginBody))
	if err != nil {
		t.Fatal(err)
	}
	_ = loginResp.Body.Close()
	if loginResp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", loginResp.StatusCode)
	}

	sseResp, err := http.Get(ts.URL + api.PathEvents)
	if err != nil {
		t.Fatal(err)
	}
	defer sseResp.Body.Close()
	if sseResp.StatusCode != http.StatusOK {
		t.Fatalf("authenticated /api/events = %d", sseResp.StatusCode)
	}
	if ct := sseResp.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/event-stream") {
		t.Fatalf("content-type = %q", ct)
	}

	reader := bufio.NewReader(sseResp.Body)
	f1, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil || f1.event != events.TopicAppEvent {
		t.Fatalf("first SSE frame = %+v err=%v", f1, err)
	}
	var ev1 api.AppEvent
	if err := json.Unmarshal([]byte(f1.data), &ev1); err != nil || ev1.Kind != api.AppEventSession || ev1.Session == nil || !ev1.Session.Authenticated {
		t.Fatalf("unexpected initial session event: %s (%v)", f1.data, err)
	}

	f2, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil || f2.event != events.TopicAppEvent {
		t.Fatalf("second SSE frame = %+v err=%v", f2, err)
	}
	var ev2 api.AppEvent
	if err := json.Unmarshal([]byte(f2.data), &ev2); err != nil || ev2.Kind != api.AppEventRuntime || ev2.Runtime == nil {
		t.Fatalf("unexpected initial runtime event: %s (%v)", f2.data, err)
	}

	// Creating a plan publishes an invalidate event for plans and nextTarget.
	planPayload, _ := json.Marshal(map[string]any{
		"roomType": "自习室", "roomQuery": "q=1", "floorId": 3, "floorName": "三楼",
		"seatNum": "101", "startHour": 8, "durationHours": 2, "weekdays": []int{1, 2},
	})
	planResp, err := http.Post(ts.URL+api.PathPlans, "application/json", bytes.NewReader(planPayload))
	if err != nil {
		t.Fatal(err)
	}
	_ = planResp.Body.Close()
	if planResp.StatusCode != http.StatusCreated {
		t.Fatalf("create plan = %d", planResp.StatusCode)
	}

	f3, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatalf("expected invalidate event: %v", err)
	}
	var ev3 api.AppEvent
	if err := json.Unmarshal([]byte(f3.data), &ev3); err != nil || ev3.Kind != api.AppEventInvalidate ||
		!slices.Contains(ev3.Invalidate, api.InvalidatePlans) || !slices.Contains(ev3.Invalidate, api.InvalidateNextTarget) {
		t.Fatalf("unexpected plan invalidate event: %s (%v)", f3.data, err)
	}

	// Booking action publishes an invalidate event for bookings.
	actResp, err := http.Post(ts.URL+"/api/bookings/b1/checkin", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = actResp.Body.Close()
	if actResp.StatusCode != http.StatusOK {
		t.Fatalf("booking action = %d", actResp.StatusCode)
	}

	f4, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatalf("expected booking invalidate event: %v", err)
	}
	var ev4 api.AppEvent
	if err := json.Unmarshal([]byte(f4.data), &ev4); err != nil || ev4.Kind != api.AppEventInvalidate ||
		!slices.Contains(ev4.Invalidate, api.InvalidateBookings) {
		t.Fatalf("unexpected booking invalidate event: %s (%v)", f4.data, err)
	}

	// Closing the bus must terminate active SSE handlers immediately.
	srv.Events.Close()
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != io.EOF {
		t.Fatalf("expected EOF after bus close, got %v", err)
	}
}

func TestHandleEventsClosesAfterLogoutSessionEvent(t *testing.T) {
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
	srv.Auth.SetOnSessionChange(func(st core.SessionStatus) {
		stCopy := st
		srv.Events.Publish(events.TopicAppEvent, api.AppEvent{Kind: api.AppEventSession, Session: &stCopy})
	})
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	loginBody, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	loginResp, err := http.Post(ts.URL+api.PathSessionOpenID, "application/json", bytes.NewReader(loginBody))
	if err != nil {
		t.Fatal(err)
	}
	_ = loginResp.Body.Close()

	sseResp, err := http.Get(ts.URL + api.PathEvents)
	if err != nil {
		t.Fatal(err)
	}
	defer sseResp.Body.Close()
	reader := bufio.NewReader(sseResp.Body)
	// Drain initial session + runtime frames.
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}

	logoutResp, err := http.Post(ts.URL+api.PathSessionLogout, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = logoutResp.Body.Close()

	fLogout, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatalf("expected logout session frame: %v", err)
	}
	var ev api.AppEvent
	if err := json.Unmarshal([]byte(fLogout.data), &ev); err != nil || ev.Kind != api.AppEventSession || ev.Session == nil || ev.Session.Authenticated {
		t.Fatalf("unexpected logout frame: %s (%v)", fLogout.data, err)
	}
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != io.EOF {
		t.Fatalf("expected EOF after unauthenticated session event, got %v", err)
	}
}

func TestHandleSessionQREventsSuccessAndCancel(t *testing.T) {
	srv, _ := testRouter(t)
	var scanPolls atomic.Int32
	ssoMux := http.NewServeMux()
	ssoMux.HandleFunc("/sso/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			http.Redirect(w, r, "/User/Center/baseInfo", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	ssoMux.HandleFunc("/sso/public/utils/loginNew.js", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`"Csrf-Key":"k1","Csrf-Value":"v1"`))
	})
	ssoMux.HandleFunc("/sso/api/protected/qrlogin/loginid", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": "qr-sse-1"})
	})
	ssoMux.HandleFunc("/sso/api/public/qrlogin/qrgen/qr-sse-1/dingDingQr", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("png"))
	})
	ssoMux.HandleFunc("/sso/api/protected/qrlogin/scan/qr-sse-1", func(w http.ResponseWriter, r *http.Request) {
		if scanPolls.Add(1) >= 2 {
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": "tok-ok"})
			return
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": ""})
	})
	ssoMux.HandleFunc("/User/Center/baseInfo", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
		})
	})
	mockUpstream := httptest.NewServer(ssoMux)
	defer mockUpstream.Close()

	srv.Auth = auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{
		Library:       mockUpstream.URL,
		SSO:           mockUpstream.URL + "/sso",
		SSOLoginPage:  mockUpstream.URL + "/sso/login?service=test",
		SSOCsrfScript: mockUpstream.URL + "/sso/public/utils/loginNew.js",
	})
	srv.Auth.SetOnQrChange(func(uuid string, st core.QrLoginStatus) {
		srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{
			UUID:    uuid,
			Status:  api.QrLoginPhase(st.Status),
			Message: st.Message,
			Session: st.Session,
		})
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	// Missing QR session returns single error event and closes immediately.
	missResp, err := http.Get(ts.URL + "/api/session/qr/nonexistent/events")
	if err != nil {
		t.Fatal(err)
	}
	missReader := bufio.NewReader(missResp.Body)
	missFrame, err := readNextSSEFrame(t, missReader, 2*time.Second)
	_ = missResp.Body.Close()
	if err != nil || missFrame.event != events.TopicQrStatus {
		t.Fatalf("missing QR frame = %+v err=%v", missFrame, err)
	}
	var missEv api.QrStatusEvent
	if err := json.Unmarshal([]byte(missFrame.data), &missEv); err != nil || missEv.Status != api.QrLoginError {
		t.Fatalf("expected error status for missing uuid, got %s (%v)", missFrame.data, err)
	}

	// Start valid QR session and stream until success.
	startResp, err := http.Post(ts.URL+api.PathSessionQR, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var start core.QrLoginStart
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = startResp.Body.Close()

	qrResp, err := http.Get(ts.URL + "/api/session/qr/" + start.UUID + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer qrResp.Body.Close()
	qrReader := bufio.NewReader(qrResp.Body)

	var seenSuccess bool
	for range 5 {
		frame, err := readNextSSEFrame(t, qrReader, 5*time.Second)
		if err == io.EOF {
			break
		}
		if err != nil {
			t.Fatalf("qr SSE error: %v", err)
		}
		var ev api.QrStatusEvent
		if err := json.Unmarshal([]byte(frame.data), &ev); err != nil {
			t.Fatal(err)
		}
		if ev.Status == api.QrLoginSuccess && ev.Session != nil && ev.Session.Authenticated {
			seenSuccess = true
			break
		}
	}
	if !seenSuccess {
		t.Fatal("did not receive QR success SSE event")
	}
	if _, err := readNextSSEFrame(t, qrReader, 2*time.Second); err != io.EOF {
		t.Fatalf("expected QR SSE stream EOF after success, got %v", err)
	}
}

func TestHandleSessionQREventsCancelClosesStream(t *testing.T) {
	srv, _ := testRouter(t)
	mockUpstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sso/login":
			_, _ = w.Write([]byte("ok"))
		case "/sso/public/utils/loginNew.js":
			_, _ = w.Write([]byte(`"Csrf-Key":"k1","Csrf-Value":"v1"`))
		case "/sso/api/protected/qrlogin/loginid":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": "qr-cancel-1"})
		case "/sso/api/public/qrlogin/qrgen/qr-cancel-1/dingDingQr":
			_, _ = w.Write([]byte("png"))
		case "/sso/api/protected/qrlogin/scan/qr-cancel-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": ""})
		default:
			http.NotFound(w, r)
		}
	}))
	defer mockUpstream.Close()

	srv.Auth = auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{
		Library:       mockUpstream.URL,
		SSO:           mockUpstream.URL + "/sso",
		SSOLoginPage:  mockUpstream.URL + "/sso/login?service=test",
		SSOCsrfScript: mockUpstream.URL + "/sso/public/utils/loginNew.js",
	})
	srv.Auth.SetOnQrChange(func(uuid string, st core.QrLoginStatus) {
		srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{
			UUID:    uuid,
			Status:  api.QrLoginPhase(st.Status),
			Message: st.Message,
			Session: st.Session,
		})
	})
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	startResp, err := http.Post(ts.URL+api.PathSessionQR, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	var start core.QrLoginStart
	if err := json.NewDecoder(startResp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	_ = startResp.Body.Close()

	qrResp, err := http.Get(ts.URL + "/api/session/qr/" + start.UUID + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer qrResp.Body.Close()
	reader := bufio.NewReader(qrResp.Body)

	first, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var firstEv api.QrStatusEvent
	if err := json.Unmarshal([]byte(first.data), &firstEv); err != nil || firstEv.Status != api.QrLoginPending {
		t.Fatalf("expected initial pending frame, got %s (%v)", first.data, err)
	}

	cancelResp, err := http.Post(ts.URL+"/api/session/qr/"+start.UUID+"/cancel", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = cancelResp.Body.Close()

	second, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var secondEv api.QrStatusEvent
	if err := json.Unmarshal([]byte(second.data), &secondEv); err != nil || secondEv.Status != api.QrLoginError {
		t.Fatalf("expected error frame after cancel, got %s (%v)", second.data, err)
	}
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != io.EOF {
		t.Fatalf("expected EOF after cancel, got %v", err)
	}
}

// The bus filters by topic, so a qr_status event must never surface on /api/events
// even while a QR login is in flight on the same backend instance.
func TestHandleEventsIgnoresQrTopic(t *testing.T) {
	srv, _ := testRouter(t)
	stubAuthUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	loginAsTestUser(t, srv, ts.URL)

	sseResp, err := http.Get(ts.URL + api.PathEvents)
	if err != nil {
		t.Fatal(err)
	}
	defer sseResp.Body.Close()
	reader := bufio.NewReader(sseResp.Body)
	// Drain the seeded session and runtime frames.
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}

	// A QR event must not reach the app-event stream.
	srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{UUID: "u1", Status: api.QrLoginPending})
	// A following app event proves the stream is still alive rather than stalled.
	srv.Events.Publish(events.TopicAppEvent, api.AppEvent{Kind: api.AppEventRuntime})

	frame, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if frame.event != events.TopicAppEvent {
		t.Fatalf("stream surfaced %q, want only %q", frame.event, events.TopicAppEvent)
	}
	var ev api.AppEvent
	if err := json.Unmarshal([]byte(frame.data), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Kind != api.AppEventRuntime {
		t.Fatalf("got kind %q, want the app event behind the QR one", ev.Kind)
	}
}

// A QR stream for uuid A must stay silent when uuid B transitions.
func TestHandleSessionQREventsScopesToUUID(t *testing.T) {
	srv, _ := testRouter(t)
	stubQrUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	srv.Auth.SetOnQrChange(func(uuid string, st core.QrLoginStatus) {
		srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{
			UUID:   uuid,
			Status: api.QrLoginPhase(st.Status),
		})
	})

	startA := startQrLogin(t, ts.URL)
	startB := startQrLogin(t, ts.URL)

	respA, err := http.Get(ts.URL + "/api/session/qr/" + startA + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer respA.Body.Close()
	readerA := bufio.NewReader(respA.Body)
	if _, err := readNextSSEFrame(t, readerA, 2*time.Second); err != nil {
		t.Fatalf("initial frame for A: %v", err)
	}

	// Publishing another session's transition must not reach A's stream.
	srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{UUID: startB, Status: api.QrLoginExpired})
	srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{UUID: startA, Status: api.QrLoginError, Message: "boom"})

	frame, err := readNextSSEFrame(t, readerA, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	var ev api.QrStatusEvent
	if err := json.Unmarshal([]byte(frame.data), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.UUID != startA {
		t.Fatalf("stream for %s surfaced event for %s", startA, ev.UUID)
	}
	if ev.Message != "boom" {
		t.Fatalf("got message %q, want the A-specific one", ev.Message)
	}
}

// A client that hangs up mid-write must unwind the handler rather than spin.
func TestHandleEventsReturnsOnWriteFailure(t *testing.T) {
	srv, _ := testRouter(t)
	stubAuthUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)
	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	loginAsTestUser(t, srv, ts.URL)

	sseResp, err := http.Get(ts.URL + api.PathEvents)
	if err != nil {
		t.Fatal(err)
	}
	reader := bufio.NewReader(sseResp.Body)
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}
	// Hang up; the handler must notice on its next write instead of looping.
	_ = sseResp.Body.Close()

	done := make(chan struct{})
	go func() {
		defer close(done)
		for range 50 {
			srv.Events.Publish(events.TopicAppEvent, api.AppEvent{Kind: api.AppEventRuntime})
		}
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("publishing blocked after client hang-up")
	}
}

// stubAuthUpstream points the server's auth service at an upstream that accepts
// openid "abcdef_123" as a logged-in user, matching the other SSE tests.
func stubAuthUpstream(t *testing.T, srv *Server) {
	t.Helper()
	hduMock := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content/index/startUp/openid/abcdef_123/":
			w.WriteHeader(http.StatusOK)
		case "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
			})
		default:
			_ = json.NewEncoder(w).Encode(map[string]any{"CODE": "ok", "MESSAGE": "ok"})
		}
	}))
	t.Cleanup(hduMock.Close)
	srv.Auth = auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{Library: hduMock.URL})
}

// loginAsTestUser authenticates against the stubbed upstream and asserts it worked.
func loginAsTestUser(t *testing.T, srv *Server, baseURL string) {
	t.Helper()
	body, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	resp, err := http.Post(baseURL+api.PathSessionOpenID, "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("login status = %d", resp.StatusCode)
	}
	if st := srv.Auth.Status(); !st.Authenticated {
		t.Fatalf("login did not authenticate: %+v", st)
	}
}

// startQrLogin starts a QR login against the stub upstream and returns its uuid.
func startQrLogin(t *testing.T, baseURL string) string {
	t.Helper()
	resp, err := http.Post(baseURL+api.PathSessionQR, "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var start core.QrLoginStart
	if err := json.NewDecoder(resp.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	if start.UUID == "" {
		t.Fatal("empty uuid from QR start")
	}
	return start.UUID
}

// stubQrUpstream points the auth service at an upstream that can start a QR
// login, so /api/session/qr returns a usable uuid.
func stubQrUpstream(t *testing.T, srv *Server) {
	t.Helper()
	var seq atomic.Int32
	mux := http.NewServeMux()
	mux.HandleFunc("/sso/login", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost {
			http.Redirect(w, r, "/User/Center/baseInfo", http.StatusFound)
			return
		}
		_, _ = w.Write([]byte("ok"))
	})
	mux.HandleFunc("/sso/public/utils/loginNew.js", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte(`"Csrf-Key":"k1","Csrf-Value":"v1"`))
	})
	mux.HandleFunc("/sso/api/protected/qrlogin/loginid", func(w http.ResponseWriter, r *http.Request) {
		n := seq.Add(1)
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": fmt.Sprintf("qr-%d", n)})
	})
	mux.HandleFunc("/sso/api/public/qrlogin/qrgen/", func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write([]byte("png"))
	})
	mux.HandleFunc("/sso/api/protected/qrlogin/scan/", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": ""})
	})
	mux.HandleFunc("/User/Center/baseInfo", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]any{
			"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
		})
	})
	upstream := httptest.NewServer(mux)
	t.Cleanup(upstream.Close)

	srv.Auth = auth.NewServiceWithEndpoints(srv.Store, nil, auth.Endpoints{
		Library:       upstream.URL,
		SSO:           upstream.URL + "/sso",
		SSOLoginPage:  upstream.URL + "/sso/login?service=test",
		SSOCsrfScript: upstream.URL + "/sso/public/utils/loginNew.js",
	})
}
