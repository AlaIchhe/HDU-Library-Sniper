package store

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	_ "modernc.org/sqlite"

	"hdu-library-sniper/internal/core"
)

const schemaVersion = 2

const baseSchema = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS plans (
	id TEXT PRIMARY KEY,
	kind TEXT NOT NULL DEFAULT 'single',
	name TEXT,
	room_type TEXT NOT NULL,
	room_query TEXT NOT NULL,
	floor_id INTEGER NOT NULL,
	floor_name TEXT NOT NULL DEFAULT '',
	seat_num TEXT NOT NULL,
	fallback_seats TEXT NOT NULL DEFAULT '[]',
	start_hour INTEGER NOT NULL,
	duration_hours INTEGER NOT NULL,
	weekdays TEXT NOT NULL DEFAULT '[1,2,3,4,5,6,7]',
	enabled INTEGER NOT NULL DEFAULT 1,
	created_at TEXT NOT NULL,
	updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS session (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	uid TEXT NOT NULL DEFAULT '',
	name TEXT NOT NULL DEFAULT '',
	student_id TEXT NOT NULL DEFAULT '',
	password TEXT NOT NULL DEFAULT '',
	openid TEXT NOT NULL DEFAULT '',
	cookies TEXT NOT NULL DEFAULT '[]',
	updated_at TEXT NOT NULL,
	credentials_enc TEXT NOT NULL DEFAULT '',
	credentials_scheme TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS audit (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	event TEXT NOT NULL,
	payload TEXT NOT NULL,
	created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS group_members (
	group_id TEXT NOT NULL,
	plan_id TEXT NOT NULL,
	position INTEGER NOT NULL,
	PRIMARY KEY (group_id, plan_id),
	FOREIGN KEY (group_id) REFERENCES plans(id) ON DELETE CASCADE,
	FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE CASCADE
);`

// Store provides thread-safe SQLite persistence for plans, groups, sessions, meta, and audit logs.
type Store struct {
	mu      sync.Mutex
	db      *sql.DB
	onAudit func(event string, payload map[string]any)
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

// SetOnAudit registers a hook called whenever a new audit event is written.
func (s *Store) SetOnAudit(fn func(event string, payload map[string]any)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.onAudit = fn
}

func (s *Store) migrate() error {
	if _, err := s.db.Exec(baseSchema); err != nil {
		return err
	}
	var verStr string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = 'schema_version'`).Scan(&verStr)
	if err == nil {
		if ver, convErr := strconv.Atoi(verStr); convErr == nil && ver >= schemaVersion {
			return nil
		}
	} else if !errors.Is(err, sql.ErrNoRows) {
		return err
	}

	cols := [][3]string{
		{"plans", "kind", "TEXT NOT NULL DEFAULT 'single'"},
		{"plans", "name", "TEXT"},
		{"session", "uid", "TEXT NOT NULL DEFAULT ''"},
		{"session", "name", "TEXT NOT NULL DEFAULT ''"},
		{"session", "student_id", "TEXT NOT NULL DEFAULT ''"},
		{"session", "password", "TEXT NOT NULL DEFAULT ''"},
		{"session", "openid", "TEXT NOT NULL DEFAULT ''"},
		{"session", "cookies", "TEXT NOT NULL DEFAULT '[]'"},
		{"session", "updated_at", "TEXT NOT NULL DEFAULT ''"},
		{"session", "credentials_enc", "TEXT NOT NULL DEFAULT ''"},
		{"session", "credentials_scheme", "TEXT NOT NULL DEFAULT ''"},
	}
	for _, c := range cols {
		if err := s.ensureColumn(c[0], c[1], c[2]); err != nil {
			return err
		}
	}
	_, err = s.db.Exec(
		`INSERT INTO meta(key, value) VALUES('schema_version', ?)
		 ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		strconv.Itoa(schemaVersion),
	)
	return err
}

func (s *Store) ensureColumn(table, column, def string) error {
	rows, err := s.db.Query(fmt.Sprintf(`PRAGMA table_info(%s)`, table))
	if err != nil {
		return err
	}
	defer rows.Close()
	for rows.Next() {
		var cid int
		var name, typ string
		var notNull, pk int
		var dflt sql.NullString
		if err := rows.Scan(&cid, &name, &typ, &notNull, &dflt, &pk); err != nil {
			return err
		}
		if name == column {
			return nil
		}
	}
	if err := rows.Err(); err != nil {
		return err
	}
	_, err = s.db.Exec(fmt.Sprintf(`ALTER TABLE %s ADD COLUMN %s %s`, table, column, def))
	return err
}

func (s *Store) GetMeta(key string) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var val string
	err := s.db.QueryRow(`SELECT value FROM meta WHERE key = ?`, key).Scan(&val)
	if errors.Is(err, sql.ErrNoRows) {
		return "", nil
	}
	return val, err
}

func (s *Store) SetMeta(key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err := s.db.Exec(
		`INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
		key, value,
	)
	return err
}

func (s *Store) WriteAudit(event string, payload any) error {
	raw, err := json.Marshal(payload)
	if err != nil {
		return err
	}
	now := core.FormatISO(time.Now())
	s.mu.Lock()
	_, err = s.db.Exec(
		`INSERT INTO audit(event, payload, created_at) VALUES(?, ?, ?)`,
		event, string(raw), now,
	)
	hook := s.onAudit
	s.mu.Unlock()
	if err == nil && hook != nil {
		var m map[string]any
		_ = json.Unmarshal(raw, &m)
		go hook(event, m)
	}
	return err
}

func (s *Store) ListAudit(limit int) ([]core.AuditEvent, error) {
	if limit <= 0 {
		limit = 50
	} else if limit > 200 {
		limit = 200
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(
		`SELECT id, event, payload, created_at FROM audit ORDER BY id DESC LIMIT ?`,
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
