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
  visionModel: '',
  modelPinned: false, // 用户在设置页手动选过并保存后为 true，之后不再自动推荐
  author: '',
  browser: process.platform === 'win32' ? 'msedge' : 'chrome',
  sandbox: 'workspace-write',
  imageApiBase: '', // 生图接口（OpenAI 兼容 /v1/images/generations，如 Muse），可空
  imageApiKey: '',
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
  if (patch.visionModel !== undefined) {
    const v = String(patch.visionModel).trim();
    if (v && !/^[\w.:/@-]{1,120}$/.test(v)) throw new Error('看图模型名不合法');
    next.visionModel = v;
  }
  if (patch.modelPinned !== undefined) next.modelPinned = Boolean(patch.modelPinned);
  if (patch.author !== undefined) next.author = String(patch.author).trim().slice(0, 16);
  if (patch.browser !== undefined) {
    if (!BROWSERS.includes(patch.browser)) throw new Error(`浏览器只能是 ${BROWSERS.join('/')}`);
    next.browser = patch.browser;
  }
  if (patch.imageApiBase !== undefined) {
    const u = String(patch.imageApiBase).trim().replace(/\/+$/, '');
    if (u) { let ok = false; try { ok = /^https?:$/.test(new URL(u).protocol); } catch { /* 下面报错 */ } if (!ok) throw new Error('生图接口地址不是合法的 http(s) URL'); }
    next.imageApiBase = u;
  }
  if (patch.imageApiKey === null) next.imageApiKey = '';
  else if (typeof patch.imageApiKey === 'string' && patch.imageApiKey.trim()) next.imageApiKey = patch.imageApiKey.trim();
  if (patch.sandbox !== undefined) {
    if (!SANDBOXES.includes(patch.sandbox)) throw new Error('sandbox 取值不合法');
    next.sandbox = patch.sandbox;
  }
  return next;
}

export function saveSettings(patch) {
  const next = mergeSettings(loadSettings(), patch);
  writeFileAtomic(paths.settings(), JSON.stringify(next, null, 2), 0o600);
  return next;
}

/** 给前端看的设置：Key 只显示末 4 位。 */
export function publicSettings(s) {
  const { apiKey, imageApiKey, ...rest } = s;
  const hint = (k) => (k ? `****${k.slice(-4)}` : '');
  return { ...rest, hasKey: Boolean(apiKey), apiKeyHint: hint(apiKey), hasImageKey: Boolean(imageApiKey), imageApiKeyHint: hint(imageApiKey) };
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
  return lines.join('\n') + '\n';
}

// Windows PowerShell 5.1 默认按 GBK 读写文本，UTF-8 中文会被读成乱码（模型看到的也是乱码）
export const WINDOWS_AGENTS_MD = `# Windows 环境须知（全局）

你的 shell 是 Windows PowerShell 5.1，它默认用 GBK 读写文本，会把本项目的 UTF-8 中文读成乱码。必须：

- 每条命令开头加：\`[Console]::OutputEncoding = [Text.Encoding]::UTF8;\`
- 读文本一律：\`Get-Content -Raw -Encoding UTF8 <路径>\`（不要裸用 Get-Content / cat / type）。
- 写文件优先用 apply_patch；必须用命令写时：\`[IO.File]::WriteAllText('<路径>', $text, (New-Object Text.UTF8Encoding $false))\`（UTF-8 无 BOM，JSON 尤其不能带 BOM）。
- 如果读到的中文像"鍐欐硶""鏍囬"这类乱码，说明编码错了，按上面的方法重新读，不要基于乱码内容继续工作。
`;

/** 写 config.toml、Windows 下的全局 AGENTS.md，并把内置 skills 同步到 CODEX_HOME/skills。 */
export function prepareCodexHome(s, platform = process.platform) {
  const home = paths.codexHome();
  writeFileAtomic(path.join(home, 'config.toml'), buildCodexConfig(s, platform));
  if (platform === 'win32') writeFileAtomic(path.join(home, 'AGENTS.md'), WINDOWS_AGENTS_MD);
  else fs.rmSync(path.join(home, 'AGENTS.md'), { force: true });
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
    WX_IMAGE_API_BASE: s.imageApiBase || '',
    WX_IMAGE_API_KEY: s.imageApiKey || '',
  };
}
