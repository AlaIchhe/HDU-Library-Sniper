<p align="center">
  <img src="src-tauri/icons/icon.png" width="96" alt="HDU Library Sniper">
</p>

<h1 align="center">HDU Library Sniper</h1>

<p align="center">
  杭州电子科技大学图书馆预约与自动签到工具。选好座位和时间，保存并启用方案，剩下的交给后台。
</p>

<p align="center">
  <a href="https://github.com/AlaIchhe/HDU-Library-Sniper/releases/latest">
    <img src="https://img.shields.io/badge/下载-Windows%20x64-2ea44f?style=for-the-badge&logo=windows&logoColor=white" alt="下载 Windows x64">
  </a>
</p>

<p align="center">
  <a href="https://github.com/AlaIchhe/HDU-Library-Sniper/releases/latest"><img src="https://img.shields.io/github/v/release/AlaIchhe/HDU-Library-Sniper?label=release&style=flat-square" alt="Release"></a>
  <a href="https://github.com/AlaIchhe/HDU-Library-Sniper/releases"><img src="https://img.shields.io/github/downloads/AlaIchhe/HDU-Library-Sniper/total?style=flat-square" alt="Downloads"></a>
  <a href="https://github.com/AlaIchhe/HDU-Library-Sniper/actions/workflows/ci.yml"><img src="https://img.shields.io/github/actions/workflow/status/AlaIchhe/HDU-Library-Sniper/ci.yml?branch=main&label=CI&style=flat-square" alt="CI"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AlaIchhe/HDU-Library-Sniper?style=flat-square" alt="License"></a>
</p>

<p align="center">
  <sub>支持 Windows x64，下载 NSIS 安装包（<code>*-setup.exe</code>）双击安装即可。</sub>
</p>

---

## 操作演示

https://github.com/user-attachments/assets/f8abc8a4-c9f6-4fd9-881b-3f6ec2d45c0d

## 能做什么

<table>
  <tr>
    <td width="50%" valign="top">
      <strong>自动抢座</strong><br>
      每天 20:00 提交预约，支持主座位和备选座位。
    </td>
    <td width="50%" valign="top">
      <strong>灵活安排</strong><br>
      选择房间、楼层、时间与重复日期，管理多个预约方案。
    </td>
  </tr>
  <tr>
    <td width="50%" valign="top">
      <strong>自动签到</strong><br>
      预约开始时自动提交签到，不必卡在截止前，也保留开始前取消的自由；没有待签到预约时后台不发任何请求。
    </td>
    <td width="50%" valign="top">
      <strong>及时获知结果</strong><br>
      查看当前预约与运行记录，接收 Windows 通知。
    </td>
  </tr>
</table>

## 开始使用

1. 安装后打开应用，用学号和数字杭电密码登录。
2. 在“预约方案”中创建方案，选择房间、楼层、座位和时间。
3. 保存并启用方案，在“当前预约”中查看结果。

> [!NOTE]
> 应用安装后默认开机自启。关闭窗口会隐藏到系统托盘，后台继续运行；从托盘菜单退出才会停止任务。预约和签到时，请保持电脑开机、联网且应用运行。

> [!IMPORTANT]
> 账号凭据（学号密码或微信 openid）加密后保存在本机 SQLite（Windows 使用系统钥匙串，其他平台使用 `HDU_SNIPER_SECRET_KEY`），不上传到第三方服务器；退出登录不会删除已保存的凭据，Cookie 失效时会用它在后台自动重新登录。没有可用密钥时会退回明文并在日志中告警。请在可信设备上使用，并遵守学校图书馆服务规则。

---

<p align="center">
  <a href="docs/DEPLOYMENT.md">容器部署</a> ·
  <a href="docs/DEVELOPMENT.md">开发与发布</a> ·
  <a href="docs/HUITU-LIMITS.md">馆方限制实测</a> ·
  <a href="docs/MACOS.md">macOS 版说明</a> ·
  <a href="LICENSE">License</a>
</p>

<p align="center">
  <sub>星光不问赶路人，时光不负有心人。<br>愿所有努力，都不被辜负。</sub>
</p>