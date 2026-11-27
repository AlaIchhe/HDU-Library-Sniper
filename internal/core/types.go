package core

const (
	NextTargetBooking = "booking"
	NextTargetCheckIn = "check-in"
	NextTargetNone    = "none"

	NotifySuccess = "success"
	NotifyWarning = "warning"
	NotifyError   = "error"
	NotifyInfo    = "info"
)

// PlanSlot is one non-overlapping seat reservation window within a BookingPlan.
type PlanSlot struct {
	ID            string   `json:"id"`
	RoomType      string   `json:"roomType"`
	RoomQuery     string   `json:"roomQuery"`
	FloorID       int64    `json:"floorId"`
	FloorName     string   `json:"floorName"`
	SeatNum       string   `json:"seatNum"`
	FallbackSeats []string `json:"fallbackSeats"`
	StartHour     int64    `json:"startHour"`
	DurationHours int64    `json:"durationHours"`
}

// BookingPlan is the unified reservation aggregate containing 1..N non-overlapping slots.
type BookingPlan struct {
	ID        string     `json:"id"`
	Name      string     `json:"name"`
	Slots     []PlanSlot `json:"slots"`
	Weekdays  []int      `json:"weekdays" contract:"Weekday[]"`
	Enabled   bool       `json:"enabled"`
	CreatedAt string     `json:"createdAt"`
	UpdatedAt string     `json:"updatedAt"`
}

// Notification is a backend-authored user alert rendered identically by desktop notifications and web toasts.
type Notification struct {
	Level     string `json:"level" contract:"NotificationLevel"`
	Title     string `json:"title"`
	Body      string `json:"body,omitempty"`
	Celebrate bool   `json:"celebrate,omitempty"`
}

// PendingCheckIn tracks an active booking awaiting automatic check-in.
type PendingCheckIn struct {
	BookingID  string
	BeginMs    int64
	DeadlineMs int64
	Attempts   uint32
	NextAtMs   int64
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
