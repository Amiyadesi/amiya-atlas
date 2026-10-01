$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$target = Join-Path $root 'src-tauri\binaries'
New-Item -ItemType Directory -Force -Path $target | Out-Null
Copy-Item (Join-Path $root 'native-host\target\release\amiya_atlas_native_host.exe') (Join-Path $target 'amiya_atlas_native_host-x86_64-pc-windows-msvc.exe') -Force
@{
  name = 'org.sayori.atlas'
  description = 'Amiya Atlas browser capture bridge'
  path = 'amiya_atlas_native_host.exe'
  type = 'stdio'
  allowed_origins = @('chrome-extension://ikegkdiefpdlgbbhajphefckcjicacdc/')
} | ConvertTo-Json | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $root 'native-host\org.sayori.atlas.json')
