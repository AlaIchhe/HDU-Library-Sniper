"use client"

import { useState } from "react"
import { IconCheck } from "@tabler/icons-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"

import { MultipleSelect } from "@/ui/multiple-select"
import { Button } from "@/ui/button"
import { DialogClose, DialogFooter } from "@/ui/dialog"
import { Field, FieldLabel, FormError } from "@/ui/field"
import { Form } from "@/ui/form"
import { Input } from "@/ui/input"
import { toastManager } from "@/ui/toast"
import type { BookingPlan, Weekday } from "../../../shared/types"
import { weekdayLabels } from "../../../shared/types"
import { useDurations, useFloors, usePlanMutations, useRoomTypes } from "../../data/queries"
import { planSchema } from "../../shared"

import { SearchableField, SelectField } from "./fields"

export function PlanEditor({ initial, onClose }: { initial?: BookingPlan; onClose: () => void }) {
  const mutations = usePlanMutations()
  const roomTypes = useRoomTypes()
  const form = useForm<z.input<typeof planSchema>, undefined, z.output<typeof planSchema>>({
    resolver: zodResolver(planSchema),
    defaultValues: {
      roomType: initial?.roomType || "",
      roomQuery: initial?.roomQuery || "",
      floorId: initial?.floorId || 0,
      floorName: initial?.floorName || "",
      seatNum: initial?.seatNum || "",
      fallback: initial?.fallbackSeats.join(", ") || "",
      startHour: initial ? String(initial.startHour) : "",
      duration: initial ? String(initial.durationHours) : "",
      weekdays: initial?.weekdays.map(String) || ["1", "2", "3", "4", "5", "6", "7"],
    },
  })
  const room = form.watch("roomType")
  const hour = form.watch("startHour")
  const duration = form.watch("duration")
  const weekdays = form.watch("weekdays")
  const [roomQuery, setRoomQuery] = useState(initial?.roomQuery || "")
  const effectiveRoomType = room || initial?.roomType || undefined
  const floors = useFloors(roomQuery, effectiveRoomType)
  const durations = useDurations(roomQuery, hour, effectiveRoomType)
  const range = floors.data?.range
  const minStartHour = range?.minBeginTime ?? 0
  const maxStartHour = range ? range.maxEndTime - (duration ? Number(duration) : range.minDuration) : 23
  const startHourOptions = Array.from({ length: Math.max(0, maxStartHour - minStartHour + 1) }, (_, i) => {
    const h = minStartHour + i
    return { value: String(h), label: `${String(h).padStart(2, "0")}:00` }
  })
  const weekdayOptions = (Object.keys(weekdayLabels).map(Number) as Weekday[]).map((day) => ({
    value: String(day),
    label: weekdayLabels[day],
  }))

  async function submit(values: z.infer<typeof planSchema>) {
    const payload = {
      kind: "single" as const,
      roomType: values.roomType,
      roomQuery: values.roomQuery,
      floorId: values.floorId,
      floorName: values.floorName,
      seatNum: values.seatNum,
      fallbackSeats: (values.fallback || "")
        .split(/[,\n，]/)
        .map((item) => item.trim())
        .filter(Boolean),
      startHour: Number(values.startHour),
      durationHours: Number(values.duration),
      weekdays: values.weekdays.map(Number) as Weekday[],
      enabled: initial?.enabled || false,
    }
    if (initial) await mutations.update.mutateAsync({ id: initial.id, patch: payload })
    else await mutations.create.mutateAsync(payload)
    toastManager.add({ type: "success", title: initial ? "方案已更新" : "方案已创建" })
    onClose()
  }

  return (
    <Form onSubmit={form.handleSubmit(submit)} className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <SearchableField
          label="房间类型"
          value={room}
          onChange={(value) => {
            const item = roomTypes.data?.options.find((option) => option.name === value)
            form.setValue("roomType", value, { shouldValidate: true })
            form.setValue("roomQuery", item?.query || "")
            form.setValue("floorId", 0)
            setRoomQuery(item?.query || "")
          }}
          placeholder="选择房间类型"
          options={roomTypes.data?.options.map((item) => ({ value: item.name, label: item.name })) || []}
          disabled={roomTypes.isLoading}
          error={form.formState.errors.roomType?.message}
          onOpenChange={(open) => {
            // 桌面端没有刷新概念：网络恢复后展开下拉即自动重试失败的查询
            if (open && roomTypes.isError) void roomTypes.refetch()
          }}
          emptyText={
            roomTypes.isFetching
              ? "正在加载房间类型…"
              : roomTypes.isError
                ? "房间类型加载失败，重新展开将自动重试"
                : "没有匹配项"
          }
        />
        <div className="grid gap-1">
          <SelectField
            label="楼层"
            value={String(form.watch("floorId") || "")}
            onChange={(value) => {
              const floor = floors.data?.options.find((item) => String(item.id) === value)
              form.setValue("floorId", Number(value), { shouldValidate: true })
              form.setValue("floorName", floor?.name || "")
            }}
            placeholder="选择楼层"
            options={
              floors.data?.options.map((item) => ({
                value: String(item.id),
                label: item.name,
                detail: `${item.seatCount} 个座位`,
              })) || []
            }
            disabled={!roomQuery || floors.isLoading}
            error={form.formState.errors.floorId?.message}
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
          <Input {...form.register("seatNum")} disabled={!form.watch("floorId")} />
          {form.formState.errors.seatNum?.message && (
            <FormError>{form.formState.errors.seatNum.message}</FormError>
          )}
        </Field>
        <Field>
          <FieldLabel>备选座位</FieldLabel>
          <Input {...form.register("fallback")} placeholder="例如：299, 300" />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <SelectField
          label="开始时间"
          value={hour}
          onChange={(value) => {
            form.setValue("startHour", value, { shouldValidate: true })
            form.setValue("duration", "")
          }}
          placeholder="选择时间"
          options={startHourOptions}
          error={form.formState.errors.startHour?.message}
        />
        <SelectField
          label="时长"
          value={duration}
          onChange={(value) => {
            form.setValue("duration", value, { shouldValidate: true })
            const maxStart = range ? range.maxEndTime - Number(value) : 23
            if (hour !== "" && Number(hour) > maxStart) {
              form.setValue("startHour", "", { shouldValidate: true })
            }
          }}
          placeholder="选择时长"
          options={
            durations.data?.options.map((value) => ({ value: String(value), label: `${value} 小时` })) || []
          }
          disabled={!hour || durations.isLoading}
          error={form.formState.errors.duration?.message}
        />
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
        <Button
          type="submit"
          loading={form.formState.isSubmitting || mutations.create.isPending || mutations.update.isPending}
        >
          <IconCheck className="size-4" />
          保存方案
        </Button>
      </DialogFooter>
    </Form>
  )
}
