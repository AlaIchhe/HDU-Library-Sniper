// Package api defines the canonical HTTP/IPC wire contracts shared between the Go server and TypeScript client.
package api

import "hdu-library-sniper/internal/core"

// Enum types and canonical wire values exported to the TypeScript contract generator.
type PlanKind string
type PlanToggleAction string
type BookingAction string
type BookingState string
type NextTargetKind string
type QrLoginPhase string
type AppEventKind string
type InvalidateTarget string
type Weekday int

const (
	PlanKindSingle PlanKind = core.PlanKindSingle
	PlanKindGroup  PlanKind = core.PlanKindGroup

	PlanActionEnable  PlanToggleAction = "enable"
	PlanActionDisable PlanToggleAction = "disable"

	BookingActionCancel   BookingAction = "cancel"
	BookingActionCheckIn  BookingAction = "checkin"
	BookingActionComeBack BookingAction = "comeback"
	BookingActionSignOut  BookingAction = "signout"
	BookingActionLeave    BookingAction = "leave"

	BookingStatePending BookingState = "pending"
	BookingStateCheckIn BookingState = "check_in"
	BookingStateInUse   BookingState = "in_use"
	BookingStateAway    BookingState = "away"

	NextTargetBooking NextTargetKind = core.NextTargetBooking
	NextTargetCheckIn NextTargetKind = core.NextTargetCheckIn
	NextTargetNone    NextTargetKind = core.NextTargetNone

	QrLoginPending QrLoginPhase = "pending"
	QrLoginSuccess QrLoginPhase = "success"
	QrLoginExpired QrLoginPhase = "expired"
	QrLoginError   QrLoginPhase = "error"

	AppEventSession    AppEventKind = "session"
	AppEventRuntime    AppEventKind = "runtime"
	AppEventInvalidate AppEventKind = "invalidate"
	AppEventAudit      AppEventKind = "audit"

	InvalidatePlans      InvalidateTarget = "plans"
	InvalidateBookings   InvalidateTarget = "bookings"
	InvalidateNextTarget InvalidateTarget = "nextTarget"
	InvalidateCheckIn    InvalidateTarget = "checkin"
	InvalidateRuntime    InvalidateTarget = "runtime"
)

type ErrorResponse struct {
	Detail string `json:"detail"`
}

type HealthResponse struct {
	Status string `json:"status"`
}

type SuccessResponse struct {
	Success bool `json:"success"`
}

type ActionResponse struct {
	Success bool   `json:"success"`
	Message string `json:"message"`
}

type LoginPasswordRequest struct {
	StudentID string `json:"studentId"`
	Password  string `json:"password"`
}

type LoginOpenIDRequest struct {
	OpenID string `json:"openid"`
}

type LoginResponse struct {
	Success bool               `json:"success"`
	Message string             `json:"message"`
	Session core.SessionStatus `json:"session"`
}

type QrCancelResponse struct {
	Cancelled bool `json:"cancelled"`
}

type QrStatusEvent struct {
	UUID    string              `json:"uuid"`
	Status  QrLoginPhase        `json:"status"`
	Message string              `json:"message,omitempty"`
	Session *core.SessionStatus `json:"session,omitempty"`
}

type AuditNotification struct {
	Event   string         `json:"event"`
	Payload map[string]any `json:"payload"`
}

type AppEvent struct {
	Kind       AppEventKind        `json:"kind"`
	Session    *core.SessionStatus `json:"session,omitempty"`
	Runtime    *core.RuntimeStatus `json:"runtime,omitempty"`
	Invalidate []InvalidateTarget  `json:"invalidate,omitempty"`
	Audit      *AuditNotification  `json:"audit,omitempty"`
}

type PlanUpsertRequest struct {
	RoomType      *string  `json:"roomType,omitempty"`
	RoomQuery     *string  `json:"roomQuery,omitempty"`
	FloorID       *int64   `json:"floorId,omitempty"`
	FloorName     *string  `json:"floorName,omitempty"`
	SeatNum       *string  `json:"seatNum,omitempty"`
	FallbackSeats []string `json:"fallbackSeats,omitempty"`
	StartHour     *int64   `json:"startHour,omitempty"`
	DurationHours *int64   `json:"durationHours,omitempty"`
	Weekdays      []int    `json:"weekdays,omitempty" contract:"Weekday[]"`
	Enabled       *bool    `json:"enabled,omitempty"`
}

type PlansListResponse struct {
	Plans []core.PlanListItem `json:"plans"`
}

type PlanItemResponse struct {
	Plan core.PlanListItem `json:"plan"`
}

type SinglePlanResponse struct {
	Plan core.BookingPlan `json:"plan"`
}

type TogglePlanResponse struct {
	Plan            core.PlanListItem `json:"plan"`
	DisabledPlanIDs []string          `json:"disabledPlanIds"`
}

type GroupUpsertRequest struct {
	Name          string   `json:"name"`
	MemberPlanIDs []string `json:"memberPlanIds"`
}

type GroupResponse struct {
	Plan core.BookingGroup `json:"plan"`
}

type RoomTypesResponse struct {
	Options []core.RoomTypeOption `json:"options"`
}

type FloorsResponse struct {
	Options []core.FloorOption `json:"options"`
	Range   core.BookingRange  `json:"range"`
}

type BookingsListResponse struct {
	Bookings []core.Booking `json:"bookings"`
}

type EnableCheckInRequest struct {
	Agreed bool `json:"agreed"`
}

type AuditListResponse struct {
	Events []core.AuditEvent `json:"events"`
}
