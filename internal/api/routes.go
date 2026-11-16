package api

import (
	"net/http"
	"reflect"

	"hdu-library-sniper/internal/core"
)

// ParamSpec describes a URL path or query parameter on an HTTP endpoint.
type ParamSpec struct {
	Name     string
	TypeExpr string
	Required bool
}

// EndpointSpec is the single source of truth for route wiring, contract tests, and TS codegen.
type EndpointSpec struct {
	Name         string
	Method       string
	Path         string
	Public       bool
	PathParams   []ParamSpec
	QueryParams  []ParamSpec
	RequestType  reflect.Type
	ResponseType reflect.Type
}

// Pattern returns the Go 1.22 net/http ServeMux registration pattern ("METHOD /path").
func (e EndpointSpec) Pattern() string {
	return e.Method + " " + e.Path
}

const (
	PathHealth            = "/api/health"
	PathSessionStatus     = "/api/session"
	PathSessionLogin      = "/api/session/login"
	PathSessionOpenID     = "/api/session/openid"
	PathSessionQR         = "/api/session/qr"
	PathSessionQRStatus   = "/api/session/qr/{uuid}/status"
	PathSessionQRCancel   = "/api/session/qr/{uuid}/cancel"
	PathSessionLogout     = "/api/session/logout"
	PathAudit             = "/api/audit"
	PathPlans             = "/api/plans"
	PathPlanByID          = "/api/plans/{id}"
	PathPlanToggle        = "/api/plans/{id}/{action}"
	PathGroups            = "/api/groups"
	PathGroupByID         = "/api/groups/{id}"
	PathCatalogRoomTypes  = "/api/catalog/room-types"
	PathCatalogFloors     = "/api/catalog/floors"
	PathCatalogDurations  = "/api/catalog/durations"
	PathBookingsCurrent   = "/api/bookings/current"
	PathBookingAction     = "/api/bookings/{id}/{action}"
	PathBookingRun        = "/api/booking/run"
	PathRuntimeStatus     = "/api/runtime/status"
	PathRuntimeNextTarget = "/api/runtime/next-target"
	PathCheckIn           = "/api/checkin"
	PathCheckInEnable     = "/api/checkin/enable"
	PathCheckInDisable    = "/api/checkin/disable"
)

