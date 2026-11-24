// 前端公共函数与「接口设置」；对话与预览在 chat.js。
const $ = (id) => document.getElementById(id);

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
  $('imageApiBase').value = saved.imageApiBase || '';
  $('imageApiKey').value = '';
  $('imageApiKey').placeholder = saved.hasImageKey ? `已保存 ${saved.imageApiKeyHint}，留空表示不修改` : '可空';
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
  return { baseUrl: $('baseUrl').value, apiKey: $('apiKey').value, model: $('model').value, modelPinned: true, visionModel: $('visionModel').value, author: $('author').value, imageApiBase: $('imageApiBase').value, imageApiKey: $('imageApiKey').value, browser: $('browser').value, sandbox: $('sandbox').value };
}
function showSettings(show) {
  $('paneSettings').classList.toggle('hidden', !show);
  $('settingsMask').classList.toggle('hidden', !show);
  if (show) refreshModels();
}
$('btnSettings').onclick = () => showSettings(true);
$('btnCloseSettings').onclick = () => showSettings(false);
$('settingsMask').onclick = () => showSettings(false);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') showSettings(false); });
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

loadSettings().then((s) => {
  if (!s.hasKey && /deepseek\.com/.test(s.baseUrl)) showSettings(true);
});

// ---------- 布局：左栏收起、对话/预览拖动分隔（记在本机） ----------
(() => {
  const grid = document.querySelector('.grid');
  const sp = $('splitter');
  const applySide = (hide) => grid.classList.toggle('no-side', hide);
  const setW = (px) => { if (px) grid.style.setProperty('--chat-w', `${px}px`); else grid.style.removeProperty('--chat-w'); };
  applySide(localStorage.getItem('wx.sideHidden') === '1');
  setW(Number(localStorage.getItem('wx.chatW')) || 0);
  $('btnSide').onclick = () => {
    const hide = !grid.classList.contains('no-side');
    applySide(hide);
    localStorage.setItem('wx.sideHidden', hide ? '1' : '0');
  };
  sp.addEventListener('pointerdown', (e) => {
    const chat = document.querySelector('.chat-card');
    const left = chat.getBoundingClientRect().left;
    const max = grid.getBoundingClientRect().right - left - 380 - 20; // 预览至少留 380px
    document.body.classList.add('dragging');
    sp.setPointerCapture(e.pointerId);
    const move = (ev) => setW(Math.round(Math.min(max, Math.max(320, ev.clientX - left - 5))));
    const up = () => {
      document.body.classList.remove('dragging');
      sp.removeEventListener('pointermove', move);
      localStorage.setItem('wx.chatW', parseInt(grid.style.getPropertyValue('--chat-w'), 10) || '');
    };
    sp.addEventListener('pointermove', move);
    sp.addEventListener('pointerup', up, { once: true });
  });
  sp.ondblclick = () => { setW(0); localStorage.removeItem('wx.chatW'); };
})();
