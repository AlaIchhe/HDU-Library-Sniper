package store

import (
	"database/sql"
	"encoding/json"
	"errors"

	"hdu-library-sniper/internal/core"
)

func scanPlanRow(scan func(dest ...any) error) (core.BookingPlan, error) {
	var p core.BookingPlan
	var floorName sql.NullString
	var fallbackJSON, weekdaysJSON string
	var enabled int64
	if err := scan(
		&p.ID, &p.RoomType, &p.RoomQuery, &p.FloorID, &floorName,
		&p.SeatNum, &fallbackJSON, &p.StartHour, &p.DurationHours,
		&weekdaysJSON, &enabled, &p.CreatedAt, &p.UpdatedAt,
	); err != nil {
		return core.BookingPlan{}, err
	}
	p.Kind = core.PlanKindSingle
	p.FloorName = floorName.String
	p.Enabled = enabled != 0
	if err := json.Unmarshal([]byte(fallbackJSON), &p.FallbackSeats); err != nil {
		p.FallbackSeats = []string{}
	}
	p.FallbackSeats = core.NonNil(p.FallbackSeats)
	var days []int
	_ = json.Unmarshal([]byte(weekdaysJSON), &days)
	p.Weekdays = core.ValidWeekdays(days)
	return p, nil
}

const singlePlanCols = `id, room_type, room_query, floor_id, floor_name, seat_num, fallback_seats, start_hour, duration_hours, weekdays, enabled, created_at, updated_at`

func (s *Store) ListPlans() ([]core.BookingPlan, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.listPlansLocked()
}

