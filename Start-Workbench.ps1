param([switch]$Legacy)
$ErrorActionPreference = 'Stop'
$electronPath = Join-Path $PSScriptRoot 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path -LiteralPath $electronPath -PathType Leaf)) {
    throw 'Electron 尚未安装。请在 Windows Node.js 22.12+ 环境中运行 npm ci。'
}
# Build the React renderer before launching; Legacy uses the preserved renderer directly.
if (-not $Legacy) {
    Push-Location $PSScriptRoot
    try { & node (Join-Path $PSScriptRoot 'node_modules\vite\bin\vite.js') build; if ($LASTEXITCODE -ne 0) { throw 'UI 构建失败。可用 -Legacy 启动旧版。' } }
    finally { Pop-Location }
}
$previousLegacy = $env:OMP_CINDY_LEGACY_UI
try {
    if ($Legacy) { $env:OMP_CINDY_LEGACY_UI = '1' } else { Remove-Item Env:OMP_CINDY_LEGACY_UI -ErrorAction SilentlyContinue }
    # The requested desktop UI is an interactive window, not a background helper.
    Start-Process -FilePath $electronPath -ArgumentList ('"' + $PSScriptRoot + '"') -WorkingDirectory $PSScriptRoot -WindowStyle Normal
} finally {
    if ($null -eq $previousLegacy) { Remove-Item Env:OMP_CINDY_LEGACY_UI -ErrorAction SilentlyContinue } else { $env:OMP_CINDY_LEGACY_UI = $previousLegacy }
}
