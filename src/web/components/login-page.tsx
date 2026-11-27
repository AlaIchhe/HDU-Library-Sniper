"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useQueryClient } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { QRCodeSVG } from "qrcode.react"

import { AnimateIcon, Info, LibraryBig, LogIn, QrCode, RefreshCw, TriangleAlert } from "@/ui/icons"

import { Alert, AlertDescription } from "@/ui/alert"
import { AntigravityParticles } from "@/ui/antigravity-particles"
import { BlurFade } from "@/ui/blur-fade"
import { BlurText } from "@/ui/blur-text"
import { Button } from "@/ui/button"
import { Card } from "@/ui/card"
import { DecryptedText } from "@/ui/decrypted-text"
import {
  Dialog,
  DialogClose,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "@/ui/dialog"
import { Field, FieldDescription, FieldLabel, FormError } from "@/ui/field"
import { GlowingEffect } from "@/ui/glowing-effect"
import { Input } from "@/ui/input"
import { MagicCard } from "@/ui/magic-card"
import { ScrollArea } from "@/ui/scroll-area"
import { ShimmerButton } from "@/ui/shimmer-button"
import { Spinner } from "@/ui/spinner"
import { TextShimmer } from "@/ui/text-shimmer"
import { cn } from "@/lib/utils"
import { api } from "../data/api"
import { subscribeQrEvents } from "../data/events"
import { queryKeys, useSession } from "../data/queries"
import { useAppStore } from "../data/store"
import { consumeReturnTo } from "../return-to"
import { Busy, type LoginFormValues, loginResolver, useForm } from "../shared"
import type { QrLoginStart, SessionStatus } from "../../shared/types"

const LIBRARY_URL = "https://hdu.huitu.zhishulib.com/"
const ISSUES_URL = "https://github.com/AlaIchhe/HDU-Library-Sniper/issues"

// 登录页只对“确定性”状态做反馈：加载中、可扫码、获取失败。
// SSO 不暴露“已扫描/待确认”，客户端也不做伪中间态。
type QrState = "loading" | "ready" | "error"
type LoginTab = "password" | "openid"

// 登录卡是局部的高密度表单：40px 控件比全局的紧凑桌面控件更适合输入密码。
const inputClass = "[&>input]:h-10 [&>input]:leading-10 sm:[&>input]:h-10 sm:[&>input]:leading-10"

function OpenidGuide({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="sm:max-w-[26rem]">
        <DialogHeader className="shrink-0">
          <DialogTitle>获取 openid</DialogTitle>
          <DialogDescription>openid 只能从微信里带出来，按下面四步操作。</DialogDescription>
        </DialogHeader>
        <ScrollArea className="min-h-0 flex-1" scrollFade overscrollContain>
          <div className="grid gap-4 px-6 pb-6">
            <div className="justify-self-center rounded-xl border bg-white p-3">
              <QRCodeSVG value={LIBRARY_URL} size={168} level="M" marginSize={2} title="微信扫码打开图书馆" />
            </div>
            <p className="text-center text-xs text-muted-foreground">微信扫一扫</p>
            <ol className="grid list-decimal gap-2 pl-5 text-sm text-muted-foreground marker:text-muted-foreground">
              <li>用微信扫一扫上面的二维码，打开图书馆并登录。</li>
              <li>
                登录成功后，地址栏会变成{" "}
                <code className="break-all rounded bg-muted px-1 py-0.5 font-mono text-[11px]">
                  …/startUp/openid/…/
                </code>
                。
              </li>
              <li>点右上角「…」→「复制链接」，发给电脑上的微信（文件传输助手）。</li>
              <li>回到这里，把整条链接粘贴到上面的 OpenID 输入框，不需要手动截取。</li>
            </ol>
            <div className="flex gap-2 rounded-lg bg-muted/60 p-3 text-xs leading-5 text-muted-foreground">
              <Info className="mt-0.5 size-4 shrink-0" animateOnHover />
              <p>openid 等同登录凭据，只在这个应用里粘贴，不要发给别人。</p>
            </div>
          </div>
        </ScrollArea>
        <DialogFooter className="shrink-0">
          <DialogClose render={<Button type="button" />}>知道了</DialogClose>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  )
}

function LoginPage() {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const theme = useAppStore((state) => state.theme)
  const reduced = useReducedMotion()
  const form = useForm<LoginFormValues>({
    resolver: loginResolver,
    defaultValues: { studentId: "", password: "" },
  })
  const [tab, setTab] = useState<LoginTab>("password")
  const [mode, setMode] = useState<"form" | "qr">("form")
  const [passwordError, setPasswordError] = useState("")
  const [openid, setOpenid] = useState("")
  const [openidError, setOpenidError] = useState("")
  const [openidBusy, setOpenidBusy] = useState(false)
  const [qr, setQr] = useState<QrLoginStart | null>(null)
  const [qrState, setQrState] = useState<QrState>("loading")
  const [qrMessage, setQrMessage] = useState("正在获取登录二维码")
  const [guideOpen, setGuideOpen] = useState(false)
  const qrNonce = useRef(0)
  const activeQrUuid = useRef<string | null>(null)

  const applyAuthenticatedSession = useCallback(
    async (nextSession: SessionStatus) => {
      queryClient.setQueryData(queryKeys.session, nextSession)
      await navigate({ to: consumeReturnTo(), replace: true })
    },
    [navigate, queryClient],
  )

  const loadQr = useCallback(async () => {
    const nonce = ++qrNonce.current
    const prevUuid = activeQrUuid.current
    activeQrUuid.current = null
    setQr(null)
    setQrState("loading")
    setQrMessage("正在获取登录二维码")
    if (prevUuid) {
      await api.cancelQr(prevUuid).catch(() => undefined)
      if (nonce !== qrNonce.current) return
    }
    try {
      const next = await api.qrStart()
      if (nonce !== qrNonce.current) {
        void api.cancelQr(next.uuid).catch(() => undefined)
        return
      }
      activeQrUuid.current = next.uuid
      setQr(next)
      setQrState("ready")
      setQrMessage("请使用钉钉扫码登录")
    } catch (cause) {
      if (nonce !== qrNonce.current) return
      setQrState("error")
      setQrMessage(cause instanceof Error ? cause.message : "二维码获取失败")
    }
  }, [])

  // 页面卸载时若还有未完成的扫码会话，通知后端停掉扫描循环并释放并发槽位。
  useEffect(() => {
    return () => {
      const uuid = activeQrUuid.current
      if (uuid) {
        activeQrUuid.current = null
        void api.cancelQr(uuid).catch(() => undefined)
      }
    }
  }, [])

  // 只有进入扫码模式才向 SSO 取码，登录页打开时不再无谓地请求一张没人看的二维码。
  useEffect(() => {
    if (mode !== "qr") return
    void loadQr()
  }, [mode, loadQr])

  // 扫码状态与到期换码只在扫码模式下运行：Web 走 SSE 推送，桌面端走 MyGo IPC 事件。
  useEffect(() => {
    if (mode !== "qr" || !qr) return
    const currentQr = qr
    let stopped = false

    const unsubscribe = subscribeQrEvents(currentQr.uuid, {
      onEvent: (result) => {
        if (stopped || result.uuid !== currentQr.uuid) return
        if (result.status === "pending") return

        activeQrUuid.current = null
        if (result.status === "success") {
          if (result.session?.authenticated) {
            void applyAuthenticatedSession(result.session)
            return
          }
          void api
            .session()
            .then((sess) => {
              if (stopped) return
              if (sess.authenticated) return applyAuthenticatedSession(sess)
              setQrState("error")
              setQrMessage("扫码已确认，但登录态校验失败")
            })
            .catch(() => {
              if (stopped) return
              setQrState("error")
              setQrMessage("扫码已确认，但登录态校验失败")
            })
          return
        }

        if (result.status === "expired") {
          // SSO 判定该码已失效：自动换新码，不打扰用户。
          void loadQr()
          return
        }

        setQrState("error")
        setQrMessage(result.message || "扫码登录失败，请刷新二维码")
      },
      onError: (message) => {
        if (stopped) return
        setQrState("error")
        setQrMessage(message)
      },
    })

    // 到期自动换码：在安全窗口到期前提前刷新。
    const ttl = Math.max(20, currentQr.ttlSeconds || 90)
    const lead = Math.min(10, Math.floor(ttl / 4))
    const expiryTimer = setTimeout(
      () => {
        if (!stopped) void loadQr()
      },
      Math.max(0, (ttl - lead) * 1000),
    )

    return () => {
      stopped = true
      unsubscribe()
      clearTimeout(expiryTimer)
    }
  }, [mode, qr, loadQr, applyAuthenticatedSession])

  function selectTab(next: LoginTab) {
    setTab(next)
    if (next === "password") setOpenidError("")
    else setPasswordError("")
  }

  async function submit(values: LoginFormValues) {
    setPasswordError("")
    try {
      const result = await api.login(values.studentId, values.password)
      if (!result.success) throw new Error(result.message)
      const nextSession = result.session?.authenticated ? result.session : await api.session()
      await applyAuthenticatedSession(nextSession)
    } catch (cause) {
      setPasswordError(cause instanceof Error ? cause.message : "登录失败")
    }
  }

  async function submitOpenid() {
    setOpenidError("")
    const value = openid.trim()
    if (!value) {
      setOpenidError("请输入 OpenID 或微信登录链接")
      return
    }
    setOpenidBusy(true)
    try {
      const result = await api.openidLogin(value)
      if (!result.success) throw new Error(result.message)
      const nextSession = result.session?.authenticated ? result.session : await api.session()
      await applyAuthenticatedSession(nextSession)
    } catch (cause) {
      setOpenidError(cause instanceof Error ? cause.message : "OpenID 登录失败")
    } finally {
      setOpenidBusy(false)
    }
  }

  function closeQr() {
    // 离开扫码页时作废在途请求，避免响应回来后又把旧二维码写回状态。
    qrNonce.current += 1
    // 同时通知服务端停止扫码轮询：它和密码登录共用 SSO 会话，继续跑会搅乱登录。
    const uuid = activeQrUuid.current ?? qr?.uuid
    activeQrUuid.current = null
    if (uuid) void api.cancelQr(uuid).catch(() => undefined)
    setQr(null)
    setMode("form")
  }

  function toggleQr() {
    if (mode === "qr") closeQr()
    else setMode("qr")
  }

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden p-6">
      <AntigravityParticles theme={theme} className="z-0" />
      <BlurFade duration={0.32} offset={10} blur="5px" className="relative z-10 w-full max-w-[26rem]">
        <div className="relative rounded-2xl">
          <GlowingEffect spread={34} proximity={72} inactiveZone={0.55} borderWidth={1} />
          <Card className="login-card glass relative w-full overflow-hidden p-7 sm:p-8">
            <header className="flex items-center justify-between gap-3">
              <AnimateIcon animateOnHover asChild>
                <div className="flex min-w-0 items-center gap-2.5">
                  <span className="grid size-7 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground">
                    <LibraryBig className="size-4" />
                  </span>
                  <span className="truncate text-[13px] font-medium tracking-tight">
                    <DecryptedText text="HDU Sniper" animateOn="hover" />
                  </span>
                </div>
              </AnimateIcon>
              <AnimateIcon animateOnHover asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-pressed={mode === "qr"}
                  className={cn(
                    "h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground",
                    mode === "qr" && "bg-muted text-foreground",
                  )}
                  onClick={toggleQr}
                >
                  <QrCode className="size-4" />
                  钉钉扫码
                </Button>
              </AnimateIcon>
            </header>

            <BlurText
              as="h1"
              text="登录图书馆账户"
              delay={24}
              stepDuration={0.2}
              className="mt-5 text-2xl font-semibold tracking-tight"
            />

            <AnimatePresence mode="wait" initial={false}>
              {mode === "form" ? (
                <motion.div
                  key="form-mode"
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                >
                  {/* biome-ignore lint/a11y/useSemanticElements: 这是按钮组不是表单字段组，fieldset 会带入默认边框和 padding */}
                  <div
                    role="group"
                    aria-label="登录方式"
                    className="mt-6 grid grid-cols-2 gap-1 rounded-lg bg-muted p-1"
                  >
                    {(
                      [
                        { id: "password", label: "密码登录" },
                        { id: "openid", label: "OpenID 登录" },
                      ] as const
                    ).map((option) => {
                      const active = tab === option.id
                      return (
                        <button
                          key={option.id}
                          type="button"
                          aria-pressed={active}
                          className={cn(
                            "relative z-0 h-8 rounded-md text-sm font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
                            active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                          )}
                          onClick={() => selectTab(option.id)}
                        >
                          {active ? (
                            <motion.span
                              layoutId="login-tab-pill"
                              aria-hidden
                              className="absolute inset-0 -z-1 rounded-md bg-background shadow-xs"
                              transition={{ type: "spring", stiffness: 480, damping: 34, mass: 0.65 }}
                            />
                          ) : null}
                          {option.label}
                        </button>
                      )
                    })}
                  </div>

                  <div className="mt-5">
                    {tab === "password" ? (
                      <form onSubmit={form.handleSubmit(submit)} className="grid gap-4">
                        <Field>
                          <FieldLabel>学号</FieldLabel>
                          <Input
                            className={inputClass}
                            autoComplete="username"
                            {...form.register("studentId")}
                          />
                          {form.formState.errors.studentId?.message && (
                            <FormError>{form.formState.errors.studentId.message}</FormError>
                          )}
                        </Field>
                        <Field>
                          <FieldLabel>数字杭电密码</FieldLabel>
                          <Input
                            className={inputClass}
                            type="password"
                            autoComplete="current-password"
                            {...form.register("password")}
                          />
                          {form.formState.errors.password?.message && (
                            <FormError>{form.formState.errors.password.message}</FormError>
                          )}
                        </Field>
                        {passwordError && (
                          <Alert variant="error">
                            <TriangleAlert className="size-4" animate />
                            <AlertDescription>{passwordError}</AlertDescription>
                          </Alert>
                        )}
                        <AnimateIcon animateOnHover asChild>
                          <ShimmerButton
                            type="submit"
                            className="h-10 w-full"
                            loading={form.formState.isSubmitting}
                          >
                            <LogIn className="size-4" />
                            登录
                          </ShimmerButton>
                        </AnimateIcon>
                      </form>
                    ) : (
                      <form
                        onSubmit={(event) => {
                          event.preventDefault()
                          void submitOpenid()
                        }}
                        className="grid gap-4"
                      >
                        <Field>
                          <FieldLabel>OpenID</FieldLabel>
                          <Input
                            className={inputClass}
                            value={openid}
                            onChange={(event) => setOpenid(event.target.value)}
                            placeholder="粘贴 openid 或微信登录链接"
                            autoComplete="off"
                            autoCapitalize="none"
                            spellCheck={false}
                          />
                          <FieldDescription>
                            在微信中打开图书馆并登录，复制地址栏里的整条链接。
                          </FieldDescription>
                        </Field>
                        {openidError && (
                          <Alert variant="error">
                            <TriangleAlert className="size-4" animate />
                            <AlertDescription>{openidError}</AlertDescription>
                          </Alert>
                        )}
                        <AnimateIcon animateOnHover asChild>
                          <ShimmerButton type="submit" className="h-10 w-full" loading={openidBusy}>
                            <LogIn className="size-4" />
                            登录
                          </ShimmerButton>
                        </AnimateIcon>
                        <p className="-mt-1 text-center text-xs text-muted-foreground">
                          没有 openid？
                          <button
                            type="button"
                            className="ml-1 font-medium text-foreground underline decoration-muted-foreground/50 underline-offset-4 hover:decoration-foreground"
                            onClick={() => setGuideOpen(true)}
                          >
                            点击获取
                          </button>
                        </p>
                      </form>
                    )}
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="qr-mode"
                  initial={reduced ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduced ? undefined : { opacity: 0, y: -4 }}
                  transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  className="mt-6 grid justify-items-center gap-3"
                >
                  <MagicCard className="rounded-xl p-0.5" gradientSize={180}>
                    <div className="relative grid size-52 place-items-center overflow-hidden rounded-[calc(var(--radius-xl)-2px)] bg-white p-2">
                      {qr?.image ? (
                        <img src={qr.image} alt="钉钉扫码登录二维码" className="size-full object-contain" />
                      ) : null}
                      {qrState === "loading" && (
                        <div className="absolute inset-0 grid place-items-center gap-2 bg-white/92 text-neutral-500">
                          <Spinner className="size-5" />
                          <TextShimmer className="text-xs" duration={2}>
                            {qrMessage}
                          </TextShimmer>
                        </div>
                      )}
                      {qrState === "error" && (
                        <div className="absolute inset-0 grid place-items-center bg-white/95 p-4 text-center">
                          <div className="grid gap-3">
                            <p className="text-xs leading-5 text-neutral-600">{qrMessage}</p>
                            <AnimateIcon animateOnHover asChild>
                              <Button
                                type="button"
                                size="sm"
                                className="justify-self-center"
                                onClick={() => void loadQr()}
                              >
                                <RefreshCw className="size-4" />
                                刷新二维码
                              </Button>
                            </AnimateIcon>
                          </div>
                        </div>
                      )}
                    </div>
                  </MagicCard>
                  <div className="grid gap-1 text-center">
                    <p className="text-sm font-medium">请使用钉钉扫码登录</p>
                    <p className="text-xs text-muted-foreground">二维码失效后会自动刷新</p>
                  </div>
                  <button
                    type="button"
                    className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    onClick={closeQr}
                  >
                    {tab === "openid" ? "返回 OpenID 登录" : "返回密码登录"}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="mt-6 text-center">
              <button
                type="button"
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                onClick={() => window.open(ISSUES_URL, "_blank", "noopener,noreferrer")}
              >
                登录遇到问题？
              </button>
            </div>
          </Card>
        </div>
      </BlurFade>

      <OpenidGuide open={guideOpen} onOpenChange={setGuideOpen} />
    </main>
  )
}

export function LoginGate() {
  const query = useSession()
  const session = query.data ?? null
  const navigate = useNavigate()
  // 只跳一次：StrictMode 会重跑 effect，第二次读到的返回目标已经被消费掉了。
  const redirected = useRef(false)

  useEffect(() => {
    if (redirected.current || !session?.authenticated) return
    // 路由状态会短暂报 "/"（深链接被守卫处理的那一刻），此时浏览器地址仍是原页面；
    // 以真实地址为准，避免把深链接误判成登录页再跳走。
    if (window.location.pathname !== "/") return
    redirected.current = true
    void navigate({ to: consumeReturnTo(), replace: true })
  }, [session?.authenticated, navigate])

  if (query.isLoading && !session) return <Busy label="正在连接后台服务..." />
  return session?.authenticated ? <Busy /> : <LoginPage />
}
