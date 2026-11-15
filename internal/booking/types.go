package booking

import (
	"context"
	"time"
)

const (
	PollInterval  = 300 * time.Millisecond
	WriteInterval = 10 * time.Second
	AccountBan    = 10 * time.Minute
)

// Client defines the library operations required by BookingExecutor.
type Client interface {
	Bookings(ctx context.Context) ([]map[string]any, error)
	Floors(ctx context.Context, roomQuery string, lookupTime time.Time, durationHours int64) ([]map[string]any, error)
	BookSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (map[string]any, error)
	LockSeat(ctx context.Context, seatID string, beginTime time.Time, durationHours int64) (map[string]any, error)
	UnlockAllSeats(ctx context.Context) (map[string]any, error)
}

type MemberResult struct {
	PlanID        string `json:"planId"`
	SeatNum       string `json:"seatNum,omitempty"`
	Success       bool   `json:"success"`
	Message       string `json:"message"`
	Terminal      bool   `json:"terminal,omitempty"`
	Unverified    bool   `json:"unverified,omitempty"`
	Blocked       bool   `json:"blocked,omitempty"`
	SeatQueryBusy bool   `json:"seatQueryBusy,omitempty"`
}

type RunResult struct {
	PlanID  string         `json:"planId,omitempty"`
	Kind    string         `json:"kind,omitempty"`
	Success bool           `json:"success"`
	Message string         `json:"message"`
	Members []MemberResult `json:"members"`
}

type Lock struct {
	PlanID        string `json:"planId"`
	SeatID        string `json:"seatId"`
	SeatNum       string `json:"seatNum"`
	BeginSeconds  int64  `json:"beginSeconds"`
	DurationHours int64  `json:"durationHours"`
	Locked        bool   `json:"locked"`
}

type LockResult struct {
	PlanID   string `json:"planId,omitempty"`
	Kind     string `json:"kind,omitempty"`
	Success  bool   `json:"success"`
	Message  string `json:"message"`
	Locks    []Lock `json:"locks"`
	Terminal bool   `json:"terminal,omitempty"`
}
