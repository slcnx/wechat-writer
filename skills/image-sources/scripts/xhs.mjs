// 小红书取图：连应用打开的浏览器（需已登录小红书），搜索笔记、下载笔记图片并登记为 图N。
//   node xhs.mjs search --q 跷脚牛肉 [--n 12] [--dir .]
//   node xhs.mjs fetch --note <笔记链接> [--max 2] [--dir .]
// 输出最后一行是 JSON。图注署名用返回的 credit（「小红书@作者」）。
import { args, registerImage, extOf, playwright, cdpEndpoint, done } from './lib.mjs';

const a = args();
const dir = a.dir || '.';
const cmd = a._[0];
const SEARCH = (q) => `https://www.xiaohongshu.com/search_result?keyword=${encodeURIComponent(q)}&source=web_search_result_notes&type=51`;

async function withPage(fn) {
  const endpoint = cdpEndpoint(dir);
  if (!endpoint) done({ ok: false, error: '浏览器未打开（没有 cdp.json）。请用户在对话里提到"小红书"，应用会打开浏览器。' });
  const browser = await playwright().chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  try { return await fn(page, ctx); } finally { await page.close().catch(() => {}); await browser.close().catch(() => {}); }
}

const needLogin = (page) => page.evaluate(() => /登录后查看搜索结果|扫码登录|手机号登录/.test(document.body.innerText.slice(0, 800)) && !document.querySelector('section.note-item'));

async function search(q, n) {
  return withPage(async (page) => {
    await page.goto(SEARCH(q), { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('section.note-item', { timeout: 15000 }).catch(() => {});
    if (await needLogin(page)) return { ok: false, error: '小红书未登录：请用户在应用打开的浏览器里扫码登录小红书后再试', login: true };
    for (let i = 0; i < 3; i++) { await page.mouse.wheel(0, 1600); await page.waitForTimeout(800); }
    const notes = await page.evaluate((max) => [...document.querySelectorAll('section.note-item')].map((s) => {
      const link = [...s.querySelectorAll('a[href]')].map((x) => x.href).find((h) => /\/(explore|search_result|discovery\/item)\/[0-9a-f]{16,}/.test(h));
      return {
        note: link || '',
        title: (s.querySelector('.footer .title, .title')?.textContent || '').trim(),
        author: (s.querySelector('.author .name, .author-wrapper .name, .name')?.textContent || '').trim(),
        likes: (s.querySelector('.like-wrapper .count, .count')?.textContent || '').trim(),
        video: Boolean(s.querySelector('.play-icon, [class*=play]')),
      };
    }).filter((x) => x.note && !x.video).slice(0, max), n);
    return { ok: true, q, notes };
  });
}

async function fetchNote(note, max) {
  return withPage(async (page, ctx) => {
    await page.goto(note, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('.note-slider-img, .swiper-slide img, .media-container img', { timeout: 15000 }).catch(() => {});
    if (await needLogin(page)) return { ok: false, error: '小红书未登录', login: true };
    const info = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('.swiper-slide:not(.swiper-slide-duplicate) img, .note-slider-img, .media-container img')]
        .map((i) => i.currentSrc || i.src).filter((u) => /^https?:/.test(u) && /xhscdn|xiaohongshu/.test(u));
      return {
        imgs: [...new Set(imgs)],
        author: (document.querySelector('.author-wrapper .username, .author .name, .username')?.textContent || '').trim(),
        title: (document.querySelector('#detail-title, .note-content .title')?.textContent || document.title || '').trim(),
      };
    });
    if (!info.imgs.length) return { ok: false, error: '没找到笔记图片（可能是视频笔记或页面结构变了，可改用 browser 工具查看）' };
    const credit = `小红书@${info.author || '作者'}`;
    const added = [];
    for (const url of info.imgs.slice(0, max)) {
      const r = await ctx.request.get(url, { headers: { Referer: 'https://www.xiaohongshu.com/' } });
      if (!r.ok()) continue;
      const item = registerImage(dir, await r.body(), extOf(r.headers()['content-type'], url), `${credit}｜${info.title.slice(0, 40)}｜${note.split('?')[0]}`, credit);
      added.push(item);
    }
    return added.length ? { ok: true, credit, title: info.title, added } : { ok: false, error: '图片下载失败' };
  });
}

if (cmd === 'search' && a.q) done(await search(String(a.q), Number(a.n) || 12));
else if (cmd === 'fetch' && a.note) done(await fetchNote(String(a.note), Number(a.max) || 2));
else done({ ok: false, error: '用法：xhs.mjs search --q 关键词 | fetch --note <链接> [--max 2]' });
