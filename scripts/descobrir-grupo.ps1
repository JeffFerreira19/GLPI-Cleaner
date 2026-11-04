# Descobre o ID do grupo tecnico no GLPI (usa os tokens do .env)
# Uso: powershell -ExecutionPolicy Bypass -File .\scripts\descobrir-grupo.ps1 -Nome "Nivel 1"
param([string]$Nome = "N1")
$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
if (-not $PSScriptRoot) { $root = (Get-Location).Path }
$cfg = @{}
Get-Content (Join-Path $root ".env") | Where-Object { $_ -match '^\s*[A-Z_]+\s*=' } | ForEach-Object {
  $k, $v = $_ -split '=', 2
  $cfg[$k.Trim()] = $v.Trim().Trim("'").Trim('"')
}
$G = $cfg.GLPI_API_URL.TrimEnd('/')
$h = @{ "Content-Type" = "application/json"; "Authorization" = "user_token $($cfg.GLPI_USER_TOKEN)" }
if ($cfg.GLPI_APP_TOKEN) { $h["App-Token"] = $cfg.GLPI_APP_TOKEN }

$s = (Invoke-RestMethod "$G/initSession" -Headers $h).session_token
$h.Remove("Authorization"); $h["Session-Token"] = $s
Invoke-RestMethod "$G/changeActiveEntities" -Method Post -Headers $h -Body '{"entities_id":0,"is_recursive":true}' | Out-Null

Write-Host "`nGrupos com '$Nome' no nome:" -ForegroundColor Cyan
$grupos = Invoke-RestMethod "$G/Group?searchText[name]=$([uri]::EscapeDataString($Nome))&range=0-100" -Headers $h
$grupos | Select-Object id, name, completename, @{n='atribuivel';e={$_.is_assign}} | Format-Table -AutoSize

Write-Host "searchOption do 'Grupo tecnico' em Ticket:" -ForegroundColor Cyan
$so = Invoke-RestMethod "$G/listSearchOptions/Ticket" -Headers $h
$so.PSObject.Properties | Where-Object { $_.Value.table -eq 'glpi_groups' } |
  ForEach-Object { "{0,-5} {1}" -f $_.Name, $_.Value.name }

Invoke-RestMethod "$G/killSession" -Headers $h | Out-Null
