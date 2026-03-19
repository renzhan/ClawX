# ClawX 相比原生 OpenClaw 的修改与增强

## 1. 桌面 GUI 封装

ClawX 将 OpenClaw CLI 运行时封装为跨平台 Electron 桌面应用（macOS / Windows / Linux），提供完整的图形化操作界面，用户无需使用终端即可管理 AI Agent。

核心架构：
- Electron 主进程负责窗口管理、Gateway 进程监控、系统集成（托盘、通知、Keychain）、自动更新
- React 19 渲染进程提供现代化 UI，使用 Zustand 状态管理、Tailwind CSS + shadcn/ui 样式
- 双进程通过 IPC 通信，渲染进程统一通过 `host-api.ts` / `api-client.ts` 调用后端，不直接访问 Gateway HTTP

## 2. OpenClaw Gateway 内嵌与生命周期管理

- 将 OpenClaw 运行时作为 npm 依赖内嵌，打包时通过 `scripts/bundle-openclaw.mjs` 将完整的 openclaw 包及其 575+ 依赖拷贝到 `build/openclaw/`，随安装包分发
- 应用启动时自动拉起 Gateway 进程（端口 18789），管理其完整生命周期（启动、健康检查、重连、重启、关闭）
- 通信策略由主进程控制：WebSocket 优先 → HTTP 回退 → IPC 兜底

## 3. 多 AI Provider 统一管理

ClawX 内置了以下 Provider 定义（`electron/shared/providers/registry.ts`），原生 OpenClaw 需要手动编辑配置文件：

| Provider | 类型 | 默认模型 |
|----------|------|----------|
| Anthropic | 官方 | claude-opus-4-6 |
| OpenAI | 官方（支持 OAuth） | gpt-5.2 |
| Google | 官方（支持 OAuth） | gemini-3.1-pro-preview |
| OpenRouter | 兼容 | anthropic/claude-opus-4.6 |
| ByteDance Ark | 官方 | (需配置 endpoint) |
| Moonshot (CN) | 官方 | kimi-k2.5 |
| SiliconFlow (CN) | 兼容 | deepseek-ai/DeepSeek-V3 |
| MiniMax (Global) | 官方（支持 Device OAuth） | MiniMax-M2.5 |
| MiniMax (CN) | 官方（支持 Device OAuth） | MiniMax-M2.5 |
| Qwen | 官方（支持 Device OAuth） | coder-model |
| Ollama | 本地 | (需配置) |
| Item | 企业内部 | gpt-5.1 |
| Custom | 自定义 | (需配置) |

API Key 存储在系统原生 Keychain 中，OpenAI/Google 支持浏览器 OAuth 登录。

## 4. Item Provider（企业 LLM 网关集成）

ClawX 新增了 Item Provider，对接公司内部 AI 网关服务：

- IAM 登录成功后，自动调用 `https://aiop-gateway.item.com/admin/api/credentials/jwt` 获取 JWT API Key
- 请求参数包含 `apiKey`、`agentName`（openclaw）、`appCode`（clawbot）、`userName`（IAM 用户名）
- JWT 存入 provider 配置文件（Gateway 子进程需要从文件读取）
- 自动创建 Item provider 账户并设为默认
- 配置集中在 `electron/utils/config.ts` 的 `ITEM_GATEWAY_CONFIG`

## 5. IAM 认证系统（OAuth2 授权码流程）

ClawX 新增企业 IAM 登录功能（`electron/services/iam/`）：

- 使用 OAuth2 Authorization Code Flow
- 启动临时本地 HTTP 服务器接收回调
- 打开系统浏览器跳转 IAM 登录页（默认 `https://id-dev.item.pub`）
- 用户登录后 IAM 重定向回本地，携带 authorization_code
- 用 code 换取 access_token + 用户信息
- Token 存储在 electron-store（`iam-auth` JSON 文件）
- 通过 `IAM_ENABLED` 环境变量控制是否启用（默认 true）
- 启用后每次启动必须先登录，RouteGuard 组件拦截未认证访问

