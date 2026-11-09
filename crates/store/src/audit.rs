use super::*;

impl Store {
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