func (s *Store) listPlansLocked() ([]core.BookingPlan, error) {
	rows, err := s.db.Query(`SELECT ` + singlePlanCols + ` FROM plans WHERE kind = 'single' ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []core.BookingPlan{}
	for rows.Next() {
		p, err := scanPlanRow(rows.Scan)
		if err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) GetPlan(id string) (*core.BookingPlan, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := scanPlanRow(s.db.QueryRow(
		`SELECT `+singlePlanCols+` FROM plans WHERE id = ? AND kind = 'single'`, id,
	).Scan)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) SavePlan(p *core.BookingPlan) error {
	fallbackJSON, err := json.Marshal(core.NonNil(p.FallbackSeats))
	if err != nil {
		return err
	}
	weekdaysJSON, err := json.Marshal(core.ValidWeekdays(p.Weekdays))
	if err != nil {
		return err
	}
	var enabled int64
	if p.Enabled {
		enabled = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	_, err = s.db.Exec(
		`INSERT INTO plans (id, kind, room_type, room_query, floor_id, floor_name, seat_num, fallback_seats,
			start_hour, duration_hours, weekdays, enabled, created_at, updated_at)
		 VALUES (?, 'single', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET kind='single', room_type=excluded.room_type, room_query=excluded.room_query,
			floor_id=excluded.floor_id, floor_name=excluded.floor_name, seat_num=excluded.seat_num,
			fallback_seats=excluded.fallback_seats, start_hour=excluded.start_hour,
			duration_hours=excluded.duration_hours, weekdays=excluded.weekdays, enabled=excluded.enabled,
			updated_at=excluded.updated_at`,
		p.ID, p.RoomType, p.RoomQuery, p.FloorID, p.FloorName, p.SeatNum,
		string(fallbackJSON), p.StartHour, p.DurationHours, string(weekdaysJSON),
		enabled, p.CreatedAt, p.UpdatedAt,
	)
	return err
}

func (s *Store) ListPlanItems() ([]core.PlanListItem, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	singles, err := s.listPlansLocked()
	if err != nil {
		return nil, err
	}
	byID := make(map[string]core.BookingPlan, len(singles))
	items := make([]core.PlanListItem, 0, len(singles))
	for i := range singles {
		p := singles[i]
		byID[p.ID] = p
		items = append(items, core.PlanListItem{Single: &p})
	}
	gRows, err := s.db.Query(`SELECT id, COALESCE(name, ''), weekdays, enabled, created_at, updated_at FROM plans WHERE kind = 'group' ORDER BY created_at ASC`)
	if err != nil {
		return nil, err
	}
	var groups []core.BookingGroup
	for gRows.Next() {
		var g core.BookingGroup
		var weekdaysJSON string
		var enabled int64
		if err := gRows.Scan(&g.ID, &g.Name, &weekdaysJSON, &enabled, &g.CreatedAt, &g.UpdatedAt); err != nil {
			_ = gRows.Close()
			return nil, err
		}
		g.Kind = core.PlanKindGroup
		g.Enabled = enabled != 0
		var days []int
		_ = json.Unmarshal([]byte(weekdaysJSON), &days)
		g.Weekdays = core.ValidWeekdays(days)
		groups = append(groups, g)
	}
	if err := gRows.Err(); err != nil {
		_ = gRows.Close()
		return nil, err
	}
	_ = gRows.Close()

	for i := range groups {
		g := groups[i]
		mIDs, err := s.getGroupMembersLocked(g.ID)
		if err != nil {
			return nil, err
		}
		g.MemberPlanIDs = mIDs
		g.Members = make([]core.BookingPlan, 0, len(mIDs))
		for _, mid := range mIDs {
			if m, ok := byID[mid]; ok {
				g.Members = append(g.Members, m)
			}
		}
		items = append(items, core.PlanListItem{Group: &g})
	}
	return items, nil
}

func (s *Store) getGroupMembersLocked(groupID string) ([]string, error) {
	rows, err := s.db.Query(`SELECT plan_id FROM group_members WHERE group_id = ? ORDER BY position ASC`, groupID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	ids := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

func (s *Store) GetPlanItem(id string) (*core.PlanListItem, error) {
	items, err := s.ListPlanItems()
	if err != nil {
		return nil, err
	}
	for i := range items {
		if items[i].ItemID() == id {
			item := items[i]
			return &item, nil
		}
	}
	return nil, nil
}

func (s *Store) SaveGroup(g *core.BookingGroup) error {
	weekdaysJSON, err := json.Marshal(core.ValidWeekdays(g.Weekdays))
	if err != nil {
		return err
	}
	var enabled int64
	if g.Enabled {
		enabled = 1
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()
	if _, err := tx.Exec(
		`INSERT INTO plans (id, kind, name, room_type, room_query, floor_id, seat_num, start_hour,
			duration_hours, weekdays, enabled, created_at, updated_at)
		 VALUES (?, 'group', ?, '', '', 0, '', 0, 0, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET kind='group', name=excluded.name, weekdays=excluded.weekdays,
			enabled=excluded.enabled, updated_at=excluded.updated_at`,
		g.ID, g.Name, string(weekdaysJSON), enabled, g.CreatedAt, g.UpdatedAt,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM group_members WHERE group_id = ?`, g.ID); err != nil {
		return err
	}
	for pos, pid := range g.MemberPlanIDs {
		if _, err := tx.Exec(
			`INSERT INTO group_members(group_id, plan_id, position) VALUES(?, ?, ?)`,
			g.ID, pid, pos,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) DeletePlan(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`DELETE FROM plans WHERE id = ? AND kind = 'single'`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) DeleteGroup(id string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	res, err := s.db.Exec(`DELETE FROM plans WHERE id = ? AND kind = 'group'`, id)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

func (s *Store) ReferencedPlanIDs(planID string) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows, err := s.db.Query(`SELECT group_id FROM group_members WHERE plan_id = ?`, planID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var ids []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			return nil, err
		}
		ids = append(ids, id)
	}
	return ids, rows.Err()
}

// SetOnlyEnabled sets enabled on id and disables all other items atomically when enabled is true.
func (s *Store) SetOnlyEnabled(id string, enabled bool) ([]string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()
	var disabled []string
	if enabled {
		rows, err := tx.Query(`SELECT id FROM plans WHERE enabled = 1 AND id <> ?`, id)
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			var did string
			if err := rows.Scan(&did); err != nil {
				_ = rows.Close()
				return nil, err
			}
			disabled = append(disabled, did)
		}
		_ = rows.Close()
		if _, err := tx.Exec(`UPDATE plans SET enabled = 0 WHERE id <> ?`, id); err != nil {
			return nil, err
		}
	}
	var enVal int64
	if enabled {
		enVal = 1
	}
	if _, err := tx.Exec(`UPDATE plans SET enabled = ? WHERE id = ?`, enVal, id); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return disabled, nil
}
