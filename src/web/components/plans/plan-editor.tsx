"use client"

import { useMemo } from "react"

import { AnimateIcon, Check, Plus, Trash2 } from "@/ui/icons"
import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { DialogClose, DialogFooter } from "@/ui/dialog"
import { Field, FieldLabel, FormError } from "@/ui/field"
import { Form } from "@/ui/form"
import { Input } from "@/ui/input"
import { MultipleSelect } from "@/ui/multiple-select"
import { toastManager } from "@/ui/toast"
import type { BookingPlan, Weekday } from "../../../shared/types"
import { weekdayLabels } from "../../../shared/types"
import { useDurations, useFloors, usePlanMutations, useRoomTypes } from "../../data/queries"
import { type PlanFormValues, type PlanSlotFormValues, planResolver, useForm } from "../../shared"

import { SearchableField, SelectField } from "./fields"

function emptySlot(): PlanSlotFormValues {
  return {
    roomType: "",
    roomQuery: "",
    floorId: 0,
    floorName: "",
    seatNum: "",
    fallback: "",
    startHour: "",
    duration: "",
  }
}

function SlotFields({
  index,
  total,
  slot,
  roomTypeOptions,
  roomTypesLoading,
  roomTypesFetching,
  roomTypesError,
  onRefetchRoomTypes,
  roomTypesList,
  onChange,
  onRemove,
}: {
  index: number
  total: number
  slot: PlanSlotFormValues
  roomTypeOptions: { value: string; label: string }[]
  roomTypesLoading: boolean
  roomTypesFetching: boolean
  roomTypesError: boolean
  onRefetchRoomTypes: () => void
  roomTypesList: { name: string; query: string }[]
  onChange: (next: PlanSlotFormValues) => void
  onRemove?: () => void
}) {
  const effectiveRoomType = slot.roomType || undefined
  const floors = useFloors(slot.roomQuery, effectiveRoomType)
  const durations = useDurations(slot.roomQuery, slot.startHour, effectiveRoomType)
  const range = floors.data?.range
  const minStartHour = range?.minBeginTime ?? 0
  const maxStartHour = range
    ? range.maxEndTime - (slot.duration ? Number(slot.duration) : range.minDuration)
    : 23
  const startHourOptions = Array.from({ length: Math.max(0, maxStartHour - minStartHour + 1) }, (_, i) => {
    const h = minStartHour + i
    return { value: String(h), label: `${String(h).padStart(2, "0")}:00` }
  })

  return (
    <div className={total > 1 ? "grid gap-4 rounded-xl border bg-muted/20 p-4" : "grid gap-4"}>
      {total > 1 ? (
        <div className="flex items-center justify-between gap-2">
          <Badge variant="secondary">时段 {index + 1}</Badge>
          {onRemove ? (
            <AnimateIcon animateOnHover asChild>
              <Button type="button" size="xs" variant="ghost" className="text-destructive" onClick={onRemove}>
                <Trash2 className="size-3.5" />
                移除
              </Button>
            </AnimateIcon>
          ) : null}
        </div>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <SearchableField
          label="房间类型"
          value={slot.roomType}
          onChange={(value) => {
            const item = roomTypesList.find((option) => option.name === value)
            onChange({
              ...slot,
              roomType: value,
              roomQuery: item?.query || "",
              floorId: 0,
              floorName: "",
              startHour: "",
              duration: "",
            })
          }}
          placeholder="选择房间类型"
          options={roomTypeOptions}
          disabled={roomTypesLoading}
          onOpenChange={(open) => {
            if (open && roomTypesError) onRefetchRoomTypes()
          }}
          emptyText={
            roomTypesFetching
              ? "正在加载房间类型…"
              : roomTypesError
                ? "房间类型加载失败，重新展开将自动重试"
                : "没有匹配项"
          }
        />
        <div className="grid gap-1">
          <SelectField
            label="楼层"
            value={String(slot.floorId || "")}
            onChange={(value) => {
              const floor = floors.data?.options.find((item) => String(item.id) === value)
              onChange({
                ...slot,
                floorId: Number(value),
                floorName: floor?.name || "",
              })
            }}
            placeholder="选择楼层"
            options={
              floors.data?.options.map((item) => ({
                value: String(item.id),
                label: item.name,
                detail: `${item.seatCount} 个座位`,
              })) || []
            }
            disabled={!slot.roomQuery || floors.isLoading}
          />
          {floors.error && (
            <p className="text-sm text-destructive">
              {floors.error instanceof Error ? floors.error.message : "楼层加载失败"}
            </p>
          )}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel>座位号</FieldLabel>
          <Input
            value={slot.seatNum}
            onChange={(e) => onChange({ ...slot, seatNum: e.target.value })}
            disabled={!slot.floorId}
          />
        </Field>
        <Field>
          <FieldLabel>备选座位</FieldLabel>
          <Input
            value={slot.fallback || ""}
            onChange={(e) => onChange({ ...slot, fallback: e.target.value })}
            placeholder="例如：299, 300"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="开始时间"
          value={slot.startHour}
          onChange={(value) => onChange({ ...slot, startHour: value, duration: "" })}
          placeholder="选择时间"
          options={startHourOptions}
        />
        <SelectField
          label="时长"
          value={slot.duration}
          onChange={(value) => {
            const maxStart = range ? range.maxEndTime - Number(value) : 23
            const nextStart = slot.startHour !== "" && Number(slot.startHour) > maxStart ? "" : slot.startHour
            onChange({ ...slot, startHour: nextStart, duration: value })
          }}
          placeholder="选择时长"
          options={
            durations.data?.options.map((value) => ({ value: String(value), label: `${value} 小时` })) || []
          }
          disabled={!slot.startHour || durations.isLoading}
        />
      </div>
    </div>
  )
}

export function PlanEditor({ initial, onClose }: { initial?: BookingPlan; onClose: () => void }) {
  const mutations = usePlanMutations()
  const roomTypes = useRoomTypes()
  const roomTypesList = roomTypes.data?.options || []
  const roomTypeOptions = useMemo(
    () => roomTypesList.map((item) => ({ value: item.name, label: item.name })),
    [roomTypesList],
  )
  const form = useForm<PlanFormValues>({
    resolver: planResolver,
    defaultValues: {
      name: initial?.name || "",
      slots: initial?.slots.length
        ? initial.slots.map((s) => ({
            id: s.id,
            roomType: s.roomType,
            roomQuery: s.roomQuery,
            floorId: s.floorId,
            floorName: s.floorName,
            seatNum: s.seatNum,
            fallback: s.fallbackSeats.join(", "),
            startHour: String(s.startHour),
            duration: String(s.durationHours),
          }))
        : [emptySlot()],
      weekdays: initial?.weekdays.map(String) || ["1", "2", "3", "4", "5", "6", "7"],
    },
  })
  const { slots, weekdays } = form.values
  const weekdayOptions = (Object.keys(weekdayLabels).map(Number) as Weekday[]).map((day) => ({
    value: String(day),
    label: weekdayLabels[day],
  }))

  function updateSlot(index: number, next: PlanSlotFormValues) {
    const copy = [...slots]
    copy[index] = next
    form.setValue("slots", copy, { shouldValidate: true })
  }

  function addSlot() {
    form.setValue("slots", [...slots, emptySlot()], { shouldValidate: false })
  }

  function removeSlot(index: number) {
    if (slots.length <= 1) return
    form.setValue(
      "slots",
      slots.filter((_, i) => i !== index),
      { shouldValidate: true },
    )
  }

  async function submit(values: PlanFormValues) {
    const payload = {
      name: values.name || values.slots[0]?.roomType || "",
      slots: values.slots.map((s) => ({
        id: s.id,
        roomType: s.roomType,
        roomQuery: s.roomQuery,
        floorId: s.floorId,
        floorName: s.floorName || "",
        seatNum: s.seatNum,
        fallbackSeats: (s.fallback || "")
          .split(/[,\n，]/)
          .map((item) => item.trim())
          .filter(Boolean),
        startHour: Number(s.startHour),
        durationHours: Number(s.duration),
      })),
      weekdays: values.weekdays.map(Number) as Weekday[],
      enabled: initial?.enabled || false,
    }
    try {
      if (initial) await mutations.update.mutateAsync({ id: initial.id, patch: payload })
      else await mutations.create.mutateAsync(payload)
      toastManager.add({ type: "success", title: initial ? "方案已更新" : "方案已创建" })
      onClose()
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: cause instanceof Error ? cause.message : "方案保存失败",
      })
    }
  }

  return (
    <Form onSubmit={form.handleSubmit(submit)} className="grid gap-5">
      <Field>
        <FieldLabel>方案名称{slots.length === 1 ? "（可选）" : ""}</FieldLabel>
        <Input
          {...form.register("name")}
          placeholder={slots.length === 1 ? "留空则默认使用房间类型" : "例如：全天自习"}
        />
        {form.formState.errors.name?.message && <FormError>{form.formState.errors.name.message}</FormError>}
      </Field>

      <div className="grid gap-3">
        {slots.map((slot, index) => (
          <SlotFields
            key={slot.id || `slot-${index}`}
            index={index}
            total={slots.length}
            slot={slot}
            roomTypeOptions={roomTypeOptions}
            roomTypesLoading={roomTypes.isLoading}
            roomTypesFetching={roomTypes.isFetching}
            roomTypesError={roomTypes.isError}
            onRefetchRoomTypes={() => void roomTypes.refetch()}
            roomTypesList={roomTypesList}
            onChange={(next) => updateSlot(index, next)}
            onRemove={slots.length > 1 ? () => removeSlot(index) : undefined}
          />
        ))}
        {form.formState.errors.slots?.message && <FormError>{form.formState.errors.slots.message}</FormError>}
        <div>
          <AnimateIcon animateOnHover asChild>
            <Button type="button" size="sm" variant="outline" onClick={addSlot}>
              <Plus className="size-3.5" />
              添加时段
            </Button>
          </AnimateIcon>
        </div>
      </div>

      <Field>
        <FieldLabel>重复日期</FieldLabel>
        <MultipleSelect
          options={weekdayOptions}
          value={weekdays}
          onChange={(values) => form.setValue("weekdays", values, { shouldValidate: true })}
          placeholder="请选择重复日期"
        />
        {form.formState.errors.weekdays?.message && (
          <FormError>{form.formState.errors.weekdays.message}</FormError>
        )}
      </Field>
      <DialogFooter variant="bare" className="px-0">
        <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
        <AnimateIcon animateOnHover asChild>
          <Button
            type="submit"
            loading={form.formState.isSubmitting || mutations.create.isPending || mutations.update.isPending}
          >
            <Check className="size-4" />
            保存方案
          </Button>
        </AnimateIcon>
      </DialogFooter>
    </Form>
  )
}
