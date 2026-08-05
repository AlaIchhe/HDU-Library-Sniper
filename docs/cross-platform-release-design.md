# 全平台发布实现设计

> 目标平台：Windows、macOS、Linux、iOS、Android、Docker  
> 基线版本：HDU Library Sniper 1.7.0 / Flet 0.86.x / Python 3.11+
> 发行范围：测试版/侧载分发，不面向 Google Play、App Store 等官方商店

## 1. 结论

采用“共享业务核心 + 独立本地实例 + 各平台调度适配器”。六种发行形态之间不建立控制关系，也不依赖中心服务：

1. **Windows、macOS、Linux**：在当前电脑本地保存配置、凭据和登录态，由当前系统的原生调度器启动本地无头任务。
2. **Android**：在当前手机本地保存数据；使用 AlarmManager 精确闹钟唤醒 BroadcastReceiver，再启动短时前台服务执行本地预约流程。
3. **iOS**：在当前手机本地保存数据；应用暴露 App Intent，由用户在本机“快捷指令”中建立“特定时间”个人自动化；AlarmKit/本地通知用于精确提醒和操作入口。
4. **Docker**：是在用户自有服务器或主机上运行的独立本地实例，配置、凭据、调度和日志全部属于该容器部署；不向桌面端或移动端提供远程操控策略。
5. **实例彼此隔离**：不同设备不会自动同步方案、凭据、Cookie、日志和任务状态。同一账号若在多台设备重复启用计划，可能产生并发执行，必须由用户自行只启用一个实例，或由本地幂等检查降低冲突。

平台能力需要如实展示：Android 精确闹钟会因权限撤销、强制停止、重启未重建或厂商限制而失效；iOS 的定点业务执行依赖用户显式创建的快捷指令个人自动化，应用自身不能静默创建这种系统自动化。

移动端不再假设 Python 进程常驻：系统调度负责在目标时间附近唤起应用，Python 只作为被唤醒后的短生命周期执行器运行预约/签到任务。Android 可以做到接近准点执行；iOS 受系统后台执行限制，只能承诺“尽力执行”，不能把快捷指令自动化视为准点保证。用户显式创建快捷指令个人自动化属于本设计接受的配置方式。

发行范围定位为测试版/侧载分发，不进入 Google Play、App Store 或国内官方商店；因此 AAB、TestFlight、App Store Connect 和商店审核不作为设计目标。移动端第一版只面向受控测试者，Android 通过签名 APK 侧载，iOS 通过开发签名或 Ad Hoc IPA 安装。

## 2. 现状评估

### 2.1 可直接复用

- `src/hdu_sniper/application.py` 已形成统一应用门面，UI/API 与业务逻辑边界较清楚。
- `src/hdu_sniper/runtime.py` 是组合根，便于按平台注入调度、密钥和更新适配器。
- `src/hdu_sniper/ui/flet_view.py` 已同时服务桌面和 Web，可继续复用。
- `src/hdu_sniper/server.py` 已有 FastAPI 宿主和部分 `/api/v1` 路由。
- `src/hdu_sniper/paths.py` 使用 `platformdirs`，桌面和容器目录策略基本合理。
- Docker 已区分 `web`、`run-now`、`scheduled` 三类运行模式。

### 2.2 必须改造

1. `SchedulerService` 同时包含 Windows Task Scheduler、cron 和 `at`，需要拆成接口与平台实现。
2. macOS 当前复用 cron；正式产品应改为 `launchd`，Linux 应优先 `systemd --user`，cron 仅作为兼容回退。
3. 凭据仍以 YAML 明文持久化；桌面和移动端应使用系统安全存储。
4. FastAPI 当前仅用进程内 `authenticated` 状态保护；Docker 的 Web UI 应默认只监听本机或由用户自行配置局域网访问，不设计公网远程控制。若用户主动反向代理到公网，需明确这是用户自负责任的部署行为，并至少提供本地认证、TLS、CSRF/CORS 和限流能力。
5. 当前桌面构建使用已归档路线 `flet pack`/PyInstaller；新增全平台发布应迁移到 `flet build`。
6. `cryptography` 等二进制依赖必须验证对应 iOS/Android wheel；否则移动构建会失败。
7. `requests.packages.urllib3.disable_warnings()` 与 `verify=False` 不适合作为任何正式发行版的默认配置，应恢复 TLS 校验并针对异常证书单独处理。
8. 更新器仅支持 Windows 内置安装；macOS/Linux 应跳转下载页或使用各自更新渠道。测试版 Android 通过 GitHub Releases/受控链接分发，iOS 通过开发签名或 Ad Hoc IPA 分发，不使用官方商店更新。
9. Flet 当前仍没有官方“无 UI 后台 Python 入口”（flet-dev/flet#5958）；移动端后台执行必须由原生层（serious_python 或 Kotlin/Swift 桥）启动嵌入式 Python，不能假设 Flet 自带移动宿主可以直接作为后台执行器。

