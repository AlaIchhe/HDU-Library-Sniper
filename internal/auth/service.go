package auth

import (
	"context"
	"encoding/json"
	"net/http"
	"net/url"
	"sync"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
	"hdu-library-sniper/internal/store"
)

const (
	loginLockoutThreshold = 3
	loginLockoutDuration  = 30 * time.Second
)

type Endpoints struct {
	Library       string
	SSO           string
	SSOLoginPage  string
	SSOCsrfScript string
}

func DefaultEndpoints() Endpoints {
	return Endpoints{
		Library:       hdu.LibraryBase,
		SSO:           hdu.SSOBase,
		SSOLoginPage:  hdu.SSOBase + "/login?service=" + url.QueryEscape(hdu.LibraryBase+hdu.LoginEntry),
		SSOCsrfScript: hdu.SSOBase + "/public/utils/loginNew.js",
	}
}

type Credentials struct {
	StudentID string `json:"student_id,omitempty"`
	Password  string `json:"password,omitempty"`
	OpenID    string `json:"openid,omitempty"`
}

type LoginResult struct {
	Success bool               `json:"success"`
	Message string             `json:"message"`
	Session core.SessionStatus `json:"session"`
}

// Service manages HDU library authentication (CAS password, OpenID, DingTalk QR) and session persistence.
type Service struct {
	Store     *store.Store
	Secrets   *SecretStore
	Client    *hdu.LibraryClient
	Endpoints Endpoints

	loginGate     sync.Mutex
	qrSem         chan struct{}
	qrWg          sync.WaitGroup
	qrStreamGrace time.Duration
	qrPollTick    time.Duration

	mu              sync.Mutex
	authenticated   bool
	refreshing      bool
	lastError       string
	creds           *Credentials
	qrSessions      map[string]*qrSession
	failStreak      int
	blockedUntil    time.Time
	onSessionChange func(core.SessionStatus)
	onQrChange      func(string, core.QrLoginStatus)
}

func NewService(st *store.Store, secrets *SecretStore) *Service {
	return NewServiceWithEndpoints(st, secrets, DefaultEndpoints())
}

func NewServiceWithEndpoints(st *store.Store, secrets *SecretStore, ep Endpoints) *Service {
	if secrets == nil {
		var err error
		secrets, err = OpenSecretStore("")
		if err != nil {
			panic(err)
		}
	}
	client := hdu.NewClientWithBaseURL(ep.Library)
	svc := &Service{
		Store:         st,
		Secrets:       secrets,
		Client:        client,
		Endpoints:     ep,
		qrSem:         make(chan struct{}, 2),
		qrStreamGrace: defaultQrStreamGrace,
		qrPollTick:    defaultQrPollTick,
		qrSessions:    make(map[string]*qrSession),
	}
	client.SetHooks(svc.Refresh, svc.MarkLost)
	return svc
}

// SetOnSessionChange registers a listener invoked whenever authentication state transitions.
func (s *Service) SetOnSessionChange(fn func(core.SessionStatus)) {
	s.mu.Lock()
	s.onSessionChange = fn
	s.mu.Unlock()
}

// SetOnQrChange registers a listener invoked whenever a QR login session updates status.
func (s *Service) SetOnQrChange(fn func(string, core.QrLoginStatus)) {
	s.mu.Lock()
	s.onQrChange = fn
	s.mu.Unlock()
}

func (s *Service) notifySession() {
	s.mu.Lock()
	fn := s.onSessionChange
	s.mu.Unlock()
	if fn != nil {
		fn(s.Status())
	}
}

func (s *Service) notifyQr(uuid string, st core.QrLoginStatus) {
	s.mu.Lock()
	fn := s.onQrChange
	s.mu.Unlock()
	if fn != nil {
		fn(uuid, st)
	}
}

func (s *Service) Authenticated() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.authenticated
}

func (s *Service) Status() core.SessionStatus {
	s.mu.Lock()
	authd := s.authenticated
	ref := s.refreshing
	lastErr := s.lastError
	s.mu.Unlock()

	if authd {
		return core.SessionStatus{
			Authenticated: true,
			UID:           s.Client.UID(),
			Name:          s.Client.Name(),
			Refreshing:    ref,
			LastError:     lastErr,
		}
	}
	return core.SessionStatus{
		Authenticated: false,
		Refreshing:    ref,
		LastError:     lastErr,
	}
}

func (s *Service) LoginBlocked() (int, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.blockedUntil.IsZero() {
		return 0, false
	}
	rem := time.Until(s.blockedUntil)
	if rem <= 0 {
		s.blockedUntil = time.Time{}
		return 0, false
	}
	secs := int(rem.Seconds()) + 1
	return secs, true
}

func (s *Service) noteLogin(success bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if success {
		s.failStreak = 0
		s.blockedUntil = time.Time{}
		return
	}
	s.failStreak++
	if s.failStreak >= loginLockoutThreshold {
		s.blockedUntil = time.Now().Add(loginLockoutDuration)
		s.failStreak = 0
	}
}

