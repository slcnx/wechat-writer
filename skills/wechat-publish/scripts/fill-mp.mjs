#!/usr/bin/env node
// 把文章目录 out/ 下的成稿填进公众号后台的新建图文编辑器（不点发表/群发）。
// 通过 CDP 连接「公众号写作助手」已打开并已登录的浏览器。
//   填稿：node fill-mp.mjs --dir <文章目录> [--selectors <json>]
//   诊断：node fill-mp.mjs --dir <文章目录> --dump <输出.json>
//   传图：node fill-mp.mjs --dir <文章目录> --upload images/img02.jpg   （传到图片素材库，返回 mmbiz 地址与素材库里的文件名）
// 输出最后一行是 JSON：{ ok, filled?, error?, dump? }
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MP = 'https://mp.weixin.qq.com/';

export function loadSelectors(file) {
  const base = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'selectors.json'), 'utf8'));
  if (!file) return base;
  return { ...base, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
}

function playwright() {
  const root = process.env.WX_WRITER_APP_ROOT;
  const req = createRequire(root ? path.join(root, 'package.json') : import.meta.url);
  return req('playwright-core');
}

const isIframe = (sel) => sel.startsWith('iframe');

async function firstVisible(page, list, timeout) {
  const deadline = Date.now() + timeout;
  do {
    for (const sel of list) {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) return { loc, sel };
    }
    await page.waitForTimeout(400);
  } while (Date.now() < deadline);
  return null;
}

async function editorText(page, sel) {
  const loc = isIframe(sel) ? page.frameLocator(sel).locator('body') : page.locator(sel).first();
  return loc.innerText().catch(() => '');
}

/** 富文本粘贴：先系统剪贴板 + 真实 Ctrl/Cmd+V，不行再派发合成 paste 事件。 */
export async function pasteHtml(page, sel, html, plain) {
  const target = isIframe(sel) ? page.frameLocator(sel).locator('body') : page.locator(sel).first();
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
  throw new Error(`正文粘贴后内容没有变化（body 选择器 ${sel} 可能不对）`);
}

async function fillOptional(page, list, value) {
  if (!value) return false;
  const hit = await firstVisible(page, list, 3000);
  if (!hit) return false;
  await hit.loc.fill(value);
  return true;
}

/** 依次填标题、作者、正文、摘要；填完校验标题没被正文污染。 */
export async function fillEditor(page, S, { title, author, digest, html, plain }) {
  const body = await firstVisible(page, S.body, 15000);
  if (!body) throw new Error(`找不到正文编辑区，已试：${S.body.join(' | ')}`);
  const filled = [];
  if (await fillOptional(page, S.title, title)) filled.push('标题');
  if (await fillOptional(page, S.author, author)) filled.push('作者');
  filled.push(`正文(${await pasteHtml(page, body.sel, html, plain)})`);
  if (await fillOptional(page, S.digest, digest)) filled.push('摘要');
  const t = await firstVisible(page, S.title, 1000);
  const tText = t ? ((await t.loc.innerText().catch(() => '')) || (await t.loc.inputValue().catch(() => ''))) : '';
  if (tText.trim().length > 80) throw new Error('标题框里出现了正文内容：title 与 body 选择器指向了同一类元素，需要按容器区分');
  if (!filled.includes('标题')) throw new Error(`没填上标题，title 选择器都没命中：${S.title.join(' | ')}`);
  return filled;
}

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

/** 在已登录页面里调用公众号自己的「上传到图片素材库」接口，返回 mmbiz 图床地址。 */
async function uploadOne(page, buf, name) {
  return page.evaluate(async ({ b64, name, type }) => {
    const d = (window.wx && window.wx.commonData && window.wx.commonData.data) || {};
    const token = (/[?&]token=(\d+)/.exec(location.href) || [])[1];
    if (!d.ticket || !token) return { error: '页面缺少登录票据（wx.commonData）' };
    const bin = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const fd = new FormData();
    fd.append('id', 'WU_FILE_0'); fd.append('name', name); fd.append('type', type);
    fd.append('lastModifiedDate', new Date().toString()); fd.append('size', String(bin.length));
    fd.append('file', new File([bin], name, { type }));
    const q = new URLSearchParams({ action: 'upload_material', f: 'json', scene: '8', writetype: 'doublewrite', groupid: '1',
      ticket_id: d.user_name || '', ticket: d.ticket, svr_time: String(Math.floor(Date.now() / 1000)), token, lang: 'zh_CN', seq: String(Date.now()) });
    const r = await fetch(`/cgi-bin/filetransfer?${q}`, { method: 'POST', body: fd, credentials: 'include' });
    const j = await r.json().catch(() => ({}));
    return j.cdn_url ? { url: j.cdn_url } : { error: `上传失败 HTTP ${r.status} ${JSON.stringify(j.base_resp || j).slice(0, 120)}` };
  }, { b64: buf.toString('base64'), name, type: MIME[path.extname(name).toLowerCase()] || 'image/png' });
}

