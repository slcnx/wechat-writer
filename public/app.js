// 前端逻辑：设置、生成、轮询日志、预览、复制富文本、触发浏览器填稿。
const $ = (id) => document.getElementById(id);
let currentId = null;
let pollTimer = null;

async function call(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
  return data;
}
function msg(el, text, kind = '') { el.textContent = text; el.className = `msg ${kind}`; }

// ---------- 设置 ----------
let saved = {};
async function loadSettings() {
  saved = await call('/api/settings');
  $('baseUrl').value = saved.baseUrl;
  $('apiKey').value = '';
  $('apiKey').placeholder = saved.hasKey ? `已保存 ${saved.apiKeyHint}，留空表示不修改` : 'sk-...（网关不校验可留空）';
  $('author').value = saved.author;
  $('browser').value = saved.browser;
  $('sandbox').value = saved.sandbox;
  fillModels([saved.model], saved.model, saved.visionModel);
  return saved;
}
function fillModels(models, model, vision) {
  const opt = (m, sel) => { const o = document.createElement('option'); o.value = m; o.textContent = m; o.selected = m === sel; return o; };
  const list = [...new Set([model, ...models].filter(Boolean))];
  $('model').replaceChildren(...list.map((m) => opt(m, model)));
  const none = opt('', vision); none.textContent = '不单独设置（用写作模型看图）';
  $('visionModel').replaceChildren(none, ...[...new Set([vision, ...models].filter(Boolean))].map((m) => opt(m, vision)));
}
// 推荐的写作模型（按优先级）：网关上的 1017 版 deepseek flash 优先，其次 DeepSeek 官方 deepseek-flash
const PREFER = [/^deepseek-v4\.1-flash-1017$/i, /deepseek.*flash.*1017/i, /^deepseek-flash$/i, /^deepseek-v4\.1-flash$/i, /deepseek.*flash/i];
function recommend(models) {
  for (const re of PREFER) { const m = models.find((x) => re.test(x)); if (m) return m; }
  return models.find((m) => /deepseek/i.test(m)) || models[0] || '';
}
/** 用当前填写（未保存也可）的地址和 Key 拉取模型列表；推荐模型置顶并在未手动选择时自动选中。 */
async function refreshModels() {
  msg($('settingsMsg'), '正在获取模型列表…');
  try {
    const { models } = await call('/api/models', { baseUrl: $('baseUrl').value, apiKey: $('apiKey').value });
    const rec = recommend(models);
    const rest = models.filter((m) => m !== rec);
    const sorted = [rec, ...rest.filter((m) => /deepseek/i.test(m)), ...rest.filter((m) => !/deepseek/i.test(m))].filter(Boolean);
    const keep = saved.modelPinned && sorted.includes($('model').value);
    fillModels(sorted, keep ? $('model').value : rec, $('visionModel').value);
    const recOpt = [...$('model').options].find((o) => o.value === rec);
    if (recOpt) recOpt.textContent = `${rec}（推荐）`;
    $('modelHint').textContent = `共 ${models.length} 个可选${keep ? '' : `，已自动选推荐模型`}`;
    msg($('settingsMsg'), '已获取模型列表，选好后点保存', 'ok');
  } catch (e) {
    $('modelHint').textContent = '';
    msg($('settingsMsg'), `获取模型失败：${e.message}（检查地址和 Key）`, 'err');
  }
}
function settingsPatch() {
  return { baseUrl: $('baseUrl').value, apiKey: $('apiKey').value, model: $('model').value, modelPinned: true, visionModel: $('visionModel').value, author: $('author').value, browser: $('browser').value, sandbox: $('sandbox').value };
}
$('btnSettings').onclick = () => {
  const pane = $('paneSettings');
  pane.classList.toggle('hidden');
  if (!pane.classList.contains('hidden')) refreshModels();
};
$('presetDeepseek').onclick = () => { $('baseUrl').value = 'https://api.deepseek.com'; refreshModels(); };
$('baseUrl').addEventListener('change', refreshModels);
$('apiKey').addEventListener('change', refreshModels);
$('btnTest').onclick = refreshModels;
$('btnSave').onclick = async () => {
  try {
    await call('/api/settings', settingsPatch());
    await loadSettings();
    await refreshModels();
    if ($('sandbox').value.startsWith('workspace')) msg($('settingsMsg'), '已保存', 'ok');
    else msg($('settingsMsg'), '已保存（注意：已开启完全访问，素材里的恶意指令可能操作你的电脑）', 'err');
  } catch (e) { msg($('settingsMsg'), e.message, 'err'); }
};

// ---------- 生成 ----------
let currentImages = [];
const mainPicker = Mat.picker('files', 'fileList');
const revisePicker = Mat.picker('reviseFiles', 'reviseList', () => currentImages.length + 1);
$('btnGenerate').onclick = async () => {
  const btn = $('btnGenerate');
  btn.disabled = true;
  try {
    const files = await mainPicker.read();
    const body = { title: $('title').value, style: $('style').value, length: $('length').value, audience: $('audience').value, materials: $('materials').value, extra: $('extra').value, files };
    const { id } = await call('/api/generate', body);
    msg($('genMsg'), 'AI 正在写作，通常 1~5 分钟…');
    mainPicker.clear();
    select(id);
  } catch (e) { msg($('genMsg'), e.message, 'err'); btn.disabled = false; }
};

