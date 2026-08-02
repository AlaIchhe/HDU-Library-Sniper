# deploy/config

本目录保存本地部署时的业务配置，文件本身不入库（见仓库根目录 `.gitignore`）：

- `settings.yaml` — 从仓库根目录 `config.example.yaml` 复制后按需修改；
- `plans.yaml` — 预约方案（可在 Web UI 中保存生成）。

Docker 部署时：

- `web` profile 以可写方式挂载本目录（`./deploy/config:/var/lib/hdu-sniper/config:rw`），
  供 Web UI 保存方案和设置；
- `run` / `scheduled` profile 以只读方式挂载（`:ro`）。

敏感凭据（学号、密码）不要写入这两个文件，请通过环境变量
`HDU_STUDENT_ID` / `HDU_PASSWORD` 或对应的 `_FILE` secret 文件提供。
