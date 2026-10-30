#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把已汉化的 .txz 以分块 base64 内嵌进 .plg，生成「单文件离线安装包」。

- base64 行每行 2048 字符，避免 Unraid CA 引擎截断超长行。
- 如果原 .plg 已有内嵌块，则替换；否则在 </PLUGIN> 前插入新块。
- pluginURL 保持原样（用于在线更新检查），离线安装优先使用内嵌包。
"""
import os
import re
import base64
import hashlib

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PLG = os.path.join(REPO, "unraid-docker-folders-modern.plg")
TXZ = os.path.join(REPO, "archive", "unraid-docker-folders-modern-2026.10.25-2.txz")

with open(PLG, "r", encoding="utf-8") as f:
    plg = f.read()

txz = open(TXZ, "rb").read()
md5 = hashlib.md5(txz).hexdigest()
raw_b64 = base64.b64encode(txz).decode("ascii")
EXP_LEN = len(raw_b64)
chunk_len = 2048
chunks = [raw_b64[i:i + chunk_len] for i in range(0, len(raw_b64), chunk_len)]
N_CHUNKS = len(chunks)

# 生成 bash 脚本行
parts = []
for i, c in enumerate(chunks):
    line = 'B6L_' + str(i) + '="' + c + '"; B64="$' + '{B64}$' + 'B6L_' + str(i) + '"'
    parts.append(line)
chunk_block = "\n".join(parts)

# 构建新的内嵌安装块
new_block = '''<!--
下载并安装插件包（单文件离线版 · 分块 base64 内嵌）。
-->
<FILE Run="/bin/bash">
<INLINE>
<![CDATA[
#!/bin/bash

PLUGIN_NAME="unraid-docker-folders-modern"
CONFIG_DIR="/boot/config/plugins/${PLUGIN_NAME}"
VERSION="]]>&version;<![CDATA["
TXZ_NAME="${PLUGIN_NAME}-${VERSION}.txz"
TXZ_PATH="${CONFIG_DIR}/${TXZ_NAME}"
EXPECTED_MD5="]]>&md5;<![CDATA["
EXPECTED_LEN="__EXP_LEN__"
N_CHUNKS="__N_CHUNKS__"

echo "[zh] 正在安装 ${PLUGIN_NAME} v${VERSION} ..."
mkdir -p "${CONFIG_DIR}"

# 内嵌的汉化插件包（base64 分块，每块 2048 字符）
B64=""
''' + chunk_block + '''
ACTUAL_LEN="${#B64}"
echo "[zh] 拼接完成：实际 base64 长度=${ACTUAL_LEN}，期望=${EXPECTED_LEN}，分块数=${N_CHUNKS}"

if [ "${ACTUAL_LEN}" != "${EXPECTED_LEN}" ]; then
  echo "[zh] 长度不匹配：内嵌 payload 可能被截断。请记录上方 ACTUAL_LEN。"
  exit 1
fi

echo "[zh] 正在解码内嵌安装包 ..."
if printf '%s' "${B64}" | base64 -d > "${TXZ_PATH}" 2>/dev/null && [ -s "${TXZ_PATH}" ]; then
  echo "[zh] 解包完成：${TXZ_PATH}"
else
  echo "[zh] decode failed：base64 解码失败。"
  exit 1
fi

if command -v md5sum >/dev/null 2>&1; then
  CALC_MD5=$(md5sum "${TXZ_PATH}" | awk '{print $1}')
else
  CALC_MD5=$(md5 -q "${TXZ_PATH}")
fi

if [ "${CALC_MD5}" = "${EXPECTED_MD5}" ]; then
  echo "[zh] MD5 校验通过，开始安装 ..."
  installpkg "${TXZ_PATH}"
else
  echo "[zh] MD5 校验失败（期望 ${EXPECTED_MD5}，实际 ${CALC_MD5}），已取消安装。"
  exit 1
fi
]]>
</INLINE>
</FILE>'''

# 检测是否已有内嵌块
START_MARK = "<!--\n下载并安装插件包（单文件离线版"
END_MARK = "</FILE>"

if START_MARK in plg and plg.index(START_MARK) < plg.rindex(END_MARK):
    # 已有内嵌块，替换
    start_idx = plg.index(START_MARK)
    block_start = plg.rfind("<!--", 0, start_idx)
    end_idx = plg.index(END_MARK, start_idx)
    block_end = end_idx + len(END_MARK)
    new_plg = plg[:block_start] + new_block + plg[block_end:]
else:
    # 没有内嵌块，在 </PLUGIN> 前插入
    plugin_close = "</PLUGIN>"
    if plugin_close in plg:
        insert_pos = plg.index(plugin_close)
        new_plg = plg[:insert_pos] + "\n" + new_block + "\n" + plg[insert_pos:]
    else:
        raise SystemExit("未找到 </PLUGIN> 标签")

new_plg = new_plg.replace("__EXP_LEN__", str(EXP_LEN)).replace("__N_CHUNKS__", str(N_CHUNKS))

with open(PLG, "w", encoding="utf-8") as f:
    f.write(new_plg)

print("已生成 2048 字符/行、共", N_CHUNKS, "行 base64 的内嵌版 .plg。")
print(".plg 字节数:", len(new_plg.encode("utf-8")))
print("期望 base64 长度:", EXP_LEN, "MD5:", md5)

# 自检
lines = [l for l in open(PLG, encoding="utf-8") if l.startswith('B6L_')]
joined = "".join(l.split('"')[1].rsplit('"', 1)[0] for l in lines)
assert joined == raw_b64, "反解析 base64 不一致！"
assert base64.b64decode(joined).hex() == txz.hex(), "解码字节与 .txz 不一致！"
print("自检通过：反解析 base64 与 .txz 字节一致。")
