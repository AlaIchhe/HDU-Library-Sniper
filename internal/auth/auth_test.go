package auth

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
	"hdu-library-sniper/internal/store"
)

func testService(t *testing.T, srv *httptest.Server) *Service {
	t.Helper()
	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	sec := NewSecretStoreWithKey([]byte("unit-test-key"), "test")
	ep := Endpoints{
		Library:       srv.URL,
		SSO:           srv.URL + "/sso",
		SSOLoginPage:  srv.URL + "/sso/login?service=test",
		SSOCsrfScript: srv.URL + "/sso/public/utils/loginNew.js",
	}
	svc := NewServiceWithEndpoints(st, sec, ep)
	t.Cleanup(func() {
		_ = svc.Logout()
		svc.qrWg.Wait()
	})
	return svc
}

func TestSecretStoreSealAndOpen(t *testing.T) {
	sec := OpenSecretStore(t.TempDir())
	enc, scheme, err := sec.Seal(`{"student_id":"304174","password":"secret"}`)
	if err != nil || scheme != SchemeFile || enc == "" {
		t.Fatalf("Seal failed: %q %v", scheme, err)
	}
	plain, err := sec.Open(enc, scheme)
	if err != nil || !strings.Contains(plain, "304174") {
		t.Fatalf("Open = %q, %v", plain, err)
	}
}

func TestPasswordLoginIsolatedJarRetryAndLockout(t *testing.T) {
	var postCount atomic.Int32
	var seenStale atomic.Bool

	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case hdu.LoginEntry:
			http.Redirect(w, r, srv.URL+"/sso/login?service=test", http.StatusFound)
		case "/sso/login":
			if r.Method == http.MethodGet {
				_, _ = fmt.Fprint(w, `<p id="login-croypto">MDEyMzQ1Njc4OWFiY2RlZg==</p><p id="login-page-flowkey">fk1</p><form id="normalLoginForm" action="/sso/doLogin"></form>`)
				return
			}
		case "/sso/doLogin":
			if strings.Contains(r.Header.Get("Cookie"), "stale=1") {
				seenStale.Store(true)
			}
			c := postCount.Add(1)
			if c == 1 {
				// Simulate transient SSO gateway blip redirecting back without login-error-msg.
				http.Redirect(w, r, srv.URL+"/sso/login?blip=1", http.StatusFound)
				return
			}
			http.Redirect(w, r, srv.URL+"/User/Center/baseInfo", http.StatusFound)
		case "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{
					"is_login":  true,
					"uid":       "304174",
					"user_info": map[string]any{"name": "陈同学"},
				},
			})
		}
	}))
	defer srv.Close()

	svc := testService(t, srv)
	svc.Client.Jar().SetAll([]hdu.StoredCookie{{Name: "stale", Value: "1", Domain: "127.0.0.1", Path: "/"}})
	res := svc.LoginPassword(context.Background(), "304174", "secret")
	if !res.Success || postCount.Load() != 2 || seenStale.Load() {
		t.Fatalf("res=%+v postCount=%d seenStale=%v", res, postCount.Load(), seenStale.Load())
	}

	for i := 0; i < 3; i++ {
		svc.noteLogin(false)
	}
	if _, blocked := svc.LoginBlocked(); !blocked {
		t.Fatal("expected lockout after 3 failures")
	}
}

func TestOpenIDLoginRollbackAndQRFlow(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sso/login":
			if r.Method == http.MethodPost {
				http.Redirect(w, r, "/User/Center/baseInfo", http.StatusFound)
				return
			}
			_, _ = w.Write([]byte("ok"))
		case "/sso/public/utils/loginNew.js":
			_, _ = w.Write([]byte(`"Csrf-Key":"k1","Csrf-Value":"v1"`))
		case "/sso/api/protected/qrlogin/loginid":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": "uuid-1"})
		case "/sso/api/public/qrlogin/qrgen/uuid-1/dingDingQr":
			_, _ = w.Write([]byte("pngdata"))
		case "/sso/api/protected/qrlogin/scan/uuid-1":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": "tok-1"})
		case "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{
					"is_login":  true,
					"uid":       "304174",
					"user_info": map[string]any{"name": "陈同学"},
				},
			})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc := testService(t, srv)
	start, err := svc.CreateQrLogin(context.Background())
	if err != nil || start.UUID != "uuid-1" || !strings.HasPrefix(start.Image, "data:image/png;base64,") {
		t.Fatalf("CreateQrLogin = %+v, %v", start, err)
	}
	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		st := svc.PollQrLogin(start.UUID)
		if st.Status == "success" {
			return
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatalf("QR login did not succeed: %+v", svc.PollQrLogin(start.UUID))
}

