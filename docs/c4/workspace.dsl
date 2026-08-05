workspace "HDU Library Sniper" "杭电图书馆座位自动预约工具（KMP 目标架构 v2）" {

    model {
        student = person "学生" "使用桌面端、Web 端或移动端配置预约方案、管理预约和自动签到"

        sniper = softwareSystem "HDU Library Sniper" "固定后天 20:00 自动抢座，并支持签到、暂离、续座、签退、取消和系统调度" {
            core = container "KMP Shared Core" "Kotlin Multiplatform" "业务核心：domain + usecases + library + persistence + secrets 端口，全平台共享同一份实现" {
                domain = component "Domain" "模型、业务规则、状态机与 DTO（BookingPlan / BookingOrder / SchedulePolicy / Seat / Credentials）" "Kotlin"
                usecases = component "UseCases" "用例编排：认证、方案 CRUD、抢座、签到、复核、策略评估、通知、更新" "Kotlin"
                huituClient = component "HuituClient" "慧图 HTTP 客户端：信封解析、魔法路径访问器、MSG_* 常量单一源" "Kotlin"
                ssoClient = component "SSOClient" "杭电 CAS 登录客户端：表单登录、AES-128/ECB/Pkcs7 密码加密、ticket 落地" "Kotlin"
                signing = component "ApiSigning" "bookSeats Api-Token 签名：base64(md5(source))" "Kotlin"
                persistence = component "Persistence" "仓库端口 + SQLite/DataStore 实现：settings / plans / credentials / session / audit" "Kotlin"
                secrets = component "SecretsPort" "平台安全存储端口：Keystore / Keychain / DPAPI / OS keyring" "Kotlin"
                notifier = component "Notifier" "通知端口：微信 webhook、系统通知" "Kotlin"
                updater = component "UpdateService" "版本比较、安装包下载、SHA-256 校验" "Kotlin"
            }

            desktop = container "Desktop App" "Compose Desktop (JVM)" "Windows/macOS 管理界面；调用共享核心"
            cli = container "CLI / Daemon" "Kotlin JVM" "无 UI 后台执行：run-now / checkin / daemon；系统任务与容器调用入口"
            android = container "Android App" "Compose + Android 原生壳" "AlarmReceiver + 前台服务 + BOOT_COMPLETED 唤醒共享核心"
            ios = container "iOS App" "SwiftUI + KMP 共享框架" "AppIntent + BGTask + 快捷指令自动化唤醒共享核心"
            server = container "Server / Worker" "Ktor (JVM)" "HTTP API + 定时 worker；Docker 部署，复用共享核心"
            web = container "Web Admin" "Ktor 静态资源 + 轻量前端" "服务端形态下的管理界面"

            group "Local Storage" {
                configStore = container "Config Store" "SQLite / DataStore / YAML" "普通配置（settings）"
                planStore = container "Plan Store" "SQLite / YAML" "预约方案（plans）"
                credentialStore = container "Credential Store" "平台安全存储" "账号凭证（学号/密码）"
                sessionStore = container "Session Store" "SQLite / DataStore" "Cookie 与会话缓存（session）"
                logStore = container "Audit Log" "SQLite / 文本文件" "运行与审计日志"
            }
        }

        huitu = softwareSystem "慧图图书馆平台" "提供登录、房间、座位、预约、签到、取消、状态查询等 HTTP API"
        sso = softwareSystem "杭电 SSO" "统一身份认证，返回 CAS ticket 与会话 Cookie"
        wechat = softwareSystem "微信 Webhook" "接收抢座和签到结果通知"
        github = softwareSystem "GitHub Releases" "发布新版本与安装包"
        osScheduler = softwareSystem "OS Task Scheduler" "Windows Task Scheduler / cron / launchd / AlarmManager / BGTask，按计划触发应用"

        student -> sniper "使用"

        desktop -> core "调用共享核心"
        cli -> core "调用共享核心"
        android -> core "调用共享核心"
        ios -> core "调用共享核心"
        server -> core "调用共享核心"
        web -> server "浏览管理界面"

        usecases -> domain "读写模型与规则"
        usecases -> huituClient "执行远端查询/预约/签到"
        usecases -> ssoClient "执行 CAS 登录"
        usecases -> signing "生成请求签名"
        usecases -> persistence "读写本地数据"
        usecases -> secrets "读写凭据"
        usecases -> notifier "发送通知"
        usecases -> updater "检查更新"

        huituClient -> persistence "读写会话缓存"
        persistence -> configStore "读写普通配置"
        persistence -> planStore "读写预约方案"
        persistence -> credentialStore "读写账号凭证"
        persistence -> sessionStore "读写 Cookie 与会话"
        persistence -> logStore "写入审计日志"

        huituClient -> huitu "调用 HTTP API"
        ssoClient -> sso "CAS 登录"
        notifier -> wechat "发送通知"
        updater -> github "检查更新"
        cli -> osScheduler "注册/查询/触发系统任务"
        server -> osScheduler "注册/查询/触发系统任务"
        android -> osScheduler "AlarmManager 调度"
        ios -> osScheduler "BGTask / 快捷指令"

        desktopEnv = deploymentEnvironment "桌面部署" {
            deploymentNode "Windows / macOS Desktop" "桌面运行环境" {
                containerInstance desktop
                containerInstance cli
                containerInstance core
                containerInstance configStore
                containerInstance planStore
                containerInstance credentialStore
                containerInstance sessionStore
                containerInstance logStore
            }
        }

        mobileEnv = deploymentEnvironment "移动端部署" {
            deploymentNode "Android 设备" "Android 运行环境" {
                containerInstance android
                containerInstance core
                containerInstance configStore
                containerInstance planStore
                containerInstance credentialStore
                containerInstance sessionStore
                containerInstance logStore
            }
            deploymentNode "iOS 设备" "iOS 运行环境" {
                containerInstance ios
                containerInstance core
                containerInstance configStore
                containerInstance planStore
                containerInstance credentialStore
                containerInstance sessionStore
                containerInstance logStore
            }
        }

        serverEnv = deploymentEnvironment "服务端部署" {
            deploymentNode "Docker / Server" "服务端运行环境" {
                deploymentNode "Ktor Server + Worker" "容器进程" {
                    containerInstance server
                    containerInstance web
                    containerInstance core
                    containerInstance configStore
                    containerInstance planStore
                    containerInstance credentialStore
                    containerInstance sessionStore
                    containerInstance logStore
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

        deployment * mobileEnv "MobileDeployment" "移动端部署视图" {
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
