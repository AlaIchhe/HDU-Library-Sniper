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
