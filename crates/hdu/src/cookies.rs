use chrono::DateTime;
use reqwest::header::{HeaderMap, SET_COOKIE};
use serde::{Deserialize, Serialize};
use url::Url;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredCookie {
    pub name: String,
    pub value: String,
    pub domain: String,
    pub path: String,
    pub expires_at: Option<i64>,
    pub secure: bool,
    pub http_only: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct CookieJar {
    cookies: Vec<StoredCookie>,
}

fn parse_expires(value: &str) -> Option<i64> {
    DateTime::parse_from_rfc2822(value)
        .ok()
        .map(|date| date.timestamp_millis())
}

pub fn parse_set_cookie(header: &str, request_url: &str) -> Option<StoredCookie> {
    let url = Url::parse(request_url).ok()?;
    let mut parts = header.split(';').map(str::trim);
    let name_value = parts.next()?;
    let (name, value) = name_value.split_once('=')?;
    if name.is_empty() {
        return None;
    }
    let mut cookie = StoredCookie {
        name: name.to_string(),
        value: value.to_string(),
        domain: url.host_str()?.to_ascii_lowercase(),
        path: "/".to_string(),
        expires_at: None,
        secure: false,
        http_only: false,
    };
    let now = chrono::Utc::now().timestamp_millis();
    for attribute in parts {
        let (raw_key, raw_value) = attribute.split_once('=').unwrap_or((attribute, ""));
        match raw_key.trim().to_ascii_lowercase().as_str() {
            "domain" if !raw_value.is_empty() => {
                cookie.domain = raw_value
                    .trim()
                    .trim_start_matches('.')
                    .to_ascii_lowercase();
            }
            "path" if !raw_value.is_empty() => cookie.path = raw_value.trim().to_string(),
            "expires" => {
                if let Some(expiry) = parse_expires(raw_value) {
                    cookie.expires_at = Some(expiry);
                }
            }
            "max-age" => {
                if let Ok(seconds) = raw_value.trim().parse::<i64>() {
                    cookie.expires_at = Some(now + seconds * 1000);
                }
            }
            "secure" => cookie.secure = true,
            "httponly" => cookie.http_only = true,
            _ => {}
        }
    }
    Some(cookie)
}

impl CookieJar {
    pub fn new(cookies: Vec<StoredCookie>) -> Self {
        Self { cookies }
    }

    pub fn all(&self) -> Vec<StoredCookie> {
        let now = chrono::Utc::now().timestamp_millis();
        self.cookies
            .iter()
            .filter(|cookie| cookie.expires_at.is_none_or(|expiry| expiry > now))
            .cloned()
            .collect()
    }

    pub fn header_for(&self, request_url: &str) -> String {
        let Ok(url) = Url::parse(request_url) else {
            return String::new();
        };
        let host = url.host_str().unwrap_or_default();
        self.all()
            .into_iter()
            .filter(|cookie| {
                (host == cookie.domain || host.ends_with(&format!(".{}", cookie.domain)))
                    && url.path().starts_with(&cookie.path)
                    && (!cookie.secure || url.scheme() == "https")
            })
            .map(|cookie| format!("{}={}", cookie.name, cookie.value))
            .collect::<Vec<_>>()
            .join("; ")
    }

    pub fn clear(&mut self) {
        self.cookies.clear();
    }

    pub fn replace_all(&mut self, cookies: Vec<StoredCookie>) {
        self.cookies = cookies;
    }

    pub fn merge_headers(&mut self, headers: &HeaderMap, request_url: &str) -> bool {
        let values: Vec<String> = headers
            .get_all(SET_COOKIE)
            .iter()
            .filter_map(|value| value.to_str().ok().map(str::to_string))
            .collect();
        let now = chrono::Utc::now().timestamp_millis();
        let mut changed = false;
        for header in values {
            let Some(cookie) = parse_set_cookie(&header, request_url) else {
                continue;
            };
            self.cookies.retain(|existing| {
                !(existing.name == cookie.name
                    && existing.domain == cookie.domain
                    && existing.path == cookie.path)
            });
            if !cookie.value.is_empty() && cookie.expires_at.is_none_or(|expiry| expiry > now) {
                self.cookies.push(cookie);
            }
            changed = true;
        }
        changed
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_and_matches_cookies() {
        let cookie = parse_set_cookie(
            "sid=abc; Domain=.example.com; Path=/api; Max-Age=3600; Secure; HttpOnly",
            "https://example.com/login",
        )
        .unwrap();
        assert_eq!(cookie.name, "sid");
        assert_eq!(cookie.value, "abc");
        assert_eq!(cookie.domain, "example.com");
        assert_eq!(cookie.path, "/api");
        assert!(cookie.secure);
        assert!(cookie.http_only);
        assert!(cookie.expires_at.is_some());

        let mut jar = CookieJar::default();
        jar.replace_all(vec![cookie]);
        assert_eq!(
            jar.header_for("https://sub.example.com/api/seats"),
            "sid=abc"
        );
        assert_eq!(jar.header_for("http://sub.example.com/api/seats"), "");
        assert_eq!(jar.header_for("https://sub.example.com/other"), "");
    }

    #[test]
    fn merge_replaces_and_deletes_cookies() {
        let mut jar = CookieJar::default();
        let mut first = HeaderMap::new();
        first.append(SET_COOKIE, "a=1; Path=/".parse().unwrap());
        assert!(jar.merge_headers(&first, "https://example.com/"));
        assert_eq!(jar.header_for("https://example.com/x"), "a=1");

        let mut second = HeaderMap::new();
        second.append(SET_COOKIE, "a=; Max-Age=0; Path=/".parse().unwrap());
        assert!(jar.merge_headers(&second, "https://example.com/"));
        assert_eq!(jar.header_for("https://example.com/x"), "");
    }
}
