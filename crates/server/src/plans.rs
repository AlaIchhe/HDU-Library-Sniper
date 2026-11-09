use std::collections::HashSet;

use chrono::{SecondsFormat, Utc};
use hdu_sniper_core::{
    valid_weekdays, validate_plan, BookingGroup, BookingPlan, PlanKind, PlanListItem, Weekday,
};
use hdu_sniper_store::{Store, StoreError};
use serde::Deserialize;
use uuid::Uuid;

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanInput {
    pub id: Option<String>,
    pub room_type: Option<String>,
    pub room_query: Option<String>,
    pub floor_id: Option<i64>,
    pub floor_name: Option<String>,
    pub seat_num: Option<String>,
    pub fallback_seats: Option<Vec<String>>,
    pub start_hour: Option<i64>,
    pub duration_hours: Option<i64>,
    pub weekdays: Option<Vec<i64>>,
    pub enabled: Option<bool>,
    pub created_at: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupInput {
    pub name: Option<String>,
    pub member_plan_ids: Option<Vec<String>>,
}

#[derive(Debug, thiserror::Error)]
pub enum PlanError {
    #[error("{0}")]
    NotFound(String),
    #[error("{0}")]
    Conflict(String),
    #[error("{0}")]
    Invalid(String),
    #[error("database: {0}")]
    Store(#[from] StoreError),
}

impl PlanError {
    pub fn status(&self) -> u16 {
        match self {
            Self::NotFound(_) => 404,
            Self::Conflict(_) => 409,
            Self::Invalid(_) => 400,
            Self::Store(_) => 500,
        }
    }
}

fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true)
}

fn all_weekdays() -> Vec<i64> {
    (1..=7).collect()
}

fn normalize_text(value: Option<String>) -> String {
    value.unwrap_or_default().trim().to_string()
}

fn normalize_seats(values: Option<Vec<String>>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for value in values.unwrap_or_default() {
        let value = value.trim().to_string();
        if !value.is_empty() && seen.insert(value.clone()) {
            out.push(value);
        }
    }
    out
}

fn normalize_weekdays(values: Option<Vec<i64>>) -> Vec<Weekday> {
    valid_weekdays(&values.unwrap_or_else(all_weekdays))
}

fn build_new_plan(input: PlanInput) -> Result<BookingPlan, PlanError> {
    let timestamp = now();
    let plan = BookingPlan {
        id: input
            .id
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| Uuid::new_v4().to_string()),
        kind: PlanKind::Single,
        room_type: normalize_text(input.room_type),
        room_query: normalize_text(input.room_query),
        floor_id: input.floor_id.unwrap_or(0),
        floor_name: normalize_text(input.floor_name),
        seat_num: normalize_text(input.seat_num),
        fallback_seats: normalize_seats(input.fallback_seats),
        start_hour: input.start_hour.unwrap_or(0),
        duration_hours: input.duration_hours.unwrap_or(0),
        weekdays: normalize_weekdays(input.weekdays),
        enabled: input.enabled.unwrap_or(false),
        created_at: input
            .created_at
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| timestamp.clone()),
        updated_at: timestamp,
    };
    let errors = validate_plan(&plan);
    if !errors.is_empty() {
        return Err(PlanError::Invalid(errors.join("；")));
    }
    Ok(plan)
}

fn merge_plan(input: PlanInput, current: &BookingPlan) -> Result<BookingPlan, PlanError> {
    let plan = BookingPlan {
        id: current.id.clone(),
        kind: PlanKind::Single,
        room_type: input
            .room_type
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|| current.room_type.clone()),
        room_query: input
            .room_query
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|| current.room_query.clone()),
        floor_id: input.floor_id.unwrap_or(current.floor_id),
        floor_name: input
            .floor_name
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|| current.floor_name.clone()),
        seat_num: input
            .seat_num
            .map(|value| value.trim().to_string())
            .unwrap_or_else(|| current.seat_num.clone()),
        fallback_seats: input
            .fallback_seats
            .map(|values| normalize_seats(Some(values)))
            .unwrap_or_else(|| current.fallback_seats.clone()),
        start_hour: input.start_hour.unwrap_or(current.start_hour),
        duration_hours: input.duration_hours.unwrap_or(current.duration_hours),
        weekdays: input
            .weekdays
            .map(|values| normalize_weekdays(Some(values)))
            .unwrap_or_else(|| current.weekdays.clone()),
        enabled: input.enabled.unwrap_or(current.enabled),
        created_at: current.created_at.clone(),
        updated_at: now(),
    };
    let errors = validate_plan(&plan);
    if !errors.is_empty() {
        return Err(PlanError::Invalid(errors.join("；")));
    }
    Ok(plan)
}

fn resolve_group_members(store: &Store, ids: &[String]) -> Result<Vec<BookingPlan>, PlanError> {
    if ids.len() < 2 {
        return Err(PlanError::Invalid(
            "组合方案至少需要两个有效单条方案".into(),
        ));
    }
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(PlanError::Invalid("组合方案不能包含重复方案".into()));
    }
    let mut plans = Vec::with_capacity(ids.len());
    for id in ids {
        match store.get_plan(id)? {
            Some(plan) => plans.push(plan),
            None => {
                return Err(PlanError::Invalid(
                    "组合方案至少需要两个有效单条方案".into(),
                ))
            }
        }
    }
    Ok(plans)
}

