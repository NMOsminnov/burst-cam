# Запуск BurstCam: проверяет Node.js, ставит зависимости, запускает сервер.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\start.ps1 [-Port 8443] [-HttpPort 8080]
param(
  [int]$Port = 8443,
  [int]$HttpPort = 8080
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

function Say($text, $color = 'Gray') { Write-Host $text -ForegroundColor $color }

# 1. Node.js
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Say 'Не найден Node.js.' Red
  Say 'Установите его одной командой (потом закройте и откройте это окно заново):' Yellow
  Say '   winget install OpenJS.NodeJS.LTS'
  Say 'или скачайте LTS-версию с https://nodejs.org'
  exit 1
}
$ver = (& node -v).TrimStart('v')
if ([int]($ver.Split('.')[0]) -lt 18) {
  Say "Node.js $ver слишком старый, нужен 18 или новее: winget upgrade OpenJS.NodeJS.LTS" Red
  exit 1
}
Say "Node.js $ver — ок" DarkGray

# 2. Зависимости (только QR-код в консоли; без него тоже работает)
if (-not (Test-Path 'node_modules\qrcode-terminal')) {
  Say 'Ставлю зависимости (один раз)…' DarkGray
  & npm install --omit=dev --no-audit --no-fund --loglevel=error
  if ($LASTEXITCODE -ne 0) { Say 'npm install не прошёл — запускаю без QR-кода.' Yellow }
}

# 3. Иконки (в репозитории уже есть; на случай, если их удалили)
if (-not (Test-Path 'app\icons\icon-192.png')) { & node tools\make-icons.js | Out-Null }

# 4. Брандмауэр: только проверка, ничего не меняем
try {
  $rule = Get-NetFirewallRule -DisplayName 'BurstCam*' -ErrorAction Stop | Where-Object { $_.Enabled -eq 'True' }
} catch { $rule = $null }
if (-not $rule) {
  Say ''
  Say 'Внимание: нет правила брандмауэра BurstCam. Если телефон не открывает страницу —' Yellow
  Say 'один раз запустите firewall.cmd (попросит права администратора) или нажмите «Разрешить»,' Yellow
  Say 'когда Windows спросит про доступ node.exe к сети (отметьте и «Частные», и «Общественные» сети).' Yellow
}
try {
  $public = Get-NetConnectionProfile -ErrorAction Stop | Where-Object { $_.NetworkCategory -eq 'Public' }
  if ($public -and -not $rule) {
    Say ("Сеть «{0}» помечена как общественная — Windows там закрывает входящие подключения сильнее." -f ($public[0].Name)) Yellow
  }
} catch { }

# 5. Сервер
Say ''
& node server\serve.js --port $Port --http $HttpPort
exit $LASTEXITCODE
