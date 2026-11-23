// 浏览器与指令：应用负责打开本机 Edge/Chrome（独立用户目录，保存扫码登录态）并等待登录；
// 之后用户的指令（填稿、设封面、改标题……）交给 Codex：wechat-publish skill 给标准流程，
// Codex 通过 Playwright MCP（CDP 连这个浏览器）自己操作。最终「保存为草稿 / 发表」由用户本人点击。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { paths, APP_ROOT } from './config.js';
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

export const FILL_INSTRUCTION = '把这篇文章填进公众号编辑器（新建图文），并按 meta.json 的 cover 设置封面';

export function buildPublishPrompt(scriptPath, instruction = FILL_INSTRUCTION) {
  return [
    '使用 wechat-publish skill，在已登录的公众号后台按用户指令操作。',
    `skill 自带脚本的绝对路径：${scriptPath}`,
    '浏览器连接信息在当前目录 cdp.json；浏览器操作用 browser 工具（已连到同一个浏览器）。',
    '严禁点击发表、群发或保存为草稿。',
    `用户指令：${instruction}`,
  ].join('\n');
}

const toml = (v) => JSON.stringify(String(v));
/** 本次运行接上浏览器工具：Playwright MCP 连本机这个浏览器，工具调用免审批（仅限此次运行）。 */
export function browserMcpArgs(endpoint) {
  const cli = path.join(APP_ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');
  return [
    '-c', `mcp_servers.browser.command=${toml(process.execPath)}`,
    // 不把截图等图片回传给模型：很多 OpenAI 兼容网关/模型不接受图片，会让整次会话报错
    '-c', `mcp_servers.browser.args=[${[cli, '--cdp-endpoint', endpoint, '--image-responses', 'omit'].map(toml).join(', ')}]`,
    '-c', 'mcp_servers.browser.default_tools_approval_mode="approve"',
    '-c', 'mcp_servers.browser.startup_timeout_sec=60',
  ];
}

/** 取 Codex 最后一条回复（日志里最后一个 "codex" 行之后、"tokens used" 之前）。 */
export function finalReply(lines) {
  const i = lines.lastIndexOf('codex');
  if (i < 0) return '';
  const rest = lines.slice(i + 1);
  const end = rest.findIndex((l) => l.startsWith('tokens used'));
  return (end < 0 ? rest : rest.slice(0, end)).join(' ').replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

/** 浏览器指令：打开浏览器 → 等扫码登录 → 交给 Codex 按 wechat-publish skill 执行（默认指令是填稿）。 */
export async function fillDraft({ id, dir, instruction }, settings) {
  state.log = [];
  setState('opening', '正在启动浏览器…', id);
  try {
    const page = await openMp(settings);
    if (!tokenFromUrl(page.url())) setState('login', '请在弹出的浏览器里用微信扫码登录公众号后台（5 分钟内）', id);
    await waitLogin(page);
    writeFileAtomic(path.join(dir, 'cdp.json'), JSON.stringify({ endpoint: await cdpEndpoint(), articleId: id }));
    const endpoint = await cdpEndpoint();
    setState('editing', `已登录，AI 正在执行：${instruction || '填入公众号编辑器'}…`, id);
    const script = path.join(paths.codexHome(), 'skills', 'wechat-publish', 'scripts', 'fill-mp.mjs');
    const run = runCodex({
      cwd: dir,
      prompt: buildPublishPrompt(script, instruction || FILL_INSTRUCTION),
      settings,
      // 填稿需要连本机浏览器调试端口，单独为这次运行打开网络
      extraArgs: ['-c', 'sandbox_workspace_write.network_access=true', '--disable', 'view_image', ...browserMcpArgs(endpoint)],
      onLog: (l) => { state.log.push(l); if (state.log.length > MAX_LOG) state.log.shift(); },
      timeoutMs: 12 * 60 * 1000,
    });
    const code = await run.done;
    const summary = finalReply(state.log);
    if (code === 0) {
      setState('ready', `AI 已执行完毕：${summary.slice(0, 300) || '见下方日志'} —— 请在浏览器里检查，然后自己点「保存为草稿」或「发表」。`, id);
    } else {
      setState('error', `AI 执行未成功（看下方日志）。填稿失败时可在预览区点「复制富文本」手动粘贴。${summary ? ` ${summary.slice(0, 300)}` : ''}`, id);
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
