Add-Type -AssemblyName System.Drawing

$ErrorActionPreference = "Stop"

$outPng = Join-Path $PSScriptRoot "..\docs\kubernetes-cluster-scheme.png"
$outJpg = Join-Path $PSScriptRoot "..\docs\kubernetes-cluster-scheme.jpg"

$bmp = New-Object System.Drawing.Bitmap 1800, 1400
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
$g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit

function Brush {
  param([string]$hex)
  return New-Object System.Drawing.SolidBrush ([System.Drawing.ColorTranslator]::FromHtml($hex))
}

function SchemeFont {
  param(
    [single]$size,
    [System.Drawing.FontStyle]$style = [System.Drawing.FontStyle]::Regular
  )
  return New-Object System.Drawing.Font -ArgumentList @("Arial", [single]$size, $style, [System.Drawing.GraphicsUnit]::Pixel)
}

function Box {
  param([single]$x, [single]$y, [single]$w, [single]$h, [string]$fill, [string]$stroke = "#8da2bf")
  $rect = New-Object System.Drawing.RectangleF $x, $y, $w, $h
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $r = 14
  $path.AddArc($x, $y, $r, $r, 180, 90)
  $path.AddArc(($x + $w - $r), $y, $r, $r, 270, 90)
  $path.AddArc(($x + $w - $r), ($y + $h - $r), $r, $r, 0, 90)
  $path.AddArc($x, ($y + $h - $r), $r, $r, 90, 90)
  $path.CloseFigure()
  $g.FillPath((Brush $fill), $path)
  $g.DrawPath((New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($stroke), 2)), $path)
}

