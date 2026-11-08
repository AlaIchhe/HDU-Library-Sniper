import type { Icon } from "@tabler/icons-react"
import type { ReactNode } from "react"
import { IconAlertCircle } from "@tabler/icons-react"
import { z } from "zod"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Spinner } from "@/components/ui/spinner"

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

export function Busy({ label = "正在加载..." }: { label?: string }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner />
      {label}
    </div>
  )
}

export function Failure({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Alert variant="error">
      <IconAlertCircle size={18} />
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
  action,
}: {
  icon: Icon
  title: string
  /** 可选的操作区。空状态是死胡同还是入口，区别就在这里。 */
  action?: ReactNode
}) {
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Icon className="size-5" />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {action ? <EmptyContent>{action}</EmptyContent> : null}
    </Empty>
  )
}
