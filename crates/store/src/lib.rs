//! SQLite 存储层：方案、组合、会话、审计与 schema 迁移。

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use chrono::{SecondsFormat, Utc};
use hdu_sniper_core::{
    valid_weekdays, AuditEvent, BookingGroup, BookingPlan, PlanKind, PlanListItem, Weekday,
};
use rusqlite::{params, Connection, OptionalExtension};

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

#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("database lock poisoned")]
    Lock,
    #[error("sqlite: {0}")]
    Sqlite(#[from] rusqlite::Error),
    #[error("json: {0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Invalid(String),
}

pub type Result<T> = std::result::Result<T, StoreError>;

/// SQLite 句柄；内部用 Mutex 串行化连接。
pub struct Store {
    conn: Mutex<Connection>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionRow {
    pub uid: String,
    pub name: String,
    pub student_id: String,
    pub password: String,
    pub openid: String,
    pub cookies: String,
    pub updated_at: String,
    /// 加密后的凭据 JSON（student_id / password / openid），空表示沿用明文列。
    pub credentials_enc: String,
    /// 加密方案：keyring / aes-gcm-env / plain。
    pub credentials_scheme: String,
}

struct GroupRow {
    id: String,
    name: String,
    weekdays: Vec<Weekday>,
    enabled: bool,
    created_at: String,
    updated_at: String,
}

impl Store {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::init(Connection::open(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::init(Connection::open_in_memory()?)
    }

    fn init(conn: Connection) -> Result<Self> {
        migrate(&conn)?;
        conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;")?;
        Ok(Self {
            conn: Mutex::new(conn),
        })
    }

    fn lock(&self) -> Result<MutexGuard<'_, Connection>> {
        self.conn.lock().map_err(|_| StoreError::Lock)
    }

    pub fn list_plans(&self) -> Result<Vec<BookingPlan>> {
        let conn = self.lock()?;
        let mut stmt =
            conn.prepare("SELECT * FROM plans WHERE kind = 'single' ORDER BY created_at ASC")?;
        let rows = stmt.query_map([], row_to_plan)?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_plan(&self, id: &str) -> Result<Option<BookingPlan>> {
        let conn = self.lock()?;
        let plan = conn
            .query_row(
                "SELECT * FROM plans WHERE id = ?1 AND kind = 'single'",
                params![id],
                row_to_plan,
            )
            .optional()?;
        Ok(plan)
    }

    pub fn save_plan(&self, plan: &BookingPlan) -> Result<BookingPlan> {
        let conn = self.lock()?;
        conn.execute(
            r#"INSERT INTO plans (id, kind, room_type, room_query, floor_id, floor_name, seat_num, fallback_seats,
                start_hour, duration_hours, weekdays, enabled, created_at, updated_at)
               VALUES (?1, 'single', ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)
               ON CONFLICT(id) DO UPDATE SET kind='single', room_type=excluded.room_type, room_query=excluded.room_query,
                 floor_id=excluded.floor_id, floor_name=excluded.floor_name, seat_num=excluded.seat_num,
                 fallback_seats=excluded.fallback_seats, start_hour=excluded.start_hour,
                 duration_hours=excluded.duration_hours, weekdays=excluded.weekdays, enabled=excluded.enabled,
                 updated_at=excluded.updated_at"#,
            params![
                plan.id,
                plan.room_type,
                plan.room_query,
                plan.floor_id,
                plan.floor_name,
                plan.seat_num,
                serde_json::to_string(&plan.fallback_seats)?,
                plan.start_hour,
                plan.duration_hours,
                serde_json::to_string(&plan.weekdays)?,
                i64::from(plan.enabled),
                plan.created_at,
                plan.updated_at,
            ],
        )?;
        Ok(plan.clone())
    }