fn validate_group(
    name: &str,
    ids: &[String],
    plans: &[BookingPlan],
) -> Result<Vec<Weekday>, PlanError> {
    if name.trim().is_empty() {
        return Err(PlanError::Invalid("组合名称不能为空".into()));
    }
    if ids.len() < 2 || plans.len() != ids.len() {
        return Err(PlanError::Invalid(
            "组合方案至少需要两个有效单条方案".into(),
        ));
    }
    if ids.iter().collect::<HashSet<_>>().len() != ids.len() {
        return Err(PlanError::Invalid("组合方案不能包含重复方案".into()));
    }
    let weekdays = plans[0].weekdays.clone();
    if plans.iter().any(|plan| plan.weekdays != weekdays) {
        return Err(PlanError::Invalid(
            "组合内单条方案的重复日期必须一致".into(),
        ));
    }
    for (left_index, left) in plans.iter().enumerate() {
        for right in plans.iter().skip(left_index + 1) {
            if left.start_hour < right.start_hour + right.duration_hours
                && right.start_hour < left.start_hour + left.duration_hours
            {
                return Err(PlanError::Invalid(format!(
                    "方案 {} 与 {} 的预约时间冲突",
                    left.seat_num, right.seat_num
                )));
            }
        }
    }
    Ok(weekdays)
}

pub fn create_plan(store: &Store, input: PlanInput) -> Result<BookingPlan, PlanError> {
    let plan = build_new_plan(input)?;
    Ok(store.save_plan(&plan)?)
}

pub fn update_plan(store: &Store, id: &str, input: PlanInput) -> Result<BookingPlan, PlanError> {
    let current = store
        .get_plan(id)?
        .ok_or_else(|| PlanError::NotFound("方案不存在".into()))?;
    let updated = merge_plan(input, &current)?;
    // A plan that belongs to a group must still fit the group's time rules.
    for item in store.list_plan_items()? {
        let PlanListItem::Group(group) = item else {
            continue;
        };
        if !group.member_plan_ids.iter().any(|member| member == id) {
            continue;
        }
        let members = group
            .member_plan_ids
            .iter()
            .map(|member| {
                if member == id {
                    Ok(updated.clone())
                } else {
                    store.get_plan(member)?.ok_or_else(|| {
                        PlanError::Invalid("组合方案至少需要两个有效单条方案".into())
                    })
                }
            })
            .collect::<Result<Vec<_>, PlanError>>()?;
        validate_group(&group.name, &group.member_plan_ids, &members)?;
    }
    Ok(store.save_plan(&updated)?)
}

pub fn delete_plan_item(store: &Store, id: &str) -> Result<(), PlanError> {
    let item = store
        .get_plan_item(id)?
        .ok_or_else(|| PlanError::NotFound("方案不存在".into()))?;
    match item {
        PlanListItem::Single(_) => {
            if !store.referenced_plan_ids(id)?.is_empty() {
                return Err(PlanError::Conflict(
                    "该单条方案已被组合引用，请先移出组合".into(),
                ));
            }
            if !store.delete_plan(id)? {
                return Err(PlanError::NotFound("方案不存在".into()));
            }
        }
        PlanListItem::Group(_) => {
            if !store.delete_group(id)? {
                return Err(PlanError::NotFound("方案不存在".into()));
            }
        }
    }
    Ok(())
}

pub fn enable_plan_item(
    store: &Store,
    id: &str,
    enabled: bool,
) -> Result<(PlanListItem, Vec<String>), PlanError> {
    if store.get_plan_item(id)?.is_none() {
        return Err(PlanError::NotFound("方案不存在".into()));
    }
    let disabled = store.set_only_enabled(id, enabled)?;
    let item = store
        .get_plan_item(id)?
        .ok_or_else(|| PlanError::NotFound("方案不存在".into()))?;
    Ok((item, disabled))
}

pub fn create_group(
    store: &Store,
    name: &str,
    member_ids: &[String],
) -> Result<BookingGroup, PlanError> {
    let members = resolve_group_members(store, member_ids)?;
    let weekdays = validate_group(name, member_ids, &members)?;
    let timestamp = now();
    let group = BookingGroup {
        id: Uuid::new_v4().to_string(),
        kind: PlanKind::Group,
        name: name.trim().to_string(),
        member_plan_ids: member_ids.to_vec(),
        members: Some(members),
        weekdays,
        enabled: false,
        created_at: timestamp.clone(),
        updated_at: timestamp,
    };
    store.save_group(&group)?;
    Ok(group)
}

pub fn update_group(
    store: &Store,
    id: &str,
    name: &str,
    member_ids: &[String],
) -> Result<BookingGroup, PlanError> {
    let current = store
        .get_plan_item(id)?
        .ok_or_else(|| PlanError::NotFound("组合方案不存在".into()))?;
    let PlanListItem::Group(current) = current else {
        return Err(PlanError::NotFound("组合方案不存在".into()));
    };
    let members = resolve_group_members(store, member_ids)?;
    let weekdays = validate_group(name, member_ids, &members)?;
    let group = BookingGroup {
        id: current.id,
        kind: PlanKind::Group,
        name: name.trim().to_string(),
        member_plan_ids: member_ids.to_vec(),
        members: Some(members),
        weekdays,
        enabled: current.enabled,
        created_at: current.created_at,
        updated_at: now(),
    };
    store.save_group(&group)?;
    Ok(group)
}
