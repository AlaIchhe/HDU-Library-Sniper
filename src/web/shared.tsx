import type { ReactNode } from "react"

import { Alert, AlertDescription, AlertTitle } from "@/ui/alert"
import { Button } from "@/ui/button"
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from "@/ui/empty"
import { type AnimatedIconComponent, CircleAlert } from "@/ui/icons"
import { Ripple } from "@/ui/ripple"
import { Spinner } from "@/ui/spinner"
import { TextShimmer } from "@/ui/text-shimmer"

export {
  type GroupFormValues,
  groupResolver,
  type LoginFormValues,
  loginResolver,
  type PlanFormValues,
  planResolver,
  useForm,
} from "./form-resolvers"

export function Busy({ label = "正在加载..." }: { label?: string }) {
  return (
    <div className="flex min-h-52 flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
      <Spinner />
      <TextShimmer duration={2.2}>{label}</TextShimmer>
    </div>
  )
}

export function Failure({ message, retry }: { message: string; retry?: () => void }) {
  return (
    <Alert variant="error">
      <CircleAlert size={18} animate />
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
  icon: AnimatedIconComponent
  title: string
  /** 可选的操作区。空状态是死胡同还是入口，区别就在这里。 */
  action?: ReactNode
}) {
  return (
    <Empty className="relative overflow-hidden">
      <Ripple mainCircleSize={112} mainCircleOpacity={0.14} numCircles={5} />
      <EmptyHeader className="relative z-10">
        <EmptyMedia variant="icon">
          <Icon className="size-5" animate />
        </EmptyMedia>
        <EmptyTitle>{title}</EmptyTitle>
      </EmptyHeader>
      {action ? <EmptyContent className="relative z-10">{action}</EmptyContent> : null}
    </Empty>
  )
}
