package auth

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"hdu-library-sniper/internal/core"
	"hdu-library-sniper/internal/hdu"
)

const (
	qrTTL = 90 * time.Second
	// SSO 的 /api/protected/qrlogin/scan 是长轮询：没有新状态时它会把连接挂住
	// 约 30s，然后回 {"code":408,"data":"wait"}。普通 HTTP 客户端的 15s 超时
	// 会在拿到这个 "wait" 之前就把整轮打断，所以扫码轮询必须单独给足超时。
	qrScanHold           = 30 * time.Second
	qrScanHoldSlack      = 5 * time.Second
	qrScanWaitData       = "wait"
	defaultQrStreamGrace = 5 * time.Second
	defaultQrPollTick    = 1200 * time.Millisecond
)

// errQrScanRejected 表示 SSO 明确拒绝了这次扫码会话（而非暂时没有状态）。
var errQrScanRejected = errors.New("扫码会话已失效，请刷新二维码")

type qrSession struct {
	createdAt     time.Time
	lastPolledAt  time.Time
	watchers      int
	watcherLeftAt time.Time
	status        core.QrLoginStatus
	cancel        context.CancelFunc
}

var (
	reCsrfKey   = []*regexp.Regexp{regexp.MustCompile(`Csrf-Key['"]?\s*[:=,]\s*['"]([^'"]+)['"]`)}
	reCsrfValue = []*regexp.Regexp{regexp.MustCompile(`Csrf-Value['"]?\s*[:=,]\s*['"]([^'"]+)['"]`)}
)

func (s *Service) ssoCSRFHeaders(ctx context.Context) (http.Header, string, error) {
	client := s.newHTTPClient(s.Client.Jar())
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.Endpoints.SSOLoginPage, nil)
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", hdu.UserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	referer := resp.Request.URL.String()
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	reqJS, err := http.NewRequestWithContext(ctx, http.MethodGet, s.Endpoints.SSOCsrfScript, nil)
	if err != nil {
		return nil, "", err
	}
	reqJS.Header.Set("User-Agent", hdu.UserAgent)
	reqJS.Header.Set("Referer", referer)
	respJS, err := client.Do(reqJS)
	if err != nil {
		return nil, "", err
	}
	defer respJS.Body.Close()
	jsBytes, _ := io.ReadAll(respJS.Body)
	script := string(jsBytes)

	h := http.Header{}
	h.Set("Origin", s.Endpoints.SSO)
	h.Set("Referer", referer)
	if k := firstMatch(script, reCsrfKey); k != "" {
		h.Set("Csrf-Key", k)
	}
	if v := firstMatch(script, reCsrfValue); v != "" {
		h.Set("Csrf-Value", v)
	}
	return h, referer, nil
}

func (s *Service) CreateQrLogin(ctx context.Context) (*core.QrLoginStart, error) {
	select {
	case s.qrSem <- struct{}{}:
	default:
		return nil, errors.New("当前扫码请求过多，请稍后再试")
	}
	releaseOnErr := true
	defer func() {
		if releaseOnErr {
			<-s.qrSem
		}
	}()

	headers, _, err := s.ssoCSRFHeaders(ctx)
	if err != nil {
		return nil, err
	}
	client := s.newHTTPClient(s.Client.Jar())
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	reqID, err := http.NewRequestWithContext(ctx, http.MethodGet, s.Endpoints.SSO+"/api/protected/qrlogin/loginid?"+ts, nil)
	if err != nil {
		return nil, err
	}
	reqID.Header = headers.Clone()
	reqID.Header.Set("User-Agent", hdu.UserAgent)
	respID, err := client.Do(reqID)
	if err != nil {
		return nil, err
	}
	defer respID.Body.Close()
	var idBody map[string]any
	if err := json.NewDecoder(respID.Body).Decode(&idBody); err != nil {
		return nil, errors.New("获取扫码登录会话失败")
	}
	uuid := strings.TrimSpace(core.ToString(idBody["data"]))
	if uuid == "" {
		return nil, errors.New("获取扫码登录 uuid 失败")
	}

	imgURL := fmt.Sprintf("%s/api/public/qrlogin/qrgen/%s/dingDingQr?t=%s", s.Endpoints.SSO, url.PathEscape(uuid), ts)
	reqImg, err := http.NewRequestWithContext(ctx, http.MethodGet, imgURL, nil)
	if err != nil {
		return nil, err
	}
	reqImg.Header.Set("User-Agent", hdu.UserAgent)
	reqImg.Header.Set("Referer", s.Endpoints.SSOLoginPage)
	respImg, err := client.Do(reqImg)
	if err != nil {
		return nil, err
	}
	defer respImg.Body.Close()
	if respImg.StatusCode >= 400 {
		return nil, fmt.Errorf("获取二维码图片失败（HTTP %d）", respImg.StatusCode)
	}
	pngBytes, err := io.ReadAll(respImg.Body)
	if err != nil {
		return nil, err
	}
	dataURL := "data:image/png;base64," + base64.StdEncoding.EncodeToString(pngBytes)

	loopCtx, cancel := context.WithCancel(context.Background())
	now := time.Now()
	s.mu.Lock()
	s.pruneQrSessionsLocked(now)
	s.qrSessions[uuid] = &qrSession{
		createdAt:    now,
		lastPolledAt: now,
		status:       core.QrLoginStatus{Status: "pending"},
		cancel:       cancel,
	}
	s.mu.Unlock()

	releaseOnErr = false
	s.qrWg.Add(1)
	go s.runQrScanLoop(loopCtx, cancel, uuid)

	return &core.QrLoginStart{
		UUID:       uuid,
		Image:      dataURL,
		TTLSeconds: int64(qrTTL.Seconds()),
	}, nil
}

