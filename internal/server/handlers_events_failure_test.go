package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"hdu-library-sniper/internal/api"
	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/events"
	"hdu-library-sniper/internal/scheduler"
)

// failingWriter fails on the nth write, so each guarded write path can be
// exercised without racing a real client hang-up.
type failingWriter struct {
	header    http.Header
	failAfter int
	writes    int
	status    int
}

func (w *failingWriter) Header() http.Header {
	if w.header == nil {
		w.header = http.Header{}
	}
	return w.header
}

func (w *failingWriter) WriteHeader(status int) { w.status = status }

func (w *failingWriter) Write(p []byte) (int, error) {
	w.writes++
	if w.writes > w.failAfter {
		return 0, errors.New("write failed")
	}
	return len(p), nil
}

func TestSSEWriteHelpersPropagateErrors(t *testing.T) {
	// A writer that rejects the very first write.
	w := &failingWriter{failAfter: 0}
	rc := prepareSSE(w)

	if err := writeSSEComment(w, rc, "connected"); err == nil {
		t.Fatal("writeSSEComment must surface a write error")
	}
	if err := writeSSEEvent(w, rc, events.TopicAppEvent, []byte(`{"kind":"runtime"}`)); err == nil {
		t.Fatal("writeSSEEvent must surface a write error")
	}
}

func TestHandleEventsStopsWhenHandshakeFails(t *testing.T) {
	srv, _ := testRouter(t)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	// First write (the "connected" comment) fails, so the handler returns early.
	w := &failingWriter{failAfter: 0}
	req := httptest.NewRequest(http.MethodGet, api.PathEvents, nil)
	srv.handleEvents(w, req)

	if w.writes != 1 {
		t.Fatalf("handler wrote %d times after a failing handshake, want 1", w.writes)
	}
}

func TestHandleEventsStopsWhenSessionSnapshotFails(t *testing.T) {
	srv, _ := testRouter(t)
	stubAuthUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	body, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, api.PathSessionOpenID, bytes.NewReader(body)))
	if st := srv.Auth.Status(); !st.Authenticated {
		t.Fatalf("login did not authenticate: %+v", st)
	}

	// The comment succeeds; the session snapshot that follows fails.
	w := &failingWriter{failAfter: 1}
	srv.handleEvents(w, httptest.NewRequest(http.MethodGet, api.PathEvents, nil))

	if w.writes != 2 {
		t.Fatalf("handler wrote %d times, want comment + one failed session frame", w.writes)
	}
}

func TestHandleSessionQREventsStopsWhenHandshakeFails(t *testing.T) {
	srv, _ := testRouter(t)
	stubQrUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, api.PathSessionQR, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("QR start status = %d", rec.Code)
	}
	var start core.QrLoginStart
	if err := json.NewDecoder(rec.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}

	req := httptest.NewRequest(http.MethodGet, api.PathSessionQR+"/"+start.UUID+"/events", nil)
	req.SetPathValue("uuid", start.UUID)

	w := &failingWriter{failAfter: 0}
	srv.handleSessionQREvents(w, req)

	if w.writes != 1 {
		t.Fatalf("QR handler wrote %d times after a failing handshake, want 1", w.writes)
	}
}

// Shortening the heartbeat lets the keepalive branch run without a 25s wait.
func withHeartbeat(t *testing.T, d time.Duration) {
	t.Helper()
	prev := sseHeartbeatInterval
	sseHeartbeatInterval = d
	t.Cleanup(func() { sseHeartbeatInterval = prev })
}

func TestHandleEventsSendsKeepalive(t *testing.T) {
	withHeartbeat(t, 10*time.Millisecond)
	srv, _ := testRouter(t)
	stubAuthUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	body, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, api.PathSessionOpenID, bytes.NewReader(body)))

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + api.PathEvents)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	// Drain session + runtime, then expect a keepalive comment (readNextSSEFrame skips comments,
	// so read raw lines instead).
	sawKeepalive := false
	deadline := time.After(2 * time.Second)
	for !sawKeepalive {
		select {
		case <-deadline:
			t.Fatal("no keepalive comment within the heartbeat window")
		default:
		}
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read failed: %v", err)
		}
		if strings.HasPrefix(line, ": keepalive") {
			sawKeepalive = true
		}
	}
}

