param(
  [string]$Url = "https://evilquest.net/play",
  [string]$BravePath = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
  [int]$Port = 9223,
  [int]$Seconds = 20,
  [switch]$NoLaunch,
  [switch]$Autorun
)

$ErrorActionPreference = "Stop"

function Wait-CdpPort {
  param([int]$Port)

  $endpoint = "http://127.0.0.1:$Port/json/version"
  for ($i = 0; $i -lt 80; $i++) {
    try {
      Invoke-WebRequest -UseBasicParsing -Uri $endpoint -TimeoutSec 1 | Out-Null
      return
    } catch {
      Start-Sleep -Milliseconds 250
    }
  }
  throw "Chrome DevTools endpoint did not appear on $endpoint"
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$oldCdpPort = $env:CDP_PORT
$oldAttach = $env:PROFILE_ATTACH_EXISTING_CDP
$oldSeconds = $env:PROFILE_SECONDS
$oldAutorun = $env:PROFILE_AUTORUN
$oldReload = $env:PROFILE_RELOAD_BEFORE_CAPTURE

try {
  if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
    throw "bun was not found in PATH. Run this from the same shell where Bun works."
  }

  if (-not $NoLaunch) {
    if (-not (Test-Path $BravePath)) {
      throw "Brave was not found at '$BravePath'. Pass -BravePath with the installed brave.exe path."
    }

    Write-Host "Starting Brave with DevTools port $Port..."
    Write-Host "If Brave was already running, close it fully first so the debugging flag is applied."
    Start-Process -FilePath $BravePath -ArgumentList @(
      "--remote-debugging-port=$Port",
      "--enable-precise-memory-info",
      $Url
    )
  } else {
    Write-Host "Using an already-running Brave/Chromium DevTools port $Port."
  }

  Wait-CdpPort -Port $Port

  $env:CDP_PORT = [string]$Port
  $env:PROFILE_ATTACH_EXISTING_CDP = "1"
  $env:PROFILE_SECONDS = [string]$Seconds
  $env:PROFILE_RELOAD_BEFORE_CAPTURE = "0"
  if ($Autorun) {
    $env:PROFILE_AUTORUN = "1"
  } else {
    Remove-Item Env:\PROFILE_AUTORUN -ErrorAction SilentlyContinue
  }

  Push-Location $repoRoot
  try {
    if (-not $Autorun) {
      Write-Host ""
      Write-Host "Log in to EvilQuest in Brave, wait until the bad FPS is visible, then type 'capture' here."
      Write-Host "The profiler will attach to the existing tab and will not reload it."
      Write-Host ""
    }
    bun tools/browser-profiler.mjs $Url
  } finally {
    Pop-Location
  }
} finally {
  if ($null -eq $oldCdpPort) { Remove-Item Env:\CDP_PORT -ErrorAction SilentlyContinue } else { $env:CDP_PORT = $oldCdpPort }
  if ($null -eq $oldAttach) { Remove-Item Env:\PROFILE_ATTACH_EXISTING_CDP -ErrorAction SilentlyContinue } else { $env:PROFILE_ATTACH_EXISTING_CDP = $oldAttach }
  if ($null -eq $oldSeconds) { Remove-Item Env:\PROFILE_SECONDS -ErrorAction SilentlyContinue } else { $env:PROFILE_SECONDS = $oldSeconds }
  if ($null -eq $oldAutorun) { Remove-Item Env:\PROFILE_AUTORUN -ErrorAction SilentlyContinue } else { $env:PROFILE_AUTORUN = $oldAutorun }
  if ($null -eq $oldReload) { Remove-Item Env:\PROFILE_RELOAD_BEFORE_CAPTURE -ErrorAction SilentlyContinue } else { $env:PROFILE_RELOAD_BEFORE_CAPTURE = $oldReload }
}
