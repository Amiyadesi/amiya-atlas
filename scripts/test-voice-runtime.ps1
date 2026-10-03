$ErrorActionPreference = 'Stop'
$voiceTestRoot = Join-Path $env:RUNNER_TEMP ('atlas-voice-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $voiceTestRoot | Out-Null
function Write-CanonicalWav([string]$url, [string]$destination) {
  $sourcePath = Join-Path $voiceTestRoot 'source.wav'
  Invoke-WebRequest $url -OutFile $sourcePath
  $bytes = [IO.File]::ReadAllBytes($sourcePath)
  $offset = 12
  $data = $null
  while ($offset + 8 -le $bytes.Length) {
    $kind = [Text.Encoding]::ASCII.GetString($bytes, $offset, 4)
    $size = [BitConverter]::ToUInt32($bytes, $offset + 4)
    if ($kind -eq 'fmt ') {
      if ([BitConverter]::ToUInt16($bytes, $offset + 8) -ne 1 -or [BitConverter]::ToUInt16($bytes, $offset + 10) -ne 1 -or [BitConverter]::ToUInt32($bytes, $offset + 12) -ne 16000 -or [BitConverter]::ToUInt16($bytes, $offset + 22) -ne 16) { throw 'Unexpected public sample format' }
    }
    if ($kind -eq 'data') { $data = [byte[]]$bytes[($offset + 8)..($offset + 7 + $size)]; break }
    $offset += 8 + $size + ($size % 2)
  }
  if (-not $data) { throw 'Public sample has no PCM data' }
  $writer = [IO.BinaryWriter]::new([IO.File]::Create($destination))
  try {
    $writer.Write([Text.Encoding]::ASCII.GetBytes('RIFF')); $writer.Write([uint32](36 + $data.Length)); $writer.Write([Text.Encoding]::ASCII.GetBytes('WAVEfmt '))
    $writer.Write([uint32]16); $writer.Write([uint16]1); $writer.Write([uint16]1); $writer.Write([uint32]16000)
    $writer.Write([uint32]32000); $writer.Write([uint16]2); $writer.Write([uint16]16); $writer.Write([Text.Encoding]::ASCII.GetBytes('data'))
    $writer.Write([uint32]$data.Length); $writer.Write($data)
  } finally { $writer.Dispose() }
  Remove-Item $sourcePath
}
try {
  Write-CanonicalWav 'https://raw.githubusercontent.com/ggml-org/whisper.cpp/v1.9.4/samples/jfk.wav' (Join-Path $voiceTestRoot 'jfk.wav')
  Write-CanonicalWav 'https://huggingface.co/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/2365baeacb507f821a0c8120fcee3d484dba7a07/test_wavs/zh.wav' (Join-Path $voiceTestRoot 'zh.wav')
  $env:ATLAS_TEST_WHISPER_DIR = $voiceTestRoot
  # Calls the native checksum-verified installer and the same process wrapper as the app.
  cargo test --manifest-path src-tauri/Cargo.toml --no-default-features --lib --locked voice::tests::real_runtime -- --nocapture
  if ($LASTEXITCODE -ne 0) { throw 'Native voice runtime test failed' }
} finally {
  Remove-Item Env:ATLAS_TEST_WHISPER_DIR -ErrorAction SilentlyContinue
  Remove-Item -Recurse -Force $voiceTestRoot -ErrorAction SilentlyContinue
}
