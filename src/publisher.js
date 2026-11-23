// 浏览器操作：用本机 Edge/Chrome（独立用户目录，保存扫码登录态）打开公众号后台，
// 新建图文、填标题/作者/摘要、把正文以富文本粘贴进编辑器。最终「发表」由用户本人点击。
import { chromium } from 'playwright-core';
import { paths } from './config.js';

const MP_HOME = 'https://mp.weixin.qq.com/';
const LOGIN_TIMEOUT = 5 * 60 * 1000;
const SEL = {
  title: ['#title', 'textarea[placeholder*="标题"]', 'input[placeholder*="标题"]'],
  author: ['#author', 'input[placeholder*="作者"]'],
  digest: ['#js_description', 'textarea[placeholder*="摘要"]'],
  body: ['.ProseMirror', '#ueditor_0', '[contenteditable="true"]'],
};

let ctx = null;
export const state = { phase: 'idle', message: '', articleId: null, updatedAt: 0 };
function setState(phase, message, articleId = state.articleId) {
  Object.assign(state, { phase, message, articleId, updatedAt: Date.now() });
}

async function context(settings) {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(paths.profile(), {
    channel: settings.browser === 'chromium' ? undefined : settings.browser,
    headless: false,
    viewport: null,
    args: ['--start-maximized'],
  });
  ctx.on('close', () => { ctx = null; });
  return ctx;
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

async function firstVisible(page, list, timeout) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const sel of list) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return { loc, sel };
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function openEditor(page, token) {
  for (const type of ['77', '10']) {
    await page.goto(`${MP_HOME}cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=${type}&createType=0&token=${token}&lang=zh_CN`);
    const hit = await firstVisible(page, SEL.body, 20000);
    if (hit) return hit;
  }
  throw new Error('没有找到公众号正文编辑器（页面结构可能已变化），请手动新建图文后用「复制富文本」粘贴');
}

async function editorText(page, sel) {
  if (sel === '#ueditor_0') return page.frameLocator(sel).locator('body').innerText().catch(() => '');
  return page.locator(sel).first().innerText().catch(() => '');
}

/**
 * 把 HTML 作为富文本粘贴进编辑区：先走系统剪贴板 + 真实 Ctrl/Cmd+V（编辑器自己的粘贴逻辑最稳），
 * 不行再派发合成 paste 事件。返回使用的方式，失败抛错。
 */
export async function pasteHtml(page, sel, html, plain) {
  const target = sel === '#ueditor_0' ? page.frameLocator(sel).locator('body') : page.locator(sel).first();
  const before = (await editorText(page, sel)).length;
  const grew = async () => (await editorText(page, sel)).length > before + Math.min(50, plain.length / 2);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin }).catch(() => {});
  const wrote = await page.evaluate(async ([h, t]) => {
    try {
      await navigator.clipboard.write([new ClipboardItem({
        'text/html': new Blob([h], { type: 'text/html' }),
        'text/plain': new Blob([t], { type: 'text/plain' }),
      })]);
      return true;
    } catch { return false; }
  }, [html, plain]);
  await target.click();
  if (wrote) {
    await page.keyboard.press('ControlOrMeta+V');
    await page.waitForTimeout(1500);
    if (await grew()) return 'clipboard';
  }
  await target.evaluate((el, [h, t]) => {
    const dt = new DataTransfer();
    dt.setData('text/html', h);
    dt.setData('text/plain', t);
    el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, [html, plain]);
  await page.waitForTimeout(1500);
  if (await grew()) return 'synthetic';
  throw new Error('正文自动粘贴失败，请在预览页点「复制富文本」后到编辑器里 Ctrl+V');
}

async function fillOptional(page, list, value) {
  if (!value) return false;
  const hit = await firstVisible(page, list, 3000);
  if (!hit) return false;
  await hit.loc.fill(value);
  return true;
}

/** 完整流程：登录 → 新建图文 → 填写。不点击发表/群发。 */
export async function fillDraft(article, settings) {
  const { meta, body, plain, id } = article;
  setState('opening', '正在启动浏览器…', id);
  try {
    const page = await openMp(settings);
    if (!tokenFromUrl(page.url())) setState('login', '请在弹出的浏览器里用微信扫码登录公众号后台（5 分钟内）', id);
    const token = await waitLogin(page);
    setState('editing', '已登录，正在新建图文并填入内容…', id);
    const edPage = await page.context().newPage();
    const { sel } = await openEditor(edPage, token);
    const filled = [];
    if (await fillOptional(edPage, SEL.title, meta.title)) filled.push('标题');
    if (await fillOptional(edPage, SEL.author, meta.author || settings.author)) filled.push('作者');
    const how = await pasteHtml(edPage, sel, body, plain);
    filled.push(`正文(${how})`);
    if (await fillOptional(edPage, SEL.digest, meta.digest)) filled.push('摘要');
    setState('ready', `已填入：${filled.join('、')}。请在浏览器里检查排版、设置封面，然后点「保存为草稿」或「发表」。`, id);
  } catch (e) {
    setState('error', e.message, id);
  }
  return { ...state };
}

export async function closeBrowser() {
  if (ctx) await ctx.close().catch(() => {});
  ctx = null;
}
