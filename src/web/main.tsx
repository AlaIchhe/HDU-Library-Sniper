import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { RouterProvider } from "@tanstack/react-router"

import { router } from "./routes/router"
import { initializeTheme } from "./store"
import { isTauri } from "./tauri"
import "./index.css"

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, retry: 1 },
  },
})

initializeTheme()

if (isTauri()) {
  // 把 Rust 侧日志转发到 WebView 控制台，方便排查打包环境问题
  void import("@tauri-apps/plugin-log").then(({ attachConsole }) => attachConsole()).catch(() => undefined)
}
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
)
