param(
  [string]$Url = "https://evilquest.net/play",
  [string]$BravePath = "C:\Program Files\BraveSoftware\Brave-Browser\Application\brave.exe",
  [int]$Port = 9223,
  [int]$Seconds = 20,
  [string[]]$Backends = @("default", "d3d11", "gl"),
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

function Add-CommonArgs {
  param(
    [System.Collections.ArrayList]$Arguments,
    [string]$Url,
    [string]$BravePath,
    [int]$Port,
    [int]$Seconds,
    [bool]$Autorun,
    [bool]$ZipLatest
  )

  [void]$Arguments.Add("-Url")
  [void]$Arguments.Add($Url)
  [void]$Arguments.Add("-BravePath")
  [void]$Arguments.Add($BravePath)
  [void]$Arguments.Add("-Port")
  [void]$Arguments.Add($Port)
  [void]$Arguments.Add("-Seconds")
  [void]$Arguments.Add($Seconds)
  if ($Autorun) { [void]$Arguments.Add("-Autorun") }
  if ($ZipLatest) { [void]$Arguments.Add("-ZipLatest") }
}

$validBackends = @("default", "d3d11", "d3d11on12", "d3d9", "gl", "vulkan", "swiftshader")
foreach ($backend in $Backends) {
  if ($validBackends -notcontains $backend) {
    throw "Invalid backend '$backend'. Expected one of: $($validBackends -join ', ')"
  }
}

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runRoot = Join-Path $repoRoot "tools\profiler-runs"
$singleProfiler = Join-Path $PSScriptRoot "profile-windows-brave.ps1"
$capturedRuns = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $Backends.Count; $i++) {
  $backend = $Backends[$i]
  Write-Host ""
  Write-Host "=== Brave backend capture $($i + 1)/$($Backends.Count): $backend ==="
  Write-Host "Close Brave fully before this run so the backend flag is applied."
  Read-Host "Press Enter after Brave is closed"

  $previousLatestRun = Get-LatestProfilerRun -RunRoot $runRoot
  $previousLatestRunName = if ($null -eq $previousLatestRun) { $null } else { $previousLatestRun.Name }

  $profilerArgs = New-Object System.Collections.ArrayList
  Add-CommonArgs -Arguments $profilerArgs -Url $Url -BravePath $BravePath -Port $Port -Seconds $Seconds -Autorun:$Autorun.IsPresent -ZipLatest:$ZipLatest.IsPresent
  if ($backend -ne "default") {
    [void]$profilerArgs.Add("-AngleBackend")
    [void]$profilerArgs.Add($backend)
  }

  & $singleProfiler @profilerArgs

  $latestRun = Get-LatestProfilerRun -RunRoot $runRoot
  $createdNewRun = $null -ne $latestRun -and $latestRun.Name -ne $previousLatestRunName
  if ($createdNewRun) {
    [void]$capturedRuns.Add($latestRun.FullName)
  } else {
    Write-Warning "No new run was captured for backend '$backend'."
  }
}

if ($capturedRuns.Count -gt 0) {
  Push-Location $repoRoot
  try {
    Write-Host ""
    Write-Host "=== Brave backend summary ==="
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
