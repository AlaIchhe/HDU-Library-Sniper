package store

import (
	"database/sql"
	"errors"
)

// SessionRecord mirrors the encrypted session row in the sessions table (no plaintext credential columns).
type SessionRecord struct {
	UID               string `json:"uid"`
	Name              string `json:"name"`
	Cookies           string `json:"cookies"`
	CredentialsEnc    string `json:"credentialsEnc"`
	CredentialsScheme string `json:"credentialsScheme"`
	UpdatedAt         string `json:"updatedAt"`
}

func (s *Store) LoadSession() (*SessionRecord, error) {
	var rec SessionRecord
	err := s.db.QueryRow(
		`SELECT uid, name, cookies, credentials_enc, credentials_scheme, updated_at
		 FROM sessions WHERE account_id = ?`,
		defaultAccountID,
	).Scan(
		&rec.UID, &rec.Name, &rec.Cookies, &rec.CredentialsEnc, &rec.CredentialsScheme, &rec.UpdatedAt,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &rec, nil
}

func (s *Store) SaveSession(rec *SessionRecord) error {
	cookies := rec.Cookies
	if cookies == "" {
		cookies = "[]"
	}
	_, err := s.db.Exec(
		`INSERT INTO sessions (account_id, uid, name, cookies, credentials_enc, credentials_scheme, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(account_id) DO UPDATE SET
			uid = excluded.uid,
			name = excluded.name,
			cookies = excluded.cookies,
			credentials_enc = excluded.credentials_enc,
			credentials_scheme = excluded.credentials_scheme,
			updated_at = excluded.updated_at`,
		defaultAccountID, rec.UID, rec.Name, cookies, rec.CredentialsEnc, rec.CredentialsScheme, rec.UpdatedAt,
	)
	return err
}

func (s *Store) ClearSession() error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE account_id = ?`, defaultAccountID)
	return err
}
