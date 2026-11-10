---
name: media-publish
description: 多平台自媒体「只填不发」投放：一次录入视频+标题+简介+话题，自动在抖音/快手/B站/小红书/YouTube/TikTok/微信视频号的创作中心上传并填写，停在发布前，标签页全部保留，由人手动点发布。当用户要「发到多个平台」「多平台分发」「批量投稿但先别发布」时使用。
allowed-tools: Bash, Read, Write, Edit
---

# 多平台自媒体投放（只填不发）

一次录入，7 个平台各自上传 + 填好，**然后停下来**。发布永远由人点。

这是刻意的设计边界：脚本里没有任何「点击发布」的代码路径，`--submit` 这类参数也不存在。

## 当前状态（重要，先看这个）

| 平台 | id | 登录态 | 选择器 | 实测结果（2026-11-10） |
| --- | --- | --- | --- | --- |
| B站 | `bilibili` | ✅ | ✅ | 标题/简介/话题/创作声明/封面 全中，13s |
| 快手 | `kuaishou` | ✅ | ✅ | 作品描述（标题+正文合并）/话题，22s |
| 小红书 | `xiaohongshu` | ✅ | ✅ | 标题/简介/话题，23s |
| YouTube | `youtube` | ✅ | ✅ | 标题/简介/话题，26s；已保存为「私享」草稿 |
| TikTok | `tiktok` | ✅ | ✅ | 标题/话题，22s |
| 抖音 | `douyin` | ✅ | ✅ | 标题/简介/话题，11s |
| 微信视频号 | `wechat` | ✅ | ❌ 未跑通 | 页面只渲染出「视频号 · 助手」骨架，无上传控件 |

> YouTube / TikTok 的登录与填写本身已验证（见上表 26s / 22s），但中国大陆网络需要 VPN 才能稳定访问。

「未校准」= 配置是按平台页面的常见结构 + 项目既有配置推断的，第一次跑**大概率需要修一次选择器**。
下面第七节写了校准流程，通常每个平台 5 分钟。

## 用法

```bash
# 1) 先看登录态（不打开上传页、不上传）
node scripts/publish.js --check

# 2) 只跑已登录的平台
node scripts/publish.js \
  --video "C:\path\video.mp4" --title "标题" --desc "简介" --tags "室内攀岩,运动" \
  --platforms bilibili,youtube,wechat

# 3) 全跑
node scripts/publish.js --video "..." --title "..." --tags "..."
```

| 参数 | 说明 |
| --- | --- |
| `--video` | 视频绝对路径（必填） |
| `--title` | 标题（必填） |
| `--desc` | 简介 / 正文 |
| `--tags` | 话题，逗号分隔，**不带 `#`** |
| `--platforms` | 只处理指定平台，逗号分隔；省略 = 全部 |
| `--check` | 只检测登录态 |
| `--port` | 调试端口，默认 9341 |
| `--profile` | 指定 Chrome 配置目录 |

stdout 输出 JSON 汇总：每个平台 `status` ∈ `ready / need_login / failed / partial`，外加 `titleFilled`、
`descFilled`、`tagsOk`、`declaration`、`cover`、`screenshot`。

## 它会怎么处理每个平台

1. 开一个标签页 → 打开创作中心；
2. 判登录：URL 落在 `login/passport/accounts.google` 或页面出现登录文案 → 重开 3 次（首次启动 cookie 未就绪是常见假象），仍不行就**把该标签页停在登录页**、标记 `need_login`、继续下一个平台；
3. 上传：拦截文件选择框 + 可信点击上传按钮 → `DOM.setFileInputFiles`；点不出选择框时兜底直接塞进页面里的视频 `input`；
4. 等编辑表单出现（标题框可见），每 15 秒打一次上传/转码进度；
5. 填标题 → 简介 → 话题（两种模式：`inline` 追加到正文、`chip` 逐个回车建标签）；
6. 平台必要项：B 站还要选「创作声明」、点一张系统推荐封面；
7. 截图存档，标记 `ready`，**停手**。标签页保持打开。

## 登录与 profile（重要）

**推荐用独立配置目录**（下文简称"实例 profile"），它和你的日常 Chrome 互不影响、可以同时开着：

