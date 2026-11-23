---
name: wechat-publish
description: 用浏览器（Playwright MCP）把 out/ 下已生成的公众号文章填进 mp.weixin.qq.com 的图文编辑器并保存草稿。仅在用户在 Codex 交互模式里明确要求"发到公众号/存草稿"且已启用浏览器 MCP 时使用。
---

# 公众号发布 skill（Codex 交互模式用）

> 应用界面里的「一键填入公众号草稿」按钮走的是内置脚本，不需要本 skill。
> 本 skill 给在终端里直接运行 `codex` 的高级用户使用，需要在应用设置里开启「浏览器 MCP」。

## 前置检查

1. `out/article.body.html` 与 `out/meta.json` 存在，且 article.body.html 不含 `<style>`/`<script>`/`class=`。不满足就先用 wechat-article skill 修好。
2. 浏览器 MCP（playwright）可用；不可用时告诉用户去设置里开启，然后停止。

## 步骤

1. `browser_navigate` 打开 `https://mp.weixin.qq.com/`。
2. 如果页面出现二维码：告诉用户"请用微信扫码登录"，然后每隔几秒 `browser_snapshot`，直到 URL 里出现 `token=`（最多等 5 分钟）。
3. 从 URL 取出 token，打开
   `https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&createType=0&token=<token>&lang=zh_CN`
   （找不到编辑器时把 `type=77` 换成 `type=10` 再试）。
4. 填标题（`#title` 或 placeholder 含"标题"的输入框）、作者（`#author`）。
5. 正文：用 `browser_evaluate` 在编辑区（`.ProseMirror` 或 `[contenteditable=true]`）上派发带 `text/html` 的 paste 事件，内容为 article.body.html；再 `browser_snapshot` 确认正文已出现。
6. 填摘要（`#js_description`）。
7. 点击「保存为草稿」，截图给用户确认。

## 红线

- **绝不点击「发表」「群发」**，发表必须由用户本人在浏览器里确认操作。
- 不读取、不输出 Cookie 和 token 以外的账号信息；不修改公众号的任何设置。
- 页面结构和上面描述不一致时，停下来截图说明，不要乱点。
