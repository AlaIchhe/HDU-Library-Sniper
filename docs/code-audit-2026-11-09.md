# 代码审计报告 · HDU Library Sniper

- 版本：`2.0.33`　commit：`d75d070`　分支：main
- 审计时间：2026-11-09
- 范围：`crates/`、`src-tauri/src/`、`src/`、`tests/`（不含 `node_modules`、`target`、`dist`、`src/components/ui` 第三方组件单独统计）
- 方法：静态度量 + lint/类型检查 + 测试执行 + 死代码扫描 + git 变更热点 + 人工抽样阅读关键路径
- 局限：复杂度为启发式 CCN（正则计数）；Playwright e2e 未在本机执行；未做动态渗透与覆盖率采集

---

## 一、结论

**不是屎山。健康分 69/100，屎山指数 31/100 —— "轻度技术债，可维护，但有三处该动刀"。**

三句话：

1. **骨架是干净的**：`core ← hdu ← auth ← server ← tauri` 单向依赖、无环；生产代码 **0 个 `unwrap()`**；biome / tsc 零告警、clippy 仅 6 条默认警告；48 个 Rust 测试 + 30 个前端测试全绿。
2. **债务高度集中**：后端 **47.5%** 的生产代码挤在 3 个文件里（`auth` 934 行、`booking` 870 行、`library` 618 行）；Rust 公共 API 文档总共 **1 行**；有 5 份复制粘贴的 JSON 取值助手。
3. **真正的问题不在"乱"，在"边界"**：本地 API 对任意 Origin 开放 CORS 且只认全局登录态 → 用户浏览任意网页时，该网页可读写 `127.0.0.1:8000`；凭据明文落库；登录/二维码接口无限流。

> 一句话给作者：这不是屎山，是一个**正在从 TypeScript 后端迁移到 Rust 的、两个月、110 个 commit 的单人项目**，迁移残留和三个千行文件是主要气味。按当前组织方式再堆 2–3 个大功能，就会开始向"局部屎山"滑动。

### 修复状态（2026-11-09，同一分支）

| 编号 | 状态 | 落地内容 |
|---|---|---|
| P1-1 | ✅ | 删除 `CorsLayer`，新增同源守卫：Host 只允许 IP / localhost / 白名单，Origin 必须等于 Host，`Sec-Fetch-Site: cross-site` 直接 403；补 4 条测试 |
| P1-2 | ✅ | 新增 `credentials_enc`，AES-256-GCM（Windows 钥匙串或 `HDU_SNIPER_SECRET_KEY`）；启动时把旧明文迁移成密文，无密钥才退回明文并告警 |
| P1-3 | ✅ | 固定窗口限流（login/openid 5/min、二维码 3/min、签到开关 10/min、兜底 240/min）；二维码并发上限 2；连续失败 3 次锁 30 秒 |
| P2-2 | ✅ | 新增 `core::json`，替换 5 处重复的 `value_to_string` / `value_to_i64` / `format_zh` / `format_iso` |
| P2-3 | ✅ | 删除 `src/shared/plan-validation.ts` 及其测试 |
| P2-4 | ◐ | 补齐 crate 级文档和主要 pub 项注释；字段级文档可继续补 |
| P2-5 | ✅ | `meta.schema_version` + 版本化迁移（当前 v2） |
| P3-4 | ✅ | CI 增加 rustfmt、clippy `-D warnings`、jscpd 3% 门禁；清掉原有 6 条 clippy 警告 |
| P2-1 | ⏳ | 三个千行文件的拆分留待独立重构提交（纯移动，单独 PR 便于 review） |
| P3-1 | ⏳ | 随机端口 + 资源目录涉及前后端启动协议，单独做 |
| P3-2 | ⏳ | 前端长页面拆分同上 |
| P3-3 | ◐ | 文档已更新；`@tauri-apps/api` 未删（需同步 `bun.lock`），媒体文件未迁移 |

修复后基线：**61 个 Rust 测试 + 29 个前端测试全绿**，clippy `-D warnings` 0 告警，重复率仍低于 3%。

### 判定标尺

