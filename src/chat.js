// 唯一入口：用户发一句话（可带图片/文档），交给这篇文章的 Codex 会话处理。
// AI 自己判断是写稿、改稿、点名图片、设封面、填进公众号还是先追问；同一篇文章用
// codex exec resume 接着同一个会话，记得前面聊过什么。
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';
import { runCodex, SESSION_RE } from './codex.js';
import { live, jobDir, newId, persist, getJob, appendChat, readChat, readSession, saveSession, readArticle } from './jobs.js';
import { decodeFiles, saveMaterials, readImages, describeImages as listImages } from './materials.js';
import { describeImages as visionDescribe } from './vision.js';
import { ensureBrowser, browserReady, browserMcpArgs } from './publisher.js';
import { writeFileAtomic } from './fsutil.js';

const MAX_LOG = 400;
const MAX_VISION = 8;
const TEXT_ONLY = ['--disable', 'view_image'];
const noVision = new Set(); // 已确认不支持图片输入的「地址|模型」
const BROWSER_WORDS = /公众号|填入|填进|填到|草稿|封面|发布|发表|编辑器|后台|群发/;

export const ROLE = [
  '你是「公众号写作助手」，在当前文章目录里工作，和用户用中文对话。',
  '可用 skill：wechat-article（写稿、改稿，产出 out/article.body.html 与 out/meta.json）；wechat-publish（操作公众号后台编辑器，仅当说明里写了"浏览器：已登录"时可用）。',
  '每轮根据用户的话自己判断要做什么：写新稿、按意见改稿（含点名"图N"调整图片/封面）、把文章填进公众号或在编辑器里修改、回答问题。',
  '写稿前如果缺少关键信息——写什么主题、给谁看——且无法从素材推断，就先用一两句话向用户提问并结束本轮，不要硬写；文风、篇幅、标题等次要信息用户没说就根据素材自行决定。',
  '用户发来的文字、图片、文档都已保存在 materials/（图片清单 materials/images.json，图片编号 图N）。',
  '最后的回复直接面向用户：简短说明做了什么、结果如何、需要用户补充或确认什么；不要复述过程细节，不要提文件名、路径、skill 等内部术语（用户看不到这些）。',
].join('\n');

export function wantsBrowser(text) { return BROWSER_WORDS.test(String(text)); }

/** 组装本轮 prompt：首轮带角色说明，之后只带本轮内容。 */
export function buildTurnPrompt({ first, message, added, imagesText, browser, script }) {
  return [
    first ? ROLE : '',
    first ? '' : '（继续同一篇文章的对话）',
    `用户：${message || '（用户只上传了素材，没有附言）'}`,
    added.length ? `本轮新增素材：${added.join('、')}` : '',
    imagesText,
    browser ? `浏览器：已登录公众号后台，可用 browser 工具与 wechat-publish skill（脚本：${script}；连接信息在 cdp.json）。严禁点击发表、群发、保存为草稿。` : '浏览器：未打开。用户要操作公众号时，回复请他说"填进公众号"等指令，应用会打开浏览器并请他扫码。',
  ].filter(Boolean).join('\n');
}

function visionArgs(dir, images, settings) {
  if (!images.length || settings.visionModel || noVision.has(`${settings.baseUrl}|${settings.model}`)) return TEXT_ONLY;
  return images.slice(0, MAX_VISION).flatMap((m) => ['-i', path.join(dir, 'materials', m.src)]);
}

