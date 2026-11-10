# media-publish · 多平台自媒体「只填不发」投放器

一个给 AI Agent 用的 **Skill**：把本地视频一次录入，自动在 **抖音 / 快手 / B站 / 小红书 / YouTube / TikTok / 微信视频号** 的创作中心里完成「上传视频 + 填写标题/简介/话题/封面/创作声明」，然后**停在发布前**，由人手动点发布。

> **设计前提：绝不替人点发布。** 脚本里没有任何点击「发布 / 投稿」的代码路径 —— 不是用开关关掉的，是根本没有。

---

## 为什么是"只填不发"

1. 每个平台发布前都有平台特有的必选项（分区、创作声明、原创/转载、合集、定时、自主声明），脚本替你点等于替你做了合规判断；
2. 发布是公开且难以撤回的动作，填错（标题被截断、话题不对、封面不合适）代价是账号信誉；
3. 多平台同一时刻对外可见，人工点能控制节奏。

---

## 平台支持情况（2026-11 实测）

| 平台 | id | 登录 | 选择器 | 实测 |
| --- | --- | --- | --- | --- |
| B站 | `bilibili` | ✅ | ✅ | 标题/简介/话题/创作声明/封面，14s |
| 抖音 | `douyin` | ✅ | ✅ | 标题/简介/话题，10s |
| 快手 | `kuaishou` | ✅ | ✅ | 作品描述（标题+正文合并）/话题，22s |
| 小红书 | `xiaohongshu` | ✅ | ✅ | 标题/简介/话题，20s |
| YouTube | `youtube` | ✅ | ✅ | 标题/简介/话题，26s（自动存为「私享」草稿） |
| TikTok | `tiktok` | ✅ | ✅ | 标题/话题，22s |
| 微信视频号 | `wechat` | ✅ | ❌ | **未跑通**：`post/create` 只渲染出页面骨架，编辑器不出现 |

YouTube / TikTok 在中国大陆需要代理；代码路径本身已验证。

---

## 环境要求

- **Windows**（脚本用了 `LOCALAPPDATA`、`taskkill` 语义等；macOS/Linux 未适配）
- **Node.js ≥ 22**（依赖内置 `WebSocket`，无任何 npm 依赖）
- **Chrome 或 Edge**（自动探测常见安装路径）

不需要 `npm install`，不需要 opencli，不需要装浏览器扩展。

---

## 安装

把本仓库整个目录放到你的 Agent 技能目录下即可，例如：

```
%USERPROFILE%\.agents\skills\media-publish\
```

Agent 会在技能目录里发现 `SKILL.md` 并自动加载。

也可以直接用命令行跑 `scripts/publish.js`，不依赖 Agent。

---

## 用法

```bash
# 1) 首次：用独立 profile 打开 7 个平台，人工登录一次（长期有效）
node scripts/open-tabs.js 9341 \
  "https://creator.douyin.com/creator-micro/content/upload" \
  "https://cp.kuaishou.com/article/publish/video" \
  "https://member.bilibili.com/platform/upload/video/frame" \
  "https://creator.xiaohongshu.com/publish/publish?source=official" \
  "https://studio.youtube.com" \
  "https://www.tiktok.com/tiktokstudio/upload?from=upload" \
  "https://channels.weixin.qq.com/platform/post/create"

# 2) 日常：检查登录态（不上传任何东西）
node scripts/publish.js --check

# 3) 投放：只填不发
node scripts/publish.js \
  --video "C:\path\video.mp4" \
  --title "标题" \
  --desc "简介" \
  --tags "话题1,话题2" \
  --platforms bilibili,douyin,xiaohongshu
```

| 参数 | 说明 |
| --- | --- |
| `--video` | 视频绝对路径（必填） |
| `--title` | 标题（必填） |
| `--desc` | 简介 / 正文 |
| `--tags` | 话题，逗号分隔，**不带 `#`** |
| `--platforms` | 只处理指定平台；省略 = 全部 7 个 |
| `--check` | 只检测登录态 |
| `--login-wait` | 未登录时停在登录页等你扫码的秒数，默认 300；0 = 不等 |
| `--discard-leftover` | 快手弹「还有上次未发布的视频」时自动点「放弃」（**会丢弃旧草稿**，默认关） |
| `--timeout` | 单平台等待编辑表单的上限秒数，默认 900 |
| `--port` | 调试端口，默认 9341 |
| `--profile` | 指定 Chrome 配置目录 |

输出：stdout 一份 JSON（每平台 `status` / 填了哪些字段 / 截图路径），进度日志走 stderr。

---

## 安全性（这一节请务必读）

**它只用自己独立的 Chrome 配置目录**：`%LOCALAPPDATA%\media-publish-profile`。

- **绝不要**把 `--profile` 指向 `%LOCALAPPDATA%\Google\Chrome\User Data`。
  第二个 Chrome 实例会重写那里的 `Local State`，**把用户的 Google 账号登出、并清掉所有站点登录态**。
  脚本里有一道硬保险会直接拒绝这种调用，但请不要绕过它。
- 不使用、不读取、不上传你的任何 Cookie 或密码；登录全在你本机的浏览器里完成。
- 不会杀掉你正在用的 Chrome 进程（它只负责启动自己那个实例）。用完由你关闭。
- 跑完不关标签页，就是留给你核对和手动发布的。

---

## 已知限制

- 微信视频号未跑通（页面不渲染编辑器）。
- 平台改版会让选择器失效：所有选择器集中在 `scripts/platforms.js`，失败时会有截图和页面文字，照着改即可。
- 顺序执行，不做并发（同时传多个视频会互相抢带宽）。
- 不自动截断标题（各平台上限不同：抖音 30 / 小红书 20 / B站 80 / YouTube 100），超了平台自己会拦。
- 不改分区/分类，由平台自动判断。

---

## 免责声明

本项目通过浏览器自动化操作**你自己的账号**。使用前请自行确认目标平台的服务条款是否允许自动化操作；
因使用本工具导致的账号处罚、内容审核问题或数据损失，作者不承担责任。请保持半自动、人工确认。

---

## 仓库结构

```
media-publish/
├── SKILL.md              技能说明（Agent 读取）
├── README.md             本文件
├── LICENSE
├── scripts/
│   ├── publish.js        主引擎：开页面 → 判定登录 → 上传 → 填写 → 停手
│   ├── platforms.js      7 个平台的配置（入口/登录判据/选择器/话题模式）
│   ├── open-tabs.js      批量开标签页（首次登录用）
│   ├── scout.js          校准：导出某平台真实页面结构 + 截图
│   ├── diag.js           诊断：列出每个标签页的登录判定与 Cookie 概览
│   ├── dump-form.js      校准：按 URL 片段导出表单字段/按钮/上传信号
│   └── probe-url.js      探针：单 URL 深查（最终 URL / Cookie 明细 / 页面文字）
└── (无 npm 依赖)
```

`scout.js` / `diag.js` / `dump-form.js` / `probe-url.js` 是**校准与排障工具**，日常投放只用 `publish.js`。

## License

MIT
