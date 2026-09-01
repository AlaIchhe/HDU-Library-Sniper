import type { LucideIcon } from "lucide-react"
import { CircleAlert } from "lucide-react"
import { z } from "zod"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"
import type { AuditEvent } from "../shared/types"

export const loginSchema = z.object({
  studentId: z.string().trim().min(1, "请输入学号"),
  password: z.string().min(1, "请输入密码"),
})

export const planSchema = z.object({
  roomType: z.string().min(1, "请选择房间类型"),
  roomQuery: z.string().min(1),
  floorId: z.coerce.number().int().positive("请选择楼层"),
  floorName: z.string().optional(),
  seatNum: z.string().trim().min(1, "请输入座位号"),
  fallback: z.string().optional(),
  startHour: z.string().min(1, "请选择开始时间"),
  duration: z.string().min(1, "请选择时长"),
  weekdays: z.array(z.string()).min(1, "至少选择一个星期"),
})

export const groupSchema = z.object({
  name: z.string().trim().min(1, "请输入组合名称"),
  ids: z.array(z.string()).min(2, "至少选择两个方案"),
})

const EVENT_LABELS: Record<string, string> = {
  booking_run_finished: "预约执行完成",
  booking_member_finished: "单条预约执行完成",
  checkin_succeeded: "自动签到成功",
  checkin_unverified: "签到待复核",
  checkin_failed: "自动签到失败",
}

export const eventLabel = (e: AuditEvent) =>
  EVENT_LABELS[e.event] ?? e.event

export function Busy({ label = "正在加载..." }: { label?: string }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  )
}

export function Failure({
  message,
  retry,
}: {
  message: string
  retry?: () => void
}) {
  return (
    <Alert variant="error">
      <CircleAlert size={18} />
      <div>
        <AlertTitle>请求失败</AlertTitle>
        <AlertDescription>
          {message}
          {retry && (
            <Button size="sm" variant="outline" className="mt-3" onClick={retry}>
              重试
            </Button>
          )}
        </AlertDescription>
      </div>
    </Alert>
  )
}

export function NoData({
  icon: Icon,
  title,
  description = "完成配置后，后台会持续处理任务。",
}: {
  icon: LucideIcon
  title: string
  description?: string
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
        <EmptyDescription>{description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  )
}
