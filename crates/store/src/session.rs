use super::*;

impl Store {
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
}
