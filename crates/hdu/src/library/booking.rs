use super::parse::*;
use super::*;

impl LibraryClient {
    pub async fn bookings(&self) -> Result<Vec<Value>, HduError> {
        let body = self
            .request_json(
                "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1",
                Method::GET,
                None,
                Vec::new(),
                READ_TIMEOUT,
            )
            .await?;
        body.get("content")
            .and_then(|content| content.get("defaultItems"))
            .and_then(Value::as_array)
            .cloned()
            .ok_or_else(|| HduError::Library("预约列表解析失败".into()))
    }

    pub async fn book_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        let uid = self.uid();
        if uid.is_empty() {
            return Err(HduError::AuthenticationExpired("缺少用户 UID".into()));
        }
        let begin = begin_time.timestamp();
        let duration = duration_hours * 3600;
        let api_time = Utc::now().timestamp();
        let form = vec![
            ("beginTime".into(), begin.to_string()),
            ("duration".into(), duration.to_string()),
            ("is_recommend".into(), "0".into()),
            ("api_time".into(), api_time.to_string()),
            ("seats[0]".into(), seat_id.to_string()),
            ("seatBookers[0]".into(), uid.clone()),
        ];
        let token = api_token(seat_id, &uid, begin, duration, api_time);
        self.request_json(
            "/Seat/Index/bookSeats?LAB_JSON=1",
            Method::POST,
            Some(form),
            vec![("Api-Token".into(), token)],
            WRITE_TIMEOUT,
        )
        .await
    }

    pub async fn lock_seat(
        &self,
        seat_id: &str,
        begin_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Value, HduError> {
        let begin = begin_time.timestamp();
        let duration = duration_hours * 3600;
        let form = vec![
            ("beginTime".into(), begin.to_string()),
            ("duration".into(), duration.to_string()),
            ("is_recommend".into(), "0".into()),
            ("api_time".into(), Utc::now().timestamp().to_string()),
            ("seats[0]".into(), seat_id.to_string()),
        ];
        self.request_json(
            "/Seat/Index/lockSeats?LAB_JSON=1",
            Method::POST,
            Some(form),
            Vec::new(),
            WRITE_TIMEOUT,
        )
        .await
    }

    pub async fn unlock_all_seats(&self) -> Result<Value, HduError> {
        self.request_json(
            "/Seat/Index/unlockAllSeats?LAB_JSON=1",
            Method::POST,
            None,
            Vec::new(),
            WRITE_TIMEOUT,
        )
        .await
    }

    pub async fn action(&self, action: Action, booking_id: &str) -> Result<Value, HduError> {
        let encoded_id = urlencoding::encode(booking_id);
        if action == Action::Leave {
            let latest = self
                .request_json(
                    &format!(
                        "/Seat/Index/stepOutLatestComeBackTime?bookingId={encoded_id}&LAB_JSON=1"
                    ),
                    Method::POST,
                    None,
                    Vec::new(),
                    WRITE_TIMEOUT,
                )
                .await?;
            assert_action_success(&latest)?;
            let come_back_time = latest
                .get("DATA")
                .and_then(|data| data.get("latest_come_back_time"))
                .map(value_to_i64)
                .unwrap_or(0);
            if come_back_time <= 0 {
                return Err(HduError::Library("无法获取暂离返回时间".into()));
            }
            let body = self
                .request_json(
                    &format!("/Seat/Index/stepOut?bookingId={encoded_id}&LAB_JSON=1"),
                    Method::POST,
                    Some(vec![("comeBackTime".into(), come_back_time.to_string())]),
                    Vec::new(),
                    WRITE_TIMEOUT,
                )
                .await?;
            assert_action_success(&body)?;
            return Ok(body);
        }
        let endpoint = match action {
            Action::Cancel => "/Seat/Index/cancelBooking",
            Action::CheckIn => "/Seat/Index/checkIn",
            Action::ComeBack => "/Seat/Index/comeBack",
            Action::SignOut => "/Seat/Index/checkOut",
            Action::Leave => unreachable!(),
        };
        let body = self
            .request_json(
                &format!("{endpoint}?bookingId={encoded_id}&LAB_JSON=1"),
                Method::POST,
                None,
                Vec::new(),
                WRITE_TIMEOUT,
            )
            .await?;
        assert_action_success(&body)?;
        Ok(body)
    }
}