    fn list_groups(&self, conn: &Connection) -> Result<Vec<GroupRow>> {
        let mut stmt = conn.prepare(
            "SELECT id, name, weekdays, enabled, created_at, updated_at FROM plans WHERE kind = 'group' ORDER BY created_at ASC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(GroupRow {
                id: row.get(0)?,
                name: row.get(1)?,
                weekdays: parse_weekdays(row.get::<_, String>(2)?)?,
                enabled: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn get_group_members(&self, group_id: &str) -> Result<Vec<String>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT plan_id FROM group_members WHERE group_id = ?1 ORDER BY position ASC",
        )?;
        let rows = stmt.query_map(params![group_id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn list_plan_items(&self) -> Result<Vec<PlanListItem>> {
        let conn = self.lock()?;
        let singles = {
            let mut stmt =
                conn.prepare("SELECT * FROM plans WHERE kind = 'single' ORDER BY created_at ASC")?;
            let rows = stmt.query_map([], row_to_plan)?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        let by_id: std::collections::HashMap<_, _> = singles
            .iter()
            .cloned()
            .map(|plan| (plan.id.clone(), plan))
            .collect();
        let mut items: Vec<PlanListItem> = singles.into_iter().map(PlanListItem::Single).collect();
        for row in self.list_groups(&conn)? {
            let member_ids = {
                let mut stmt = conn.prepare(
                    "SELECT plan_id FROM group_members WHERE group_id = ?1 ORDER BY position ASC",
                )?;
                let rows = stmt.query_map(params![row.id], |r| r.get::<_, String>(0))?;
                rows.collect::<std::result::Result<Vec<_>, _>>()?
            };
            let members = member_ids
                .iter()
                .filter_map(|id| by_id.get(id).cloned())
                .collect::<Vec<_>>();
            items.push(PlanListItem::Group(BookingGroup {
                id: row.id,
                kind: PlanKind::Group,
                name: row.name,
                member_plan_ids: member_ids,
                members: Some(members),
                weekdays: row.weekdays,
                enabled: row.enabled,
                created_at: row.created_at,
                updated_at: row.updated_at,
            }));
        }
        Ok(items)
    }

    pub fn get_plan_item(&self, id: &str) -> Result<Option<PlanListItem>> {
        Ok(self.list_plan_items()?.into_iter().find(|item| match item {
            PlanListItem::Single(plan) => plan.id == id,
            PlanListItem::Group(group) => group.id == id,
        }))
    }

    pub fn save_group(&self, group: &BookingGroup) -> Result<()> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        tx.execute(
            r#"INSERT INTO plans (id, kind, name, room_type, room_query, floor_id, seat_num, start_hour,
                duration_hours, weekdays, enabled, created_at, updated_at)
               VALUES (?1, 'group', ?2, '', '', 0, '', 0, 0, ?3, ?4, ?5, ?6)
               ON CONFLICT(id) DO UPDATE SET kind='group', name=excluded.name, weekdays=excluded.weekdays,
                 enabled=excluded.enabled, updated_at=excluded.updated_at"#,
            params![
                group.id,
                group.name,
                serde_json::to_string(&group.weekdays)?,
                i64::from(group.enabled),
                group.created_at,
                group.updated_at,
            ],
        )?;
        tx.execute(
            "DELETE FROM group_members WHERE group_id = ?1",
            params![group.id],
        )?;
        for (position, plan_id) in group.member_plan_ids.iter().enumerate() {
            tx.execute(
                "INSERT INTO group_members(group_id, plan_id, position) VALUES(?1, ?2, ?3)",
                params![group.id, plan_id, position as i64],
            )?;
        }
        tx.commit()?;
        Ok(())
    }

    pub fn delete_group(&self, id: &str) -> Result<bool> {
        let conn = self.lock()?;
        Ok(conn.execute(
            "DELETE FROM plans WHERE id = ?1 AND kind = 'group'",
            params![id],
        )? > 0)
    }

    pub fn referenced_plan_ids(&self, id: &str) -> Result<Vec<String>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare("SELECT group_id FROM group_members WHERE plan_id = ?1")?;
        let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }

    pub fn set_only_enabled(&self, id: &str, enabled: bool) -> Result<Vec<String>> {
        let mut conn = self.lock()?;
        let tx = conn.transaction()?;
        let disabled = {
            let mut stmt = tx.prepare("SELECT id FROM plans WHERE enabled = 1 AND id <> ?1")?;
            let rows = stmt.query_map(params![id], |row| row.get::<_, String>(0))?;
            rows.collect::<std::result::Result<Vec<_>, _>>()?
        };
        if enabled {
            tx.execute("UPDATE plans SET enabled = 0 WHERE id <> ?1", params![id])?;
        }
        tx.execute(
            "UPDATE plans SET enabled = ?1 WHERE id = ?2",
            params![i64::from(enabled), id],
        )?;
        tx.commit()?;
        Ok(disabled)
    }

    pub fn delete_plan(&self, id: &str) -> Result<bool> {
        let conn = self.lock()?;
        Ok(conn.execute(
            "DELETE FROM plans WHERE id = ?1 AND kind = 'single'",
            params![id],
        )? > 0)
    }

    pub fn load_session(&self) -> Result<Option<SessionRow>> {
        let conn = self.lock()?;
        let row = conn
            .query_row(
                "SELECT uid, name, student_id, password, openid, cookies, updated_at, credentials_enc, credentials_scheme FROM session WHERE id = 1",
                [],
                |row| {
                    Ok(SessionRow {
                        uid: row.get(0)?,
                        name: row.get(1)?,
                        student_id: row.get(2)?,
                        password: row.get(3)?,
                        openid: row.get(4)?,
                        cookies: row.get(5)?,
                        updated_at: row.get(6)?,
                        credentials_enc: row.get(7)?,
                        credentials_scheme: row.get(8)?,
                    })
                },
            )
            .optional()?;
        Ok(row)
    }

    pub fn save_session(&self, session: &SessionRow) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            r#"INSERT INTO session(id, uid, name, student_id, password, openid, cookies, updated_at, credentials_enc, credentials_scheme)
               VALUES(1, ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
               ON CONFLICT(id) DO UPDATE SET uid=excluded.uid, name=excluded.name,
                 student_id=excluded.student_id, password=excluded.password,
                 openid=excluded.openid, cookies=excluded.cookies, updated_at=excluded.updated_at,
                 credentials_enc=excluded.credentials_enc, credentials_scheme=excluded.credentials_scheme"#,
            params![
                &session.uid,
                &session.name,
                &session.student_id,
                &session.password,
                &session.openid,
                &session.cookies,
                &session.updated_at,
                &session.credentials_enc,
                &session.credentials_scheme,
            ],
        )?;
        Ok(())
    }

