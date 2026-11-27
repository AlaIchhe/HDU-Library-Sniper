package store

import "hdu-library-sniper/internal/core"

func (s *Store) ListPendingCheckIns() ([]core.PendingCheckIn, error) {
	rows, err := s.db.Query(
		`SELECT booking_id, begin_ms, deadline_ms, attempts, next_at_ms
		 FROM pending_checkins ORDER BY next_at_ms ASC`,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []core.PendingCheckIn{}
	for rows.Next() {
		var p core.PendingCheckIn
		if err := rows.Scan(&p.BookingID, &p.BeginMs, &p.DeadlineMs, &p.Attempts, &p.NextAtMs); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

func (s *Store) UpsertPendingCheckIn(p core.PendingCheckIn) error {
	_, err := s.db.Exec(
		`INSERT INTO pending_checkins (booking_id, begin_ms, deadline_ms, attempts, next_at_ms)
		 VALUES (?, ?, ?, ?, ?)
		 ON CONFLICT(booking_id) DO UPDATE SET
		   begin_ms = excluded.begin_ms,
		   deadline_ms = excluded.deadline_ms,
		   attempts = excluded.attempts,
		   next_at_ms = excluded.next_at_ms`,
		p.BookingID, p.BeginMs, p.DeadlineMs, p.Attempts, p.NextAtMs,
	)
	return err
}

func (s *Store) DeletePendingCheckIn(bookingID string) error {
	_, err := s.db.Exec(`DELETE FROM pending_checkins WHERE booking_id = ?`, bookingID)
	return err
}

func (s *Store) ClearPendingCheckIns() error {
	_, err := s.db.Exec(`DELETE FROM pending_checkins`)
	return err
}
