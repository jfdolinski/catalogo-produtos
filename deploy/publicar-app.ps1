# Coloca no ar uma versão do aplicativo de celular: baixa o APK da Release do GitHub (gerada pelo workflow Aplicativo),
# confere o SHA-256 e copia para a pasta de dados do catálogo na VPS. O painel passa a mostrar o botão de download
# e os celulares com versão anterior recebem o aviso de versão nova.
# Uso: .\deploy\publicar-app.ps1 -Tag app-1.0.0-3      (sem -Tag: a Release mais recente)
param(
  [string]$Tag,
  [string]$Repo = 'jfdolinski/catalogo-produtos',
  [string]$Host_ = $(if ($env:VPS_HOST) { $env:VPS_HOST } elseif (Test-Path "$PSScriptRoot\vps-host.txt") { (Get-Content "$PSScriptRoot\vps-host.txt" -Raw).Trim() } else { throw 'Defina VPS_HOST ou crie deploy\vps-host.txt com usuario@ip da VPS' }),
  [string]$Chave = $(if ($env:VPS_KEY) { $env:VPS_KEY } else { "$env:USERPROFILE\.ssh\etiquetas_vps" }),
  [string]$Destino = '/opt/catalogo/data/downloads'
)
$ErrorActionPreference = 'Stop'
if (-not $Tag) {
  $Tag = (gh release list --repo $Repo --limit 20 --json tagName --jq '[.[] | select(.tagName | startswith("app-"))][0].tagName')
  if (-not $Tag) { throw 'Nenhuma Release app-* encontrada.' }
}
$pasta = Join-Path ([IO.Path]::GetTempPath()) "catalogo-app-$Tag"
if (Test-Path $pasta) { Remove-Item -Recurse -Force $pasta }
New-Item -ItemType Directory $pasta | Out-Null
gh release download $Tag --repo $Repo --dir $pasta --pattern 'catalogo-app.apk' --pattern 'catalogo-app.apk.sha256' --pattern 'app-versao.txt'
if ($LASTEXITCODE) { throw "Falha ao baixar a Release $Tag" }

$esperado = ((Get-Content (Join-Path $pasta 'catalogo-app.apk.sha256') -Raw).Trim() -split '\s+')[0].ToLower()
$obtido = (Get-FileHash (Join-Path $pasta 'catalogo-app.apk') -Algorithm SHA256).Hash.ToLower()
if ($esperado -ne $obtido) { throw 'SHA-256 do APK não confere; nada foi publicado.' }

# Versão gravada como "1.0.0-3" (versão-execução): o app compara só o número antes do hífen
$versao = (Get-Content (Join-Path $pasta 'app-versao.txt') -Raw).Trim()
$numero = ($Tag -replace '^app-', '')
Set-Content -Path (Join-Path $pasta 'app-versao.txt') -Value $numero -NoNewline -Encoding ascii
Write-Host "Publicando $Tag (versão $versao)..."

ssh -i $Chave -o BatchMode=yes $Host_ "mkdir -p $Destino"
# Envia com nome temporário e troca no fim: quem estiver baixando não pega um arquivo pela metade
scp -i $Chave -o BatchMode=yes (Join-Path $pasta 'catalogo-app.apk') "${Host_}:$Destino/catalogo-app.apk.novo"
scp -i $Chave -o BatchMode=yes (Join-Path $pasta 'app-versao.txt') "${Host_}:$Destino/app-versao.txt.novo"
ssh -i $Chave -o BatchMode=yes $Host_ "cd $Destino && chmod 644 *.novo && mv catalogo-app.apk.novo catalogo-app.apk && mv app-versao.txt.novo app-versao.txt && ls -la"
if ($LASTEXITCODE) { throw 'Falha ao publicar na VPS' }
Remove-Item -Recurse -Force $pasta
Write-Host "Pronto: /downloads/catalogo-app.apk ($numero)"
