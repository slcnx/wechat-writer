#!/usr/bin/env node
// 公众号写作助手：本地 Web 应用（只监听 127.0.0.1），Windows / macOS / Linux 通用。
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, loadSettings, saveSettings, publicSettings, mergeSettings } from './config.js';
import { readJson, sendJson, sendHtml, serveStatic } from './http.js';
import { getJob, listJobs, readArticle, readChat, isValidId, jobDir } from './jobs.js';
import { previewPage, localizeImages } from './article.js';
import fs from 'node:fs';
import { sendMessage, stopTurn } from './chat.js';
import { browserReady } from './publisher.js';

const PORT = Number(process.env.WX_WRITER_PORT || 8848);
const PUBLIC = path.join(APP_ROOT, 'public');

async function listModels(s) {
  const r = await fetch(`${s.baseUrl}/models`, {
    headers: s.apiKey ? { Authorization: `Bearer ${s.apiKey}` } : {},
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`网关返回 HTTP ${r.status}`);
  const data = await r.json();
  return (data.data || []).map((m) => m.id).sort();
}

async function api(req, res, url) {
  const p = url.pathname;
  const settings = loadSettings();

  if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, publicSettings(settings));
  if (p === '/api/settings' && req.method === 'POST') return sendJson(res, 200, publicSettings(saveSettings(await readJson(req))));
  if (p === '/api/models' && (req.method === 'GET' || req.method === 'POST')) {
    // POST 可带未保存的 baseUrl / apiKey 试连（apiKey 为空则用已保存的），用于设置页自动拉取模型列表
    const probe = req.method === 'POST' ? mergeSettings(settings, await readJson(req)) : settings;
    const models = await listModels(probe);
    return sendJson(res, 200, { models, current: settings.model, vision: settings.visionModel, available: models.includes(settings.model) });
  }
  if (p === '/api/jobs' && req.method === 'GET') return sendJson(res, 200, { jobs: listJobs(), browser: browserReady() });
  // 唯一入口：一条消息（可带图片/文档），没有 id 就开一篇新文章
  if (p === '/api/chat' && req.method === 'POST') {
    const body = await readJson(req);
    if (body.id && !isValidId(body.id)) return sendJson(res, 400, { error: '非法文章 id' });
    return sendJson(res, 200, await sendMessage(body, settings));
  }
  const stop = /^\/api\/jobs\/([^/]+)\/stop$/.exec(p);
  if (stop && req.method === 'POST') {
    if (!isValidId(stop[1])) return sendJson(res, 400, { error: '非法文章 id' });
    return sendJson(res, 200, await stopTurn(stop[1]));
  }
  const m = /^\/api\/(jobs|articles)\/([^/]+)$/.exec(p);
  if (!m || !isValidId(m[2]) || req.method !== 'GET') return sendJson(res, 404, { error: '接口不存在' });
  const [, kind, id] = m;
  if (!fs.existsSync(jobDir(id))) return sendJson(res, 404, { error: '文章不存在' });
  if (kind === 'jobs') {
    const { log = [], ...job } = getJob(id) || { id, status: 'idle' };
    return sendJson(res, 200, { ...job, log: log.slice(-150), chat: readChat(id) });
  }
  return sendJson(res, 200, readArticle(id));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(req.headers.host || '')) return sendJson(res, 403, { error: '仅允许本机访问' });
    if (url.pathname.startsWith('/api/')) {
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').includes('application/json')) {
        return sendJson(res, 415, { error: '需要 application/json' }); // 阻止跨站表单 CSRF
      }
      return await api(req, res, url);
    }
    const pv = /^\/preview\/([^/]+)$/.exec(url.pathname);
    if (pv && isValidId(pv[1])) {
      const { meta, body } = readArticle(pv[1]);
      return sendHtml(res, body ? previewPage(meta, localizeImages(body, pv[1])) : '<p>尚未生成成稿</p>');
    }
    const md = /^\/media\/([^/]+)\/(img\d{2}\.(?:png|jpg|gif|webp))$/.exec(url.pathname);
    if (md && isValidId(md[1])) {
      const file = path.join(jobDir(md[1]), 'materials', 'images', md[2]);
      if (fs.existsSync(file)) {
        res.writeHead(200, { 'Content-Type': `image/${md[2].endsWith('jpg') ? 'jpeg' : md[2].split('.').pop()}`, 'Cache-Control': 'no-store' });
        return fs.createReadStream(file).pipe(res);
      }
    }
    if (!serveStatic(res, PUBLIC, url.pathname)) sendJson(res, 404, { error: 'not found' });
  } catch (e) {
    sendJson(res, 400, { error: e.message });
  }
});

function openBrowser(u) {
  const [cmd, args] = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', u]]
    : process.platform === 'darwin' ? ['open', [u]] : ['xdg-open', [u]];
  spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true }).on('error', () => {}).unref();
}

server.listen(PORT, '127.0.0.1', () => {
  const u = `http://127.0.0.1:${PORT}/`;
  console.log(`公众号写作助手已启动：${u}（关闭此窗口即退出）`);
  if (!process.argv.includes('--no-open')) openBrowser(u);
});
