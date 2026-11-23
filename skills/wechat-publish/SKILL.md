---
name: wechat-publish
description: 在已登录的微信公众号后台按用户指令操作图文编辑器：填稿（标题/作者/正文富文本/摘要/图片）、设置封面、改标题摘要、检查排版截图等。当任务提到公众号编辑器、填入公众号、封面、草稿时使用。绝不点击发表、群发或保存为草稿。
---

# 公众号编辑器操作 skill

浏览器由「公众号写作助手」打开并已扫码登录。你有两类工具：

- **browser 工具**（Playwright MCP，已连到这个浏览器）：`browser_tabs` 切换标签页、`browser_snapshot` 看页面结构、`browser_click` / `browser_hover` / `browser_type` 操作、`browser_evaluate` 读页面数据。**截图不会返回给你**（为兼容不支持图片的模型），验证一律用 `browser_snapshot` 或 `browser_evaluate` 读 DOM。
- **skill 脚本** `scripts/fill-mp.mjs`（绝对路径见任务说明）：处理点击做不好的事。用环境变量 `WX_WRITER_NODE` 指向的 node 运行（没有就用 `node`），Windows PowerShell 写 `& $env:WX_WRITER_NODE <脚本> --dir . ...`。最后一行输出 JSON。
  - `--dir .`：新开编辑器标签页，填标题/作者/摘要，素材图片先传公众号素材库再把正文以富文本粘贴进去。
  - `--dir . --upload images/img02.jpg`：把一张素材图传到公众号图片素材库，返回 `url` 和素材库里的文件名 `libraryName`。
  - `--dir . --dump dom-dump.json`：导出编辑器里可编辑元素的结构，用来修正选择器。
  - `--dir . --selectors fix.json`：用修正过的选择器填稿（只写要改的键）。

文章文件：`out/meta.json`（title、author、digest、cover、images）、`out/article.body.html`、`materials/images.json`（图N ↔ images/文件）。

## 标准流程

### A. 填稿（指令是"填进公众号""一键填入"等）

1. 确认 `out/meta.json` 有 title、`out/article.body.html` 非空，否则停止说明。
2. 运行 `fill-mp.mjs --dir .`。`ok:true` → 继续第 4 步。
3. 失败时最多修正 2 轮：
   - "没有已登录的公众号页面"/连不上 → 停止，提示用户在应用里重新「打开公众号后台」扫码。
   - "图片 images/…" 开头 → 图片上传失败，说明哪张、什么原因，不要擅自删图。
   - 其他 → `--dump` 导出结构；按 `box` 位置与 `chain` 祖先链判断标题（上方、矮）和正文（下方、高）。两者常都是 `.ProseMirror`，**必须用容器区分**（当前为 `#js_title_main .ProseMirror` 与 `#ueditor_0 .ProseMirror`），写 `fix.json` 后带 `--selectors` 重跑。
4. 如果 meta.json 有 `cover`，接着做 B。

### B. 设置封面（指令如"图3做封面"，或填稿后 meta.cover 有值）

1. 由 `materials/images.json` 找到图N 的 `src`，运行 `--upload <src>`，记下 `libraryName`。
2. `browser_tabs` 选中最新的编辑器标签页（URL 含 `appmsg_edit`）。
3. 滚到「封面和摘要」区：悬停 `#js_cover_area .js_cover_btn_area`（显示"拖拽或选择封面"或已有封面），在弹出菜单点 **「从图片库选择」**（`#js_cover_null a.js_imagedialog`；已有封面时菜单里也有同名项）。
4. 弹窗「最近使用 / 我的图片」里按文件名找到 `libraryName` 那一张（最新上传的在最前），点击选中，点 **「下一步」**。
5. 裁剪页「编辑封面」（2.35:1 消息列表 / 1:1 转发卡片）保持默认裁剪，点 **「确认」**（有的版本叫「完成」）。
6. 验证：`browser_evaluate` 读 `document.querySelector('#js_cover_area [style*="background-image"]')?.getAttribute('style')`，含 `mmbiz` 地址即成功（无障碍快照里"拖拽或选择封面"文字可能不更新，不要以它为准）。

### C. 改标题 / 作者 / 摘要 / 正文小改

在当前编辑器标签页用 browser 工具改：标题 `#js_title_main .ProseMirror`，作者 `#author`，摘要 `#js_description`，正文 `#ueditor_0 .ProseMirror`。改正文前先 snapshot 定位到具体段落，只改指令涉及的部分。**同时把改动同步写回 `out/` 下对应文件**，保持应用里的预览一致。

### D. 检查排版

用 `browser_evaluate` 读编辑器状态汇报：标题文字、正文字数、小标题数、图片数及每张 src 是否为 `mmbiz`、封面是否已设、摘要内容；发现问题（图片未上传、样式丢失、标题过长等）用文字说明。用户要截图时可调用 `browser_take_screenshot`（文件会保存，但你看不到画面）。

### E. 其他指令

先 `browser_snapshot` 看清页面，再按最小步骤完成；不确定的操作先截图说明、不要乱点。

## 汇报

用 2~4 行中文说明做了什么、结果如何；若用了 `fix.json` 修正选择器，把内容贴出来便于维护者更新内置选择器。

## 红线

- **绝不点击「发表」「群发」「保存为草稿」「预览发送到手机」**，也不要用任何方式触发；这些由用户本人确认。
- 不读取、不输出 Cookie、token、ticket 等账号信息；不修改公众号设置；不访问 mp.weixin.qq.com 以外的网站。
- 不删除素材库里的图片，不关闭用户的其他标签页。
