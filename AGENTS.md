# 发布说明

## README 下载链接

`.github/workflows/release.yml` 使用 Tauri 按版本号生成 MSI，资产文件名形如 `HDU.Library.Sniper_2.0.20_x64_zh-CN.msi`。Release 工作流会上传带版本号的文件，但不会自动改写 `README.md` 中的下载链接。

每次发布新版本时，必须检查 README 的 MSI 下载链接是否仍指向实际存在的资产。若继续使用版本化文件名，发布版本号后同步更新链接；若要避免手工更新，应先修改工作流上传一个固定名称的下载别名，再把 README 改为该固定地址。

发布完成后还要检查 GitHub Release 是否包含 MSI、签名文件和 `latest.json`，并确认 README 链接可以直接下载当前版本。
