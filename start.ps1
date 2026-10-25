param([switch]$NoBrowser, [switch]$Stop)
$ErrorActionPreference = 'Stop'
$projectDirectory = $PSScriptRoot
$serverFile = Join-Path $projectDirectory 'server.mjs'
$dataDirectory = Join-Path $projectDirectory 'data'
$pidFile = Join-Path $dataDirectory 'server.pid'
$portNumber = if ($env:PORT) { [int]$env:PORT } else { 8765 }
$appUrl = "http://127.0.0.1:$portNumber"

function Get-WorkspaceHealth {
    try { return Invoke-RestMethod -Uri "$appUrl/api/health" -TimeoutSec 2 } catch { return $null }
}

if ($Stop) {
    if (-not (Test-Path -LiteralPath $pidFile)) {
        Write-Host 'No background service started by this launcher.'
        exit 0
    }
    $serviceProcessId = [int](Get-Content -LiteralPath $pidFile -Raw)
    $serviceProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $serviceProcessId"
    if ($serviceProcess -and $serviceProcess.Name -eq 'node.exe' -and $serviceProcess.CommandLine.Contains($serverFile)) {
        Stop-Process -Id $serviceProcessId
        Write-Host 'Workspace service stopped.'
    } else {
        Write-Host 'The recorded service is no longer running.'
    }
    Remove-Item -LiteralPath $pidFile
    exit 0
}

$health = Get-WorkspaceHealth
if ($health -and $health.app -eq 'eval-dataset-workspace') {
    Write-Host "Workspace is already running: $appUrl"
    if (-not $NoBrowser) { Start-Process $appUrl }
    exit 0
}
if ($health) { throw "Port $portNumber is in use by another service. Set PORT to another number." }

if ($env:EVAL_NODE) {
    $nodeExecutable = $env:EVAL_NODE
} else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if (-not $nodeCommand) { throw 'Node.js 22 or newer is required. Install Node.js and add it to PATH.' }
    $nodeExecutable = $nodeCommand.Source
}
$nodeVersion = & $nodeExecutable --version
if ([int]($nodeVersion.TrimStart('v').Split('.')[0]) -lt 22) { throw 'Node.js 22 or newer is required.' }
New-Item -ItemType Directory -Path $dataDirectory -Force | Out-Null
$stdoutFile = Join-Path $dataDirectory 'server.stdout.log'
$stderrFile = Join-Path $dataDirectory 'server.stderr.log'
$process = Start-Process -FilePath $nodeExecutable -ArgumentList ('"' + $serverFile + '"') -WorkingDirectory $projectDirectory -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile -PassThru
$ready = $false
for ($attempt = 0; $attempt -lt 20; $attempt++) {
    Start-Sleep -Milliseconds 250
    $process.Refresh()
    if ($process.HasExited) { break }
    $health = Get-WorkspaceHealth
    if ($health -and $health.app -eq 'eval-dataset-workspace') { $ready = $true; break }
}
if (-not $ready) {
    $process.Refresh()
    if (-not $process.HasExited) { Stop-Process -Id $process.Id }
    throw "Could not start workspace on port $portNumber. Check $stderrFile"
}
Set-Content -LiteralPath $pidFile -Value $process.Id -Encoding ascii
Write-Host "Workspace started: $appUrl"
if (-not $NoBrowser) { Start-Process $appUrl }
