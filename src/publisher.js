// 浏览器与填稿：应用负责打开本机 Edge/Chrome（独立用户目录，保存扫码登录态）并等待登录；
// 填稿交给 Codex + wechat-publish skill（通过 CDP 连接这个浏览器，失败时自行诊断修正）。
// 最终「保存为草稿 / 发表」由用户本人点击。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { paths } from './config.js';
import { runCodex } from './codex.js';
import { writeFileAtomic } from './fsutil.js';

const MP_HOME = 'https://mp.weixin.qq.com/';
const LOGIN_TIMEOUT = 5 * 60 * 1000;
const MAX_LOG = 300;

let ctx = null;
export const state = { phase: 'idle', message: '', articleId: null, updatedAt: 0, log: [] };
function setState(phase, message, articleId = state.articleId) {
  Object.assign(state, { phase, message, articleId, updatedAt: Date.now() });
}

async function context(settings) {
  if (ctx) return ctx;
  const profile = paths.profile();
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  ctx = await chromium.launchPersistentContext(profile, {
    channel: settings.browser === 'chromium' ? undefined : settings.browser,
    headless: false,
    viewport: null,
    // 随机端口、仅本机：供 wechat-publish skill 的脚本连接同一个已登录浏览器
    args: ['--start-maximized', '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1'],
  });
  ctx.on('close', () => { ctx = null; });
  return ctx;
}

/** Chromium 把实际调试端口写在用户目录的 DevToolsActivePort 第一行。 */
export function readDevToolsPort(profileDir) {
  try {
    const port = Number(fs.readFileSync(path.join(profileDir, 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0]);
    return Number.isInteger(port) && port > 0 ? port : null;
  } catch { return null; }
}

async function cdpEndpoint() {
  for (let i = 0; i < 20; i++) {
    const port = readDevToolsPort(paths.profile());
    if (port) return `http://127.0.0.1:${port}`;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('浏览器没有开启调试端口，请关闭应用打开的浏览器后重试');
}

export async function openMp(settings) {
  const c = await context(settings);
  const page = c.pages().find((p) => p.url().includes('mp.weixin.qq.com')) || c.pages()[0] || (await c.newPage());
  if (!page.url().includes('mp.weixin.qq.com')) await page.goto(MP_HOME);
  await page.bringToFront();
  return page;
}

export function tokenFromUrl(url) {
  const m = /[?&]token=(\d+)/.exec(String(url));
  return m ? m[1] : null;
}

async function waitLogin(page) {
  const deadline = Date.now() + LOGIN_TIMEOUT;
  while (Date.now() < deadline) {
    for (const p of page.context().pages()) {
      const t = tokenFromUrl(p.url());
      if (t) return t;
    }
    await page.waitForTimeout(1500);
  }
  throw new Error('5 分钟内未检测到登录，请扫码后重试');
}

export function buildPublishPrompt(scriptPath) {
  return [
    '使用 wechat-publish skill，把当前目录 out/ 下的成稿填进公众号后台编辑器。',
    `填稿脚本的绝对路径：${scriptPath}`,
    '浏览器连接信息在当前目录 cdp.json。严禁点击发表、群发或保存为草稿。',
  ].join('\n');
}

/** 一键填稿：打开浏览器 → 等扫码登录 → 交给 Codex 按 wechat-publish skill 填写。 */
export async function fillDraft({ id, dir }, settings) {
  state.log = [];
  setState('opening', '正在启动浏览器…', id);
  try {
    const page = await openMp(settings);
    if (!tokenFromUrl(page.url())) setState('login', '请在弹出的浏览器里用微信扫码登录公众号后台（5 分钟内）', id);
    await waitLogin(page);
    writeFileAtomic(path.join(dir, 'cdp.json'), JSON.stringify({ endpoint: await cdpEndpoint() }));
    setState('editing', '已登录，AI 正在按 wechat-publish skill 填写公众号编辑器…', id);
    const script = path.join(paths.codexHome(), 'skills', 'wechat-publish', 'scripts', 'fill-mp.mjs');
    const run = runCodex({
      cwd: dir,
      prompt: buildPublishPrompt(script),
      settings,
      // 填稿需要连本机浏览器调试端口，单独为这次运行打开网络
      extraArgs: ['-c', 'sandbox_workspace_write.network_access=true'],
      onLog: (l) => { state.log.push(l); if (state.log.length > MAX_LOG) state.log.shift(); },
      timeoutMs: 8 * 60 * 1000,
    });
    const code = await run.done;
    const last = [...state.log].reverse().find((l) => /"ok":\s*(true|false)/.test(l)) || '';
    if (code === 0 && /"ok":\s*true/.test(last)) {
      setState('ready', '已填入公众号编辑器。请在浏览器里检查排版、设置封面，然后自己点「保存为草稿」或「发表」。', id);
    } else {
      setState('error', `AI 填稿未成功（看下方日志）。可在预览区点「复制富文本」手动粘贴。${last ? ` 最后结果：${last.slice(0, 200)}` : ''}`, id);
    }
  } catch (e) {
    setState('error', e.message, id);
  } finally {
    fs.rmSync(path.join(dir, 'cdp.json'), { force: true });
  }
  return { ...state };
}

export async function closeBrowser() {
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
}