## 3. 目标架构

```text
apps/
  flet_app/                    # 统一 Flet 视图与入口
src/hdu_sniper/
  domain/                      # 模型、规则、DTO，无 OS/UI 依赖
  use_cases/                   # 认证、方案、预约、签到等用例
  infrastructure/
    library_api/               # 慧图/SSO HTTP 实现
    persistence/               # YAML/SQLite 仓储
    secrets/                   # Keyring/Keychain/Keystore/环境变量
    notifications/             # 当前实例的系统通知与 Webhook
  platform/
    scheduler.py               # SchedulerPort
    desktop/
      windows_task.py
      macos_launchd.py
      linux_systemd.py
    container/
      local_scheduler.py       # 容器内独立调度，不负责远程控制
    mobile/
      android/                 # Kotlin 原生：AlarmReceiver、ForegroundService、BootReceiver
      ios/                     # Swift 原生：AppIntent、Shortcut、BGTask
      embedded/                # 被原生桥唤醒后调用的 Python 短任务入口
  api/                         # 当前实例的本地 FastAPI/Web 宿主
  ui/                          # Flet 页面/组件
```

在不进行全量重构时，`embedded/` 复用 `BookingRunner.run_once(execute_at=...)` 和
`--checkin-wait` 等现有入口；`android/`、`ios/` 只负责系统调度、权限和进程生命周期，
不把长网络任务写在原生接收器里。

核心端口建议：

```python
class SchedulerPort(Protocol):
    def ensure_daily(self, hour: int, minute: int) -> ScheduleResult: ...
    def remove_daily(self) -> ScheduleResult: ...
    def status(self) -> SchedulerStatus: ...

class SecretStore(Protocol):
    def get_credentials(self) -> Credentials | None: ...
    def save_credentials(self, value: Credentials) -> None: ...
    def clear_credentials(self) -> None: ...
```

组合根根据 `RuntimeKind` 注入：

- `DESKTOP_WINDOWS` → Windows Task Scheduler + Windows Credential Manager。
- `DESKTOP_MACOS` → launchd + Keychain。
- `DESKTOP_LINUX` → systemd user timer/cron fallback + Secret Service。
- `CONTAINER_LOCAL` → 容器内调度器 + Docker Secrets/环境变量 + 当前实例 Web UI。
- `MOBILE_ANDROID` → Android ExactAlarm 适配器 + Android Keystore。
- `MOBILE_IOS` → App Intent/快捷指令适配器 + Keychain + AlarmKit 提醒。

## 4. 独立本地实例拓扑

所有平台遵循同一个边界：当前安装或部署只管理当前设备上的数据和任务。

- 凭据、Cookie、方案、调度状态和日志都保存在当前实例的标准数据目录或系统安全存储中。
- Windows、macOS、Linux 由当前操作系统的原生调度器启动本地无头入口。
- Android 由当前设备的精确闹钟唤醒短生命周期本地执行链路，Python 进程只在被唤醒后运行，并持续检查授权、重启和厂商限制状态。
- iOS 由用户在当前设备“快捷指令”中显式创建“特定时间”个人自动化；AlarmKit/本地通知负责精确提醒，业务执行按尽力而为处理，不承诺准点。
- Docker 使用容器内 cron/调度进程执行，Web UI 只管理该容器挂载卷中的本地实例。
- 每次执行记录计划 ID、计划日期、实际触发时间、请求结果和核验结果。运行前检查当天执行记录，减少同一实例重复执行。
- 不提供设备发现、远程绑定、跨设备同步、远程任务下发、中心账号或云端控制面。

### 4.1 Docker 本地访问边界

- 默认 Web UI 绑定 `127.0.0.1`；Docker 端口映射由用户自行决定。
- 若部署在无桌面服务器，用户可在该服务器本机浏览器访问，或自行通过 SSH 隧道/局域网访问；这不属于应用提供的远程操控协议。
- 不提供面向移动端或桌面端的管理 API 契约。现有 FastAPI 路由仅作为当前 Web UI 的进程内/同实例宿主。
- 配置与凭据通过挂载卷、环境变量或 Docker Secrets 注入，不与其他安装实例同步。

