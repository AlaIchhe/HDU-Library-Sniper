"use client"

import { useRef, useState } from "react"

import { AnimateIcon, CalendarDays, ListChecks, Pencil, Plus, Trash2 } from "@/ui/icons"
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/ui/alert-dialog"
import { Badge } from "@/ui/badge"
import { BlurFade } from "@/ui/blur-fade"
import { Button } from "@/ui/button"
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/ui/dialog"
import { InteractiveHoverButton } from "@/ui/interactive-hover-button"
import { Magnet } from "@/ui/magnet"
import { Switch } from "@/ui/switch"
import { toastManager } from "@/ui/toast"
import type { BookingPlan } from "../../shared/types"
import { formatWeekdays } from "../../shared/types"
import { usePlanMutations, usePlans } from "../data/queries"
import {
  DataTable,
  DataTableBody,
  DataTableHeader,
  DataTableHoverActions,
  DataTableRevealCell,
  DataTableRow,
  PRESS_CLASS,
} from "./data-table"
import { PageHeader, PageShell, PageState } from "./page-layout"
import { cn } from "@/lib/utils"
import { undoToast } from "../undo-toast"
import { NoData } from "../shared"

import { PlanEditor } from "./plans/plan-editor"

const PLAN_COLUMNS = "sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1.25fr)_minmax(6.5rem,auto)]"

