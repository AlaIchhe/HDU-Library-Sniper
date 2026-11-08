"use client"

import { createContext, useContext, useMemo, useRef, useState } from "react"
import { Reorder, useDragControls, useReducedMotion, type DragControls } from "motion/react"
import {
  IconCalendarEvent,
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconGripVertical,
  IconListCheck,
  IconPencil,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"

import { MultipleSelect } from "@/components/ui/multiple-select"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CheckboxGroup } from "@/components/ui/checkbox-group"
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@/components/ui/combobox"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from "@/components/ui/drawer"
import { Field, FieldDescription, FieldLabel, FormError } from "@/components/ui/field"
import { Form } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { InteractiveHoverButton } from "@/components/ui/interactive-hover-button"
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toastManager } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import type { BookingPlan, BookingGroup, PlanListItem, Weekday } from "../../shared/types"
import { weekdayLabels } from "../../shared/types"
import { useDurations, useFloors, usePlanMutations, usePlans, useRoomTypes } from "../queries"
import { PageHeader, PageShell, Panel } from "./page-layout"
import { useRefreshSignal } from "../store"
import { undoToast } from "../undo-toast"
import { Busy, Failure, groupSchema, NoData, planSchema } from "../shared"

function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  error,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; detail?: string }[]
  placeholder: string
  disabled?: boolean
  error?: string
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        value={value}
        onValueChange={(next) => next && onChange(next)}
        disabled={disabled}
        itemToStringLabel={(item) =>
          options.find((option) => option.value === String(item))?.label ?? String(item ?? "")
        }
      >
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label}>
              {option.label}
              {option.detail && <small className="ms-2 text-muted-foreground">{option.detail}</small>}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {error && <FormError>{error}</FormError>}
    </Field>
  )
}

function SearchableField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  error,
  onOpenChange,
  emptyText = "没有匹配项",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  disabled?: boolean
  error?: string
  onOpenChange?: (open: boolean) => void
  emptyText?: string
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Combobox
        value={value}
        onValueChange={(next) => next !== null && onChange(String(next))}
        itemToStringValue={(item) => String(item ?? "")}
        onOpenChange={onOpenChange}
        disabled={disabled}
      >
        <ComboboxInput placeholder={placeholder} />
        <ComboboxPopup>
          <ComboboxList>
            {options.map((option) => (
              <ComboboxItem key={option.value} value={option.value}>
                {option.label}
              </ComboboxItem>
            ))}
            <ComboboxEmpty>{emptyText}</ComboboxEmpty>
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {error && <FormError>{error}</FormError>}
    </Field>
  )
}