| 指标 | 屎山警戒线 | 本项目 | 判定 |
|---|---|---|---|
| 单文件最大生产行数 | > 2000 | 934（auth） | ✅ 未越线，但已进入千行区间 |
| CCN ≥ 15 的函数占比 | > 5% | 0.18%（1/550） | ✅ |
| 重复代码率 | > 5% | 0.62% | ✅ |
| 生产代码 `unwrap()` | 常见 | 0 | ✅ |
| 有测试且能跑 | 无测试 | 78 个单测，全绿 | ✅ |
| 模块循环依赖 | 存在 | 0 | ✅ |
| 千行文件占后端比例 | > 30% | 47.5% | ⚠️ |
| 代码内文档/注释 | < 5% 视为贫血 | 注释 1.8%，Rust doc 0.02% | ❌ |
| 本地 API 安全边界 | 无鉴权/任意源 | CORS `*` + 全局登录态 | ❌ |

**屎山指数 = 100 − 加权健康分（69）= 31。** 分级：0–20 干净 / 20–40 轻度 / 40–60 中度 / 60–80 重度 / 80+ 屎山。

---

## 二、这次用的审计管线

管线设计参考了 CodeScene 的 hotspot 方法（变更频率 × 复杂度）、Qlty/Sonar 的复杂度与可维护性度量，以及 Rust/TS 各自的事实标准工具链：

- <https://codescene.io/docs/guides/technical/hotspots.html>
- <https://docs.qlty.sh/complexity>
- <https://docs.sonarsource.com/sonarqube-server/user-guide/code-metrics/metrics-definition>
- <https://zhauniarovich.com/post/2021/2021-09-pedantic-clippy>
- <https://biomejs.dev/linter/rules/no-explicit-any/javascript/>

| # | 维度 | 工具 | 命令（本仓库） | 本次结果 |
|---|---|---|---|---|
| 1 | 体量 / 语言分布 | 脚本内置 + scc/tokei | `./scripts/code-audit.sh` | 14,485 行代码 / 105 文件 |
| 2 | 圈复杂度 / 函数长度 / 嵌套 | 自写启发式（等价 lizard） | `lizard crates -C 10` | 550 函数，max CCN 20 |
| 3 | 重复代码 | jscpd 4 | `npx jscpd --min-lines 12 --min-tokens 70 --format rust,typescript,tsx,css` | 0.62%（71 行，4 处） |
| 4 | Rust lint | clippy | `cargo clippy --workspace --all-targets --message-format=short` | 6 warning（4 条可 `--fix`） |
| 5 | Rust 格式 | rustfmt | `cargo fmt --all -- --check` | 通过 |
| 6 | Rust 测试 | cargo test | `cargo test --workspace` | 48 passed |
| 7 | TS lint / 格式 | Biome 2.6.5 | `biome ci src tests *.json` | 0 diagnostics |
| 8 | TS 类型 | tsc strict | `tsc --noEmit` | 通过 |
| 9 | 前端测试 | Vitest | `vitest run` | 30 passed（7 文件） |
| 10 | 死代码 / 未用导出 | knip 5 | `npx knip` | 1 个未用依赖，39 个未用导出（多数在 `components/ui`） |
| 11 | 变更热点 | git churn × 复杂度 | `git log --numstat` 聚合 | 见 §5.4 |
| 12 | 架构 / 依赖方向 | cargo tree + 人工 | `cargo tree`、读 `build_router` | 无环、分层清晰 |
| 13 | 密钥启发式扫描 | ripgrep 正则 | AKIA/sk-/ghp_/PRIVATE KEY | 未发现 |

> 踩坑记录：审计产物（NDJSON / JSON）如果落在仓库内，会被 `biome ci .` 当成待格式化 JSON，产生 700+ 条 parse 错误。本次给 `biome.jsonc` 补了 `!.audit`，脚本输出固定到 `.audit/`（已 gitignore），不再污染 CI。

---

## 三、代码地图

### Rust 后端（生产 5,103 行 / 21 个文件）

| crate | 生产行 | 职责 | 评价 |
|---|---:|---|---|
| `core` | ~300 | 领域类型、时间计算、方案校验 | 干净，纯函数，测试齐全 |
| `hdu` | ~820 | 馆方 HTTP 客户端、Cookie、SSO 加密 | 协议适配层，边界清楚；`library.rs` 偏大 |
| `auth` | 934 | 账密登录、openid、扫码轮询、会话持久化、刷新回滚 | **上帝服务**，26 个方法挤在一个 `AuthService` |
| `store` | 465 | SQLite、方案/分组/会话/审计 | 接口清晰；迁移方式原始 |
| `server` | ~2,400 | axum 路由、预约执行器、调度器、方案 CRUD | 拆分基本合理，`booking.rs` 偏大 |
| `src-tauri` | 141 | 桌面壳、托盘、内嵌 API | 简洁 |