func TestHandleSessionQREventsSendsKeepalive(t *testing.T) {
	withHeartbeat(t, 10*time.Millisecond)
	srv, _ := testRouter(t)
	stubQrUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()

	uuid := startQrLogin(t, ts.URL)
	resp, err := http.Get(ts.URL + api.PathSessionQR + "/" + uuid + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()

	reader := bufio.NewReader(resp.Body)
	sawKeepalive := false
	deadline := time.After(2 * time.Second)
	for !sawKeepalive {
		select {
		case <-deadline:
			t.Fatal("no keepalive comment within the heartbeat window")
		default:
		}
		line, err := reader.ReadString('\n')
		if err != nil {
			t.Fatalf("read failed: %v", err)
		}
		if strings.HasPrefix(line, ": keepalive") {
			sawKeepalive = true
		}
	}
}

func TestPublishInvalidateNoOps(t *testing.T) {
	// No bus configured: must not panic.
	srv, _ := testRouter(t)
	bus := srv.Events
	srv.Events = nil
	srv.publishInvalidate(api.InvalidatePlans)
	srv.Events = bus

	// No targets: must not publish anything.
	ch, unsub := srv.Events.Subscribe(events.TopicAppEvent)
	defer unsub()
	srv.publishInvalidate()
	select {
	case msg := <-ch:
		t.Fatalf("empty invalidate published %+v", msg)
	default:
	}
}

// A subscriber whose payload is not the concrete type is served from RawJSON.
func TestHandleSessionQREventsFallsBackToRawJSON(t *testing.T) {
	srv, _ := testRouter(t)
	stubQrUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	uuid := startQrLogin(t, ts.URL)

	resp, err := http.Get(ts.URL + api.PathSessionQR + "/" + uuid + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatalf("initial frame: %v", err)
	}

	// Publish a payload that is not api.QrStatusEvent so the handler must unmarshal RawJSON.
	srv.Events.Publish(events.TopicQrStatus, map[string]string{"uuid": uuid, "status": "pending"})

	frame, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatalf("frame from raw fallback: %v", err)
	}
	var ev api.QrStatusEvent
	if err := json.Unmarshal([]byte(frame.data), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.UUID != uuid {
		t.Fatalf("got uuid %q, want %q", ev.UUID, uuid)
	}
}

// The handler must give up when a post-handshake write fails, rather than
// looping until the client's context is noticed.
func TestHandleEventsStopsWhenPublishWriteFails(t *testing.T) {
	withHeartbeat(t, time.Hour)
	srv, _ := testRouter(t)
	stubAuthUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	body, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, api.PathSessionOpenID, bytes.NewReader(body)))

	// Comment + session + runtime succeed; the next app event write fails.
	w := &failingWriter{failAfter: 3}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	req := httptest.NewRequest(http.MethodGet, api.PathEvents, nil).WithContext(ctx)

	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.handleEvents(w, req)
	}()

	// Give the handler a moment to reach its select loop, then publish.
	time.Sleep(50 * time.Millisecond)
	srv.Events.Publish(events.TopicAppEvent, api.AppEvent{Kind: api.AppEventRuntime})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after a failed publish write")
	}
	if w.writes != 4 {
		t.Fatalf("writer saw %d writes, want 4 (comment, session, runtime, failing event)", w.writes)
	}
}

// A payload that is neither the concrete type nor valid JSON is skipped.
func TestHandleSessionQREventsSkipsUnparsablePayload(t *testing.T) {
	srv, _ := testRouter(t)
	stubQrUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	uuid := startQrLogin(t, ts.URL)

	resp, err := http.Get(ts.URL + api.PathSessionQR + "/" + uuid + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}

	// A func payload cannot be serialized, so Publish drops it entirely; use a
	// channel payload to make json.Marshal fail the same way.
	srv.Events.Publish(events.TopicQrStatus, make(chan int))
	srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{UUID: uuid, Status: api.QrLoginError, Message: "done"})

	frame, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatalf("expected the real event after the dropped one: %v", err)
	}
	var ev api.QrStatusEvent
	if err := json.Unmarshal([]byte(frame.data), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Message != "done" {
		t.Fatalf("got %q, want the event published after the unparsable one", ev.Message)
	}
}

func TestHandleEventsUnavailableWithoutBus(t *testing.T) {
	srv, _ := testRouter(t)
	bus := srv.Events
	srv.Events = nil
	defer func() { srv.Events = bus }()

	w := httptest.NewRecorder()
	srv.handleEvents(w, httptest.NewRequest(http.MethodGet, api.PathEvents, nil))

	if w.Code != http.StatusServiceUnavailable {
		t.Fatalf("status = %d, want 503", w.Code)
	}
}

func TestHandleEventsReturnsImmediatelyWhenUnauthenticated(t *testing.T) {
	withHeartbeat(t, time.Hour)
	srv, _ := testRouter(t)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	// No login: the handler must write the session snapshot then close.
	w := &failingWriter{failAfter: 10}
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.handleEvents(w, httptest.NewRequest(http.MethodGet, api.PathEvents, nil))
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler kept the stream open for an unauthenticated client")
	}
	// comment + session snapshot
	if w.writes != 2 {
		t.Fatalf("writes = %d, want 2", w.writes)
	}
}

func TestHandleEventsStopsWhenRuntimeSnapshotFails(t *testing.T) {
	withHeartbeat(t, time.Hour)
	srv, _ := testRouter(t)
	stubAuthUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	body, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, api.PathSessionOpenID, bytes.NewReader(body)))

	// comment + session succeed; runtime snapshot write fails.
	w := &failingWriter{failAfter: 2}
	srv.handleEvents(w, httptest.NewRequest(http.MethodGet, api.PathEvents, nil))
	if w.writes != 3 {
		t.Fatalf("writes = %d, want 3", w.writes)
	}
}

