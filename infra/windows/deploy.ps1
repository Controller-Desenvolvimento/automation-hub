<#
  Auto deploy do Automation Hub (servidor Windows + PM2).

  Roda a cada minuto (tarefa agendada, ver install-autodeploy.ps1). Cada rodada e' curta e SEM estado em
  memoria: o que precisa lembrar fica em apps/api/storage/deploy-*.json. Fluxo:

    1. git fetch. Se o commit de origin/<branch> e' o que ja esta no ar, nao faz nada.
    2. Compara os arquivos alterados e escolhe o caminho mais leve:
         - so' docs/infra ........ nada a reiniciar
         - apps/web .............. compila numa pasta paralela e troca a dist (sem reiniciar nada;
                                   o hub serve o frontend na hora e as automacoes nem sentem)
         - apps/api .............. compila numa pasta paralela e grava deploy-pending.json: o hub para de
                                   iniciar execucoes novas (ficam na fila) e o admin ve o aviso na interface.
    3. Com a API pendente, a cada rodada confere se NAO ha execucao rodando (ou se o admin clicou em
       "Atualizar agora"). Quando esvazia: migra o banco (se precisa), troca a dist, reinicia o PM2 e
       confere a saude. Se nao subir, volta pra versao anterior e avisa.

  Seguranca: nunca mexe numa arvore de trabalho com alteracoes locais; so' avanca em fast-forward; so'
  troca a pasta de build depois de compilar com sucesso; mantem a versao anterior pra voltar.
  Teste sem efeito colateral:  powershell -File deploy.ps1 -DryRun   (so' loga o que faria)
  Diagnostico do ambiente:      powershell -File deploy.ps1 -CheckEnv
#>
param(
  [string]$RepoDir = '',
  [string]$Branch = 'master',
  [string]$PmName = 'automation-hub',
  [string]$HealthUrl = 'http://localhost:3000/api/auth/me',
  [int]$HealthTimeoutSec = 90,
  [switch]$DryRun,
  [switch]$CheckEnv
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$OutputEncoding = [Text.Encoding]::UTF8
if (-not $RepoDir) { $RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path }
$ApiDir = Join-Path $RepoDir 'apps\api'
$WebDir = Join-Path $RepoDir 'apps\web'
$Storage = Join-Path $ApiDir 'storage'
New-Item -ItemType Directory -Force -Path $Storage | Out-Null

$PendingFile = Join-Path $Storage 'deploy-pending.json'     # lido pela API (segura a fila + aviso ao admin)
$LastFile = Join-Path $Storage 'deploy-last.json'           # lido pela API (resultado do ultimo deploy)
$PlanFile = Join-Path $Storage 'deploy-plan.json'           # so' deste script
$DeployedFile = Join-Path $Storage 'deploy-deployed.json'   # commit que esta de fato no ar
$AttemptFile = Join-Path $Storage 'deploy-attempt.json'     # evita repetir sem parar uma tentativa que falhou
$LogFile = Join-Path $Storage 'deploy.log'
$NowIso = { (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ') }

# ---------------------------------------------------------------- utilitarios
function Log([string]$Message) {
  $line = '{0} {1}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
  try { Add-Content -LiteralPath $LogFile -Value $line -Encoding UTF8 } catch { }
  Write-Host $line
}

# Repete a mesma mensagem no maximo a cada 10 minutos (a rodada roda a cada minuto).
function Log-Throttled([string]$Key, [string]$Message) {
  $stamp = Join-Path $Storage ('deploy-log-' + $Key + '.stamp')
  if ((Test-Path -LiteralPath $stamp) -and (((Get-Date) - (Get-Item -LiteralPath $stamp).LastWriteTime).TotalMinutes -lt 10)) { return }
  Set-Content -LiteralPath $stamp -Value (Get-Date).ToString('o')
  Log $Message
}

function Read-Json([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return $null }
  try { return (Get-Content -LiteralPath $Path -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}

# Sem BOM: quem le' do outro lado e' o Node, e o JSON.parse nao aceita BOM.
function Write-Json([string]$Path, $Object) {
  [IO.File]::WriteAllText($Path, ($Object | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding($false)))
}

function Tail([string]$Text, [int]$Max) {
  if ($Text.Length -le $Max) { return $Text }
  return '...' + $Text.Substring($Text.Length - $Max)
}

# Roda um executavel nativo sem que o stderr (ex.: progresso do git) vire erro do PowerShell 5.1.
function Invoke-Native([string]$Exe, [string[]]$Arguments, [string]$WorkDir = $RepoDir, [switch]$AllowFail) {
  $old = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location -LiteralPath $WorkDir
  try {
    $out = & $Exe @Arguments 2>&1 | ForEach-Object { "$_" }
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $old
  }
  $text = (@($out) -join "`n").Trim()
  if ($code -ne 0 -and -not $AllowFail) {
    throw ('{0} {1} falhou (codigo {2}): {3}' -f $Exe, ($Arguments -join ' '), $code, (Tail $text 700))
  }
  return @{ Code = $code; Text = $text }
}

function Get-DbSettings {
  $envFile = Join-Path $ApiDir '.env'
  if (-not (Test-Path -LiteralPath $envFile)) { throw 'apps/api/.env nao encontrado' }
  foreach ($line in Get-Content -LiteralPath $envFile -Encoding UTF8) {
    if ($line -match '^\s*DATABASE_URL\s*=\s*(.+?)\s*$') {
      $url = $Matches[1].Trim('"').Trim("'")
      if ($url -match '^postgres(?:ql)?://([^:]+):([^@]*)@([^:/]+)(?::(\d+))?/([^?]+)') {
        $port = '5432'
        if ($Matches[4]) { $port = $Matches[4] }
        return @{ User = [uri]::UnescapeDataString($Matches[1]); Password = [uri]::UnescapeDataString($Matches[2]); Host = $Matches[3]; Port = $port; Db = $Matches[5] }
      }
    }
  }
  throw 'DATABASE_URL invalida ou ausente em apps/api/.env'
}

# Quantas execucoes estao rodando agora (so' 'running': a fila nao conta, ela segue depois do reinicio).
function Get-RunningCount {
  $db = Get-DbSettings
  $psql = (Get-Command psql -ErrorAction SilentlyContinue).Source
  if (-not $psql) { $psql = 'C:\Program Files\PostgreSQL\16\bin\psql.exe' }
  $env:PGPASSWORD = $db.Password
  # No PowerShell 5.1 as aspas duplas de um argumento nativo se perdem: o identificador "Execution" (maiusculo)
  # precisa chegar ao psql escapado com barra invertida.
  $sql = 'select count(*) from \"Execution\" where status = ''running'''
  $r = Invoke-Native $psql @('-h', $db.Host, '-p', $db.Port, '-U', $db.User, '-d', $db.Db, '-tA', '-c', $sql)
  return [int]$r.Text
}

# Mostra o resultado no GitHub (check "deploy/servidor" no commit). Opcional: sem credencial, so' ignora.
function Set-GhStatus([string]$Sha, [string]$State, [string]$Description) {
  if ($DryRun) { return }
  try {
    $remote = (Invoke-Native git @('remote', 'get-url', 'origin')).Text
    if ($remote -notmatch 'github\.com[:/]([^/]+)/([^/.]+)') { return }
    $tokenFile = Join-Path $env:USERPROFILE '.automation-hub-deploy-token'
    if (Test-Path -LiteralPath $tokenFile) { $env:GH_TOKEN = (Get-Content -LiteralPath $tokenFile -Raw).Trim() }
    $desc = (($Description -replace "[`r`n]+", ' ') -replace '"', "'").Trim()    # aspas e quebras de linha quebram o argumento nativo
    if ($desc.Length -gt 130) { $desc = $desc.Substring(0, 130) }
    Invoke-Native gh @('api', '-X', 'POST', ('repos/{0}/{1}/statuses/{2}' -f $Matches[1], $Matches[2], $Sha), '-f', "state=$State", '-f', 'context=deploy/servidor', '-f', "description=$desc") -AllowFail | Out-Null
  } catch {
    Log ('(status no GitHub ignorado: {0})' -f $_.Exception.Message)
  }
}

function Write-Last([string]$Sha, [string]$Status, [string]$Kind, [string]$Message, [string]$Started) {
  Write-Json $LastFile ([ordered]@{ sha = $Sha; status = $Status; kind = $Kind; message = $Message; startedAt = $Started; finishedAt = (& $NowIso) })
}

# Troca <Dir> por <Dir>-next (build novo), guardando o atual em <Dir>-prev. Tenta de novo se algum
# arquivo estiver aberto por uma requisicao em andamento.
function Rename-WithRetry([string]$From, [string]$NewName) {
  for ($i = 1; $i -le 8; $i++) {
    try { Rename-Item -LiteralPath $From -NewName $NewName -ErrorAction Stop; return } catch {
      if ($i -eq 8) { throw }
      Start-Sleep -Milliseconds 600
    }
  }
}
function Swap-Dir([string]$Dir) {
  $next = "$Dir-next"; $prev = "$Dir-prev"
  if (-not (Test-Path -LiteralPath $next)) { throw "pasta de build novo nao existe: $next" }
  if (Test-Path -LiteralPath $prev) { Remove-Item -LiteralPath $prev -Recurse -Force }
  if (Test-Path -LiteralPath $Dir) { Rename-WithRetry $Dir (Split-Path $prev -Leaf) }
  Rename-WithRetry $next (Split-Path $Dir -Leaf)
}
function Restore-PrevDir([string]$Dir) {
  $prev = "$Dir-prev"; $failed = "$Dir-failed"
  if (-not (Test-Path -LiteralPath $prev)) { return }
  if (Test-Path -LiteralPath $failed) { Remove-Item -LiteralPath $failed -Recurse -Force }
  if (Test-Path -LiteralPath $Dir) { Rename-WithRetry $Dir (Split-Path $failed -Leaf) }
  Rename-WithRetry $prev (Split-Path $Dir -Leaf)
}
function Remove-IfExists([string]$Path) {
  if (Test-Path -LiteralPath $Path) { Remove-Item -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue }
}

# Qualquer resposta HTTP abaixo de 500 (inclusive o 401 de "sem login") significa que a API subiu.
function Test-Health([int]$TimeoutSec = 90) {
  $end = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $end) {
    try {
      Invoke-WebRequest -Uri $HealthUrl -UseBasicParsing -TimeoutSec 5 | Out-Null
      return $true
    } catch {
      $resp = $_.Exception.Response
      if ($resp -ne $null -and [int]$resp.StatusCode -lt 500) { return $true }
    }
    Start-Sleep -Seconds 2
  }
  return $false
}

function Build-Web {
  Remove-IfExists (Join-Path $WebDir 'dist-next')
  Invoke-Native npx @('tsc', '-b') $WebDir | Out-Null
  Invoke-Native npx @('vite', 'build', '--outDir', 'dist-next', '--emptyOutDir') $WebDir | Out-Null
  if (-not (Test-Path -LiteralPath (Join-Path $WebDir 'dist-next\index.html'))) { throw 'build do frontend nao gerou index.html' }
}

# A API e' compilada fora da pasta "dist" (o "nest build" apaga ela antes de compilar, o que derrubaria o
# servidor no ar se o build falhasse). Mesmo resultado: tsc + copia dos assets de public/.
function Build-Api {
  Remove-IfExists (Join-Path $ApiDir 'dist-next')
  Invoke-Native npx @('tsc', '-p', 'tsconfig.build.json', '--outDir', 'dist-next') $ApiDir | Out-Null
  $pub = Join-Path $ApiDir 'public'
  if (Test-Path -LiteralPath $pub) { Copy-Item -LiteralPath $pub -Destination (Join-Path $ApiDir 'dist-next\public') -Recurse -Force }
  if (-not (Test-Path -LiteralPath (Join-Path $ApiDir 'dist-next\src\main.js'))) { throw 'build da API nao gerou dist-next\src\main.js' }
}

function Fail-Attempt([string]$Sha, [string]$Kind, [string]$Message, [string]$Started, [int]$RetryMinutes) {
  Log ('FALHOU: {0}' -f $Message)
  Write-Last $Sha 'failed' $Kind $Message $Started
  Write-Json $AttemptFile ([ordered]@{ sha = $Sha; retryAfter = (Get-Date).ToUniversalTime().AddMinutes($RetryMinutes).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') })
  Set-GhStatus $Sha 'failure' ('Deploy falhou: ' + $Message)
}

function Test-Dirty {
  return [bool](Invoke-Native git @('status', '--porcelain', '--untracked-files=no')).Text
}

# ---------------------------------------------------------------- diagnostico
if ($CheckEnv) {
  Log ('CheckEnv: usuario={0} sessao={1} repo={2}' -f $env:USERNAME, (Get-Process -Id $PID).SessionId, $RepoDir)
  foreach ($c in 'git', 'node', 'npm', 'npx', 'pm2', 'psql', 'gh') { Log ('  {0}: {1}' -f $c, ((Get-Command $c -ErrorAction SilentlyContinue).Source)) }
  try { Log ('  git fetch: codigo {0}' -f (Invoke-Native git @('fetch', 'origin', $Branch, '--quiet') -AllowFail).Code) } catch { Log ('  git fetch ERRO: ' + $_.Exception.Message) }
  try { Log ('  execucoes rodando: {0}' -f (Get-RunningCount)) } catch { Log ('  banco ERRO: ' + $_.Exception.Message) }
  try { Log ('  pm2: {0}' -f ((Invoke-Native pm2 @('jlist') -AllowFail).Text.Length -gt 10)) } catch { Log ('  pm2 ERRO: ' + $_.Exception.Message) }
  try { Log ('  saude da API: {0}' -f (Test-Health 10)) } catch { Log ('  saude ERRO: ' + $_.Exception.Message) }
  try { Log ('  gh auth: codigo {0}' -f (Invoke-Native gh @('auth', 'status') -AllowFail).Code) } catch { Log ('  gh ERRO: ' + $_.Exception.Message) }
  exit 0
}

# ---------------------------------------------------------------- uma rodada
$mutex = New-Object System.Threading.Mutex($false, 'Global\automation-hub-deploy')
if (-not $mutex.WaitOne(0)) { exit 0 }     # outra rodada ainda esta trabalhando
try {
  # Trunca o log quando passa de ~1 MB (mantem o final).
  if ((Test-Path -LiteralPath $LogFile) -and ((Get-Item -LiteralPath $LogFile).Length -gt 1MB)) {
    $keep = Get-Content -LiteralPath $LogFile -Tail 800 -Encoding UTF8
    Set-Content -LiteralPath $LogFile -Value $keep -Encoding UTF8
  }

  $deployed = Read-Json $DeployedFile
  if (-not $deployed) {
    # Primeira rodada: assume que o que esta no ar e' o HEAD atual (a pasta do servidor e' onde o build foi feito).
    $head = (Invoke-Native git @('rev-parse', 'HEAD')).Text
    Write-Json $DeployedFile ([ordered]@{ sha = $head; at = (& $NowIso) })
    Log ('Primeira rodada: marcando {0} como o que esta no ar.' -f $head.Substring(0, 7))
    $deployed = Read-Json $DeployedFile
  }
  $deployedSha = [string]$deployed.sha

  try { Invoke-Native git @('fetch', 'origin', $Branch, '--quiet') | Out-Null } catch { Log ('fetch falhou (rede?): ' + $_.Exception.Message); exit 0 }
  $target = (Invoke-Native git @('rev-parse', "origin/$Branch")).Text
  $pending = Read-Json $PendingFile
  $plan = Read-Json $PlanFile

  # --- ja esta no ar e nada pendente: fim da rodada
  if (-not $pending -and $target -eq $deployedSha) { exit 0 }

  # --- uma tentativa que falhou nao e' repetida a cada minuto
  if (-not $pending) {
    $attempt = Read-Json $AttemptFile
    if ($attempt -and $attempt.sha -eq $target -and (([datetime]$attempt.retryAfter).ToUniversalTime() -gt (Get-Date).ToUniversalTime())) { exit 0 }
  }

  # ================================================================ FASE A: preparar (sem reiniciar nada)
  if (-not $pending -or $pending.sha -ne $target) {
    $started = & $NowIso
    $short = $target.Substring(0, 7)
    $subject = (Invoke-Native git @('log', '-1', '--format=%s', $target)).Text
    Log ('Novo commit {0}: {1}' -f $short, $subject)

    if (Test-Dirty) {
      Fail-Attempt $target 'none' 'A pasta do servidor tem alteracoes locais nao commitadas; o deploy automatico nao mexe nela.' $started 5
      exit 0
    }

    $files = @()
    $known = (Invoke-Native git @('cat-file', '-e', ($deployedSha + '^{commit}')) -AllowFail).Code -eq 0
    if ($known) { $files = @((Invoke-Native git @('diff', '--name-only', $deployedSha, $target)).Text -split "`n" | Where-Object { $_ }) }
    else { $files = @('apps/web/x', 'apps/api/x', 'apps/api/package-lock.json') ; Log 'commit anterior desconhecido: tratando como mudanca completa' }
    $webChanged = [bool]($files | Where-Object { $_ -match '^apps/web/' })
    $apiChanged = [bool]($files | Where-Object { $_ -match '^apps/api/(?!test/)' })
    $apiLock = [bool]($files | Where-Object { $_ -match '^apps/api/(package\.json|package-lock\.json)$' })
    $webLock = [bool]($files | Where-Object { $_ -match '^apps/web/(package\.json|package-lock\.json)$' })
    $schema = [bool]($files | Where-Object { $_ -match '^apps/api/prisma/schema\.prisma$' })
    $migrations = [bool]($files | Where-Object { $_ -match '^apps/api/prisma/migrations/' })
    Log ('Arquivos alterados: {0} | web={1} api={2} lockApi={3} schema={4} migracoes={5}' -f $files.Count, $webChanged, $apiChanged, $apiLock, $schema, $migrations)

    if ($DryRun) { Log '[dry-run] pararia aqui: nao altera nada.'; exit 0 }

    Set-GhStatus $target 'pending' 'Deploy em andamento'
    try {
      Invoke-Native git @('merge', '--ff-only', "origin/$Branch") | Out-Null
    } catch {
      Fail-Attempt $target 'none' ('Nao foi possivel avancar a pasta do servidor em fast-forward: ' + (Tail $_.Exception.Message 200)) $started 30
      exit 0
    }

    if (-not $webChanged -and -not $apiChanged) {
      Write-Json $DeployedFile ([ordered]@{ sha = $target; at = (& $NowIso) })
      Write-Last $target 'ok' 'none' 'Sem mudanca de codigo (docs/infra): nada a reiniciar.' $started
      Set-GhStatus $target 'success' 'Sem mudanca de codigo: nada a reiniciar'
      Log 'Sem mudanca de codigo: nada a reiniciar.'
      exit 0
    }

    # --- frontend: compila ao lado e troca. Nao reinicia nada.
    if ($webChanged) {
      try {
        Log 'Frontend: compilando...'
        if ($webLock) { Invoke-Native npm @('ci') $WebDir | Out-Null }
        Build-Web
        Swap-Dir (Join-Path $WebDir 'dist')
        Log 'Frontend: publicado (sem reinicio).'
      } catch {
        Remove-IfExists (Join-Path $WebDir 'dist-next')
        Invoke-Native git @('reset', '--hard', $deployedSha) -AllowFail | Out-Null
        Fail-Attempt $target 'web' ('Falha ao compilar o frontend: ' + (Tail $_.Exception.Message 400)) $started 360
        exit 0
      }
    }

    if (-not $apiChanged) {
      Write-Json $DeployedFile ([ordered]@{ sha = $target; at = (& $NowIso) })
      Write-Last $target 'ok' 'web' ('Frontend atualizado sem reiniciar: ' + $subject) $started
      Set-GhStatus $target 'success' 'Frontend publicado, sem reinicio'
      Log 'Deploy concluido (so frontend).'
      exit 0
    }

    # --- API: prepara o build novo (se nao depende de instalar pacotes) e segura a fila
    $needsInstall = $apiLock
    $built = $false
    if (-not $needsInstall) {
      try {
        Log 'API: compilando em pasta paralela...'
        Build-Api
        $built = $true
      } catch {
        Remove-IfExists (Join-Path $ApiDir 'dist-next')
        Invoke-Native git @('reset', '--hard', $deployedSha) -AllowFail | Out-Null
        Fail-Attempt $target 'api' ('Falha ao compilar a API (o servidor segue na versao anterior): ' + (Tail $_.Exception.Message 400)) $started 360
        exit 0
      }
    }
    Write-Json $PlanFile ([ordered]@{ sha = $target; prevSha = $deployedSha; needsInstall = $needsInstall; needsGenerate = ($schema -or $apiLock); needsMigrate = $migrations; built = $built; webChanged = $webChanged; startedAt = $started })
    $requested = & $NowIso
    if ($pending -and $pending.requestedAt) { $requested = [string]$pending.requestedAt }   # recompilou por commit novo: nao reinicia a contagem
    Write-Json $PendingFile ([ordered]@{ sha = $target; message = $subject; requestedAt = $requested })
    Set-GhStatus $target 'pending' 'API aguardando as execucoes terminarem para reiniciar'
    Log 'API: atualizacao pendente. A fila de novas execucoes esta segurada ate esvaziar.'
    Start-Sleep -Seconds 8     # deixa o runner (ciclo de 3 s) perceber o arquivo antes de contar o que esta rodando
    $pending = Read-Json $PendingFile
    $plan = Read-Json $PlanFile
  }

  # ================================================================ FASE B: reiniciar quando esvaziar
  if ($DryRun) { Log '[dry-run] fase B: pararia aqui.'; exit 0 }
  $force = [bool]$pending.force
  $running = $null
  try { $running = Get-RunningCount } catch { Log-Throttled 'dbcount' ('Nao consegui contar as execucoes (banco); nao vou reiniciar sem certeza: ' + $_.Exception.Message) }
  if ($running -eq $null) { exit 0 }                                   # sem certeza, nao reinicia
  if ($running -gt 0 -and -not $force) {
    Log-Throttled 'waiting' ('Aguardando {0} execucao(oes) terminar(em) para reiniciar.' -f $running)
    exit 0
  }
  Remove-IfExists (Join-Path $Storage 'deploy-log-waiting.stamp')

  $target = [string]$pending.sha
  $started = & $NowIso
  if ($plan -and $plan.startedAt) { $started = [string]$plan.startedAt }
  $prevSha = $deployedSha
  if ($plan -and $plan.prevSha) { $prevSha = [string]$plan.prevSha }
  $needsInstall = $false; $needsGenerate = $false; $needsMigrate = $false; $built = $false
  if ($plan) { $needsInstall = [bool]$plan.needsInstall; $needsGenerate = [bool]$plan.needsGenerate; $needsMigrate = [bool]$plan.needsMigrate; $built = [bool]$plan.built }
  Log ('Reiniciando para {0} ({1}).' -f $target.Substring(0, 7), $(if ($force) { 'liberado pelo admin' } else { 'servidor ocioso' }))

  $swapped = $false
  try {
    if ($needsInstall) {
      Log 'API: parando para instalar dependencias...'
      Invoke-Native pm2 @('stop', $PmName) | Out-Null
      Invoke-Native npm @('ci') $ApiDir | Out-Null
    }
    if ($needsGenerate) { Invoke-Native npx @('prisma', 'generate') $ApiDir | Out-Null }
    if (-not $built) { Log 'API: compilando...'; Build-Api }
    if ($needsMigrate) { Log 'Banco: aplicando migracoes...'; Invoke-Native npx @('prisma', 'migrate', 'deploy') $ApiDir | Out-Null }
    Swap-Dir (Join-Path $ApiDir 'dist')
    $swapped = $true
    Invoke-Native pm2 @('restart', $PmName) | Out-Null
    if (-not (Test-Health $HealthTimeoutSec)) { throw 'A API nao respondeu depois de reiniciar.' }
  } catch {
    $why = Tail $_.Exception.Message 400
    Log ('ERRO no deploy: {0}' -f $why)
    $rolled = $false
    try {
      if ($swapped) { Restore-PrevDir (Join-Path $ApiDir 'dist') }
      Remove-IfExists (Join-Path $ApiDir 'dist-next')
      Invoke-Native git @('reset', '--hard', $prevSha) -AllowFail | Out-Null
      # Se o npm ci falhou no meio, node_modules ficou quebrado: reinstala as dependencias da versao anterior.
      if ($needsInstall) { Log 'Reinstalando as dependencias da versao anterior...'; Invoke-Native npm @('ci') $ApiDir -AllowFail | Out-Null }
      Invoke-Native pm2 @('restart', $PmName) | Out-Null
      $rolled = Test-Health $HealthTimeoutSec
    } catch { Log ('Falha ao voltar a versao anterior: ' + $_.Exception.Message) }
    Remove-IfExists $PendingFile; Remove-IfExists $PlanFile
    $st = 'failed'; if ($rolled) { $st = 'rolled_back' }
    $msg = $why; if ($rolled) { $msg = 'Voltou para a versao anterior. Motivo: ' + $why } else { $msg = 'ATENCAO: a API pode estar fora do ar. Motivo: ' + $why }
    Write-Last $target $st 'api' $msg $started
    Write-Json $AttemptFile ([ordered]@{ sha = $target; retryAfter = (Get-Date).ToUniversalTime().AddHours(6).ToString('yyyy-MM-ddTHH:mm:ss.fffZ') })
    Set-GhStatus $target 'failure' ('Deploy falhou: ' + $msg)
    exit 1
  }

  Write-Json $DeployedFile ([ordered]@{ sha = $target; at = (& $NowIso) })
  Remove-IfExists $PendingFile; Remove-IfExists $PlanFile; Remove-IfExists $AttemptFile
  $subject = (Invoke-Native git @('log', '-1', '--format=%s', $target) -AllowFail).Text
  Write-Last $target 'ok' 'api' ('API atualizada e reiniciada: ' + $subject) $started
  Set-GhStatus $target 'success' 'Servidor atualizado e reiniciado'
  Log ('Deploy concluido: {0}' -f $target.Substring(0, 7))
} catch {
  Log ('ERRO inesperado na rodada: {0}' -f $_.Exception.Message)
  exit 1
} finally {
  $mutex.ReleaseMutex()
}