### 4.2 多实例冲突规则

- 项目不协调多台设备之间的执行锁，也不提供分布式锁。
- UI 和文档必须提示：同一账号只应在一个实例启用自动计划。
- 本地执行器仍需使用本机文件锁/SQLite 事务和“账号 + 预约日期 + 计划”幂等键，防止同一实例因重复唤醒并发执行。
- 对远端图书馆接口的成功响应必须二次查询核验，避免网络超时后再次提交相同预约。

## 5. 各平台实现

| 平台 | 构建产物 | 构建宿主 | 定时策略 | 分发与更新 |
|---|---|---|---|---|
| Windows | `.exe`/portable zip 为主，可选 `.msix` | Windows runner | Task Scheduler | GitHub Releases；MSIX 按需封装 |
| macOS | 签名、公证、staple 的 `.dmg` | macOS runner | launchd agent | GitHub Releases；应用内只提示下载 |
| Linux | `.AppImage` + `.deb`，可选 `.rpm` | Linux runner | systemd user timer，cron fallback | GitHub Releases/软件源 |
| Android | 分 ABI 签名 `.apk` 测试/侧载包（不生成 AAB） | 任意桌面 runner | 本机 AlarmManager 精确闹钟 + BroadcastReceiver + 短时前台服务 | GitHub Releases/受控链接，签名 APK 侧载 |
| iOS | 模拟器包 + debug/Ad Hoc 签名 `.ipa` | macOS runner | 本机快捷指令个人自动化 + App Intent；AlarmKit/本地通知精确提醒 | 开发机/Ad Hoc 注册设备，GitHub Releases 或内部 OTA |
| Docker | OCI multi-arch `linux/amd64,linux/arm64` | BuildKit | 容器内调度器或独立 worker | GHCR，使用不可变 tag 和 digest |

### 5.1 Windows

- 用 `flet build windows` 取代 `flet pack`，减少 PyInstaller 特殊处理。
- 测试版可继续使用 Inno Setup 签名 `.exe`；如需 MSIX 再额外封装，不接 Microsoft Store。
- CI 执行：单元测试 → build → `--self-check` → 安装冒烟测试 → Authenticode 签名 → SHA-256/SBOM。
- 证书使用 GitHub Environments secret 或硬件/云签名服务，禁止提交 PFX。

### 5.2 macOS

- Universal 产物优先；若依赖不支持，可分别构建 `arm64`、`x86_64`。
- 使用 Developer ID Application 签名，`notarytool` 公证，随后 `stapler` 固定票据。
- 将 cron 改为 `~/Library/LaunchAgents/io.github.alaichhe.hdu-library-sniper.plist`。
- CI 必须在临时 keychain 导入证书，任务结束销毁临时 keychain。

### 5.3 Linux

- Flet 构建基础目录后封装 AppImage；另生成 Debian 包。
- 定时器使用 `~/.config/systemd/user/hdu-sniper.timer` + `.service`。
- 无 systemd 环境回退到 cron，并在 UI 中明确显示能力等级。
- AppImage/DEB 应在 Ubuntu LTS 最低兼容环境构建，避免 glibc 过新。

### 5.4 Android