function PlanEditor({ initial, onClose }: { initial?: BookingPlan; onClose: () => void }) {
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
          <FieldDescription>使用逗号或换行分隔</FieldDescription>
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

function SortableRow({
  value,
  index,
  total,
  label,
  onMove,
}: {
  value: string
  index: number
  total: number
  label: string
  onMove: (from: number, to: number) => void
}) {
  // controls 必须在这里创建并交给手柄，手柄才能驱动这一行的拖拽
  const controls = useDragControls()
  const reduced = useReducedMotion()
  // 不用 whileDrag：它结束时要回退到「初始值」，而 boxShadow 没有初始值，
  // 用手柄启动拖拽时会一直卡在放大 + 阴影的状态。改用显式状态给出终点。
  const [dragging, setDragging] = useState(false)

  return (
    <Reorder.Item
      value={value}
      dragListener={false}
      dragControls={controls}
      onDragStart={() => setDragging(true)}
      onDragEnd={() => setDragging(false)}
      animate={{ scale: dragging && !reduced ? 1.02 : 1 }}
      transition={{ type: "spring", stiffness: 500, damping: 32 }}
      className={cn(
        "relative flex items-center gap-2 rounded-lg border bg-card p-2 text-xs transition-shadow duration-200",
        dragging && "z-10 shadow-lg",
      )}
    >
      <DragHandleContext.Provider value={controls}>
        <ReorderHandle label={`拖动排序：${label}`} />
      </DragHandleContext.Provider>
      <Badge variant="secondary">{index + 1}</Badge>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={index === 0}
        aria-label={`上移 ${label}`}
        onClick={() => onMove(index, index - 1)}
      >
        <IconChevronUp />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={index === total - 1}
        aria-label={`下移 ${label}`}
        onClick={() => onMove(index, index + 1)}
      >
        <IconChevronDown />
      </Button>
    </Reorder.Item>
  )
}

/**
 * 拖拽手柄。`Reorder.Item` 用 dragListener={false} 关掉了整行拖动，
 * 只有按在这里才发起拖拽——否则行内的上下移按钮会被误判为拖动。
 *
 * dragControls 由父级 Item 创建后经 context 传进来，手柄自己不调用
 * useDragControls()：那样得到的 controls 与 Item 无关，拖不动。
 */
const DragHandleContext = createContext<DragControls | null>(null)

function ReorderHandle({ label }: { label: string }) {
  const controls = useContext(DragHandleContext)

  return (
    <button
      type="button"
      aria-label={label}
      className="grid size-6 shrink-0 cursor-grab touch-none place-items-center rounded-md text-muted-foreground/60 outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      onPointerDown={(event) => controls?.start(event)}
    >
      <IconGripVertical className="size-3.5" />
    </button>
  )
}

function GroupEditor({
  singles,
  initial,
  onClose,
}: {
  singles: BookingPlan[]
  initial?: BookingGroup
  onClose: () => void
}) {
  const mutations = usePlanMutations()
  const form = useForm<z.infer<typeof groupSchema>>({
    resolver: zodResolver(groupSchema),
    defaultValues: { name: initial?.name || "", ids: initial?.memberPlanIds || [] },
  })
  const ids = form.watch("ids")
  const ordered = ids.map((id) => singles.find((plan) => plan.id === id)).filter(Boolean) as BookingPlan[]

  async function submit(values: z.infer<typeof groupSchema>) {
    try {
      if (initial)
        await mutations.updateGroup.mutateAsync({ id: initial.id, name: values.name, ids: values.ids })
      else await mutations.createGroup.mutateAsync({ name: values.name, ids: values.ids })
      toastManager.add({ type: "success", title: initial ? "组合方案已更新" : "组合方案已创建" })
      onClose()
    } catch (cause) {
      toastManager.add({ type: "error", title: cause instanceof Error ? cause.message : "组合方案保存失败" })
    }
  }

  return (
    <Form onSubmit={form.handleSubmit(submit)} className="grid gap-5">
      <Field>
        <FieldLabel>组合名称</FieldLabel>
        <Input {...form.register("name")} />
        {form.formState.errors.name?.message && <FormError>{form.formState.errors.name.message}</FormError>}
      </Field>
      <Field>
        <FieldLabel>选择单条方案</FieldLabel>
        <CheckboxGroup
          value={ids}
          onValueChange={(values) => form.setValue("ids", values, { shouldValidate: true })}
          className="grid gap-2"
        >
          {singles.map((plan) => {
            return (
              // biome-ignore lint/a11y/noLabelWithoutControl: Checkbox 是 Base UI 组件，label 通过包裹建立关联
              <label key={plan.id} className="flex items-start gap-3 rounded-lg border p-3 text-xs">
                <Checkbox value={plan.id} />
                <span>
                  <strong className="block">
                    {plan.roomType} · 座位 {plan.seatNum}
                  </strong>
                  <small className="text-muted-foreground">
                    {plan.floorName || `楼层 ${plan.floorId}`} · {String(plan.startHour).padStart(2, "0")}:00
                    · {plan.durationHours} 小时
                  </small>
                </span>
              </label>
            )
          })}
        </CheckboxGroup>
        {form.formState.errors.ids?.message && <FormError>{form.formState.errors.ids.message}</FormError>}
      </Field>
      <div className="grid gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <span className="text-sm font-medium">执行顺序</span>
          <span className="text-xs text-muted-foreground">拖动排序，或用箭头微调</span>
        </div>
        {ordered.length ? (
          <Reorder.Group
            axis="y"
            values={ids}
            onReorder={(next) => form.setValue("ids", next, { shouldValidate: true })}
            className="grid gap-2"
          >
            {ordered.map((plan, index) => (
              <SortableRow
                key={plan.id}
                value={plan.id}
                index={index}
                total={ordered.length}
                label={`${plan.roomType} · 座位 ${plan.seatNum}`}
                onMove={(from, to) => {
                  const next = [...ids]
                  ;[next[from], next[to]] = [next[to], next[from]]
                  form.setValue("ids", next, { shouldValidate: true })
                }}
              />
            ))}
          </Reorder.Group>
        ) : (
          <p className="rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
            勾选上方的单条方案后，这里会显示执行顺序。
          </p>
        )}
      </div>
      <DialogFooter variant="bare" className="px-0">
        <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
        <Button type="submit" loading={form.formState.isSubmitting}>
          <IconCheck className="size-4" />
          保存组合
        </Button>
      </DialogFooter>
    </Form>
  )
}

export function PlansPage() {
  const plans = usePlans()
  const mutations = usePlanMutations()
  const [dialog, setDialog] = useState<"type" | "single" | "group" | "edit-single" | "edit-group" | null>(
    null,
  )
  const [selected, setSelected] = useState<PlanListItem>()
  const [deleteTarget, setDeleteTarget] = useState<PlanListItem | null>(null)
  const items = plans.data?.plans || []

  // ⌘K 面板 / `r` 快捷键请求刷新时，重拉方案与「下一次执行」
  useRefreshSignal(() => void plans.refetch())

  const allSingles = useMemo(
    () => items.filter((item): item is BookingPlan => item.kind === "single"),
    [items],
  )
  const available = useMemo(() => {
    const referenced = new Set(
      items.filter((item) => item.kind === "group").flatMap((item) => item.memberPlanIds),
    )
    return allSingles.filter((item) => !referenced.has(item.id))
  }, [allSingles, items])

  // 同一方案的切换在请求返回前只接受一次点击：开关是受控的，
  // 列表刷新前 item.enabled 还是旧值，连点两次会发出两个相同方向的请求。
  const toggleInFlight = useRef(new Set<string>())

  async function toggle(item: PlanListItem, nextEnabled?: boolean) {
    if (toggleInFlight.current.has(item.id)) return
    const enabled = nextEnabled ?? !item.enabled
    // 同时只能启用一个方案：启用新方案时由后端自动停用当前方案。
    // 停用的结果可撤销，所以不做事前确认，而是事后给一个「撤销」入口。
    toggleInFlight.current.add(item.id)
    try {
      const result = await mutations.toggle.mutateAsync({ id: item.id, enabled })

      if (!enabled) {
        toastManager.add({ type: "success", title: "方案已停用" })
        return
      }

      // 把被顶掉的方案还给用户：后端在 disabledPlanIds 里已经说清是哪些
      const displaced = (result?.disabledPlanIds || []).filter((id) => id !== item.id)
      if (!displaced.length) {
        toastManager.add({ type: "success", title: "方案已启用" })
        return
      }

      const names = displaced
        .map((id) => items.find((entry) => entry.id === id))
        .map((entry) =>
          entry?.kind === "group" ? entry.name : entry ? `${entry.roomType} · ${entry.seatNum}` : null,
        )
        .filter((name): name is string => Boolean(name))

      undoToast({
        title:
          names.length === 1
            ? `已启用，之前启用的「${names[0]}」已停用`
            : `已启用，${names.length} 个原方案已停用`,
        onUndo: async () => {
          try {
            // 先停用当前方案再恢复旧的，避免「同时只能启用一个」被破坏
            await mutations.toggle.mutateAsync({ id: item.id, enabled: false })
            for (const id of displaced) {
              await mutations.toggle.mutateAsync({ id, enabled: true })
            }
            toastManager.add({ type: "success", title: "已撤销" })
          } catch (cause) {
            toastManager.add({
              type: "error",
              title: cause instanceof Error ? cause.message : "撤销失败",
            })
          }
        },
      })
    } catch (cause) {
      toastManager.add({ type: "error", title: cause instanceof Error ? cause.message : "状态更新失败" })
    } finally {
      toggleInFlight.current.delete(item.id)
    }
  }

  if (plans.isLoading) return <Busy />
  if (plans.error)
    return (
      <Failure
        message={plans.error instanceof Error ? plans.error.message : "方案加载失败"}
        retry={() => void plans.refetch()}
      />
    )

  return (
    <PageShell>
      <PageHeader
        eyebrow="PLANS"
        title="预约方案"
        description="配置一次预约规则，或按时间顺序组合多个方案。"
        actions={
          // InteractiveHoverButton 自带圆点 + 悬停箭头作为 affordance；
          // children 会被放进一个 inline-block 的 span，再塞图标会让「+」
          // 和文字分成两行。这里只传纯文本，accessible name 保持「创建方案」。
          <InteractiveHoverButton onClick={() => setDialog("type")}>创建方案</InteractiveHoverButton>
        }
      />

      <Panel title="我的计划" description="同时只能启用一个方案，组合方案按成员顺序执行。">
        {items.length ? (
          <Table variant="card">
            <TableHeader className="max-sm:hidden">
              <TableRow>
                <TableHead>方案</TableHead>
                <TableHead className="hidden lg:table-cell">时间</TableHead>
                <TableHead className="hidden lg:table-cell">重复日期</TableHead>
                <TableHead className="text-right">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {items.map((item) => (
                <TableRow
                  key={item.id}
                  className="max-sm:grid max-sm:grid-cols-[minmax(0,1fr)_auto] max-sm:items-center"
                >
                  <TableCell className="min-w-0 max-sm:overflow-hidden">
                    <div className="flex min-w-0 items-center gap-3">
                      <Badge variant={item.kind === "group" ? "info" : "outline"}>
                        {item.kind === "group" ? (
                          <IconCalendarEvent className="size-3" />
                        ) : (
                          <IconListCheck className="size-3" />
                        )}
                        {item.kind === "group" ? "组合" : "单条"}
                      </Badge>
                      <strong className="truncate">
                        {item.kind === "group" ? item.name : `${item.roomType} · 座位 ${item.seatNum}`}
                      </strong>
                    </div>
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {item.kind === "group"
                      ? `${item.memberPlanIds.length} 个方案`
                      : `${item.floorName || `楼层 ${item.floorId}`} · ${String(item.startHour).padStart(
                          2,
                          "0",
                        )}:00 · ${item.durationHours} 小时`}
                  </TableCell>
                  <TableCell className="hidden lg:table-cell">
                    {item.weekdays.map((day) => weekdayLabels[day]).join("、")}
                  </TableCell>
                  <TableCell className="max-sm:ps-0">
                    <div className="flex justify-end gap-2">
                      <Switch
                        checked={item.enabled}
                        onCheckedChange={(checked) => void toggle(item, checked)}
                        disabled={mutations.toggle.isPending}
                        aria-label={item.enabled ? "停用方案" : "启用方案"}
                      />
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => {
                          setSelected(item)
                          setDialog(item.kind === "group" ? "edit-group" : "edit-single")
                        }}
                        aria-label="编辑方案"
                      >
                        <IconPencil />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => setDeleteTarget(item)}
                        aria-label="删除方案"
                      >
                        <IconTrash />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        ) : (
          <NoData
            icon={IconListCheck}
            title="还没有预约方案"
            description="创建方案后启用它，后台会在开放时间自动提交预约。"
            action={
              <Button onClick={() => setDialog("type")}>
                <IconPlus className="size-4" />
                创建第一个方案
              </Button>
            }
          />
        )}
      </Panel>

      <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>删除方案？</AlertDialogTitle>
            <AlertDialogDescription>此操作无法撤销，组合引用关系也会受到影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>取消</AlertDialogClose>
            <Button
              variant="destructive"
              loading={mutations.remove.isPending}
              onClick={async () => {
                if (!deleteTarget) return
                const target = deleteTarget
                try {
                  await mutations.remove.mutateAsync(target.id)
                  setDeleteTarget(null)
                  toastManager.add({ type: "success", title: "方案已删除" })
                } catch (cause) {
                  toastManager.add({
                    type: "error",
                    title: cause instanceof Error ? cause.message : "删除失败",
                  })
                }
              }}
            >
              删除
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>

      <Dialog open={dialog === "type"} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>创建方案</DialogTitle>
            <DialogDescription>选择适合你的预约执行方式</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <div className="grid gap-3 sm:grid-cols-2">
              <Button
                variant="outline"
                className="h-auto sm:h-auto flex-col items-start gap-1 p-5 text-left"
                onClick={() => setDialog("single")}
              >
                <IconListCheck className="size-6" />
                单条方案
                <span className="text-xs text-muted-foreground">固定房间、座位和时间</span>
              </Button>
              <Button
                variant="outline"
                className="h-auto sm:h-auto flex-col items-start gap-1 p-5 text-left"
                disabled={available.length < 2}
                onClick={() => setDialog("group")}
              >
                <IconCalendarEvent className="size-6" />
                组合方案
                <span className="text-xs text-muted-foreground">按时间顺序尝试多个方案</span>
              </Button>
            </div>
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <Dialog
        open={dialog === "single" || dialog === "edit-single"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>{dialog === "edit-single" ? "编辑单条方案" : "创建单条方案"}</DialogTitle>
            <DialogDescription>设置座位、时间和重复日期</DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <PlanEditor
              initial={selected?.kind === "single" ? selected : undefined}
              onClose={() => setDialog(null)}
            />
          </DialogPanel>
        </DialogPopup>
      </Dialog>

      <Drawer
        open={dialog === "group" || dialog === "edit-group"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DrawerPopup position="bottom">
          <DrawerHeader>
            <DrawerTitle>{dialog === "edit-group" ? "编辑组合方案" : "创建组合方案"}</DrawerTitle>
            <DrawerDescription>按顺序尝试已保存的单条方案</DrawerDescription>
          </DrawerHeader>
          <DrawerPanel>
            <GroupEditor
              singles={selected?.kind === "group" ? allSingles : available}
              initial={selected?.kind === "group" ? selected : undefined}
              onClose={() => setDialog(null)}
            />
          </DrawerPanel>
          <DrawerFooter>
            <DrawerClose render={<Button variant="outline" />}>关闭</DrawerClose>
          </DrawerFooter>
        </DrawerPopup>
      </Drawer>
    </PageShell>
  )
}
