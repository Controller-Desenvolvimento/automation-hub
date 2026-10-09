# Libera streaming (SSE) no IIS/ARR que fica na frente do hub.
#
# Problema: o ARR segura a resposta inteira (inclusive o cabecalho HTTP) ate o fim
# quando ela vem em "chunks", entao o chat dos BIs (POST /chatkit, text/event-stream)
# so recebe os eventos no final e o navegador desiste apos 120 s sem evento.
#
# Precisa rodar como ADMINISTRADOR (PowerShell elevado). Faz backup da config do IIS antes.
# Para desfazer:  appcmd restore backup <nome mostrado no inicio>

#Requires -RunAsAdministrator
$ErrorActionPreference = 'Stop'
$appcmd = Join-Path $env:windir 'system32\inetsrv\appcmd.exe'

$backupName = 'antes-arr-streaming-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
& $appcmd add backup $backupName | Out-Null
Write-Host "Backup do IIS criado: $backupName"
Write-Host "  (para desfazer: & '$appcmd' restore backup $backupName)`n"

Write-Host '== ANTES: ARR (nivel do servidor) =='
& $appcmd list config -section:system.webServer/proxy
Write-Host "`n== Sites =="
& $appcmd list site

Write-Host "`n== APLICANDO (nivel do servidor) =="
& $appcmd set config -section:system.webServer/proxy /responseBufferLimit:0 /bufferChunkedResponses:false /minResponseBuffer:0 /commit:apphost
if ($LASTEXITCODE -ne 0) { throw 'Falha ao aplicar a configuracao do ARR.' }

Write-Host "`n== DEPOIS: ARR (nivel do servidor) =="
& $appcmd list config -section:system.webServer/proxy

Write-Host "`nPronto. O IIS aplica sozinho (nao precisa de iisreset). Avise o Claude para repetir o teste."