/** 把正文里的素材图片（src="images/…"）上传到公众号并替换成 mmbiz 地址；结果缓存在 out/uploaded.json。 */
export async function uploadImages(page, dir, html, prefix = '') {
  const cacheFile = path.join(dir, 'out', 'uploaded.json');
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch { /* 首次 */ }
  const srcs = [...new Set([...html.matchAll(/<img\b[^>]*\bsrc\s*=\s*["'](images\/[\w.-]+)["']/gi)].map((m) => m[1]))];
  for (const src of srcs) {
    if (cache[src]) continue;
    const r = await uploadOne(page, fs.readFileSync(path.join(dir, 'materials', src)), `${prefix}${path.basename(src)}`);
    if (!r.url) throw new Error(`图片 ${src} ${r.error}`);
    cache[src] = r.url;
    fs.writeFileSync(cacheFile, JSON.stringify(cache, null, 2));
  }
  const out = html.replace(/(<img\b[^>]*\bsrc\s*=\s*["'])(images\/[\w.-]+)(["'])/gi, (m, a, src, b) => `${a}${cache[src]}${b}`);
  return { html: out, uploaded: srcs.length };
}

/** 列出页面上所有可编辑元素及其祖先链，供 AI 修正选择器。 */
export async function dumpEditables(page) {
  return page.evaluate(() => {
    const desc = (el) => {
      const r = el.getBoundingClientRect();
      const chain = [];
      for (let p = el, i = 0; p && i < 5; p = p.parentElement, i++) {
        chain.push(p.tagName.toLowerCase() + (p.id ? `#${p.id}` : '') + (typeof p.className === 'string' && p.className.trim() ? `.${p.className.trim().split(/\s+/).slice(0, 3).join('.')}` : ''));
      }
      return { tag: el.tagName.toLowerCase(), id: el.id, placeholder: el.getAttribute('placeholder') || '', visible: r.width > 0 && r.height > 0, box: [r.x, r.y, r.width, r.height].map(Math.round), text: (el.innerText || el.value || '').slice(0, 40), chain };
    };
    const hints = [...document.querySelectorAll('label, .placeholder_tips, [class*=placeholder]')]
      .filter((e) => /标题|作者|正文|摘要/.test(e.textContent || '') && (e.textContent || '').length < 30).map(desc);
    return { url: location.href, editables: [...document.querySelectorAll('[contenteditable=true], textarea, input[type=text], input:not([type]), iframe')].map(desc).filter((d) => d.visible), hints };
  });
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const dir = path.resolve(arg('dir') || '.');
  const S = loadSelectors(arg('selectors'));
  const { endpoint: cdp, articleId = '' } = JSON.parse(fs.readFileSync(path.join(dir, 'cdp.json'), 'utf8'));
  const prefix = articleId ? `${articleId}-` : '';
  const browser = await playwright().chromium.connectOverCDP(cdp);
  const ctx = browser.contexts()[0];
  const home = ctx.pages().find((p) => /[?&]token=\d+/.test(p.url()));
  const logged = home && /[?&]token=(\d+)/.exec(home.url());
  if (!logged) throw new Error('浏览器里没有已登录的公众号页面，请先在应用里点「打开公众号后台」扫码登录');
  const upSrc = arg('upload');
  if (upSrc) {
    if (!/^images\/[\w.-]+$/.test(upSrc)) throw new Error('--upload 只接受 images/文件名');
    const name = `${prefix}${path.basename(upSrc)}`;
    const r = await uploadOne(home, fs.readFileSync(path.join(dir, 'materials', upSrc)), name);
    if (!r.url) throw new Error(`图片 ${upSrc} ${r.error}`);
    return { ok: true, url: r.url, libraryName: name };
  }
  const page = await ctx.newPage();
  let opened = false;
  for (const type of S.editorTypes) {
    await page.goto(`${MP}cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=${type}&createType=0&token=${logged[1]}&lang=zh_CN`);
    if (await firstVisible(page, [...S.body, ...S.title], 15000)) { opened = true; break; }
  }
  const dumpFile = arg('dump');
  if (dumpFile) {
    fs.writeFileSync(dumpFile, JSON.stringify(await dumpEditables(page), null, 2));
    await page.close();
    return { ok: true, dump: dumpFile, editorOpened: opened };
  }
  const out = path.join(dir, 'out');
  const meta = JSON.parse(fs.readFileSync(path.join(out, 'meta.json'), 'utf8'));
  const raw = fs.readFileSync(path.join(out, 'article.body.html'), 'utf8');
  const { html, uploaded } = await uploadImages(home, dir, raw, prefix);
  const plain = html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  const author = meta.author || JSON.parse(fs.readFileSync(path.join(dir, 'brief.json'), 'utf8')).author || '';
  const filled = await fillEditor(page, S, { title: meta.title, author, digest: meta.digest, html, plain });
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
  await page.bringToFront();
  if (uploaded) filled.push(`图片${uploaded}张(已传素材库)`);
  return { ok: true, filled };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((r) => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch((e) => { console.log(JSON.stringify({ ok: false, error: e.message })); process.exit(1); });
}
