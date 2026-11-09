use super::*;

struct GroupRow {
    id: String,
    name: String,
    weekdays: Vec<Weekday>,
    enabled: bool,
    created_at: String,
    updated_at: String,
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

impl Store {
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
}
