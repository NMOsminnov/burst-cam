# Выпустить новый сертификат CA (если старый потерян, скомпрометирован или его удалили с телефона).
# Старый не стирается — переезжает в .certs.old-<дата>. После этого сертификат на телефон
# нужно поставить заново (страница http://<адрес>:8080/).
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$root = Split-Path -Parent $PSScriptRoot
$certs = Join-Path $root '.certs'
if (Test-Path $certs) {
  $dest = Join-Path $root (".certs.old-" + (Get-Date -Format 'yyyyMMdd-HHmmss'))
  Move-Item $certs $dest
  Write-Host "Старый CA перенесён в $dest" -ForegroundColor Yellow
}
Write-Host 'Новый CA появится при следующем запуске start.cmd. Не забудьте удалить старый сертификат BurstCam с телефона.' -ForegroundColor Green