export function PlansPage() {
  const plans = usePlans()
  const mutations = usePlanMutations()
  const [dialog, setDialog] = useState<"create" | "edit" | null>(null)
  const [selected, setSelected] = useState<BookingPlan>()
  const [deleteTarget, setDeleteTarget] = useState<BookingPlan | null>(null)
  const items = plans.data?.plans || []

  const editingPlan = dialog === "edit" ? selected : undefined

  function openCreateDialog() {
    setSelected(undefined)
    setDialog("create")
  }

  const toggleInFlight = useRef(new Set<string>())

  async function toggle(item: BookingPlan, nextEnabled?: boolean) {
    if (toggleInFlight.current.has(item.id)) return
    const enabled = nextEnabled ?? !item.enabled
    toggleInFlight.current.add(item.id)
    try {
      const result = await mutations.toggle.mutateAsync({ id: item.id, enabled })

      if (!enabled) {
        toastManager.add({ type: "success", title: "方案已停用" })
        return
      }

      const displaced = (result?.disabledPlanIds || []).filter((id) => id !== item.id)
      if (!displaced.length) {
        toastManager.add({ type: "success", title: "方案已启用" })
        return
      }

      const names = displaced
        .map((id) => items.find((entry) => entry.id === id))
        .map((entry) => {
          if (!entry) return null
          if (entry.slots.length === 1) {
            return `${entry.name || entry.slots[0].roomType} · ${entry.slots[0].seatNum}`
          }
          return entry.name
        })
        .filter((name): name is string => Boolean(name))

      undoToast({
        title:
          names.length === 1
            ? `已启用，之前启用的「${names[0]}」已停用`
            : `已启用，${names.length} 个原方案已停用`,
        onUndo: async () => {
          try {
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

  return (
    <PageState
      loading={plans.isLoading}
      error={plans.error}
      errorFallback="方案加载失败"
      onRetry={() => void plans.refetch()}
    >
      <PageShell key="ready">
        <PageHeader
          eyebrow="PLANS"
          title="预约方案"
          count={items.length}
          actions={
            <Magnet padding={36} magnetStrength={6}>
              <InteractiveHoverButton onClick={openCreateDialog}>创建方案</InteractiveHoverButton>
            </Magnet>
          }
        />

        <BlurFade delay={0.05} duration={0.28} offset={10} blur="4px" className="min-w-0">
          <DataTable
            columns={PLAN_COLUMNS}
            isEmpty={items.length === 0}
            empty={
              <NoData
                icon={ListChecks}
                title="还没有预约方案"
                action={
                  <AnimateIcon animateOnHover asChild>
                    <Button onClick={openCreateDialog}>
                      <Plus className="size-4" />
                      创建第一个方案
                    </Button>
                  </AnimateIcon>
                }
              />
            }
          >
            <DataTableHeader>
              <span>方案</span>
              <span>时间</span>
              <span>重复日期</span>
              <span className="text-right">操作</span>
            </DataTableHeader>
            <DataTableBody>
              {items.map((item, index) => (
                <PlanRow
                  key={item.id}
                  item={item}
                  index={index}
                  pending={mutations.toggle.isPending}
                  onToggle={(checked) => void toggle(item, checked)}
                  onEdit={() => {
                    setSelected(item)
                    setDialog("edit")
                  }}
                  onDelete={() => setDeleteTarget(item)}
                />
              ))}
            </DataTableBody>
          </DataTable>
        </BlurFade>

        <AlertDialog open={!!deleteTarget} onOpenChange={(open) => !open && setDeleteTarget(null)}>
          <AlertDialogPopup>
            <AlertDialogHeader>
              <AlertDialogTitle>删除方案？</AlertDialogTitle>
              <AlertDialogDescription>此操作无法撤销。</AlertDialogDescription>
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

        <Dialog
          open={dialog !== null}
          onOpenChange={(open) => !open && setDialog(null)}
          onOpenChangeComplete={(open) => {
            if (!open && dialog === null) setSelected(undefined)
          }}
        >
          <DialogPopup className="sm:max-w-[38rem]">
            <DialogHeader>
              <DialogTitle>{editingPlan ? "编辑预约方案" : "创建预约方案"}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <PlanEditor
                key={editingPlan ? `edit-${editingPlan.id}` : "create"}
                initial={editingPlan}
                onClose={() => setDialog(null)}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      </PageShell>
    </PageState>
  )
}

function PlanRow({
  item,
  index,
  pending,
  onToggle,
  onEdit,
  onDelete,
}: {
  item: BookingPlan
  index: number
  pending: boolean
  onToggle: (checked: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const isMulti = item.slots.length > 1
  const first = item.slots[0]
  const title = item.name || first?.roomType || "未命名方案"
  const subtitle = isMulti
    ? item.slots.map((s) => `${s.roomType} · 座位 ${s.seatNum}`).join(" / ")
    : first
      ? `${first.floorName || `楼层 ${first.floorId}`} · 座位 ${first.seatNum}`
      : "无时段"
  const timePrimary = isMulti
    ? `${item.slots.length} 个时段`
    : first
      ? `${String(first.startHour).padStart(2, "0")}:00 开始`
      : "-"
  const timeSecondary = isMulti
    ? item.slots.map((s) => `${String(s.startHour).padStart(2, "0")}:00(${s.durationHours}h)`).join(" · ")
    : first
      ? `时长 ${first.durationHours} 小时`
      : "-"
  const weekdaysText = formatWeekdays(item.weekdays)

  return (
    <DataTableRow value={item.id} index={index} active={item.enabled}>
      <DataTableRevealCell
        primary={
          <div className="flex min-w-0 items-center gap-2.5">
            <Badge size="sm" variant={isMulti ? "info" : "outline"}>
              {isMulti ? <CalendarDays className="size-3" /> : <ListChecks className="size-3" />}
              {isMulti ? `${item.slots.length} 时段` : "单时段"}
            </Badge>
            <p className="truncate text-sm font-medium text-foreground">{title}</p>
          </div>
        }
        reveal={
          <>
            <p className="truncate">{subtitle}</p>
            <p className="mt-1 sm:hidden">
              {timePrimary} · {timeSecondary} · {weekdaysText}
            </p>
          </>
        }
      />

      <DataTableRevealCell
        className="hidden sm:block"
        primary={<p className="truncate text-sm font-medium tabular-nums text-foreground">{timePrimary}</p>}
        reveal={<p className="truncate tabular-nums">{timeSecondary}</p>}
      />

      <div className="hidden min-w-0 sm:block">
        <p className="text-sm leading-snug text-foreground/85">{weekdaysText}</p>
      </div>

      <div className="flex items-center justify-between gap-2 sm:justify-end">
        <span className="text-[13px] font-medium text-foreground/80 sm:hidden">
          {item.enabled ? "已启用" : "未启用"}
        </span>
        <div className="flex items-center gap-1.5">
          <DataTableHoverActions>
            <AnimateIcon animateOnHover asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className={PRESS_CLASS}
                onClick={onEdit}
                aria-label="编辑方案"
              >
                <Pencil />
              </Button>
            </AnimateIcon>
            <AnimateIcon animateOnHover asChild>
              <Button
                size="icon-sm"
                variant="ghost"
                className={cn("text-destructive", PRESS_CLASS)}
                onClick={onDelete}
                aria-label="删除方案"
              >
                <Trash2 />
              </Button>
            </AnimateIcon>
          </DataTableHoverActions>
          <Switch
            checked={item.enabled}
            onCheckedChange={onToggle}
            disabled={pending}
            aria-label={item.enabled ? "停用方案" : "启用方案"}
          />
        </div>
      </div>
    </DataTableRow>
  )
}
