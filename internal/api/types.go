// Package api defines the canonical HTTP/SSE wire contracts shared between the Go server and TypeScript client.
package api

import "hdu-library-sniper/internal/core"

// Enum types and canonical wire values exported to the TypeScript contract generator.
type PlanToggleAction string
type BookingAction string
type BookingState string
type NextTargetKind string
type QrLoginPhase string
type AppEventKind string
type InvalidateTarget string
type NotificationLevel string
type Weekday int

const (
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

	AppEventSession      AppEventKind = "session"
	AppEventRuntime      AppEventKind = "runtime"
	AppEventInvalidate   AppEventKind = "invalidate"
	AppEventNotification AppEventKind = "notification"

	InvalidatePlans      InvalidateTarget = "plans"
	InvalidateBookings   InvalidateTarget = "bookings"
	InvalidateNextTarget InvalidateTarget = "nextTarget"
	InvalidateCheckIn    InvalidateTarget = "checkin"
	InvalidateRuntime    InvalidateTarget = "runtime"

	NotificationSuccess NotificationLevel = core.NotifySuccess
	NotificationWarning NotificationLevel = core.NotifyWarning
	NotificationError   NotificationLevel = core.NotifyError
	NotificationInfo    NotificationLevel = core.NotifyInfo
)

type ErrorResponse struct {
	Detail string `json:"detail"`
}

type HealthResponse struct {
	Status string `json:"status"`
}

type PanelAuthStatusResponse struct {
	Required      bool `json:"required"`
	Authenticated bool `json:"authenticated"`
}

type PanelAuthRequest struct {
	Password string `json:"password"`
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

type AppEvent struct {
	Kind         AppEventKind        `json:"kind"`
	Session      *core.SessionStatus `json:"session,omitempty"`
	Runtime      *core.RuntimeStatus `json:"runtime,omitempty"`
	Invalidate   []InvalidateTarget  `json:"invalidate,omitempty"`
	Notification *core.Notification  `json:"notification,omitempty"`
}

type PlanSlotInput struct {
	ID            string   `json:"id,omitempty"`
	RoomType      string   `json:"roomType"`
	RoomQuery     string   `json:"roomQuery"`
	FloorID       int64    `json:"floorId"`
	FloorName     string   `json:"floorName,omitempty"`
	SeatNum       string   `json:"seatNum"`
	FallbackSeats []string `json:"fallbackSeats,omitempty"`
	StartHour     int64    `json:"startHour"`
	DurationHours int64    `json:"durationHours"`
}

type PlanUpsertRequest struct {
	Name     *string         `json:"name,omitempty"`
	Slots    []PlanSlotInput `json:"slots,omitempty"`
	Weekdays []int           `json:"weekdays,omitempty" contract:"Weekday[]"`
	Enabled  *bool           `json:"enabled,omitempty"`
}

type PlansListResponse struct {
	Plans []core.BookingPlan `json:"plans"`
}

type PlanResponse struct {
	Plan core.BookingPlan `json:"plan"`
}

type TogglePlanResponse struct {
	Plan            core.BookingPlan `json:"plan"`
	DisabledPlanIDs []string         `json:"disabledPlanIds"`
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
