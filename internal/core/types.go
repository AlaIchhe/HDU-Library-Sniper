package core

import (
	"encoding/json"
	"fmt"
)

const (
	PlanKindSingle = "single"
	PlanKindGroup  = "group"

	NextTargetBooking = "booking"
	NextTargetCheckIn = "check-in"
	NextTargetNone    = "none"
)

// BookingPlan is a single seat reservation rule with fallback seats and weekday schedule.
type BookingPlan struct {
	ID            string   `json:"id"`
	Kind          string   `json:"kind" contract:"\"single\""`
	RoomType      string   `json:"roomType"`
	RoomQuery     string   `json:"roomQuery"`
	FloorID       int64    `json:"floorId"`
	FloorName     string   `json:"floorName"`
	SeatNum       string   `json:"seatNum"`
	FallbackSeats []string `json:"fallbackSeats"`
	StartHour     int64    `json:"startHour"`
	DurationHours int64    `json:"durationHours"`
	Weekdays      []int    `json:"weekdays" contract:"Weekday[]"`
	Enabled       bool     `json:"enabled"`
	CreatedAt     string   `json:"createdAt"`
	UpdatedAt     string   `json:"updatedAt"`
}

// BookingGroup executes a sequence of member plans in order.
type BookingGroup struct {
	ID            string        `json:"id"`
	Kind          string        `json:"kind" contract:"\"group\""`
	Name          string        `json:"name"`
	MemberPlanIDs []string      `json:"memberPlanIds"`
	Members       []BookingPlan `json:"members,omitempty"`
	Weekdays      []int         `json:"weekdays" contract:"Weekday[]"`
	Enabled       bool          `json:"enabled"`
	CreatedAt     string        `json:"createdAt"`
	UpdatedAt     string        `json:"updatedAt"`
}

// PlanListItem represents the tagged union BookingPlan | BookingGroup.
type PlanListItem struct {
	Single *BookingPlan
	Group  *BookingGroup
}

func (p PlanListItem) IsEnabled() bool {
	if p.Single != nil {
		return p.Single.Enabled
	}
	if p.Group != nil {
		return p.Group.Enabled
	}
	return false
}

func (p PlanListItem) ItemID() string {
	if p.Single != nil {
		return p.Single.ID
	}
	if p.Group != nil {
		return p.Group.ID
	}
	return ""
}

func (p PlanListItem) MarshalJSON() ([]byte, error) {
	if p.Single != nil {
		v := *p.Single
		v.Kind = PlanKindSingle
		v.FallbackSeats = NonNil(v.FallbackSeats)
		v.Weekdays = NonNil(v.Weekdays)
		return json.Marshal(v)
	}
	if p.Group != nil {
		v := *p.Group
		v.Kind = PlanKindGroup
		v.MemberPlanIDs = NonNil(v.MemberPlanIDs)
		v.Weekdays = NonNil(v.Weekdays)
		return json.Marshal(v)
	}
	return nil, fmt.Errorf("empty PlanListItem")
}

// SessionStatus mirrors the active CAS/library session snapshot for the UI.
type SessionStatus struct {
	Authenticated bool   `json:"authenticated"`
	UID           string `json:"uid,omitempty"`
	Name          string `json:"name,omitempty"`
	Refreshing    bool   `json:"refreshing"`
	LastError     string `json:"lastError,omitempty"`
}

// QrLoginStart returns the DingTalk QR code image (data URL) and polling uuid.
type QrLoginStart struct {
	UUID       string `json:"uuid"`
	Image      string `json:"image"`
	TTLSeconds int64  `json:"ttlSeconds"`
}

// QrLoginStatus represents one poll result for an active QR login session.
type QrLoginStatus struct {
	Status  string         `json:"status" contract:"QrLoginPhase"`
	Message string         `json:"message,omitempty"`
	Session *SessionStatus `json:"session,omitempty"`
}

// Booking represents a normalized active library seat booking for display.
type Booking struct {
	BookingID    string `json:"bookingId"`
	RoomName     string `json:"roomName"`
	SeatNum      string `json:"seatNum"`
	StartText    string `json:"startText"`
	DurationText string `json:"durationText"`
	Status       string `json:"status"`
	State        string `json:"state" contract:"BookingState"`
	StatusLabel  string `json:"statusLabel"`
	CanCancel    bool   `json:"canCancel"`
	CanCheckIn   bool   `json:"canCheckIn"`
	CanSignOut   bool   `json:"canSignOut"`
	CanLeave     bool   `json:"canLeave"`
	CanRenew     bool   `json:"canRenew"`
}

type RoomTypeOption struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Query string `json:"query"`
}

type FloorOption struct {
	ID         int64    `json:"id"`
	Name       string   `json:"name"`
	SeatCount  int64    `json:"seatCount"`
	SeatTitles []string `json:"seatTitles"`
}

type BookingRange struct {
	MinBeginTime int64 `json:"minBeginTime"`
	MaxEndTime   int64 `json:"maxEndTime"`
	MinDuration  int64 `json:"minDuration"`
	MaxDuration  int64 `json:"maxDuration"`
}

type DurationOptions struct {
	RoomQuery string  `json:"roomQuery"`
	StartHour int64   `json:"startHour"`
	Options   []int64 `json:"options"`
}

type CheckInPolling struct {
	Active     bool   `json:"active"`
	NextPollAt string `json:"nextPollAt,omitempty"`
	LastPollAt string `json:"lastPollAt,omitempty"`
}

type RuntimeStatus struct {
	Scheduler      string          `json:"scheduler"`
	State          string          `json:"state"`
	LastRunAt      string          `json:"lastRunAt,omitempty"`
	LastMessage    string          `json:"lastMessage,omitempty"`
	CheckInPolling *CheckInPolling `json:"checkInPolling,omitempty"`
}

type CheckInStatus struct {
	Enabled        bool   `json:"enabled"`
	ConsentVersion string `json:"consentVersion"`
	ConsentedAt    string `json:"consentedAt,omitempty"`
	LastAttemptAt  string `json:"lastAttemptAt,omitempty"`
	LastSuccessAt  string `json:"lastSuccessAt,omitempty"`
	LastMessage    string `json:"lastMessage,omitempty"`
}

type NextExecutionTarget struct {
	Kind      string `json:"kind" contract:"NextTargetKind"`
	Label     string `json:"label"`
	At        string `json:"at,omitempty"`
	PlanID    string `json:"planId,omitempty"`
	BookingID string `json:"bookingId,omitempty"`
}

type AuditEvent struct {
	ID        int64          `json:"id"`
	Event     string         `json:"event"`
	Payload   map[string]any `json:"payload"`
	CreatedAt string         `json:"createdAt"`
}
