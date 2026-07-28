<div align="center">

# HDU Library Sniper

[![Typing SVG](https://readme-typing-svg.demolab.com?font=Fira+Code&pause=1000&color=1677FF&center=true&vCenter=true&width=600&lines=HDU+Library+Seat+Reservation;杭州电子科技大学图书馆座位预约工具;自动预约+失败重试+通知推送)](https://git.io/typing-svg)

[![Python](https://img.shields.io/badge/Python-3.11+-3776AB?logo=python&logoColor=white)](https://www.python.org/)
[![Playwright](https://img.shields.io/badge/Playwright-Automation-2EAD33?logo=playwright&logoColor=white)](https://playwright.dev/)
[![License](https://img.shields.io/github/license/AlaIchhe/HDU-Library-Sniper)](LICENSE)

</div>

## 安装

从 [GitHub Releases](https://github.com/AlaIchhe/HDU-Library-Sniper/releases) 下载对应系统的安装包，安装后直接启动。

## 使用方法

1. 启动程序，使用学号和数字杭电密码登录。
2. 进入“方案”，选择房间类型、楼层和目标座位。
3. 设置预约时间和使用时长，保存并启用方案。
4. 程序默认每天 20:00 自动执行预约，结果可通过通知或日志查看。

创建方案后可以关闭程序。Windows 和 Linux 的定时任务会在后台触发，但电脑需要保持开机或休眠；完全关机时任务无法运行。

## 通知

支持通过 webhook 推送预约结果，可配置微信 Server 酱或 PushPlus。未配置通知时，也可以在应用日志中查看执行结果。

## 常见问题

### 创建方案后需要一直开着程序吗？

不需要。创建并启用方案后，程序会通过系统定时任务自动执行。

### 电脑关机后还能自动预约吗？

不能。电脑至少需要保持开机或休眠状态。Windows 休眠唤醒通常可以执行任务，Linux 需要系统支持定时唤醒。

### 登录失效怎么办？

重新打开应用，点击“重新认证”并再次登录即可。

### 预约结果在哪里查看？

可以查看应用日志，或查看已配置的通知推送。

## 关键词

HDU Library Sniper、HDU、杭州电子科技大学、杭电、杭电图书馆、图书馆座位预约、座位预约、图书馆抢座、自动抢座、自习室预约、阅览室预约、library seat booking、library seat reservation、seat booking automation、Python、Playwright、Flet、Windows、macOS、Linux、Docker。

关联：杭州电子科技大学、杭电、图书馆、自动签到、自动打卡、座位预约、预约脚本。

## 注意事项

* 请合理设置重试间隔，遵守图书馆相关规定。
* 学号、密码和 Cookie 属于敏感信息，请勿分享或提交到代码仓库。
* 本项目仅供学习和个人使用。

