use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub type Weekday = u8;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
/// 方案类型：单方案或组合。
pub enum PlanKind {
    #[default]
    Single,
    Group,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
/// 一个预约方案：房间、座位、时间与重复星期。
pub struct BookingPlan {
    pub id: String,
    #[ts(type = "\"single\"")]
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
    #[ts(type = "Array<1 | 2 | 3 | 4 | 5 | 6 | 7>")]
    pub weekdays: Vec<Weekday>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
/// 组合方案：按顺序执行的一组预约。
pub struct BookingGroup {
    pub id: String,
    #[ts(type = "\"group\"")]
    pub kind: PlanKind,
    pub name: String,
    pub member_plan_ids: Vec<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub members: Option<Vec<BookingPlan>>,
    #[ts(type = "Array<1 | 2 | 3 | 4 | 5 | 6 | 7>")]
    pub weekdays: Vec<Weekday>,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(untagged)]
#[ts(export)]
pub enum PlanListItem {
    Single(BookingPlan),
    Group(BookingGroup),
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
/// 馆方返回的当前预约，已转换为前端展示字段。
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
/// 当前登录态快照。
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

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
pub struct CheckInPolling {
    pub active: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub next_poll_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_poll_at: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
/// 调度器运行态：当前状态、下次执行与最近消息。
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

#[derive(Debug, Clone, Copy, Serialize, Deserialize, TS)]
#[serde(rename_all = "kebab-case")]
#[ts(export)]
pub enum NextTargetKind {
    Booking,
    CheckIn,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
/// 下一次预约执行的目标时间与方案。
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct RoomTypeOption {
    pub id: String,
    pub name: String,
    pub query: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct FloorOption {
    pub id: i64,
    pub name: String,
    pub seat_count: i64,
    pub seat_titles: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BookingRange {
    pub min_begin_time: i64,
    pub max_end_time: i64,
    pub min_duration: i64,
    pub max_duration: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct DurationOptions {
    pub room_query: String,
    pub start_hour: i64,
    pub options: Vec<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
/// 自动签到状态。
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

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct AuditEvent {
    pub id: i64,
    pub event: String,
    #[ts(type = "Record<string, unknown>")]
    pub payload: serde_json::Value,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
/// 扫码登录开始：二维码图片与轮询 uuid。
pub struct QrLoginStart {
    pub uuid: String,
    pub image: String,
    pub ttl_seconds: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export, optional_fields)]
/// 扫码登录轮询结果。
pub struct QrLoginStatus {
    pub status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session: Option<SessionStatus>,
}
