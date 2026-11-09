use super::*;

const SCHEMA: &str = r#"
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
  );
"#;

/// 当前 schema 版本。以后加字段时递增，并在 migrate 里按版本执行 ALTER。
const SCHEMA_VERSION: i64 = 2;

fn schema_version(conn: &Connection) -> Result<i64> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key = 'schema_version'",
            [],
            |row| row.get(0),
        )
        .optional()?;
    Ok(stored.and_then(|value| value.parse().ok()).unwrap_or(0))
}

pub(crate) fn migrate(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    if schema_version(conn)? >= SCHEMA_VERSION {
        return Ok(());
    }
    // v2：会话表补齐列（旧库没有版本号，ensure_column 幂等，直接跑一遍）
    for (table, column, definition) in [
        ("plans", "kind", "TEXT NOT NULL DEFAULT 'single'"),
        ("plans", "name", "TEXT"),
        ("session", "uid", "TEXT NOT NULL DEFAULT ''"),
        ("session", "name", "TEXT NOT NULL DEFAULT ''"),
        ("session", "student_id", "TEXT NOT NULL DEFAULT ''"),
        ("session", "password", "TEXT NOT NULL DEFAULT ''"),
        ("session", "openid", "TEXT NOT NULL DEFAULT ''"),
        ("session", "cookies", "TEXT NOT NULL DEFAULT '[]'"),
        ("session", "updated_at", "TEXT NOT NULL DEFAULT ''"),
        ("session", "credentials_enc", "TEXT NOT NULL DEFAULT ''"),
        ("session", "credentials_scheme", "TEXT NOT NULL DEFAULT ''"),
    ] {
        ensure_column(conn, table, column, definition)?;
    }
    conn.execute(
        "INSERT INTO meta(key, value) VALUES('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
}

fn ensure_column(conn: &Connection, table: &str, column: &str, definition: &str) -> Result<()> {
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(());
        }
    }
    conn.execute(
        &format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"),
        [],
    )?;
    Ok(())
}
