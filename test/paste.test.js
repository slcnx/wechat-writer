// 用本机 Chrome/Edge 验证 wechat-publish skill 的填稿脚本。模拟页按 2026-11 实测的公众号新版编辑器结构搭建：
// 标题和正文都是 contenteditable（ProseMirror），标题在 #js_title_main、正文在 #ueditor_0（div）。
// 没有可用浏览器时跳过：WX_TEST_BROWSER=msedge|chrome 可指定。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { chromium } from 'playwright-core';
import { fillEditor, loadSelectors } from '../skills/wechat-publish/scripts/fill-mp.mjs';

const MOCK = `<!DOCTYPE html><html><body>
<div id="js_title_main"><div class="title-editor__input"><div class="ProseMirror" contenteditable="true"><p><br></p></div></div></div>
<div id="js_author_area"><input id="author" placeholder="请输入作者"></div>
<div id="ueditor_0" class="mock-iframe"><div class="mock-iframe-body">
  <div class="ProseMirror rich_media_content" contenteditable="true" style="min-height:200px"><p><br></p></div>
</div></div>
<textarea id="js_description"></textarea>
</body></html>`;

test('fillEditor 按新版编辑器结构把标题/作者/正文/摘要各自填对', async (t) => {
  const channel = process.env.WX_TEST_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome');
  let browser;
  try { browser = await chromium.launch({ channel, headless: true }); } catch {
    t.skip(`没有可用的 ${channel}`);
    return;
  }
  const server = http.createServer((_, res) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(MOCK); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const page = await (await browser.newContext()).newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const html = '<section style="font-size:16px"><h2 style="color:#07c160">一、小标题</h2><p>这是<strong style="color:#07c160">加粗</strong>的正文，足够长足够长足够长足够长足够长足够长足够长足够长足够长足够长。</p></section>';
    const plain = '一、小标题 这是加粗的正文，足够长足够长足够长足够长足够长足够长足够长足够长足够长足够长。';
    const filled = await fillEditor(page, loadSelectors(), { title: '测试标题', author: '吃在天府', digest: '一句话摘要', html, plain });
    assert.deepEqual(filled.map((f) => f.replace(/\(.*\)/, '')), ['标题', '作者', '正文', '摘要']);
    assert.equal((await page.locator('#js_title_main .ProseMirror').innerText()).trim(), '测试标题');
    assert.equal(await page.locator('#author').inputValue(), '吃在天府');
    assert.equal(await page.locator('#js_description').inputValue(), '一句话摘要');
    const body = await page.locator('#ueditor_0 .ProseMirror').innerHTML();
    assert.match(body, /<strong[^>]*>加粗<\/strong>/);
    assert.match(body, /一、小标题/);
  } finally {
    await browser.close();
    server.close();
  }
});
