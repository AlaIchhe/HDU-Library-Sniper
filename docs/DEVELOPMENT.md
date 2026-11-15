# 开发与发布

[返回项目首页](../README.md) · [部署说明](DEPLOYMENT.md) · [馆方限制实测](HUITU-LIMITS.md)

## 开发环境

推荐环境：

- Go 1.27+（全程 `CGO_ENABLED=0`，无 C 依赖）
- Bun 1.2+（前端构建与 MyGo CLI）
- 容器部署需要 Docker Compose 或 Podman Compose

安装前端依赖并生成 MyGo 绑定：

```bash
bun install
bun run generate
```

开发模式启动方式：

```bash
# 方式一：MyGo 桌面端热开发（自动拉起 vite dev 与 Go 桌面端）
bun run dev

# 方式二：浏览器 + 独立 Go HTTP 服务
bun run dev:web
bun run server
```

后台默认监听 `http://localhost:8000`。构建静态前端并启动服务端：

```bash
bun run local
```

常用检查命令：

```bash
bun run typecheck                  # TypeScript 类型检查
bun run check                      # Biome lint + format 检查（自动修复用 check:fix）
bun run test                       # 前端单测
bun run build:web                  # 构建前端 dist/web
CGO_ENABLED=0 go vet ./...         # Go 静态检查
CGO_ENABLED=0 go test ./...        # Go 单测
./scripts/code-audit.sh            # 全量静态与测试门禁
```

Biome 的配置在 `biome.jsonc`：2 空格缩进、双引号、行宽 110；
`src/web` 保持无分号风格，其余（`tests/` 等）保留分号。

## 多平台桌面打包

桌面端基于 [MyGo](https://github.com/egoist/mygo) 构建，全程 `CGO_ENABLED=0`：
在 Ubuntu 上即可交叉构建 Windows 安装包（需安装 `nsis`）和 Linux 发行包；macOS `.app` / `.dmg` 需在 macOS 上构建：

```bash
bun run build
```

产物输出在 `build/` 目录。需要本地打包容器服务端时：

```bash
CGO_ENABLED=0 go build ./cmd/server
```

## 自动更新与发布

桌面端更新由 MyGo 内置 `updater` 插件提供，可通过系统托盘菜单「检查更新…」触发：

- 仓库 Variable `MYGO_UPDATE_PUBLIC_KEY`：更新验证公钥（注入 `mygo.config.ts`）
- 仓库 Secret `MYGO_UPDATER_PRIVATE_KEY`：更新签名私钥

推送 `v*` 标签即可触发 [`.github/workflows/release.yml`](../.github/workflows/release.yml) 创建草稿 Release 并上传 Windows、macOS、Linux 安装包与更新清单：

```bash
git tag -a vX.Y.Z -m "Release vX.Y.Z"
git push origin vX.Y.Z
```

## 项目结构

```text
internal/core/           领域类型、上海时区（内嵌 tzdata）、方案校验
internal/hdu/            馆方 HTTP、CookieJar、AES/MD5
internal/auth/           SSO/openid/QR 登录、AES-256-GCM 凭据存储
internal/store/          纯 Go SQLite (modernc.org/sqlite) schema/CRUD
internal/booking/        抢座预锁/并发执行/状态分类
internal/scheduler/      定时调度、自动签到与同步重试
internal/server/         net/http 路由、安全中间件与 SPA 托管
internal/app/            桌面端与服务端共用的启动装配
cmd/server/              无头 HTTP 服务入口（容器部署）
main.go                  MyGo 桌面端入口（托盘、自启动、更新、通知、IPC 绑定）
mygo.config.ts           MyGo 应用与打包配置
src/shared/types.ts      前后端共享 TypeScript DTO
src/web/                 React WebUI（与生成的 src/web/mygo.ts 对接）
scripts/                 Podman、systemd 与 code-audit 脚本
tests/                   前端测试
Containerfile            静态 Distroless + 纯 Go 服务端镜像
compose.yaml             Docker Compose 编排
```
