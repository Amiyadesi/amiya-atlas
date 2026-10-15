param([string]$Sdk = $env:ANDROID_HOME, [string]$Java = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$repo = Split-Path $PSScriptRoot -Parent
Set-Location -LiteralPath $repo
if (-not $Sdk -or -not $Java) { throw '先设置 ANDROID_HOME 与 JAVA_HOME（JDK 17+）' }
$env:ANDROID_HOME = $Sdk
$env:JAVA_HOME = $Java
$env:NDK_HOME = Join-Path $Sdk 'ndk/28.2.13676358'
if (-not (Test-Path -LiteralPath "$env:NDK_HOME/source.properties")) { throw '请安装 NDK 28.2.13676358' }
if (-not (Test-Path -LiteralPath 'src-tauri/gen/android/gradlew.bat')) {
  npm.cmd run tauri -- android init --ci
  if ($LASTEXITCODE -ne 0) { throw 'Android 初始化失败' }
}
$version = (Get-Content -LiteralPath 'src-tauri/tauri.conf.json' -Raw | ConvertFrom-Json).version
$numbers = $version.Split('.')
$versionCode = [int]$numbers[0] * 1000000 + [int]$numbers[1] * 1000 + [int]$numbers[2]
[IO.File]::WriteAllText((Join-Path $repo 'src-tauri/gen/android/app/tauri.properties'), "tauri.android.versionName=$version`ntauri.android.versionCode=$versionCode`n", (New-Object Text.UTF8Encoding($false)))
$gradle = 'src-tauri/gen/android/app/build.gradle.kts'
$text = Get-Content -LiteralPath $gradle -Raw
# Pin the generated template to the published SDK used for this release.
$text = $text -replace 'compileSdk = \d+', 'compileSdk = 36' -replace 'targetSdk = \d+', 'targetSdk = 36'
[IO.File]::WriteAllText((Join-Path $repo $gradle), $text, (New-Object Text.UTF8Encoding($false)))
if (-not (Test-Path -LiteralPath (Join-Path $Sdk 'platforms/android-36/android.jar'))) { throw '请安装 Android SDK Platform 36' }
if (Test-Path -LiteralPath 'platform/android-signing.gradle.kts') {
  $text = Get-Content -LiteralPath $gradle -Raw
  $line = 'apply(from = file("../../../../platform/android-signing.gradle.kts"))'
  if (-not $text.Contains($line)) { Add-Content -LiteralPath $gradle -Value $line }
}
$toolchain = Join-Path $env:NDK_HOME 'toolchains/llvm/prebuilt/windows-x86_64/bin'
$env:TAURI_ANDROID_PROJECT_PATH = Join-Path $repo 'src-tauri/gen/android'
$env:WRY_ANDROID_PACKAGE = 'org.sayori.atlas'
$env:WRY_ANDROID_LIBRARY = 'atlas'
$env:WRY_ANDROID_KOTLIN_FILES_OUT_DIR = Join-Path $env:TAURI_ANDROID_PROJECT_PATH 'app/src/main/java/org/sayori/atlas/generated'
New-Item -ItemType Directory -Path $env:WRY_ANDROID_KOTLIN_FILES_OUT_DIR -Force | Out-Null
$env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER = Join-Path $toolchain 'aarch64-linux-android24-clang.cmd'
$env:CC_aarch64_linux_android = $env:CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER
$env:AR_aarch64_linux_android = Join-Path $toolchain 'llvm-ar.exe'
$ErrorActionPreference = 'Continue'
npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw '前端构建失败' }
cargo build --manifest-path src-tauri/Cargo.toml --locked --release --lib --target aarch64-linux-android --features tauri/custom-protocol
if ($LASTEXITCODE -ne 0) { throw 'Android Rust 构建失败' }
$jni = 'src-tauri/gen/android/app/src/main/jniLibs/arm64-v8a'
New-Item -ItemType Directory -Path $jni -Force | Out-Null
Copy-Item -LiteralPath 'src-tauri/target/aarch64-linux-android/release/libatlas.so' -Destination (Join-Path $jni 'libatlas.so') -Force
Push-Location -LiteralPath 'src-tauri/gen/android'
try {
  .\gradlew.bat assembleArm64Release -x rustBuildArm64Release '-Pkotlin.incremental=false' --no-daemon --console=plain
  if ($LASTEXITCODE -ne 0) { throw 'Android APK 构建失败' }
} finally { Pop-Location }
$ErrorActionPreference = 'Stop'
