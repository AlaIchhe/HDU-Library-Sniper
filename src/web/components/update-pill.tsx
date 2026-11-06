import { useSyncExternalStore } from "react"
import { ArrowUpCircle, Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import { toastManager } from "@/components/ui/toast"
import { cn } from "@/lib/utils"
import { getUpdateProgress, subscribeUpdateProgress, type UpdateProgress } from "../update-state"
import { installPendingUpdate } from "../updater"

type Copy = { long: string; short: string; hint: string }

function describePill(progress: UpdateProgress): Copy {
  const version = progress.version ?? ""
  switch (progress.phase) {
    case "available":
      return {
        long: `更新到 v${version}`,
        short: `v${version}`,
        hint: `发现新版本 v${version}，点击立即下载并安装`,
      }
    case "downloading":
      return progress.total > 0
        ? {
            long: `下载中 ${progress.percent}%`,
            short: `${progress.percent}%`,
            hint: `正在下载更新 ${progress.percent}%，请稍候`,
          }
        : { long: "下载中…", short: "…", hint: "正在下载更新，请稍候" }
    case "verifying":
      return { long: "校验中…", short: "校验", hint: "正在校验安装包，马上开始安装" }
    case "installing":
      return { long: "正在安装…", short: "安装", hint: "正在安装更新，若弹出 UAC 请选择允许" }
    default:
      return { long: "", short: "", hint: "" }
  }
}

/**
 * 顶栏更新控件：平时不渲染，只有检出更新后才出现。
 * 点击后原地变成进度条，下载、校验、安装都不需要额外弹窗。
 */
export function UpdatePill() {
  const progress = useSyncExternalStore(subscribeUpdateProgress, getUpdateProgress)
  if (progress.phase === "idle") return null

  const busy = progress.phase !== "available"
  const { long, short, hint } = describePill(progress)

  async function install() {
    try {
      await installPendingUpdate()
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "更新失败",
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      title={hint}
      aria-busy={busy}
      data-phase={progress.phase}
      onClick={() => {
        if (!busy) void install()
      }}
      className={cn(
        "relative min-w-16 overflow-hidden tabular-nums md:min-w-36",
        busy && "cursor-default hover:bg-transparent data-pressed:bg-transparent",
      )}
    >
      {busy && (
        <span
          aria-hidden
          className={cn(
            "absolute inset-y-0 left-0 bg-primary/15 transition-[width] duration-300 ease-out",
            progress.phase === "downloading" && progress.total <= 0 && "animate-pulse",
          )}
          style={{ width: `${progress.phase === "downloading" ? progress.percent : 100}%` }}
        />
      )}
      <span className="relative flex items-center gap-1.5">
        {busy ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />}
        <span className="max-md:hidden">{long}</span>
        <span className="md:hidden">{short}</span>
      </span>
    </Button>
  )
}
