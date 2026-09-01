"use client"

import { useEffect, useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { LogIn, LockKeyhole, ShieldCheck } from "lucide-react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import { AnimatedShinyText } from "@/components/ui/animated-shiny-text"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Avatar, AvatarFallback } from "@/components/ui/avatar"
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
import { api } from "../api"
import { useSession } from "../queries"
import { useAppStore } from "../store"
import { Busy, loginSchema } from "../shared"

function LoginPage() {
  const navigate = useNavigate()
  const setSession = useAppStore((state) => state.setSession)
  const form = useForm<z.infer<typeof loginSchema>>({
    resolver: zodResolver(loginSchema),
    defaultValues: { studentId: "", password: "" },
  })
  const [error, setError] = useState("")

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

  return (
    <main className="relative grid min-h-svh place-items-center overflow-hidden p-6">
      <Card className="relative z-10 w-full max-w-md">
        <CardHeader>
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
          <CardDescription>
            管理预约方案，查看实时预约状态，保持后台服务持续运行。
          </CardDescription>
        </CardHeader>
        <Form onSubmit={form.handleSubmit(submit)} className="contents">
          <CardContent className="grid gap-4">
            <Field>
              <FieldLabel>学号</FieldLabel>
              <Input autoComplete="username" {...form.register("studentId")} />
              {form.formState.errors.studentId?.message && (
                <FieldError>{form.formState.errors.studentId.message}</FieldError>
              )}
            </Field>
            <Field>
              <FieldLabel>数字杭电密码</FieldLabel>
              <Input
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
          </CardContent>
          <CardFooter className="flex-col items-stretch gap-3">
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
          </CardFooter>
        </Form>
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
