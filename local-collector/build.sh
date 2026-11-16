#!/usr/bin/env bash
# Builds the local collector and native launcher for Linux (Mono).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

if ! command -v mcs >/dev/null 2>&1; then
  echo "Mono C# compiler (mcs) not found. Install mono-devel, then retry." >&2
  exit 1
fi

mcs -nologo -r:System.Web.Extensions.dll \
  -out:"$ROOT/LessonCaptureCollector.exe" \
  "$ROOT/LessonCaptureCollector.cs"

mcs -nologo \
  -out:"$ROOT/LessonCaptureLauncher.exe" \
  "$ROOT/LessonCaptureLauncher.cs"

chmod +x "$ROOT/LessonCaptureCollector.exe" "$ROOT/LessonCaptureLauncher.exe" 2>/dev/null || true
echo "Built the local collector and native launcher (Mono)."
