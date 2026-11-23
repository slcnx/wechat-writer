// 原子写文件：先写临时文件再 rename，避免进程中断留下半截文件。
import fs from 'node:fs';
import path from 'node:path';

export function writeFileAtomic(file, data, mode) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, data, mode ? { mode } : undefined);
  fs.renameSync(tmp, file);
}

export function readJsonSafe(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); // 容忍 PowerShell 写出的 BOM
  } catch {
    return fallback;
  }
}
