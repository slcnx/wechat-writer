import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeImages, extractText } from '../src/vision.js';
import { decodeFiles, saveMaterials, readImages, describeImages as describeList } from '../src/materials.js';
import { mergeSettings, DEFAULTS } from '../src/config.js';

const FX = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');

test('extractText 兼容 output_text 与 output[].content[]', () => {
  assert.equal(extractText({ output_text: ' a ' }), 'a');
  assert.equal(extractText({ output: [{ type: 'reasoning' }, { type: 'message', content: [{ type: 'output_text', text: '黄底黑字' }] }] }), '黄底黑字');
});

test('看图模型：图片以 base64 发出，描述写回 images.json 与 图片说明.md，失败的跳过', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxw-vis-'));
  const png = fs.readFileSync(path.join(FX, 'green.png')).toString('base64');
  await saveMaterials(dir, decodeFiles([{ name: 'a.png', content: png }, { name: 'b.png', content: png }]));
  const calls = [];
  const fake = async (url, opt) => {
    const body = JSON.parse(opt.body);
    calls.push({ url, body, auth: opt.headers.Authorization });
    if (calls.length === 2) return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
    return { ok: true, status: 200, json: async () => ({ output_text: '一块纯绿色的色块' }) };
  };
  const logs = [];
  const n = await describeImages(dir, { ...DEFAULTS, baseUrl: 'http://gw/v1', apiKey: 'k', visionModel: 'gemma-x' }, (l) => logs.push(l), fake);
  assert.equal(n, 1);
  assert.equal(calls[0].url, 'http://gw/v1/responses');
  assert.equal(calls[0].body.model, 'gemma-x');
  assert.equal(calls[0].auth, 'Bearer k');
  assert.match(calls[0].body.input[0].content[1].image_url, /^data:image\/png;base64,iVBOR/);
  const imgs = readImages(dir);
  assert.equal(imgs[0].desc, '一块纯绿色的色块');
  assert.equal(imgs[1].desc, undefined);
  assert.match(fs.readFileSync(path.join(dir, 'materials', '图片说明.md'), 'utf8'), /图1（images\/img01\.png）：一块纯绿色的色块/);
  assert.match(describeList(imgs), /图1 = images\/img01\.png（来源：a\.png） 画面：一块纯绿色的色块/);
  assert.ok(logs.some((l) => /图2 失败/.test(l)));
  assert.equal(await describeImages(dir, { ...DEFAULTS, visionModel: '' }, () => {}, fake), 0, '未设置看图模型时不调用');
});

test('看图模型设置校验', () => {
  assert.equal(mergeSettings(DEFAULTS, { visionModel: 'gemma-4-31b-it' }).visionModel, 'gemma-4-31b-it');
  assert.equal(mergeSettings(DEFAULTS, { visionModel: '' }).visionModel, '');
  assert.throws(() => mergeSettings(DEFAULTS, { visionModel: 'a b' }));
});
