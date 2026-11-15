package store

import (
	"database/sql"
	"errors"
)

// SessionRecord mirrors the single persisted row (id = 1) in the session table.
type SessionRecord struct {
	UID               string `json:"uid"`
	Name              string `json:"name"`
	StudentID         string `json:"studentId"`
	Password          string `json:"password"`
	OpenID            string `json:"openid"`
	Cookies           string `json:"cookies"`
	UpdatedAt         string `json:"updatedAt"`
	CredentialsEnc    string `json:"credentialsEnc"`
	CredentialsScheme string `json:"credentialsScheme"`
}

func (s *Store) LoadSession() (*SessionRecord, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var rec SessionRecord
	err := s.db.QueryRow(
		`SELECT uid, name, student_id, password, openid, cookies, updated_at, credentials_enc, credentials_scheme
		 FROM session WHERE id = 1`,
	).Scan(
		&rec.UID, &rec.Name, &rec.StudentID, &rec.Password, &rec.OpenID,
		&rec.Cookies, &rec.UpdatedAt, &rec.CredentialsEnc, &rec.CredentialsScheme,
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
	s.mu.Lock()
	defer s.mu.Unlock()
	cookies := rec.Cookies
	if cookies == "" {
		cookies = "[]"
	}
	_, err := s.db.Exec(
		`INSERT INTO session (id, uid, name, student_id, password, openid, cookies, updated_at, credentials_enc, credentials_scheme)
		 VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
			uid=excluded.uid, name=excluded.name, student_id=excluded.student_id, password=excluded.password,
			openid=excluded.openid, cookies=excluded.cookies, updated_at=excluded.updated_at,
			credentials_enc=excluded.credentials_enc, credentials_scheme=excluded.credentials_scheme`,
		rec.UID, rec.Name, rec.StudentID, rec.Password, rec.OpenID,
		cookies, rec.UpdatedAt, rec.CredentialsEnc, rec.CredentialsScheme,
	)
	return err
}

func (s *Store) ClearSession() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.db.Exec(`DELETE FROM session`); err != nil {
		return err
	}
	_, err := s.db.Exec(`DELETE FROM meta WHERE key LIKE 'catalog:%'`)
	return err
}
