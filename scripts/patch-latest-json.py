#!/usr/bin/env python3
"""把 macOS 的更新包条目写进 Tauri 的 latest.json。

Windows 的 release 任务用 tauri-action 生成 latest.json，里面只有 windows-x86_64；
macOS 的 universal 包同时服务 Apple Silicon 和 Intel，所以要补两个平台键，
并指向 releases/download 的浏览器地址（和 Windows 版本的处理保持一致，避开 API 限流）。

用法：
    python3 scripts/patch-latest-json.py latest.json \\
        --tarball "src-tauri/target/universal-apple-darwin/release/bundle/macos/HDU Library Sniper.app.tar.gz" \\
        --url-prefix "https://github.com/<owner>/<repo>/releases/download/v2.1.5"
"""

import argparse
import json
import os
import sys
from urllib.parse import quote

PLATFORMS = ("darwin-aarch64", "darwin-x86_64")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("manifest", help="latest.json 路径（原地改写）")
    parser.add_argument("--tarball", required=True, help="构建出来的 *.app.tar.gz")
    parser.add_argument("--url-prefix", required=True, help=".../releases/download/<tag>")
    args = parser.parse_args()

    signature_path = args.tarball + ".sig"
    if not os.path.isfile(args.tarball):
        print(f"missing updater bundle: {args.tarball}", file=sys.stderr)
        return 1
    if not os.path.isfile(signature_path):
        print(f"missing signature: {signature_path}", file=sys.stderr)
        return 1

    with open(signature_path, encoding="utf-8") as handle:
        signature = handle.read().strip()

    asset = os.path.basename(args.tarball)
    entry = {
        "signature": signature,
        "url": f"{args.url_prefix.rstrip('/')}/{quote(asset)}",
    }

    with open(args.manifest, encoding="utf-8") as handle:
        manifest = json.load(handle)

    platforms = manifest.setdefault("platforms", {})
    for key in PLATFORMS:
        platforms[key] = entry

    if not any(key.startswith("windows") for key in platforms):
        print("warning: latest.json has no windows entry; is the Windows job done?", file=sys.stderr)

    with open(args.manifest, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")

    print(json.dumps(manifest, indent=2, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
