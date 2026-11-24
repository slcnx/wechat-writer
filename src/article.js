// 文章 HTML 的清洗、校验与预览页包装。
// 公众号编辑器只保留内联样式：<style>/<script>/class/外链脚本都会被丢弃，所以生成后先在这里把关。

const STRIP_PAIRED = /<(script|style|iframe|object|head|title)\b[\s\S]*?<\/\1\s*>/gi;
const STRIP_TAGS = /<\/?(script|style|iframe|object|embed|link|meta|head|title)\b[^>]*>/gi;

export function sanitizeBody(html) {
  let out = String(html || '');
  const doc = out.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  if (doc) out = doc[1];
  out = out.replace(/<!DOCTYPE[^>]*>/gi, '').replace(/<\/?(html|body)[^>]*>/gi, '');
  out = out.replace(STRIP_PAIRED, '').replace(STRIP_TAGS, '');
  out = out.replace(/\s+on[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
  out = out.replace(/(href|src)\s*=\s*(["'])\s*javascript:[^"']*\2/gi, '$1="#"');
  return out.trim();
}

export function textOf(html) {
  return String(html).replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, '').trim();
}

/** 返回 { ok, problems, warnings, chars }。problems 会阻止发布，warnings 只提示。 */
export function validateArticle(meta, body, images = []) {
  const problems = [];
  const warnings = [];
  const chars = textOf(body).length;
  if (!meta || !meta.title) problems.push('meta.json 缺少 title');
  else if ([...meta.title].length > 64) problems.push('标题超过 64 字（公众号上限）');
  if (meta?.digest && [...meta.digest].length > 120) warnings.push('摘要超过 120 字，公众号会截断');
  if (chars < 200) problems.push(`正文过短（${chars} 字）`);
  if (/<(script|style|iframe)\b/i.test(body)) problems.push('正文仍含 script/style/iframe');
  if (/\sclass\s*=/i.test(body)) warnings.push('正文含 class 属性，粘贴到公众号后样式会丢失，应改为内联 style');
  if (/<a\s/i.test(body)) warnings.push('正文含超链接，非公众号文章链接在发布时会被去掉');
  const srcs = (body.match(/<img\b[^>]*>/gi) || []).map((t) => (/src\s*=\s*["']([^"']*)["']/i.exec(t) || [])[1] || '');
  const known = new Set(images.map((m) => m.src));
  const missing = srcs.filter((s) => s.startsWith('images/') && !known.has(s));
  if (missing.length) problems.push(`正文引用了不存在的图片：${missing.join('、')}`);
  if (srcs.some((s) => !/^(images\/|https?:)/.test(s))) warnings.push('有无法识别的图片地址（只支持素材图片 images/… 或 https 链接）');
  const used = srcs.filter((s) => known.has(s)).length;
  if (meta?.cover && !images.some((m) => m.id === meta.cover)) warnings.push(`封面 ${meta.cover} 不在图片素材里，填稿时将跳过封面`);
  if (images.length && !used) warnings.push(`上传了 ${images.length} 张图片但正文一张都没用，可在修改意见里指定，如"图1放开头"`);
  return { ok: problems.length === 0, problems, warnings, chars, images: used };
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** 素材图片 src="images/x" 改成应用内地址，供预览与复制使用。 */
export function localizeImages(body, id) {
  return String(body).replace(/(<img\b[^>]*\bsrc\s*=\s*["'])images\/([\w.-]+)(["'])/gi, `$1/media/${id}/$2$3`);
}

/** 预览页：默认手机阅读宽度，应用里可切到电脑宽度（改 #page 的 max-width）。 */
export function previewPage(meta, body) {
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(meta.title)} - 预览</title></head>
<body style="margin:0;background:#ededed;font-family:-apple-system,'PingFang SC','Microsoft YaHei',sans-serif;">
<div id="page" style="max-width:420px;margin:0 auto;background:#fff;min-height:100vh;padding:20px 16px 40px;box-sizing:border-box;">
<h1 style="font-size:22px;line-height:1.4;font-weight:700;color:#222;margin:0 0 12px;">${esc(meta.title)}</h1>
<div style="font-size:14px;color:#576b95;margin-bottom:22px;">${esc(meta.author || '')}</div>
<div id="js_content">${body}</div>
</div></body></html>`;
}
