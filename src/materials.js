// 素材落盘：文本原样保存；Word/PDF 提取文字（Word 里的图片一并取出）；图片编号为 图1、图2……
// 图片统一放 materials/images/imgNN.ext，清单在 materials/images.json，正文里用 src="images/imgNN.ext" 引用。
import fs from 'node:fs';
import path from 'node:path';
import { writeFileAtomic, readJsonSafe } from './fsutil.js';

export const IMAGE_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp'];
export const TEXT_EXT = ['.txt', '.md', '.markdown', '.html', '.htm', '.csv', '.json'];
export const DOC_EXT = ['.docx', '.pdf'];
export const ACCEPT = [...IMAGE_EXT, ...TEXT_EXT, ...DOC_EXT].join(',');
const MAX_FILE = 15 * 1024 * 1024;
const MIME_EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

export function safeFileName(name, i) {
  const base = path.basename(String(name || '')).replace(/[^\w.一-龥-]/g, '_').slice(0, 80);
  return base && !base.startsWith('.') ? base : `file-${i}.txt`;
}

export function kindOf(name) {
  const ext = path.extname(String(name)).toLowerCase();
  if (IMAGE_EXT.includes(ext)) return 'image';
  if (TEXT_EXT.includes(ext)) return 'text';
  if (DOC_EXT.includes(ext)) return ext.slice(1);
  return null;
}

/** 解码并校验上传文件；不支持的类型或超限直接抛错（在写盘之前）。 */
export function decodeFiles(files) {
  return (Array.isArray(files) ? files : []).map((f, i) => {
    const kind = kindOf(f.name);
    if (!kind) throw new Error(`不支持的文件类型：${f.name}（支持 ${ACCEPT}）`);
    const buf = Buffer.from(String(f.content || ''), 'base64');
    if (buf.length > MAX_FILE) throw new Error(`${f.name} 超过 15MB`);
    return { name: safeFileName(f.name, i), kind, buf };
  });
}

export function readImages(dir) {
  return readJsonSafe(path.join(dir, 'materials', 'images.json'), []);
}

function addImage(dir, images, buf, ext, from) {
  const n = images.length + 1;
  const file = `img${String(n).padStart(2, '0')}${ext}`;
  writeFileAtomic(path.join(dir, 'materials', 'images', file), buf);
  images.push({ id: `图${n}`, src: `images/${file}`, from });
  return images[images.length - 1];
}

async function docxToText(dir, buf, name, images) {
  const mammoth = (await import('mammoth')).default;
  const found = [];
  await mammoth.convertToHtml({ buffer: buf }, {
    convertImage: mammoth.images.imgElement(async (img) => {
      const data = Buffer.from(await img.read('base64'), 'base64');
      const ext = MIME_EXT[img.contentType];
      if (ext) found.push(addImage(dir, images, data, ext, `${name} 内嵌图片`).id);
      return { src: '' };
    }),
  });
  const { value } = await mammoth.extractRawText({ buffer: buf });
  return found.length ? `${value}\n\n（本文档内嵌图片已提取为：${found.join('、')}）` : value;
}

async function pdfToText(buf) {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { text } = await extractText(pdf, { mergePages: true });
  return text;
}

/**
 * 保存一批素材到 <dir>/materials，返回 { saved: [文件名], images: 本次新增图片 }。
 * 图片编号在已有基础上递增（修改意见时补传的图片接着编号）。
 */
export async function saveMaterials(dir, decoded, prefix = '') {
  const mdir = path.join(dir, 'materials');
  fs.mkdirSync(path.join(mdir, 'images'), { recursive: true });
  const images = readImages(dir);
  const before = images.length;
  const saved = [];
  let i = fs.readdirSync(mdir).filter((f) => /^\d{2}-/.test(f)).length;
  for (const f of decoded) {
    if (f.kind === 'image') {
      addImage(dir, images, f.buf, path.extname(f.name).toLowerCase().replace('.jpeg', '.jpg'), `${prefix}${f.name}`);
      continue;
    }
    i += 1;
    const base = `${String(i).padStart(2, '0')}-${f.name}`;
    if (f.kind === 'text') {
      writeFileAtomic(path.join(mdir, base), f.buf);
      saved.push(base);
    } else {
      const text = f.kind === 'docx' ? await docxToText(dir, f.buf, f.name, images) : await pdfToText(f.buf);
      writeFileAtomic(path.join(mdir, `${base}.txt`), `【从 ${f.name} 提取的文字】\n\n${text}`);
      saved.push(`${base}.txt`);
    }
  }
  writeFileAtomic(path.join(mdir, 'images.json'), JSON.stringify(images, null, 2));
  return { saved, images: images.slice(before) };
}

/** 给 prompt 用的图片清单文字。 */
export function describeImages(images) {
  if (!images.length) return '本篇没有图片素材。';
  return ['图片素材（正文里用 src="images/文件名" 引用）：', ...images.map((m) => `- ${m.id} = ${m.src}（来源：${m.from}）${m.desc ? ` 画面：${m.desc}` : ''}`)].join('\n');
}
