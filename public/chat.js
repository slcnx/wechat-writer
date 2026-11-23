// 对话：唯一入口（一句话 + 图片/材料），右侧预览与图库。依赖 app.js 的 $ / call / msg。
let currentId = null;
let pollTimer = null;
const picker = Mat.picker('files', 'fileList', () => (window.currentImageCount || 0) + 1);
const WELCOME = $('chat').firstElementChild.cloneNode(true);

function bubble(role, text, files = []) {
  const div = document.createElement('div');
  div.className = `bubble ${role === 'user' ? 'me' : 'ai'}`;
  div.textContent = text || '';
  if (files.length) {
    const f = document.createElement('div');
    f.className = 'files';
    f.textContent = `📎 ${files.join('、')}`;
    div.append(f);
  }
  return div;
}

function renderChat(chat, running) {
  const box = $('chat');
  box.replaceChildren(WELCOME.cloneNode(true), ...chat.map((m) => bubble(m.role, m.text, m.files)));
  if (running) {
    const t = bubble('ai', 'AI 正在处理…');
    t.classList.add('typing');
    box.append(t);
  }
  box.scrollTop = box.scrollHeight;
}

const STATUS = { running: 'AI 处理中…', done: '', failed: '上次出错' };
async function refreshHistory() {
  const { jobs } = await call('/api/jobs');
  const items = jobs.map((j) => {
    const li = document.createElement('li');
    li.className = j.id === currentId ? 'active' : '';
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = j.title;
    const st = document.createElement('span');
    st.className = 'st';
    st.textContent = `${j.id.slice(4, 6)}-${j.id.slice(6, 8)} ${j.id.slice(9, 11)}:${j.id.slice(11, 13)}${STATUS[j.status] ? ` · ${STATUS[j.status]}` : ''}`;
    li.append(t, st);
    li.onclick = () => open(j.id);
    return li;
  });
  $('history').replaceChildren(...items);
}

async function poll() {
  if (!currentId) return;
  clearTimeout(pollTimer);
  const job = await call(`/api/jobs/${currentId}`).catch(() => null);
  if (!job) return;
  const running = job.status === 'running';
  renderChat(job.chat || [], running);
  $('status').classList.toggle('hidden', !job.notice);
  $('status').textContent = job.notice || '';
  $('logBox').classList.toggle('hidden', !(job.log || []).length);
  $('log').textContent = (job.log || []).join('\n');
  $('btnSend').disabled = running;
  if (running) { pollTimer = setTimeout(poll, 2000); return; }
  await showArticle(currentId);
  refreshHistory();
}

async function showArticle(id) {
  const a = await call(`/api/articles/${id}`).catch(() => null);
  if (!a) return;
  window.currentImageCount = (a.images || []).length;
  picker.render();
  Mat.gallery('gallery', a.images || [], id, a.meta.images || [], 'msg', a.meta.cover || '');
  $('btnCopy').disabled = !a.body;
  if (!a.body) { $('preview').src = 'about:blank'; $('checkBox').classList.add('hidden'); return; }
  const c = a.check;
  const lines = [`字数 ${c.chars}`, ...c.problems.map((p) => `✗ ${p}`), ...c.warnings.map((w) => `! ${w}`)];
  if (a.meta.todo?.length) lines.push(`待核实：${a.meta.todo.join('；')}`);
  $('checkBox').textContent = (c.ok ? '✓ 校验通过 · ' : '✗ 未通过 · ') + lines.join('  ');
  $('checkBox').className = `check ${c.ok ? 'good' : 'bad'}`;
  $('preview').src = `/preview/${id}?t=${Date.now()}`;
}

async function open(id) {
  currentId = id || null;
  $('preview').src = 'about:blank';
  $('checkBox').classList.add('hidden');
  $('gallery').classList.add('hidden');
  $('logBox').classList.add('hidden');
  window.currentImageCount = 0;
  await refreshHistory();
  if (!id) { renderChat([], false); $('btnCopy').disabled = true; picker.render(); $('msg').focus(); return; }
  await poll();
}

async function send() {
  const text = $('msg').value.trim();
  if (!text && !picker.count()) return msg($('pubMsg'), '先说点什么或上传素材', 'err');
  $('btnSend').disabled = true;
  try {
    const files = await picker.read();
    const { id } = await call('/api/chat', { id: currentId, message: text, files });
    $('msg').value = '';
    picker.clear();
    msg($('pubMsg'), '');
    currentId = id;
    await refreshHistory();
    poll();
  } catch (e) {
    msg($('pubMsg'), e.message, 'err');
    $('btnSend').disabled = false;
  }
}

$('btnSend').onclick = send;
$('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) send(); });
$('btnNew').onclick = () => open(null);

$('btnCopy').onclick = async () => {
  const a = await call(`/api/articles/${currentId}`);
  const hasLocal = /src=["']images\//.test(a.body);
  const plain = $('preview').contentDocument?.getElementById('js_content')?.innerText || '';
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([a.body], { type: 'text/html' }), 'text/plain': new Blob([plain], { type: 'text/plain' }) })]);
    msg($('pubMsg'), `已复制，可到公众号编辑器正文处粘贴${hasLocal ? '（本地图片不会随手动粘贴上传，建议对 AI 说"填进公众号"）' : ''}`, hasLocal ? '' : 'ok');
  } catch (e) { msg($('pubMsg'), `复制失败：${e.message}`, 'err'); }
};

open(null);
