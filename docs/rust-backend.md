# Rust 后端迁移

当前工作分支：`feat/rust-backend`。

目标是把 Bun 侧车替换为 Rust，并让桌面端和容器端共用业务核心：

```text
                 ┌─ Tauri commands（桌面）
Rust core ───────┤
                 └─ axum HTTP（容器）
```

## 当前进度

已完成：

- Cargo workspace 骨架；
- `crates/core`：共享类型、上海时区预约锚点、预锁时间、plan validation；
- `crates/store`：与现有 SQLite schema 兼容的 plans/groups/session/audit CRUD；
- `crates/server`：axum 骨架，health + plans/groups CRUD；
- `crates/hdu`：CookieJar、AES-128-ECB、openid 解析、馆方 LibraryClient（validate、房间类型、预约范围、座位图、预约列表、book/lock/action）；
- 使用 wiremock 覆盖馆方请求、Cookie、AES、Api-Token 和错误映射；
- 29 个 Rust 测试通过。

尚未完成：

- 完整 AuthService：SSO 学号密码登录、二维码登录、openid 会话、Cookie 持久化、会话恢复；
- scheduler、签到、预约执行；
- catalog、bookings、runtime status、check-in API；
- Tauri command 适配层与前端 transport；
- Bun 源码/侧车移除；
- 与 Bun 的双跑差分测试。

当前 Tauri 仍使用原来的 Bun 侧车；新 Rust server 还没有接进桌面端。

## 目录

```text
Cargo.toml
crates/
  core/
  hdu/
  store/
  server/
src-tauri/       # 现有 Tauri 桌面端
src/web/         # React 前端
```

依赖方向：

```text
core  ← hdu
core  ← store
core  ← server
core  ← src-tauri
```

## 本地检查

```bash
# 当前阶段只检查新 crate，避免在 Linux 上编译 Tauri/WebKit
cargo check -p hdu-sniper-core -p hdu-sniper-hdu -p hdu-sniper-store -p hdu-sniper-server --all-targets

cargo test -p hdu-sniper-core -p hdu-sniper-hdu -p hdu-sniper-store -p hdu-sniper-server
```

别名：

```bash
cargo check-rust
cargo test-all
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
- release 的 LTO/strip 只用于最终产物，日常用 dev/check；
- `rusqlite` 的 bundled SQLite 第一次编译较慢，之后由 target cache 复用。

## 迁移顺序

1. 对现有 Bun 服务补 HTTP 契约/差分测试；
2. 移植 HDU client + Cookie + 加密；
3. 移植 scheduler/booking；
4. 移植 catalog/bookings/runtime API；
5. 接入 Tauri commands / desktop transport；
6. 双跑 Bun/Rust，确认行为一致；
7. 删除 Bun 侧车、更新构建和安装包。

## 数据兼容

SQLite 路径保持 `~/.hdu-library-sniper/data/hdu-sniper.sqlite`（可由 `HDU_SNIPER_HOME` 覆盖），表结构直接读取现有数据库；迁移只能加列，不能破坏已有用户数据。
