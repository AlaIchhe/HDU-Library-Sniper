package booking

import (
	"context"
	"time"

	"hdu-library-sniper/internal/hdu"
)

const (
	PollInterval  = 300 * time.Millisecond
	WriteInterval = 10 * time.Second
	AccountBan    = 10 * time.Minute
)

// Client defines the strongly-typed library operations required by Executor.
type Client interface {
	Bookings(ctx context.Context) ([]hdu.RawBooking, error)
	Floors(ctx context.Context, roomQuery string, lookupTime time.Time, durationHours int64) ([]hdu.FloorNode, error)
	BookSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (hdu.ActionResult, error)
	LockSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (hdu.ActionResult, error)
	UnlockAllSeats(ctx context.Context) (hdu.ActionResult, error)
}

type SlotResult struct {
	SlotID        string `json:"slotId"`
	SeatNum       string `json:"seatNum,omitempty"`
	Success       bool   `json:"success"`
	Message       string `json:"message"`
	Terminal      bool   `json:"terminal,omitempty"`
	Unverified    bool   `json:"unverified,omitempty"`
	Blocked       bool   `json:"blocked,omitempty"`
	SeatQueryBusy bool   `json:"seatQueryBusy,omitempty"`
}

type RunResult struct {
	PlanID  string       `json:"planId,omitempty"`
	Success bool         `json:"success"`
	Message string       `json:"message"`
	Slots   []SlotResult `json:"slots"`
}

type Lock struct {
	SlotID        string `json:"slotId"`
	SeatID        string `json:"seatId"`
	SeatNum       string `json:"seatNum"`
	BeginSeconds  int64  `json:"beginSeconds"`
	DurationHours int64  `json:"durationHours"`
	Locked        bool   `json:"locked"`
}

type LockResult struct {
	PlanID   string `json:"planId,omitempty"`
	Success  bool   `json:"success"`
	Message  string `json:"message"`
	Locks    []Lock `json:"locks"`
	Terminal bool   `json:"terminal,omitempty"`
}
