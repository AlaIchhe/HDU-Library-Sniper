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
	return NewServiceWithEndpoints(st, sec, ep)
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
