# 公众号写作助手 wechat-writer

和 AI 聊天写公众号：给素材（文字 / 图片 / Word / PDF）→ AI 写稿配图选封面 → 手机效果预览 → 说一句"填进公众号"，AI 自己操作公众号后台填好（发表由你本人确认）。

![界面](docs/images/05-written.png)

- 开源 [Codex CLI](https://github.com/openai/codex) 作为写作智能体，内置公众号写作 skill
- 默认接 [DeepSeek 官方 API](https://platform.deepseek.com)（`deepseek-flash` / `deepseek-v4-pro`），也支持任何 Responses API 兼容地址
- Windows / macOS / Linux（x64 / ARM64）免安装便携包，自带 Node 运行时与 Codex，解压即用

**使用**：到 [Releases](https://github.com/slcnx/wechat-writer/releases/latest) 下载对应平台的包，看 [图文教程](docs/教程.md)。
**开发 / 构建 / 发布**：看 [docs/开发与部署.md](docs/开发与部署.md)。
