package auth

import (
	"context"
	"errors"
	"fmt"
	"html"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"

	"hdu-library-sniper/internal/hdu"
)

type loginForm struct {
	key       string
	execution string
	actionURL string
}

var (
	reCroypto = []*regexp.Regexp{
		regexp.MustCompile(`id=["']login-croypto["'][^>]*>([^<]+)<`),
		regexp.MustCompile(`id=["']login-croypto["'][^>]*value=["']([^"']+)["']`),
	}
	reFlowkey = []*regexp.Regexp{
		regexp.MustCompile(`id=["']login-page-flowkey["'][^>]*>([^<]+)<`),
		regexp.MustCompile(`id=["']login-page-flowkey["'][^>]*value=["']([^"']+)["']`),
		regexp.MustCompile(`name=["']execution["'][^>]*value=["']([^"']+)["']`),
	}
	reFormAction = regexp.MustCompile(`id=["']normalLoginForm["'][^>]*action=["']([^"']+)["']`)
)

func firstMatch(src string, res []*regexp.Regexp) string {
	for _, re := range res {
		if m := re.FindStringSubmatch(src); len(m) > 1 {
			if val := strings.TrimSpace(html.UnescapeString(m[1])); val != "" {
				return val
			}
		}
	}
	return ""
}

func (s *Service) fetchLoginForm(ctx context.Context, jar *hdu.CookieJar) (*loginForm, error) {
	client := s.newHTTPClient(jar)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.Endpoints.Library+hdu.LoginEntry, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", hdu.UserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("无法访问统一身份认证页面: %w", err)
	}
	defer resp.Body.Close()

	bodyBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	page := string(bodyBytes)
	key := firstMatch(page, reCroypto)
	if key == "" {
		return nil, errors.New("SSO 页面缺少登录参数")
	}
	execution := firstMatch(page, reFlowkey)
	if execution == "" {
		return nil, errors.New("SSO 页面缺少登录流程参数")
	}
	action := "/login"
	if m := reFormAction.FindStringSubmatch(page); len(m) > 1 && strings.TrimSpace(m[1]) != "" {
		action = strings.TrimSpace(html.UnescapeString(m[1]))
	}
	actionURL, err := resp.Request.URL.Parse(action)
	if err != nil {
		return nil, err
	}
	return &loginForm{key: key, execution: execution, actionURL: actionURL.String()}, nil
}

func (s *Service) postLoginForm(ctx context.Context, jar *hdu.CookieJar, form *loginForm, studentID, password string) (*http.Response, string, error) {
	encPass, err := hdu.EncryptPassword(form.key, password)
	if err != nil {
		return nil, "", err
	}
	encCaptcha, err := hdu.EncryptPassword(form.key, "{}")
	if err != nil {
		return nil, "", err
	}
	vals := url.Values{}
	vals.Set("username", studentID)
	vals.Set("type", "UsernamePassword")
	vals.Set("_eventId", "submit")
	vals.Set("execution", form.execution)
	vals.Set("croypto", form.key)
	vals.Set("password", encPass)
	vals.Set("captcha_payload", encCaptcha)

	client := s.newHTTPClient(jar)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, form.actionURL, strings.NewReader(vals.Encode()))
	if err != nil {
		return nil, "", err
	}
	req.Header.Set("User-Agent", hdu.UserAgent)
	req.Header.Set("Origin", s.Endpoints.SSO)
	req.Header.Set("Referer", form.actionURL)
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")

	resp, err := client.Do(req)
	if err != nil {
		return nil, "", err
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, string(b), nil
}

func (s *Service) loginPasswordInner(ctx context.Context, studentID, password string) (LoginResult, error) {
	for attempt := 0; attempt < 2; attempt++ {
		jar := hdu.NewCookieJar()
		form, err := s.fetchLoginForm(ctx, jar)
		if err != nil {
			return LoginResult{}, err
		}
		resp, body, err := s.postLoginForm(ctx, jar, form, studentID, password)
		if err != nil {
			return LoginResult{}, fmt.Errorf("SSO 登录请求失败: %w", err)
		}
		finalURL := resp.Request.URL.String()
		if !strings.HasPrefix(finalURL, s.Endpoints.SSO) {
			return s.finishPasswordLogin(ctx, jar)
		}
		if strings.Contains(body, "login-error-msg") || attempt == 1 {
			return LoginResult{
				Success: false,
				Message: fmt.Sprintf("SSO 登录失败（HTTP %d）", resp.StatusCode),
				Session: s.Status(),
			}, nil
		}
	}
	return LoginResult{}, errors.New("SSO 登录失败")
}

