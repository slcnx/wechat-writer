// 看图：把素材图片以 base64 发给「看图模型」（OpenAI Responses 格式 input_image），
// 得到画面描述，写回 images.json 的 desc 字段，并汇总到 materials/图片说明.md，供写作模型使用。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic } from './fsutil.js';
import { readImages } from './materials.js';

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const PROMPT = '你在为公众号文章准备配图说明。用 1~2 句中文客观描述这张图片：主体是什么、场景、图中能看清的文字（原样写出）。看不清的不要猜。';

export function extractText(resp) {
  if (typeof resp?.output_text === 'string' && resp.output_text) return resp.output_text.trim();
  const parts = (resp?.output || []).filter((o) => o.type === 'message').flatMap((o) => o.content || []);
  return parts.map((c) => c.text || '').join('').trim();
}

export async function describeOne(file, settings, fetchImpl = fetch) {
  const ext = path.extname(file).toLowerCase();
  const dataUrl = `data:${MIME[ext] || 'image/png'};base64,${fs.readFileSync(file).toString('base64')}`;
  const r = await fetchImpl(`${settings.baseUrl}/responses`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(settings.apiKey ? { Authorization: `Bearer ${settings.apiKey}` } : {}) },
    body: JSON.stringify({
      model: settings.visionModel,
      input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }, { type: 'input_image', image_url: dataUrl }] }],
    }),
    signal: AbortSignal.timeout(90000),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`HTTP ${r.status} ${JSON.stringify(data.error || data).slice(0, 160)}`);
  const text = extractText(data);
  if (!text) throw new Error('看图模型没有返回描述');
  return text.slice(0, 300);
}

/** 为还没有描述的图片生成描述（逐张，失败的跳过并记日志）。返回本次新描述的数量。 */
export async function describeImages(dir, settings, log = () => {}, fetchImpl = fetch) {
  if (!settings.visionModel) return 0;
  const images = readImages(dir);
  let n = 0;
  for (const m of images) {
    if (m.desc) continue;
    try {
      m.desc = await describeOne(path.join(dir, 'materials', m.src), settings, fetchImpl);
      n += 1;
      log(`[看图] ${m.id}：${m.desc}`);
    } catch (e) {
      log(`[看图] ${m.id} 失败：${e.message}`);
    }
  }
  if (n) {
    writeFileAtomic(path.join(dir, 'materials', 'images.json'), JSON.stringify(images, null, 2));
    const md = ['# 图片说明（看图模型生成，写图注时以此为准）', '', ...images.filter((m) => m.desc).map((m) => `- ${m.id}（${m.src}）：${m.desc}`)].join('\n');
    writeFileAtomic(path.join(dir, 'materials', '图片说明.md'), `${md}\n`);
  }
  return n;
}