- 测试版只构建签名 APK，按 ABI 拆分；不生成 AAB，也不接 Google Play 或国内商店。
- 侧载分发优先 arm64-v8a；需要覆盖其他设备时再构建 armeabi-v7a、x86_64。
- 使用 `flet build apk --split-per-abi`；侧载分发建议开启 legacy packaging，以减小原始 APK 体积。
- 使用独立 release keystore 签名，不要长期使用 debug key；keystore 只放在受保护环境中。
- 密钥放 Android Keystore/EncryptedSharedPreferences，日志严禁打印密码、Cookie、token。
- 执行模型是“系统调度唤醒 + 短生命周期 Python 执行器”：`AlarmManager 精确闹钟 → BroadcastReceiver → 前台服务 → 初始化嵌入式 Python → run_daemon/run_checkin`。Python 不常驻，原生层只负责唤醒和进程生命周期。
- 优先使用 `AlarmManager.setAlarmClock()`；它向用户展示闹钟并通常获得更高调度优先级。若只用 `setExactAndAllowWhileIdle()`，它只是“接近精确”，应额外提前 10-30 秒唤醒，再让 `BookingRunner.run_once(execute_at=...)` 的预热和到点等待逻辑收敛到目标时刻。
- BroadcastReceiver 只做快速校验和启动前台服务；网络预约、重试和结果核验放在服务内的 Python 入口中，不要在接收器里直接执行长任务。
- Android 12+ 需要 `SCHEDULE_EXACT_ALARM`，或目标系统允许时声明 `USE_EXACT_ALARM`；新安装、权限撤销、设备重启都必须进入降级或重新调度流程。
- 前台服务必须声明正确类型和通知，并受 Android 12+ 后台启动限制约束；闹钟广播、`BOOT_COMPLETED` 和用户操作是允许启动前台服务的合法入口，但仍需按系统版本和厂商策略做真机验证。
- 用户强制停止应用会清除已注册的闹钟，且第三方应用无法在强制停止后收到广播；必须要求用户重新打开应用一次。设备重启后需要 `BOOT_COMPLETED` 重建闹钟，Doze、OEM 省电和厂商后台清理仍可能导致失效。
- WorkManager 用于当前设备上的状态刷新、失败补偿和执行记录整理，不替代精确闹钟。应用提供“本地精确执行 / 仅提醒 / 当前不可调度”三档能力状态。
- 先做真机兼容测试，特别验证 `cryptography`、TLS、Cookie 持久化、嵌入式 Python 启动耗时、Doze、锁屏、重启、强制停止和国产 ROM 电池策略。

### 5.5 iOS

- 只能在 macOS + Xcode 上构建和签名。
- 测试路线：先 `flet build ios-simulator` 做无签名冒烟，再为开发机构建 `debugging` IPA，为固定测试机构建 `release-testing`（Ad Hoc）IPA；不接 TestFlight/App Store。
- 所有真机 IPA 都需要 Apple Developer 账号、Bundle ID、签名证书、Provisioning Profile 和注册 UDID；Ad Hoc 设备列表需要随测试范围维护。
- 使用 Keychain 保存当前设备的本地凭据和 Cookie 加密材料。
- iOS 26+ 可用 AlarmKit 在指定时刻呈现系统级警报；它保证的是警报展示，不等同于在警报时刻自动运行任意网络代码。AlarmKit 配置的 App Intent 附加动作由用户点击警报按钮触发。
- 定点执行采用本机“快捷指令自动化”：App 暴露 App Intent 或 URL Scheme，指导用户创建“特定时间”个人自动化并关闭“运行前询问”。这是用户显式配置的系统自动化，不能由第三方 App 静默创建或统一管理。
- 用户显式配置是接受的约束，但仍要按“尽力执行”设计：快捷指令自动化可能被系统延后、跳过或受锁屏/省电策略影响，UI 与测试说明不得承诺准点执行。
- iOS 16+ 的 App Intent 可通过 `openAppWhenRun = false` 在后台运行；iOS 26+ 应使用 `IntentModes.supportedModes = [.background]`。普通 App Intent 后台运行通常只有约 30 秒预算，预约前置查询、预热、重试和复核应压缩在这个预算内；更长任务优先使用 iOS 26+ `LongRunningIntent`，或退化为打开 App 前台执行。
- App Intent 调用当前设备保存的凭据、方案和登录态，执行结束写入当前设备日志；不连接其他 HDU Library Sniper 实例。若 Flet 没有官方后台入口，则需要 serious_python 或原生 Swift/Kotlin 桥直接启动嵌入式 Python。
- BGAppRefreshTask/BGProcessingTask 仅做当前设备的状态整理与补偿；系统决定执行时间，不能替代快捷指令定点入口。
- UI 应单独显示“快捷指令已配置/待配置/需要测试”，并提供一次性测试动作、最近触发时间、失败原因和本机执行日志。
- 首个里程碑以少量注册设备验证；登录、自动操作、快捷指令引导和 AlarmKit 用途应在测试说明中写清楚，避免测试者误以为系统会在后台自动执行任意代码。

### 5.6 Docker

建议拆为两个进程角色：

```text
hdu-sniper-api       # Web UI + API，不负责周期任务
hdu-sniper-worker    # 调度、预约执行、签到和重试
```

- API/worker 共用持久化数据库（单机可 SQLite + 文件锁，生产建议 PostgreSQL）。
- 镜像改用非 root 用户；根文件系统只读；仅 `/var/lib/hdu-sniper` 可写。
- 增加 `/health/live` 与 `/health/ready`。
- 使用 `docker buildx build --platform linux/amd64,linux/arm64`。
- 发布 tag：`1.8.0`、`1.8`、`1`、`latest`；生产部署固定 digest。
- 生成 SPDX/CycloneDX SBOM，执行 Trivy/Grype 扫描并签名镜像。

