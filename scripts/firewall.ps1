# Разрешить телефону подключаться к BurstCam (входящие TCP 8080 и 8443) — нужны права администратора.
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\firewall.ps1           # добавить правило
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\firewall.ps1 -Remove   # убрать правило
param(
  [switch]$Remove,
  [int[]]$Ports = @(8080, 8443)
)
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$name = 'BurstCam (локальный сервер камеры)'

$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host 'Нужны права администратора — Windows сейчас спросит разрешение.' -ForegroundColor Yellow
  $argList = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"")
  if ($Remove) { $argList += '-Remove' }
  Start-Process powershell -Verb RunAs -ArgumentList $argList -Wait
  exit
}

Get-NetFirewallRule -DisplayName $name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
if ($Remove) {
  Write-Host 'Правило BurstCam удалено.' -ForegroundColor Green
} else {
  # Только локальная подсеть: из интернета порт не открывается, даже если ноутбук в публичной сети.
  New-NetFirewallRule -DisplayName $name -Direction Inbound -Action Allow -Protocol TCP `
    -LocalPort $Ports -RemoteAddress LocalSubnet -Profile Any | Out-Null
  Write-Host ("Готово: входящие TCP {0} разрешены из локальной подсети." -f ($Ports -join ', ')) -ForegroundColor Green
}
Write-Host 'Окно можно закрыть.'
Start-Sleep -Seconds 4
