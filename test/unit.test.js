import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.WX_WRITER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'wxw-'));
const cfg = await import('../src/config.js');
const art = await import('../src/article.js');
const jobs = await import('../src/jobs.js');
const pub = await import('../src/publisher.js');

test('mergeSettings 校验与 Key 处理', () => {
  const s = cfg.mergeSettings(cfg.DEFAULTS, { baseUrl: 'http://10.0.0.1:8317/v1/', apiKey: 'sk-abc123' });
  assert.equal(s.baseUrl, 'http://10.0.0.1:8317/v1');
  assert.equal(s.apiKey, 'sk-abc123');
  assert.equal(cfg.mergeSettings(s, { apiKey: '' }).apiKey, 'sk-abc123', '空串保持不变');
  assert.equal(cfg.mergeSettings(s, { apiKey: null }).apiKey, '', 'null 清空');
  assert.throws(() => cfg.mergeSettings(s, { baseUrl: 'ftp://x' }));
  assert.throws(() => cfg.mergeSettings(s, { model: 'a b' }));
  assert.throws(() => cfg.mergeSettings(s, { browser: 'firefox' }));
  assert.deepEqual(cfg.publicSettings(s).apiKeyHint, '****c123');
  assert.equal('apiKey' in cfg.publicSettings(s), false);
});

test('Codex 配置不含 Key，Windows 路径正确转义', () => {
  const s = cfg.mergeSettings(cfg.DEFAULTS, { apiKey: 'sk-secret' });
  const t = cfg.buildCodexConfig(s);
  assert.match(t, /wire_api = "responses"/);
  assert.match(t, /env_key = "WX_WRITER_API_KEY"/);
  assert.doesNotMatch(t, /sk-secret/);
  assert.equal(JSON.parse('"C:\\\\Users\\\\a"'), 'C:\\Users\\a');
});

test('Windows 上自动启用 unelevated 沙箱', () => {
  assert.match(cfg.buildCodexConfig(cfg.DEFAULTS, 'win32'), /\[windows\]\nsandbox = "unelevated"/);
  assert.doesNotMatch(cfg.buildCodexConfig(cfg.DEFAULTS, 'darwin'), /\[windows\]/);
  assert.doesNotMatch(cfg.buildCodexConfig({ ...cfg.DEFAULTS, sandbox: 'danger-full-access' }, 'win32'), /\[windows\]/);
});

test('prepareCodexHome 同步内置 skills', () => {
  const home = cfg.prepareCodexHome(cfg.DEFAULTS);
  assert.ok(fs.existsSync(path.join(home, 'skills', 'wechat-article', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(home, 'skills', 'wechat-article', 'references', 'style.md')));
  assert.ok(fs.existsSync(path.join(home, 'config.toml')));
});

test('sanitizeBody 去掉脚本/样式/事件', () => {
  const dirty = '<html><head><style>p{}</style></head><body><p onclick="x()">hi</p><script>alert(1)</script><link rel=x><a href="javascript:alert(1)">a</a></body></html>';
  const clean = art.sanitizeBody(dirty);
  assert.equal(clean, '<p>hi</p><a href="#">a</a>');
});

test('validateArticle 规则', () => {
  const long = `<p style="x">${'字'.repeat(300)}</p>`;
  assert.equal(art.validateArticle({ title: '好标题' }, long).ok, true);
  const bad = art.validateArticle({ title: '超'.repeat(65) }, '<p>短</p>');
  assert.equal(bad.ok, false);
  assert.equal(bad.problems.length, 2);
  const w = art.validateArticle({ title: 't' }, `${long}<p class="a">x</p>`);
  assert.equal(w.ok, true);
  assert.equal(w.warnings.length, 1);
});

test('previewPage 转义标题', () => {
  const html = art.previewPage({ title: '<b>x</b>' }, '<p>正文</p>');
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
  assert.match(html, /<div id="js_content"><p>正文<\/p><\/div>/);
});

test('文章 id 防穿越', () => {
  assert.equal(jobs.isValidId('../../etc'), false);
  assert.throws(() => jobs.jobDir('..'));
});

test('tokenFromUrl', () => {
  assert.equal(pub.tokenFromUrl('https://mp.weixin.qq.com/cgi-bin/home?t=home/index&lang=zh_CN&token=123456'), '123456');
  assert.equal(pub.tokenFromUrl('https://mp.weixin.qq.com/'), null);
});

test('readDevToolsPort 与填稿 prompt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxw-prof-'));
  assert.equal(pub.readDevToolsPort(dir), null);
  fs.writeFileSync(path.join(dir, 'DevToolsActivePort'), '54321\n/devtools/browser/abc\n');
  assert.equal(pub.readDevToolsPort(dir), 54321);
  assert.match(pub.buildPublishPrompt('/x/fill-mp.mjs'), /wechat-publish skill[\s\S]*\/x\/fill-mp\.mjs[\s\S]*严禁点击发表[\s\S]*用户指令：把这篇文章填进/);
  assert.match(pub.buildPublishPrompt('/x', '把图3设为封面'), /用户指令：把图3设为封面/);
  const a = pub.browserMcpArgs('http://127.0.0.1:5555');
  assert.ok(a.includes('mcp_servers.browser.default_tools_approval_mode="approve"'));
  assert.ok(a.some((x) => x.includes('--cdp-endpoint') && x.includes('http://127.0.0.1:5555') && x.includes('@playwright')));
});

test('codexEnv 暴露 node 与应用目录给 skill 脚本，不含明文 Key 以外的东西', () => {
  const env = cfg.codexEnv({ ...cfg.DEFAULTS, apiKey: 'sk-1' });
  assert.equal(env.WX_WRITER_NODE, process.execPath);
  assert.equal(env.WX_WRITER_API_KEY, 'sk-1');
  const pk = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  assert.ok(env[pk].startsWith(path.dirname(process.execPath)));
});

test('finalReply 取 Codex 最后一条回复', () => {
  const lines = ['codex', '中间过程', 'mcp: browser/browser_click started', 'codex', '**完成情况**', '- 已填入标题', 'tokens used', '42,914', '重复输出'];
  assert.equal(pub.finalReply(lines), '完成情况 - 已填入标题');
  assert.equal(pub.finalReply(['无']), '');
});
