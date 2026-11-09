"use client"

import { createContext, useContext, useState } from "react"
import { Reorder, useDragControls, useReducedMotion, type DragControls } from "motion/react"
import { IconCheck, IconChevronDown, IconChevronUp, IconGripVertical } from "@tabler/icons-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import type { z } from "zod"

import { Badge } from "@/ui/badge"
import { Button } from "@/ui/button"
import { Checkbox } from "@/ui/checkbox"
import { CheckboxGroup } from "@/ui/checkbox-group"
import { DialogClose, DialogFooter } from "@/ui/dialog"
import { Field, FieldLabel, FormError } from "@/ui/field"
import { Form } from "@/ui/form"
import { Input } from "@/ui/input"
import { toastManager } from "@/ui/toast"
import { cn } from "@/lib/utils"
import type { BookingPlan, BookingGroup } from "../../../shared/types"
import { usePlanMutations } from "../../data/queries"
import { groupSchema } from "../../shared"

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

export function GroupEditor({
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
        <span className="text-sm font-medium">执行顺序</span>
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
        ) : null}
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