依赖方向（无环）：

```
core ← hdu ← auth ← server ← src-tauri
  ↑       ↑       ↑
  └──── store ────┘
```

### 前端（7,608 行 TS/TSX，其中 `components/ui` 第三方 3,718 行）

| 区域 | 行数 | 说明 |
|---|---:|---|
| `src/web/components` | ~3,000 | 页面级组件，React Query + RHF + Zod |
| `src/components/ui` | 3,718 | shadcn/base-ui 风格组件库，按第三方对待 |
| `src/web/{api,queries,store,updater}` | ~700 | 数据层，Zod 在 API 边界校验 |
| `tests` | 420 | 7 个单测 + 2 个 Playwright spec |

---

## 四、记分卡

| 维度 | 权重 | 得分 | 依据 |
|---|---:|---:|---|
| 结构与模块化 | 20% | 6.5 | 分层干净、无环；但 3 个文件占后端 47.5% |
| 复杂度控制 | 15% | 8.0 | max CCN 20；仅 16/550 函数 ≥ 10；max 嵌套 6 |
| 重复代码 | 10% | 7.5 | jscpd 0.62%；但 `value_to_string`/`value_to_i64` 复制 5 份 |
| 可读性与命名 | 10% | 8.0 | 命名达意、无 TODO/FIXME、无注释掉的死代码 |
| 文档 | 10% | 3.0 | 外部文档 413 行 + 5 张图；代码内 Rust doc 仅 1 行 |
| 测试 | 15% | 7.0 | 78 个单测全绿、有 wiremock；无覆盖率门禁、e2e 仅 2 条且未跑 |
| 错误处理 | 10% | 9.5 | 生产 0 unwrap、thiserror 分类、`anyhow` 只在 main |
| 安全边界 | 10% | 4.0 | CORS `*`、明文凭据、登录/二维码无限流 |

加权：`0.20×6.5 + 0.15×8 + 0.10×7.5 + 0.10×8 + 0.10×3 + 0.15×7 + 0.10×9.5 + 0.10×4 = 6.75`；工程化加成 +0.15（CI、Biome、clippy、rustfmt 都在）→ 6.90 → **69/100**。

---

## 五、问题清单

### P1-1　本地 API 对任意网页开放（CORS `*` + 全局登录态）

**证据**：`crates/server/src/lib.rs:135-140`

```rust
.layer(
    CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any),
)
```

鉴权只有 `require_auth`（`crates/server/src/lib.rs:144-154`），判断的是"当前进程是否已登录馆方账号"，与请求来源无关；API 固定在 `127.0.0.1:8000`（`src-tauri/src/lib.rs:53`）。

**影响**：用户登录期间打开任意恶意/被挂马的网页，该网页即可 `fetch` 本地 API 并**读取响应**：预约记录、方案、学号姓名、审计事件；也可**发起操作**：取消预约、触发抢座、开关自动签到。预检也会被 `allow_headers(Any)` 放行，不存在浏览器侧拦截。

**修复**（半天）：

1. CORS 改成白名单：`tauri://localhost`、`http://tauri.localhost`、`http://localhost:5173`（dev）、`http://127.0.0.1:8000`。
2. 启动时生成随机 token（写进 Tauri 侧注入的 `window.__APP_TOKEN__` 或环境），前端每个请求带 `X-App-Token`，`require_auth` 同时校验 token 与登录态。
3. 加 `Origin`/`Host` 校验，拒绝 `Sec-Fetch-Site: cross-site`。

### P1-2　账号凭据明文落库

**证据**：`crates/store/src/lib.rs:29-38`（`password TEXT`）、`crates/auth/src/lib.rs:382`（`password: password.to_string()`）；README 已明确自述"以明文保存在本机 SQLite"。

