#!/usr/bin/env node
// 公众号写作助手：本地 Web 应用（只监听 127.0.0.1），Windows / macOS / Linux 通用。
import http from 'node:http';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, loadSettings, saveSettings, publicSettings } from './config.js';
import { readJson, sendJson, sendHtml, serveStatic } from './http.js';
import { createJob, reviseJob, getJob, listJobs, readArticle, isValidId } from './jobs.js';
import { previewPage, textOf } from './article.js';
import { fillDraft, openMp, state as publishState } from './publisher.js';

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
  const m = /^\/api\/(jobs|articles|publish)\/([^/]+)(\/[a-z]+)?$/.exec(p);
  const settings = loadSettings();

  if (p === '/api/settings' && req.method === 'GET') return sendJson(res, 200, publicSettings(settings));
  if (p === '/api/settings' && req.method === 'POST') return sendJson(res, 200, publicSettings(saveSettings(await readJson(req))));
  if (p === '/api/models' && req.method === 'GET') {
    const models = await listModels(settings);
    return sendJson(res, 200, { models, current: settings.model, available: models.includes(settings.model) });
  }
  if (p === '/api/jobs' && req.method === 'GET') return sendJson(res, 200, { jobs: listJobs() });
  if (p === '/api/generate' && req.method === 'POST') {
    const job = createJob(await readJson(req), settings);
    return sendJson(res, 200, { id: job.id });
  }
  if (p === '/api/open-mp' && req.method === 'POST') {
    await openMp(settings);
    return sendJson(res, 200, { ok: true });
  }
  if (p === '/api/publish-status' && req.method === 'GET') return sendJson(res, 200, publishState);
  if (!m || !isValidId(m[2])) return sendJson(res, 404, { error: '接口不存在' });

  const [, kind, id, action = ''] = m;
  if (kind === 'jobs' && !action && req.method === 'GET') {
    const job = getJob(id);
    return job ? sendJson(res, 200, job) : sendJson(res, 404, { error: '文章不存在' });
  }
  if (kind === 'jobs' && action === '/revise' && req.method === 'POST') {
    const { instruction } = await readJson(req);
    reviseJob(id, instruction, settings);
    return sendJson(res, 200, { id });
  }
  if (kind === 'articles' && !action && req.method === 'GET') return sendJson(res, 200, readArticle(id));
  if (kind === 'publish' && !action && req.method === 'POST') {
    const a = readArticle(id);
    if (!a.check.ok) return sendJson(res, 400, { error: `成稿未通过校验：${a.check.problems.join('；')}` });
    if (['opening', 'login', 'editing'].includes(publishState.phase)) return sendJson(res, 409, { error: '已有发布流程在进行' });
    fillDraft({ ...a, id, plain: textOf(a.body) }, settings); // 后台执行，前端轮询 publish-status
    return sendJson(res, 200, { started: true });
  }
  return sendJson(res, 404, { error: '接口不存在' });
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
      return sendHtml(res, body ? previewPage(meta, body) : '<p>尚未生成成稿</p>');
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
