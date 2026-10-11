"""Generate the README promo. Requires Pillow and imageio-ffmpeg.

Run from the repository root: python scripts/make-promo.py
All interface data in the video is illustrative.
"""
from pathlib import Path
import math
import subprocess

import imageio_ffmpeg
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "docs" / "media"
OUT.mkdir(parents=True, exist_ok=True)
W, H, FPS, SECONDS = 960, 540, 20, 24
FONT = Path("C:/Windows/Fonts/msyh.ttc")
if not FONT.exists():
    raise SystemExit("Set FONT to a Chinese font available on this machine")


def font(size):
    return ImageFont.truetype(str(FONT), size)


def text(draw, pos, value, size=22, color="#e8eef7"):
    draw.text(pos, value, font=font(size), fill=color)


def box(draw, xy, fill="#152138", outline="#2a3b57", radius=18):
    draw.rounded_rectangle(xy, radius=radius, fill=fill, outline=outline, width=1)


def frame(t):
    im = Image.new("RGB", (W, H), "#0a1020")
    d = ImageDraw.Draw(im)
    # Subtle grid and moving accent dots.
    for x in range(0, W, 48):
        d.line((x, 0, x, H), fill="#101a2c")
    for y in range(0, H, 48):
        d.line((0, y, W, y), fill="#101a2c")
    for i in range(12):
        x = (i * 89 + t * 9) % W
        y = 40 + (i * 71) % 450
        d.ellipse((x, y, x + 3, y + 3), fill="#345075")
    scene = min(int(t // 4), 5)
    local = t % 4
    ease = 1 - (1 - min(local / .7, 1)) ** 3
    shift = round((1 - ease) * 22)
    text(d, (42, 24), "HDU LIBRARY SNIPER", 16, "#8ca6c9")
    text(d, (757, 25), "杭电图书馆预约", 14, "#8ca6c9")
    titles = ["把预约交给计划", "配置一次，按计划执行", "预约窗口开启，自动出发", "预约结果，一眼可见", "签到窗口内，自动签到", "少一点等待，多一点专注"]
    subs = ["HDU Library Sniper · 杭电图书馆预约与自动签到工具", "房间、楼层、座位、时间与重复日期，自由选择", "定时提交预约请求，并复核预约是否生效", "查看当前预约与执行记录，及时获取系统通知", "支持手动签到与结果复核，启用前请阅读风险说明", "Windows 桌面端 · 本地数据存储 · 支持自动更新"]
    text(d, (48, 78 + shift), titles[scene], 36)
    text(d, (50, 134 + shift), subs[scene], 18, "#9fb0c9")
    if scene == 0:
        for i, (big, small) in enumerate([("01", "配置预约方案"), ("02", "定时执行预约"), ("03", "查看结果与签到")]):
            x = 50 + i * 290
            box(d, (x, 207 + shift, x + 270, 392 + shift))
            text(d, (x + 25, 229 + shift), big, 48, "#64dfcb")
            text(d, (x + 25, 313 + shift), small, 22)
    elif scene == 1:
        box(d, (50, 186, 910, 425))
        for i, (label, value) in enumerate([("房间类型", "自习室"), ("楼层 / 座位", "六楼 / 130"), ("开始 / 时长", "08:00 / 4 小时"), ("重复日期", "周一至周五")]):
            x = 76 + (i % 2) * 430
            y = 203 + (i // 2) * 91
            text(d, (x, y), label, 16, "#9fb0c9")
            box(d, (x, y + 28, x + 380, y + 77), "#0d1728", radius=10)
            text(d, (x + 16, y + 38), value, 21)
    elif scene == 2:
        clock = "19:59:59" if local < 1.4 else "20:00:00"
        text(d, (73, 214), clock, 68, "#64dfcb")
        steps = ["等待预约窗口", "提交预约请求", "复核预约结果"]
        for i, value in enumerate(steps):
            y = 214 + i * 62
            active = local > i * .9
            box(d, (519, y, 887, y + 49), "#173c3a" if active else "#152138", radius=12)
            text(d, (539, y + 10), value, 21, "#64dfcb" if active else "#9fb0c9")
    elif scene == 3:
        box(d, (50, 189, 910, 420))
        text(d, (76, 209), "当前预约", 20, "#9fb0c9")
        text(d, (76, 257), "自习室 · 六楼 · 座位 130", 30)
        text(d, (76, 311), "08:00 — 12:00", 24, "#9fb0c9")
        box(d, (708, 260, 878, 314), "#173c3a", radius=12)
        text(d, (734, 271), "预约已生效", 22, "#64dfcb")
        text(d, (76, 375), "预约结果以图书馆系统为准", 16, "#9fb0c9")
    elif scene == 4:
        for i, (label, note) in enumerate([("窗口检查", "在允许时间内执行"), ("自动签到", "已启用的签到任务"), ("结果通知", "工作台与系统通知")]):
            x = 50 + i * 290
            box(d, (x, 210, x + 270, 398))
            text(d, (x + 24, 239), label, 27, "#64dfcb")
            text(d, (x + 24, 311), note, 18)
    else:
        box(d, (50, 209, 910, 401))
        text(d, (79, 232), "HDU Library Sniper", 36, "#64dfcb")
        text(d, (80, 290), "前往 README，下载 Windows 安装包", 26)
        text(d, (80, 352), "合理使用预约功能，遵守学校图书馆服务条款", 17, "#9fb0c9")
    text(d, (50, 469), "功能示意 · 非真实预约记录", 13, "#7f93af")
    d.rounded_rectangle((50, 509, 910, 513), radius=2, fill="#233049")
    d.rounded_rectangle((50, 509, 50 + max(4, 860 * t / SECONDS), 513), radius=2, fill="#64dfcb")
    # Fade each scene in and out, keeping transitions soft.
    fade = min(1, local / .22, (4 - local) / .22)
    return Image.blend(Image.new("RGB", im.size, "#0a1020"), im, max(0, fade))


def main():
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    video = OUT / "hdu-sniper-promo.mp4"
    proc = subprocess.Popen([ffmpeg, "-y", "-f", "rawvideo", "-vcodec", "rawvideo", "-s", f"{W}x{H}", "-pix_fmt", "rgb24", "-r", str(FPS), "-i", "-", "-an", "-c:v", "libx264", "-crf", "23", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(video)], stdin=subprocess.PIPE, stderr=subprocess.DEVNULL)
    preview = []
    for i in range(FPS * SECONDS):
        im = frame(i / FPS)
        proc.stdin.write(im.tobytes())
        if i % 4 == 0:
            preview.append(im.resize((640, 360)).quantize(colors=64))
    proc.stdin.close()
    if proc.wait() != 0:
        raise SystemExit("Video encoding failed")
    preview[0].save(OUT / "hdu-sniper-promo.gif", save_all=True, append_images=preview[1:], duration=200, loop=0, optimize=True)
    frame(21.5).save(OUT / "hdu-sniper-promo-cover.png")
    print(f"Created {video} and GIF preview")


if __name__ == "__main__":
    main()