async function poll() {
  if (!currentId) return;
  const job = await call(`/api/jobs/${currentId}`).catch(() => null);
  if (!job) return;
  const log = $('log');
  log.classList.remove('hidden');
  log.textContent = (job.log || []).slice(-120).join('\n');
  log.scrollTop = log.scrollHeight;
  if (job.status === 'running') { pollTimer = setTimeout(poll, 2000); return; }
  $('btnGenerate').disabled = false;
  $('btnRevise').disabled = false;
  if (job.status === 'done') msg($('genMsg'), '写好了，右侧预览', 'ok');
  else msg($('genMsg'), job.error || '生成失败，看日志', 'err');
  await showArticle(currentId);
  refreshHistory();
}

async function select(id) {
  clearTimeout(pollTimer);
  currentId = id;
  ['btnCopy', 'btnPublish', 'btnRevise'].forEach((b) => { $(b).disabled = true; });
  $('preview').src = 'about:blank';
  $('checkBox').classList.add('hidden');
  await refreshHistory();
  poll();
}

async function showArticle(id) {
  const a = await call(`/api/articles/${id}`);
  const box = $('checkBox');
  box.classList.remove('hidden');
  const c = a.check;
  const lines = [`字数 ${c.chars}`, ...c.problems.map((p) => `✗ ${p}`), ...c.warnings.map((w) => `! ${w}`)];
  if (a.meta.todo?.length) lines.push(`待核实：${a.meta.todo.join('；')}`);
  box.textContent = (c.ok ? '✓ 校验通过 · ' : '✗ 未通过 · ') + lines.join('  ');
  box.className = `check ${c.ok ? 'good' : 'bad'}`;
  $('preview').src = `/preview/${id}?t=${Date.now()}`;
  currentImages = a.images || [];
  Mat.gallery('gallery', currentImages, id, a.meta.images || [], 'revise', a.meta.cover || '');
  revisePicker.render();
  $('btnCopy').disabled = !a.body;
  $('btnPublish').disabled = !c.ok;
  $('btnBrowserCmd').disabled = !a.body;
}

async function refreshHistory() {
  const { jobs } = await call('/api/jobs');
  const ul = $('history');
  ul.innerHTML = '';
  for (const j of jobs) {
    const li = document.createElement('li');
    li.className = j.id === currentId ? 'active' : '';
    const t = document.createElement('span');
    t.textContent = j.title;
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = { running: '写作中', done: '已完成', failed: '失败' }[j.status] || j.status;
    li.append(t, st);
    li.onclick = () => select(j.id);
    ul.append(li);
  }
}

// ---------- 修改 / 复制 / 发布 ----------
$('btnRevise').onclick = async () => {
  try {
    const files = await revisePicker.read();
    await call(`/api/jobs/${currentId}/revise`, { instruction: $('revise').value, files });
    $('revise').value = '';
    revisePicker.clear();
    msg($('genMsg'), '正在按意见修改…');
    select(currentId);
  } catch (e) { msg($('pubMsg'), e.message, 'err'); }
};

$('btnCopy').onclick = async () => {
  const a = await call(`/api/articles/${currentId}`);
  const hasLocal = /src=["']images\//.test(a.body);
  const plain = $('preview').contentDocument?.getElementById('js_content')?.innerText || '';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([a.body], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
    msg($('pubMsg'), `已复制。到公众号编辑器正文处 Ctrl+V 粘贴（标题单独填写）${hasLocal ? '。注意：本地图片不会随手动粘贴上传，请用「一键填入公众号草稿」' : ''}`, hasLocal ? '' : 'ok');
  } catch (e) { msg($('pubMsg'), `复制失败：${e.message}`, 'err'); }
};

$('btnOpenMp').onclick = async () => {
  try { await call('/api/open-mp', {}); msg($('pubMsg'), '已在独立浏览器中打开公众号后台，首次需扫码登录', 'ok'); } catch (e) { msg($('pubMsg'), e.message, 'err'); }
};

async function browserTask(instruction) {
  try {
    await call(`/api/publish/${currentId}`, { instruction });
    watchPublish();
  } catch (e) { msg($('pubMsg'), e.message, 'err'); }
}
$('btnPublish').onclick = () => browserTask('');
$('btnBrowserCmd').onclick = () => {
  const v = $('browserCmd').value.trim();
  if (!v) return msg($('pubMsg'), '请先写一句指令', 'err');
  $('browserCmd').value = '';
  browserTask(v);
};
async function watchPublish() {
  const s = await call('/api/publish-status');
  msg($('pubMsg'), s.message, s.phase === 'error' ? 'err' : s.phase === 'ready' ? 'ok' : '');
  const pl = $('pubLog');
  if (s.log?.length) { pl.classList.remove('hidden'); pl.textContent = s.log.slice(-80).join('\n'); pl.scrollTop = pl.scrollHeight; }
  if (['opening', 'login', 'editing'].includes(s.phase)) setTimeout(watchPublish, 1500);
}

loadSettings().then((s) => {
  if (!s.hasKey && /deepseek\.com/.test(s.baseUrl)) { $('paneSettings').classList.remove('hidden'); refreshModels(); }
});
refreshHistory();
