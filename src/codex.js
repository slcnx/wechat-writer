// 调用开源 Codex CLI（codex exec）在文章目录里执行内置 skill。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { APP_ROOT, codexEnv, prepareCodexHome } from './config.js';

const BUNDLED = path.join(APP_ROOT, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');

/** 优先使用随应用安装的 codex，避免依赖全局 PATH（Windows 上 .cmd 需要 shell）。 */
export function codexCommand() {
  if (fs.existsSync(BUNDLED)) return { cmd: process.execPath, pre: [BUNDLED], shell: false };
  return { cmd: 'codex', pre: [], shell: process.platform === 'win32' };
}

export function buildWritePrompt(brief) {
  return [
    '使用 wechat-article skill 完成任务。',
    '素材在当前目录的 materials/ 下，写作要求在 brief.json。',
    '把成稿写到 out/article.body.html 和 out/meta.json，格式严格按 skill 规定。',
    brief.title ? `标题方向：${brief.title}` : '',
  ].filter(Boolean).join('\n');
}

export function buildRevisePrompt(instruction) {
  return [
    '使用 wechat-article skill 修改已有成稿。',
    '先读 out/article.body.html、out/meta.json 和 materials/，按下面的修改意见改写，并覆盖原文件。',
    `修改意见：${instruction}`,
  ].join('\n');
}

/**
 * 运行 codex exec。prompt 走 stdin（避免 Windows 命令行对中文/引号的转义问题）。
 * onLog(line) 逐行回调；返回 { code, cancel }，其中 done 为 Promise。
 */
export function runCodex({ cwd, prompt, settings, onLog = () => {}, timeoutMs = 15 * 60 * 1000 }) {
  prepareCodexHome(settings);
  const { cmd, pre, shell } = codexCommand();
  const args = [...pre, 'exec', '--skip-git-repo-check', '-s', settings.sandbox, '-C', cwd, '-'];
  const child = spawn(cmd, args, { cwd, env: codexEnv(settings), shell, windowsHide: true });
  const pump = (stream) => {
    let buf = '';
    stream.setEncoding('utf8');
    stream.on('data', (d) => {
      buf += d;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop();
      parts.forEach((l) => l.trim() && onLog(l));
    });
    stream.on('end', () => buf.trim() && onLog(buf));
  };
  pump(child.stdout);
  pump(child.stderr);
  child.stdin.end(prompt, 'utf8');
  const timer = setTimeout(() => { onLog('[超时] Codex 运行超过时限，已终止'); child.kill(); }, timeoutMs);
  const done = new Promise((resolve) => {
    child.on('error', (e) => { onLog(`[启动失败] ${e.message}`); resolve(-1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
  return { done, cancel: () => child.kill() };
}
