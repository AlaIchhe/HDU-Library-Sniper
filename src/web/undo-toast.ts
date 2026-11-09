import { toastManager } from "@/ui/toast"

/**
 * 带「撤销」动作的 toast。不自动消失：用户需要时间决定要不要撤销。
 *
 * Base UI 的 <Toast.Action> 会自己合并 toast.actionProps（含 onClick），
 * 所以这里直接传 onClick 即可；但它不会在点击后关闭 toast，需要手动 close，
 * 否则用户可以重复点击、把撤销执行多次。
 */
export function undoToast({
  title,
  onUndo,
  undoLabel = "撤销",
}: {
  title: string
  onUndo: () => void
  undoLabel?: string
}) {
  const id = toastManager.add({
    type: "success",
    title,
    timeout: 0,
    actionProps: {
      children: undoLabel,
      onClick: () => {
        toastManager.close(id)
        onUndo()
      },
    },
  })
}
