# HDU Library Sniper

杭州电子科技大学图书馆预约与自动签到工具。选好座位和时间，保存并启用方案，剩下的交给后台。

**[下载 Windows 安装包](https://github.com/AlaIchhe/HDU-Library-Sniper/releases/latest/download/HDU.Library.Sniper_2.0.21_x64_zh-CN.msi)** · 支持 Windows x64，双击 MSI 安装即可。

## 操作演示

[![创建方案、选择座位和时间、保存启用、查看预约](docs/media/hdu-sniper-demo.gif)](docs/media/hdu-sniper-demo.mp4)

[观看完整视频](docs/media/hdu-sniper-demo.mp4) · 约 29 秒，演示数据。

## 能做什么

- **自动抢座**：每天 20:00 提交预约，支持主座位和备选座位。
- **灵活安排**：选择房间、楼层、时间与重复日期，管理多个预约方案。
- **自动签到**：在签到窗口执行签到，也可手动操作。
- **及时获知结果**：查看当前预约与运行记录，接收 Windows 通知。

## 开始使用

1. 安装后打开应用，用学号和数字杭电密码登录。
2. 在“预约方案”中创建方案，选择房间、楼层、座位和时间。
3. 保存并启用方案，在“当前预约”中查看结果。

应用安装后默认开机自启。关闭窗口会隐藏到系统托盘，后台继续运行；从托盘菜单退出才会停止任务。预约和签到时，请保持电脑开机、联网且应用运行。

账号凭据和预约数据保存在本机，不上传到第三方服务器；退出登录不会删除已保存的凭据。请在可信设备上使用，并遵守学校图书馆服务规则。

---

[容器部署](docs/DEPLOYMENT.md) · [开发与发布](docs/DEVELOPMENT.md) · [License](LICENSE)
