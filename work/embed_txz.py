#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把已汉化的 .txz 以分块 base64 内嵌进 .plg，生成「单文件离线安装包」（诊断增强版）。

- base64 行改用 2048 字符/行（约 373 行），彻底排除 Unraid CA 引擎对超长单行
  （之前 12001 字符）截断/破坏的最大嫌疑。
- 安装脚本在解码前打印「实际拼接 base64 长度」，与期望长度对比；解码失败时
  打印明确诊断行，便于从 Unraid 安装日志定位是「行数被截断」还是「字符被破坏」。
- 每行形如 B6L_<i>="<2048 chars>;"，安装脚本按 i 递增拼接。
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

START_MARK = "内嵌的汉化插件包"
END_MARK = "Post-install script"

if START_MARK not in plg:
    raise SystemExit("未找到原安装块标记（可能已内嵌或结构变化）。")
if END_MARK not in plg:
    raise SystemExit("未找到 Post-install script 标记。")

start_idx = plg.index(START_MARK)
block_start = plg.rfind("<!--", 0, start_idx)
end_idx = plg.index(END_MARK)
block_end = plg.rindex("</FILE>", block_start, end_idx) + len("</FILE>")

header = '''<!--
下载并安装插件包（单文件离线版 · 分块 base64 内嵌 · 诊断增强）。

本 .plg 已内嵌汉化后的 .txz（base64 编码为下方多行、每行 2048 字符的分块），
无需联网即可安装。安装脚本拼接所有分块后解码到
/boot/config/plugins/<name>/<name>-<version>.txz，校验 MD5 后执行 installpkg。
2048 字符/行是为避免 Unraid CA 引擎对超长单行截断/破坏；解码前后打印拼接长度
与失败诊断，便于从安装日志定位问题。
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

echo "[zh] 正在准备安装 ${PLUGIN_NAME} v${VERSION} ..."
mkdir -p "${CONFIG_DIR}"

# 内嵌的汉化插件包（base64 分块，每块 2048 字符）
B64=""
'''

footer = '''
ACTUAL_LEN="${#B64}"
echo "[zh] 拼接完成：实际 base64 长度=${ACTUAL_LEN}，期望=${EXPECTED_LEN}，分块数=${N_CHUNKS}"
if [ "${ACTUAL_LEN}" != "${EXPECTED_LEN}" ]; then
  echo "[zh] 长度不匹配：内嵌 payload 可能被 Unraid CA 引擎截断/破坏。请记录上方 ACTUAL_LEN。"
fi

echo "[zh] 正在解码内嵌安装包 ..."
if printf '%s' "${B64}" | base64 -d > "${TXZ_PATH}" 2>/dev/null && [ -s "${TXZ_PATH}" ]; then
  echo "[zh] 解包完成：${TXZ_PATH}"
else
  echo "[zh] decode failed：base64 解码失败。请对照上方实际长度与期望长度 ${EXPECTED_LEN}。"
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

# 生成 373 行 base64（每行 2048 字符）；用普通字符串拼接 bash 行（避免 f-string 吃掉 ${}）
parts = []
for i, c in enumerate(chunks):
    line = 'B6L_' + str(i) + '="' + c + '"; B64="$' + '{B64}$' + 'B6L_' + str(i) + '"'
    parts.append(line)
chunk_block = "\n".join(parts)

new_block = header + "\n" + chunk_block + footer
new_block = new_block.replace("__EXP_LEN__", str(EXP_LEN)).replace("__N_CHUNKS__", str(N_CHUNKS))

new_plg = plg[:block_start] + new_block + plg[block_end:]
with open(PLG, "w", encoding="utf-8") as f:
    f.write(new_plg)

print("已生成 2048 字符/行、共", N_CHUNKS, "行 base64 的诊断增强版 .plg。")
print(".plg 字节数:", len(new_plg.encode("utf-8")))
print("期望 base64 长度:", EXP_LEN, "MD5:", md5)

# 自检
lines = [l for l in open(PLG, encoding="utf-8") if l.startswith('B6L_')]
joined = "".join(l.split('"')[1].rsplit('"', 1)[0] for l in lines)
assert joined == raw_b64, "反解析 base64 不一致！"
assert base64.b64decode(joined).hex() == txz.hex(), "解码字节与 .txz 不一致！"
print("自检通过：反解析 base64 与 .txz 字节一致。")
