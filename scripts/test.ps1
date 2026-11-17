# Все проверки: юнит-тесты (логика серии, сертификаты) + сквозные (безголовый Chromium с поддельной камерой).
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\test.ps1 [-Unit]
# Журнал — artifacts\test-*.log. Окна браузера не открываются.
param([switch]$Unit)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
New-Item -ItemType Directory -Force artifacts | Out-Null
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$log = "artifacts\test-$stamp.log"

if (-not (Test-Path 'node_modules\@playwright\test')) {
  Write-Host 'Ставлю зависимости для тестов…'
  & npm install --no-audit --no-fund --loglevel=error
}

Write-Host '== Юнит-тесты' -ForegroundColor Cyan
& npm test *>&1 | Tee-Object -FilePath $log
$unitOk = $LASTEXITCODE -eq 0
$e2eOk = $true
if (-not $Unit) {
  Write-Host '== Сквозные тесты (Chromium, поддельная камера)' -ForegroundColor Cyan
  & npx playwright test *>&1 | Tee-Object -FilePath $log -Append
  $e2eOk = $LASTEXITCODE -eq 0
  if (-not $e2eOk) {
    Write-Host 'Если ошибка «Executable doesn''t exist» — один раз выполните: npx playwright install chromium' -ForegroundColor Yellow
  }
}
Write-Host ''
if ($unitOk -and $e2eOk) { Write-Host "Все проверки прошли. Журнал: $log" -ForegroundColor Green; exit 0 }
Write-Host "Есть падения. Журнал: $log" -ForegroundColor Red
exit 1