// QrStatus returns the current snapshot of a QR login session without modifying watcher state.
func (s *Service) QrStatus(uuid string) core.QrLoginStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	qs, ok := s.qrSessions[uuid]
	if !ok {
		return core.QrLoginStatus{Status: "error", Message: "扫码会话不存在或已取消"}
	}
	return qs.status
}

func (s *Service) PollQrLogin(uuid string) core.QrLoginStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	qs, ok := s.qrSessions[uuid]
	if !ok {
		return core.QrLoginStatus{Status: "error", Message: "扫码会话不存在或已取消"}
	}
	qs.lastPolledAt = time.Now()
	return qs.status
}

// BeginQrWatch tracks an active SSE subscriber for uuid so disconnected browser tabs free the QR slot.
func (s *Service) BeginQrWatch(uuid string) func() {
	s.mu.Lock()
	if qs, ok := s.qrSessions[uuid]; ok {
		qs.watchers++
		qs.watcherLeftAt = time.Time{}
	}
	s.mu.Unlock()

	var once sync.Once
	return func() {
		once.Do(func() {
			s.mu.Lock()
			if qs, ok := s.qrSessions[uuid]; ok {
				if qs.watchers > 0 {
					qs.watchers--
				}
				if qs.watchers == 0 {
					qs.watcherLeftAt = time.Now()
				}
			}
			s.mu.Unlock()
		})
	}
}

func (s *Service) CancelQrLogin(uuid string) bool {
	s.mu.Lock()
	qs, ok := s.qrSessions[uuid]
	var notify bool
	if ok {
		notify = qs.status.Status == "pending"
		delete(s.qrSessions, uuid)
	}
	s.mu.Unlock()
	if ok {
		if qs.cancel != nil {
			qs.cancel()
		}
		if notify {
			s.notifyQr(uuid, core.QrLoginStatus{Status: "error", Message: "扫码会话已取消"})
		}
	}
	return ok
}

func (s *Service) pruneQrSessionsLocked(now time.Time) {
	for id, qs := range s.qrSessions {
		if now.Sub(qs.createdAt) > 5*time.Minute {
			if qs.cancel != nil {
				qs.cancel()
			}
			delete(s.qrSessions, id)
		}
	}
}

