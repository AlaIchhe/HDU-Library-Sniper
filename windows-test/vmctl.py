#!/usr/bin/env python3
"""Tiny control surface for the dockur/windows guest.

The VM container exposes the QEMU HMP monitor on /run/shm/monitor.sock, so we can
take screenshots and type without touching the guest's network or RDP.

  ./vmctl.py shot NAME            # screendump -> windows-test/storage/shots/NAME.png
  ./vmctl.py type "text{ENTER}"   # QEMU sendkey text; {ENTER} {ESC} {WIN} {TAB} ...
  ./vmctl.py key "meta_l" "ret"   # raw QEMU key names, sent in order
  ./vmctl.py status               # HMP info status

Text is mapped to QEMU key names; only printable ASCII plus a few modal keys are
supported. Each key is sent separately, so the guest sees normal typing events.
"""
import json
import os
import subprocess
import sys
import time

WS = os.path.dirname(os.path.abspath(__file__))
CONTAINER = "hdu-win-vm"
SHOTS_DIR = os.path.join(WS, "storage", "shots")

# Printable ASCII -> QEMU keycode name (QEMU's qcode names, no Q_KEY_CODE_ prefix).
SHIFT = {
    "!": "1", "@": "2", "#": "3", "$": "4", "%": "5", "^": "6", "&": "7",
    "*": "8", "(": "9", ")": "0", "_": "minus", "+": "equal",
    "{": "bracket_left", "}": "bracket_right", "|": "backslash", ":": "semicolon",
    '"': "apostrophe", "<": "comma", ">": "dot", "?": "slash", "~": "grave_accent",
}
PLAIN = {
    " ": "spc", "-": "minus", "=": "equal", "[": "bracket_left", "]": "bracket_right",
    "\\": "backslash", ";": "semicolon", "'": "apostrophe", "`": "grave_accent",
    ",": "comma", ".": "dot", "/": "slash",
}
MODAL = {
    "{ENTER}": ["ret"], "{ESC}": ["esc"], "{TAB}": ["tab"], "{SPACE}": ["spc"],
    "{WIN}": ["meta_l"], "{BACKSPACE}": ["backspace"], "{DELETE}": ["delete"],
    "{UP}": ["up"], "{DOWN}": ["down"], "{LEFT}": ["left"], "{RIGHT}": ["right"],
    "{CTRL-ESC}": ["ctrl", "esc"], "{CTRL-V}": ["ctrl-v"], "{CTRL-A}": ["ctrl-a"],
    "{ALT-TAB}": ["alt-tab"], "{ALT-F4}": ["alt-f4"], "{WIN-R}": ["meta_l-r"],
    "{WIN-E}": ["meta_l-e"], "{CTRL-C}": ["ctrl-c"], "{CTRL-W}": ["ctrl-w"],
    "{WIN-D}": ["meta_l-d"], "{CTRL-SHIFT-ESC}": ["ctrl-shift-esc"],
}
MODAL.update({f"{{F{n}}}": [f"f{n}"] for n in range(1, 13)})


def text_to_keys(text):
    keys = []
    i = 0
    while i < len(text):
        ch = text[i]
        if ch == "{":
            end = text.find("}", i)
            if end != -1:
                token = text[i:end + 1].upper()
                if token in MODAL:
                    keys.append(MODAL[token])
                    i = end + 1
                    continue
                raise SystemExit(f"unknown token {text[i:end+1]!r}")
        if ch in SHIFT:
            keys.append([f"shift-{SHIFT[ch]}"])
        elif ch in PLAIN:
            keys.append([PLAIN[ch]])
        elif ch.isalpha():
            keys.append([ch.lower()] if ch.islower() else [f"shift-{ch.lower()}"])
        elif ch.isdigit():
            keys.append([ch])
        else:
            raise SystemExit(f"cannot type {ch!r}")
        i += 1
    return keys


def run_monitor(payload):
    """Run one python snippet inside the container that speaks HMP on the monitor socket."""
    script = r"""
import json, socket, sys, time
payload = json.load(sys.stdin)
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.settimeout(3)
s.connect('/run/shm/monitor.sock')
time.sleep(0.2)
try:
    s.recv(4096)
except Exception:
    pass
for command in payload["commands"]:
    s.sendall(command.encode() + b"\n")
    time.sleep(payload.get("delay", 0.05))
time.sleep(0.2)
s.close()
print("ok")
"""
    p = subprocess.run(
        ["podman", "exec", "-i", CONTAINER, "python3", "-c", script],
        input=json.dumps(payload).encode(), capture_output=True, timeout=120,
    )
    if p.returncode != 0:
        raise SystemExit(f"monitor failed: {p.stderr.decode(errors='replace')}")
    return p.stdout.decode()


def shot(name):
    os.makedirs(SHOTS_DIR, exist_ok=True)
    ppm = f"/storage/shots/{name}.ppm"
    host_ppm = os.path.join(SHOTS_DIR, f"{name}.ppm")
    host_png = os.path.join(SHOTS_DIR, f"{name}.png")
    run_monitor({"commands": [f"screendump {ppm}"], "delay": 0.4})
    for _ in range(20):
        if os.path.exists(host_ppm):
            break
        time.sleep(0.1)
    subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", host_ppm, host_png], check=True)
    print(host_png)


def key(keys):
    commands = ["sendkey " + "-".join(seq) + " 40" for seq in keys]
    run_monitor({"commands": commands, "delay": 0.05})
    time.sleep(0.2)


def main():
    if len(sys.argv) < 2:
        raise SystemExit(__doc__)
    cmd = sys.argv[1]
    if cmd == "shot":
        shot(sys.argv[2])
    elif cmd == "type":
        keys = text_to_keys(sys.argv[2])
        # split into small batches so the monitor socket does not stall
        for i in range(0, len(keys), 25):
            key(keys[i:i + 25])
            time.sleep(0.15)
        print(f"typed {len(keys)} keys")
    elif cmd == "key":
        key([[k] for k in sys.argv[2:]])
        print("sent")
    elif cmd == "status":
        p = subprocess.run(
            ["podman", "exec", "-i", CONTAINER, "python3", "-c", r"""
import socket, time
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM); s.settimeout(2)
s.connect('/run/shm/monitor.sock'); time.sleep(0.2)
try: print(s.recv(4096).decode(errors='replace'))
except Exception: pass
s.sendall(b"info status\n"); time.sleep(0.3)
try: print(s.recv(8192).decode(errors='replace'))
except Exception: pass
"""],
            capture_output=True, timeout=30,
        )
        print(p.stdout.decode(errors="replace").strip())
    else:
        raise SystemExit(__doc__)


if __name__ == "__main__":
    main()