## 6. Flet 构建配置建议

迁移到统一命令：

```bash
flet build windows .
flet build macos .
flet build linux .
flet build ios-simulator .
flet build apk . --split-per-abi --android-legacy-packaging
flet build ipa . --ios-export-method release-testing
```

`pyproject.toml` 建议新增平台节：

```toml
[tool.flet]
product = "HDU Library Sniper"
org = "io.github.alaichhe"
bundle_id = "io.github.alaichhe.hdu-library-sniper"
build_number = 1

[tool.flet.android]
split_per_abi = true
legacy_packaging = true
target_arch = ["arm64-v8a"]

[tool.flet.ios]
export_method = "release-testing"
```

版本号继续使用 `pyproject.toml` 的 `[project].version` 和 `build_number`。`target_arch`、`legacy_packaging`、`export_method` 等键名以项目锁定的 Flet 0.86.x CLI `flet build --help` 和官方文档为准，并在 CI 中固定 Flet/Flutter 版本，避免模板漂移。

## 7. CI/CD 设计

建议拆为五条工作流：

```text
ci.yml                  # 每次 PR：lint、unit、contract、依赖审计
release-desktop.yml     # tag：Windows/macOS/Linux
release-android.yml     # tag 或手动：分 ABI 签名 APK
release-ios.yml         # 手动/受保护环境：simulator、debug、Ad Hoc IPA
release-container.yml   # main/tag：GHCR multi-arch
```

测试版不创建 AAB、不上传 App Store Connect，也不使用 TestFlight。

### 7.1 发布门禁

所有平台共同门禁：

1. tag、`pyproject.toml`、包版本完全一致。
2. Ruff、pytest、覆盖率门槛通过。
3. 业务契约测试以 mock server 运行，不在 CI 使用真实学生凭据。
4. 构建后运行 `--self-check` 或平台等价冒烟测试。
5. 生成 SHA-256、SBOM、provenance。
6. 二进制、安装包和容器镜像完成签名。
7. 先创建 draft release，所有 job 成功后再发布。

### 7.2 Runner 矩阵

```yaml
strategy:
  matrix:
    include:
      - os: windows-latest
        target: windows
      - os: macos-latest
        target: macos
      - os: ubuntu-22.04
        target: linux
      - os: ubuntu-22.04
        target: android
      - os: macos-latest
        target: ios
```

Android 可在 Windows/macOS/Linux 构建；iOS 必须使用 macOS。桌面产物原则上在对应目标 OS 构建和测试。

### 7.3 密钥清单

```text
WINDOWS_SIGN_CERT / WINDOWS_SIGN_PASSWORD（或云签名身份）
APPLE_CERT_P12 / APPLE_CERT_PASSWORD
APPLE_TEAM_ID / APPLE_ID / APPLE_APP_PASSWORD
IOS_DEBUG_PROVISIONING_PROFILE
IOS_RELEASE_TESTING_PROVISIONING_PROFILE
IOS_DEVICE_UDIDS
ANDROID_KEYSTORE / ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD
CONTAINER_SIGNING_IDENTITY（优先 OIDC keyless）
```

密钥只进入受保护的 GitHub Environment；fork PR、普通 PR 和日志中不可用。Ad Hoc 描述文件需要在证书中登记测试机 UDID。

## 8. 版本与发布渠道

- 应用版本采用 SemVer：`MAJOR.MINOR.PATCH`。
- 平台构建号独立递增，测试包同样不要复用构建号。
- 渠道：`nightly` → `beta` → `stable`。
- Git tag 只触发候选构建；测试版发布仍需受保护环境人工批准。
- GitHub Release 附：变更说明、风险提示、SHA-256、SBOM、支持平台和已知限制。
- Android 测试版通过 GitHub Releases/受控链接侧载，用户需允许安装未知来源；iOS 测试版通过开发/Ad Hoc 描述文件安装，不使用官方商店更新。

## 9. 实施阶段

### 阶段 A：发布基线

- 冻结 Flet/Flutter/Python 版本。
- 把现有 Windows/macOS 流程迁到 `flet build`。
- 新增 Linux AppImage/DEB 和 Docker multi-arch。
- 建立统一 artifact 命名、校验和、SBOM、draft release。

**验收**：三桌面系统可安装启动，Docker amd64/arm64 可运行，版本和校验和一致。

### 阶段 B：平台能力解耦

