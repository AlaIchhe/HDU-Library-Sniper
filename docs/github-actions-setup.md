# GitHub Actions 备链路设置

## 前置条件

1. 在 GitHub 上 **Fork** 此仓库（不能是 clone 到别的账号仓库，必须 fork；否则看不到 Secrets 入口）
2. 你的 GitHub 账号已安装相关 Actions 集成
3. 收藏好下面的 URL：`https://github.com/<你的用户名>/HDU-Library-Sniper/settings/secrets/actions`

> **Fork 是什么？** 在仓库主页右上角点 **Fork** → **Create a fork**，GitHub 会在你的账号下复制一份完全一样的仓库。你之后的所有操作都在**你自己的 fork** 上进行，不会影响原作者。

---

## 第 1 步 — 拦截敏感登录凭证

从这里开始**所有操作都只在 GitHub 网页端**，不要写到任何仓库文件里（包括 README、示例、issue/PR）。

打开你要 fork 的仓库（就是你自己的那个）：

```
https://github.com/<你的用户名>/HDU-Library-Sniper/settings/secrets/actions
```

点击 **New repository secret**，依次添加三个 Secret：

| Secret 名 | 必须 | 内容 | 说明 |
| --- | --- | --- | --- |
| `HDU_STUDENT_ID` | ✅ | 你的学号 | 账户凭据 = 账户所有权，被盗即被盗号 |
| `HDU_PASSWORD` | ✅ | 数字杭电统一身份认证密码（登录 sso.hdu.edu.cn 用的密码） | CI 以环境变量传给程序，不落盘 |
| `HDU_PLANS_YAML` | ✅ | `data/plans.yaml` 全文 | 预约方案列表（不传 → 无方案 → 退出码 3，必须传） |
| `HDU_CONFIG_YAML` | ❌ | `config/config.yaml` 全文 | 重试/超时/推送配置。不传即用仓库内的 |
| `WEBHOOK_URL` | ❌ | Server 酱 / PushPlus / 飞书 webhook 地址 | 失败或成功都会推送。不填则没有推送 |

### 如何设置凭据（填入 `HDU_STUDENT_ID` / `HDU_PASSWORD` Secret）

> CI（GitHub Actions）现在用学号+密码 headless 自动登录（runner 会自动 `playwright install chromium`），
> 不再需要本地准备 Cookie。

1. `HDU_STUDENT_ID`：填你的学号
2. `HDU_PASSWORD`：填你的**数字杭电统一身份认证密码**（即登录 `sso.hdu.edu.cn` 用的密码，**不是**图书馆系统密码）
3. CI 运行时把这两个 Secret 作为环境变量传给 `python main.py --run-now`，程序自动 headless 登录并复用登录态

> 密码即数字杭电密码；CI 不落盘凭据，运行结束清理 `data/session.cache`。

---

## 第 2 步 — 准备 plans.yaml

仓库内的 `data/plans.yaml` 已被 `.gitignore` 排除，Runner 上是空目录。有两种方式注入：

### 方案 A（推荐）：通过 Secret 注入

在本地运行 `python main.py` 创建并保存方案后：

```bash
cat data/plans.yaml
```

复制全部内容 → 新建 Secret `HDU_PLANS_YAML`。

### 方案 B：先让仓库自带一个示例，再运行时覆盖

1. 复制 `data/plans.yaml` 为 `data/plans.yaml.example`
2. 用 `HDU_PLANS_YAML` Secret 在运行时注入正式方案
3. 把 `.plans.example` 提交到仓库
4. 其他用户复制 → 粘贴进 Secret 即可

---

## 第 3 步 — 测试触发

> **不要自己新建 workflow 文件**。仓库已经替你写好了 `.github/workflows/book-seat.yml`，
> 你 fork 完之后 GitHub 会自动识别它，在网页端出现在下拉列表里。

### 找到 workflow 的位置

1. 在你的 forked 仓库网页上，点顶部的 **Actions** 标签
   ```
   https://github.com/<你的用户名>/HDU-Library-Sniper/actions
   ```
2. 第一次会看到 "Get started with GitHub Actions" 提示页，**点绿色按钮 "Configure" 或 "I understand my workflows, go ahead and enable them"** 启用 Actions（新版本 GitHub 支持直接点 **"New workflow"** 旁边的 **"set up a workflow yourself"**，但这里**不要点**，因为我们已经有现成的文件了）
3. 等仓库完成首次文件扫描（通常分钟级），左侧栏会出现 **"HDU Library SeatBooking"** workflow 节点
4. 点一下这个 workflow 名，右侧显示历史 runs（第一次是空的，正常）

