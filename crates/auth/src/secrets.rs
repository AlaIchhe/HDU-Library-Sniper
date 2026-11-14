use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{AeadCore, Aes256Gcm, KeyInit, Nonce};
use base64::Engine;

use crate::AuthError;

/// 凭据加密后端。没有可用后端时调用方会退回明文存储（并显式标记）。
pub trait SecretStore: Send + Sync {
    fn scheme(&self) -> &'static str;
    fn seal(&self, plaintext: &str) -> Result<String, AuthError>;
    fn open(&self, sealed: &str) -> Result<String, AuthError>;
}

/// AES-256-GCM 实现：密钥来自环境变量或系统钥匙串（Windows 凭据管理器 / macOS 登录钥匙串）。
pub struct AesSecretStore {
    cipher: Aes256Gcm,
    scheme: &'static str,
}

impl AesSecretStore {
    pub fn from_key(key: &[u8], scheme: &'static str) -> Result<Self, AuthError> {
        let cipher = Aes256Gcm::new_from_slice(key)
            .map_err(|error| AuthError::Invalid(format!("invalid secret key: {error}")))?;
        Ok(Self { cipher, scheme })
    }

    pub fn from_env() -> Option<Self> {
        let encoded = std::env::var("HDU_SNIPER_SECRET_KEY").ok()?;
        let key = base64::engine::general_purpose::STANDARD
            .decode(encoded.trim())
            .ok()?;
        if key.len() != 32 {
            tracing::warn!("HDU_SNIPER_SECRET_KEY 必须是 32 字节的 base64");
            return None;
        }
        Self::from_key(&key, "aes-gcm-env").ok()
    }

    /// Windows 用凭据管理器，macOS 用登录钥匙串；两者都通过 keyring 的 native 后端。
    #[cfg(any(windows, target_os = "macos"))]
    pub fn from_keyring() -> Option<Self> {
        let entry = keyring::Entry::new("hdu-library-sniper", "credentials-key").ok()?;
        let encoded = match entry.get_password() {
            Ok(value) => value,
            Err(keyring::Error::NoEntry) => {
                let key = Aes256Gcm::generate_key(&mut OsRng);
                let encoded = base64::engine::general_purpose::STANDARD.encode(key);
                entry.set_password(&encoded).ok()?;
                encoded
            }
            Err(error) => {
                tracing::warn!(%error, "系统钥匙串不可用");
                return None;
            }
        };
        let key = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .ok()?;
        if key.len() != 32 {
            return None;
        }
        Self::from_key(&key, "aes-gcm-keyring").ok()
    }
}

impl SecretStore for AesSecretStore {
    fn scheme(&self) -> &'static str {
        self.scheme
    }

    fn seal(&self, plaintext: &str) -> Result<String, AuthError> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|_| AuthError::Invalid("凭据加密失败".into()))?;
        let mut payload = nonce.to_vec();
        payload.extend_from_slice(&ciphertext);
        Ok(base64::engine::general_purpose::STANDARD.encode(payload))
    }

    fn open(&self, sealed: &str) -> Result<String, AuthError> {
        let payload = base64::engine::general_purpose::STANDARD
            .decode(sealed)
            .map_err(|error| AuthError::Invalid(format!("凭据密文格式错误: {error}")))?;
        if payload.len() <= 12 {
            return Err(AuthError::Invalid("凭据密文过短".into()));
        }
        let (nonce_bytes, ciphertext) = payload.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| AuthError::Invalid("凭据解密失败（密钥不匹配？）".into()))?;
        String::from_utf8(plaintext).map_err(|error| AuthError::Invalid(error.to_string()))
    }
}

/// 选择加密后端：环境变量密钥优先，其次系统钥匙串，最后退回明文。
pub fn default_store() -> Option<Box<dyn SecretStore>> {
    if let Some(store) = AesSecretStore::from_env() {
        tracing::info!("凭据使用环境变量密钥加密");
        return Some(Box::new(store));
    }
    #[cfg(any(windows, target_os = "macos"))]
    if let Some(store) = AesSecretStore::from_keyring() {
        tracing::info!("凭据使用系统钥匙串加密");
        return Some(Box::new(store));
    }
    tracing::warn!("没有可用的凭据加密后端，密码将以明文保存；可设置 HDU_SNIPER_SECRET_KEY");
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seals_and_opens() {
        let store = AesSecretStore::from_key(&[7u8; 32], "test").unwrap();
        let sealed = store.seal("secret").unwrap();
        assert_ne!(sealed, "secret");
        assert_eq!(store.open(&sealed).unwrap(), "secret");
    }

    #[test]
    fn rejects_tampered_ciphertext() {
        let store = AesSecretStore::from_key(&[7u8; 32], "test").unwrap();
        let mut sealed = store.seal("secret").unwrap();
        sealed.push('A');
        assert!(store.open(&sealed).is_err());
    }

    #[test]
    fn rejects_short_payload() {
        let store = AesSecretStore::from_key(&[7u8; 32], "test").unwrap();
        assert!(store.open("AAAA").is_err());
    }
}
