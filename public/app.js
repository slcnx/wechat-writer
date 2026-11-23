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
async function loadSettings() {
  const s = await call('/api/settings');
  $('baseUrl').value = s.baseUrl;
  $('apiKey').placeholder = s.hasKey ? `已保存 ${s.apiKeyHint}，留空表示不修改` : '网关不校验可留空';
  $('author').value = s.author;
  $('browser').value = s.browser;
  $('browserMcp').checked = s.browserMcp;
  $('sandbox').value = s.sandbox;
  $('model').innerHTML = `<option>${s.model}</option>`;
  return s;
}
function settingsPatch() {
  return { baseUrl: $('baseUrl').value, apiKey: $('apiKey').value, model: $('model').value, author: $('author').value, browser: $('browser').value, sandbox: $('sandbox').value, browserMcp: $('browserMcp').checked };
}
$('btnSettings').onclick = () => $('paneSettings').classList.toggle('hidden');
$('presetDeepseek').onclick = () => {
  $('baseUrl').value = 'https://api.deepseek.com';
  $('model').innerHTML = '<option selected>deepseek-flash</option><option>deepseek-v4-pro</option>';
  msg($('settingsMsg'), '已填入 DeepSeek 官方地址，粘贴 Key 后点「测试连接」或直接保存');
};
$('btnSave').onclick = async () => {
  try { await call('/api/settings', settingsPatch()); $('apiKey').value = ''; await loadSettings(); msg($('settingsMsg'), '已保存', 'ok'); if (!$('sandbox').value.startsWith('workspace')) msg($('settingsMsg'), '已保存（注意：已开启完全访问，素材里的恶意指令可能操作你的电脑）', 'err'); } catch (e) { msg($('settingsMsg'), e.message, 'err'); }
};
$('btnTest').onclick = async () => {
  msg($('settingsMsg'), '连接中…');
  try {
    const want = $('model').value;
    await call('/api/settings', { baseUrl: $('baseUrl').value, apiKey: $('apiKey').value });
    const { models } = await call('/api/models');
    const ds = models.filter((m) => /deepseek/i.test(m));
    const list = [...ds, ...models.filter((m) => !ds.includes(m))];
    $('model').innerHTML = list.map((m) => `<option ${m === want ? 'selected' : ''}>${m}</option>`).join('');
    msg($('settingsMsg'), `连接成功，共 ${models.length} 个模型（DeepSeek 已置顶），选好后点保存`, 'ok');
  } catch (e) { msg($('settingsMsg'), `连接失败：${e.message}`, 'err'); }
};

// ---------- 生成 ----------
function readFile(f) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve({ name: f.name, content: String(r.result).split(',')[1] || '' });
    r.onerror = reject;
    r.readAsDataURL(f);
  });
}
$('btnGenerate').onclick = async () => {
  const btn = $('btnGenerate');
  btn.disabled = true;
  try {
    const files = await Promise.all([...$('files').files].map(readFile));
    const body = { title: $('title').value, style: $('style').value, length: $('length').value, audience: $('audience').value, materials: $('materials').value, extra: $('extra').value, files };
    const { id } = await call('/api/generate', body);
    msg($('genMsg'), 'AI 正在写作，通常 1~5 分钟…');
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
  $('btnCopy').disabled = !a.body;
  $('btnPublish').disabled = !c.ok;
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
    await call(`/api/jobs/${currentId}/revise`, { instruction: $('revise').value });
    $('revise').value = '';
    msg($('genMsg'), '正在按意见修改…');
    select(currentId);
  } catch (e) { msg($('pubMsg'), e.message, 'err'); }
};

$('btnCopy').onclick = async () => {
  const a = await call(`/api/articles/${currentId}`);
  const plain = $('preview').contentDocument?.getElementById('js_content')?.innerText || '';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([a.body], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
    msg($('pubMsg'), '已复制。到公众号编辑器正文处 Ctrl+V 粘贴即可（标题单独填写）', 'ok');
  } catch (e) { msg($('pubMsg'), `复制失败：${e.message}`, 'err'); }
};

$('btnOpenMp').onclick = async () => {
  try { await call('/api/open-mp', {}); msg($('pubMsg'), '已在独立浏览器中打开公众号后台，首次需扫码登录', 'ok'); } catch (e) { msg($('pubMsg'), e.message, 'err'); }
};

$('btnPublish').onclick = async () => {
  try {
    await call(`/api/publish/${currentId}`, {});
    watchPublish();
  } catch (e) { msg($('pubMsg'), e.message, 'err'); }
};
async function watchPublish() {
  const s = await call('/api/publish-status');
  msg($('pubMsg'), s.message, s.phase === 'error' ? 'err' : s.phase === 'ready' ? 'ok' : '');
  const pl = $('pubLog');
  if (s.log?.length) { pl.classList.remove('hidden'); pl.textContent = s.log.slice(-80).join('\n'); pl.scrollTop = pl.scrollHeight; }
  if (['opening', 'login', 'editing'].includes(s.phase)) setTimeout(watchPublish, 1500);
}

loadSettings().then((s) => { if (!s.hasKey && /deepseek\.com/.test(s.baseUrl)) $('paneSettings').classList.remove('hidden'); });
refreshHistory();
