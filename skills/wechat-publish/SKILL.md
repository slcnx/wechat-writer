---
name: wechat-publish
description: 把当前文章目录 out/ 下的成稿（标题、作者、正文富文本、摘要）填进微信公众号后台的新建图文编辑器，填错会自己诊断页面结构并修正。当任务提到"填入公众号""发到公众号草稿""公众号编辑器"时使用。绝不点击发表或群发。
---

# 公众号填稿 skill

把 `out/meta.json` 与 `out/article.body.html` 填进公众号后台编辑器。浏览器由「公众号写作助手」打开并已扫码登录，连接地址在当前目录的 `cdp.json`。

## 工具

本 skill 自带脚本 `scripts/fill-mp.mjs`（与本文件同目录下的 scripts/）。用环境变量 `WX_WRITER_NODE` 指向的 node 运行；它没有时用 `node`。

- 填稿：`"$WX_WRITER_NODE" <skill目录>/scripts/fill-mp.mjs --dir . [--selectors <修正后的选择器.json>]`
- 诊断：`"$WX_WRITER_NODE" <skill目录>/scripts/fill-mp.mjs --dir . --dump dom-dump.json`

Windows PowerShell 写法：`& $env:WX_WRITER_NODE <skill目录>\scripts\fill-mp.mjs --dir .`

脚本最后一行输出 JSON：`{"ok":true,"filled":["标题","作者","正文(clipboard)","摘要"]}` 或 `{"ok":false,"error":"..."}`。每次运行都会新开一个编辑器标签页。

## 工作流程

1. **检查成稿**：`out/meta.json` 有 title，`out/article.body.html` 非空。缺了就停止并说明，不要自己编内容。
2. **直接填稿**：运行填稿命令。`ok:true` → 跳到第 5 步。
3. **失败则诊断**（最多 2 轮）：
   - 错误是"没有已登录的公众号页面"或连不上 cdp → 停止，告诉用户先在应用里点「打开公众号后台」扫码登录。
   - 其他错误 → 运行诊断命令，读 `dom-dump.json`：`editables` 是页面上所有可见可编辑元素（含 `placeholder`、`box` 位置、`chain` 祖先链），`hints` 是"标题/作者/正文/摘要"的提示文字及其位置。
   - 根据位置和祖先链判断哪个是标题、哪个是正文（标题在上、单行、较矮；正文在下、高度大；两者常常都是 `.ProseMirror`，**必须用祖先容器 id/class 区分**，如 `#js_title_main .ProseMirror` 与 `#ueditor_0 .ProseMirror`）。
   - 写 `selectors.fix.json`，只写需要改的键，值是按优先级排列的 CSS 选择器数组，例如 `{"title":["#新标题容器 .ProseMirror"],"body":["#新正文容器 .ProseMirror"]}`，然后带 `--selectors selectors.fix.json` 重跑填稿命令。
4. 2 轮仍失败 → 停止，说明原因，并告诉用户可以在应用预览区点「复制富文本」手动粘贴。
5. **汇报**：用一两句话说明填了哪些项、是否用了修正后的选择器；如果用了，把 `selectors.fix.json` 的内容贴出来，方便维护者更新内置选择器。

## 红线

- **绝不点击「发表」「群发」「保存为草稿」**，也不要用任何方式触发它们；这些由用户本人在浏览器里确认。
- 不读取、不输出 Cookie、token 等账号信息；不修改公众号设置；不访问 mp.weixin.qq.com 以外的网站。
- 只用本 skill 的脚本操作浏览器，不要另写脚本去点击页面按钮。
