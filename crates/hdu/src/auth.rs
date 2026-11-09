use aes::cipher::{BlockEncrypt, KeyInit};
use aes::Aes128;
use base64::Engine;

pub const LIBRARY_BASE: &str = "https://hdu.huitu.zhishulib.com";
#[allow(dead_code)]
pub const LOGIN_ENTRY: &str = "https://hdu.huitu.zhishulib.com/User/Index/hduCASLogin";
pub const OPENID_USER_AGENT: &str = "Mozilla/5.0 (Linux; Android 11; SM-G9910 wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/86.0.4240.99 XWEB/4375 MMWEBSDK/20221012 Mobile Safari/537.36 MicroMessenger/8.0.30.2260(0x28001E55) WeChat/arm64 Weixin NetType/WIFI Language/zh_CN ABI/arm64 miniProgram/wx5e72fc4ec15ca4e8";
pub const USER_AGENT: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36";
#[allow(dead_code)]
pub const SSO_BASE: &str = "https://sso.hdu.edu.cn";
#[allow(dead_code)]
pub const SSO_CSRF_KEY: &str = "FzgxPikIetYDlXZM4lRG9taclVDa99lB";
#[allow(dead_code)]
pub const SSO_CSRF_VALUE: &str = "7964f321f00366a3a287a133dd307ed0";

pub fn extract_openid(input: &str) -> String {
    let value = input.trim();
    if value.is_empty() {
        return String::new();
    }
    let candidate = value
        .find("/startUp/openid/")
        .map(|index| &value[index + "/startUp/openid/".len()..])
        .unwrap_or(value);
    let candidate = candidate.split('/').next().unwrap_or_default();
    if (10..=128).contains(&candidate.len())
        && candidate
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        candidate.to_string()
    } else {
        String::new()
    }
}

/// AES-128-ECB + PKCS#7, base64 encoded, matching the SSO page's `croypto` field.
pub fn encrypt_password(key_base64: &str, password: &str) -> Result<String, String> {
    let key = base64::engine::general_purpose::STANDARD
        .decode(key_base64)
        .map_err(|error| format!("invalid key: {error}"))?;
    if key.len() != 16 {
        return Err(format!("AES-128 key must be 16 bytes, got {}", key.len()));
    }
    let cipher = Aes128::new_from_slice(&key).map_err(|error| error.to_string())?;
    let mut padded = password.as_bytes().to_vec();
    let remainder = padded.len() % 16;
    let padding = 16 - remainder;
    padded.extend(std::iter::repeat_n(padding as u8, padding));
    for chunk in padded.chunks_mut(16) {
        let block = aes::cipher::generic_array::GenericArray::from_mut_slice(chunk);
        cipher.encrypt_block(block);
    }
    Ok(base64::engine::general_purpose::STANDARD.encode(padded))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_bare_and_url_openids() {
        assert_eq!(extract_openid(" abcdefghij_123 "), "abcdefghij_123");
        assert_eq!(
            extract_openid(
                "https://hdu.huitu.zhishulib.com/content/index/startUp/openid/abcDEF_123-456/"
            ),
            "abcDEF_123-456"
        );
        assert_eq!(extract_openid("short"), "");
        assert_eq!(extract_openid("bad/space"), "");
    }

    #[test]
    fn encrypts_with_aes_ecb_pkcs7() {
        let key = "MDEyMzQ1Njc4OWFiY2RlZg=="; // base64("0123456789abcdef")
        let encrypted = encrypt_password(key, "secret").unwrap();
        assert_eq!(encrypted, "iNo+4RE7nEnpk338CYGhcw==");
    }
}
