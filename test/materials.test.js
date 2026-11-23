import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFiles, saveMaterials, readImages, describeImages, safeFileName, kindOf } from '../src/materials.js';
import { validateArticle, localizeImages } from '../src/article.js';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const b64 = (f) => fs.readFileSync(path.join(FX, f)).toString('base64');

test('文件类型与文件名', () => {
  assert.equal(kindOf('a.JPG'), 'image');
  assert.equal(kindOf('b.docx'), 'docx');
  assert.equal(kindOf('c.pdf'), 'pdf');
  assert.equal(kindOf('d.md'), 'text');
  assert.equal(kindOf('e.exe'), null);
  assert.throws(() => decodeFiles([{ name: 'virus.exe', content: '' }]), /不支持/);
  assert.equal(safeFileName('../../a.md', 0), 'a.md');
  assert.equal(safeFileName('.hidden', 3), 'file-3.txt');
  assert.equal(safeFileName('成都 美食.md', 0), '成都_美食.md');
});

test('图片编号、Word 提取文字与内嵌图片、PDF 提取文字、修改时接着编号', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxw-mat-'));
  const r1 = await saveMaterials(dir, decodeFiles([
    { name: '店门口.png', content: b64('green.png') },
    { name: '采访.docx', content: b64('sample.docx') },
    { name: '菜单.pdf', content: b64('sample.pdf') },
    { name: '笔记.md', content: Buffer.from('# 笔记\n火锅').toString('base64') },
  ]));
  assert.deepEqual(r1.images.map((m) => [m.id, m.src]), [['图1', 'images/img01.png'], ['图2', 'images/img02.png']]);
  assert.match(r1.images[1].from, /采访\.docx 内嵌图片/);
  const docTxt = fs.readFileSync(path.join(dir, 'materials', r1.saved.find((f) => f.includes('docx'))), 'utf8');
  assert.match(docTxt, /宽窄巷子的三大炮/);
  assert.match(docTxt, /图2/);
  const pdfTxt = fs.readFileSync(path.join(dir, 'materials', r1.saved.find((f) => f.includes('pdf'))), 'utf8');
  assert.match(pdfTxt, /Chengdu hotpot/);
  assert.ok(r1.saved.some((f) => f.endsWith('笔记.md')));
  const r2 = await saveMaterials(dir, decodeFiles([{ name: 'new.jpg', content: b64('green.png') }]), '修改时补充：');
  assert.deepEqual(r2.images.map((m) => m.id), ['图3']);
  assert.equal(readImages(dir).length, 3);
  assert.match(describeImages(readImages(dir)), /图3 = images\/img03\.jpg（来源：修改时补充：new\.jpg）/);
});

test('图片校验与预览地址', () => {
  const images = [{ id: '图1', src: 'images/img01.png' }, { id: '图2', src: 'images/img02.jpg' }];
  const text = `<p>${'字'.repeat(300)}</p>`;
  const ok = validateArticle({ title: 't' }, `${text}<p><img src="images/img01.png"></p>`, images);
  assert.equal(ok.ok, true);
  assert.equal(ok.images, 1);
  const bad = validateArticle({ title: 't' }, `${text}<img src="images/img09.png">`, images);
  assert.equal(bad.ok, false);
  assert.match(bad.problems[0], /img09/);
  const unused = validateArticle({ title: 't' }, text, images);
  assert.match(unused.warnings.join(), /2 张图片但正文一张都没用/);
  assert.equal(localizeImages('<img alt="x" src="images/img01.png">', '20261123-000000-abcd'), '<img alt="x" src="/media/20261123-000000-abcd/img01.png">');
});
