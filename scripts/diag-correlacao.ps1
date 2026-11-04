# Diagnostico de correlacao chamado GLPI x evento Zabbix
# Uso: powershell -ExecutionPolicy Bypass -File .\scripts\diag-correlacao.ps1 -Busca "Ponto 147" -DataChamado "2026-09-30 16:16:41"
param(
  [string]$Busca = "Ponto 147",
  [string]$DataChamado = "2026-09-30 16:16:41"
)
$ErrorActionPreference = "Stop"

$root = if ($PSScriptRoot) { Split-Path -Parent $PSScriptRoot } else { (Get-Location).Path }
$envFile = Join-Path $root ".env"
if (-not (Test-Path $envFile)) { throw "Arquivo .env nao encontrado em $root" }

$cfg = @{}
Get-Content $envFile | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  $cfg[$k.Trim()] = $v.Trim().Trim("'").Trim('"')
}
$Z = $cfg.ZABBIX_API_URL
$T = $cfg.ZABBIX_API_TOKEN
$offsetTxt = if ($cfg.GLPI_UTC_OFFSET) { $cfg.GLPI_UTC_OFFSET } else { "-03:00" }

if ($offsetTxt -notmatch '^([+-])(\d{2}):?(\d{2})$') { throw "GLPI_UTC_OFFSET invalido: $offsetTxt" }
$offsetMin = [int]$Matches[2] * 60 + [int]$Matches[3]
if ($Matches[1] -eq '-') { $offsetMin = -$offsetMin }

$epoch = Get-Date -Year 1970 -Month 1 -Day 1 -Hour 0 -Minute 0 -Second 0 -Millisecond 0
function ToUnix([string]$glpiDate) {
  $local = Get-Date -Date ($glpiDate -replace ' ', 'T')
  [int64](($local - $epoch).TotalSeconds) - ($offsetMin * 60)
}
function FromUnix([int64]$unix) {
  $epoch.AddSeconds($unix + ($offsetMin * 60)).ToString("yyyy-MM-dd HH:mm:ss")
}

function Zbx($method, $params) {
  $body = @{ jsonrpc = "2.0"; method = $method; params = $params; id = 1 }
  $headers = @{}
  if ($cfg.ZABBIX_AUTH_MODE -eq "body") { $body.auth = $T } else { $headers.Authorization = "Bearer $T" }
  $r = Invoke-RestMethod $Z -Method Post -ContentType "application/json-rpc" -Headers $headers `
        -Body ($body | ConvertTo-Json -Depth 10)
  if ($r.error) { throw "$method : $($r.error.message) $($r.error.data)" }
  $r.result
}

Write-Host "`n[1] Zabbix configurado: $Z" -ForegroundColor Cyan
Write-Host ("Hosts visiveis para o token: " + (Zbx "host.get" @{ countOutput = $true }))

Write-Host "`n[2] Hosts com '$Busca' no nome" -ForegroundColor Cyan
$hosts = @(Zbx "host.get" @{
  output = @("hostid", "host", "name")
  search = @{ name = $Busca; host = $Busca }
  searchByAny = $true
})
if ($hosts.Count -eq 0) {
  Write-Host "NENHUM host encontrado -> outro servidor Zabbix ou token sem permissao" -ForegroundColor Yellow
  return
}
$hosts | Format-Table hostid, host, name -AutoSize

$ticketUnix = ToUnix $DataChamado
Write-Host ("Abertura do chamado: $DataChamado ($offsetTxt) = unix $ticketUnix")

Write-Host "`n[3] Eventos de problema desses hosts (24h antes e depois do chamado)" -ForegroundColor Cyan
$ev = @(Zbx "event.get" @{
  hostids = @($hosts | ForEach-Object { $_.hostid }); source = 0; object = 0; value = 1
  time_from = $ticketUnix - 86400; time_till = $ticketUnix + 86400
  output = @("eventid", "name", "clock"); sortfield = @("clock"); sortorder = "DESC"; limit = 50
})
if ($ev.Count -eq 0) {
  Write-Host "Nenhum evento no periodo." -ForegroundColor Yellow
  return
}
$ev | ForEach-Object {
  [pscustomobject]@{
    eventid       = $_.eventid
    inicio        = FromUnix ([int64]$_.clock)
    seg_ate_abrir = $ticketUnix - [int64]$_.clock
    nome          = $_.name
  }
} | Format-Table -AutoSize -Wrap