func (s *Service) finishPasswordLogin(ctx context.Context, jar *hdu.CookieJar) (LoginResult, error) {
	s.Client.Jar().SetAll(jar.All())
	if !s.Client.ValidateOnce(ctx) {
		return LoginResult{
			Success: false,
			Message: "图书馆身份校验失败",
			Session: s.Status(),
		}, nil
	}
	s.mu.Lock()
	s.authenticated = true
	s.refreshing = false
	s.lastError = ""
	s.mu.Unlock()
	_ = s.persistSession()
	s.notifySession()
	return LoginResult{
		Success: true,
		Message: "登录成功",
		Session: s.Status(),
	}, nil
}

func (s *Service) LoginPassword(ctx context.Context, studentID, password string) LoginResult {
	if strings.TrimSpace(studentID) == "" || password == "" {
		return LoginResult{Success: false, Message: "请输入学号和密码", Session: s.Status()}
	}
	if wait, blocked := s.LoginBlocked(); blocked {
		return LoginResult{
			Success: false,
			Message: fmt.Sprintf("登录尝试次数过多，请等待 %d 秒后再试", wait),
			Session: s.Status(),
		}
	}

	s.mu.Lock()
	s.creds = &Credentials{StudentID: strings.TrimSpace(studentID), Password: password}
	s.mu.Unlock()

	s.loginGate.Lock()
	res, err := s.loginPasswordInner(ctx, strings.TrimSpace(studentID), password)
	s.loginGate.Unlock()

	if err != nil {
		res = LoginResult{Success: false, Message: err.Error(), Session: s.Status()}
	}
	s.noteLogin(res.Success)
	if !res.Success {
		s.mu.Lock()
		s.authenticated = false
		s.lastError = res.Message
		s.mu.Unlock()
	}
	res.Session = s.Status()
	return res
}

func (s *Service) LoginOpenID(ctx context.Context, rawOpenID string) LoginResult {
	openid, err := hdu.ExtractOpenID(rawOpenID)
	if err != nil {
		return LoginResult{Success: false, Message: err.Error(), Session: s.Status()}
	}
	s.loginGate.Lock()
	defer s.loginGate.Unlock()
	return s.loginOpenIDLocked(ctx, openid)
}

func (s *Service) loginOpenIDLocked(ctx context.Context, openid string) LoginResult {
	prevCookies := s.Client.Jar().All()
	prevUID := s.Client.UID()
	prevName := s.Client.Name()
	s.mu.Lock()
	prevCreds := s.creds
	prevAuth := s.authenticated
	s.creds = &Credentials{OpenID: openid}
	s.mu.Unlock()

	rollback := func(msg string) LoginResult {
		s.Client.Jar().SetAll(prevCookies)
		s.Client.SetIdentity(prevUID, prevName)
		s.mu.Lock()
		s.creds = prevCreds
		s.authenticated = prevAuth
		s.lastError = msg
		s.mu.Unlock()
		return LoginResult{Success: false, Message: msg, Session: s.Status()}
	}

	s.Client.Jar().Clear()
	client := s.newHTTPClient(s.Client.Jar())
	target := s.Endpoints.Library + "/content/index/startUp/openid/" + url.PathEscape(openid) + "/"
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		return rollback(err.Error())
	}
	req.Header.Set("User-Agent", hdu.OpenIDUserAgent)
	resp, err := client.Do(req)
	if err != nil {
		return rollback(fmt.Sprintf("OpenID 登录请求失败: %v", err))
	}
	_, _ = io.Copy(io.Discard, resp.Body)
	_ = resp.Body.Close()

	if !s.Client.ValidateOnce(ctx) {
		return rollback("OpenID 无效或已过期")
	}

	s.mu.Lock()
	s.authenticated = true
	s.refreshing = false
	s.lastError = ""
	s.mu.Unlock()
	_ = s.persistSession()
	s.notifySession()
	return LoginResult{Success: true, Message: "登录成功", Session: s.Status()}
}
