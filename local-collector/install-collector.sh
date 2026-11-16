#!/usr/bin/env bash
# Installs the Mono-built collector for Linux Chrome / Chromium native messaging.
# Does not change the Windows PowerShell installer.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"

COLLECTOR_SRC="$ROOT/LessonCaptureCollector.exe"
LAUNCHER_SRC="$ROOT/LessonCaptureLauncher.exe"
if [[ ! -f "$COLLECTOR_SRC" || ! -f "$LAUNCHER_SRC" ]]; then
  echo "Missing built binaries. Run ./build.sh first." >&2
  exit 1
fi
if ! command -v mono >/dev/null 2>&1; then
  echo "mono is required on PATH to run the collector." >&2
  exit 1
fi
if ! command -v ffmpeg >/dev/null 2>&1 || ! command -v ffprobe >/dev/null 2>&1; then
  echo "ffmpeg and ffprobe must be on PATH (e.g. apt install ffmpeg)." >&2
  exit 1
fi

INSTALL_ROOT="${XDG_DATA_HOME:-$HOME/.local/share}/BenjiLessonCapture"
mkdir -p "$INSTALL_ROOT"
cp -f "$COLLECTOR_SRC" "$INSTALL_ROOT/LessonCaptureCollector.exe"
cp -f "$LAUNCHER_SRC" "$INSTALL_ROOT/LessonCaptureLauncher.exe"

# Native Messaging host must be a real executable. Wrap Mono invocations.
LAUNCHER_WRAP="$INSTALL_ROOT/lesson-capture-launcher"
COLLECTOR_WRAP="$INSTALL_ROOT/lesson-capture-collector"
cat > "$LAUNCHER_WRAP" <<EOF
#!/usr/bin/env bash
exec mono "$INSTALL_ROOT/LessonCaptureLauncher.exe"
EOF
cat > "$COLLECTOR_WRAP" <<EOF
#!/usr/bin/env bash
exec mono "$INSTALL_ROOT/LessonCaptureCollector.exe"
EOF
chmod +x "$LAUNCHER_WRAP" "$COLLECTOR_WRAP"

# Chrome / Chromium native host manifests (same extension id as Windows).
HOST_NAME="com.benji.lesson_capture"
MANIFEST_JSON=$(cat <<EOF
{
  "name": "$HOST_NAME",
  "description": "Starts the local lesson capture collector when needed.",
  "path": "$LAUNCHER_WRAP",
  "type": "stdio",
  "allowed_origins": [
    "chrome-extension://pemhnjpencigejipajkpchgmobglljcm/"
  ]
}
EOF
)

register_host() {
  local dir="$1"
  mkdir -p "$dir"
  printf '%s\n' "$MANIFEST_JSON" > "$dir/$HOST_NAME.json"
}

register_host "$HOME/.config/google-chrome/NativeMessagingHosts"
register_host "$HOME/.config/chromium/NativeMessagingHosts"
# Some agent Chromes use this path.
register_host "$HOME/.config/google-chrome-unstable/NativeMessagingHosts"

# Start collector if it is not already healthy.
if ! curl -fsS --max-time 2 "http://127.0.0.1:8766/health" >/dev/null 2>&1; then
  nohup "$COLLECTOR_WRAP" >/dev/null 2>&1 &
  sleep 1
fi

if curl -fsS --max-time 2 "http://127.0.0.1:8766/health" >/dev/null 2>&1; then
  echo "Installed Linux collector under $INSTALL_ROOT and registered Chrome native host."
else
  echo "Installed files, but health check failed. Start manually: $COLLECTOR_WRAP" >&2
  exit 1
fi
