# Publica o catálogo na VPS.
#   .\deploy\publicar.ps1              -> atualiza só o código (dados da VPS são mantidos)
#   .\deploy\publicar.ps1 -ComDados    -> envia também banco/imagens/config locais (só usados se a VPS
#                                          ainda não tiver dados; para sobrescrever, adicione -ForcarDados)
param(
  [switch]$ComDados,
  [switch]$ForcarDados,
  [string]$Destino = $(if ($env:VPS_HOST) { $env:VPS_HOST } elseif (Test-Path "$PSScriptRoot\vps-host.txt") { (Get-Content "$PSScriptRoot\vps-host.txt" -Raw).Trim() } else { throw 'Defina VPS_HOST ou crie deploy\vps-host.txt com usuario@ip da VPS' }),
  [string]$Chave = $(if ($env:VPS_KEY) { $env:VPS_KEY } else { "$env:USERPROFILE\.ssh\etiquetas_vps" }),
  [string]$Dominio = 'catalogo.b6nhiy.easypanel.host'
)
$ErrorActionPreference = 'Stop'
$raiz = Split-Path $PSScriptRoot -Parent
$dist = Join-Path $raiz 'dist'
$node = if (Get-Command node -ErrorAction SilentlyContinue) { 'node' } else { "$env:ProgramFiles\nodejs\node.exe" }

Write-Host '== empacotando'
Remove-Item -Recurse -Force $dist -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Force (Join-Path $dist 'app') | Out-Null
foreach ($item in 'src', 'public', 'assets', 'package.json', 'package-lock.json', 'README.md') {
  Copy-Item -Recurse (Join-Path $raiz $item) (Join-Path $dist 'app')
}
$conteudo = @('app')
if ($ComDados) {
  & $node --disable-warning=ExperimentalWarning (Join-Path $PSScriptRoot 'exportar-dados.mjs') (Join-Path $raiz 'data') (Join-Path $dist 'data')
  if ($LASTEXITCODE) { throw 'falha ao exportar dados' }
  $conteudo += 'data'
}
Copy-Item (Join-Path $PSScriptRoot 'instalar.sh') $dist
$conteudo += 'instalar.sh'
$pacote = Join-Path $dist 'catalogo.tgz'
tar -czf $pacote -C $dist @conteudo
if ($LASTEXITCODE) { throw 'falha ao empacotar' }
Write-Host ("pacote: {0:N1} MB" -f ((Get-Item $pacote).Length / 1MB))

Write-Host '== enviando'
scp -i $Chave -o BatchMode=yes -q $pacote "${Destino}:/tmp/catalogo.tgz"
if ($LASTEXITCODE) { throw 'falha no envio' }

Write-Host '== instalando na VPS'
$forcar = if ($ForcarDados) { 1 } else { 0 }
$remoto = "rm -rf /tmp/catalogo-deploy && mkdir -p /tmp/catalogo-deploy && tar -xzf /tmp/catalogo.tgz -C /tmp/catalogo-deploy && rm /tmp/catalogo.tgz && " +
  "sed -i 's/\r$//' /tmp/catalogo-deploy/instalar.sh && DOMINIO=$Dominio FORCAR_DADOS=$forcar bash /tmp/catalogo-deploy/instalar.sh"
ssh -i $Chave -o BatchMode=yes $Destino $remoto
if ($LASTEXITCODE) { throw 'falha na instalação' }
Remove-Item -Recurse -Force $dist
Write-Host "== pronto: https://$Dominio/"