func TestSessionChangeCallbacksAndRefreshingReset(t *testing.T) {
	var valid atomic.Bool
	valid.Store(true)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/content/index/startUp/openid/abcdef_123/":
			w.WriteHeader(http.StatusOK)
		case "/User/Center/baseInfo":
			if !valid.Load() {
				_ = json.NewEncoder(w).Encode(map[string]any{"DATA": map[string]any{"is_login": false}})
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
			})
		}
	}))
	defer srv.Close()

	svc := testService(t, srv)
	var events []core.SessionStatus
	svc.SetOnSessionChange(func(st core.SessionStatus) {
		events = append(events, st)
	})

	if res := svc.LoginOpenID(context.Background(), "abcdef_123"); !res.Success {
		t.Fatalf("login failed: %+v", res)
	}
	svc.MarkLost()
	// Duplicate MarkLost does not re-emit identical state.
	svc.MarkLost()

	if res := svc.LoginOpenID(context.Background(), "abcdef_123"); !res.Success {
		t.Fatalf("second login failed: %+v", res)
	}
	// Refresh failure when OpenID becomes invalid transitions Authenticated -> false and notifies.
	valid.Store(false)
	if svc.Refresh(context.Background()) {
		t.Fatal("expected Refresh to fail when OpenID validation fails")
	}
	if svc.Authenticated() {
		t.Fatal("expected Authenticated() == false after failed Refresh")
	}

	valid.Store(true)
	if res := svc.LoginOpenID(context.Background(), "abcdef_123"); !res.Success {
		t.Fatalf("third login failed: %+v", res)
	}
	if err := svc.Logout(); err != nil {
		t.Fatalf("logout failed: %v", err)
	}

	if len(events) != 6 {
		t.Fatalf("expected 6 session events, got %d: %+v", len(events), events)
	}
	if !events[0].Authenticated || events[0].Refreshing {
		t.Fatalf("event[0] = %+v", events[0])
	}
	if events[1].Authenticated || events[1].Refreshing || events[1].LastError == "" {
		t.Fatalf("event[1] = %+v", events[1])
	}
	if !events[2].Authenticated || events[2].Refreshing {
		t.Fatalf("event[2] = %+v", events[2])
	}
	if events[3].Authenticated || events[3].Refreshing || events[3].LastError == "" {
		t.Fatalf("event[3] = %+v", events[3])
	}
	if !events[4].Authenticated || events[4].Refreshing {
		t.Fatalf("event[4] = %+v", events[4])
	}
	if events[5].Authenticated || events[5].Refreshing || events[5].LastError != "" {
		t.Fatalf("event[5] = %+v", events[5])
	}
}