func (s *Service) MarkLost() {
	const lostMsg = "图书馆登录状态已失效"
	s.mu.Lock()
	changed := s.authenticated || s.lastError != lostMsg
	s.authenticated = false
	s.refreshing = false
	s.lastError = lostMsg
	s.mu.Unlock()
	s.Client.Jar().Clear()
	s.Client.SetIdentity("", "")
	if changed {
		s.notifySession()
	}
}

func (s *Service) Restore(ctx context.Context) bool {
	rec, err := s.Store.LoadSession()
	if err != nil || rec == nil {
		return false
	}
	creds := s.decodeStoredCredentials(rec)
	s.mu.Lock()
	s.creds = creds
	s.mu.Unlock()

	if rec.Cookies != "" {
		_ = s.Client.Jar().ImportJSON(rec.Cookies)
	}
	if rec.UID != "" {
		s.Client.SetIdentity(rec.UID, rec.Name)
	}
	if s.Client.ValidateOnce(ctx) {
		s.mu.Lock()
		s.authenticated = true
		s.refreshing = false
		s.lastError = ""
		s.mu.Unlock()
		_ = s.persistSession()
		s.notifySession()
		return true
	}
	return s.Refresh(ctx)
}

func (s *Service) Refresh(ctx context.Context) bool {
	s.loginGate.Lock()
	defer s.loginGate.Unlock()

	s.mu.Lock()
	creds := s.creds
	wasAuth := s.authenticated
	s.refreshing = true
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		s.refreshing = false
		s.mu.Unlock()
	}()

	if creds == nil {
		s.MarkLost()
		return false
	}
	if creds.StudentID != "" && creds.Password != "" {
		res, err := s.loginPasswordInner(ctx, creds.StudentID, creds.Password)
		if err == nil && res.Success {
			return true
		}
		s.mu.Lock()
		if err != nil {
			s.lastError = err.Error()
		} else {
			s.lastError = res.Message
		}
		s.authenticated = false
		s.refreshing = false
		s.mu.Unlock()
		if wasAuth {
			s.notifySession()
		}
		return false
	}
	if creds.OpenID != "" {
		res := s.loginOpenIDLocked(ctx, creds.OpenID)
		if !res.Success {
			s.mu.Lock()
			s.authenticated = false
			s.refreshing = false
			s.lastError = res.Message
			s.mu.Unlock()
			if wasAuth {
				s.notifySession()
			}
		}
		return res.Success
	}
	s.MarkLost()
	return false
}

func (s *Service) Logout() error {
	s.mu.Lock()
	sessions := s.qrSessions
	s.qrSessions = make(map[string]*qrSession)
	pendingIDs := make([]string, 0, len(sessions))
	for uuid, qs := range sessions {
		if qs.status.Status == "pending" {
			pendingIDs = append(pendingIDs, uuid)
		}
	}
	wasAuth := s.authenticated
	s.authenticated = false
	s.refreshing = false
	s.lastError = ""
	s.creds = nil
	s.mu.Unlock()

	for _, qs := range sessions {
		if qs.cancel != nil {
			qs.cancel()
		}
	}
	for _, uuid := range pendingIDs {
		s.notifyQr(uuid, core.QrLoginStatus{Status: "error", Message: "扫码会话已取消"})
	}
	s.Client.Jar().Clear()
	s.Client.SetIdentity("", "")
	s.Client.ClearRoomMeta()
	err := s.Store.ClearSession()
	if wasAuth {
		s.notifySession()
	}
	return err
}

func (s *Service) persistSession() error {
	s.mu.Lock()
	creds := s.creds
	s.mu.Unlock()

	rec := &store.SessionRecord{
		UID:       s.Client.UID(),
		Name:      s.Client.Name(),
		Cookies:   s.Client.Jar().ExportJSON(),
		UpdatedAt: core.FormatISO(time.Now()),
	}
	if creds != nil {
		raw, err := json.Marshal(creds)
		if err != nil {
			return err
		}
		enc, scheme, err := s.Secrets.Seal(string(raw))
		if err != nil {
			return err
		}
		rec.CredentialsEnc = enc
		rec.CredentialsScheme = scheme
	}
	return s.Store.SaveSession(rec)
}

func (s *Service) decodeStoredCredentials(rec *store.SessionRecord) *Credentials {
	if rec.CredentialsEnc == "" || s.Secrets == nil {
		return nil
	}
	plain, err := s.Secrets.Open(rec.CredentialsEnc, rec.CredentialsScheme)
	if err != nil || plain == "" {
		return nil
	}
	var c Credentials
	if json.Unmarshal([]byte(plain), &c) == nil && (c.StudentID != "" || c.OpenID != "") {
		return &c
	}
	return nil
}

func (s *Service) newHTTPClient(jar http.CookieJar) *http.Client {
	return s.newHTTPClientWithTimeout(jar, 15*time.Second)
}

// newHTTPClientWithTimeout 用于需要比默认 15s 更长的请求（例如 SSO 扫码长轮询）。
func (s *Service) newHTTPClientWithTimeout(jar http.CookieJar, timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout: timeout,
		Jar:     jar,
	}
}