配置项（`electron/utils/config.ts` 的 `IAM_CONFIG`）：
- `IAM_HOST`：IAM 服务器地址
- `IAM_CLIENT_ID` / `IAM_CLIENT_SECRET`：OAuth2 客户端凭证
- `IAM_TOKEN_PATH` / `IAM_AUTHORIZE_PATH` / `IAM_USERINFO_PATH`：端点路径
- `IAM_TIMEOUT`：请求超时

## 6. 云端备份服务

ClawX 新增自动云端备份功能（`electron/services/backup/`）：

- 压缩 agent 配置、skills、memory 目录为 zip
- 通过 IAM Token 认证上传到云端 API
- 每日定时备份（默认窗口 22:00-04:00）
- 支持手动触发备份和从云端恢复
- 仅 IAM 登录用户可用

环境变量：
- `BACKUP_API_URL`：备份 API 地址
- `BACKUP_TIMEOUT`：上传/下载超时
- `BACKUP_WINDOW_START` / `BACKUP_WINDOW_END`：备份时间窗口

## 7. 预装 Skills 机制

### 打包时

通过 `scripts/bundle-preinstalled-skills.mjs` 脚本，在打包阶段从 GitHub 拉取 skills：

1. 读取 `resources/skills/preinstalled-manifest.json` 配置
2. 对每个 skill，使用 `git sparse-checkout --depth 1` 浅克隆只拉取需要的目录
3. 拷贝到 `build/preinstalled-skills/`
4. 通过 `electron-builder.yml` 的 `extraResources` 打入安装包

### 运行时

应用启动时调用 `ensurePreinstalledSkillsInstalled()`（`electron/utils/skill-config.ts`）：
- 从安装包 resources 中读取预装 skills
- 部署到 `~/.openclaw/skills/` 目录
- 幂等操作，不覆盖用户已修改的 skill
- 通过 `.clawx-preinstalled.json` marker 文件跟踪版本

### 预装内容

| Skill | 来源仓库 | 用途 |
|-------|----------|------|
| pdf | anthropics/skills | PDF 文档解析 |
| xlsx | anthropics/skills | Excel 文件解析 |
| docx | anthropics/skills | Word 文档解析 |
| pptx | anthropics/skills | PowerPoint 解析 |
| find-skills | vercel-labs/skills | 技能发现 |
| self-improving-agent | openclaw/skills | 自我改进 Agent |
| tavily-search | tavily-ai/skills | Tavily 搜索（需 TAVILY_API_KEY） |
| brave-web-search | brave/brave-search-skills | Brave 搜索（需 BRAVE_SEARCH_API_KEY） |
| bocha-skill | openclaw/skills | Bocha 搜索（需 BOCHA_API_KEY） |

所有 skill 默认 `autoEnable: true`。

## 8. 消息渠道插件（Channel Plugins）

ClawX 内置了以下消息渠道插件，打包时通过 `scripts/bundle-openclaw-plugins.mjs` 从 npm 依赖中提取：

| 渠道 | npm 包 | 目录名 |
|------|--------|--------|
| 钉钉 (DingTalk) | @soimy/dingtalk | dingtalk |
| 企业微信 (WeCom) | @wecom/wecom-openclaw-plugin | wecom |
| 飞书 (Feishu/Lark) | @larksuite/openclaw-lark | feishu-openclaw-plugin |
| QQ Bot | @sliverp/qqbot | qqbot |

运行时通过 `ensurePluginInstalled()` 从安装包 resources 拷贝到 `~/.openclaw/extensions/`。

原生 OpenClaw 还支持 Telegram、Discord、WhatsApp、Signal、iMessage、Matrix、Line、MS Teams、Google Chat、Mattermost 等渠道，但这些不需要额外插件。

## 9. 自动更新

- 使用 `electron-updater` 实现应用内自动更新
- 主更新源：阿里云 OSS CDN `https://oss.intelli-spectrum.com/{channel}/`
- 备用源：GitHub Releases（`ValueCell-ai/ClawX`）
- 协议：HTTPS GET（generic provider），无需认证
- 更新通道根据版本号自动检测：正式版 → `/latest/`，beta → `/beta/`，alpha → `/alpha/`
- 下载完成后 5 秒倒计时自动安装

