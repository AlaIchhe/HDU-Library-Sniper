//! SQLite 存储层：方案、组合、会话、审计与 schema 迁移。

use std::path::Path;
use std::sync::{Mutex, MutexGuard};

use chrono::{SecondsFormat, Utc};
use hdu_sniper_core::{
    valid_weekdays, AuditEvent, BookingGroup, BookingPlan, PlanKind, PlanListItem, Weekday,
};
use rusqlite::{params, Connection, OptionalExtension};

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

mod audit;
mod plans;
mod schema;
mod session;

use schema::migrate;

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
