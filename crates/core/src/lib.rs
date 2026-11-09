//! 领域类型、时间基准、方案校验与 JSON 取值助手。

pub mod json;
pub mod plan;
pub mod time;
pub mod types;

pub use plan::{valid_weekdays, validate_plan};
pub use time::{
    booking_anchor_delay_seconds, booking_day_offset_for, booking_prelock_delay_seconds,
    next_booking_anchor, shanghai_seconds_of_day, BOOKING_DAY_OFFSET, BOOKING_PRELOCK_LEAD_SECONDS,
};
pub use types::*;
