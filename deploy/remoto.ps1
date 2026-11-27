# Executa um script bash na VPS sem problemas de aspas/BOM do PowerShell (envia em base64).
# Uso: .\deploy\remoto.ps1 -Script deploy\arquivo.sh   ou   .\deploy\remoto.ps1 -Comando 'uptime'
param(
  [string]$Script,
  [string]$Comando,
  [string]$Host_ = $(if ($env:VPS_HOST) { $env:VPS_HOST } elseif (Test-Path "$PSScriptRoot\vps-host.txt") { (Get-Content "$PSScriptRoot\vps-host.txt" -Raw).Trim() } else { throw 'Defina VPS_HOST ou crie deploy\vps-host.txt com usuario@ip da VPS' }),
  [string]$Chave = $(if ($env:VPS_KEY) { $env:VPS_KEY } else { "$env:USERPROFILE\.ssh\etiquetas_vps" })
)
$texto = if ($Script) { [IO.File]::ReadAllText((Resolve-Path $Script)) } else { $Comando }
$texto = $texto.TrimStart([char]0xFEFF).Replace("`r", '')
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($texto))
ssh -i $Chave -o BatchMode=yes -o ConnectTimeout=15 $Host_ "echo $b64 | base64 -d | bash"
exit $LASTEXITCODE
