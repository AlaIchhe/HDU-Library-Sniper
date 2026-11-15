package auth

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
)

const (
	SchemeEnv   = "aes256gcm-env"
	SchemeFile  = "aes256gcm-file"
	SchemePlain = "plain"
)

// SecretStore seals and unseals persisted credentials using HDU_SNIPER_SECRET_KEY or a 0600 local key file.
type SecretStore struct {
	key    []byte
	scheme string
}

func OpenSecretStore(dataDir string) *SecretStore {
	if env := strings.TrimSpace(os.Getenv("HDU_SNIPER_SECRET_KEY")); env != "" {
		sum := sha256.Sum256([]byte(env))
		return &SecretStore{key: sum[:], scheme: SchemeEnv}
	}
	if dataDir != "" {
		if key, err := loadOrCreateKeyFile(filepath.Join(dataDir, ".secret.key")); err == nil {
			return &SecretStore{key: key, scheme: SchemeFile}
		}
	}
	return &SecretStore{scheme: SchemePlain}
}

func NewSecretStoreWithKey(key []byte, scheme string) *SecretStore {
	sum := sha256.Sum256(key)
	return &SecretStore{key: sum[:], scheme: scheme}
}

func loadOrCreateKeyFile(path string) ([]byte, error) {
	if raw, err := os.ReadFile(path); err == nil {
		if decoded, decErr := base64.StdEncoding.DecodeString(strings.TrimSpace(string(raw))); decErr == nil && len(decoded) == 32 {
			return decoded, nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return nil, err
	}
	key := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, key); err != nil {
		return nil, err
	}
	encoded := base64.StdEncoding.EncodeToString(key) + "\n"
	if err := os.WriteFile(path, []byte(encoded), 0o600); err != nil {
		return nil, err
	}
	return key, nil
}

func (s *SecretStore) Scheme() string {
	return s.scheme
}

func (s *SecretStore) IsEncrypted() bool {
	return len(s.key) == 32
}

func (s *SecretStore) Seal(plain string) (cipherText, scheme string, err error) {
	if !s.IsEncrypted() {
		return "", SchemePlain, nil
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", "", err
	}
	nonce := make([]byte, gcm.NonceSize())
	if _, err := io.ReadFull(rand.Reader, nonce); err != nil {
		return "", "", err
	}
	sealed := gcm.Seal(nonce, nonce, []byte(plain), nil)
	return base64.StdEncoding.EncodeToString(sealed), s.scheme, nil
}

func (s *SecretStore) Open(cipherText, scheme string) (string, error) {
	if cipherText == "" || scheme == "" || scheme == SchemePlain {
		return "", nil
	}
	if !s.IsEncrypted() {
		return "", errors.New("secret key unavailable for encrypted credentials")
	}
	raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(cipherText))
	if err != nil {
		return "", err
	}
	block, err := aes.NewCipher(s.key)
	if err != nil {
		return "", err
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		return "", err
	}
	if len(raw) < gcm.NonceSize() {
		return "", errors.New("ciphertext too short")
	}
	plain, err := gcm.Open(nil, raw[:gcm.NonceSize()], raw[gcm.NonceSize():], nil)
	if err != nil {
		return "", err
	}
	return string(plain), nil
}
