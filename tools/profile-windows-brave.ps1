param(
  [string]$Url = "https://evilquest.net/play",
  [string]$BravePath = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
  [string]$BrowserName = "Brave",
  [string]$BrowserPath = "",
  [int]$Port = 9223,
  [int]$Seconds = 20,
  [string]$AngleBackend = "",
  [string[]]$ExtraBrowserArg = @(),
  [switch]$NoLaunch,
  [switch]$Autorun,
  [switch]$ZipLatest
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

function Get-LatestProfilerRun {
  param([string]$RunRoot)

  if (-not (Test-Path $RunRoot)) {
    return $null
  }

  return Get-ChildItem -Path $RunRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
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

  $validAngleBackends = @("d3d11", "d3d11on12", "d3d9", "gl", "vulkan", "swiftshader")
  if ($AngleBackend -and $validAngleBackends -notcontains $AngleBackend) {
    throw "Invalid -AngleBackend '$AngleBackend'. Expected one of: $($validAngleBackends -join ', ')"
  }

  if (-not $NoLaunch) {
    $launchPath = if ($BrowserPath) { $BrowserPath } else { $BravePath }
    if (-not (Test-Path $launchPath)) {
      throw "$BrowserName was not found at '$launchPath'. Pass -BrowserPath with the installed browser .exe path."
    }

    $browserArgs = @(
      "--remote-debugging-port=$Port",
      "--enable-precise-memory-info"
    )
    if ($AngleBackend) {
      $browserArgs += "--use-angle=$AngleBackend"
    }
    if ($ExtraBrowserArg.Count -gt 0) {
      $browserArgs += $ExtraBrowserArg
    }
    $browserArgs += $Url

    Write-Host "Starting $BrowserName with DevTools port $Port..."
    Write-Host "If $BrowserName was already running, close it fully first so the debugging flag is applied."
    if ($AngleBackend) {
      Write-Host "Forcing ANGLE backend: $AngleBackend"
    }
    if ($ExtraBrowserArg.Count -gt 0) {
      Write-Host "Extra browser args: $($ExtraBrowserArg -join ' ')"
    }
    Start-Process -FilePath $launchPath -ArgumentList $browserArgs
  } else {
    Write-Host "Using an already-running $BrowserName/Chromium DevTools port $Port."
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
    $runRoot = Join-Path $repoRoot "tools\profiler-runs"
    $previousLatestRun = Get-LatestProfilerRun -RunRoot $runRoot
    $previousLatestRunName = if ($null -eq $previousLatestRun) { $null } else { $previousLatestRun.Name }

    if (-not $Autorun) {
      Write-Host ""
      Write-Host "Log in to EvilQuest in $BrowserName, wait until the FPS state is visible, then type 'capture' here."
      Write-Host "The profiler will attach to the existing tab and will not reload it."
      Write-Host "After the capture finishes, type 'quit' to return to PowerShell."
      Write-Host ""
    }
    bun tools/browser-profiler.mjs $Url
    if ($LASTEXITCODE -ne 0) {
      throw "browser-profiler failed with exit code $LASTEXITCODE"
    }

    $latestRun = Get-LatestProfilerRun -RunRoot $runRoot
    $createdNewRun = $null -ne $latestRun -and $latestRun.Name -ne $previousLatestRunName
    if (-not $createdNewRun) {
      Write-Warning "No new profiler run was created. Type 'capture' before 'quit' to record one."
    } else {
      Write-Host ""
      Write-Host "Diagnosing profiler run: $($latestRun.Name)"
      bun tools/diagnose-profiler-run.mjs $latestRun.FullName --write
      if ($LASTEXITCODE -ne 0) {
        Write-Warning "diagnose-profiler-run failed with exit code $LASTEXITCODE"
      }
    }

    if ($ZipLatest) {
      if (-not $createdNewRun) {
        Write-Warning "Skipping zip because no new profiler run was created."
      } else {
        $zipPath = Join-Path $runRoot ($latestRun.Name + ".zip")
        if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
        Compress-Archive -Path (Join-Path $latestRun.FullName "*") -DestinationPath $zipPath -Force
        Write-Host "Packaged latest profiler run: $zipPath"
      }
    }
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
