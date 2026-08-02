---
name: publish-release
description: Publish a new GitHub Release for the HDU-Library-Sniper desktop app. Use when the user asks to 发布/发版/release/publish a new version, create a release tag, or generate release notes. Generates AI release notes, bumps the version in pyproject.toml, src/hdu_sniper/__init__.py and uv.lock, then creates and pushes an annotated vX.Y.Z tag that triggers the desktop-release GitHub Actions workflow.
---

# Publish Release

## 发布流程

1. **确定版本号**
   - 读取最近标签与当前版本：`git describe --tags --abbrev=0`、读取 `pyproject.toml` 的 `version`。
   - 与用户确认目标版本（默认下一个 minor；破坏性变更用 major），不要自行决定。

2. **生成发布说明**
   - 查看提交区间：`git log --no-merges --format='%s' <最近标签>..HEAD`。
   - 使用以下可复用提示词生成说明，保存为 UTF-8 文件（如 `release-notes.md`）：

   > 请先运行 `git log --no-merges --format='%s' $(git describe --tags --abbrev=0)..HEAD` 查看自上次发布以来的全部提交，然后用中文为即将发布的下一版本写一份面向用户的 GitHub Release 发布说明，按“新功能 / 改进 / 修复”分类，语言简洁，不包含提交哈希或内部实现细节。

3. **预览**（推荐）
   - `scripts\bump-version.ps1 <版本> -DryRun -Tag -NotesFile <说明文件> [-Title "<标题>"]`
   - 确认脚本预览的版本、标题与说明正文无误。

4. **执行发布**
   - `scripts\bump-version.ps1 <版本> -Commit -Tag -Push -NotesFile <说明文件> [-Title "<标题>"]`
   - 脚本自动完成：同步更新 `pyproject.toml`、`src/hdu_sniper/__init__.py`、`uv.lock` → `uv lock` → 提交 → 创建注解标签 → `git push --follow-tags`。

5. **验证**
   - 推送 `v*` 标签后，`.github/workflows/desktop-release.yml` 自动构建 Windows/macOS 产物并创建 Release；构建需数分钟。
   - 用 `gh run list` 或 Actions 页面检查运行状态；失败时查看失败 job 日志。
   - Release 标题来自标签主题行，描述来自标签正文；GitHub 自动生成的更新日志会追加在描述之后。

## 关键注意点

- 版本号必须三处一致：`pyproject.toml`、`src/hdu_sniper/__init__.py`、`uv.lock`；CI 会校验三处与标签一致，不一致直接构建失败。
- `-Title` 可选且必须单行；不带时 Release 标题为标签名（`vX.Y.Z`）。
- 不带 `-Notes` / `-NotesFile` 时描述只剩 GitHub 自动生成内容（该仓库无 PR，基本为空），所以发布说明应始终用提示词生成。
- 脚本只提交版本相关三个文件，不会夹带工作区其他改动。
- 首次推送偶发 GitHub 服务端错误 `fatal error in commit_refs`，直接重试即可；不要删除或覆盖已有标签。
- 离线时可用 `-SkipLock`，但会导致 CI 版本校验失败，尽量不用。
- 详细发布文档见 `docs/DESKTOP-RELEASE.md`。