- 抽取 `SchedulerPort`、`SecretStore`、`UpdatePort`、`NotificationPort`。
- Windows、launchd、systemd、server 分别实现。
- 凭据迁移到系统安全存储；保留一次性 YAML 迁移器，成功后清除旧敏感数据。

**验收**：业务核心测试不再 mock `platform.system()` 或直接调用 PowerShell/cron。

### 阶段 C：Docker 本地实例加固

- 保持 Web UI、配置、调度和执行位于同一容器部署边界，不新增外部控制协议。
- Web 与 scheduled 角色共享当前部署的挂载卷；使用 SQLite 事务/文件锁防止同实例并发执行。
- 默认绑定本机地址，补充非 root、healthcheck、只读根文件系统和 Docker Secrets。
- 为一次执行、每日调度、重启恢复和日志轮转建立容器集成测试。

**验收**：Docker 实例在用户自有主机上可独立完成配置和准点执行；断网、重启、容器重建后挂载数据保持一致；没有跨实例管理入口。

### 阶段 D：Android

- 先构建 arm64-v8a APK 做真机验证，再配置独立 release keystore 并建立侧载分发。
- 实现 Android 原生调度插件：精确闹钟、BroadcastReceiver、前台执行服务、开机重建和权限状态监听。
- 移动 UI 展示“精确闹钟权限、下次触发、前台服务、厂商省电限制、最后执行结果”状态。
- 完成本机密钥存储、深链、本地通知和网络失败恢复。

**验收**：在屏幕关闭、Doze、应用进程被回收、设备重启等场景验证到点触发；用户强制停止或撤销精确闹钟权限后，UI 能识别失效、停止显示自动执行有效，并引导重新授权或改为仅提醒。

### 阶段 E：iOS

- 构建 ios-simulator 包、debugging IPA 和 release-testing（Ad Hoc）IPA。
- 完成 Keychain、本地通知和隐私说明；测试说明中明确快捷指令/AlarmKit 的行为边界。
- 暴露 App Intent/URL Scheme，生成逐步引导，让用户创建“特定时间、直接运行”的快捷指令个人自动化。
- 实现原生唤醒桥：Android 精确闹钟接收器 + 前台服务启动嵌入式 Python 入口；iOS App Intent 通过 serious_python 或原生 Swift 桥调用嵌入式 Python。
- iOS 26+ 可加入 AlarmKit 作为醒目提醒和手动兜底入口；低版本使用本地通知。
- 应用内提供一键测试、快捷指令配置状态、最近触发时间、本机执行日志和失败原因；UI 明确标注后台执行是尽力而为。

**验收**：在至少 2-3 台注册真机上完成 debug/Ad Hoc IPA 安装与快捷指令触发验证；验证锁屏下快捷指令触发 App Intent/网络动作的实际表现、后台约 30 秒预算和失败提示；明确区分 AlarmKit 精确提醒、快捷指令自动化和 BGTask 尽力执行。

## 10. 首批具体改动清单

1. 新建 `src/hdu_sniper/platform/`，从 `scheduler.py` 抽出协议和四类实现。
2. 为 `create_app()` 增加 `RuntimeKind` 和依赖注入参数。
3. 给 Flet UI 增加 capability model，例如 `scheduler_mode`、`exact_alarm_authorized`、`automation_configured`、`last_triggered_at`、`supports_self_update`。
4. 新增 Android 原生桥接：`AlarmManager.setAlarmClock()`（或提前唤醒 + `setExactAndAllowWhileIdle()`）、显式 BroadcastReceiver、短时前台服务、`BOOT_COMPLETED` 重建、权限撤销检测。
5. 新增 iOS 原生桥接：App Intent/URL Scheme、`openAppWhenRun = false` / iOS 26+ `.background`、快捷指令配置引导；iOS 26+ 可选 AlarmKit 精确提醒。
6. 移动端将桌面“系统任务”页改为“执行能力”页，Android 显示本机精确闹钟状态，iOS 显示本机快捷指令配置与测试状态。
7. 将 `verify=False` 改为安全默认值，并补充证书错误诊断。
8. 新建凭据迁移器和 `SecretStore`；禁止新版本继续写明文 `credentials.yaml`。
9. 将 Docker Web UI 明确定义为当前实例本地界面，默认限制监听地址，不增加外部管理 API。
10. 加固 Docker 的 web/scheduled 角色，加入同实例锁、非 root、healthcheck、只读文件系统。
11. 将 `.github/workflows/desktop-release.yml` 拆分并新增 Linux、Android、iOS、container 工作流。
12. 建立物理设备测试清单：Windows 10/11、macOS Intel/Apple Silicon、Ubuntu LTS、Android 8+、iOS 15+；Android 重点覆盖 Pixel/三星/小米/华为等后台策略差异。

