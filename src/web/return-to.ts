/**
 * 登录前想去的位置。未登录守卫会把地址换成 "/"，
 * 不留这条记录，深链接和刷新都会退化成首页。
 */
const storageKey = "hdu-sniper:return-to"

/** 进程内副本：StrictMode 会重复挂载，读一次就清空会让第二次读到兜底值。 */
let cached: string | null = null

/** 只接受站内路径，避免把用户送回外部地址。 */
function isInternalPath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//")
}

export function rememberReturnTo(path: string) {
  if (!isInternalPath(path)) return
  cached = path
  try {
    sessionStorage.setItem(storageKey, path)
  } catch {
    /* 隐私模式下 sessionStorage 可能不可用，内存副本仍然有效 */
  }
}

export function consumeReturnTo(fallback = "/plans"): string {
  if (cached) return cached
  try {
    const saved = sessionStorage.getItem(storageKey)
    if (saved && isInternalPath(saved)) {
      cached = saved
      return saved
    }
  } catch {
    /* 同上 */
  }
  return fallback
}

/** 用户已经到达目标页后清掉，避免下次登录被带到上一次的页面。 */
export function forgetReturnTo() {
  cached = null
  try {
    sessionStorage.removeItem(storageKey)
  } catch {
    /* 同上 */
  }
}
