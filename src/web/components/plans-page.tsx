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
import {
  Drawer,
  DrawerClose,
  DrawerFooter,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from "@/ui/drawer"
import { InteractiveHoverButton } from "@/ui/interactive-hover-button"
import { Magnet } from "@/ui/magnet"
import { SpotlightCard } from "@/ui/spotlight-card"
import { Switch } from "@/ui/switch"
import { toastManager } from "@/ui/toast"
import type { BookingPlan, PlanListItem } from "../../shared/types"
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
import { useRefreshSignal } from "../data/store"
import { undoToast } from "../undo-toast"
import { NoData } from "../shared"

import { GroupEditor } from "./plans/group-editor"
import { PlanEditor } from "./plans/plan-editor"

const PLAN_COLUMNS = "sm:grid-cols-[minmax(0,1.4fr)_minmax(0,0.9fr)_minmax(0,1.25fr)_minmax(6.5rem,auto)]"
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

  const allSingles = items.filter((item): item is BookingPlan => item.kind === "single")
  const referenced = new Set(
    items.filter((item) => item.kind === "group").flatMap((item) => item.memberPlanIds),
  )
  const available = allSingles.filter((item) => !referenced.has(item.id))

  // 创建模式始终不携带历史选中项，避免先编辑再创建时误把编辑目标当成 initial 覆盖原方案
  const editingSingle = dialog === "single" ? undefined : selected?.kind === "single" ? selected : undefined
  const editingGroup = dialog === "group" ? undefined : selected?.kind === "group" ? selected : undefined

  function openCreateDialog() {
    setSelected(undefined)
    setDialog("type")
  }

  function openCreateSingle() {
    setSelected(undefined)
    setDialog("single")
  }

  function openCreateGroup() {
    setSelected(undefined)
    setDialog("group")
  }

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
            // InteractiveHoverButton 自带圆点 + 悬停箭头作为 affordance；
            // children 会被放进一个 inline-block 的 span，再塞图标会让「+」
            // 和文字分成两行。这里只传纯文本，accessible name 保持「创建方案」。
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
                    setDialog(item.kind === "group" ? "edit-group" : "edit-single")
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
            </DialogHeader>
            <DialogPanel>
              <div className="grid gap-3 sm:grid-cols-2">
                <AnimateIcon animateOnHover asChild>
                  <SpotlightCard className="gap-2" onClick={openCreateSingle}>
                    <span className="grid size-10 place-items-center rounded-xl border bg-muted/60 text-foreground">
                      <ListChecks className="size-5" />
                    </span>
                    <span className="text-sm font-semibold text-foreground">单条方案</span>
                    <span className="text-xs leading-relaxed text-foreground/65">
                      指定单个房间、座位与预约时段
                    </span>
                  </SpotlightCard>
                </AnimateIcon>
                <AnimateIcon animateOnHover asChild>
                  <SpotlightCard className="gap-2" disabled={available.length < 2} onClick={openCreateGroup}>
                    <span className="grid size-10 place-items-center rounded-xl border bg-muted/60 text-foreground">
                      <CalendarDays className="size-5" />
                    </span>
                    <span className="text-sm font-semibold text-foreground">组合方案</span>
                    <span className="text-xs leading-relaxed text-foreground/65">
                      {available.length < 2 ? "至少需要 2 条可用方案" : "按顺位串联多个备选方案"}
                    </span>
                  </SpotlightCard>
                </AnimateIcon>
              </div>
            </DialogPanel>
          </DialogPopup>
        </Dialog>

        <Dialog
          open={dialog === "single" || dialog === "edit-single"}
          onOpenChange={(open) => !open && setDialog(null)}
          onOpenChangeComplete={(open) => {
            if (!open && dialog === null) setSelected(undefined)
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>{editingSingle ? "编辑单条方案" : "创建单条方案"}</DialogTitle>
            </DialogHeader>
            <DialogPanel>
              <PlanEditor
                key={editingSingle ? `edit-${editingSingle.id}` : "create"}
                initial={editingSingle}
                onClose={() => setDialog(null)}
              />
            </DialogPanel>
          </DialogPopup>
        </Dialog>

        <Drawer
          open={dialog === "group" || dialog === "edit-group"}
          onOpenChange={(open) => !open && setDialog(null)}
          onOpenChangeComplete={(open) => {
            if (!open && dialog === null) setSelected(undefined)
          }}
        >
          <DrawerPopup>
            <DrawerHeader>
              <DrawerTitle>{editingGroup ? "编辑组合方案" : "创建组合方案"}</DrawerTitle>
            </DrawerHeader>
            <DrawerPanel>
              <GroupEditor
                key={editingGroup ? `edit-${editingGroup.id}` : "create"}
                singles={editingGroup ? allSingles : available}
                initial={editingGroup}
                onClose={() => setDialog(null)}
              />
            </DrawerPanel>
            <DrawerFooter>
              <DrawerClose render={<Button variant="outline" />}>关闭</DrawerClose>
            </DrawerFooter>
          </DrawerPopup>
        </Drawer>
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
  item: PlanListItem
  index: number
  pending: boolean
  onToggle: (checked: boolean) => void
  onEdit: () => void
  onDelete: () => void
}) {
  const title = item.kind === "group" ? item.name : item.roomType
  const subtitle =
    item.kind === "group"
      ? `${item.memberPlanIds.length} 个成员方案`
      : `${item.floorName || `楼层 ${item.floorId}`} · 座位 ${item.seatNum}`
  const timePrimary =
    item.kind === "group" ? "顺位组合" : `${String(item.startHour).padStart(2, "0")}:00 开始`
  const timeSecondary =
    item.kind === "group" ? `${item.memberPlanIds.length} 个子方案` : `时长 ${item.durationHours} 小时`
  const weekdaysText = formatWeekdays(item.weekdays)

  return (
    <DataTableRow value={item.id} index={index} active={item.enabled}>
      <DataTableRevealCell
        primary={
          <div className="flex min-w-0 items-center gap-2.5">
            <Badge size="sm" variant={item.kind === "group" ? "info" : "outline"}>
              {item.kind === "group" ? (
                <CalendarDays className="size-3" />
              ) : (
                <ListChecks className="size-3" />
              )}
              {item.kind === "group" ? "组合" : "单条"}
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