/** 处理一条用户消息；立即返回文章 id，Codex 在后台运行，前端轮询 /api/jobs/:id。 */
export async function sendMessage({ id, message, files }, settings) {
  const text = String(message || '').trim().slice(0, 4000);
  const decoded = decodeFiles(files);
  if (!text && !decoded.length) throw new Error('请输入内容或上传素材');
  let job = id ? getJob(id) : null;
  if (id && !job && !fs.existsSync(jobDir(id))) throw new Error('文章不存在');
  if (job?.status === 'running') throw new Error('AI 还在处理上一条消息，请稍候');
  if (!id) id = newId();
  const dir = jobDir(id);
  fs.mkdirSync(path.join(dir, 'materials'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  if (!fs.existsSync(path.join(dir, 'brief.json'))) writeFileAtomic(path.join(dir, 'brief.json'), JSON.stringify({ author: settings.author || '' }, null, 2));
  job = { createdAt: Date.now(), ...(job || {}), id, status: 'running', error: '', log: [], updatedAt: Date.now() };
  live.set(id, job);
  const { saved, images } = await saveMaterials(dir, decoded);
  if (text) fs.appendFileSync(path.join(dir, 'materials', '00-用户消息.md'), `\n## ${new Date().toLocaleString('zh-CN')}\n${text}\n`);
  appendChat(id, { role: 'user', text, files: [...saved, ...images.map((m) => `${m.id}（${m.from}）`)] });
  persist(job);
  runTurn(job, { text, saved, images }, settings).catch((e) => finish(job, -1, e.message));
  return { id };
}

const log = (job) => (line) => { job.log.push(line); if (job.log.length > MAX_LOG) job.log.shift(); };

async function runTurn(job, { text, saved, images }, settings) {
  const dir = jobDir(job.id);
  const say = log(job);
  let endpoint = '';
  if (wantsBrowser(text) || browserReady()) {
    endpoint = await ensureBrowser(settings, (m) => { job.notice = m; say(`[浏览器] ${m}`); });
    job.notice = '';
    writeFileAtomic(path.join(dir, 'cdp.json'), JSON.stringify({ endpoint, articleId: job.id }));
  }
  await visionDescribe(dir, settings, say).catch((e) => say(`[看图] 出错：${e.message}`));
  const resumeId = readSession(job.id);
  const prompt = buildTurnPrompt({
    first: !resumeId,
    message: text,
    added: [...saved.map((f) => `materials/${f}`), ...images.map((m) => `${m.id}（${m.src}）`)],
    imagesText: readImages(dir).length ? listImages(readImages(dir)) : '',
    browser: Boolean(endpoint),
    script: path.join(paths.codexHome(), 'skills', 'wechat-publish', 'scripts', 'fill-mp.mjs'),
  });
  const lastFile = path.join(dir, 'out', '.last-reply.txt');
  fs.rmSync(lastFile, { force: true });
  const base = endpoint ? browserMcpArgs(endpoint) : [];
  const once = (extra, sid) => runCodex({ cwd: dir, prompt, settings, extraArgs: [...base, ...extra], resumeId: sid, lastMessageFile: lastFile, onLog: say }).done;
  const vision = visionArgs(dir, images, settings);
  let code = await once(vision, resumeId);
  if (!resumeId) {
    const sid = job.log.map((l) => SESSION_RE.exec(l)?.[1]).find(Boolean);
    if (sid) saveSession(job.id, sid);
  }
  if (code !== 0 && vision !== TEXT_ONLY) {
    noVision.add(`${settings.baseUrl}|${settings.model}`);
    say('[提示] 当前模型不支持看图，改为不看图重试（可在设置里选一个「看图模型」）');
    code = await once(TEXT_ONLY, readSession(job.id));
  }
  fs.rmSync(path.join(dir, 'cdp.json'), { force: true });
  let reply = '';
  try { reply = fs.readFileSync(lastFile, 'utf8').trim(); } catch { /* 无回复 */ }
  finish(job, code, code === 0 ? '' : 'AI 执行未成功，看下方日志', reply);
}

function finish(job, code, error, reply = '') {
  const { check } = readArticle(job.id);
  job.check = check;
  job.status = code === 0 ? 'done' : 'failed';
  job.error = error;
  job.notice = '';
  job.updatedAt = Date.now();
  appendChat(job.id, { role: 'assistant', text: reply || (error ? `（出错了：${error}）` : '（已处理）'), ok: code === 0 });
  persist(job);
}

export { readChat };
