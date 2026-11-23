#!/usr/bin/env node
// 构建免安装便携包：自带 Node 运行时 + 目标平台的 Codex 二进制，解压即用。
// 可在任意一台机器上交叉构建全部平台（npm --os/--cpu 装目标平台的可选依赖）。
// 用法：node scripts/build-dist.mjs [win-x64 win-arm64 mac-x64 mac-arm64 linux-x64 linux-arm64]
// 环境变量：NODE_VERSION（默认 24.22.3）、NODE_MIRROR（默认 https://nodejs.org/dist）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(DIST, '.cache');
const NODE_VERSION = (process.env.NODE_VERSION || '24.22.3').replace(/^v/, '');
const NODE_MIRROR = (process.env.NODE_MIRROR || 'https://nodejs.org/dist').replace(/\/+$/, '');
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const TARGETS = {
  'win-x64': { node: 'win-x64', ext: 'zip', os: 'win32', cpu: 'x64' },
  'win-arm64': { node: 'win-arm64', ext: 'zip', os: 'win32', cpu: 'arm64' },
  'mac-x64': { node: 'darwin-x64', ext: 'tar.gz', os: 'darwin', cpu: 'x64' },
  'mac-arm64': { node: 'darwin-arm64', ext: 'tar.gz', os: 'darwin', cpu: 'arm64' },
  'linux-x64': { node: 'linux-x64', ext: 'tar.xz', os: 'linux', cpu: 'x64' },
  'linux-arm64': { node: 'linux-arm64', ext: 'tar.xz', os: 'linux', cpu: 'arm64' },
};
const COPY = ['package.json', 'package-lock.json', 'src', 'public', 'skills', 'docs'];

const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: 'inherit', env: { ...process.env, COPYFILE_DISABLE: '1' } });

async function download(url, file) {
  if (fs.existsSync(file)) return file;
  console.log(`下载 ${url}`);
  const r = await fetch(url);
  if (!r.ok) throw new Error(`下载失败 HTTP ${r.status}: ${url}`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.part`, Buffer.from(await r.arrayBuffer()));
  fs.renameSync(`${file}.part`, file);
  return file;
}

/** 下载并解出 node 可执行文件到 runtime/。Windows 只要 node.exe，其他平台只要 bin/node。 */
async function addRuntime(t, stage) {
  const base = `node-v${NODE_VERSION}-${t.node}`;
  const archive = await download(`${NODE_MIRROR}/v${NODE_VERSION}/${base}.${t.ext}`, path.join(CACHE, `${base}.${t.ext}`));
  const tmp = path.join(CACHE, `x-${base}`);
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  if (t.ext === 'zip') run('unzip', ['-q', '-o', archive, '-d', tmp]);
  else run('tar', ['-xf', archive, '-C', tmp]);
  const rt = path.join(stage, 'runtime');
  fs.mkdirSync(rt, { recursive: true });
  const exe = t.os === 'win32' ? 'node.exe' : 'node';
  const src = t.os === 'win32' ? path.join(tmp, base, exe) : path.join(tmp, base, 'bin', exe);
  fs.copyFileSync(src, path.join(rt, exe));
  fs.chmodSync(path.join(rt, exe), 0o755);
  fs.copyFileSync(path.join(tmp, base, 'LICENSE'), path.join(rt, 'NODE-LICENSE'));
  fs.rmSync(tmp, { recursive: true, force: true });
}

function writeLaunchers(t, stage) {
  if (t.os === 'win32') {
    const cmd = ['@echo off', 'chcp 65001 >nul', 'title WeChat Writer', 'cd /d "%~dp0"',
      '"%~dp0runtime\\node.exe" src\\server.js %*', 'if errorlevel 1 pause', ''].join('\r\n');
    fs.writeFileSync(path.join(stage, 'start.cmd'), cmd);
    return;
  }
  const sh = '#!/bin/sh\ncd "$(dirname "$0")" || exit 1\nexec ./runtime/node src/server.js "$@"\n';
  const names = t.os === 'darwin' ? ['start.sh', 'start.command'] : ['start.sh'];
  for (const n of names) {
    fs.writeFileSync(path.join(stage, n), sh);
    fs.chmodSync(path.join(stage, n), 0o755);
  }
}

function readme(t) {
  const start = t.os === 'win32' ? '双击 start.cmd'
    : t.os === 'darwin' ? '双击 start.command（首次若提示"无法验证开发者"：先在终端执行 xattr -dr com.apple.quarantine <解压目录>）'
      : '终端执行 ./start.sh';
  const browser = t.os === 'win32' ? 'Microsoft Edge（系统自带）' : 'Google Chrome 或 Chromium';
  return `公众号写作助手 ${version}（${t.os}-${t.cpu}，便携版，自带 Node ${NODE_VERSION} 与 Codex CLI）\r
\r
1. ${start}，浏览器会自动打开 http://127.0.0.1:8848/\r
2. 点「设置」填 API 地址（OpenAI 兼容，以 /v1 结尾）和 Key，点「测试连接」选模型，保存\r
3. 给素材 → 生成文章 → 预览 → 一键填入公众号草稿（需要 ${browser}）\r
\r
数据目录：用户主目录下 .wechat-writer（设置、文章、浏览器登录态）\r
完整教程：docs/教程.md\r
`;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export async function build(name) {
  const t = TARGETS[name];
  if (!t) throw new Error(`未知目标 ${name}，可选：${Object.keys(TARGETS).join(' ')}`);
  const dirName = `wechat-writer-${version}-${name}`;
  const stage = path.join(DIST, 'stage', dirName);
  fs.rmSync(stage, { recursive: true, force: true });
  fs.mkdirSync(stage, { recursive: true });
  for (const f of COPY) fs.cpSync(path.join(ROOT, f), path.join(stage, f), { recursive: true });
  console.log(`== ${name}: 安装 ${t.os}/${t.cpu} 依赖`);
  run('npm', ['ci', '--omit=dev', '--no-audit', '--no-fund', '--ignore-scripts', `--os=${t.os}`, `--cpu=${t.cpu}`], stage);
  const codexPkg = path.join(stage, 'node_modules', '@openai', `codex-${t.os}-${t.cpu}`);
  if (!fs.existsSync(codexPkg)) throw new Error(`缺少 ${codexPkg}，npm 未装上目标平台的 Codex`);
  await addRuntime(t, stage);
  writeLaunchers(t, stage);
  fs.writeFileSync(path.join(stage, 'README.txt'), `﻿${readme(t)}`);
  const out = path.join(DIST, `${dirName}.${t.os === 'win32' ? 'zip' : 'tar.gz'}`);
  fs.rmSync(out, { force: true });
  if (t.os === 'win32') run('zip', ['-qry', '-9', out, dirName], path.dirname(stage));
  else run('tar', [...(process.platform === 'darwin' ? ['--no-mac-metadata', '--no-xattrs'] : []), '-czf', out, dirName], path.dirname(stage));
  fs.rmSync(stage, { recursive: true, force: true });
  const size = (fs.statSync(out).size / 1048576).toFixed(1);
  console.log(`== ${name}: ${path.basename(out)} (${size} MB)`);
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const names = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(TARGETS);
  const outs = [];
  for (const n of names) outs.push(await build(n));
  const sums = outs.map((f) => `${sha256(f)}  ${path.basename(f)}`).join('\n') + '\n';
  fs.appendFileSync(path.join(DIST, 'SHA256SUMS.txt'), sums);
  console.log(sums);
}
