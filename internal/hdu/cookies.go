package hdu

import (
	"encoding/json"
	"net/http"
	"net/url"
	"sort"
	"strings"
	"sync"
	"time"
)

// StoredCookie matches the serialized cookie schema saved in the SQLite session table.
type StoredCookie struct {
	Name     string `json:"name"`
	Value    string `json:"value"`
	Domain   string `json:"domain"`
	Path     string `json:"path"`
	Expires  *int64 `json:"expires,omitempty"`
	Secure   bool   `json:"secure"`
	HTTPOnly bool   `json:"httpOnly"`
}

// CookieJar is a thread-safe http.CookieJar that supports atomic snapshots and JSON persistence.
type CookieJar struct {
	mu      sync.Mutex
	cookies []StoredCookie
}

func NewCookieJar() *CookieJar {
	return &CookieJar{}
}

func (j *CookieJar) SetCookies(u *url.URL, cookies []*http.Cookie) {
	if u == nil || len(cookies) == 0 {
		return
	}
	host := strings.ToLower(u.Hostname())
	now := time.Now().Unix()

	j.mu.Lock()
	defer j.mu.Unlock()

	for _, c := range cookies {
		if c.Name == "" {
			continue
		}
		domain := strings.ToLower(strings.TrimSpace(c.Domain))
		if domain == "" {
			domain = host
		} else {
			domainHost := strings.TrimPrefix(domain, ".")
			if host != domainHost && !strings.HasSuffix(host, "."+domainHost) {
				continue
			}
		}
		path := c.Path
		if path == "" || !strings.HasPrefix(path, "/") {
			path = "/"
		}
		var expires *int64
		expired := c.MaxAge < 0
		if c.MaxAge > 0 {
			exp := now + int64(c.MaxAge)
			expires = &exp
		} else if !c.Expires.IsZero() {
			exp := c.Expires.Unix()
			if exp <= now {
				expired = true
			}
			expires = &exp
		}
		j.removeLocked(c.Name, domain, path)
		if expired || c.Value == "" {
			continue
		}
		j.cookies = append(j.cookies, StoredCookie{
			Name:     c.Name,
			Value:    c.Value,
			Domain:   domain,
			Path:     path,
			Expires:  expires,
			Secure:   c.Secure,
			HTTPOnly: c.HttpOnly,
		})
	}
}

func (j *CookieJar) Cookies(u *url.URL) []*http.Cookie {
	if u == nil {
		return nil
	}
	host := strings.ToLower(u.Hostname())
	reqPath := u.Path
	if reqPath == "" {
		reqPath = "/"
	}
	isHTTPS := strings.EqualFold(u.Scheme, "https")
	now := time.Now().Unix()

	j.mu.Lock()
	defer j.mu.Unlock()

	var matched []StoredCookie
	for _, c := range j.cookies {
		if c.Expires != nil && *c.Expires <= now {
			continue
		}
		if c.Secure && !isHTTPS {
			continue
		}
		if !domainMatches(host, c.Domain) || !pathMatches(reqPath, c.Path) {
			continue
		}
		matched = append(matched, c)
	}
	sort.SliceStable(matched, func(a, b int) bool {
		return len(matched[a].Path) > len(matched[b].Path)
	})
	out := make([]*http.Cookie, 0, len(matched))
	for _, c := range matched {
		out = append(out, &http.Cookie{Name: c.Name, Value: c.Value})
	}
	return out
}

func (j *CookieJar) All() []StoredCookie {
	j.mu.Lock()
	defer j.mu.Unlock()
	out := make([]StoredCookie, len(j.cookies))
	copy(out, j.cookies)
	return out
}

func (j *CookieJar) SetAll(cookies []StoredCookie) {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cookies = make([]StoredCookie, len(cookies))
	copy(j.cookies, cookies)
}

func (j *CookieJar) Clear() {
	j.mu.Lock()
	defer j.mu.Unlock()
	j.cookies = nil
}

func (j *CookieJar) ExportJSON() string {
	b, err := json.Marshal(j.All())
	if err != nil {
		return "[]"
	}
	return string(b)
}

func (j *CookieJar) ImportJSON(raw string) error {
	if strings.TrimSpace(raw) == "" {
		j.Clear()
		return nil
	}
	var cookies []StoredCookie
	if err := json.Unmarshal([]byte(raw), &cookies); err != nil {
		return err
	}
	j.SetAll(cookies)
	return nil
}

func (j *CookieJar) HeaderFor(rawURL string) string {
	u, err := url.Parse(rawURL)
	if err != nil {
		return ""
	}
	parts := make([]string, 0)
	for _, c := range j.Cookies(u) {
		parts = append(parts, c.Name+"="+c.Value)
	}
	return strings.Join(parts, "; ")
}

func (j *CookieJar) removeLocked(name, domain, path string) {
	kept := j.cookies[:0]
	for _, c := range j.cookies {
		if c.Name == name && c.Domain == domain && c.Path == path {
			continue
		}
		kept = append(kept, c)
	}
	j.cookies = kept
}

func domainMatches(host, domain string) bool {
	if strings.HasPrefix(domain, ".") {
		trimmed := domain[1:]
		return host == trimmed || strings.HasSuffix(host, domain)
	}
	return host == domain || strings.HasSuffix(host, "."+domain)
}

func pathMatches(reqPath, cookiePath string) bool {
	if cookiePath == "/" {
		return true
	}
	if reqPath == cookiePath {
		return true
	}
	return strings.HasPrefix(reqPath, strings.TrimRight(cookiePath, "/")+"/")
}
