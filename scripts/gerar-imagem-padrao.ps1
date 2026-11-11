# Gera assets/imagem-padrao.png: caixa de medicamento com o texto "IMAGEM NAO LOCALIZADA".
# Uso: powershell -File scripts\gerar-imagem-padrao.ps1
Add-Type -AssemblyName System.Drawing

$out = Join-Path $PSScriptRoot '..\assets\imagem-padrao.png'
New-Item -ItemType Directory -Force (Split-Path $out) | Out-Null

$S = 800
$bmp = New-Object System.Drawing.Bitmap $S, $S
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.TextRenderingHint = 'AntiAliasGridFit'
$g.Clear([System.Drawing.Color]::White)

function C($hex) { [System.Drawing.ColorTranslator]::FromHtml($hex) }
function P($x, $y) { New-Object System.Drawing.PointF $x, $y }

$line = New-Object System.Drawing.Pen (C '#3A4A5C'), 4
$line.LineJoin = 'Round'

# Geometria da caixa: frente + profundidade
$x0 = 140; $x1 = 540; $y0 = 300; $y1 = 640; $dx = 130; $dy = -110

# Sombra
$g.FillEllipse((New-Object System.Drawing.SolidBrush (C '#EEF1F5')), 110, 600, 640, 90)

$front = @((P $x0 $y0), (P $x1 $y0), (P $x1 $y1), (P $x0 $y1))
$top   = @((P $x0 $y0), (P $x1 $y0), (P ($x1 + $dx) ($y0 + $dy)), (P ($x0 + $dx) ($y0 + $dy)))
$side  = @((P $x1 $y0), (P ($x1 + $dx) ($y0 + $dy)), (P ($x1 + $dx) ($y1 + $dy)), (P $x1 $y1))

$g.FillPolygon((New-Object System.Drawing.SolidBrush (C '#FFFFFF')), $front)
$g.FillPolygon((New-Object System.Drawing.SolidBrush (C '#E7ECF2')), $top)
$g.FillPolygon((New-Object System.Drawing.SolidBrush (C '#CFD8E3')), $side)

# Faixa azul na frente e na lateral
$blue = New-Object System.Drawing.SolidBrush (C '#2E6FD8')
$blueDark = New-Object System.Drawing.SolidBrush (C '#2259B3')
$bandTop = $y0 + 24; $bandBot = $y0 + 84
$g.FillRectangle($blue, $x0, $bandTop, $x1 - $x0, $bandBot - $bandTop)
$g.FillPolygon($blueDark, @((P $x1 $bandTop), (P ($x1 + $dx) ($bandTop + $dy)), (P ($x1 + $dx) ($bandBot + $dy)), (P $x1 $bandBot)))

# Faixa vermelha fina (tarja)
$red = New-Object System.Drawing.SolidBrush (C '#D64545')
$g.FillRectangle($red, $x0, $y1 - 34, $x1 - $x0, 14)
$g.FillPolygon((New-Object System.Drawing.SolidBrush (C '#B33636')), @((P $x1 ($y1 - 34)), (P ($x1 + $dx) ($y1 - 34 + $dy)), (P ($x1 + $dx) ($y1 - 20 + $dy)), (P $x1 ($y1 - 20))))

# Texto da faixa
$center = New-Object System.Drawing.StringFormat
$center.Alignment = 'Center'; $center.LineAlignment = 'Center'
$white = New-Object System.Drawing.SolidBrush (C '#FFFFFF')
$g.DrawString('MEDICAMENTO', (New-Object System.Drawing.Font 'Segoe UI', 22, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)), $white,
  (New-Object System.Drawing.RectangleF $x0, $bandTop, ($x1 - $x0), ($bandBot - $bandTop)), $center)

# Cruz em círculo
$cx = ($x0 + $x1) / 2; $cy = $y0 + 148
$g.FillEllipse((New-Object System.Drawing.SolidBrush (C '#E8F0FD')), $cx - 52, $cy - 52, 104, 104)
$g.FillRectangle($blue, $cx - 13, $cy - 36, 26, 72)
$g.FillRectangle($blue, $cx - 36, $cy - 13, 72, 26)

# Texto principal
$dark = New-Object System.Drawing.SolidBrush (C '#2B3645')
$nao = 'IMAGEM N' + [char]0x00C3 + 'O'
$fontBig = New-Object System.Drawing.Font 'Segoe UI', 40, ([System.Drawing.FontStyle]::Bold), ([System.Drawing.GraphicsUnit]::Pixel)
$g.DrawString($nao, $fontBig, $dark, (New-Object System.Drawing.RectangleF $x0, ($y0 + 205), ($x1 - $x0), 50), $center)
$g.DrawString('LOCALIZADA', $fontBig, $dark, (New-Object System.Drawing.RectangleF $x0, ($y0 + 252), ($x1 - $x0), 50), $center)

# Contornos
$g.DrawPolygon($line, $side)
$g.DrawPolygon($line, $top)
$g.DrawPolygon($line, $front)

$g.Dispose()
$bmp.Save((Resolve-Path (Split-Path $out)).Path + '\imagem-padrao.png', [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "Gerado: $out"
