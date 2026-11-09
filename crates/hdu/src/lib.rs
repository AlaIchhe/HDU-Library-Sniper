mod auth;
mod cookies;
mod library;

pub use auth::{encrypt_password, extract_openid, OPENID_USER_AGENT, USER_AGENT};
pub use cookies::{parse_set_cookie, CookieJar, StoredCookie};
pub use library::{
    Action, AuthenticationExpiredError, BookingRange, HduError, HduLibraryError, LibraryClient,
    RequestTimeoutError, RoomType,
};

pub const BASE_URL: &str = "https://hdu.huitu.zhishulib.com";
