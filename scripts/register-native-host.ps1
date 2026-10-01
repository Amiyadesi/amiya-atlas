param([string]$InstallDir = (Split-Path -Parent $PSScriptRoot))
$ErrorActionPreference = 'Stop'
$hostName = 'org.sayori.atlas'
$hostDir = Join-Path $InstallDir 'native-host'
$binary = Join-Path $hostDir 'amiya_atlas_native_host.exe'
$manifest = Join-Path $hostDir 'org.sayori.atlas.json'
New-Item -ItemType Directory -Force -Path $hostDir | Out-Null
@{
  name = $hostName
  description = 'Amiya Atlas browser capture bridge'
  path = $binary
  type = 'stdio'
  allowed_origins = @('chrome-extension://ikegkdiefpdlgbbhajphefckcjicacdc/')
} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath $manifest
New-Item -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$hostName" -Name '(default)' -Value $manifest
New-Item -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" -Force | Out-Null
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\$hostName" -Name '(default)' -Value $manifest
Write-Output "Registered $hostName for Chrome and Edge."
