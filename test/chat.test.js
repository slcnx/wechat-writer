import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildTurnPrompt, wantsBrowser, ROLE } from '../src/chat.js';
import { codexArgs, SESSION_RE } from '../src/codex.js';
import { DEFAULTS } from '../src/config.js';

test('是否需要浏览器：按用户的话判断', () => {
  for (const t of ['填进公众号', '把图3设为封面', '存到草稿', '打开公众号后台']) assert.ok(wantsBrowser(t), t);
  for (const t of ['写一篇成都美食', '写一篇 600 字的公众号文章', '改一下这篇草稿', '图2放开头', '标题短一点']) assert.ok(!wantsBrowser(t), t);
});

test('首轮带角色说明（含信息不足先追问），续聊只带本轮内容', () => {
  const first = buildTurnPrompt({ first: true, message: '写钟水饺', added: ['图1（images/img01.png）'], imagesText: '图片素材…', browser: false, script: '/s.mjs' });
  assert.ok(first.startsWith(ROLE));
  assert.match(first, /先用一两句话向用户提问/);
  assert.match(first, /用户：写钟水饺/);
  assert.match(first, /本轮新增素材：图1/);
  assert.match(first, /浏览器：未打开/);
  const next = buildTurnPrompt({ first: false, message: '填进公众号', added: [], imagesText: '', browser: true, script: '/s.mjs' });
  assert.ok(!next.includes(ROLE));
  assert.match(next, /继续同一篇文章/);
  assert.match(next, /浏览器：已登录[\s\S]*\/s\.mjs[\s\S]*严禁点击发表/);
  assert.match(buildTurnPrompt({ first: false, message: '', added: ['materials/01-a.docx.txt'], imagesText: '', browser: false }), /用户只上传了素材/);
});

test('codex 参数：首轮 exec 新会话，续聊 exec resume 同一会话', () => {
  const s = { ...DEFAULTS };
  const a = codexArgs({ cwd: '/w', settings: s, extraArgs: ['-i', 'x.png'], lastMessageFile: '/w/out/.last.txt' });
  assert.deepEqual(a.slice(0, 1), ['exec']);
  assert.ok(a.includes('-C') && a.includes('/w') && a.includes('-o') && a.at(-1) === '-');
  const r = codexArgs({ cwd: '/w', settings: s, resumeId: '01a20787-761e-70d0-a616-ae7bbaae9952', lastMessageFile: '/w/o.txt' });
  assert.deepEqual(r.slice(0, 2), ['exec', 'resume']);
  assert.ok(!r.includes('-C') && !r.includes('-s'));
  assert.ok(r.includes('sandbox_mode="workspace-write"'));
  assert.deepEqual(r.slice(-2), ['01a20787-761e-70d0-a616-ae7bbaae9952', '-']);
  assert.equal(SESSION_RE.exec('session id: 01a20787-761e-70d0-a616-ae7bbaae9952')[1], '01a20787-761e-70d0-a616-ae7bbaae9952');
});

test('插话轮次的 prompt 提示 AI 接着做、不要重做', () => {
  const p = buildTurnPrompt({ first: false, message: '标题改短点', added: [], imagesText: '', browser: false, interrupted: true });
  assert.match(p, /被用户插话打断/);
  assert.match(p, /用户：标题改短点/);
  assert.doesNotMatch(buildTurnPrompt({ first: false, message: 'x', added: [], imagesText: '', browser: false }), /打断/);
});