func TestQrWatchAbandonAndCancelNotifiesAndFreesSlot(t *testing.T) {
	var idCounter atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/sso/login":
			_, _ = w.Write([]byte("ok"))
		case r.URL.Path == "/sso/public/utils/loginNew.js":
			_, _ = w.Write([]byte(`"Csrf-Key":"k1","Csrf-Value":"v1"`))
		case r.URL.Path == "/sso/api/protected/qrlogin/loginid":
			n := idCounter.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": fmt.Sprintf("qr-%d", n)})
		case strings.HasPrefix(r.URL.Path, "/sso/api/public/qrlogin/qrgen/"):
			_, _ = w.Write([]byte("png"))
		case strings.HasPrefix(r.URL.Path, "/sso/api/protected/qrlogin/scan/"):
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": ""})
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc := testService(t, srv)
	svc.qrStreamGrace = 30 * time.Millisecond
	svc.qrPollTick = 15 * time.Millisecond

	cancelledCh := make(chan core.QrLoginStatus, 4)
	svc.SetOnQrChange(func(_ string, st core.QrLoginStatus) {
		cancelledCh <- st
	})

	q1, err := svc.CreateQrLogin(context.Background())
	if err != nil {
		t.Fatalf("q1: %v", err)
	}
	q2, err := svc.CreateQrLogin(context.Background())
	if err != nil {
		t.Fatalf("q2: %v", err)
	}
	// Semaphore has capacity 2; 3rd must fail while both active.
	if _, err := svc.CreateQrLogin(context.Background()); err == nil {
		t.Fatal("expected 3rd concurrent QR to fail")
	}

	// Disconnect watcher on q1 and wait past qrStreamGrace -> q1 is abandoned and frees slot.
	end1 := svc.BeginQrWatch(q1.UUID)
	end1()
	deadline := time.Now().Add(1 * time.Second)
	var q3 *core.QrLoginStart
	for time.Now().Before(deadline) {
		q3, err = svc.CreateQrLogin(context.Background())
		if err == nil {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if err != nil || q3 == nil {
		t.Fatalf("expected slot freed after watcher abandoned q1, last err=%v", err)
	}

	// Cancel q2 and verify notification + slot release.
	if !svc.CancelQrLogin(q2.UUID) {
		t.Fatal("CancelQrLogin(q2) returned false")
	}
	select {
	case st := <-cancelledCh:
		if st.Status != "error" {
			t.Fatalf("expected error status on cancel, got %+v", st)
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("timed out waiting for cancel notification")
	}
	_ = svc.CancelQrLogin(q3.UUID)
	svc.qrWg.Wait()
}

// SSO 的扫码接口是长轮询：没有新状态时它会挂住连接，最后回 {"code":408,"data":"wait"}。
// 这个用例锁住两件事：wait 不能被当成失败，单轮超时也不能让整张码作废。
func TestQrScanLongPollWaitAndTimeoutKeepSessionAlive(t *testing.T) {
	var polls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/sso/login":
			_, _ = w.Write([]byte("ok"))
		case r.URL.Path == "/sso/public/utils/loginNew.js":
			_, _ = w.Write([]byte(`"Csrf-Key":"k1","Csrf-Value":"v1"`))
		case r.URL.Path == "/sso/api/protected/qrlogin/loginid":
			_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": "qr-wait-1"})
		case strings.HasPrefix(r.URL.Path, "/sso/api/public/qrlogin/qrgen/"):
			_, _ = w.Write([]byte("png"))
		case r.URL.Path == "/User/Center/baseInfo":
			_ = json.NewEncoder(w).Encode(map[string]any{
				"DATA": map[string]any{"is_login": true, "uid": "304174", "user_info": map[string]any{"name": "陈同学"}},
			})
		case strings.HasPrefix(r.URL.Path, "/sso/api/protected/qrlogin/scan/"):
			switch n := polls.Add(1); n {
			case 1:
				// 长轮询满一轮没等到扫码：SSO 用 408 + data=wait 表示“还没有状态”。
				w.WriteHeader(http.StatusRequestTimeout)
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 408, "message": "Request Timeout", "data": "wait"})
			case 2:
				// 单轮被掐断（对应线上 15s 客户端超时）：直接断连让客户端拿到 EOF。
				// 这不该让整张码进入 error。
				conn, _, err := w.(http.Hijacker).Hijack()
				if err == nil {
					_ = conn.Close()
				}
			default:
				_ = json.NewEncoder(w).Encode(map[string]any{"code": 200, "data": "tok-wait"})
			}
		default:
			http.NotFound(w, r)
		}
	}))
	defer srv.Close()

	svc := testService(t, srv)
	svc.qrPollTick = 10 * time.Millisecond
	svc.qrStreamGrace = 5 * time.Second

	start, err := svc.CreateQrLogin(context.Background())
	if err != nil {
		t.Fatalf("CreateQrLogin: %v", err)
	}
	end := svc.BeginQrWatch(start.UUID)
	defer end()

	deadline := time.Now().Add(4 * time.Second)
	for time.Now().Before(deadline) {
		st := svc.PollQrLogin(start.UUID)
		if st.Status == "error" {
			t.Fatalf("长轮询的 wait/超时不应让扫码会话失败: %+v", st)
		}
		if st.Status == "success" {
			if st.Session == nil || !st.Session.Authenticated {
				t.Fatalf("success 事件缺少已认证会话: %+v", st)
			}
			if got := polls.Load(); got < 3 {
				t.Fatalf("期望至少 3 轮长轮询，实际 %d", got)
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("扫码长轮询没有走到 success: %+v", svc.PollQrLogin(start.UUID))
}

// 扫码票据被 CAS 拒绝时，必须给出可诊断的原因，而不是笼统的“会话校验失败”。
func TestCompleteQrLoginReportsRejectedTicket(t *testing.T) {
	// 票据被拒时 CAS 会把浏览器留在 SSO 自己的登录页上，不会跳回图书馆域。
	var sso *httptest.Server
	sso = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/sso/login":
			_, _ = w.Write([]byte("<html>login</html>"))
		case "/sso/public/utils/loginNew.js":
			_, _ = w.Write([]byte(`"Csrf-Key":"k1","Csrf-Value":"v1"`))
		default:
			http.NotFound(w, r)
		}
	}))
	defer sso.Close()

	lib := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.NotFound(w, r)
	}))
	defer lib.Close()

	st, err := store.OpenMemory()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = st.Close() })
	svc := NewServiceWithEndpoints(st, NewSecretStoreWithKey([]byte("unit-test-key"), "test"), Endpoints{
		Library:       lib.URL,
		SSO:           sso.URL + "/sso",
		SSOLoginPage:  sso.URL + "/sso/login?service=test",
		SSOCsrfScript: sso.URL + "/sso/public/utils/loginNew.js",
	})
	t.Cleanup(func() {
		_ = svc.Logout()
		svc.qrWg.Wait()
	})
	err = svc.completeQrLogin(context.Background(), "tok-rejected")
	if err == nil {
		t.Fatal("expected rejected ticket error")
	}
	if !strings.Contains(err.Error(), "未被接受") {
		t.Fatalf("expected a diagnosable rejection message, got %v", err)
	}
	// 诊断信息不应把票据/查询串泄漏出去。
	if strings.Contains(err.Error(), "tok-rejected") || strings.Contains(err.Error(), "service=") {
		t.Fatalf("error leaked sensitive request data: %v", err)
	}
}

func TestRedactURLStripsQueryAndFragment(t *testing.T) {
	got := redactURL("https://sso.hdu.edu.cn/login?service=https%3A%2F%2Fx&ticket=ST-1#frag")
	if got != "https://sso.hdu.edu.cn/login" {
		t.Fatalf("redactURL = %q", got)
	}
	if got := redactURL("::not a url"); got == "" {
		t.Fatal("expected fallback for unparsable url")
	}
}
