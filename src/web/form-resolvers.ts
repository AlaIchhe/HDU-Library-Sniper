import { type ChangeEvent, type FormEvent, useCallback, useRef, useState } from "react"

export interface LoginFormValues {
  studentId: string
  password: string
}

export interface PlanSlotFormValues {
  id?: string
  roomType: string
  roomQuery: string
  floorId: number
  floorName?: string
  seatNum: string
  fallback?: string
  startHour: string
  duration: string
}

export interface PlanFormValues {
  name: string
  slots: PlanSlotFormValues[]
  weekdays: string[]
}

type FieldError = { type: string; message: string }
type FieldErrors<T extends object> = Partial<Record<keyof T, FieldError>>
type ResolverResult<T extends object> =
  | { values: T; errors: FieldErrors<T> }
  | { values: Record<string, never>; errors: FieldErrors<T> }

type Resolver<T extends object> = (
  values: T,
  context?: unknown,
  options?: unknown,
) => Promise<ResolverResult<T>>

export function useForm<T extends object>({
  resolver,
  defaultValues,
}: {
  resolver: Resolver<T>
  defaultValues: T
}) {
  const [values, setValues] = useState<T>(defaultValues)
  const [errors, setErrors] = useState<FieldErrors<T>>({})
  const [isSubmitting, setIsSubmitting] = useState(false)
  const valuesRef = useRef<T>(defaultValues)
  const submittedRef = useRef(false)
  const fieldNonceRef = useRef<Partial<Record<keyof T, number>>>({})

  const validateField = useCallback(
    async <K extends keyof T>(name: K, snapshot: T) => {
      const nonce = (fieldNonceRef.current[name] ?? 0) + 1
      fieldNonceRef.current[name] = nonce
      const result = await resolver(snapshot)
      if (fieldNonceRef.current[name] !== nonce) return
      const nextError = result.errors[name]
      setErrors((prev) => {
        if (nextError) return { ...prev, [name]: nextError }
        if (!(name in prev)) return prev
        const next = { ...prev }
        delete next[name]
        return next
      })
    },
    [resolver],
  )

  const setValue = useCallback(
    <K extends keyof T>(name: K, value: T[K], options?: { shouldValidate?: boolean }) => {
      const nextValues = { ...valuesRef.current, [name]: value }
      valuesRef.current = nextValues
      setValues(nextValues)
      if (options?.shouldValidate || submittedRef.current) {
        void validateField(name, nextValues)
      }
    },
    [validateField],
  )

  const register = useCallback(
    <K extends keyof T>(name: K) => ({
      name: String(name),
      value: String(values[name] ?? ""),
      onChange: (event: ChangeEvent<HTMLInputElement>) => {
        setValue(name, event.target.value as T[K])
      },
    }),
    [values, setValue],
  )

  const handleSubmit = useCallback(
    (onValid: (data: T) => unknown) => async (event?: FormEvent<HTMLFormElement>) => {
      event?.preventDefault()
      submittedRef.current = true
      setIsSubmitting(true)
      try {
        const result = await resolver(valuesRef.current)
        if (Object.keys(result.errors).length > 0) {
          setErrors(result.errors)
          return
        }
        setErrors({})
        await onValid(result.values as T)
      } finally {
        setIsSubmitting(false)
      }
    },
    [resolver],
  )

  return {
    values,
    register,
    setValue,
    handleSubmit,
    formState: { errors, isSubmitting },
  }
}

function makeResolver<T extends object>(
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
  const name = raw.name.trim()
  const errors: FieldErrors<PlanFormValues> = {}
  if (raw.slots.length === 0) {
    errors.slots = { type: "minLength", message: "至少添加一个预约时段" }
  }
  if (raw.slots.length > 1 && !name) {
    errors.name = { type: "required", message: "多时段方案请输入方案名称" }
  }
  const normalizedSlots: PlanSlotFormValues[] = []
  for (let i = 0; i < raw.slots.length; i++) {
    const slot = raw.slots[i]
    const prefix = raw.slots.length > 1 ? `时段 ${i + 1}：` : ""
    const floorId = Number(slot.floorId)
    const seatNum = slot.seatNum.trim()
    if (!slot.roomType || !slot.roomQuery) {
      errors.slots ??= { type: "required", message: `${prefix}请选择房间类型` }
    } else if (!Number.isInteger(floorId) || floorId <= 0) {
      errors.slots ??= { type: "validate", message: `${prefix}请选择楼层` }
    } else if (!seatNum) {
      errors.slots ??= { type: "required", message: `${prefix}请输入座位号` }
    } else if (!slot.startHour) {
      errors.slots ??= { type: "required", message: `${prefix}请选择开始时间` }
    } else if (!slot.duration) {
      errors.slots ??= { type: "required", message: `${prefix}请选择时长` }
    }
    normalizedSlots.push({ ...slot, floorId, seatNum })
  }
  if (!errors.slots && normalizedSlots.length > 1) {
    const sorted = [...normalizedSlots].sort((a, b) => Number(a.startHour) - Number(b.startHour))
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1]
      if (Number(prev.startHour) + Number(prev.duration) > Number(sorted[i].startHour)) {
        errors.slots = { type: "validate", message: "方案内各时段不能重叠" }
        break
      }
    }
  }
  if (raw.weekdays.length < 1) {
    errors.weekdays = { type: "minLength", message: "至少选择一个星期" }
  }
  return { data: { name, slots: normalizedSlots, weekdays: raw.weekdays }, errors }
})
