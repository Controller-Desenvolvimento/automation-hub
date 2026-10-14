' Executa o deploy.ps1 sem abrir janela (o console do PowerShell piscaria a cada minuto na sessao do servidor).
Dim fso, dir, cmd
Set fso = CreateObject("Scripting.FileSystemObject")
dir = fso.GetParentFolderName(WScript.ScriptFullName)
cmd = "powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File """ & dir & "\deploy.ps1"""
CreateObject("WScript.Shell").Run cmd, 0, True