    pub fn set_meta(&self, key: &str, value: &str) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn get_meta(&self, key: &str) -> Result<Option<String>> {
        let conn = self.lock()?;
        let value = conn
            .query_row(
                "SELECT value FROM meta WHERE key = ?1",
                params![key],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        Ok(value)
    }

    pub fn write_audit(&self, event: &str, payload: &serde_json::Value) -> Result<()> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO audit(event, payload, created_at) VALUES(?1, ?2, ?3)",
            params![
                event,
                serde_json::to_string(payload)?,
                Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true),
            ],
        )?;
        Ok(())
    }

    pub fn list_audit(&self, limit: i64) -> Result<Vec<AuditEvent>> {
        let conn = self.lock()?;
        let mut stmt = conn.prepare(
            "SELECT id, event, payload, created_at FROM audit ORDER BY created_at DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(AuditEvent {
                id: row.get(0)?,
                event: row.get(1)?,
                payload: serde_json::from_str(&row.get::<_, String>(2)?)
                    .unwrap_or_else(|_| serde_json::json!({})),
                created_at: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
    }
}

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

fn migrate(conn: &Connection) -> Result<()> {
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

fn parse_json_vec(value: String) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(&value).unwrap_or_default()
}

fn parse_weekdays(value: String) -> rusqlite::Result<Vec<Weekday>> {
    let days = serde_json::from_str::<Vec<i64>>(&value).unwrap_or_default();
    Ok(valid_weekdays(&days))
}