**影响**：同机任意进程、同步盘/备份、取证镜像、误发的 `.sqlite` 都能直接拿到统一身份认证密码（学生往往复用密码）。这是**已知取舍**，但对一个处理校园账号的工具，风险等级仍然偏高。

**修复**（1 天）：

- 首选：密码交给 OS 钥匙串（Windows Credential Manager / macOS Keychain / libsecret），SQLite 只存引用。
- 次选：用 `keyring` 取机器绑定密钥做 AES-GCM 加密；密钥不落盘。
- 至少：启动时提示"记住密码=明文存储"，默认不记住。

### P1-3　未认证接口无限流 + 无界任务派生

**证据**：`crates/server/src/session.rs:23-39`（`/api/session/login`）、`:61-69`（`/api/session/qr`）；`crates/auth/src/lib.rs:726-728` 每次调用 `tokio::spawn` 一个 90 秒轮询任务。

**影响**：结合 P1-1，任意网页可循环 POST 二维码接口：每次触发 2 个对馆方 SSO 的出站请求并派生一个长任务 → 本机资源放大 + 对学校 SSO 的高频请求（可能触发风控/封禁）。登录接口同样可被用来做撞库探测（无速率限制、无失败退避）。

**修复**（半天）：令牌桶限流（如 3 次/分钟/IP）、二维码同时最多 2 个会话、登录失败指数退避、给派生任务加 `JoinSet` 上限。

### P2-1　三座千行"上帝文件"（后端 47.5%）

| 文件 | 生产行 | 函数数 | 主要职责（本应拆分） |
|---|---:|---:|---|
| `crates/auth/src/lib.rs` | 934 | 26 方法 | SSO 表单解析、重定向跟随、账密登录、openid、扫码轮询、会话持久化、刷新/回滚 |
| `crates/server/src/booking.rs` | 870 | 53 | 预约执行、节奏控制、锁座、失败分类、座位解析、响应判定 |
| `crates/hdu/src/library.rs` | 618 | 40 | HTTP 客户端、房间/楼层/时长解析、下单、签到、Cookie 刷新回调 |

**判定**：这不是"乱"，是"密度过高"。单文件承担 4–7 个变化理由，改一处要读一千行，review 和测试定位成本都在上升。clippy 也在这里报了 `too_many_arguments`（`execute_plan` 8 个参数，`booking.rs:384`）——参数表本身就是职责过载的体征。

**修复**（1–2 天，纯移动、不改行为）：

- `auth` → `sso.rs`（表单/重定向/CSRF）、`qr.rs`（扫码状态机）、`session.rs`（持久化/恢复/刷新）、`password.rs`（账密 + openid）；`AuthService` 保留编排。
- `booking` → `executor.rs`、`classify.rs`（失败分类/响应判定）、`seat.rs`（座位解析）、`pacing.rs`（节奏/退避）。
- `library` → `client.rs` + `parse.rs`（JSON → 领域类型）。

### P2-2　复制粘贴的 JSON 取值助手

`value_to_string` / `value_to_i64` 在 5 个文件各一份（共 10 个函数）：`crates/hdu/src/library.rs:547,555`、`crates/server/src/booking.rs:856,864`、`crates/server/src/bookings.rs:117,125`、`crates/server/src/catalog.rs:128,136`、`crates/server/src/scheduler.rs:493,501`；`format_zh` 两份：`bookings.rs:104`、`runtime.rs:128`。约 70 行重复。

**影响**：小，但这是"复制比抽象快"的典型信号；一旦有人修了其中一份的 `null` 处理，其余四份就漂移。

**修复**（1 小时）：在 `crates/core` 建 `json.rs`（`str_field`/`i64_field`/`fmt_zh`），五处替换。

### P2-3　TS→Rust 迁移残留：`plan-validation.ts`

**证据**：`src/shared/plan-validation.ts` 的 `validatePlan` 只被 `tests/plans.test.ts:2` 引用，生产代码 0 引用；规则与 `crates/core/src/plan.rs:15` 完全重复，连中文错误文案都一模一样。

**影响**：死代码靠自己的测试"续命"；两份校验规则会漂移（前端以为校验过、后端实际规则不同）。

**修复**：删除该文件与对应测试；规则只保留 Rust 侧（或从 Rust 生成 JSON Schema 给前端）。

### P2-4　公共 API 文档近乎为零

