// 写作任务：每篇文章一个目录 articles/<id>/{materials,out,brief.json,job.json}。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { writeFileAtomic, readJsonSafe } from './fsutil.js';
import { runCodex, buildWritePrompt, buildRevisePrompt } from './codex.js';
import { sanitizeBody, validateArticle } from './article.js';

const ID_RE = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
const MAX_FILE = 5 * 1024 * 1024;
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

export function safeFileName(name, i) {
  const base = path.basename(String(name || '')).replace(/[^\w.一-龥-]/g, '_').slice(0, 80);
  return base && !base.startsWith('.') ? base : `file-${i}.txt`;
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
  return { meta: meta || {}, body: clean, check: validateArticle(meta, clean) };
}

function start(job, prompt, settings) {
  const log = (line) => { job.log.push(line); if (job.log.length > MAX_LOG) job.log.shift(); };
  job.status = 'running';
  job.error = '';
  job.updatedAt = Date.now();
  persist(job);
  const run = runCodex({ cwd: jobDir(job.id), prompt, settings, onLog: log });
  run.done.then((code) => {
    const { check } = readArticle(job.id);
    job.check = check;
    job.status = check.ok ? 'done' : 'failed';
    if (!check.ok) job.error = code === 0 ? `成稿未通过校验：${check.problems.join('；')}` : `Codex 退出码 ${code}：${check.problems.join('；')}`;
    job.updatedAt = Date.now();
    persist(job);
  });
  return job;
}

export function createJob(input, settings) {
  const materials = String(input.materials || '').trim();
  const files = Array.isArray(input.files) ? input.files : [];
  if (!materials && files.length === 0) throw new Error('请至少提供一段素材或一个素材文件');
  const bufs = files.map((f) => Buffer.from(String(f.content || ''), 'base64'));
  bufs.forEach((b, i) => { if (b.length > MAX_FILE) throw new Error(`${files[i].name} 超过 5MB`); });
  const id = newId();
  const dir = jobDir(id);
  fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  if (materials) writeFileAtomic(path.join(dir, 'materials', '00-用户输入.md'), materials);
  files.forEach((f, i) => {
    writeFileAtomic(path.join(dir, 'materials', `${String(i + 1).padStart(2, '0')}-${safeFileName(f.name, i)}`), bufs[i]);
  });
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
  return start(job, buildWritePrompt(brief), settings);
}

export function reviseJob(id, instruction, settings) {
  const job = getJob(id);
  if (!job) throw new Error('文章不存在');
  if (job.status === 'running') throw new Error('该文章正在生成中');
  if (!String(instruction || '').trim()) throw new Error('请填写修改意见');
  job.log = job.log || [];
  live.set(id, job);
  return start(job, buildRevisePrompt(String(instruction).slice(0, 2000)), settings);
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
