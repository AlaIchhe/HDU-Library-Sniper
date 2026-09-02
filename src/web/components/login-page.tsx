"use client"

import { useCallback, useEffect, useRef, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { LogIn, LockKeyhole, QrCode, RefreshCw, ShieldCheck } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import { AnimatedShinyText } from "@/components/ui/animated-shiny-text"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
} from "@/components/ui/field"
import { Form } from "@/components/ui/form"
import { Input } from "@/components/ui/input"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { api } from "../api"
import { useSession } from "../queries"
import { useAppStore } from "../store"
import { Busy, loginSchema } from "../shared"
import type { QrLoginStart } from "../../shared/types"

type QrState = "loading" | "ready" | "waiting" | "confirmed" | "expired" | "error"

function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((state) => state.setSession)
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { studentId: "", password: "" },
  })
  const [error, setError] = useState("")
  const [qr, setQr] = useState<QrLoginStart | null>(null)
  const [qrState, setQrState] = useState<QrState>("loading")
  const [qrMessage, setQrMessage] = useState("正在获取登录二维码")
  const qrNonce = useRef(0)

  const loadQr = useCallback(async () => {
    const nonce = ++qrNonce.current
    setQr(null)
    setQrState("loading")
    setQrMessage("正在获取登录二维码")
    try {
      const nextQr = await api.qrStart()
      if (nonce !== qrNonce.current) return
      setQr(nextQr)
      setQrState("ready")
      setQrMessage("请使用企业微信扫码登录")
    } catch (cause) {
      if (nonce !== qrNonce.current) return
      setQrState("error")
      setQrMessage(cause instanceof Error ? cause.message : "二维码获取失败")
    }
  }, [])

  useEffect(() => {
    void loadQr()
  }, [loadQr])

  useEffect(() => {
    if (!qr || !["ready", "waiting"].includes(qrState)) return
    let stopped = false
    let timer: ReturnType<typeof setTimeout>

    async function poll() {
      if (!qr || stopped) return
      try {
        const result = await api.qrStatus(qr.uuid)
        if (stopped) return
        if (result.status === "confirmed") {
          setQrState("confirmed")
          if (result.session?.authenticated) {
            setSession(result.session)
            await navigate({ to: "/plans" })
          } else {
            setQrState("error")
            setQrMessage("扫码已确认，但登录态校验失败")
          }
          return
        }
        if (result.status === "expired") {
          setQrState("expired")
          setQrMessage(result.message || "二维码已过期，请刷新")
          return
        }
        if (result.status === "error") {
          setQrState("error")
          setQrMessage(result.message || "扫码状态获取失败")
          return
        }
        setQrState("waiting")
        setQrMessage("等待扫码确认...")
      } catch (cause) {
        if (stopped) return
        setQrState("error")
        setQrMessage(cause instanceof Error ? cause.message : "扫码状态获取失败")
        return
      }
      if (!stopped) timer = setTimeout(poll, 1800)
    }

    timer = setTimeout(poll, 1200)
    return () => {
      stopped = true
      clearTimeout(timer)
    }
  }, [qr, qrState, navigate, setSession])

  async function submit(values: z.infer<typeof loginSchema>) {
    setError("")
    try {
      const result = await api.login(values.studentId, values.password)
      if (!result.success) throw new Error(result.message)
      setSession(await api.session())
      await navigate({ to: "/plans" })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败")
    }
  }

  const qrBusy = qrState === "loading" || qrState === "waiting" || qrState === "confirmed"

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden p-6">
      <Card className="relative z-10 w-full min-w-0 max-w-[min(86vw,48rem)] overflow-hidden">
        <CardHeader className="min-w-0">
          <div className="mb-4 flex items-center gap-3">
            <Avatar className="size-11 rounded-lg">
              <AvatarFallback className="rounded-lg bg-primary text-primary-foreground">
                H
              </AvatarFallback>
            </Avatar>
            <div>
              <CardTitle>HDU Sniper</CardTitle>
              <CardDescription>预约工作台</CardDescription>
            </div>
          </div>
          <AnimatedShinyText className="text-xs font-semibold tracking-widest text-muted-foreground">
            SECURE ACCESS
          </AnimatedShinyText>
          <CardTitle render={<h1 />} className="text-3xl">
            登录图书馆账户
          </CardTitle>
          <CardDescription className="break-words">
            支持账号密码或企业微信扫码，登录后可管理预约方案并保持后台服务运行。
          </CardDescription>
        </CardHeader>
        <div className="grid gap-0 px-6 pb-6 md:grid-cols-[minmax(0,1fr)_1px_minmax(0,1fr)]">
          <Form onSubmit={form.handleSubmit(submit)} className="contents">
            <div className="grid content-start gap-4 md:pr-6">
              <Field>
                <FieldLabel>学号</FieldLabel>
                <Input className="w-full" autoComplete="username" {...form.register("studentId")} />
                {form.formState.errors.studentId?.message && (
                  <FieldError>{form.formState.errors.studentId.message}</FieldError>
                )}
              </Field>
              <Field>
                <FieldLabel>数字杭电密码</FieldLabel>
                <Input
                  className="w-full"
                  type="password"
                  autoComplete="current-password"
                  {...form.register("password")}
                />
                {form.formState.errors.password?.message && (
                  <FieldError>{form.formState.errors.password.message}</FieldError>
                )}
              </Field>
              {error && (
                <Alert variant="error">
                  <ShieldCheck className="size-4" />
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" loading={form.formState.isSubmitting}>
                <LogIn className="size-4" />
                进入工作台
              </Button>
              <Field>
                <FieldDescription>
                  <LockKeyhole className="mr-1 inline size-3.5" />
                  凭据仅提交给本地后台服务
                </FieldDescription>
              </Field>
            </div>
          </Form>
          <Separator orientation="vertical" className="hidden md:block" />
          <div className="grid content-start gap-4 pt-6 md:pt-0 md:pl-6">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2 text-sm font-medium">
                <QrCode className="size-4" />
                扫码登录
              </div>
              <Badge variant={qrState === "error" || qrState === "expired" ? "warning" : "secondary"}>
                {qrState === "loading" && "加载中"}
                {qrState === "ready" && "待扫码"}
                {qrState === "waiting" && "待确认"}
                {qrState === "confirmed" && "已确认"}
                {qrState === "expired" && "已过期"}
                {qrState === "error" && "异常"}
              </Badge>
            </div>
            <div className="relative mx-auto aspect-square w-full max-w-60 overflow-hidden rounded-xl border bg-background">
              {qr?.image && ["ready", "waiting", "expired", "error"].includes(qrState) ? (
                <img
                  src={qr.image}
                  alt="SSO 登录二维码"
                  className="size-full object-contain"
                />
              ) : null}
              {qrBusy && (
                <div className="absolute inset-0 grid place-items-center gap-2 bg-background/85 text-xs text-muted-foreground">
                  <Spinner className="size-5" />
                  {qrMessage}
                </div>
              )}
              {(qrState === "expired" || qrState === "error") && (
                <div className="absolute inset-0 grid place-items-center bg-background/92 p-4 text-center">
                  <div className="grid gap-3">
                    <p className="text-xs leading-5 text-muted-foreground">{qrMessage}</p>
                    <Button size="sm" onClick={() => void loadQr()}>
                      <RefreshCw className="size-4" />
                      刷新二维码
                    </Button>
                  </div>
                </div>
              )}
            </div>
            <p className="text-center text-xs leading-5 text-muted-foreground">
              扫码请求由本地后台代理，避免跨域并保护登录会话。
            </p>
          </div>
        </div>
      </Card>
    </main>
  )
}

export function LoginGate() {
  const session = useAppStore((state) => state.session)
  const setSession = useAppStore((state) => state.setSession)
  const query = useSession()
  const navigate = useNavigate()

  useEffect(() => {
    if (query.data) setSession(query.data)
  }, [query.data, setSession])

  useEffect(() => {
    if (session?.authenticated) void navigate({ to: "/plans", replace: true })
  }, [session, navigate])

  if (query.isLoading && !session) return <Busy label="正在连接后台服务..." />
  return session?.authenticated ? <Busy /> : <LoginPage />
}













