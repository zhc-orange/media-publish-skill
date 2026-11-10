'use strict';

/**
 * 7 个平台的配置。
 *
 * confidence:
 *   verified —— 已在真实页面跑通（B 站）
 *   draft    —— 按项目里既有的配置/文案推断，尚未在真实页面校准（需要登录后跑一次 scout）
 *
 * 原则：这里只描述「怎么把内容填进去」，不包含任何「点击发布」的配置。
 * 发布必须由人在页面上手动点。
 */

const PLATFORMS = [
  {
    id: 'douyin',
    name: '抖音',
    confidence: 'draft',
    entry: 'https://creator.douyin.com/creator-micro/content/upload',
    loginUrl: 'https://creator.douyin.com/',
    loginMarkers: ['扫码登录', '密码登录', '验证码登录', '手机号登录'],
    loggedInSelectors: ['input[type=file]', '[class*="avatar"]', '[class*="user-info"]'],
    loginUrlIncludes: 'creator.douyin.com',
    uploadButtons: ['text=上传视频', 'text=点击上传', 'text=发布视频'],
    titleSelectors: ['input[placeholder*="作品标题"]', 'input[placeholder*="标题"]', '[class*="title"] input'],
    titlePlaceholder: /标题/,
    descSelectors: ['div[contenteditable="true"]', '[class*="editor"] [contenteditable="true"]'],
    descPlaceholder: /简介|描述|正文/,
    tags: { mode: 'inline', prefix: '#', limit: 5 },
    maxTitle: 30,
    waitMs: 240000,
  },
  {
    id: 'kuaishou',
    name: '快手',
    confidence: 'draft',
    entry: 'https://cp.kuaishou.com/article/publish/video',
    loginUrl: 'https://cp.kuaishou.com/',
    loginMarkers: ['立即登录', '扫码登录', '账号登录'],
    loginUrlIncludes: 'cp.kuaishou.com',
    uploadButtons: ['text=上传视频', 'text=点击上传', 'text=发布作品'],
    titleSelectors: ['[class*="_description_"]', '[contenteditable="true"][placeholder*="作品描述"]', 'div[contenteditable="true"]'],
    titlePlaceholder: /作品描述/,
    descSelectors: [],
    descPlaceholder: null,
    mergedTitleDesc: true,
    leftoverPrompt: '还有上次未发布的视频',
    leftoverDismiss: ['text=放弃'],
    tags: { mode: 'inline', prefix: '#', limit: 5 },
    maxTitle: 30,
    waitMs: 240000,
  },
  {
    id: 'bilibili',
    name: 'B站',
    confidence: 'verified',
    entry: 'https://member.bilibili.com/platform/upload/video/frame',
    loginUrl: 'https://passport.bilibili.com/login',
    loginMarkers: [],
    loginUrlIncludes: 'member.bilibili.com',
    uploadButtons: ['text=上传视频'],
    titleSelectors: ['input[placeholder="请输入稿件标题"]', 'input[placeholder*="稿件标题"]'],
    titlePlaceholder: /稿件标题/,
    descSelectors: ['div.ql-editor'],
    descPlaceholder: /简介/,
    tags: { mode: 'chip', limit: 10, replace: true, selector: 'input[placeholder*="创建标签"]' },
    extras: ['declaration', 'cover'],
    maxTitle: 80,
    waitMs: 900000,
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    confidence: 'draft',
    entry: 'https://creator.xiaohongshu.com/publish/publish?source=official',
    loginUrl: 'https://creator.xiaohongshu.com/login',
    loginMarkers: ['短信登录', '扫码登录', '发送验证码'],
    loginUrlIncludes: 'creator.xiaohongshu.com',
    uploadButtons: ['text=上传视频', 'text=视频'],
    titleSelectors: ['input[placeholder*="标题"]', '.title-input input', '[class*="title"] input'],
    titlePlaceholder: /标题/,
    descSelectors: ['div[contenteditable="true"]', '.ql-editor', 'textarea[placeholder*="正文"]'],
    descPlaceholder: /正文|描述|简介/,
    tags: { mode: 'inline', prefix: '#', limit: 10 },
    maxTitle: 20,
    waitMs: 300000,
  },
  {
    id: 'youtube',
    name: 'YouTube',
    confidence: 'draft',
    entry: 'https://studio.youtube.com',
    entryTemplate: 'https://studio.youtube.com/channel/{channelId}/videos/upload?d=ud',
    loginUrl: 'https://accounts.google.com/',
    loginMarkers: ['使用您的 Google 账号登录', 'Sign in', 'Email or phone'],
    loginUrlIncludes: 'studio.youtube.com',
    loggedInSelectors: ['ytcp-avatar', '#avatar-btn', 'ytcp-button'],
    uploadButtons: ['text=选择文件', 'text=Select file', 'text=上传视频', 'text=Upload videos'],
    titleSelectors: ['#textbox', 'ytcp-social-suggestions-textbox #textbox', 'div#textbox[contenteditable="true"]'],
    titlePlaceholder: null,
    descSelectors: ['#description-textarea #textbox', 'ytcp-textarea #textbox'],
    descPlaceholder: null,
    tags: { mode: 'chip', limit: 30, selector: '#tags-container input', openButtons: ['text=展开', 'text=显示更多', 'text=Show more'] },
    maxTitle: 100,
    waitMs: 600000,
  },
  {
    id: 'tiktok',
    name: 'TikTok',
    confidence: 'draft',
    entry: 'https://www.tiktok.com/tiktokstudio/upload?from=upload',
    loginUrl: 'https://www.tiktok.com/login',
    loginMarkers: ['使用二维码登录', '使用手机号', 'Log in', '登入'],
    loginUrlIncludes: 'tiktok.com',
    uploadButtons: ['text=选择文件', 'text=Select file', 'text=上传'],
    titleSelectors: ['div[contenteditable="true"]', '.public-DraftEditor-content', '[data-e2e="caption-input"]'],
    titlePlaceholder: null,
    descSelectors: [], // TikTok 标题与文案是同一个输入框
    descPlaceholder: null,
    tags: { mode: 'inline', prefix: '#', limit: 10 },
    maxTitle: 2200,
    waitMs: 300000,
    mergedTitleDesc: true,
  },
  {
    id: 'wechat',
    name: '微信视频号',
    confidence: 'draft',
    entry: 'https://channels.weixin.qq.com/platform/post/create',
    loginUrl: 'https://channels.weixin.qq.com/login.html',
    loginMarkers: ['扫码登录', '微信扫码登录', '登录视频号助手'],
    loginUrlIncludes: 'channels.weixin.qq.com',
    uploadButtons: ['text=添加视频', 'text=上传视频', 'text=发表视频'],
    titleSelectors: ['input[placeholder*="短标题"]', 'input[placeholder*="标题"]'],
    titlePlaceholder: /短标题|标题/,
    descSelectors: ['.input-editor', 'div[contenteditable="true"]'],
    descPlaceholder: /描述|添加描述/,
    tags: { mode: 'inline', prefix: '#', limit: 10 },
    maxTitle: 30,
    waitMs: 300000,
  },
];

function getPlatform(id) {
  const found = PLATFORMS.find((p) => p.id === id);
  if (!found) throw new Error(`未知平台：${id}（可用：${PLATFORMS.map((p) => p.id).join(', ')}）`);
  return found;
}

module.exports = { PLATFORMS, getPlatform };
