// 图片登记：与应用 src/materials.js 同一套规则——文件放 materials/images/imgNN.ext，
// 清单 materials/images.json 追加 { id: "图N", src, from, credit }，编号接着已有的往后排。
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' };

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) out[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
    else out._.push(argv[i]);
  }
  return out;
}

export function extOf(type, url = '') {
  const t = String(type || '').split(';')[0].trim();
  if (EXT[t]) return EXT[t];
  const m = /\.(png|jpe?g|webp|gif)(\?|$)/i.exec(url);
  return m ? `.${m[1].toLowerCase().replace('jpeg', 'jpg')}` : '.jpg';
}

/** 把图片写进文章素材并登记编号；返回 { id, src, from, credit }。 */
export function registerImage(dir, buf, ext, from, credit = '') {
  if (!buf?.length || buf.length < 2048) throw new Error('图片为空或过小');
  const mdir = path.join(dir, 'materials');
  fs.mkdirSync(path.join(mdir, 'images'), { recursive: true });
  const listFile = path.join(mdir, 'images.json');
  let list = [];
  try { list = JSON.parse(fs.readFileSync(listFile, 'utf8').replace(/^﻿/, '')); } catch { /* 还没有图片 */ }
  const n = list.length + 1;
  const file = `img${String(n).padStart(2, '0')}${ext === '.webp' ? '.webp' : ext}`;
  fs.writeFileSync(path.join(mdir, 'images', file), buf);
  const item = { id: `图${n}`, src: `images/${file}`, from, ...(credit ? { credit } : {}) };
  list.push(item);
  const tmp = `${listFile}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, listFile);
  return item;
}

export function playwright() {
  const root = process.env.WX_WRITER_APP_ROOT;
  return createRequire(root ? path.join(root, 'package.json') : import.meta.url)('playwright-core');
}

export function cdpEndpoint(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'cdp.json'), 'utf8')).endpoint; } catch { return ''; }
}

export const done = (obj) => { console.log(JSON.stringify(obj, null, 1)); process.exit(obj.ok === false ? 1 : 0); };