**证据**：5,103 行 Rust 生产代码里 `///` 只有 1 行（`crates/hdu/src/auth.rs:39`）；整体注释率 1.8%。

**影响**：外部文档（README/DEVELOPMENT/rust-backend + 5 张 mermaid 图，质量不错）覆盖了"怎么跑"，但没有覆盖"每个 pub 项为什么这样"。半年后回来看 `BookingExecutor::run_burst` 的 4 秒/10 分钟参数，只能靠猜。

**修复**：只给 `pub` 项补一行 `///`，优先 `core`/`hdu` 的协议常量与 `server` 的执行器入口；配合 `#![warn(missing_docs)]`（先 allow，逐步收紧）。

### P2-5　手写列迁移，没有 schema 版本号

**证据**：`crates/store/src/lib.rs:102-121` 用一张硬编码 `(table, column, definition)` 列表逐列 `PRAGMA table_info` + `ALTER TABLE`。

**影响**：当前只有加列，能工作；一旦要改类型/回填/删列就没有落点，也没有"这个库是哪个版本"的可观测性。

**修复**：加 `meta.schema_version`，迁移写成有序数组 `(version, sql)`，启动时事务内逐条应用。

### P3-1　固定端口 + 相对路径静态目录

`src-tauri/src/lib.rs:53` 固定 `127.0.0.1:8000`（端口被占则本地 API 静默失败，仅写日志）；`crates/server/src/lib.rs:132-134` 的 `ServeDir::new("dist/web")` 依赖进程 CWD。

**修复**：端口 0 让内核分配 + 通过 Tauri `invoke` 把 base URL 传给前端；静态目录用 `app.path().resource_dir()`。

### P3-2　前端两个长页面文件

`src/web/components/plans-page.tsx` 839 行含 7 个组件（`PlanEditor` 约 180 行、`GroupEditor` 约 100 行）；`app-shell.tsx` 639 行含 6 个组件。**长而不绕**：CCN 都很低，没有 `useEffect` 链，状态用 RHF/Zustand/React Query 管得很干净。属于"该拆但不用急"。

### P3-3　依赖与仓库卫生

- `@tauri-apps/api` 在 `package.json` 中但源码 0 引用（knip 命中）。
- `typescript: 7.1.0-beta` 用于正式构建链，beta 编译器升级可能引入行为差异。
- `docs/media` 里 18MB GIF + 9.5MB MP4 进 git（演示用，建议放 Release 附件或压缩）。
- 未使用的导出 39 个，绝大多数在 `src/components/ui`（组件库正常现象，可忽略）。

### P3-4　CI 门禁缺口

`.github/workflows/ci.yml` 已跑 Biome、`tsc`、`cargo test` —— 这已经比多数同类项目好。缺的是：

- `cargo clippy -- -D warnings`（当前 6 条：4 条 `--fix` 可清，2 条手工改，清零后锁死）
- `cargo fmt --check`
- 覆盖率（`cargo llvm-cov` + `vitest --coverage`）
- 依赖审计（`cargo audit` / `bun audit`）
- 体量与重复率门禁（单文件 > 1000 行、jscpd > 3% 直接失败）
- `knip`（当前能稳定抓到未用依赖/导出）

---

## 六、重构处方（按 ROI 排序）

| 顺序 | 动作 | 工作量 | 收益 |
|---|---|---|---|
| 1 | 删除 `plan-validation.ts` + 其测试 | 10 分钟 | 去掉一处双份规则 |
| 2 | 抽 `core::json` 助手，替换 5 处复制 | 1 小时 | 去掉约 70 行重复，统一空值语义 |
| 3 | CORS 白名单 + 本地 token + Origin 校验 | 半天 | 堵住"任意网页操控本地 API" |
| 4 | 登录/二维码限流 + 任务上限 | 半天 | 去掉放大面 |
| 5 | 拆 `auth` 为 4 个模块（纯移动） | 1 天 | 最大的一笔结构债清零 |
| 6 | 拆 `booking`、`library` | 1 天 | 后端不再有千行文件 |
| 7 | 凭据进钥匙串/加密 | 1 天 | 明文密码风险下降一个量级 |
| 8 | CI 六件套门禁 + 覆盖率 | 半天 | 防止回潮 |
| 9 | 拆 `plans-page` / `app-shell` | 半天 | 前端文件回到 300 行内 |

