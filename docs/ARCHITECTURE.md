# 应用架构

## 目标

- Windows 和 macOS 使用 Flet 桌面宿主。
- Docker 和服务器使用 Flet Web 宿主，不依赖 X11 或桌面环境。
- 两种宿主复用同一套控件树、业务门面和持久化规则。
- 后台一次性任务不加载任何 UI。

## 分层

```text
Flet Desktop          FastAPI + Flet Web          CLI / scheduler
      |                       |                          |
      +----------- SniperApplication ------------------+
                              |
                 services / core / repositories
                              |
                   AppPaths + settings + files
```

`SniperApplication` 是交互入口唯一依赖的应用门面，负责认证、方案管理、预约执行、取消和系统调度。界面只订阅 `ApplicationEvent` 并展示状态，不直接创建业务服务或工作线程。

## 运行模式

| 场景 | 命令 | 交互宿主 | 数据目录 |
| --- | --- | --- | --- |
| Windows/macOS 桌面 | `python main.py` | Flet 桌面窗口 | 操作系统标准用户目录 |
| Docker/服务器 | `python main.py --web` | FastAPI + Flet Web | `HDU_SNIPER_HOME` |
| 一次性执行 | `python main.py --run-now` | 无 | 同上 |
| 系统计划任务 | `python main.py --daemon` | 无 | 同上 |

Web 进程内的浏览器会话共享同一个 `SniperApplication`。应用门面用进程级忙状态阻止两个会话同时启动预约任务；若未来需要多副本部署，应将任务互斥和事件状态迁移到外部协调组件，而不是直接增加 Uvicorn worker 数量。
