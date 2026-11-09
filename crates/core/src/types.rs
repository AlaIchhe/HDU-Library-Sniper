use serde::{Deserialize, Serialize};

pub type Weekday = u8;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PlanKind {
    #[default]
    Single,
    Group,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingPlan {
    pub id: String,
    pub kind: PlanKind,
    pub room_type: String,
    pub room_query: String,
    pub floor_id: i64,
    #[serde(default)]
    pub floor_name: String,
    pub seat_num: String,
    #[serde(default)]
    pub fallback_seats: Vec<String>,
    pub start_hour: i64,
    pub duration_hours: i64,
    #[serde(default)]
    pub weekdays: Vec<Weekday>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingGroup {
    pub id: String,
    pub kind: PlanKind,
    pub name: String,
    pub member_plan_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<BookingPlan>>,
    pub weekdays: Vec<Weekday>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum PlanListItem {
    Single(BookingPlan),
    Group(BookingGroup),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Booking {
    pub booking_id: String,
    pub room_name: String,
    pub seat_num: String,
    pub start_text: String,
    pub duration_text: String,
    pub status: String,
    pub state: String,
    pub status_label: String,
    pub can_cancel: bool,
    pub can_check_in: bool,
    pub can_sign_out: bool,
    pub can_leave: bool,
    pub can_renew: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionStatus {
    pub authenticated: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub uid: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub refreshing: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInPolling {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_poll_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_poll_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub scheduler: String,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub check_in_polling: Option<CheckInPolling>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum NextTargetKind {
    Booking,
    CheckIn,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NextExecutionTarget {
    pub kind: NextTargetKind,
    pub label: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub plan_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub booking_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoomTypeOption {
    pub id: String,
    pub name: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FloorOption {
    pub id: i64,
    pub name: String,
    pub seat_count: i64,
    pub seat_titles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingRange {
    pub min_begin_time: i64,
    pub max_end_time: i64,
    pub min_duration: i64,
    pub max_duration: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DurationOptions {
    pub room_query: String,
    pub start_hour: i64,
    pub options: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckInStatus {
    pub enabled: bool,
    pub consent_version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub consented_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_attempt_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_success_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_message: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuditEvent {
    pub id: i64,
    pub event: String,
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginStart {
    pub uuid: String,
    pub image: String,
    pub ttl_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QrLoginStatus {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionStatus>,
}
