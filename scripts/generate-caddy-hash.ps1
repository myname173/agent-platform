$ErrorActionPreference = 'Stop'
$Docker = 'C:\Users\LINLEE\AppData\Local\Programs\DockerDesktop\resources\bin\docker.exe'

if (-not (Test-Path $Docker)) { throw "docker not found: $Docker" }

$secure = Read-Host 'Storage console password' -AsSecureString
$ptr = [IntPtr]::Zero
try {
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
  & $Docker run --rm caddy:2-alpine caddy hash-password --plaintext $plain
  if ($LASTEXITCODE -ne 0) { throw "docker failed with exit code $LASTEXITCODE" }
} finally {
  if ($ptr -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
  }
}
