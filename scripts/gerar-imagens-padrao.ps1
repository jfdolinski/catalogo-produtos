# Gera as opcoes de imagem padrao em assets/padrao/02..10.png (a 01 e a caixa de assets/imagem-padrao.png)
# e a folha de comparacao relatorios/opcoes-imagem-padrao.png.
# Uso: powershell -File scripts\gerar-imagens-padrao.ps1
Add-Type -AssemblyName System.Drawing

$raiz = Join-Path $PSScriptRoot '..'
$saida = Join-Path $raiz 'assets\padrao'
New-Item -ItemType Directory -Force $saida | Out-Null
Copy-Item (Join-Path $raiz 'assets\imagem-padrao.png') (Join-Path $saida '01.png') -Force

$S = 800
$NAO = 'N' + [char]0xC3 + 'O'
$fonte = 'Segoe UI'

function Cor($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function Pincel($hex) { New-Object System.Drawing.SolidBrush (Cor $hex) }
function Caneta($hex, $w) {
  $p = New-Object System.Drawing.Pen (Cor $hex), $w
  $p.LineJoin = 'Round'; $p.StartCap = 'Round'; $p.EndCap = 'Round'
  $p
}
function Canto($x, $y, $w, $h, $r) {
  $c = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  if ($r -le 0) { $c.AddRectangle((New-Object System.Drawing.RectangleF ([single]$x), ([single]$y), ([single]$w), ([single]$h))); return $c }
  $c.AddArc($x, $y, $d, $d, 180, 90)
  $c.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $c.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $c.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $c.CloseFigure()
  $c
}
function Ret($g, $x, $y, $w, $h, $r, $fundo, $linha, $lw) {
  $c = Canto $x $y $w $h $r
  if ($fundo) { $g.FillPath((Pincel $fundo), $c) }
  if ($linha) { $g.DrawPath((Caneta $linha $lw), $c) }
}
function Elipse($g, $x, $y, $w, $h, $fundo, $linha, $lw) {
  if ($fundo) { $g.FillEllipse((Pincel $fundo), [single]$x, [single]$y, [single]$w, [single]$h) }
  if ($linha) { $g.DrawEllipse((Caneta $linha $lw), [single]$x, [single]$y, [single]$w, [single]$h) }
}
function Poligono($g, $pontos, $fundo, $linha, $lw) {
  $p = @()
  for ($i = 0; $i -lt $pontos.Count; $i += 2) { $p += New-Object System.Drawing.PointF ([single]$pontos[$i]), ([single]$pontos[$i + 1]) }
  if ($fundo) { $g.FillPolygon((Pincel $fundo), [System.Drawing.PointF[]]$p) }
  if ($linha) { $g.DrawPolygon((Caneta $linha $lw), [System.Drawing.PointF[]]$p) }
}
function Cruz($g, $cx, $cy, $t, $b, $cor) {
  $g.FillRectangle((Pincel $cor), [single]($cx - $b / 2), [single]($cy - $t / 2), [single]$b, [single]$t)
  $g.FillRectangle((Pincel $cor), [single]($cx - $t / 2), [single]($cy - $b / 2), [single]$t, [single]$b)
}
function Texto($g, $t, $cx, $cy, $w, $tam, $cor, $estilo = 'Bold') {
  $f = New-Object System.Drawing.Font $fonte, ([single]$tam), ([System.Drawing.FontStyle]$estilo), ([System.Drawing.GraphicsUnit]::Pixel)
  $fmt = New-Object System.Drawing.StringFormat
  $fmt.Alignment = 'Center'; $fmt.LineAlignment = 'Center'
  $g.DrawString($t, $f, (Pincel $cor), (New-Object System.Drawing.RectangleF ([single]($cx - $w / 2)), ([single]($cy - 100)), ([single]$w), 200), $fmt)
}
function Legenda($g, $cor) {
  Texto $g 'IMAGEM' 400 655 700 56 $cor
  Texto $g "$NAO LOCALIZADA" 400 715 700 56 $cor
}
function Sombra($g, $x, $y, $w, $h) { Elipse $g $x $y $w $h '#EDF0F5' $null 0 }

function Desenhar($n, [scriptblock]$corpo, $fundo = '#FFFFFF') {
  $bmp = New-Object System.Drawing.Bitmap $S, $S
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = 'AntiAlias'; $g.TextRenderingHint = 'AntiAlias'
  $g.Clear((Cor $fundo))
  & $corpo $g
  $g.Dispose()
  $bmp.Save((Join-Path $saida ('{0:00}.png' -f $n)), [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
}

# 02: caixa de medicamento de frente
Desenhar 2 { param($g)
  Sombra $g 170 555 460 40
  Ret $g 210 110 380 460 18 '#FFFFFF' '#334155' 7
  $g.FillRectangle((Pincel '#2563EB'), 214, 170, 372, 90)
  Texto $g 'MEDICAMENTO' 400 215 360 34 '#FFFFFF'
  Elipse $g 330 300 140 140 '#E8EFFF' $null 0
  Cruz $g 400 370 90 30 '#2563EB'
  $g.FillRectangle((Pincel '#DC2626'), 214, 490, 372, 22)
  Legenda $g '#1E293B'
}
# 03: frasco de comprimidos
Desenhar 3 { param($g)
  Sombra $g 215 562 370 34
  Ret $g 275 110 250 80 14 '#15803D' '#14532D' 7
  $g.DrawLine((Caneta '#14532D' 5), 320, 125, 320, 175); $g.DrawLine((Caneta '#14532D' 5), 400, 125, 400, 175); $g.DrawLine((Caneta '#14532D' 5), 480, 125, 480, 175)
  Ret $g 240 190 320 385 34 '#FFF7ED' '#14532D' 7
  Ret $g 240 280 320 200 0 '#FFFFFF' '#14532D' 7
  Cruz $g 400 380 100 34 '#16A34A'
  Legenda $g '#14532D'
}
# 04: capsulas
Desenhar 4 { param($g)
  $g.TranslateTransform(400, 330); $g.RotateTransform(-35)
  $c = Canto (-230) (-70) 460 140 70
  $g.FillPath((Pincel '#E2F7F4'), $c)
  $meia = New-Object System.Drawing.Region $c
  $meia.Intersect((New-Object System.Drawing.RectangleF ([single]-230), ([single]-70), ([single]230), ([single]140)))
  $g.FillRegion((Pincel '#14B8A6'), $meia)
  $g.DrawPath((Caneta '#0F766E' 7), $c)
  $g.DrawLine((Caneta '#0F766E' 7), 0, -70, 0, 70)
  $g.ResetTransform()
  Elipse $g 545 110 110 110 '#CCFBF1' '#0F766E' 6
  $g.DrawLine((Caneta '#0F766E' 6), 565, 165, 635, 165)
  Legenda $g '#134E4A'
}
# 05: cruz de farmacia
Desenhar 5 { param($g)
  Elipse $g 170 95 460 460 '#ECFDF5' $null 0
  Elipse $g 215 140 370 370 '#16A34A' $null 0
  Cruz $g 400 325 230 76 '#FFFFFF'
  Legenda $g '#166534'
}
# 06: camera sem foto
Desenhar 6 { param($g)
  Ret $g 170 200 460 310 34 '#E2E8F0' '#475569' 8
  Poligono $g @(300, 200, 330, 145, 470, 145, 500, 200) '#E2E8F0' '#475569' 8
  Elipse $g 290 245 220 220 '#FFFFFF' '#475569' 8
  Elipse $g 345 300 110 110 '#CBD5E1' $null 0
  $g.DrawLine((Caneta '#FFFFFF' 34), 195, 120, 605, 560)
  $g.DrawLine((Caneta '#DC2626' 18), 195, 120, 605, 560)
  Legenda $g '#334155'
}
# 07: sacola de compras
Desenhar 7 { param($g)
  Sombra $g 190 562 420 34
  $g.DrawArc((Caneta '#9A3412' 14), 300, 100, 200, 190, 180, 180)
  Poligono $g @(205, 215, 595, 215, 625, 575, 175, 575) '#F97316' '#9A3412' 7
  Elipse $g 305 305 190 190 '#FFEDD5' $null 0
  Texto $g '?' 400 396 180 140 '#C2410C'
  Legenda $g '#7C2D12'
}
# 08: caixa de papelao
Desenhar 8 { param($g)
  Sombra $g 170 562 460 34
  Poligono $g @(170, 250, 400, 110, 630, 250, 400, 390) '#E7C9A0' '#78350F' 7
  Poligono $g @(170, 250, 400, 390, 400, 580, 170, 440) '#D4A574' '#78350F' 7
  Poligono $g @(630, 250, 400, 390, 400, 580, 630, 440) '#BE8A52' '#78350F' 7
  Poligono $g @(280, 182, 510, 322, 510, 395, 455, 362, 455, 355, 225, 215) '#F5E6D0' '#78350F' 5
  Legenda $g '#78350F'
}
# 09: tubo de pomada
Desenhar 9 { param($g)
  $g.TranslateTransform(400, 330); $g.RotateTransform(-18)
  Poligono $g @(-215, -105, 150, -80, 150, 80, -215, 105) '#F5F3FF' '#5B21B6' 7
  $g.FillRectangle((Pincel '#6D28D9'), -240, -112, 28, 224)
  $g.DrawRectangle((Caneta '#5B21B6' 7), -240, -112, 28, 224)
  Ret $g 150 (-55) 75 110 12 '#7C3AED' '#5B21B6' 7
  Poligono $g @(-90, -94, 40, -87, 40, 87, -90, 94) '#7C3AED' $null 0
  Cruz $g (-25) 0 90 30 '#FFFFFF'
  $g.ResetTransform()
  Legenda $g '#4C1D95'
}
# 10: moldura tracejada, a mais discreta
Desenhar 10 { param($g)
  $c = Canto 130 90 540 460 28
  $p = Caneta '#94A3B8' 9
  $p.DashStyle = 'Dash'
  $g.DrawPath($p, $c)
  Elipse $g 490 150 80 80 '#CBD5E1' $null 0
  Poligono $g @(200, 480, 340, 260, 430, 390, 495, 310, 600, 480) '#CBD5E1' $null 0
  Legenda $g '#475569'
} '#F8FAFC'

# Folha de comparacao: 5 x 2, numeradas
$cel = 300; $rot = 44
$folha = New-Object System.Drawing.Bitmap (5 * $cel + 60), (2 * ($cel + $rot) + 60)
$g = [System.Drawing.Graphics]::FromImage($folha)
$g.SmoothingMode = 'AntiAlias'; $g.InterpolationMode = 'HighQualityBicubic'; $g.TextRenderingHint = 'AntiAlias'
$g.Clear((Cor '#F1F5F9'))
for ($i = 1; $i -le 10; $i++) {
  $l = [math]::Floor(($i - 1) / 5); $k = ($i - 1) % 5
  $x = 10 + $k * ($cel + 10); $y = 10 + $l * ($cel + $rot + 10)
  $img = [System.Drawing.Image]::FromFile((Join-Path $saida ('{0:00}.png' -f $i)))
  $g.FillRectangle((Pincel '#FFFFFF'), $x, $y, $cel, $cel + $rot)
  $g.DrawImage($img, $x, ($y + $rot), $cel, $cel)
  $img.Dispose()
  Texto $g "Op$([char]0xE7)$([char]0xE3)o $i" ($x + $cel / 2) ($y + 24) $cel 26 '#1E293B'
}
$g.Dispose()
$dest = Join-Path $raiz 'relatorios'
New-Item -ItemType Directory -Force $dest | Out-Null
$folha.Save((Join-Path $dest 'opcoes-imagem-padrao.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$folha.Dispose()
Get-ChildItem $saida | ForEach-Object { '{0} {1} KB' -f $_.Name, [math]::Round($_.Length / 1KB) }
