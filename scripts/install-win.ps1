# 公众号写作助手 · Windows 一键安装（x64 / ARM64 通用）
# 用法（在解压后的 wechat-writer 目录里，PowerShell）：
#   powershell -ExecutionPolicy Bypass -File .\scripts\install-win.ps1 -BaseUrl http://10.0.0.1:8317/v1
param(
  [string]$BaseUrl = "https://api.deepseek.com",
  [string]$Model = "deepseek-flash",
  [string]$Registry = "https://registry.npmmirror.com",
  [string]$InstallDir = "$env:LOCALAPPDATA\WeChatWriter"
)
$ErrorActionPreference = "Stop"
$src = Split-Path -Parent $PSScriptRoot

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

Write-Host "== 1/4 检查 Node.js (需要 >= 20)" -ForegroundColor Cyan
Refresh-Path  # Node 可能是本次登录后才装的，先刷新 PATH
$node = Get-Command node -ErrorAction SilentlyContinue
$ok = $false
if ($node) { $ok = ([int]((& node -v).TrimStart('v').Split('.')[0])) -ge 20 }
if (-not $ok) {
  Write-Host "未找到 Node.js 20+，用 winget 安装 Node.js LTS ..."
  winget install --id OpenJS.NodeJS.LTS -e --accept-source-agreements --accept-package-agreements
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "Node.js 安装后仍不可用，请重开 PowerShell 再运行本脚本" }
}
Write-Host ("Node " + (& node -v) + " / 架构 " + $env:PROCESSOR_ARCHITECTURE)

Write-Host "== 2/4 复制程序到 $InstallDir" -ForegroundColor Cyan
New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
if ((Resolve-Path $src).Path -ne (Resolve-Path $InstallDir).Path) {
  robocopy $src $InstallDir /E /XD node_modules dist .git /NFL /NDL /NJH /NJS | Out-Null
}

Write-Host "== 3/4 安装依赖（Codex CLI + playwright-core，不下载浏览器，使用系统 Edge）" -ForegroundColor Cyan
Push-Location $InstallDir
# PowerShell 5.1 在 Stop 模式下会把原生命令的 stderr 当致命错误，这里临时放宽，只看退出码
$ErrorActionPreference = "Continue"
try {
  & npm install --omit=dev --no-audit --no-fund --registry $Registry 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "npm install 失败" }
  & node node_modules/@openai/codex/bin/codex.js --version 2>&1 | ForEach-Object { "$_" }
  if ($LASTEXITCODE -ne 0) { throw "Codex CLI 无法运行" }
} finally { Pop-Location; $ErrorActionPreference = "Stop" }

Write-Host "== 4/4 预置设置并创建桌面快捷方式" -ForegroundColor Cyan
$dataDir = Join-Path $env:USERPROFILE ".wechat-writer"
$settings = Join-Path $dataDir "settings.json"
New-Item -ItemType Directory -Force -Path $dataDir | Out-Null
if (-not (Test-Path $settings)) {
  $obj = @{ baseUrl = $BaseUrl; apiKey = ""; model = $Model; author = ""; browser = "msedge"; sandbox = "workspace-write"; browserMcp = $false }
  [IO.File]::WriteAllText($settings, ($obj | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
}
$lnk = Join-Path ([Environment]::GetFolderPath("Desktop")) "公众号写作助手.lnk"
$sh = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
$sh.TargetPath = Join-Path $InstallDir "scripts\start-win.cmd"
$sh.WorkingDirectory = $InstallDir
$sh.Save()

try {
  $r = Invoke-WebRequest -UseBasicParsing "$BaseUrl/models" -TimeoutSec 5
  Write-Host "网关 $BaseUrl 可达 (HTTP $($r.StatusCode))" -ForegroundColor Green
} catch { Write-Warning "网关 $BaseUrl 暂不可达：$($_.Exception.Message)。装好后可在应用「设置」里修改地址" }

Write-Host "安装完成！双击桌面「公众号写作助手」启动。" -ForegroundColor Green
