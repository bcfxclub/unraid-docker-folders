#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
本地打包脚本：把汉化后的 Unraid Docker Folders 后端 + 前端 assets 打成 .txz。

说明：
- 本环境无 xz 二进制，故用 Python tarfile 的 xz 模式生成 .txz（Unraid 安装需要）。
- 所有 tar 成员属主设为 root(uid/gid=0)，与 build/build.sh 的 --owner=root --group=root 一致。
- GraphQL 后端 npm 包(unraid-api-plugin-docker-folders)因需 71MB 体积下载 + xz 解包，
  本环境无法构建，故不打包该 tarball；插件默认 PHP 模式完整可用，仅 GraphQL 模式增强缺失。
"""
import os
import io
import tarfile
import hashlib

PLUGIN_NAME = "unraid-docker-folders-modern"
PROJECT_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
# 打包根：tar 内的顶层目录是 usr/，后端文件都在 src/backend/usr 下
BACKEND_USR = os.path.join(PROJECT_ROOT, "src", "backend", "usr")
# 插件目录相对 BACKEND_USR 的路径（不含开头的 usr/）
PLUGIN_REL_PARTS = ["local", "emhttp", "plugins", PLUGIN_NAME]
PLUGIN_DIR_IN_TXZ = "usr/" + "/".join(PLUGIN_REL_PARTS)
ARCHIVE_DIR = os.path.join(PROJECT_ROOT, "archive")
BUILD_VERSION = "2026.10.25-2"  # 与上游版本保持一致（仅做汉化，不改版本号）

# 需要从仓库根目录复制进插件目录的附加文件
EXTRA_FILES = {
    "CHANGELOG.md": "CHANGELOG.md",
    "icon.png": "icon.png",
    "LICENSE": "LICENSE",
}

PERM_DIR = 0o755
PERM_EXEC = 0o755   # .sh
PERM_FILE = 0o644   # .php/.page/.html/.js/.css/.sql/其他


def perm_for(path: str) -> int:
    ext = os.path.splitext(path)[1].lower()
    if ext == ".sh":
        return PERM_EXEC
    return PERM_FILE


def main():
    if not os.path.isdir(BACKEND_USR):
        raise SystemExit(f"未找到后端目录: {BACKEND_USR}")

    # 前端 assets 必须存在
    assets_dir = os.path.join(BACKEND_USR, *PLUGIN_REL_PARTS, "assets")
    if not os.path.isdir(assets_dir):
        raise SystemExit("前端 assets 目录不存在，请先运行 npm run build")

    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    txz_path = os.path.join(ARCHIVE_DIR, f"{PLUGIN_NAME}-{BUILD_VERSION}.txz")

    members = []  # (arcname, local_path, mode, mtime) 文件带真实 mtime，目录为 0

    def fwd(p: str) -> str:
        return p.replace("\\", "/")

    # 1) 后端 usr 树（tar 内路径统一为 usr/... 正斜杠）
    for root, dirs, files in os.walk(BACKEND_USR):
        rel = fwd(os.path.relpath(root, BACKEND_USR))
        arc_dir = ("usr/" + rel) if rel != "." else "usr"
        members.append((arc_dir.rstrip("/") + "/", None, PERM_DIR, 0))  # 目录 mtime=0
        for f in files:
            local = os.path.join(root, f)
            arc = arc_dir.rstrip("/") + "/" + f
            members.append((arc, local, perm_for(f), int(os.path.getmtime(local))))  # 文件用真实 mtime

    # 2) 附加文件 -> 插件目录
    for src_name, dst_name in EXTRA_FILES.items():
        src = os.path.join(PROJECT_ROOT, src_name)
        if os.path.isfile(src):
            arc = fwd(PLUGIN_DIR_IN_TXZ) + "/" + dst_name
            members.append((arc, src, perm_for(dst_name), int(os.path.getmtime(src))))
        else:
            print(f"警告: 附加文件缺失，跳过: {src}")

    # 去重（保持顺序），目录与文件同路径时优先文件
    seen = {}
    for arc, local, mode, mtime in members:
        seen[arc] = (local, mode, mtime)
    ordered = list(seen.items())

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:xz", format=tarfile.GNU_FORMAT) as tf:
        for arc, (local, mode, mtime) in ordered:
            if local is None:
                # 目录
                ti = tarfile.TarInfo(name=arc.rstrip("/") + "/")
                ti.type = tarfile.DIRTYPE
                ti.mode = mode
                ti.uid = 0
                ti.gid = 0
                ti.uname = "root"
                ti.gname = "root"
                ti.mtime = mtime
                tf.addfile(ti)
            else:
                with open(local, "rb") as fh:
                    data = fh.read()
                ti = tarfile.TarInfo(name=arc)
                ti.size = len(data)
                ti.mode = mode
                ti.uid = 0
                ti.gid = 0
                ti.uname = "root"
                ti.gname = "root"
                ti.mtime = mtime
                tf.addfile(ti, io.BytesIO(data))

    out = buf.getvalue()
    with open(txz_path, "wb") as fh:
        fh.write(out)

    md5 = hashlib.md5(out).hexdigest()
    size_kb = len(out) / 1024.0
    print(f"已生成: {txz_path}")
    print(f"大小: {size_kb:.1f} KB ({len(out)} bytes)")
    print(f"MD5: {md5}")
    print(f"文件成员数: {len(ordered)}")

    # 写 md5 到文件便于后续更新 .plg
    with open(os.path.join(ARCHIVE_DIR, f"{PLUGIN_NAME}-{BUILD_VERSION}.md5"), "w") as fh:
        fh.write(md5)
    print("已写入 md5 文件。")


if __name__ == "__main__":
    main()
