// 文章存储：每篇文章一个目录 articles/<id>/{materials,out,chat.json,session.json,job.json}。
// 一篇文章 = 一段对话（一个持续的 Codex 会话）；这里只管目录、状态、对话记录和成稿读取。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { paths } from './config.js';
import { writeFileAtomic, readJsonSafe } from './fsutil.js';
import { sanitizeBody, validateArticle } from './article.js';
import { readImages } from './materials.js';

const ID_RE = /^\d{8}-\d{6}-[a-f0-9]{4}$/;
export const live = new Map(); // id -> job（内存中带实时日志）

export function isValidId(id) { return ID_RE.test(String(id)); }
export function jobDir(id) {
  if (!isValidId(id)) throw new Error('非法文章 id');
  return path.join(paths.articles(), id);
}

export function newId() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}-${crypto.randomBytes(2).toString('hex')}`;
}

export function persist(job) {
  const { log = [], ...rest } = job;
  writeFileAtomic(path.join(jobDir(job.id), 'job.json'), JSON.stringify({ ...rest, log: log.slice(-80) }, null, 2));
}

export function readChat(id) {
  return readJsonSafe(path.join(jobDir(id), 'chat.json'), []);
}

export function appendChat(id, msg) {
  const chat = readChat(id);
  chat.push({ ...msg, at: Date.now() });
  writeFileAtomic(path.join(jobDir(id), 'chat.json'), JSON.stringify(chat, null, 2));
  return chat;
}

export function readSession(id) {
  return readJsonSafe(path.join(jobDir(id), 'session.json'), {}).sessionId || '';
}

export function saveSession(id, sessionId) {
  writeFileAtomic(path.join(jobDir(id), 'session.json'), JSON.stringify({ sessionId }, null, 2));
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
    const first = readChat(id).find((m) => m.role === 'user');
    return { id, status: j.status, title: meta.title || (first?.text || '').slice(0, 24) || '(新对话)', createdAt: j.createdAt };
  });
}
