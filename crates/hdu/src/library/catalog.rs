use super::parse::*;
use super::*;

impl LibraryClient {
    pub async fn room_types(&self) -> Result<Vec<RoomType>, HduError> {
        let body = self
            .request_json(
                "/Space/Category/list?LAB_JSON=1",
                Method::GET,
                None,
                Vec::new(),
            )
            .await?;
        let items = [body.get("content"), body.get("data"), body.get("DATA")]
            .into_iter()
            .flatten()
            .find_map(find_non_empty_default_items)
            .ok_or_else(|| HduError::Library("房间类型解析失败".into()))?;
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            let name = item.get("name").map(value_to_string).unwrap_or_default();
            let url = item
                .get("link")
                .map(|link| {
                    if let Some(text) = link.as_str() {
                        text.to_string()
                    } else {
                        link.get("url").map(value_to_string).unwrap_or_default()
                    }
                })
                .unwrap_or_default();
            let query = url
                .split_once('?')
                .map(|(_, query)| query)
                .ok_or_else(|| HduError::Library("房间类型链接解析失败".into()))?;
            let query = percent_decode_str(query)
                .decode_utf8()
                .map_err(|_| HduError::Library("房间类型链接解析失败".into()))?
                .to_string();
            out.push(RoomType { name, query });
        }
        Ok(out)
    }

    pub async fn booking_range(&self, room_query: &str) -> Result<BookingRange, HduError> {
        let body = self
            .request_json(
                &format!("/Seat/Index/searchSeats?{room_query}&LAB_JSON=1"),
                Method::GET,
                None,
                Vec::new(),
            )
            .await?;
        let range = body
            .get("data")
            .and_then(|data| data.get("range"))
            .ok_or_else(|| HduError::Library("预约时间范围解析失败".into()))?;
        Ok(BookingRange {
            min_begin_time: range.get("minBeginTime").map(value_to_i64).unwrap_or(0),
            max_end_time: range.get("maxEndTime").map(value_to_i64).unwrap_or(0),
            min_duration: range.get("min_duration").map(value_to_i64).unwrap_or(1),
            max_duration: range.get("max_duration").map(value_to_i64).unwrap_or(0),
        })
    }

    pub async fn floors(
        &self,
        room_query: &str,
        lookup_time: DateTime<Utc>,
        duration_hours: i64,
    ) -> Result<Vec<Value>, HduError> {
        let category = self.lookup_category(room_query).await?;
        let form = vec![
            ("beginTime".into(), (lookup_time.timestamp()).to_string()),
            ("duration".into(), (duration_hours * 3600).to_string()),
            ("num".into(), "1".into()),
            ("space_category[category_id]".into(), category.category_id),
            ("space_category[content_id]".into(), category.content_id),
        ];
        let body = self
            .request_json(
                "/Seat/Index/searchSeats?LAB_JSON=1",
                Method::POST,
                Some(form),
                Vec::new(),
            )
            .await?;
        let floors = body
            .get("allContent")
            .and_then(|all| all.get("children"))
            .and_then(|children| children.get(2))
            .and_then(|container| container.get("children"))
            .and_then(|container| container.get("children"))
            .and_then(Value::as_array)
            .ok_or_else(|| HduError::Library("座位图解析失败".into()))?;
        Ok(floors.clone())
    }

    async fn lookup_category(&self, room_query: &str) -> Result<Category, HduError> {
        if let Some(category) = self
            .categories
            .lock()
            .expect("category cache poisoned")
            .get(room_query)
            .cloned()
        {
            return Ok(category);
        }
        let body = self
            .request_json(
                &format!("/Seat/Index/searchSeats?{room_query}&LAB_JSON=1"),
                Method::GET,
                None,
                Vec::new(),
            )
            .await?;
        let category = body
            .get("data")
            .and_then(|data| data.get("space_category"))
            .ok_or_else(|| HduError::Library("房间详情解析失败".into()))?;
        let category_id = category
            .get("category_id")
            .map(value_to_string)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| HduError::Library("房间详情解析失败".into()))?;
        let category = Category {
            category_id,
            content_id: category
                .get("content_id")
                .map(value_to_string)
                .unwrap_or_default(),
        };
        self.categories
            .lock()
            .expect("category cache poisoned")
            .insert(room_query.to_string(), category.clone());
        Ok(category)
    }
}
