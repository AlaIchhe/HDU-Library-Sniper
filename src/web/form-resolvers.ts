import type { FieldErrors, FieldValues, Resolver } from "react-hook-form"

export interface LoginFormValues {
  studentId: string
  password: string
}

export interface PlanFormValues {
  roomType: string
  roomQuery: string
  floorId: number
  floorName?: string
  seatNum: string
  fallback?: string
  startHour: string
  duration: string
  weekdays: string[]
}

export interface GroupFormValues {
  name: string
  ids: string[]
}

function makeResolver<T extends FieldValues>(
  validate: (values: T) => { data: T; errors: FieldErrors<T> },
): Resolver<T> {
  return async (values) => {
    const { data, errors } = validate(values)
    return Object.keys(errors).length === 0 ? { values: data, errors: {} } : { values: {}, errors }
  }
}

export const loginResolver = makeResolver<LoginFormValues>((raw) => {
  const studentId = raw.studentId.trim()
  const errors: FieldErrors<LoginFormValues> = {}
  if (!studentId) errors.studentId = { type: "required", message: "请输入学号" }
  if (!raw.password) errors.password = { type: "required", message: "请输入密码" }
  return { data: { studentId, password: raw.password }, errors }
})

export const planResolver = makeResolver<PlanFormValues>((raw) => {
  const floorId = Number(raw.floorId)
  const seatNum = raw.seatNum.trim()
  const errors: FieldErrors<PlanFormValues> = {}
  if (!raw.roomType) errors.roomType = { type: "required", message: "请选择房间类型" }
  if (!raw.roomQuery) errors.roomQuery = { type: "required", message: "请选择房间类型" }
  if (!Number.isInteger(floorId) || floorId <= 0) {
    errors.floorId = { type: "validate", message: "请选择楼层" }
  }
  if (!seatNum) errors.seatNum = { type: "required", message: "请输入座位号" }
  if (!raw.startHour) errors.startHour = { type: "required", message: "请选择开始时间" }
  if (!raw.duration) errors.duration = { type: "required", message: "请选择时长" }
  if (raw.weekdays.length < 1) errors.weekdays = { type: "minLength", message: "至少选择一个星期" }
  return { data: { ...raw, floorId, seatNum }, errors }
})

export const groupResolver = makeResolver<GroupFormValues>((raw) => {
  const name = raw.name.trim()
  const errors: FieldErrors<GroupFormValues> = {}
  if (!name) errors.name = { type: "required", message: "请输入组合名称" }
  if (raw.ids.length < 2) errors.ids = { type: "minLength", message: "至少选择两个方案" }
  return { data: { name, ids: raw.ids }, errors }
})
