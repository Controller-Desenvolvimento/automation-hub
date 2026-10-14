<#
  Registra (ou remove) a tarefa agendada do auto deploy: roda infra\windows\deploy.ps1 a cada minuto.

  Roda na sessao INTERATIVA do usuario atual (nao como servico): o PM2 do hub, o Chrome dos robos e o
  disco X: ja dependem dessa sessao (o PM2 sobe pelo logon do usuario), entao o deploy enxerga o mesmo ambiente.
  Instalar:   powershell -ExecutionPolicy Bypass -File infra\windows\install-autodeploy.ps1
  Remover:    powershell -ExecutionPolicy Bypass -File infra\windows\install-autodeploy.ps1 -Uninstall
#>
param([switch]$Uninstall, [int]$EveryMinutes = 1)
$ErrorActionPreference = 'Stop'
$name = 'AutomationHubAutoDeploy'

if ($Uninstall) {
  Unregister-ScheduledTask -TaskName $name -Confirm:$false -ErrorAction SilentlyContinue
  'Tarefa removida (se existia).'
  exit 0
}

$vbs = Join-Path $PSScriptRoot 'run-hidden.vbs'
$action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument ('"{0}"' -f $vbs)
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes $EveryMinutes)
$settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
$principal = New-ScheduledTaskPrincipal -UserId ('{0}\{1}' -f $env:USERDOMAIN, $env:USERNAME) -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'Auto deploy do Automation Hub: busca commits novos no GitHub e atualiza o servidor (ver infra/windows/deploy.ps1).' -Force | Out-Null
'Tarefa "{0}" registrada: roda a cada {1} minuto(s) na sessao de {2}.' -f $name, $EveryMinutes, $env:USERNAME
'Log: apps/api/storage/deploy.log'