## 10. 国际化（i18n）

支持三种语言，原生 OpenClaw 仅有英文 CLI：
- English (en)
- 简体中文 (zh)
- 日本語 (ja)

启动时自动检测系统语言，首次引导向导中可选择。

## 11. 首次启动引导向导（Setup Wizard）

原生 OpenClaw 需要手动编辑配置文件，ClawX 提供图形化引导：
1. 语言与地区设置
2. AI Provider 配置（API Key 或 OAuth）
3. Skill 选择
4. 配置验证

## 12. 其他增强

- 系统托盘支持，最小化到托盘
- 开机自启动（Settings → General）
- 深色/浅色/跟随系统主题
- 代理设置（HTTP/HTTPS/SOCKS，自动同步到 Gateway 和 Telegram 渠道）
- OpenClaw Doctor 集成（Settings → Advanced → Developer，无需离开 app 即可诊断）
- Token 用量统计仪表盘（读取 OpenClaw session transcript .jsonl 文件聚合）
- Cron 定时任务可视化管理
- 通信回归测试框架（`comms:replay` / `comms:compare`）


## 13. 打包常见问题与解决方案

### 13.1 DMG 构建 404 错误（npmmirror 缺少 dmgbuild-bundle）

错误信息：
```
⨯ Response code 404 (Not Found) for https://cdn.npmmirror.com/binaries/electron/dmg-builder@1.2.0/dmgbuild-bundle-arm64-75c8a6c.tar.gz
```

原因：`.npmrc` 中配置了 `electron_mirror` 和 `electron_builder_binaries_mirror` 指向 npmmirror，但 npmmirror 上缺少 dmgbuild-bundle 文件。

解决方案：

方案 A（推荐）：注释掉 `.npmrc` 中的镜像配置，让 electron-builder 从 GitHub 官方源下载：
```
# electron_mirror=https://npmmirror.com/mirrors/electron/
# electron_builder_binaries_mirror=https://npmmirror.com/mirrors/electron-builder-binaries/
```
同时清理缓存：`rm -rf ~/Library/Caches/electron-builder/dmg`

方案 B：跳过 DMG，只出 zip（内部分发够用）：
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run package:mac -- --arm64 -c.mac.target=zip
```

### 13.2 macOS 代码签名失败

错误信息：
```
skipped macOS application code signing  reason=cannot find valid "Developer ID Application" identity
0 valid identities found
```

原因：本地没有 Apple Developer 证书。

解决方案：

公司内部分发不需要正式签名，打包时跳过签名：
```bash
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run package:mac -- --arm64
```

用户安装后首次打开需要：
- 右键点击 ClawX.app → 选择"打开" → 弹窗中点"打开"
- 或终端执行：`xattr -cr /Applications/ClawX.app`

### 13.3 uv 二进制缺失导致 onboard 失败

错误信息：
```
Error: uv not found in system PATH and bundled binary missing at /Applications/ClawX.app/Contents/Resources/bin/uv
```

原因：打包前没有下载 `uv` 二进制文件到 `resources/bin/` 目录。`pnpm run package:mac` 不会自动下载 uv。

解决方案：打包前先执行：
```bash
pnpm run uv:download
```
确认 `resources/bin/darwin-arm64/` 目录存在后再打包。

### 13.4 预装 Skills 路径变更导致打包失败

错误信息：
```
Error: Missing source path in repo checkout: skills/tavily/search
```

原因：上游 skill 仓库重构了目录结构（如 `skills/tavily/search` → `skills/tavily-search`）。

解决方案：更新 `resources/skills/preinstalled-manifest.json` 中对应 skill 的 `repoPath` 字段，使其与上游仓库实际路径一致。

### 13.5 推荐的完整打包命令（公司内部分发）

```bash
# 1. 确保依赖和 uv 已下载
pnpm run init

# 2. 打包 macOS arm64（跳过签名，跳过 DMG 只出 zip）
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm run package:mac -- --arm64 -c.mac.target=zip

# 3. 打包 Windows x64
pnpm run package:win -- --x64
```

产物在 `release/` 目录下。
