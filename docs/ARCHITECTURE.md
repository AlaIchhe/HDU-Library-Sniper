# 应用架构

## 目标

- Windows 和 macOS 使用 Flet 桌面宿主。
- Docker 和服务器使用 Flet Web 宿主，不依赖 X11 或桌面环境。
- 两种宿主复用同一套控件树、业务门面和持久化规则。
- 三种交互平台统一加载随包分发的 Noto Sans SC Variable，避免依赖宿主系统中文字体回退。
- 后台一次性任务不加载任何 UI。

## 模块关系

```text
Flet Desktop          FastAPI + Flet Web          CLI / scheduler
      |                       |                          |
      +------------------ SniperApp --------------------+
                              |
          BookingPlans + BookingRunner + LibraryLogin
                              |
             library client / rooms / responses
                              |
                 config + paths + local files
```

目录按项目业务概念命名，不模拟 Clean Architecture 的层级。`booking/` 包含预约模型、方案管理、重试和执行流程，`library/` 包含第三方图书馆系统的访问、登录、房间查询、响应解析和签名。顶层模块保留跨业务流程的应用装配、事件、配置、调度和宿主入口。

`runtime.py` 是唯一组合根，保证 `LibraryClient`、`LibraryLogin`、`BookingPlans` 和 `BookingRunner` 共享同一组状态对象。`SniperApp` 是 Flet 和 FastAPI 的交互门面，负责状态机和事件翻译，不重复实现预约逻辑。后台任务通过同一实例的 `BookingRunner.run_once()` 执行，不加载 UI。

认证边界同时存在于展示层和应用门面：未认证时 Flet 只渲染认证页面且不加载方案、房间或执行数据；认证后认证入口退出一级导航，通过页头“重新认证”显式进入。`SniperApp` 对所有业务查询和命令执行统一认证守卫，远端明确返回 `is_login=false` 时发布 `AUTH_REQUIRED` 事件并清除本地认证状态，因此隐藏控件不是唯一的访问控制。FastAPI 仅公开健康检查，状态接口在未认证时返回 401，生产构建不提供 OpenAPI/Swagger 页面。

预约日期和调度时间是产品规则而非用户配置：所有方案固定预约后天；创建方案时合并今天、明天、后天三天的房间座位布局；有效方案创建后静默确保每天 20:00 的系统任务。模型和配置文件均不保存日期偏移。

## 运行模式

| 场景 | 命令 | 交互宿主 | 数据目录 |
| --- | --- | --- | --- |
| Windows/macOS 桌面 | `python -m hdu_sniper` | Flet 桌面窗口 | 操作系统标准用户目录 |
| Docker/服务器 | `python -m hdu_sniper --web` | FastAPI + Flet Web | `HDU_SNIPER_HOME` |
| 一次性执行 | `python -m hdu_sniper --run-now` | 无 | 同上 |
| 系统计划任务 | `python -m hdu_sniper --daemon` | 无 | 同上 |

Web 进程内的浏览器会话共享同一个 `SniperApp`，因此当前 Web 模式是单租户部署，公网入口必须在反向代理层增加 TLS 和访问认证。应用门面用进程级忙状态阻止两个会话同时启动预约任务；若未来需要多用户或多副本部署，必须拆分每用户的客户端、Cookie、凭据和方案存储，并将任务互斥与事件状态迁移到外部协调组件，而不是直接增加 Uvicorn worker 数量。
