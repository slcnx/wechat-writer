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
import { ensureBrowser, browserMcpArgs, NETWORK_ARGS } from './publisher.js';
import { writeFileAtomic } from './fsutil.js';

const MAX_LOG = 400;
const MAX_VISION = 8;
const TEXT_ONLY = ['--disable', 'view_image'];
const noVision = new Set(); // 已确认不支持图片输入的「地址|模型」
const turns = new Map(); // id -> { cancel, reason, promise }：正在运行的一轮，用于插话/停止
// 只认「要动公众号后台」的说法；「写一篇公众号文章」不该弹浏览器
// 默认一切都改本地文章（右侧预览）；明确提到公众号后台/编辑器里操作才算
const XHS_WORDS = /小红书/; // 只开浏览器取图，不碰公众号
const BROWSER_WORDS = /填入|填进|填到|放进|贴进|贴到|发到|同步到|(公众号|微信)(里|上|中|那边|后台|编辑器)|编辑器|后台|发布|发表|群发|存.{0,3}草稿|草稿箱/;

export const ROLE = [
  '你是「公众号写作助手」，在当前文章目录里工作，和用户用中文对话。',
  '可用 skill：wechat-article（写稿、改稿，产出 out/article.body.html 与 out/meta.json）；image-sources（小红书取图、生图）；wechat-publish（操作公众号后台编辑器，仅当说明里写了"浏览器：已登录公众号后台"时可用）。',
  '所有修改（文字、图片、封面、标签等）一律只改本地文章（out/ 下的文件，用户在应用右侧预览看到的就是它）；只有用户明确说在公众号/编辑器里改或填进公众号时，才操作公众号后台。',
  '每轮根据用户的话自己判断要做什么：写新稿、按意见改稿（含点名"图N"调整图片/封面）、把文章填进公众号或在编辑器里修改、回答问题。',
  '写稿前如果缺少关键信息——写什么主题、给谁看——且无法从素材推断，就先用一两句话向用户提问并结束本轮，不要硬写；文风、篇幅、标题等次要信息用户没说就根据素材自行决定。',
  '用户发来的文字、图片、文档都已保存在 materials/（图片清单 materials/images.json，图片编号 图N）。',
  '最后的回复直接面向用户：简短说明做了什么、结果如何、需要用户补充或确认什么；不要复述过程细节，不要提文件名、路径、skill 等内部术语（用户看不到这些）。',
].join('\n');

export function wantsBrowser(text) { return BROWSER_WORDS.test(String(text)); }
/** 本轮浏览器用途：mp=操作公众号后台，xhs=只上小红书取图，''=不开浏览器。 */
export function browserMode(text) { return wantsBrowser(text) ? 'mp' : XHS_WORDS.test(String(text)) ? 'xhs' : ''; }

