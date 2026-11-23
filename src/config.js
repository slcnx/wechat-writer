// 用户设置（API 地址 / Key / 模型 / 浏览器）与应用私有 CODEX_HOME 的生成。
// 应用使用独立 CODEX_HOME，不读写用户自己的 ~/.codex，API Key 只经环境变量传给 Codex。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileAtomic, readJsonSafe } from './fsutil.js';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const API_KEY_ENV = 'WX_WRITER_API_KEY';

export function dataDir() {
  return process.env.WX_WRITER_HOME || path.join(os.homedir(), '.wechat-writer');
}
export const paths = {
  settings: () => path.join(dataDir(), 'settings.json'),
  codexHome: () => path.join(dataDir(), 'codex-home'),
  articles: () => path.join(dataDir(), 'articles'),
  profile: () => path.join(dataDir(), 'browser-profile'),
};

export const DEFAULTS = Object.freeze({
  baseUrl: 'https://api.deepseek.com',
  apiKey: '',
  model: 'deepseek-flash',
  author: '',
  browser: process.platform === 'win32' ? 'msedge' : 'chrome',
  sandbox: 'workspace-write',
  browserMcp: false,
});

const BROWSERS = ['msedge', 'chrome', 'chromium'];
const SANDBOXES = ['read-only', 'workspace-write', 'danger-full-access'];

export function loadSettings() {
  return { ...DEFAULTS, ...readJsonSafe(paths.settings(), {}) };
}

/** 校验并合并设置；apiKey 传空字符串表示"保持不变"，传 null 表示清空。 */
export function mergeSettings(current, patch) {
  const next = { ...current };
  if (patch.baseUrl !== undefined) {
    const u = String(patch.baseUrl).trim().replace(/\/+$/, '');
    let parsed;
    try { parsed = new URL(u); } catch { throw new Error('API 地址不是合法 URL'); }
    if (!/^https?:$/.test(parsed.protocol)) throw new Error('API 地址必须是 http(s)');
    next.baseUrl = u;
  }
  if (patch.apiKey === null) next.apiKey = '';
  else if (typeof patch.apiKey === 'string' && patch.apiKey.trim()) next.apiKey = patch.apiKey.trim();
  if (patch.model !== undefined) {
    const m = String(patch.model).trim();
    if (!/^[\w.:/@-]{1,120}$/.test(m)) throw new Error('模型名不合法');
    next.model = m;
  }
  if (patch.author !== undefined) next.author = String(patch.author).trim().slice(0, 16);
  if (patch.browser !== undefined) {
    if (!BROWSERS.includes(patch.browser)) throw new Error(`浏览器只能是 ${BROWSERS.join('/')}`);
    next.browser = patch.browser;
  }
  if (patch.sandbox !== undefined) {
    if (!SANDBOXES.includes(patch.sandbox)) throw new Error('sandbox 取值不合法');
    next.sandbox = patch.sandbox;
  }
  if (patch.browserMcp !== undefined) next.browserMcp = Boolean(patch.browserMcp);
  return next;
}

export function saveSettings(patch) {
  const next = mergeSettings(loadSettings(), patch);
  writeFileAtomic(paths.settings(), JSON.stringify(next, null, 2), 0o600);
  return next;
}

/** 给前端看的设置：Key 只显示末 4 位。 */
export function publicSettings(s) {
  const { apiKey, ...rest } = s;
  return { ...rest, hasKey: Boolean(apiKey), apiKeyHint: apiKey ? `****${apiKey.slice(-4)}` : '' };
}

const toml = (v) => JSON.stringify(String(v)); // JSON 字符串转义与 TOML basic string 兼容

export function buildCodexConfig(s, platform = process.platform) {
  const lines = [
    '# 由公众号写作助手自动生成，修改请在应用「设置」里改',
    `model = ${toml(s.model)}`,
    'model_provider = "wxgateway"',
    'approval_policy = "never"',
    `sandbox_mode = ${toml(s.sandbox)}`,
    '',
    '[model_providers.wxgateway]',
    'name = "OpenAI-compatible gateway"',
    `base_url = ${toml(s.baseUrl)}`,
    `env_key = ${toml(API_KEY_ENV)}`,
    'wire_api = "responses"',
  ];
  if (platform === 'win32' && s.sandbox !== 'danger-full-access') {
    // Windows 默认沙箱需要管理员预配置，否则所有命令都被拦截；unelevated 用受限令牌，开箱即用
    lines.push('', '[windows]', 'sandbox = "unelevated"');
  }
  if (s.browserMcp) {
    lines.push('', '[mcp_servers.playwright]', 'command = "npx"',
      `args = ["-y", "@playwright/mcp@latest", "--browser", ${toml(s.browser)}, "--user-data-dir", ${toml(paths.profile())}]`);
  }
  return lines.join('\n') + '\n';
}

/** 写 config.toml 并把内置 skills 同步到 CODEX_HOME/skills。 */
export function prepareCodexHome(s) {
  const home = paths.codexHome();
  writeFileAtomic(path.join(home, 'config.toml'), buildCodexConfig(s));
  const src = path.join(APP_ROOT, 'skills');
  const dst = path.join(home, 'skills');
  for (const name of fs.readdirSync(src)) {
    fs.rmSync(path.join(dst, name), { recursive: true, force: true });
    fs.cpSync(path.join(src, name), path.join(dst, name), { recursive: true });
  }
  return home;
}

/** Codex 运行环境：便携包里没有全局 node，把应用自带的 node 放进 PATH 并告诉 skill 脚本。 */
export function codexEnv(s) {
  const nodeDir = path.dirname(process.execPath);
  const pathKey = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  return {
    ...process.env,
    [pathKey]: `${nodeDir}${path.delimiter}${process.env[pathKey] || ''}`,
    CODEX_HOME: paths.codexHome(),
    WX_WRITER_NODE: process.execPath,
    WX_WRITER_APP_ROOT: APP_ROOT,
    [API_KEY_ENV]: s.apiKey || 'sk-no-key',
  };
}