## 11. 风险排序

| 等级 | 风险 | 应对 |
|---|---|---|
| P1 | iOS 快捷指令后台执行是尽力而为，可能被系统延后或跳过（已接受约束） | 用户显式配置自动化；提供一键测试、最近触发时间、失败原因；UI 明示非准点保证 |
| P0 | Android 精确闹钟权限被拒绝/撤销或应用被强制停止 | 能力探测、开机重建、失效告警并降级为仅提醒 |
| P0 | 同一账号在多个独立实例同时启用 | 明确单实例启用规则；本机幂等不能代替跨设备锁 |
| P0 | 凭据/Cookie 泄漏 | 系统安全存储、Docker Secret、日志脱敏和本地文件权限 |
| P1 | 用户主动将 Docker Web UI 暴露到公网 | 默认仅本机监听；文档警告并提供可选本地认证/TLS 配置 |
| P1 | Android 精确闹钟/前台服务在国产 ROM、厂商省电策略或强制停止后失效 | 能力探测、失效告警、受控侧载和测试说明 |
| P1 | iOS 普通 App Intent 后台运行约 30 秒，长流程可能超时 | 压缩预热与重试预算；长任务使用 iOS 26+ `LongRunningIntent` 或打开 App 前台执行 |
| P1 | 移动端嵌入式 Python 入口与二进制依赖未验证（Flet 无官方无 UI 后台入口，issue #5958） | 最先做最小 APK/IPA 构建探针，验证 serious_python/原生桥、`cryptography`、TLS 和 Cookie 持久化 |
| P1 | macOS 未签名/未公证被 Gatekeeper 拦截 | 完整签名、公证、staple 流程 |
| P1 | iOS Ad Hoc 设备/描述文件维护成本 | 固定设备清单、提前注册 UDID、建立测试者安装说明 |
| P1 | Linux glibc 兼容问题 | 在最低支持 LTS 构建并真机测试 |
| P2 | Flet/Flutter 模板更新导致构建漂移 | 锁版本、缓存和定期升级窗口 |
| P2 | 图书馆接口变化 | 契约测试、响应适配器、快速回滚 |

## 12. 推荐优先级

最短可交付路线为：

```text
调度/凭据能力解耦
→ Android 本机精确闹钟最小原型
→ Docker 独立本地实例加固与 multi-arch
→ Linux/macOS 原生调度完善
→ iOS 本机快捷指令 + App Intent 原型
→ AlarmKit 提醒与 Ad Hoc/debug 签名完善
```

这样先用最小原型验证最关键的本地移动能力：Android 验证精确闹钟触发到网络请求的完整链路，iOS 验证用户创建的“特定时间”快捷指令能否在锁屏场景调用 App Intent。Docker 只作为用户自有主机上的另一种独立本地部署形态，不与其他设备建立远程控制关系。

## 13. 若允许全量重构：最合理技术路线

### 13.1 结论

如果允许大范围破坏性变更和整体重构，最合理的选择是放弃 Flet/Python 作为跨平台 UI 和移动端执行宿主，迁移到 **Kotlin Multiplatform（KMP）+ 原生调度壳**：

- 业务核心、持久化、HTTP、预约规则和签到规则全部用 Kotlin 表达，Android/iOS/桌面/Docker 共享同一份核心。
- Android 的 AlarmReceiver、前台服务和 `BOOT_COMPLETED` 重建直接调用 Kotlin 核心，不启动 CPython，不依赖 Flet 移动宿主。
- iOS 的 App Intent/BGTask 调用 KMP 生成的共享框架，原生支持后台预算、`LongRunningIntent` 和快捷指令自动化，没有嵌入式 Python 启动和包体负担。
- 桌面用 Compose Desktop 或原生 UI，调度器启动同一个 Kotlin 核心的 headless CLI/daemon。
- Docker 用 Ktor 提供 API/worker 和一个轻量 Web 管理面，核心仍然共享。
- 凭据、Cookie、方案、日志继续保存在当前设备或容器的本地安全存储中，不引入中心服务，不破坏“移动端独立本地实例”的产品边界。

这是所有候选方案中唯一同时解决“UI 跨平台”、“移动端原生后台执行”和“业务核心单一来源”的路线。代价是需要把约 7.2k 行 Python 源码和 3.5k 行测试移植到 Kotlin，并重写 Flet UI；它应当作为独立里程碑推进，而不是在当前版本上叠加。