/** 组装本轮 prompt：首轮带角色说明，之后只带本轮内容。 */
export function buildTurnPrompt({ first, message, added, imagesText, browser, script, interrupted }) {
  return [
    first ? ROLE : '',
    first ? '' : '（继续同一篇文章的对话）',
    interrupted ? '（上一轮还没做完就被用户插话打断了：先确认已完成到哪一步，再结合下面这条新消息继续，不要从头重做。）' : '',
    `用户：${message || '（用户只上传了素材，没有附言）'}`,
    added.length ? `本轮新增素材：${added.join('、')}` : '',
    imagesText,
    browser === 'xhs' ? '浏览器：已打开，可用 browser 工具与 image-sources skill 上小红书取图；本轮不要操作公众号后台。' : '',
    browser === 'mp' ? `浏览器：已登录公众号后台，可用 browser 工具与 wechat-publish skill（脚本：${script}；连接信息在 cdp.json）。先把修改落到本地文章，再按用户要求同步到编辑器。严禁点击发表、群发、保存为草稿。` : '',
    browser ? '' : '浏览器：本轮不可用。只修改本地文章（右侧预览），不要声称已同步到公众号；用户要操作公众号时，请他说"填进公众号"等指令。',
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
  // 运行中再发消息 = 插话：打断当前这一轮，在同一个会话里带着新消息接着做
  const interrupted = job?.status === 'running' && await interrupt(id, 'steer');
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
  const ctx = { cancel: null, reason: '' };
  turns.set(id, ctx);
  ctx.promise = runTurn(job, ctx, { text, saved, images, interrupted }, settings)
    .catch((e) => finish(job, ctx, -1, e.message))
    .finally(() => { if (turns.get(id) === ctx) turns.delete(id); });
  return { id };
}

/** 打断正在运行的一轮（reason=steer 插话 / stop 停止），等它收尾；返回是否确实打断了。 */
async function interrupt(id, reason) {
  const ctx = turns.get(id);
  if (!ctx) return false;
  ctx.reason = reason;
  ctx.cancel?.();
  const slow = new Promise((r) => setTimeout(r, 20000, 'slow'));
  if (await Promise.race([ctx.promise, slow]) === 'slow') throw new Error('AI 正在等待浏览器登录，暂时无法打断，请先扫码或稍后再试');
  return true;
}

export async function stopTurn(id) {
  if (!(await interrupt(id, 'stop'))) throw new Error('当前没有正在执行的任务');
  return { ok: true };
}

const log = (job) => (line) => { job.log.push(line); if (job.log.length > MAX_LOG) job.log.shift(); };

async function runTurn(job, ctx, { text, saved, images, interrupted }, settings) {
  const dir = jobDir(job.id);
  const say = log(job);
  let endpoint = '';
  const mode = browserMode(text);
  if (mode) {
    endpoint = await ensureBrowser(settings, (m) => { job.notice = m; say(`[浏览器] ${m}`); }, () => Boolean(ctx.reason), { mp: mode === 'mp' });
    job.notice = '';
    writeFileAtomic(path.join(dir, 'cdp.json'), JSON.stringify({ endpoint, articleId: job.id }));
  }
  if (ctx.reason) return finish(job, ctx, -1, '');
  await visionDescribe(dir, settings, say).catch((e) => say(`[看图] 出错：${e.message}`));
  const resumeId = readSession(job.id);
  const prompt = buildTurnPrompt({
    first: !resumeId,
    message: text,
    added: [...saved.map((f) => `materials/${f}`), ...images.map((m) => `${m.id}（${m.src}）`)],
    imagesText: readImages(dir).length ? listImages(readImages(dir)) : '',
    browser: endpoint ? mode : '',
    script: path.join(paths.codexHome(), 'skills', 'wechat-publish', 'scripts', 'fill-mp.mjs'),
    interrupted,
  });
  const lastFile = path.join(dir, 'out', '.last-reply.txt');
  fs.rmSync(lastFile, { force: true });
  const base = endpoint ? browserMcpArgs(endpoint) : settings.imageApiBase ? NETWORK_ARGS : [];
  const once = (extra, sid) => {
    if (ctx.reason) return Promise.resolve(-1);
    const run = runCodex({ cwd: dir, prompt, settings, extraArgs: [...base, ...extra], resumeId: sid, lastMessageFile: lastFile, onLog: say });
    ctx.cancel = run.cancel;
    return run.done;
  };
  const vision = visionArgs(dir, images, settings);
  let code = await once(vision, resumeId);
  if (!resumeId) {
    const sid = job.log.map((l) => SESSION_RE.exec(l)?.[1]).find(Boolean);
    if (sid) saveSession(job.id, sid);
  }
  if (code !== 0 && vision !== TEXT_ONLY && !ctx.reason) {
    noVision.add(`${settings.baseUrl}|${settings.model}`);
    say('[提示] 当前模型不支持看图，改为不看图重试（可在设置里选一个「看图模型」）');
    code = await once(TEXT_ONLY, readSession(job.id));
  }
  fs.rmSync(path.join(dir, 'cdp.json'), { force: true });
  let reply = '';
  try { reply = fs.readFileSync(lastFile, 'utf8').trim(); } catch { /* 无回复 */ }
  finish(job, ctx, code, code === 0 ? '' : 'AI 执行未成功，看下方日志', reply);
}

function finish(job, ctx, code, error, reply = '') {
  const { check } = readArticle(job.id);
  job.check = check;
  job.notice = '';
  job.updatedAt = Date.now();
  if (ctx.reason) {
    // 插话：不留回复，紧接着的新一轮会接手；停止：留一条记录
    job.status = 'stopped';
    job.error = '';
    log(job)(ctx.reason === 'stop' ? '[已停止] 用户停止了本轮' : '[插话] 用户发来新消息，打断本轮');
    if (ctx.reason === 'stop') appendChat(job.id, { role: 'assistant', text: '（已停止。已改动的内容会保留，可以接着说下一步。）', ok: false });
  } else {
    job.status = code === 0 ? 'done' : 'failed';
    job.error = error;
    appendChat(job.id, { role: 'assistant', text: reply || (error ? `（出错了：${error}）` : '（已处理）'), ok: code === 0 });
  }
  persist(job);
}

export { readChat };
