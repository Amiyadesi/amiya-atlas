param([string]$InstallDir)
$ErrorActionPreference = 'Stop'
if (-not $InstallDir) {
  $InstallDir = (Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Amiya Atlas').InstallLocation.Trim('"')
}
$InstallDir = (Resolve-Path -LiteralPath $InstallDir).ProviderPath
foreach ($file in @('amiya-atlas.exe', 'amiya_atlas_native_host.exe', 'extension\manifest.json', 'extension\id.txt', 'native-host\org.sayori.atlas.json')) {
  if (-not (Test-Path -LiteralPath (Join-Path $InstallDir $file) -PathType Leaf)) { throw "Missing installed file: $file" }
}
$manifestPath = Join-Path $InstallDir 'native-host\org.sayori.atlas.json'
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$expectedHost = Join-Path $InstallDir 'amiya_atlas_native_host.exe'
if ([IO.Path]::GetFullPath($manifest.path) -ne $expectedHost) { throw 'Native host path does not match the installed binary' }
if (-not (Test-Path -LiteralPath $manifest.path -PathType Leaf)) { throw 'Native host binary is missing' }
$extensionId = (Get-Content -LiteralPath (Join-Path $InstallDir 'extension\id.txt') -Raw).Trim()
if ($manifest.name -ne 'org.sayori.atlas' -or $manifest.type -ne 'stdio' -or $manifest.allowed_origins.Count -ne 1 -or $manifest.allowed_origins[0] -ne "chrome-extension://$extensionId/") { throw 'Native host manifest is invalid' }
foreach ($browser in @('Google\Chrome', 'Microsoft\Edge')) {
  $key = Get-Item -LiteralPath "HKCU:\Software\$browser\NativeMessagingHosts\org.sayori.atlas"
  if ($key.GetValue('') -ne $manifestPath) { throw "Incorrect native host registration: $browser" }
}
Write-Output "PASS: app, extension, native host JSON and Chrome/Edge registration ($InstallDir)"
