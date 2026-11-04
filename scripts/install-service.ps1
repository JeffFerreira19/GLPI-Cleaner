# Executar como Administrador, na pasta do projeto
param(
  [string]$ServiceName = "ZabbixGlpiCleaner",
  [string]$NssmPath = ""
)

$ErrorActionPreference = "Stop"
$ProjectDir = Split-Path -Parent $PSScriptRoot

# --- Localiza o NSSM ---
if (-not $NssmPath) {
  $cmd = Get-Command nssm -ErrorAction SilentlyContinue
  if ($cmd) { $NssmPath = $cmd.Source }
}
if (-not $NssmPath) {
  $svc = Get-CimInstance Win32_Service | Where-Object PathName -like "*nssm*" | Select-Object -First 1
  if ($svc) { $NssmPath = ($svc.PathName -replace '"', '').Trim() }
}
if (-not $NssmPath -or -not (Test-Path $NssmPath)) {
  throw "nssm.exe nao encontrado. Informe com -NssmPath 'C:\...\nssm.exe'"
}
Write-Host "NSSM: $NssmPath"

$NodeExe = (Get-Command node).Source

# --- Build ---
Set-Location $ProjectDir
if (-not (Test-Path "$ProjectDir\.env")) { throw ".env nao encontrado (copie de .env.example)" }
npm.cmd install
npm.cmd run build
if (-not (Test-Path "$ProjectDir\dist\server.js")) { throw "Build falhou: dist\server.js nao encontrado" }
New-Item -ItemType Directory -Force -Path "$ProjectDir\logs" | Out-Null

# --- Recria o servico ---
$ErrorActionPreference = "Continue"
& $NssmPath stop $ServiceName 2>$null | Out-Null
& $NssmPath remove $ServiceName confirm 2>$null | Out-Null
$ErrorActionPreference = "Stop"

& $NssmPath install $ServiceName $NodeExe "dist\server.js"
& $NssmPath set $ServiceName AppDirectory $ProjectDir
& $NssmPath set $ServiceName AppStdout "$ProjectDir\logs\service.out.log"
& $NssmPath set $ServiceName AppStderr "$ProjectDir\logs\service.err.log"
& $NssmPath set $ServiceName AppRotateFiles 1
& $NssmPath set $ServiceName AppRotateBytes 10485760
& $NssmPath set $ServiceName Start SERVICE_AUTO_START
& $NssmPath start $ServiceName

Start-Sleep -Seconds 3
Get-Service $ServiceName
Invoke-RestMethod "http://127.0.0.1:3910/health"
