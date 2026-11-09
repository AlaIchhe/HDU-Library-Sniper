# Rust 后端迁移

当前工作分支：`feat/rust-backend`。

目标是把 Bun 侧车替换为 Rust，并让桌面端和容器端共用业务核心：

```text
                 ┌─ Tauri 进程内 axum（桌面）
Rust core ───────┤
                 └─ axum HTTP（容器）
```

桌面端不再是 sidecar：Tauri 进程直接启动 axum，监听 `127.0.0.1:8000`；容器运行同一个 `hdu-sniper-server` 二进制。Bun 只保留作前端构建工具。

## 当前进度

已完成：

- Cargo workspace：`core`、`hdu`、`auth`、`store`、`server`；
- `core`：共享类型、上海时区预约锚点、预锁时间、plan validation；
- `store`：兼容现有 SQLite schema 的 plans/groups/session/audit CRUD；
- `hdu`：CookieJar、AES-128-ECB、openid 解析、馆方 LibraryClient；
- `auth`：学号密码 SSO、二维码登录、openid 登录、restore/refresh/logout、session 持久化、凭据加密与迁移；
- `server`：axum 容器 API、Tauri 进程内 API、同源守卫与限流、静态 Web 资源；
- scheduler：20:00 预约锚点、预锁、burst 重试、自动签到、结果审计；
- LibraryClient 在登录失效时调用 AuthService.refresh 并重试一次原请求；
- booking executor：主/备选座位、已有预约幂等、封禁/限流/流程异常分类、结果确认；
- 61 个 Rust 测试通过（core 9、hdu 15、auth 11、store 7、server 19）；
- Tauri 已改为进程内 Rust server，容器镜像已改为 Rust 二进制；
- 前端移除 stop_backend/start_backend 调用，更新时不再管理 sidecar。

已验证：

- Bun 与 Rust 的 `/api/session`、plans CRUD、groups、`/api/runtime/status`、`/api/runtime/next-target`、`/api/checkin`、`/api/audit` 在相同 SQLite session 下返回一致（除 id/时间戳）；
- Tauri debug 二进制在 Xvfb 下启动成功，进程内 API 返回 health/session/plans；
- Rust 容器镜像构建成功（97.2 MB），容器内静态 index、health、session 和 401 鉴权均正常。

尚未完成：

- HDU 依赖 API 的更完整契约测试（已有 15 个 hdu wiremock 测试覆盖登录、座位、预约和错误映射）；
- 用 CI 的 Windows runner 实际构建并安装一次 NSIS 安装包，确认升级路径（本地 Linux 环境只验证了 Tauri debug 版）。

## 目录

```text
Cargo.toml
crates/
  core/       领域类型、时间规则、plan validation
  hdu/        馆方 HTTP、Cookie、AES/MD5、Api-Token
  auth/       SSO/openid/QR 登录、会话
  store/      SQLite schema/CRUD
  server/     axum API、scheduler、booking
src-tauri/    Tauri 桌面端（进程内启动 server）
src/web/      React 前端
Containerfile Rust server + 静态前端
```

依赖方向：

```text
core  ← hdu
core  ← auth
core  ← store
core  ← server
server ← src-tauri
```

## 本地检查

```bash
cargo check-rust
cargo test -p hdu-sniper-core -p hdu-sniper-hdu -p hdu-sniper-auth -p hdu-sniper-store -p hdu-sniper-server
```

Tauri 集成检查（Linux 需要 WebKitGTK/GTK 系统依赖）：

```bash
cargo check -p hdu-library-sniper
```

Windows/CI 上再跑完整的：

```bash
cargo check --workspace --all-targets
```

## 快速编译建议

- `cargo check` 代替 `cargo build`；
- `sccache`；
- `cargo-nextest`；
- Windows Defender 排除 `target/`、`.cargo/`；
- Windows 可测试 `lld-link`；
- release 的 LTO/strip 只用于最终产物；日常用 dev/check；
- `rusqlite` 的 bundled SQLite 第一次编译较慢，之后由 target cache 复用。

## 数据兼容

SQLite 路径保持 `~/.hdu-library-sniper/data/hdu-sniper.sqlite`（可由 `HDU_SNIPER_HOME` 覆盖），表结构直接读取现有数据库；迁移只能加列，不能破坏已有用户数据。

## 迁移收尾

1. 在 Windows runner 构建 NSIS 并安装验证；
2. 补充 HDU 依赖 API 的 wiremock 契约测试；
4. 更新 README/部署文档，发布下一版。