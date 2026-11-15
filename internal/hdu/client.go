package hdu

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"

	"hdu-library-sniper/internal/core"
)

const (
	LibraryBase     = "https://hdu.huitu.zhishulib.com"
	SSOBase         = "https://sso.hdu.edu.cn"
	LoginEntry      = "/User/Index/hduCASLogin"
	UserAgent       = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
	MobileUserAgent = "Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36"
	OpenIDUserAgent = "Mozilla/5.0 (Linux; Android 11; SM-G9910 wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 XWEB/4375 MMWEBSDK/20221012 Mobile Safari/537.36 MicroMessenger/8.0.30.2260(0x28001E55) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 miniProgram/wx5e72fc4ec15ca4e8"
)

type category struct {
	categoryID string
	contentID  string
}

// LibraryClient talks to hdu.huitu.zhishulib.com with strict read/write timeouts and session hooks.
type LibraryClient struct {
	baseURL   string
	jar       *CookieJar
	readHTTP  *http.Client
	writeHTTP *http.Client

	mu         sync.Mutex
	uid        string
	name       string
	categories map[string]category
	onRefresh  func(context.Context) bool
	onAuthLost func()
}

func NewClient() *LibraryClient {
	return NewClientWithBaseURL(LibraryBase)
}

func NewClientWithBaseURL(baseURL string) *LibraryClient {
	jar := NewCookieJar()
	noAuthRedirect := func(req *http.Request, via []*http.Request) error {
		if strings.Contains(req.URL.String(), LoginEntry) || strings.Contains(req.URL.Host, "sso.hdu.edu.cn") {
			return http.ErrUseLastResponse
		}
		if len(via) >= 10 {
			return http.ErrUseLastResponse
		}
		return nil
	}
	return &LibraryClient{
		baseURL: strings.TrimRight(baseURL, "/"),
		jar:     jar,
		readHTTP: &http.Client{
			Timeout:       core.ReadTimeout,
			Jar:           jar,
			CheckRedirect: noAuthRedirect,
		},
		writeHTTP: &http.Client{
			Timeout:       core.WriteTimeout,
			Jar:           jar,
			CheckRedirect: noAuthRedirect,
		},
		categories: make(map[string]category),
	}
}

func (c *LibraryClient) BaseURL() string {
	return c.baseURL
}

func (c *LibraryClient) Jar() *CookieJar {
	return c.jar
}

func (c *LibraryClient) UID() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.uid
}

func (c *LibraryClient) Name() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.name
}

func (c *LibraryClient) SetIdentity(uid, name string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.uid = uid
	c.name = name
}

func (c *LibraryClient) SetHooks(onRefresh func(context.Context) bool, onAuthLost func()) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.onRefresh = onRefresh
	c.onAuthLost = onAuthLost
}

// Validate checks /User/Center/baseInfo and attempts one session refresh if expired.
func (c *LibraryClient) Validate(ctx context.Context) bool {
	body, err := c.requestJSON(ctx, "/User/Center/baseInfo", http.MethodGet, nil, nil, false)
	if err != nil {
		return false
	}
	return c.applyBaseInfo(body)
}

// ValidateOnce checks /User/Center/baseInfo without invoking the session refresh callback.
func (c *LibraryClient) ValidateOnce(ctx context.Context) bool {
	body, err := c.requestJSONOnce(ctx, "/User/Center/baseInfo", http.MethodGet, nil, nil, false)
	if err != nil {
		return false
	}
	return c.applyBaseInfo(body)
}

func (c *LibraryClient) applyBaseInfo(body map[string]any) bool {
	data := core.AsMap(body["DATA"])
	if data == nil {
		return false
	}
	if !core.ToBool(data["is_login"]) {
		return false
	}
	uid := strings.TrimSpace(core.ToString(data["uid"]))
	if uid == "" || !allASCIIDigits(uid) {
		return false
	}
	name := strings.TrimSpace(core.GetString(data, "user_info", "name"))
	c.SetIdentity(uid, name)
	return true
}

func (c *LibraryClient) requestJSON(
	ctx context.Context,
	path string,
	method string,
	form url.Values,
	headers http.Header,
	isWrite bool,
) (map[string]any, error) {
	body, err := c.requestJSONOnce(ctx, path, method, form, headers, isWrite)
	if err == nil || !IsAuthExpired(err) {
		return body, err
	}

	c.mu.Lock()
	refresh := c.onRefresh
	authLost := c.onAuthLost
	c.mu.Unlock()

	if refresh != nil && refresh(ctx) {
		retryBody, retryErr := c.requestJSONOnce(ctx, path, method, form, headers, isWrite)
		if retryErr == nil {
			return retryBody, nil
		}
		if IsAuthExpired(retryErr) && authLost != nil {
			authLost()
		}
		return nil, retryErr
	}
	if authLost != nil {
		authLost()
	}
	return nil, err
}

func (c *LibraryClient) requestJSONOnce(
	ctx context.Context,
	path string,
	method string,
	form url.Values,
	headers http.Header,
	isWrite bool,
) (map[string]any, error) {
	var bodyReader io.Reader
	if form != nil {
		bodyReader = strings.NewReader(form.Encode())
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bodyReader)
	if err != nil {
		return nil, NetworkError(err)
	}
	req.Header.Set("User-Agent", MobileUserAgent)
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Origin", c.baseURL)
	req.Header.Set("Referer", c.baseURL+"/")
	if form != nil {
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8")
	}
	for k, vals := range headers {
		for _, v := range vals {
			req.Header.Set(k, v)
		}
	}

	httpClient := c.readHTTP
	if isWrite {
		httpClient = c.writeHTTP
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, classifyTransportError(err)
	}
	defer resp.Body.Close()

	if resp.StatusCode >= 300 && resp.StatusCode < 400 {
		loc := resp.Header.Get("Location")
		if strings.Contains(loc, LoginEntry) || strings.Contains(loc, "sso.hdu.edu.cn") {
			return nil, AuthExpired("图书馆登录状态已失效")
		}
	}
	raw, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, classifyTransportError(err)
	}
	var parsed map[string]any
	jsonErr := json.Unmarshal(raw, &parsed)
	if resp.StatusCode >= 400 {
		if jsonErr == nil && core.GetString(parsed, "ui_type") == "com.Redirect" &&
			strings.Contains(core.GetString(parsed, "href"), LoginEntry) {
			return nil, AuthExpired("图书馆登录状态已失效")
		}
		return nil, HTTPError(resp.StatusCode)
	}
	if jsonErr != nil {
		return nil, LibraryError("馆方返回了无效数据")
	}
	if core.GetString(parsed, "ui_type") == "com.Redirect" &&
		strings.Contains(core.GetString(parsed, "href"), LoginEntry) {
		return nil, AuthExpired("图书馆登录状态已失效")
	}
	return parsed, nil
}

func allASCIIDigits(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < '0' || s[i] > '9' {
			return false
		}
	}
	return len(s) > 0
}