function Text {
  param(
    [string]$s,
    [single]$x,
    [single]$y,
    [single]$size = 20,
    [string]$color = "#1b2737",
    [bool]$bold = $false
  )
  $style = if ($bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $g.DrawString($s, (SchemeFont -size $size -style $style), (Brush $color), [single]$x, [single]$y)
}

function Arrow {
  param([single]$x1, [single]$y1, [single]$x2, [single]$y2, [string]$color = "#52677f", [bool]$dash = $false)
  $p = New-Object System.Drawing.Pen ([System.Drawing.ColorTranslator]::FromHtml($color), 3)
  $p.EndCap = [System.Drawing.Drawing2D.LineCap]::ArrowAnchor
  if ($dash) { $p.DashPattern = @(8, 8) }
  $g.DrawLine($p, [single]$x1, [single]$y1, [single]$x2, [single]$y2)
}

$g.Clear([System.Drawing.ColorTranslator]::FromHtml("#f6f8fb"))

Text "Схема работы Kubernetes-кластера от балансировщика" 60 38 28 "#1b2737" $true
Text "Данные сервиса взяты из реальной БД orchestrator_db, внешний k8s-контур - из deploy/k8s." 60 76 18 "#3d4b5f"

Box 40 125 480 290 "#ffffff" "#d4dce8"
Text "Внешний вход" 70 150 24 "#1b2737" $true
Box 80 205 360 70 "#edf5ff" "#4d82bd"
Text "Пользователь / клиент" 110 226 20
Text "HTTPS-запрос" 110 252 17 "#3d4b5f"
Box 80 315 360 70 "#edf5ff" "#4d82bd"
Text "Cloudflare / балансировщик" 110 336 20
Text "health-check и маршрутизация на ноды" 110 362 17 "#3d4b5f"

Box 570 125 1170 730 "#ffffff" "#d4dce8"
Text "Kubernetes k3s cluster: namespace ai-prod" 600 150 24 "#1b2737" $true

Box 610 205 330 100 "#fff6df" "#c7902a"
Text "Нода 1" 635 226 20
Text "ingress-nginx DaemonSet" 635 254 17 "#3d4b5f"
Text "hostPort 80/443" 635 278 17 "#3d4b5f"
Box 980 205 330 100 "#fff6df" "#c7902a"
Text "Нода 2" 1005 226 20
Text "ingress-nginx DaemonSet" 1005 254 17 "#3d4b5f"
Text "hostPort 80/443" 1005 278 17 "#3d4b5f"
Box 1350 205 330 100 "#fff6df" "#c7902a"
Text "Нода 3" 1375 226 20
Text "ingress-nginx DaemonSet" 1375 254 17 "#3d4b5f"
Text "hostPort 80/443" 1375 278 17 "#3d4b5f"

Box 845 360 550 86 "#f4efff" "#7c61bd"
Text "Ingress ai-prod" 875 383 20
Text "host: orchestrator.example.com, TLS: origin-ca-tls" 875 411 17 "#3d4b5f"

Box 735 500 360 90 "#edf5ff" "#4d82bd"
Text "Service orchestrator-service:80" 760 523 20
Text "ClusterIP для backend + frontend" 760 552 17 "#3d4b5f"
Box 1195 500 360 90 "#edf5ff" "#4d82bd"
Text "Deployment orchestrator-service" 1220 523 20
Text "replicas: 1, RUNNER_ENABLED=true" 1220 552 17 "#3d4b5f"
Box 735 650 360 90 "#eef8f1" "#4f9c65"
Text "Service tools-service:4188" 760 673 20
Text "внутренний сервис инструментов" 760 702 17 "#3d4b5f"
Box 1195 650 360 90 "#eef8f1" "#4f9c65"
Text "Deployment tools-service" 1220 673 20
Text "hostPath /srv/projects -> /projects" 1220 702 17 "#3d4b5f"

Box 40 455 480 830 "#ffffff" "#d4dce8"
Text "Факты из orchestrator_db" 70 480 24 "#1b2737" $true
Box 80 535 380 92 "#ffffff"
Text "projects" 105 558 20
Text "2 активных проекта:" 105 586 17 "#3d4b5f"
Text "PROJECT Оркестратор, PROJECT_2 ПС" 105 610 17 "#3d4b5f"
Box 80 655 380 78 "#ffffff"
Text "services" 105 678 20
Text "45 сервисных записей" 105 706 18 "#1b2737" $true
Box 80 760 380 120 "#ffffff"
Text "tasks" 105 783 20
Text "13 638 всего, 340 активных" 105 811 17 "#3d4b5f"
Text "PROJECT: 154 активных" 105 835 17 "#3d4b5f"
Text "PROJECT_2: 186 активных" 105 859 17 "#3d4b5f"
Box 80 905 380 110 "#ffffff"
Text "roles / connectors" 105 928 20
Text "19 ролей, 1 MCP-роль" 105 956 17 "#3d4b5f"
Text "5 включенных коннекторов" 105 980 17 "#3d4b5f"
Box 80 1045 380 145 "#ffffff"
Text "service_dependencies" 105 1068 20
Text "Catalog_Service -> IAM_Service GRPC" 105 1096 16 "#3d4b5f"
Text "Chat_Service -> Connector_Service REST" 105 1120 16 "#3d4b5f"
Text "Chat_Service -> IAM_Service GRPC" 105 1144 16 "#3d4b5f"
Text "deployments в БД: 0 записей" 80 1220 15 "#56657a"

Box 570 925 640 370 "#ffffff" "#d4dce8"
Text "PostgreSQL в k8s" 600 950 24 "#1b2737" $true
Box 610 1000 250 68 "#eef8f1" "#4f9c65"
Text "pg-main-rw:5432" 635 1023 20
Text "primary / write" 635 1048 17 "#3d4b5f"
Box 910 1000 250 68 "#eef8f1" "#4f9c65"
Text "pg-main-ro:5432" 935 1023 20
Text "read replicas" 935 1048 17 "#3d4b5f"
Box 680 1110 420 110 "#eef8f1" "#4f9c65"
Text "CNPG Cluster pg-main" 705 1133 20
Text "instances: 3, DB: orchestrator_db" 705 1162 17 "#3d4b5f"
Text "storage: local-path 20Gi" 705 1186 17 "#3d4b5f"

Box 1240 925 500 370 "#ffffff" "#d4dce8"
Text "Реальная БД-источник" 1270 950 24 "#1b2737" $true
Box 1280 1000 420 70 "#fff0f0" "#c75d5d"
Text "infra-haproxy-1:5000" 1305 1023 20
Text "локально 127.0.0.1:5432/6432" 1305 1048 17 "#3d4b5f"
Box 1280 1095 420 50 "#fff0f0" "#c75d5d"
Text "infra-pgbouncer-1:5432" 1305 1112 20
Box 1280 1170 420 50 "#fff0f0" "#c75d5d"
Text "infra-patroni1-1 / PostgreSQL 16" 1305 1187 20
Box 1335 1245 310 58 "#f8fbff" "#4d82bd"
Text "orchestrator_db" 1400 1263 20

Arrow 260 275 260 315
Arrow 440 350 610 255
Arrow 440 350 980 255
Arrow 440 350 1350 255
Arrow 775 305 930 360
Arrow 1145 305 1130 360
Arrow 1515 305 1310 360
Arrow 1120 446 935 500
Arrow 1095 545 1195 545
Arrow 1375 590 1375 650
Arrow 1195 695 1095 695
Arrow 1375 590 860 1000
Arrow 1375 590 1280 1035
Arrow 735 545 460 580 "#8a99aa" $true
Arrow 735 545 460 715 "#8a99aa" $true
Arrow 735 545 460 820 "#8a99aa" $true
Arrow 860 1034 910 1034
Arrow 735 1068 820 1110
Arrow 1035 1068 960 1110
Arrow 1490 1070 1490 1095
Arrow 1490 1145 1490 1170
Arrow 1490 1220 1490 1245

Text "Поток: Cloudflare -> ingress-nginx на любой ноде -> Ingress -> Service -> pod orchestrator-service." 610 830 15 "#56657a"
Text "Примечание: отдельные k8s-объекты не хранятся в БД; они взяты из deploy/k8s, а факты сервисного слоя - из orchestrator_db." 610 1360 15 "#56657a"

$bmp.Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)

$jpgEncoder = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq "image/jpeg" }
$encoderParams = New-Object System.Drawing.Imaging.EncoderParameters 1
$encoderParams.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter ([System.Drawing.Imaging.Encoder]::Quality), 92L
$bmp.Save($outJpg, $jpgEncoder, $encoderParams)

$g.Dispose()
$bmp.Dispose()

Write-Output "Wrote $outPng"
Write-Output "Wrote $outJpg"

