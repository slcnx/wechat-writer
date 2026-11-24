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

/** 组装 codex exec 参数：首轮新建会话；有 resumeId 时用 exec resume 接着同一个会话聊。 */
export function codexArgs({ cwd, settings, extraArgs = [], resumeId = '', lastMessageFile = '' }) {
  // 写公众号用不到生图；看图开关由调用方按模型能力决定
  const common = ['--skip-git-repo-check', '--disable', 'image_generation', ...extraArgs, ...(lastMessageFile ? ['-o', lastMessageFile] : [])];
  if (resumeId) return ['exec', 'resume', ...common, '-c', `sandbox_mode=${JSON.stringify(settings.sandbox)}`, resumeId, '-'];
  return ['exec', ...common, '-s', settings.sandbox, '-C', cwd, '-'];
}

export const SESSION_RE = /session id:\s*([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

/**
 * 运行 codex exec。prompt 走 stdin（避免 Windows 命令行对中文/引号的转义问题）。
 * onLog(line) 逐行回调；返回 { done, cancel }，done 解析为退出码。
 */
export function runCodex({ cwd, prompt, settings, extraArgs = [], resumeId = '', lastMessageFile = '', onLog = () => {}, timeoutMs = 15 * 60 * 1000 }) {
  prepareCodexHome(settings);
  const { cmd, pre, shell } = codexCommand();
  const args = [...pre, ...codexArgs({ cwd, settings, extraArgs, resumeId, lastMessageFile })];
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
  const kill = () => killTree(child);
  const timer = setTimeout(() => { onLog('[超时] Codex 运行超过时限，已终止'); kill(); }, timeoutMs);
  const done = new Promise((resolve) => {
    child.on('error', (e) => { onLog(`[启动失败] ${e.message}`); resolve(-1); });
    child.on('close', (code) => { clearTimeout(timer); resolve(code ?? -1); });
  });
  return { done, cancel: kill };
}

/** 结束 codex 及其子进程：Windows 上 kill() 只杀 node 包装进程，原生 codex 会成孤儿，要用 taskkill /T。 */
function killTree(child) {
  if (child.exitCode !== null || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => child.kill());
  } else child.kill('SIGTERM'); // bin/codex.js 会把信号转给原生进程
}
