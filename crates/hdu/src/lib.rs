mod auth;
mod cookies;
mod library;

pub use auth::{
    encrypt_password, extract_openid, LIBRARY_BASE, LOGIN_ENTRY, OPENID_USER_AGENT, SSO_BASE,
    SSO_CSRF_KEY, SSO_CSRF_VALUE, USER_AGENT,
};
pub use cookies::{parse_set_cookie, CookieJar, StoredCookie};
pub use library::{
    Action, AuthenticationExpiredError, BookingRange, HduError, HduLibraryError, LibraryClient,
    RefreshHandler, RequestTimeoutError, RoomType,
};

pub const BASE_URL: &str = "https://hdu.huitu.zhishulib.com";
