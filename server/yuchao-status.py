#!/usr/bin/env python3
"""鱼巢服务器面板的状态脚本：只读，输出一份 JSON。

安装在服务器上，并在 authorized_keys 里把鱼巢的专用密钥绑定到它：
    restrict,command="/usr/bin/python3 /usr/local/lib/yuchao/status.py" ssh-ed25519 AAAA... yuchao-readonly
这样这把密钥登录后只能运行本脚本，客户端传来的任何命令都会被忽略，也不能开端口转发或交互终端。

本脚本只读取状态，不修改任何文件、不重启任何服务。只依赖 Python 3 标准库。
"""

import json
import os
import shutil
import socket
import subprocess
import time
import urllib.request

# 按服务器的实际部署修改
SERVICE = "duyuuu"  # systemd 服务名
OTHER_SERVICES = ["nginx"]
RELEASES_DIR = "/opt/duyuuu/releases"  # 每次发布一个目录
CURRENT_LINK = "/opt/duyuuu/current"  # 指向线上 release 的软链接
APP_URL = "http://127.0.0.1:3000/"  # 本机直连应用，绕过 nginx
NGINX_ERROR_LOG = "/var/log/nginx/error.log"
MAX_RELEASES = 40
MAX_LOG_LINES = 30


def run(args, timeout=5):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout).stdout
    except Exception as e:  # 命令不存在或超时，不影响其他信息
        return ""


def service(name):
    out = run(["systemctl", "show", name, "-p", "ActiveState", "-p", "SubState", "-p", "ActiveEnterTimestamp", "-p", "NRestarts", "-p", "MainPID"])
    props = dict(line.split("=", 1) for line in out.splitlines() if "=" in line)
    return {
        "name": name,
        "active": props.get("ActiveState") or "unknown",
        "sub": props.get("SubState") or "",
        "since": props.get("ActiveEnterTimestamp") or None,
        "restarts": int(props.get("NRestarts") or 0),
        "pid": int(props.get("MainPID") or 0),
    }


def probe(url):
    start = time.monotonic()
    try:
        with urllib.request.urlopen(url, timeout=5) as r:
            status = r.status
    except urllib.error.HTTPError as e:
        status = e.code
    except Exception as e:
        return {"url": url, "status": None, "ms": None, "error": type(e).__name__}
    return {"url": url, "status": status, "ms": round((time.monotonic() - start) * 1000)}


def releases():
    try:
        current = os.path.realpath(CURRENT_LINK)
        names = os.listdir(RELEASES_DIR)
    except OSError:
        return {"current": None, "total": 0, "items": []}
    items = []
    for n in names:
        p = os.path.join(RELEASES_DIR, n)
        if os.path.isdir(p):
            items.append({"name": n, "mtime": os.path.getmtime(p), "current": os.path.realpath(p) == current})
    items.sort(key=lambda r: r["mtime"], reverse=True)
    return {"current": os.path.basename(current), "total": len(items), "items": items[:MAX_RELEASES]}


def tail(path, n):
    try:
        with open(path, "rb") as f:
            f.seek(0, os.SEEK_END)
            f.seek(max(0, f.tell() - 64 * 1024))
            return f.read().decode("utf-8", "replace").splitlines()[-n:]
    except OSError:
        return []


def main():
    disk = shutil.disk_usage("/")
    mem = {}
    for line in open("/proc/meminfo"):
        k, v = line.split(":", 1)
        mem[k] = int(v.split()[0]) * 1024
    print(json.dumps({
        "version": 1,
        "host": socket.gethostname(),
        "time": time.time(),
        "uptime": float(open("/proc/uptime").read().split()[0]),
        "load": list(os.getloadavg()),
        "cpus": os.cpu_count(),
        "memory": {"total": mem.get("MemTotal"), "available": mem.get("MemAvailable")},
        "disk": {"total": disk.total, "used": disk.used, "free": disk.free},
        "services": [service(SERVICE)] + [service(s) for s in OTHER_SERVICES],
        "app": probe(APP_URL),
        "releases": releases(),
        "serviceLog": run(["journalctl", "-u", SERVICE, "-p", "warning", "--since", "7 days ago", "-n", str(MAX_LOG_LINES), "--no-pager", "-o", "short-iso"]).splitlines(),
        "nginxErrors": tail(NGINX_ERROR_LOG, MAX_LOG_LINES),
    }, ensure_ascii=False))


if __name__ == "__main__":
    main()