func (s *Service) runQrScanLoop(ctx context.Context, cancel context.CancelFunc, uuid string) {
	defer func() {
		if cancel != nil {
			cancel()
		}
		<-s.qrSem
		s.qrWg.Done()
	}()
	streamGrace := s.qrStreamGrace
	if streamGrace <= 0 {
		streamGrace = defaultQrStreamGrace
	}
	pollTick := s.qrPollTick
	if pollTick <= 0 {
		pollTick = defaultQrPollTick
	}
	deadline := time.Now().Add(qrTTL)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		qs, ok := s.qrSessions[uuid]
		var abandoned bool
		if ok && qs.watchers == 0 && !qs.watcherLeftAt.IsZero() && time.Since(qs.watcherLeftAt) > streamGrace {
			abandoned = true
			delete(s.qrSessions, uuid)
		}
		s.mu.Unlock()
		if !ok || abandoned {
			return
		}

		token, err := s.pollQrRoundForToken(ctx, uuid)
		if ctx.Err() != nil {
			return
		}
		if err != nil {
			if errors.Is(err, errQrScanRejected) {
				s.setQrStatus(uuid, core.QrLoginStatus{Status: "error", Message: err.Error()})
				return
			}
			// 单轮超时/网络抖动不该让整张码作废：SSO 的长轮询本来就会挂住几十秒，
			// 一轮没拿到状态就继续挂下一轮，直到 qrTTL 到期。
			select {
			case <-ctx.Done():
				return
			case <-time.After(pollTick):
			}
			continue
		}
		if token != "" {
			if err := s.completeQrLogin(ctx, token); err != nil {
				s.setQrStatus(uuid, core.QrLoginStatus{Status: "error", Message: err.Error()})
			} else {
				sess := s.Status()
				s.setQrStatus(uuid, core.QrLoginStatus{Status: "success", Session: &sess})
			}
			return
		}

		select {
		case <-ctx.Done():
			return
		case <-time.After(pollTick):
		}
	}
	s.setQrStatus(uuid, core.QrLoginStatus{Status: "expired", Message: "二维码已过期"})
}

func (s *Service) setQrStatus(uuid string, st core.QrLoginStatus) {
	s.mu.Lock()
	qs, ok := s.qrSessions[uuid]
	if ok {
		qs.status = st
	}
	s.mu.Unlock()
	if ok {
		s.notifyQr(uuid, st)
	}
}

func (s *Service) pollQrRoundForToken(ctx context.Context, uuid string) (string, error) {
	// 每一轮都刷新 CSRF，和 SSO 前端的做法一致；用父 ctx 做页面的取用。
	headers, _, err := s.ssoCSRFHeaders(ctx)
	if err != nil {
		return "", err
	}

	// 长轮询单独计时：普通客户端 15s 超时会在 SSO 回 "wait" 之前把它掐断。
	roundCtx, cancel := context.WithTimeout(ctx, qrScanHold+qrScanHoldSlack)
	defer cancel()

	client := s.newHTTPClientWithTimeout(s.Client.Jar(), qrScanHold+qrScanHoldSlack)
	ts := strconv.FormatInt(time.Now().UnixMilli(), 10)
	scanURL := fmt.Sprintf("%s/api/protected/qrlogin/scan/%s?%s", s.Endpoints.SSO, url.PathEscape(uuid), ts)
	req, err := http.NewRequestWithContext(roundCtx, http.MethodGet, scanURL, nil)
	if err != nil {
		return "", err
	}
	req.Header = headers
	req.Header.Set("User-Agent", hdu.UserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 && resp.StatusCode != http.StatusRequestTimeout {
		return "", errQrScanRejected
	}
	var body map[string]any
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return "", err
	}
	return classifyQrScanRound(body)
}

// classifyQrScanRound 解释一轮长轮询的返回：拿到 token 就是成功，SSO 回
// "wait"（码还没被扫）或 408 表示这一轮没有新状态，需要继续挂下一轮；
// 401/403 一类才是真失败。空白 data 也按“还没结果”处理，不能当成失败。
func classifyQrScanRound(body map[string]any) (string, error) {
	data := strings.TrimSpace(core.ToString(body["data"]))
	if data == qrScanWaitData {
		return "", nil
	}
	if data != "" {
		return data, nil
	}
	if code := core.ToInt64(body["code"]); code == http.StatusUnauthorized || code == http.StatusForbidden {
		return "", errQrScanRejected
	}
	return "", nil
}

func (s *Service) completeQrLogin(ctx context.Context, token string) error {
	s.loginGate.Lock()
	defer s.loginGate.Unlock()

	form := url.Values{}
	form.Set(token, "login")
	client := s.newHTTPClient(s.Client.Jar())
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.Endpoints.SSOLoginPage, strings.NewReader(form.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("User-Agent", hdu.UserAgent)
	req.Header.Set("Origin", s.Endpoints.SSO)
	req.Header.Set("Referer", s.Endpoints.SSOLoginPage)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	if !s.Client.ValidateOnce(ctx) {
		return errors.New("扫码登录成功但图书馆会话校验失败")
	}
	s.mu.Lock()
	s.authenticated = true
	s.refreshing = false
	s.lastError = ""
	s.creds = &Credentials{}
	s.mu.Unlock()
	if err := s.persistSession(); err != nil {
		return err
	}
	s.notifySession()
	return nil
}
