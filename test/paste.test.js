// 用本机 Chrome/Edge 验证"富文本粘贴进编辑器"的机制（模拟编辑器，不访问微信）。
// 没有可用浏览器时跳过：WX_TEST_BROWSER=msedge|chrome 可指定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { pasteHtml } from '../src/publisher.js';

const MOCK = `<!DOCTYPE html><html><body>
<textarea id="title"></textarea>
<div class="ProseMirror" contenteditable="true" style="min-height:200px"><p><br></p></div>
</body></html>`;

test('pasteHtml 把富文本粘贴进 contenteditable 编辑器', async (t) => {
  const channel = process.env.WX_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome');
  let browser;
  try { browser = await chromium.launch({ channel, headless: true }); } catch {
    t.skip(`没有可用的 ${channel}`);
    return;
  }
  const server = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html' }); res.end(MOCK); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const html = '<section style="font-size:16px"><h2 style="color:#07c160">一、小标题</h2><p>这是<strong style="color:#07c160">加粗</strong>的正文，足够长足够长足够长足够长足够长足够长足够长足够长足够长足够长。</p></section>';
    const how = await pasteHtml(page, '.ProseMirror', html, '一、小标题 这是加粗的正文，足够长足够长足够长足够长足够长足够长足够长足够长足够长足够长。');
    const inner = await page.locator('.ProseMirror').innerHTML();
    assert.ok(['clipboard', 'synthetic'].includes(how));
    assert.match(inner, /<strong[^>]*>加粗<\/strong>/);
    assert.match(inner, /一、小标题/);
  } finally {
    await browser.close();
    server.close();
  }
});
