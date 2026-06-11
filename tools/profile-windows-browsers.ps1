param(
  [string]$Url = "https://evilquest.net/play",
  [int]$Port = 9223,
  [int]$Seconds = 20,
  [string[]]$Browsers = @("Chrome", "Brave", "Edge"),
  [switch]$Autorun,
  [switch]$ZipLatest
)

$ErrorActionPreference = "Stop"

function Get-LatestProfilerRun {
  param([string]$RunRoot)

  if (-not (Test-Path $RunRoot)) {
    return $null
  }

  return Get-ChildItem -Path $RunRoot -Directory |
    Sort-Object Name -Descending |
    Select-Object -First 1
}

function Resolve-BrowserPath {
  param([string]$Browser)

  if (Test-Path $Browser) {
    return [pscustomobject]@{
      Name = [System.IO.Path]::GetFileNameWithoutExtension($Browser)
      Path = (Resolve-Path $Browser).Path
    }
  }

  $programFilesX86 = ${env:ProgramFiles(x86)}
  $candidates = @{
    Chrome = @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "$programFilesX86\Google\Chrome\Application\chrome.exe"
    )
    Brave = @(
      "$env:ProgramFiles\BraveSoftware\Brave-Browser\Application\brave.exe",
      "$programFilesX86\BraveSoftware\Brave-Browser\Application\brave.exe"
    )
    Edge = @(
      "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
      "$programFilesX86\Microsoft\Edge\Application\msedge.exe"
    )
  }

  if (-not $candidates.ContainsKey($Browser)) {
    throw "Unknown browser '$Browser'. Use Chrome, Brave, Edge, or pass a full .exe path."
  }

  foreach ($path in $candidates[$Browser]) {
    if ($path -and (Test-Path $path)) {
      return [pscustomobject]@{
        Name = $Browser
        Path = $path
      }
    }
  }

  throw "$Browser was not found in the standard install locations. Pass the full .exe path in -Browsers."
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runRoot = Join-Path $repoRoot "tools\profiler-runs"
$singleProfiler = Join-Path $PSScriptRoot "profile-windows-brave.ps1"
$capturedRuns = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $Browsers.Count; $i++) {
  $browser = Resolve-BrowserPath -Browser $Browsers[$i]
  $runPort = $Port + $i
  Write-Host ""
  Write-Host "=== Browser capture $($i + 1)/$($Browsers.Count): $($browser.Name) ==="
  Write-Host "This run uses DevTools port $runPort."
  Write-Host "Close $($browser.Name) fully before this run so the DevTools flag is applied."
  Read-Host "Press Enter after $($browser.Name) is closed"

  $previousLatestRun = Get-LatestProfilerRun -RunRoot $runRoot
  $previousLatestRunName = if ($null -eq $previousLatestRun) { $null } else { $previousLatestRun.Name }

  $profilerArgs = @(
    "-Url", $Url,
    "-BrowserName", $browser.Name,
    "-BrowserPath", $browser.Path,
    "-Port", $runPort,
    "-Seconds", $Seconds
  )
  if ($Autorun) { $profilerArgs += "-Autorun" }
  if ($ZipLatest) { $profilerArgs += "-ZipLatest" }

  & $singleProfiler @profilerArgs

  $latestRun = Get-LatestProfilerRun -RunRoot $runRoot
  $createdNewRun = $null -ne $latestRun -and $latestRun.Name -ne $previousLatestRunName
  if ($createdNewRun) {
    [void]$capturedRuns.Add($latestRun.FullName)
  } else {
    Write-Warning "No new run was captured for $($browser.Name)."
  }
}

if ($capturedRuns.Count -gt 0) {
  Push-Location $repoRoot
  try {
    Write-Host ""
    Write-Host "=== Browser comparison summary ==="
    bun tools/summarize-profiler-backends.mjs @capturedRuns
    if ($LASTEXITCODE -ne 0) {
      throw "summarize-profiler-backends.mjs failed with exit code $LASTEXITCODE"
    }
  } finally {
    Pop-Location
  }
} else {
  Write-Warning "No profiler runs were captured, so there is nothing to summarize."
}