```bash
# 第一次：用独立 profile 起一个 Chrome 并打开 7 个入口，人工登录
node scripts/open-tabs.js 9341 \
  "https://creator.douyin.com/creator-micro/content/upload" \
  "https://cp.kuaishou.com/article/publish/video" \
  "https://member.bilibili.com/platform/upload/video/frame" \
  "https://creator.xiaohongshu.com/publish/publish?source=official" \
  "https://studio.youtube.com" \
  "https://www.tiktok.com/tiktokstudio/upload?from=upload" \
  "https://channels.weixin.qq.com/platform/post/create"
# （先用该 profile 启动 Chrome：--user-data-dir=%LOCALAPPDATA%\media-publish-profile --remote-debugging-port=9341）

# 之后每次投放都指定同一个 profile，登录态长期复用
node scripts/publish.js --profile "%LOCALAPPDATA%\media-publish-profile" --video ... --title ...
```

- **不要**用 `%LOCALAPPDATA%\Google\Chrome\User Data`（你日常的配置）当 profile：
  历史遗留的「目录联接」做法会被 Chrome 的 App-Bound Encryption 与路径差异影响，
  经常出现"Cookie 在、但页面仍跳登录"的假象。
- 未登录的平台：脚本会把标签页停在登录页，`--login-wait`（默认 300 秒）内你扫码，它自己接着走。
- 已登录的平台不用重复登录，登录态存在实例 profile 里，直到平台自己失效。

> 如果你的日常 Chrome 正开着而脚本又没指定 `--profile`，脚本会报错退出 —— 这是为了防止两个实例抢同一个配置目录。


## 校准一个平台（第一次跑某平台失败时）

```bash
# 1) 打开该平台的创作中心，导出真实结构 + 截图
node scripts/scout.js douyin
# 产物：%TEMP%\media-publish-scout\douyin.png + report.json
```

看截图和 `report.json`，然后改 `scripts/platforms.js` 里该平台的：

| 字段 | 作用 |
| --- | --- |
| `entry` / `loginUrl` | 打开哪个页面 / 登录页 |
| `loginMarkers` | 页面上出现这些字就判定「未登录」 |
| `loginUrlIncludes` | URL 必须包含这段，否则判定异常 |
| `uploadButtons` | 上传入口按钮文案，按顺序尝试 |
| `titleSelectors` / `titlePlaceholder` | 标题框选择器；找不到时用占位符正则兜底 |
| `descSelectors` / `descPlaceholder` | 简介框 |
| `tags.mode` | `inline`（追加 `#话题` 到正文）或 `chip`（逐回车建标签） |
| `extras` | 额外必填项（目前只有 B 站的 `declaration` + `cover`） |
| `confirmance: 'draft' → 'verified'` | 跑通后改掉 |

## 失败排查

- `need_login` → 脚本已把标签页停在登录页，扫码后加 `--platforms <id>` 重跑。
- `failed` + `找不到上传按钮` → 改 `uploadButtons` 文案。
- `failed` + `上传后没等到编辑表单` → 上传被拦（格式/大小/风控），看 `notes` 里的页面文字和截图。
- 所有失败都带截图路径：`%TEMP%\media-publish\<platform>-error.png`。
- 脚本**不关标签页也不关 Chrome**，就是留给你核对和补填的。

## 为什么一定要人点发布

1. 各平台发布前都有平台特有的必选项（分区、创作声明、原创/转载、合集、定时、声明与权益），脚本替你点等于替你做了合规判断；
2. 发布是公开且难以撤回的动作，一旦填错（标题截断、话题不对、封面不合适）代价是账号信誉；
3. 七个平台同一时刻对外可见，人工点能有节奏。

## 已知限制

- **顺序执行**，不做并发：同时传 7 个视频会互相抢带宽。
- **标题超长不自动截断**（各平台上限不同：抖音 30 / 小红书 20 / B站 80 / YouTube 100）。超了平台自己会拦，脚本会在 `notes` 里提示。
- **分区/分类不改**，由平台自动判断。
- YouTube 的上传是一个多步对话框（详情 → 视频元素 → 检查 → 可见性），首次跑大概率要按截图修 `titleSelectors`。
