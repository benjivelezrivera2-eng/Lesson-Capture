<#!
Installs the collector for the interactive Windows user. It registers a
sign-in launcher and Chrome native-messaging host without Codex or Python.
#>
param()

$ErrorActionPreference = 'Stop'
$source = Join-Path $PSScriptRoot 'LessonCaptureCollector.exe'
if (-not (Test-Path $source)) { throw "Collector executable is missing: $source" }
$launcherSource = Join-Path $PSScriptRoot 'LessonCaptureLauncher.exe'
if (-not (Test-Path $launcherSource)) { throw "Launcher executable is missing: $launcherSource" }

$root = Join-Path $env:LOCALAPPDATA 'BenjiLessonCapture'
$destination = Join-Path $root 'LessonCaptureCollector.exe'
$launcherDestination = Join-Path $root 'LessonCaptureLauncher.exe'
$nativeHostManifest = Join-Path $root 'com.benji.lesson_capture.json'
New-Item -ItemType Directory -Force -Path $root | Out-Null
function Copy-IfChanged([string]$from, [string]$to) {
  if ((Test-Path $to) -and ((Get-FileHash -LiteralPath $from).Hash -eq (Get-FileHash -LiteralPath $to).Hash)) {
    return
  }
  Copy-Item -LiteralPath $from -Destination $to -Force
}

# The collector holds its executable open while listening. Re-running the
# installer must not interrupt a running lesson or fail while registering the
# restart hooks. Defer a changed binary until the collector is stopped.
$health = $null
try { $health = Invoke-RestMethod 'http://127.0.0.1:8766/health' -TimeoutSec 2 } catch { }
$collectorHealthy = $health.ok -and $health.service -eq 'LessonCaptureCollector'
if ($collectorHealthy -and (Test-Path $destination)) {
  if ((Get-FileHash -LiteralPath $source).Hash -ne (Get-FileHash -LiteralPath $destination).Hash) {
    Write-Warning 'Collector is running; its binary update was deferred so active captures remain undisturbed.'
  }
} else {
  Copy-IfChanged $source $destination
}
Copy-Item -LiteralPath $launcherSource -Destination $launcherDestination -Force

$nativeHost = @{
  name = 'com.benji.lesson_capture'
  description = 'Starts the local lesson capture collector when needed.'
  path = $launcherDestination
  type = 'stdio'
  allowed_origins = @('chrome-extension://pemhnjpencigejipajkpchgmobglljcm/')
} | ConvertTo-Json -Depth 3
Set-Content -LiteralPath $nativeHostManifest -Value $nativeHost -Encoding UTF8
# Chrome reads the Registry *default* value for a native host. PowerShell's
# literal '(default)' property creates a named value instead, which Chrome
# ignores after restart. Codex can run under a sandbox account while the
# installed helper belongs to the interactive Windows profile, so resolve that
# profile's SID from the destination path instead of blindly writing HKCU.
$profilePath = Split-Path -Parent (Split-Path -Parent (Split-Path -Parent $root))
$profile = Get-ChildItem 'HKLM:\SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList' | ForEach-Object {
  $imagePath = (Get-ItemProperty -Path $_.PSPath -Name ProfileImagePath -ErrorAction SilentlyContinue).ProfileImagePath
  if ($imagePath -eq $profilePath) { $_.PSChildName }
} | Select-Object -First 1
if (-not $profile) { throw "Could not find the Windows profile SID for $profilePath; refusing to register under the wrong account." }
$nativeKey = "HKU\$profile\Software\Google\Chrome\NativeMessagingHosts\com.benji.lesson_capture"
& reg.exe add $nativeKey /ve /t REG_SZ /d $nativeHostManifest /f | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not register the Chrome native host.' }

$taskName = 'Benji Lesson Capture Collector'
$startupLauncher = Join-Path $root 'StartLessonCapture.vbs'
# Register the real interactive user's Run key. A scheduled task can be denied
# or removed by managed Windows policy, and the old Startup-folder fallback did
# not survive a reboot on this machine. The script keeps the console hidden and
# skips launch when the collector is already listening.
@"
On Error Resume Next
Set request = CreateObject("MSXML2.ServerXMLHTTP")
request.setTimeouts 1000, 1000, 1000, 1000
request.Open "GET", "http://127.0.0.1:8766/health", False
request.Send
If Err.Number <> 0 Or request.Status <> 200 Then
  Err.Clear
  Set shell = CreateObject("WScript.Shell")
  shell.Run Chr(34) & "$destination" & Chr(34), 0, False
End If
"@ | Set-Content -LiteralPath $startupLauncher -Encoding ASCII
$runKey = "HKU\$profile\Software\Microsoft\Windows\CurrentVersion\Run"
$runCommand = '"' + (Join-Path $env:WINDIR 'System32\wscript.exe') + '" "' + $startupLauncher + '"'
& reg.exe add $runKey /v $taskName /t REG_SZ /d $runCommand /f | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Could not register the collector at sign-in.' }

# Avoid starting a second collector if the installer is run while a capture
# helper is already healthy. A new one would compete for the same local port.
if (-not $collectorHealthy) {
  Start-Process -FilePath $destination -WindowStyle Hidden
  Start-Sleep -Milliseconds 500
  $health = Invoke-RestMethod 'http://127.0.0.1:8766/health' -TimeoutSec 5
}
if (-not $health.ok -or $health.service -ne 'LessonCaptureCollector') { throw 'Collector health check did not reach the new collector.' }
Write-Output "Collector installed and healthy. Capture folder: $($health.outputRoot)"
