//! 馆方接口封装：HTTP 客户端、Cookie、房间/座位/预约/签到。

mod auth;
mod cookies;
mod library;

pub use auth::{
    encrypt_password, extract_openid, LIBRARY_BASE, LOGIN_ENTRY, OPENID_USER_AGENT, SSO_BASE,
    SSO_CSRF_KEY, SSO_CSRF_VALUE, USER_AGENT,
};
pub use cookies::{parse_set_cookie, CookieJar, StoredCookie};
pub use library::{
    Action, AuthLostHandler, AuthenticationExpiredError, BookingRange, HduError, HduLibraryError,
    LibraryClient, RefreshHandler, RequestTimeoutError, RoomType,
};

pub const BASE_URL: &str = "https://hdu.huitu.zhishulib.com";
