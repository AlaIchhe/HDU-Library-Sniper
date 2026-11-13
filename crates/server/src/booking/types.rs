use super::*;

pub trait BookingClient: Send + Sync {
    async fn bookings(&self) -> Result<Vec<Value>, HduError>;
    async fn floors(
        &self,
        room_query: &str,
        lookup_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Vec<Value>, HduError>;
    async fn book_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError>;
    async fn lock_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError>;
    async fn unlock_all_seats(&self) -> Result<Value, HduError>;
}

impl BookingClient for LibraryClient {
    async fn bookings(&self) -> Result<Vec<Value>, HduError> {
        LibraryClient::bookings(self).await
    }
    async fn floors(
        &self,
        room_query: &str,
        lookup_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Vec<Value>, HduError> {
        LibraryClient::floors(self, room_query, lookup_time, duration_hours).await
    }
    async fn book_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        LibraryClient::book_seat(self, seat_id, begin_time, duration_hours).await
    }
    async fn lock_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        LibraryClient::lock_seat(self, seat_id, begin_time, duration_hours).await
    }
    async fn unlock_all_seats(&self) -> Result<Value, HduError> {
        LibraryClient::unlock_all_seats(self).await
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingMemberResult {
    pub plan_id: String,
    pub seat_num: Option<String>,
    pub success: bool,
    pub message: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub terminal: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub unverified: bool,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub blocked: bool,
    /// 座位图查询不可用：服务端并发保护（HTTP 404 / CODE=NotFound）或请求超时。
    /// 实测：404 瞬时恢复、不累积；超时在 20:00 拥堵时同样代表通路没打开，
    /// 必须一起算，否则会写出假的"已恢复"（2026-11-13 实战两次误报）。
    /// 轮询间隔与业务失败相同（`POLL_MS`），此标记只用于审计与拥堵期间冻结写入槽。
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub seat_query_busy: bool,
}

impl BookingMemberResult {
    pub(crate) fn failure(
        plan: &BookingPlan,
        seat_num: Option<String>,
        message: impl Into<String>,
    ) -> Self {
        Self {
            plan_id: plan.id.clone(),
            seat_num,
            success: false,
            message: message.into(),
            ..Self::default()
        }
    }
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingRunResult {
    pub plan_id: Option<String>,
    pub kind: Option<String>,
    pub success: bool,
    pub message: String,
    pub members: Vec<BookingMemberResult>,
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingLock {
    pub plan_id: String,
    pub seat_id: String,
    pub seat_num: String,
    pub begin_seconds: i64,
    pub duration_hours: i64,
    /// 锁座是否真的生效（`DATA.result=success`）。**仅供日志展示**：
    /// 实测空闲座位也返回 `result=fail`，故 `locked=false` 的 seatId 依然可用、
    /// 依然会被正式预约消费（docs/HUITU-LIMITS.md §3）。
    pub locked: bool,
}

#[derive(Debug, Clone, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookingLockResult {
    pub plan_id: Option<String>,
    pub kind: Option<String>,
    pub success: bool,
    pub message: String,
    pub locks: Vec<BookingLock>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub terminal: bool,
}
