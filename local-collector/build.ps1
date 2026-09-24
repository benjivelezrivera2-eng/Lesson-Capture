param()

$ErrorActionPreference = 'Stop'
$compiler = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
  throw "The .NET Framework C# compiler was not found: $compiler"
}

$collectorOutput = Join-Path $PSScriptRoot 'LessonCaptureCollector.exe'
$collectorSource = Join-Path $PSScriptRoot 'LessonCaptureCollector.cs'
& $compiler /nologo /target:winexe /reference:System.Web.Extensions.dll "/out:$collectorOutput" $collectorSource
if ($LASTEXITCODE -ne 0) { throw 'Collector build failed.' }

$launcherOutput = Join-Path $PSScriptRoot 'LessonCaptureLauncher.exe'
$launcherSource = Join-Path $PSScriptRoot 'LessonCaptureLauncher.cs'
& $compiler /nologo /target:winexe "/out:$launcherOutput" $launcherSource
if ($LASTEXITCODE -ne 0) { throw 'Native launcher build failed.' }

Write-Output 'Built the local collector and native launcher.'