### 13.2 为什么不选其他方案

- **Flutter/Dart 全量重写**：UI 生态最强，但精确闹钟、广播接收器和 iOS App Intent 仍要回到原生层；在原生接收器里启动 Flutter Engine 再执行 Dart 逻辑，比直接调用 KMP Kotlin 核心更重，也不是 Flutter 官方推荐的准点后台路径。
- **Rust 核心 + Flutter/原生壳**：长期质量好，但本项目是 Python 业务和测试资产，Rust 移植成本远高于 KMP，且 HTTP/TLS/UI 集成都要额外 FFI，属于过度工程。
- **Headless Python Core + 原生移动壳**：如果接受不了重写业务核心，这是最好的次优方案，也是本文档第 3-12 节的主路径；但它仍保留 CPython 运行时、移动端二进制依赖和嵌入式解释器启动时间，不能完全消除移动端执行风险。

### 13.3 推荐重构后的形态

```text
core/                      # Kotlin Multiplatform 共享核心
  domain/                  # 模型、规则、DTO，无平台依赖
  usecases/                # 认证、方案、预约、签到、复核
  library/                 # 慧图/SSO HTTP、响应解析、签名
  persistence/             # SQLite/DataStore/本地文件
  secrets/                 # 平台安全存储端口
desktop/
  compose_ui/              # Compose Desktop 管理界面
  cli/                     # headless daemon/run-now/checkin
android/
  app/                     # Compose UI + AlarmReceiver + FGS + BootReceiver
ios/
  app/                     # SwiftUI 或 Compose UI + AppIntent + BGTask
container/
  server/                  # Ktor API/worker，复用同一核心
  web/                     # 轻量 Web 管理面
```

系统调度仍承担唤醒职责：Android 用 `setAlarmClock()` 或提前唤醒，iOS 用用户显式创建的快捷指令自动化；被唤醒后直接进入 Kotlin 核心执行，不再经过 Python/Flet 运行时。

### 13.4 保守破坏性重构（次优）

若只重构宿主和调度层、保留 Python 业务代码，推荐形态是：

```text
python_core/               # 现有业务逻辑拆成 headless 服务/CLI
mobile/
  android_native/          # Kotlin 原生壳，嵌入/调用 Python core
  ios_native/              # Swift 原生壳，serious_python 调用 Python core
desktop/                   # 短期保留 Flet，后续迁移到原生壳
```

该路线保留现有 `BookingRunner`、契约测试和 Python 运维资产，但仍需为移动端建立 serious_python/Chaquopy 桥，并在 iOS 后台预算中计入 Python 启动时间。它适合把破坏范围限制在 UI/宿主层，不适合作为“允许全量重构”时的最终答案。

## 参考

- Flet 官方发布文档：<https://flet.dev/docs/publish/>
- Flet Android 打包：<https://flet.dev/docs/publish/android/>
- Flet iOS 打包：<https://flet.dev/docs/publish/ios/>
- Flet Android/iOS 二进制 wheel：<https://flet.dev/docs/reference/binary-packages-android-ios/>
- Flet 移动端后台入口 issue：#5958 <https://github.com/flet-dev/flet/issues/5958>
- serious_python：<https://pub.dev/packages/serious_python>
- Apple AlarmKit：<https://developer.apple.com/documentation/alarmkit/scheduling-an-alarm-with-alarmkit>
- Apple BackgroundTasks：<https://developer.apple.com/documentation/UIKit/using-background-tasks-to-update-your-app>
- Apple App Intent 后台模式：<https://developer.apple.com/documentation/appintents/appintent/supportedmodes>
- Apple App Intent `openAppWhenRun`：<https://developer.apple.com/documentation/appintents/appintent/openappwhenrun>
- Apple `LongRunningIntent`：<https://developer.apple.com/documentation/appintents/longrunningintent>
- Apple 快捷指令个人自动化：<https://support.apple.com/zh-cn/guide/shortcuts/apdfbdbd7123/ios>
- Apple 自动化直接运行设置：<https://support.apple.com/zh-cn/guide/shortcuts/apd602971e63/ios>
- Android AlarmManager 精确闹钟：<https://developer.android.com/develop/background-work/services/alarms/schedule>
- Android 前台服务后台启动限制：<https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start>
- Android WorkManager：<https://developer.android.com/develop/background-work/background-tasks/persistent/getting-started/define-work>
