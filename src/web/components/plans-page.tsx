"use client"

import { useMemo, useRef, useState } from "react"
import { IconCalendarEvent, IconListCheck, IconPencil, IconPlus, IconTrash } from "@tabler/icons-react"
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
import { Dialog, DialogHeader, DialogPanel, DialogPopup, DialogTitle } from "@/components/ui/dialog"
import {
  Drawer,
  DrawerClose,
  DrawerFooter,
  DrawerHeader,
  DrawerPanel,
  DrawerPopup,
  DrawerTitle,
} from "@/components/ui/drawer"
import { InteractiveHoverButton } from "@/components/ui/interactive-hover-button"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { toastManager } from "@/components/ui/toast"
import type { BookingPlan, PlanListItem } from "../../shared/types"
import { weekdayLabels } from "../../shared/types"
import { usePlanMutations, usePlans } from "../queries"
import { PageHeader, PageShell, Panel } from "./page-layout"
import { useRefreshSignal } from "../store"
import { undoToast } from "../undo-toast"
import { Busy, Failure, NoData } from "../shared"

import { GroupEditor } from "./plans/group-editor"
import { PlanEditor } from "./plans/plan-editor"
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
        actions={
          // InteractiveHoverButton 自带圆点 + 悬停箭头作为 affordance；
          // children 会被放进一个 inline-block 的 span，再塞图标会让「+」
          // 和文字分成两行。这里只传纯文本，accessible name 保持「创建方案」。
          <InteractiveHoverButton onClick={() => setDialog("type")}>创建方案</InteractiveHoverButton>
        }
      />

      <Panel title="我的计划">
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
              </Button>
              <Button
                variant="outline"
                className="h-auto sm:h-auto flex-col items-start gap-1 p-5 text-left"
                disabled={available.length < 2}
                onClick={() => setDialog("group")}
              >
                <IconCalendarEvent className="size-6" />
                组合方案
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
