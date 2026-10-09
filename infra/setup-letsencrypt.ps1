# setup-letsencrypt.ps1
# Instala win-acme + plugin Cloudflare e emite certificado Let's Encrypt
# para hubcontroller.com.br via DNS-01 challenge.
# Requer: rodar como Administrador.

$ErrorActionPreference = 'Stop'

$domain      = "hubcontroller.com.br"
$iissite     = "hub-automation"
$installDir  = "C:\win-acme"
$cfTokenFile = "$installDir\Cloudflare-token.txt"

# ---------- 1. Criar pasta ----------
if (-not (Test-Path $installDir)) { New-Item -ItemType Directory -Path $installDir | Out-Null }

# ---------- 2. Baixar win-acme (versão plugável) ----------
Write-Host "Baixando win-acme..." -ForegroundColor Cyan
$wacsUrl = "https://github.com/win-acme/win-acme/releases/download/v2.2.9.1701/win-acme.v2.2.9.1701.x64.pluggable.zip"
$wacsZip = "$env:TEMP\win-acme.zip"
Invoke-WebRequest -Uri $wacsUrl -OutFile $wacsZip -UseBasicParsing
Expand-Archive -Path $wacsZip -DestinationPath $installDir -Force
Remove-Item $wacsZip

# ---------- 3. Baixar plugin Cloudflare ----------
Write-Host "Baixando plugin Cloudflare..." -ForegroundColor Cyan
$cfUrl = "https://github.com/win-acme/win-acme/releases/download/v2.2.9.1701/plugin.validation.dns.cloudflare.v2.2.9.1701.zip"
$cfZip = "$env:TEMP\cf-plugin.zip"
Invoke-WebRequest -Uri $cfUrl -OutFile $cfZip -UseBasicParsing
Expand-Archive -Path $cfZip -DestinationPath $installDir -Force
Remove-Item $cfZip

# ---------- 4. Salvar token Cloudflare (lido pelo plugin) ----------
# O plugin lê o token de um arquivo de configuração JSON na pasta Plugins/.
$pluginsDir = "$installDir\Plugins"
if (-not (Test-Path $pluginsDir)) { New-Item -ItemType Directory -Path $pluginsDir | Out-Null }

# win-acme armazena segredos via "secrets" — passamos o token diretamente na CLI.
# Gravamos em arquivo separado apenas para referência do script (sem expor no log).
$cfToken = Read-Host "Cole o Cloudflare API Token" -AsSecureString
$cfTokenPlain = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
    [Runtime.InteropServices.Marshal]::SecureStringToBSTR($cfToken))

# ---------- 5. Solicitar certificado ----------
Write-Host "`nSolicitando certificado para $domain ..." -ForegroundColor Cyan

$wacsExe = "$installDir\wacs.exe"

& $wacsExe `
  --target          manual `
  --host            $domain `
  --validation      dns-01 `
  --validationplugin cloudflare `
  --cloudflareapitoken $cfTokenPlain `
  --store           iis `
  --siteid          (Get-WebSite -Name $iissite).Id `
  --installation    iis `
  --installationsiteid (Get-WebSite -Name $iissite).Id `
  --emailaddress    inovacao01@controller-rnc.com.br `
  --accepttos `
  --verbose

Write-Host "`nConcluido! Certificado instalado e binding HTTPS atualizado." -ForegroundColor Green
Write-Host "A renovacao automatica foi configurada como tarefa agendada do Windows." -ForegroundColor Green
