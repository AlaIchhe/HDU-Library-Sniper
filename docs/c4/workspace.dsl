workspace "HDU Library Sniper" "杭电图书馆座位自动预约工具" {

    model {
        student = person "学生" "使用桌面端或 Web 端配置预约方案、管理预约和自动签到"

        sniper = softwareSystem "HDU Library Sniper" "固定后天 20:00 自动抢座，并支持签到、暂离、续座、签退、取消和系统调度" {
            desktop = container "Flet Desktop App" "Python + Flet" "Windows/macOS 桌面交互界面"
            web = container "FastAPI + Flet Web" "Python + FastAPI + Flet" "Web 模式：API + Flet Web 界面"
            cli = container "CLI / Background Runner" "Python" "无 UI 后台执行、系统任务和容器调用"
            core = container "SniperApp Core" "Python" "认证守卫、应用状态机、领域服务编排和事件发布" {
                facade = component "SniperApp" "应用门面" "Python"
                plans = component "BookingPlans" "方案仓储" "Python"
                runner = component "BookingRunner" "抢座执行器" "Python"
                rooms = component "LibraryRooms" "场馆目录" "Python"
                client = component "LibraryClient" "HTTP 客户端" "Python"
                login = component "LibraryLogin" "登录服务" "Python"
                scheduler = component "SchedulerService" "系统调度" "Python"
                notifier = component "Notifier" "通知服务" "Python"
                update = component "UpdateService" "更新服务" "Python"
            }
            storage = container "Local Files" "YAML / JSON / log" "配置、凭证、会话缓存、方案、策略、审计日志"
        }

        huitu = softwareSystem "慧图图书馆平台" "提供登录、房间、座位、预约、签到、取消、状态查询等 HTTP API"
        sso = softwareSystem "杭电 SSO" "统一身份认证，返回 CAS ticket 与会话 Cookie"
        wechat = softwareSystem "微信 Webhook" "接收抢座和签到结果通知"
        github = softwareSystem "GitHub Releases" "发布新版本与安装包"
        osScheduler = softwareSystem "OS Task Scheduler" "Windows Task Scheduler / cron，按计划触发应用"

        student -> sniper "使用"
        sniper -> huitu "调用 HTTP API"
        sniper -> sso "执行统一身份认证"
        sniper -> wechat "发送通知"
        sniper -> github "检查更新并下载"
        sniper -> osScheduler "注册/查询/触发系统任务"

        desktop -> core "调用应用门面"
        web -> core "调用应用门面"
        cli -> core "调用应用门面"
        core -> storage "读写配置与状态"

        facade -> plans "读取方案"
        facade -> runner "执行抢座"
        facade -> scheduler "管理调度"
        facade -> notifier "发送通知"
        facade -> update "检查更新"
        runner -> rooms "查询楼层座位"
        runner -> client "提交预约"
        rooms -> client "调用平台"
        login -> client "复用客户端会话"
        plans -> storage "读写 plans.yaml"
        facade -> storage "读写 settings.yaml"
        client -> huitu "调用 HTTP API"
        login -> sso "CAS 登录"
        notifier -> wechat "发送通知"
        update -> github "检查更新"
        scheduler -> osScheduler "任务管理"

        desktopEnv = deploymentEnvironment "桌面部署" {
            deploymentNode "Windows / macOS Desktop" "桌面运行环境" {
                containerInstance desktop
                containerInstance core
                containerInstance storage
            }
        }

        serverEnv = deploymentEnvironment "服务端部署" {
            deploymentNode "Docker / Server" "服务端运行环境" {
                deploymentNode "uvicorn + FastAPI" {
                    containerInstance web
                    containerInstance core
                    containerInstance storage
                }
            }
        }
    }

    views {
        systemContext sniper "SystemContext" "系统上下文" {
            include *
            autolayout lr
        }

        container sniper "Containers" "容器视图" {
            include *
            autolayout lr
        }

        component core "Components" "核心组件视图" {
            include *
            autolayout lr
        }

        deployment * desktopEnv "DesktopDeployment" "桌面部署视图" {
            include *
            autolayout lr
        }

        deployment * serverEnv "ServerDeployment" "服务端部署视图" {
            include *
            autolayout lr
        }

        styles {
            element "Person" {
                shape Person
                background #08427b
                color #ffffff
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
            relationship "Relationship" {
                color #707070
            }
        }
    }
}