**不要做的事**：不要为了"看起来整齐"重写 `scheduler` 或前端状态层——这两块目前的设计（可注入 sleep、React Query + Zod、单一 Zustand store）是对的，重写只会引入回归。

---

## 七、可持续的审计管线（可直接抄）

### 7.1 本地一条命令

仓库已附带 `scripts/code-audit.sh`：

```bash
./scripts/code-audit.sh            # 全部阶段
AUDIT_OUT=/tmp/hdu-audit ./scripts/code-audit.sh
```

阶段：体量 → 大文件 → rustfmt → clippy → cargo test → biome → tsc → vitest → jscpd → knip。默认把 clippy 警告记为 WARN，`CLIPPY_STRICT=1 ./scripts/code-audit.sh` 可升为门禁；jscpd 超过 3% 直接失败。输出默认写入 `.audit/`（已 gitignore + biome 排除）。

### 7.2 CI 增量（建议追加到 `ci.yml`）

```yaml
      - name: Rust lint
        run: |
          rustup component add clippy rustfmt
          cargo fmt --all -- --check
          cargo clippy --workspace --all-targets -- -D warnings

      - name: Duplication gate
        run: npx --yes jscpd@4 --min-lines 12 --min-tokens 70 \
          --format rust,typescript,tsx --threshold 3 \
          --ignore "**/node_modules/**,**/target/**,**/components/ui/**" src crates

      - name: Dead code / deps
        run: npx --yes knip@5 --no-progress

      - name: Dependency audit
        run: |
          cargo install cargo-audit --locked
          cargo audit
```

覆盖率（可选，先观察不设卡）：

```bash
cargo install cargo-llvm-cov --locked
cargo llvm-cov --workspace --summary-only
./node_modules/.bin/vitest run --coverage
```

### 7.3 想上仪表盘

- 轻量：Qlty CLI（`qlty check` / `qlty metrics`），本地 + PR 注释。
- 重一点：SonarQube（Community）+ `sonar-scanner`，认知复杂度、重复率、覆盖率一张看板。
- 热点：CodeScene 的思路可以手工复刻——`git log --numstat` 聚合 churn，乘以函数复杂度，每季度看一次 Top 10。

---

## 八、复现与原始数据

```bash
# 体量 / 复杂度（本次用的脚本在报告附录，或直接用 scc + lizard）
scc --no-cocomo crates src src-tauri
lizard crates src-tauri/src -C 10 -L 80 -w

# 重复
npx jscpd@4 --min-lines 12 --min-tokens 70 --format rust,typescript,tsx src crates

# Rust
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings
cargo test --workspace

# 前端
./node_modules/.bin/biome ci src tests
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/vitest run
npx knip@5

# 热点
git log --pretty=format: --numstat | awk 'NF==3 && $1!="-" {a[$3]+=$1+$2; n[$3]++} END {for (f in a) print a[f], n[f], f}' | sort -rn | head -20
```

**关键数字备忘**：14,485 行代码 / 105 文件；Rust 生产 5,103 行、测试 1,418 行；TS 7,608 行代码（UI 库原始 3,718 行）；550 函数、16 个 CCN ≥ 10、max 20；重复 0.62%；注释 1.8%；Rust doc 1 行；clippy 6 条；78 个单测全绿（2 条 e2e 未跑）；110 commits / 单人 / 2026-09-02 起。

---

## 九、正面清单（别改坏的地方）

- **错误处理**：生产代码 0 `unwrap`，`thiserror` 分域错误 + `ApiError` 统一映射；`anyhow` 只出现在 `main`。
- **可测试性**：`BookingExecutor::with_sleep` 注入时钟、wiremock 模拟 SSO；调度循环用 `sleep` 而非忙等。
- **前端数据层**：React Query 管服务端状态、Zustand 管 UI 状态、Zod 在 API 边界做运行时校验；401 会清会话并回登录页。
- **工程化**：Biome + tsc strict + rustfmt + CI；`README`/`DEVELOPMENT`/`DEPLOYMENT` + 5 张架构图，外部文档质量高于平均。
- **依赖方向**：`core` 不依赖任何人，`hdu` 不依赖 `auth`，`server` 只做编排——这条线守住了，后面拆文件不会伤筋动骨。