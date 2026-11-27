package store

import (
	"database/sql"
	"encoding/json"
	"errors"

	"hdu-library-sniper/internal/core"
)

func (s *Store) ListPlans() ([]core.BookingPlan, error) {
	rows, err := s.db.Query(
		`SELECT id, name, weekdays, enabled, created_at, updated_at
		 FROM plans WHERE account_id = ? ORDER BY created_at ASC`,
		defaultAccountID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	plans := []core.BookingPlan{}
	byID := make(map[string]int)
	for rows.Next() {
		var p core.BookingPlan
		var weekdaysJSON string
		var enabled int64
		if err := rows.Scan(&p.ID, &p.Name, &weekdaysJSON, &enabled, &p.CreatedAt, &p.UpdatedAt); err != nil {
			return nil, err
		}
		p.Enabled = enabled != 0
		var days []int
		_ = json.Unmarshal([]byte(weekdaysJSON), &days)
		p.Weekdays = core.ValidWeekdays(days)
		p.Slots = []core.PlanSlot{}
		byID[p.ID] = len(plans)
		plans = append(plans, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(plans) == 0 {
		return plans, nil
	}

	slotRows, err := s.db.Query(
		`SELECT s.id, s.plan_id, s.room_type, s.room_query, s.floor_id, s.floor_name,
		        s.seat_num, s.fallback_seats, s.start_hour, s.duration_hours
		 FROM plan_slots s
		 JOIN plans p ON p.id = s.plan_id
		 WHERE p.account_id = ?
		 ORDER BY s.plan_id ASC, s.position ASC`,
		defaultAccountID,
	)
	if err != nil {
		return nil, err
	}
	defer slotRows.Close()

	for slotRows.Next() {
		var planID string
		slot, err := scanSlotRow(slotRows.Scan, &planID)
		if err != nil {
			return nil, err
		}
		if idx, ok := byID[planID]; ok {
			plans[idx].Slots = append(plans[idx].Slots, slot)
		}
	}
	return plans, slotRows.Err()
}

func (s *Store) GetPlan(id string) (*core.BookingPlan, error) {
	var p core.BookingPlan
	var weekdaysJSON string
	var enabled int64
	err := s.db.QueryRow(
		`SELECT id, name, weekdays, enabled, created_at, updated_at
		 FROM plans WHERE id = ? AND account_id = ?`,
		id, defaultAccountID,
	).Scan(&p.ID, &p.Name, &weekdaysJSON, &enabled, &p.CreatedAt, &p.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	p.Enabled = enabled != 0
	var days []int
	_ = json.Unmarshal([]byte(weekdaysJSON), &days)
	p.Weekdays = core.ValidWeekdays(days)

	slotRows, err := s.db.Query(
		`SELECT id, plan_id, room_type, room_query, floor_id, floor_name,
		        seat_num, fallback_seats, start_hour, duration_hours
		 FROM plan_slots WHERE plan_id = ? ORDER BY position ASC`,
		p.ID,
	)
	if err != nil {
		return nil, err
	}
	defer slotRows.Close()

	p.Slots = []core.PlanSlot{}
	for slotRows.Next() {
		var planID string
		slot, err := scanSlotRow(slotRows.Scan, &planID)
		if err != nil {
			return nil, err
		}
		p.Slots = append(p.Slots, slot)
	}
	if err := slotRows.Err(); err != nil {
		return nil, err
	}
	return &p, nil
}

func (s *Store) EnabledPlan() (*core.BookingPlan, error) {
	var id string
	err := s.db.QueryRow(
		`SELECT id FROM plans WHERE account_id = ? AND enabled = 1 ORDER BY created_at ASC LIMIT 1`,
		defaultAccountID,
	).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return s.GetPlan(id)
}

func (s *Store) SavePlan(p *core.BookingPlan) error {
	core.NormalizePlan(p)
	weekdaysJSON, err := json.Marshal(core.ValidWeekdays(p.Weekdays))
	if err != nil {
		return err
	}
	var enabled int64
	if p.Enabled {
		enabled = 1
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.Exec(
		`INSERT INTO plans (id, account_id, name, weekdays, enabled, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name,
		   weekdays = excluded.weekdays,
		   enabled = excluded.enabled,
		   updated_at = excluded.updated_at`,
		p.ID, defaultAccountID, p.Name, string(weekdaysJSON), enabled, p.CreatedAt, p.UpdatedAt,
	); err != nil {
		return err
	}
	if _, err := tx.Exec(`DELETE FROM plan_slots WHERE plan_id = ?`, p.ID); err != nil {
		return err
	}
	for pos, slot := range p.Slots {
		fbJSON, err := json.Marshal(core.NonNil(slot.FallbackSeats))
		if err != nil {
			return err
		}
		if _, err := tx.Exec(
			`INSERT INTO plan_slots (id, plan_id, position, room_type, room_query, floor_id, floor_name,
			                         seat_num, fallback_seats, start_hour, duration_hours)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			slot.ID, p.ID, pos, slot.RoomType, slot.RoomQuery, slot.FloorID, slot.FloorName,
			slot.SeatNum, string(fbJSON), slot.StartHour, slot.DurationHours,
		); err != nil {
			return err
		}
	}
	return tx.Commit()
}

func (s *Store) DeletePlan(id string) (bool, error) {
	res, err := s.db.Exec(`DELETE FROM plans WHERE id = ? AND account_id = ?`, id, defaultAccountID)
	if err != nil {
		return false, err
	}
	n, _ := res.RowsAffected()
	return n > 0, nil
}

// SetOnlyEnabled sets enabled on id and disables all other plans atomically when enabled is true.
func (s *Store) SetOnlyEnabled(id string, enabled bool) ([]string, error) {
	tx, err := s.db.Begin()
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	var disabled []string
	if enabled {
		rows, err := tx.Query(
			`SELECT id FROM plans WHERE account_id = ? AND enabled = 1 AND id <> ?`,
			defaultAccountID, id,
		)
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
		if _, err := tx.Exec(
			`UPDATE plans SET enabled = 0 WHERE account_id = ? AND id <> ?`,
			defaultAccountID, id,
		); err != nil {
			return nil, err
		}
	}
	var enVal int64
	if enabled {
		enVal = 1
	}
	if _, err := tx.Exec(
		`UPDATE plans SET enabled = ? WHERE id = ? AND account_id = ?`,
		enVal, id, defaultAccountID,
	); err != nil {
		return nil, err
	}
	if err := tx.Commit(); err != nil {
		return nil, err
	}
	return disabled, nil
}

func scanSlotRow(scan func(dest ...any) error, planID *string) (core.PlanSlot, error) {
	var slot core.PlanSlot
	var fbJSON string
	if err := scan(
		&slot.ID, planID, &slot.RoomType, &slot.RoomQuery, &slot.FloorID, &slot.FloorName,
		&slot.SeatNum, &fbJSON, &slot.StartHour, &slot.DurationHours,
	); err != nil {
		return core.PlanSlot{}, err
	}
	if err := json.Unmarshal([]byte(fbJSON), &slot.FallbackSeats); err != nil {
		slot.FallbackSeats = []string{}
	}
	slot.FallbackSeats = core.NonNil(slot.FallbackSeats)
	return slot, nil
}
