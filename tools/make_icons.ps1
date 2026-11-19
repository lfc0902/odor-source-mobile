# 生成 PWA 图标（192/512/180/maskable）
Add-Type -AssemblyName System.Drawing

$OutDir = Join-Path $PSScriptRoot '..\icons'
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function New-AppIcon {
  param([int]$Size, [string]$FileName, [double]$MotifScale = 1.0)

  $bmp = New-Object System.Drawing.Bitmap($Size, $Size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.ColorTranslator]::FromHtml('#0F172A'))

  # 进入 512x512 设计坐标系，并整体居中缩放
  $g.TranslateTransform([float]($Size / 2), [float]($Size / 2))
  $k = ($Size / 512.0) * $MotifScale
  $g.ScaleTransform([float]$k, [float]$k)
  $g.TranslateTransform(-256, -256)

  $cx = 256; $cy = 352

  # 上风向扇形（60 度）
  $fill = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(110, 56, 189, 248))
  $pen  = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(255, 56, 189, 248), 8)
  $pie  = New-Object System.Drawing.RectangleF(($cx - 200), ($cy - 200), 400, 400)
  $g.FillPie($fill, $pie, 240, 60)
  $g.DrawPie($pen, $pie, 240, 60)

  # 估算位置虚线圆
  $penDash = New-Object System.Drawing.Pen([System.Drawing.Color]::FromArgb(210, 56, 189, 248), 7)
  $penDash.DashStyle = [System.Drawing.Drawing2D.DashStyle]::Dash
  $g.DrawEllipse($penDash, 256 - 46, 218 - 46, 92, 92)

  # 观测点
  $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
  $blue  = New-Object System.Drawing.SolidBrush([System.Drawing.ColorTranslator]::FromHtml('#38BDF8'))
  $g.FillEllipse($white, ($cx - 30), ($cy - 30), 60, 60)
  $g.FillEllipse($blue,  ($cx - 18), ($cy - 18), 36, 36)

  $path = Join-Path $OutDir $FileName
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)

  $penDash.Dispose(); $pen.Dispose(); $fill.Dispose(); $white.Dispose(); $blue.Dispose()
  $g.Dispose(); $bmp.Dispose()
  Write-Output ("wrote " + $path)
}

New-AppIcon -Size 512 -FileName 'icon-512.png'
New-AppIcon -Size 192 -FileName 'icon-192.png'
New-AppIcon -Size 180 -FileName 'icon-180.png'
New-AppIcon -Size 512 -FileName 'icon-maskable-512.png' -MotifScale 0.78
