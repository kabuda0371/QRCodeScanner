# 二维码识别助手 - Edge 一键启动（免手动加载扩展）
# 用法：双击 launch-edge.cmd，即以独立配置启动 Edge 并自动加载本仓库
# 更新：git pull 后重新双击即可加载最新代码
# 可选参数：headless（无头自检模式）
param([string]$Mode = '')

$ErrorActionPreference = 'Continue'
$dir = Split-Path -Parent $PSScriptRoot   # 仓库根目录（tools 的上一级）

$edgePaths = @(
    'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    'C:\Program Files\Microsoft\Edge\Application\msedge.exe'
)
$edge = $edgePaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $edge) {
    Write-Host '[错误] 未找到 Edge 浏览器，请先安装 Microsoft Edge' -ForegroundColor Red
    Read-Host '按回车键退出'
    exit 1
}

$edgeArgs = @(
    "--load-extension=$dir",
    "--user-data-dir=$dir\.edge-profile",
    '--no-first-run',
    '--no-default-browser-check'
)

if ($Mode -eq 'headless') {
    & $edge @edgeArgs '--headless=new' '--disable-gpu' '--disable-crash-reporter' `
        '--virtual-time-budget=3000' '--dump-dom' 'about:blank' | Out-Null
    exit $LASTEXITCODE
}

Start-Process -FilePath $edge -ArgumentList $edgeArgs
Write-Host ''
Write-Host "已启动 Edge 并加载扩展：$dir" -ForegroundColor Green
Write-Host '更新代码（git pull）后重新双击本脚本即可加载最新版本。'
Write-Host ''