### 手动触发一次

1. 在 workflow 页面右侧，点 **Run workflow** 下拉按钮
2. **branch:** 选 `main`（默认就是 main）
3. 再点 **Run workflow**（绿色按钮）
4. 页面会自动刷新，出现一条新的、状态为 **"In progress"** 的 run，点进去看日志

### 看日志

按顺序展开每个步骤点进去：

| 步骤名 | 如果成功显示 | 如果失败显示 |
| --- | --- | --- |
| `Install Playwright chromium` | chromium 安装完成 | ❌ 网络问题致浏览器未装（重跑即可） |
| `Inject plans/config secrets` | `✔ secrets ready ...` | ❌ `HDU_STUDENT_ID 未设置或为空...` |
| Run booking | 与本地运行时终端输出一致，最后一行 `0` / `1` / `2` / `3` 退出码 | `python` 报错类型，红字 |
| Clear cache files | `✔ cache cleared` | ❌ 清除失败（罕见） |
| Push notification | `200 OK`（webhook 返回）或该步骤被跳过 | webhook 地址错误 401/404 |

**触发后最长 4 分钟出结果**（含 chromium 安装）。如果失败：

```
HDU_STUDENT_ID 未设置或为空 → 回到第 1 步检查 Secret
登录失败（用户名或密码错误）→ 核对 HDU_STUDENT_ID / HDU_PASSWORD；密码即数字杭电密码
headless 登录超时 / 触发验证码 → 偶发风控，重试即可；频繁失败检查密码是否已改
步骤内报错 traceback → 复制错误信息 到 GitHub Issue / 问维护者
```

### ⚠️ 最常见的情况：左侧不显示 workflow

按优先级排查：

| 现象 | 排查 |
| --- | --- |
| 左侧没有 `HDU Library Seat Booking` workflow | 打开仓库根目录，确认 `.github/workflows/book-seat.yml` 文件存在且拼写正确（`.github` 前面有个点） |
| 左侧显示 `book-seat.yml` 文件图标、点进去是代码页 | 需要等 GitHub 后台解析 workflow（通常 1-5 分钟）。刷新几次 |
| 左侧完全没有 "Actions" 标签 | 在仓库 Settings → Actions → General 里，选 **"Allow all actions and reusable workflows"** |
| Actions 标签是灰色的，下拉无 workflow | 去 fork 的来源仓库（AlaIchhe/HDU-Library-Sniper），确认原作者已经 push 了 workflow 文件，且你 fork 的是含 workflow 的分支 |
| workflow 出现但 "Run workflow" 按钮灰色 | 该 workflow 没有 `workflow_dispatch` 触发器。本仓库的已包含，**不是这个问题** |

---

## 第 4 步 — 测试成功，启用每日定时

workflow 里已经写死了 `schedule` 触发器：

```yaml
on:
  schedule:
    - cron: '59 23 * * *'   # UTC 23:59 = CST 07:59
  workflow_dispatch:        # 这个就是你刚点的手动触发
```

所以**只要测试跑通过一次**，GitHub 会自动在每天 UTC 23:59 再次触发，不用额外设置。

**后续每月查看 GitHub Actions 使用情况**：

```
https://github.com/<你的用户名>/HDU-Library-Sniper/settings/billing
```

| 类型 | 免费额度 | 你的用量 |
| --- | --- | --- |
| 公开仓库 | 2000 分钟/月 | ≈ 30 分钟/月（每天 1 分钟 × 30 天） |
| 私有仓库 | 50 分钟/月 | >> 超出请转公开或关闭 schedule |

**✅ 正常使用几年都不会产生费用。**

### 关闭 / 暂停 schedule 触发器

什么时候用：长期外出、放了假、想临时停几天。

**方法 1（网页端 · 推荐）：**
`Actions` → 左侧点 `HDU Library Seat Booking` workflow → 右上角 `...` 三点 → `Disable workflow`

**方法 2（改文件 · 永久删除 schedule）：**

```yaml
on:
  # schedule:              # 加 # 注释即关闭每日定时
  #   - cron: '59 23 * * *'
  workflow_dispatch:        # 保留手动触发入口
```

提交到 main 分支后调度立刻取消。

---

## 怎么 Fork 一份自己用（公开/私有不重要）

默认 fork 后仓库是**公开**的。公开仓传学号+密码进 Secret 后**不要开启 PR against 其他 fork**，否则 Secret 会在 downstream PR 里暴露。

想私有，直接：`Settings → Danger Zone → Change visibility`。fork 自带免费 Secret 存储。

