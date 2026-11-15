package hdu

import (
	"bytes"
	"crypto/aes"
	"crypto/md5"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
)

// EncryptPassword applies AES-128-ECB with PKCS#7 padding and base64 encoding required by HDU CAS.
func EncryptPassword(keyB64, plain string) (string, error) {
	key, err := base64.StdEncoding.DecodeString(strings.TrimSpace(keyB64))
	if err != nil {
		return "", fmt.Errorf("invalid base64 CAS key: %w", err)
	}
	block, err := aes.NewCipher(key)
	if err != nil {
		return "", fmt.Errorf("invalid AES key size: %w", err)
	}
	bs := block.BlockSize()
	pad := bs - (len(plain) % bs)
	padded := append([]byte(plain), bytes.Repeat([]byte{byte(pad)}, pad)...)
	out := make([]byte, len(padded))
	for off := 0; off < len(padded); off += bs {
		block.Encrypt(out[off:off+bs], padded[off:off+bs])
	}
	return base64.StdEncoding.EncodeToString(out), nil
}

// ExtractOpenID pulls the openid token from a WeChat startup URL or raw token string.
func ExtractOpenID(raw string) (string, error) {
	trimmed := strings.TrimSpace(raw)
	if trimmed == "" {
		return "", errors.New("OpenID 不能为空")
	}
	if idx := strings.Index(trimmed, "/startUp/openid/"); idx >= 0 {
		rest := trimmed[idx+len("/startUp/openid/"):]
		for i, ch := range rest {
			if ch == '/' || ch == '?' || ch == '#' {
				rest = rest[:i]
				break
			}
		}
		trimmed = strings.TrimSpace(rest)
	}
	if len(trimmed) < 6 {
		return "", errors.New("无法识别有效的 OpenID")
	}
	for _, ch := range trimmed {
		if !(ch >= 'a' && ch <= 'z' || ch >= 'A' && ch <= 'Z' || ch >= '0' && ch <= '9' || ch == '_' || ch == '-') {
			return "", errors.New("无法识别有效的 OpenID")
		}
	}
	return trimmed, nil
}

// ApiToken computes the signature expected in the Api-Token header for bookSeats.
func ApiToken(seatID, uid string, beginTime, duration, apiTime int64) string {
	src := fmt.Sprintf(
		"post&/Seat/Index/bookSeats?LAB_JSON=1&api_time%d&beginTime%d&duration%d&is_recommend0&seatBookers[0]%s&seats[0]%s",
		apiTime, beginTime, duration, uid, seatID,
	)
	sum := md5.Sum([]byte(src))
	hexStr := hex.EncodeToString(sum[:])
	return base64.StdEncoding.EncodeToString([]byte(hexStr))
}