func TestHandleEventsStopsWhenKeepaliveFails(t *testing.T) {
	withHeartbeat(t, 5*time.Millisecond)
	srv, _ := testRouter(t)
	stubAuthUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	body, _ := json.Marshal(api.LoginOpenIDRequest{OpenID: "abcdef_123"})
	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, api.PathSessionOpenID, bytes.NewReader(body)))

	// comment + session + runtime succeed; the first keepalive fails.
	w := &failingWriter{failAfter: 3}
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.handleEvents(w, httptest.NewRequest(http.MethodGet, api.PathEvents, nil))
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler ignored a failing keepalive")
	}
}

// qrHandlerFixture starts a QR login and returns the server plus its uuid.
func qrHandlerFixture(t *testing.T) (*Server, string) {
	t.Helper()
	srv, _ := testRouter(t)
	stubQrUpstream(t, srv)
	srv.Scheduler = scheduler.New(srv.Store, srv.Auth, srv.Booking)

	rec := httptest.NewRecorder()
	srv.Handler().ServeHTTP(rec, httptest.NewRequest(http.MethodPost, api.PathSessionQR, nil))
	if rec.Code != http.StatusOK {
		t.Fatalf("QR start status = %d", rec.Code)
	}
	var start core.QrLoginStart
	if err := json.NewDecoder(rec.Body).Decode(&start); err != nil {
		t.Fatal(err)
	}
	return srv, start.UUID
}

func qrRequest(uuid string) *http.Request {
	req := httptest.NewRequest(http.MethodGet, api.PathSessionQR+"/"+uuid+"/events", nil)
	req.SetPathValue("uuid", uuid)
	return req
}

func TestHandleSessionQREventsStopsWhenInitialFrameFails(t *testing.T) {
	withHeartbeat(t, time.Hour)
	srv, uuid := qrHandlerFixture(t)

	// The very first frame fails.
	w := &failingWriter{failAfter: 0}
	srv.handleSessionQREvents(w, qrRequest(uuid))
	if w.writes != 1 {
		t.Fatalf("writes = %d, want 1", w.writes)
	}
}

func TestHandleSessionQREventsClosesOnBusShutdown(t *testing.T) {
	withHeartbeat(t, time.Hour)
	srv, uuid := qrHandlerFixture(t)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + api.PathSessionQR + "/" + uuid + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}

	srv.Events.Close()
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != io.EOF {
		t.Fatalf("expected EOF after bus close, got %v", err)
	}
}

func TestHandleSessionQREventsStopsWhenPublishWriteFails(t *testing.T) {
	withHeartbeat(t, time.Hour)
	srv, uuid := qrHandlerFixture(t)

	// Initial frame succeeds; the next published event write fails.
	w := &failingWriter{failAfter: 1}
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.handleSessionQREvents(w, qrRequest(uuid))
	}()

	time.Sleep(50 * time.Millisecond)
	srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{UUID: uuid, Status: api.QrLoginPending})

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("handler did not return after a failed publish write")
	}
	if w.writes != 2 {
		t.Fatalf("writes = %d, want 2", w.writes)
	}
}

func TestHandleSessionQREventsStopsWhenKeepaliveFails(t *testing.T) {
	withHeartbeat(t, 5*time.Millisecond)
	srv, uuid := qrHandlerFixture(t)

	// Initial frame succeeds; the first keepalive fails.
	w := &failingWriter{failAfter: 1}
	done := make(chan struct{})
	go func() {
		defer close(done)
		srv.handleSessionQREvents(w, qrRequest(uuid))
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("QR handler ignored a failing keepalive")
	}
}

func TestHandleSessionQREventsSkipsUndecodableEvent(t *testing.T) {
	srv, uuid := qrHandlerFixture(t)

	ts := httptest.NewServer(srv.Handler())
	defer ts.Close()
	resp, err := http.Get(ts.URL + api.PathSessionQR + "/" + uuid + "/events")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	reader := bufio.NewReader(resp.Body)
	if _, err := readNextSSEFrame(t, reader, 2*time.Second); err != nil {
		t.Fatal(err)
	}

	// Numbers decode into the string fields as a type error, leaving a zero value
	// that the uuid filter drops.
	srv.Events.Publish(events.TopicQrStatus, map[string]any{"uuid": 123, "status": 456})
	srv.Events.Publish(events.TopicQrStatus, api.QrStatusEvent{UUID: uuid, Status: api.QrLoginError, Message: "after-bad"})

	frame, err := readNextSSEFrame(t, reader, 2*time.Second)
	if err != nil {
		t.Fatalf("expected the good event behind the bad one: %v", err)
	}
	var ev api.QrStatusEvent
	if err := json.Unmarshal([]byte(frame.data), &ev); err != nil {
		t.Fatal(err)
	}
	if ev.Message != "after-bad" {
		t.Fatalf("got %q, want the event after the undecodable one", ev.Message)
	}
}
