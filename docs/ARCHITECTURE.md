# 应用架构

## 目标

- Windows 和 macOS 使用 Flet 桌面宿主。
- Docker 和服务器使用 Flet Web 宿主，不依赖 X11 或桌面环境。
- 两种宿主复用同一套控件树、业务门面和持久化规则。
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

## 运行模式

| 场景 | 命令 | 交互宿主 | 数据目录 |
| --- | --- | --- | --- |
| Windows/macOS 桌面 | `python -m hdu_sniper` | Flet 桌面窗口 | 操作系统标准用户目录 |
| Docker/服务器 | `python -m hdu_sniper --web` | FastAPI + Flet Web | `HDU_SNIPER_HOME` |
| 一次性执行 | `python -m hdu_sniper --run-now` | 无 | 同上 |
| 系统计划任务 | `python -m hdu_sniper --daemon` | 无 | 同上 |

Web 进程内的浏览器会话共享同一个 `SniperApp`。应用门面用进程级忙状态阻止两个会话同时启动预约任务；若未来需要多副本部署，应将任务互斥和事件状态迁移到外部协调组件，而不是直接增加 Uvicorn worker 数量。
