// 生图（OpenAI 兼容 /v1/images/generations，如 Muse）：地址与 Key 来自应用设置，经环境变量传入。
//   node gen-image.mjs --prompt "……" [--size 16:9] [--dir .] [--note 用途]
import { args, registerImage, extOf, done } from './lib.mjs';

const a = args();
const base = (process.env.WX_IMAGE_API_BASE || '').replace(/\/+$/, '');
const key = process.env.WX_IMAGE_API_KEY || '';
if (!base) done({ ok: false, error: '未配置生图接口：请用户在应用「设置」里填写生图接口地址与 Key' });
if (!a.prompt) done({ ok: false, error: '用法：gen-image.mjs --prompt "画面描述" [--size 16:9]' });

const url = /\/v1$/.test(base) ? `${base}/images/generations` : `${base}/v1/images/generations`;
const r = await fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
  body: JSON.stringify({ prompt: String(a.prompt), size: String(a.size || '16:9'), response_format: 'url', n: 1 }),
  signal: AbortSignal.timeout(240000),
}).catch((e) => ({ ok: false, statusText: e.message }));
if (!r.ok) done({ ok: false, error: `生图接口失败：${r.status || ''} ${r.statusText || ''} ${await r.text?.().catch(() => '') || ''}`.slice(0, 300) });
const data = (await r.json()).data?.[0] || {};
let buf; let type = 'image/png';
if (data.b64_json) buf = Buffer.from(data.b64_json, 'base64');
else if (data.url) { const img = await fetch(new URL(data.url, url), { headers: key ? { Authorization: `Bearer ${key}` } : {} }); // Muse 返回相对路径
  if (!img.ok) done({ ok: false, error: `下载生成的图片失败：${img.status}` }); buf = Buffer.from(await img.arrayBuffer()); type = img.headers.get('content-type'); }
if (!buf) done({ ok: false, error: '接口没有返回图片' });
const item = registerImage(a.dir || '.', buf, extOf(type, data.url), `AI 生成插画：${String(a.note || a.prompt).slice(0, 60)}`, 'AI 生成');
done({ ok: true, added: [item] });
