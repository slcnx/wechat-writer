// 浏览器管道：打开本机 Edge/Chrome（独立用户目录，保存扫码登录态）、等待扫码登录、
// 提供 CDP 地址给 Codex 的浏览器工具（Playwright MCP）。具体怎么操作公众号后台由
// Codex 按 wechat-publish skill 自己完成；「保存为草稿 / 发表」由用户本人点击。
import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { paths, APP_ROOT } from './config.js';

const MP_HOME = 'https://mp.weixin.qq.com/';
const LOGIN_TIMEOUT = 5 * 60 * 1000;

let ctx = null;

async function context(settings) {
  if (ctx) return ctx;
  const profile = paths.profile();
  fs.rmSync(path.join(profile, 'DevToolsActivePort'), { force: true });
  ctx = await chromium.launchPersistentContext(profile, {
    channel: settings.browser === 'chromium' ? undefined : settings.browser,
    headless: false,
    viewport: null,
    // 随机端口、仅本机：供 Codex 的浏览器工具与 skill 脚本连接同一个已登录浏览器
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

export function tokenFromUrl(url) {
  const m = /[?&]token=(\d+)/.exec(String(url));
  return m ? m[1] : null;
}

const loggedIn = () => Boolean(ctx && ctx.pages().some((p) => tokenFromUrl(p.url())));

/** 浏览器已打开且已登录公众号后台。 */
export function browserReady() { return loggedIn(); }

/** 打开浏览器到公众号后台并等待扫码登录（最多 5 分钟），返回 CDP 地址。onStatus 用来提示用户扫码。 */
export async function ensureBrowser(settings, onStatus = () => {}) {
  const c = await context(settings);
  if (!loggedIn()) {
    const page = c.pages().find((p) => p.url().includes('mp.weixin.qq.com')) || c.pages()[0] || (await c.newPage());
    if (!page.url().includes('mp.weixin.qq.com')) await page.goto(MP_HOME);
    await page.bringToFront();
    if (!loggedIn()) onStatus('请在弹出的浏览器窗口里用公众号管理员微信扫码登录（5 分钟内）');
    const deadline = Date.now() + LOGIN_TIMEOUT;
    while (!loggedIn()) {
      if (Date.now() > deadline) throw new Error('5 分钟内未检测到公众号登录');
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return cdpEndpoint();
}

const toml = (v) => JSON.stringify(String(v));
/** 本次运行接上浏览器工具：Playwright MCP 连本机这个浏览器，工具调用免审批（仅限此次运行）。 */
export function browserMcpArgs(endpoint) {
  const cli = path.join(APP_ROOT, 'node_modules', '@playwright', 'mcp', 'cli.js');
  return [
    // 不把截图等图片回传给模型：很多 OpenAI 兼容网关/模型不接受图片，会让整次会话报错
    '-c', `mcp_servers.browser.command=${toml(process.execPath)}`,
    '-c', `mcp_servers.browser.args=[${[cli, '--cdp-endpoint', endpoint, '--image-responses', 'omit'].map(toml).join(', ')}]`,
    '-c', 'mcp_servers.browser.default_tools_approval_mode="approve"',
    '-c', 'mcp_servers.browser.startup_timeout_sec=60',
    // 填稿脚本需要连本机调试端口
    '-c', 'sandbox_workspace_write.network_access=true',
  ];
}

export async function closeBrowser() {
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
}