fn row_to_plan(row: &rusqlite::Row<'_>) -> rusqlite::Result<BookingPlan> {
    Ok(BookingPlan {
        id: row.get("id")?,
        kind: PlanKind::Single,
        room_type: row.get("room_type")?,
        room_query: row.get("room_query")?,
        floor_id: row.get("floor_id")?,
        floor_name: row
            .get::<_, Option<String>>("floor_name")?
            .unwrap_or_default(),
        seat_num: row.get("seat_num")?,
        fallback_seats: parse_json_vec(row.get("fallback_seats")?),
        start_hour: row.get("start_hour")?,
        duration_hours: row.get("duration_hours")?,
        weekdays: parse_weekdays(row.get("weekdays")?)?,
        enabled: row.get::<_, i64>("enabled")? != 0,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(id: &str, enabled: bool) -> BookingPlan {
        BookingPlan {
            id: id.into(),
            kind: PlanKind::Single,
            room_type: "自习室".into(),
            room_query: "q".into(),
            floor_id: 2,
            floor_name: "二楼".into(),
            seat_num: "101".into(),
            fallback_seats: vec!["102".into()],
            start_hour: 8,
            duration_hours: 2,
            weekdays: vec![1, 2, 3],
            enabled,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        }
    }

    #[test]
    fn stores_and_lists_plans() {
        let store = Store::open_in_memory().unwrap();
        store.save_plan(&plan("p1", true)).unwrap();
        store.save_plan(&plan("p2", false)).unwrap();
        assert_eq!(store.list_plans().unwrap().len(), 2);
        assert_eq!(store.get_plan("p1").unwrap().unwrap().seat_num, "101");
        assert_eq!(store.get_plan("missing").unwrap(), None);
    }

    #[test]
    fn stores_groups_and_members() {
        let store = Store::open_in_memory().unwrap();
        store.save_plan(&plan("p1", false)).unwrap();
        store.save_plan(&plan("p2", false)).unwrap();
        let group = BookingGroup {
            id: "g1".into(),
            kind: PlanKind::Group,
            name: "组合".into(),
            member_plan_ids: vec!["p1".into(), "p2".into()],
            members: None,
            weekdays: vec![1, 2, 3],
            enabled: false,
            created_at: "2026-01-01T00:00:00.000Z".into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
        };
        store.save_group(&group).unwrap();
        assert_eq!(store.get_group_members("g1").unwrap(), vec!["p1", "p2"]);
        assert_eq!(store.list_plan_items().unwrap().len(), 3);
        assert!(store.delete_group("g1").unwrap());
        assert_eq!(store.list_plan_items().unwrap().len(), 2);
    }

    #[test]
    fn only_one_plan_can_be_enabled() {
        let store = Store::open_in_memory().unwrap();
        store.save_plan(&plan("p1", true)).unwrap();
        store.save_plan(&plan("p2", true)).unwrap();
        let disabled = store.set_only_enabled("p1", true).unwrap();
        assert_eq!(disabled, vec!["p2"]);
        assert!(store.get_plan("p1").unwrap().unwrap().enabled);
        assert!(!store.get_plan("p2").unwrap().unwrap().enabled);
    }

    #[test]
    fn migrates_a_legacy_session_without_openid() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            r#"
            CREATE TABLE session (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                uid TEXT NOT NULL DEFAULT '',
                name TEXT NOT NULL DEFAULT '',
                student_id TEXT NOT NULL DEFAULT '',
                password TEXT NOT NULL DEFAULT '',
                cookies TEXT NOT NULL DEFAULT '[]',
                updated_at TEXT NOT NULL
            );
            INSERT INTO session(id, uid, name, student_id, password, cookies, updated_at)
            VALUES(1, '304174', '陈同学', '304174', 'secret', '[]', '2026-01-01T00:00:00.000Z');
            "#,
        )
        .unwrap();
        let store = Store::init(conn).unwrap();
        let session = store.load_session().unwrap().unwrap();
        assert_eq!(session.uid, "304174");
        assert_eq!(session.openid, "");
    }

    #[test]
    fn persists_the_single_session_row() {
        let store = Store::open_in_memory().unwrap();
        let session = SessionRow {
            uid: "304174".into(),
            name: "陈同学".into(),
            student_id: "304174".into(),
            password: "secret".into(),
            openid: "abcdefghij_123".into(),
            cookies: r#"[{"name":"sid","value":"abc"}]"#.into(),
            updated_at: "2026-01-01T00:00:00.000Z".into(),
            ..SessionRow::default()
        };
        store.save_session(&session).unwrap();
        assert_eq!(store.load_session().unwrap(), Some(session.clone()));
        store
            .save_session(&SessionRow {
                cookies: "[]".into(),
                updated_at: "2026-01-02T00:00:00.000Z".into(),
                ..session
            })
            .unwrap();
        assert_eq!(store.load_session().unwrap().unwrap().cookies, "[]");
    }

    #[test]
    fn stores_meta_and_audit_in_the_same_schema() {
        let store = Store::open_in_memory().unwrap();
        store.set_meta("auto_checkin_enabled", "1").unwrap();
        assert_eq!(
            store.get_meta("auto_checkin_enabled").unwrap().as_deref(),
            Some("1")
        );
        store
            .write_audit("checkin_missed", &serde_json::json!({"id": "b-1"}))
            .unwrap();
        let audit = store.list_audit(10).unwrap();
        assert_eq!(audit.len(), 1);
        assert_eq!(audit[0].event, "checkin_missed");
        assert_eq!(audit[0].payload["id"], "b-1");
    }

    #[test]
    fn stamps_the_schema_version() {
        let store = Store::open_in_memory().unwrap();
        assert_eq!(
            store.get_meta("schema_version").unwrap().as_deref(),
            Some("2")
        );
    }
}
