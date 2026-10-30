# Unraid Docker Folders（容器文件夹 · 中文汉化版）

一款 Unraid 插件，为 Docker 标签页增加文件夹分组管理，支持实时更新，并采用干净的 Vue 3 界面。

> 本仓库为 [rizowski/unraid-docker-folders](https://github.com/rizowski/unraid-docker-folders) 的**简体中文汉化版**：界面与提示信息均已翻译为中文。插件功能与原版一致，默认使用 PHP 后端模式，完整可用。

## 功能特性

### 分组管理
- **文件夹**：将 Docker 容器分组到可自定义图标与颜色的文件夹中
- **拖拽排序**：在文件夹之间拖动容器来整理（基于 SortableJS）
- **Compose 项目分组**：自动将属于同一 Docker Compose 项目的容器归为一组
- **网格与列表视图**：在两种布局模式间切换
- **容器搜索**：按名称或镜像实时筛选；匹配的文件夹会自动展开
- **导入/导出**：将文件夹配置以 JSON 形式备份与共享

### 容器管理
- **容器操作**：直接在文件夹视图中启动、停止、重启、删除容器
- **镜像更新**：检查可用镜像更新、查看更新说明，并可一次拉取一个或多个容器
- **Compose 管理**：在界面中编辑并应用 Docker Compose 文件，带版本历史
- **计划任务**：按 cron 计划执行容器操作
- **自动备份**：自动备份文件夹与插件配置

### 实时数据
- **实时资源统计**：运行中容器的 CPU、内存、I/O、网络、进程数、重启次数、运行时长、镜像/日志大小
- **容器日志**：从展开的容器卡片中流式查看日志
- **实时更新**：通过 Unraid 的 nchan 服务进行 WebSocket 推送——所有打开的标签页即时同步
- **轮询兜底**：30 秒轮询捕捉外部变更（CLI、Portainer 等）
- **CSRF 集成**：正确对接 Unraid WebGUI 的安全校验

## 技术栈

- **前端**：Vue 3 + TypeScript + Vite + Pinia + Tailwind CSS 4
- **后端**：PHP 8.0+ + SQLite3
- **实时通信**：nchan WebSocket 发布/订阅
- **拖拽**：SortableJS

## 安装

### 方式一：通过 Community Applications（应用市场）
在 **Apps（应用）** 标签页中搜索 **Docker Folders** 安装原版。

### 方式二：通过 URL 安装原版
1. 进入 Unraid 的 **Plugins（插件）** > **Install Plugin（安装插件）**
2. 粘贴以下 URL 并点击 **Install（安装）**：
   ```
   https://raw.githubusercontent.com/rizowski/unraid-docker-folders/main/unraid-docker-folders-modern.plg
   ```
3. 安装完成后，Unraid 菜单中 **Docker** 下会出现 **Folders（文件夹）** 标签页

历史版本见 [Releases](https://github.com/rizowski/unraid-docker-folders/releases) 页面。

### 方式三：单文件离线安装（汉化版 · 推荐）
汉化版的 `unraid-docker-folders-modern.plg` 已把 `.txz` 安装内容以 base64 内嵌其中，**一个文件即可离线安装**，无需联网、无需单独拷贝 `.txz`：

1. 将本仓库根目录的 `unraid-docker-folders-modern.plg`（约 800 KB，已内嵌汉化插件包）
   上传到 Unraid 的 flash 盘，例如 `/boot/config/unraid-docker-folders-modern.plg`，
   或直接以文件形式导入。
2. 在 Unraid 的 **Plugins（插件）** 页面，点击 **Install Plugin**，
   粘贴该 `.plg` 的地址（或拖入文件）并安装。
3. 安装脚本会自动把内嵌的 base64 解码为 `.txz`，校验 MD5 后执行 `installpkg`，
   全程离线完成。安装后菜单 **Docker** 下出现 **Folders（文件夹）** 标签页，
   界面即为简体中文。

> 说明：`.plg` 的 MD5 校验值与内嵌 `.txz` 的实际字节完全一致，安装前会验证完整性。
> 离线安装不依赖 GitHub。

### 从源码构建
```bash
# 前端构建（本环境使用 npm；原版使用 yarn）
cd src/frontend && npm install && npm run build

# 打包插件（本地构建，生成 .txz 与 MD5）
python3 work/package_local.py

# 输出：archive/unraid-docker-folders-modern-<version>.txz
```

发布版本由原版 GitHub Actions 在推送至 `main`（稳定版）或 `dev`（预发布）时自动构建，
工作流会运行 `./build/build.sh --release`，完成前端构建、打包 `.txz`、更新 `.plg`、打标签并发布 Release。

## 已知限制（汉化版）
- 本汉化版的 `.txz` 未包含 GraphQL 后端 npm 包（`unraid-api-plugin-docker-folders`），
  因此仅支持默认的 **PHP 后端模式**；如需 GraphQL 模式增强，请基于原版构建流程补充该包。
- GraphQL 模式相关的少量英文术语（如 `docker compose` 命令名）按惯例保留未译。

## 支持与许可
- **问题反馈**：[GitHub Issues](https://github.com/rizowski/unraid-docker-folders/issues)（原版）
- **许可**：MIT License，详见 [LICENSE](https://github.com/rizowski/unraid-docker-folders/blob/main/LICENSE)
- 本插件内置 [CodeMirror 5](https://codemirror.net/5/)（MIT），用于 Compose 文件编辑。

## 致谢
原作者：[rizowski](https://github.com/rizowski)
灵感来自 VladoPortos 的 [folderview2](https://github.com/VladoPortos/folder.view2)
