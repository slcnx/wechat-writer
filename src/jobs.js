// 写作任务：每篇文章一个目录 articles/<id>/{materials,out,brief.json,job.json}。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { writeFileAtomic, readJsonSafe } from './fsutil.js';
import { runCodex, buildWritePrompt, buildRevisePrompt } from './codex.js';
import { sanitizeBody, validateArticle } from './article.js';
import { decodeFiles, saveMaterials, readImages, describeImages } from './materials.js';
import { describeImages as visionDescribe } from './vision.js';

const ID_RE = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
const MAX_VISION = 8; // 最多把 8 张图片直接给模型看
const MAX_LOG = 400;
const live = new Map(); // id -> job（内存中带实时日志）

export function isValidId(id) { return ID_RE.test(String(id)); }
export function jobDir(id) {
  if (!isValidId(id)) throw new Error('非法文章 id');
  return path.join(paths.articles(), id);
}

function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

function persist(job) {
  const { log, ...rest } = job;
  writeFileAtomic(path.join(jobDir(job.id), 'job.json'), JSON.stringify({ ...rest, log: log.slice(-80) }, null, 2));
}

/** 读取成稿并做清洗+校验；清洗结果写回 article.body.html。 */
export function readArticle(id) {
  const out = path.join(jobDir(id), 'out');
  const meta = readJsonSafe(path.join(out, 'meta.json'), null);
  let body = '';
  try { body = fs.readFileSync(path.join(out, 'article.body.html'), 'utf8'); } catch { /* 未生成 */ }
  const clean = sanitizeBody(body);
  if (clean && clean !== body) writeFileAtomic(path.join(out, 'article.body.html'), clean);
  const images = readImages(jobDir(id));
  return { meta: meta || {}, body: clean, images, check: validateArticle(meta, clean, images) };
}

const TEXT_ONLY = ['--disable', 'view_image'];
const noVision = new Set(); // 本次运行中已确认不支持图片输入的「地址|模型」

/** 有图片时先把图片附给模型看（能看图的模型据画面写图注）；已知不支持看图的模型直接关掉看图工具。 */
export function visionArgs(dir, settings) {
  const images = readImages(dir);
  if (!images.length || settings.visionModel || noVision.has(`${settings.baseUrl}|${settings.model}`)) return TEXT_ONLY;
  return images.slice(0, MAX_VISION).flatMap((m) => ['-i', path.join(dir, 'materials', m.src)]);
}

function start(job, buildPrompt, settings) {
  const log = (line) => { job.log.push(line); if (job.log.length > MAX_LOG) job.log.shift(); };
  job.status = 'running';
  job.error = '';
  job.updatedAt = Date.now();
  persist(job);
  const cwd = jobDir(job.id);
  // 设置了看图模型：先把图片（base64）交给它生成画面描述，写作模型据描述安排图片
  const done = visionDescribe(cwd, settings, log).catch((e) => log(`[看图] 出错：${e.message}`)).then(() => {
    const prompt = buildPrompt();
    const vision = visionArgs(cwd, settings);
    const once = (extraArgs) => runCodex({ cwd, prompt, settings, extraArgs, onLog: log }).done;
    return once(vision).then((code) => {
      if (code === 0 || vision === TEXT_ONLY) return code;
      noVision.add(`${settings.baseUrl}|${settings.model}`);
      log('[提示] 当前模型不支持看图，改为不看图重试：按文件名、素材说明和上下文安排图片（可在设置里选一个「看图模型」）');
      return once(TEXT_ONLY);
    });
  });
  done.then((code) => {
    const { check } = readArticle(job.id);
    job.check = check;
    job.status = check.ok ? 'done' : 'failed';
    if (!check.ok) job.error = code === 0 ? `成稿未通过校验：${check.problems.join('；')}` : `Codex 退出码 ${code}：${check.problems.join('；')}`;
    job.updatedAt = Date.now();
    persist(job);
  });
  return job;
}

export async function createJob(input, settings) {
  const materials = String(input.materials || '').trim();
  const decoded = decodeFiles(input.files);
  if (!materials && decoded.length === 0) throw new Error('请至少提供一段素材或一个素材文件');
  const id = newId();
  const dir = jobDir(id);
  fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  if (materials) writeFileAtomic(path.join(dir, 'materials', '00-用户输入.md'), materials);
  await saveMaterials(dir, decoded);
  const brief = {
    title: String(input.title || '').slice(0, 64),
    style: String(input.style || '干货科普'),
    audience: String(input.audience || '公众号普通读者'),
    length: String(input.length || '1500-2500 字'),
    author: settings.author || '',
    extra: String(input.extra || '').slice(0, 2000),
  };
  writeFileAtomic(path.join(dir, 'brief.json'), JSON.stringify(brief, null, 2));
  const job = { id, title: brief.title, status: 'queued', createdAt: Date.now(), log: [], check: null, error: '' };
  live.set(id, job);
  return start(job, () => buildWritePrompt(brief, describeImages(readImages(dir))), settings);
}

/** 按修改意见改稿；可同时补传图片/文档（图片接着编号），意见里可直接写"图2放开头"。 */
export async function reviseJob(id, input, settings) {
  const job = getJob(id);
  if (!job) throw new Error('文章不存在');
  if (job.status === 'running') throw new Error('该文章正在生成中');
  const instruction = String(input.instruction || '').trim();
  const decoded = decodeFiles(input.files);
  if (!instruction && !decoded.length) throw new Error('请填写修改意见或补充素材');
  const dir = jobDir(id);
  const { saved, images } = await saveMaterials(dir, decoded, '修改时补充：');
  const added = [...saved.map((f) => `materials/${f}`), ...images.map((m) => `${m.id}（${m.src}）`)];
  job.log = job.log || [];
  live.set(id, job);
  return start(job, () => buildRevisePrompt(instruction || '把新补充的素材用进文章', describeImages(readImages(dir)), added), settings);
}

export function getJob(id) {
  if (!isValidId(id)) return null;
  if (live.has(id)) return live.get(id);
  const j = readJsonSafe(path.join(jobDir(id), 'job.json'), null);
  if (j && j.status === 'running') j.status = 'failed'; // 应用重启时中断的任务
  return j;
}

export function listJobs() {
  let ids = [];
  try { ids = fs.readdirSync(paths.articles()).filter(isValidId); } catch { /* 尚无文章 */ }
  return ids.sort().reverse().slice(0, 50).map((id) => {
    const j = getJob(id) || { id, status: 'unknown' };
    const meta = readJsonSafe(path.join(jobDir(id), 'out', 'meta.json'), {});
    return { id, status: j.status, title: meta.title || j.title || '(未命名)', createdAt: j.createdAt };
  });
}
