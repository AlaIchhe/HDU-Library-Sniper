package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	_ "modernc.org/sqlite"

	"hdu-library-sniper/internal/core"
)

const (
	defaultAccountID = "default"
	auditRetention   = 500
)

type migration struct {
	version int
	sql     string
}

var migrations = []migration{
	{
		version: 1,
		sql: `
CREATE TABLE IF NOT EXISTS plans (
	id TEXT PRIMARY KEY,
	account_id TEXT NOT NULL DEFAULT 'default',
	name TEXT NOT NULL DEFAULT '',
	weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
	enabled INTEGER NOT NULL DEFAULT 0,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plans_account ON plans(account_id, created_at);

CREATE TABLE IF NOT EXISTS plan_slots (
	id TEXT PRIMARY KEY,
	plan_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	room_type TEXT NOT NULL,
	room_query TEXT NOT NULL,
	floor_id INTEGER NOT NULL,
	floor_name TEXT NOT NULL DEFAULT '',
	seat_num TEXT NOT NULL,
	fallback_seats TEXT NOT NULL DEFAULT '[]',
	start_hour INTEGER NOT NULL,
	duration_hours INTEGER NOT NULL,
	FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_plan_slots_plan ON plan_slots(plan_id, position);

CREATE TABLE IF NOT EXISTS sessions (
	account_id TEXT PRIMARY KEY DEFAULT 'default',
	uid TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL DEFAULT '',
	cookies TEXT NOT NULL DEFAULT '[]',
	credentials_enc TEXT NOT NULL DEFAULT '',
	credentials_scheme TEXT NOT NULL DEFAULT '',
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
	key TEXT PRIMARY KEY,
	value TEXT NOT NULL,
	updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS catalog_cache (
	key TEXT PRIMARY KEY,
	payload TEXT NOT NULL,
	fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS pending_checkins (
	booking_id TEXT PRIMARY KEY,
	begin_ms INTEGER NOT NULL,
	deadline_ms INTEGER NOT NULL,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_at_ms INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_events (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	event TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at TEXT NOT NULL
);`,
	},
}

// Store provides SQLite persistence for plans, slots, sessions, settings, catalog cache, pending check-ins, and audits.
// SQLite connection pool is serialized with MaxOpenConns(1) + busy_timeout so no coarse Go-level mutex is required.
type Store struct {
	db *sql.DB
}

func Open(path string) (*Store, error) {
	inMemory := path == ":memory:"
	if !inMemory {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			return nil, fmt.Errorf("create db dir: %w", err)
		}
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	if !inMemory {
		if _, err := db.Exec(`PRAGMA journal_mode = WAL;`); err != nil {
			_ = db.Close()
			return nil, err
		}
	}
	if _, err := db.Exec(`PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;`); err != nil {
		_ = db.Close()
		return nil, err
	}
	s := &Store{db: db}
	if err := s.migrate(); err != nil {
		_ = db.Close()
		return nil, err
	}
	return s, nil
}

func OpenMemory() (*Store, error) {
	return Open(":memory:")
}

func (s *Store) Close() error {
	return s.db.Close()
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
		version INTEGER PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return err
	}
	var current int
	if err := s.db.QueryRow(`SELECT COALESCE(MAX(version), 0) FROM schema_migrations`).Scan(&current); err != nil {
		return err
	}
	for _, m := range migrations {
		if m.version <= current {
			continue
		}
		tx, err := s.db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(m.sql); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("migration v%d: %w", m.version, err)
		}
		if _, err := tx.Exec(
			`INSERT INTO schema_migrations(version, applied_at) VALUES(?, ?)`,
			m.version, core.FormatISO(time.Now()),
		); err != nil {
			_ = tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) GetSetting(key string) (string, error) {
	var val string
	err := s.db.QueryRow(`SELECT value FROM settings WHERE key = ?`, key).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return val, err
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(
		`INSERT INTO settings(key, value, updated_at) VALUES(?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
		key, value, core.FormatISO(time.Now()),
	)
	return err
}

func (s *Store) GetCatalogCache(key string) (payload string, fetchedAt int64, ok bool, err error) {
	err = s.db.QueryRow(
		`SELECT payload, fetched_at FROM catalog_cache WHERE key = ?`, key,
	).Scan(&payload, &fetchedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return "", 0, false, nil
	}
	if err != nil {
		return "", 0, false, err
	}
	return payload, fetchedAt, true, nil
}

func (s *Store) SetCatalogCache(key, payload string, fetchedAt int64) error {
	_, err := s.db.Exec(
		`INSERT INTO catalog_cache(key, payload, fetched_at) VALUES(?, ?, ?)
		 ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at`,
		key, payload, fetchedAt,
	)
	return err
}

func (s *Store) WriteAudit(event string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	now := core.FormatISO(time.Now())
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(
		`INSERT INTO audit_events(event, payload, created_at) VALUES(?, ?, ?)`,
		event, string(raw), now,
	); err != nil {
		return err
	}
	// Keep audit_events bounded so long-running daemons never grow unbounded.
	if _, err := tx.Exec(
		`DELETE FROM audit_events WHERE id NOT IN (SELECT id FROM audit_events ORDER BY id DESC LIMIT ?)`,
		auditRetention,
	); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) ListAudit(limit int) ([]core.AuditEvent, error) {
	if limit <= 0 {
		limit = 50
	} else if limit > 200 {
		limit = 200
	}
	rows, err := s.db.Query(
		`SELECT id, event, payload, created_at FROM audit_events ORDER BY id DESC LIMIT ?`,
		limit,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	events := []core.AuditEvent{}
	for rows.Next() {
		var ev core.AuditEvent
		var raw string
		if err := rows.Scan(&ev.ID, &ev.Event, &raw, &ev.CreatedAt); err != nil {
			return nil, err
		}
		if err := json.Unmarshal([]byte(raw), &ev.Payload); err != nil || ev.Payload == nil {
			ev.Payload = map[string]any{}
		}
		events = append(events, ev)
	}
	return events, rows.Err()
}