// Endpoints enumerates every HTTP/IPC API endpoint exposed by the server.
var Endpoints = []EndpointSpec{
	{Name: "health", Method: http.MethodGet, Path: PathHealth, Public: true, ResponseType: reflect.TypeFor[HealthResponse]()},
	{Name: "sessionStatus", Method: http.MethodGet, Path: PathSessionStatus, Public: true, ResponseType: reflect.TypeFor[core.SessionStatus]()},
	{Name: "sessionLogin", Method: http.MethodPost, Path: PathSessionLogin, Public: true, RequestType: reflect.TypeFor[LoginPasswordRequest](), ResponseType: reflect.TypeFor[LoginResponse]()},
	{Name: "sessionOpenId", Method: http.MethodPost, Path: PathSessionOpenID, Public: true, RequestType: reflect.TypeFor[LoginOpenIDRequest](), ResponseType: reflect.TypeFor[LoginResponse]()},
	{Name: "sessionQrStart", Method: http.MethodPost, Path: PathSessionQR, Public: true, ResponseType: reflect.TypeFor[core.QrLoginStart]()},
	{Name: "sessionQrStatus", Method: http.MethodGet, Path: PathSessionQRStatus, Public: true, PathParams: []ParamSpec{{Name: "uuid", TypeExpr: "string", Required: true}}, ResponseType: reflect.TypeFor[core.QrLoginStatus]()},
	{Name: "sessionQrCancel", Method: http.MethodPost, Path: PathSessionQRCancel, Public: true, PathParams: []ParamSpec{{Name: "uuid", TypeExpr: "string", Required: true}}, ResponseType: reflect.TypeFor[QrCancelResponse]()},
	{Name: "sessionLogout", Method: http.MethodPost, Path: PathSessionLogout, Public: true, ResponseType: reflect.TypeFor[SuccessResponse]()},

	{Name: "auditList", Method: http.MethodGet, Path: PathAudit, QueryParams: []ParamSpec{{Name: "limit", TypeExpr: "number", Required: false}}, ResponseType: reflect.TypeFor[AuditListResponse]()},
	{Name: "plansList", Method: http.MethodGet, Path: PathPlans, ResponseType: reflect.TypeFor[PlansListResponse]()},
	{Name: "plansCreate", Method: http.MethodPost, Path: PathPlans, RequestType: reflect.TypeFor[PlanUpsertRequest](), ResponseType: reflect.TypeFor[SinglePlanResponse]()},
	{Name: "plansGet", Method: http.MethodGet, Path: PathPlanByID, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}}, ResponseType: reflect.TypeFor[PlanItemResponse]()},
	{Name: "plansUpdate", Method: http.MethodPatch, Path: PathPlanByID, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}}, RequestType: reflect.TypeFor[PlanUpsertRequest](), ResponseType: reflect.TypeFor[SinglePlanResponse]()},
	{Name: "plansDelete", Method: http.MethodDelete, Path: PathPlanByID, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}}, ResponseType: reflect.TypeFor[SuccessResponse]()},
	{Name: "plansToggle", Method: http.MethodPost, Path: PathPlanToggle, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}, {Name: "action", TypeExpr: "PlanToggleAction", Required: true}}, ResponseType: reflect.TypeFor[TogglePlanResponse]()},

	{Name: "groupsCreate", Method: http.MethodPost, Path: PathGroups, RequestType: reflect.TypeFor[GroupUpsertRequest](), ResponseType: reflect.TypeFor[GroupResponse]()},
	{Name: "groupsGet", Method: http.MethodGet, Path: PathGroupByID, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}}, ResponseType: reflect.TypeFor[GroupResponse]()},
	{Name: "groupsUpdate", Method: http.MethodPatch, Path: PathGroupByID, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}}, RequestType: reflect.TypeFor[GroupUpsertRequest](), ResponseType: reflect.TypeFor[GroupResponse]()},
	{Name: "groupsDelete", Method: http.MethodDelete, Path: PathGroupByID, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}}, ResponseType: reflect.TypeFor[SuccessResponse]()},

	{Name: "catalogRoomTypes", Method: http.MethodGet, Path: PathCatalogRoomTypes, ResponseType: reflect.TypeFor[RoomTypesResponse]()},
	{Name: "catalogFloors", Method: http.MethodGet, Path: PathCatalogFloors, QueryParams: []ParamSpec{{Name: "roomQuery", TypeExpr: "string", Required: true}, {Name: "roomType", TypeExpr: "string", Required: false}}, ResponseType: reflect.TypeFor[FloorsResponse]()},
	{Name: "catalogDurations", Method: http.MethodGet, Path: PathCatalogDurations, QueryParams: []ParamSpec{{Name: "roomQuery", TypeExpr: "string", Required: true}, {Name: "startHour", TypeExpr: "number", Required: true}, {Name: "roomType", TypeExpr: "string", Required: false}}, ResponseType: reflect.TypeFor[core.DurationOptions]()},

	{Name: "bookingsCurrent", Method: http.MethodGet, Path: PathBookingsCurrent, ResponseType: reflect.TypeFor[BookingsListResponse]()},
	{Name: "bookingsAction", Method: http.MethodPost, Path: PathBookingAction, PathParams: []ParamSpec{{Name: "id", TypeExpr: "string", Required: true}, {Name: "action", TypeExpr: "BookingAction", Required: true}}, ResponseType: reflect.TypeFor[ActionResponse]()},
	{Name: "bookingRun", Method: http.MethodPost, Path: PathBookingRun, ResponseType: reflect.TypeFor[ActionResponse]()},

	{Name: "runtimeStatus", Method: http.MethodGet, Path: PathRuntimeStatus, ResponseType: reflect.TypeFor[core.RuntimeStatus]()},
	{Name: "runtimeNextTarget", Method: http.MethodGet, Path: PathRuntimeNextTarget, ResponseType: reflect.TypeFor[core.NextExecutionTarget]()},
	{Name: "checkinStatus", Method: http.MethodGet, Path: PathCheckIn, ResponseType: reflect.TypeFor[core.CheckInStatus]()},
	{Name: "checkinEnable", Method: http.MethodPost, Path: PathCheckInEnable, RequestType: reflect.TypeFor[EnableCheckInRequest](), ResponseType: reflect.TypeFor[core.CheckInStatus]()},
	{Name: "checkinDisable", Method: http.MethodPost, Path: PathCheckInDisable, ResponseType: reflect.TypeFor[core.CheckInStatus]()},
}
