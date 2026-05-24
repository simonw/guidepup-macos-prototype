#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo_root="$(cd "$script_dir/.." && pwd)"
cd "$repo_root"

setup_mode="${GUIDEPUP_SETUP_MODE:-local}"
run_root="${VOICEOVER_RUN_ROOT:-}"
install_webkit=true
core_timeout_seconds="${VOICEOVER_CORE_TIMEOUT_SECONDS:-240}"
voiceover_rate_as_percent="${VOICEOVER_RATE_AS_PERCENT:-180}"

usage() {
  cat <<'USAGE'
Usage: scripts/run-voiceover-media-smoke.sh [options]

Options:
  --setup-mode local|ci|skip   local runs npx @guidepup/setup, ci expects setup-action already ran
  --run-root PATH              write artifacts, recordings, and test-results under PATH
  --require-audio true|false   fail if system-audio probe is missing or silent
  --audio-seconds N            duration for the ScreenCaptureKit audio probe
  --core-timeout-seconds N     timeout for the Node VoiceOver smoke core
  --voiceover-rate-percent N   real VoiceOver speech rate percent; defaults to 180
  --skip-webkit-install        do not run npx playwright install webkit
  -h, --help                   show this help
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --setup-mode)
      setup_mode="$2"
      shift 2
      ;;
    --run-root)
      run_root="$2"
      shift 2
      ;;
    --require-audio)
      export REQUIRE_SYSTEM_AUDIO="$2"
      shift 2
      ;;
    --audio-seconds)
      export AUDIO_PROBE_SECONDS="$2"
      shift 2
      ;;
    --core-timeout-seconds)
      core_timeout_seconds="$2"
      shift 2
      ;;
    --voiceover-rate-percent)
      voiceover_rate_as_percent="$2"
      shift 2
      ;;
    --skip-webkit-install)
      install_webkit=false
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 64
      ;;
  esac
done

case "$setup_mode" in
  local|ci|skip) ;;
  *)
    echo "--setup-mode must be local, ci, or skip" >&2
    exit 64
    ;;
esac

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "VoiceOver media smoke requires macOS." >&2
  exit 69
fi

if [[ -z "$run_root" && "$setup_mode" == "local" ]]; then
  run_root="local-runs/voiceover-media-smoke-$(date +%Y%m%d-%H%M%S)"
fi

if [[ -n "$run_root" ]]; then
  export VOICEOVER_ARTIFACTS_DIR="$run_root/artifacts"
  export VOICEOVER_RECORDINGS_DIR="$run_root/recordings"
  export VOICEOVER_TEST_RESULTS_DIR="$run_root/test-results"
else
  export VOICEOVER_ARTIFACTS_DIR="${VOICEOVER_ARTIFACTS_DIR:-artifacts}"
  export VOICEOVER_RECORDINGS_DIR="${VOICEOVER_RECORDINGS_DIR:-recordings}"
  export VOICEOVER_TEST_RESULTS_DIR="${VOICEOVER_TEST_RESULTS_DIR:-test-results}"
fi

export REQUIRE_SYSTEM_AUDIO="${REQUIRE_SYSTEM_AUDIO:-true}"
export AUDIO_PROBE_SECONDS="${AUDIO_PROBE_SECONDS:-45}"
export VOICEOVER_CORE_TIMEOUT_SECONDS="$core_timeout_seconds"
export VOICEOVER_RATE_AS_PERCENT="$voiceover_rate_as_percent"

mkdir -p "$VOICEOVER_ARTIFACTS_DIR" "$VOICEOVER_RECORDINGS_DIR" "$VOICEOVER_TEST_RESULTS_DIR"

echo "VoiceOver media smoke"
echo "  setup mode: $setup_mode"
echo "  artifacts: $VOICEOVER_ARTIFACTS_DIR"
echo "  recordings: $VOICEOVER_RECORDINGS_DIR"
echo "  test results: $VOICEOVER_TEST_RESULTS_DIR"
echo "  require audio: $REQUIRE_SYSTEM_AUDIO"
echo "  audio seconds: $AUDIO_PROBE_SECONDS"
echo "  core timeout seconds: $VOICEOVER_CORE_TIMEOUT_SECONDS"
echo "  VoiceOver speech rate percent: $VOICEOVER_RATE_AS_PERCENT"

terminate_process_tree() {
  local signal="$1"
  local pid="$2"
  local children

  children="$(pgrep -P "$pid" 2>/dev/null || true)"
  for child in $children; do
    terminate_process_tree "$signal" "$child"
  done

  kill "-$signal" "$pid" 2>/dev/null || true
}

run_with_timeout() {
  local seconds="$1"
  local label="$2"
  shift 2

  local safe_label
  safe_label="$(printf '%s' "$label" | tr -c 'A-Za-z0-9_.-' '_')"
  local timed_out_file="${TMPDIR:-/tmp}/guidepup-timeout-${safe_label}-$$"
  rm -f "$timed_out_file"

  "$@" &
  local command_pid="$!"

  (
    sleep "$seconds"
    if kill -0 "$command_pid" 2>/dev/null; then
      echo "$label timed out after ${seconds}s" >&2
      printf '%s timed out after %ss\n' "$label" "$seconds" > "$timed_out_file"
      terminate_process_tree TERM "$command_pid"
      sleep 5
      terminate_process_tree KILL "$command_pid"
    fi
  ) &
  local watchdog_pid="$!"

  local status
  if wait "$command_pid"; then
    status=0
  else
    status="$?"
  fi

  kill "$watchdog_pid" 2>/dev/null || true
  wait "$watchdog_pid" 2>/dev/null || true

  if [[ -f "$timed_out_file" ]]; then
    cat "$timed_out_file" >&2
    rm -f "$timed_out_file"
    return 124
  fi

  return "$status"
}

capture_with_timeout() {
  local seconds="$1"
  local output="$2"
  local label="$3"
  shift 3

  local status
  if run_with_timeout "$seconds" "$label" "$@" > "$output" 2>&1; then
    status=0
  else
    status="$?"
  fi

  if [[ "$status" -ne 0 ]]; then
    printf '\n%s exited with status %s\n' "$label" "$status" >> "$output"
  fi

  return 0
}

if [[ "$install_webkit" == true ]]; then
  node node_modules/playwright/cli.js install webkit
fi

case "$setup_mode" in
  local)
    npx --yes @guidepup/setup@0.21.0
    ;;
  ci|skip)
    ;;
esac

capture_with_timeout 20 "$VOICEOVER_ARTIFACTS_DIR/macos-version.txt" "sw_vers" sw_vers
capture_with_timeout 30 "$VOICEOVER_ARTIFACTS_DIR/audio-devices.txt" "system_profiler SPAudioDataType" system_profiler SPAudioDataType
capture_with_timeout 30 "$VOICEOVER_ARTIFACTS_DIR/displays.txt" "system_profiler SPDisplaysDataType" system_profiler SPDisplaysDataType
capture_with_timeout 20 "$VOICEOVER_ARTIFACTS_DIR/simctl-list.txt" "xcrun simctl list" xcrun simctl list

npm run build:audio-probe

core_status=0
run_with_timeout "$VOICEOVER_CORE_TIMEOUT_SECONDS" "VoiceOver media smoke core" \
  npm run test:voiceover:media || core_status="$?"

if [[ ! -f "$VOICEOVER_ARTIFACTS_DIR/summary.md" ]]; then
  cat > "$VOICEOVER_ARTIFACTS_DIR/summary.md" <<SUMMARY
# VoiceOver Media Smoke

## Errors
- VoiceOver media smoke core exited without writing summary.md.
- Core exit status was $core_status.
SUMMARY

  if [[ "$core_status" -eq 0 ]]; then
    core_status=1
  fi
fi

if [[ -f "$VOICEOVER_ARTIFACTS_DIR/summary.json" ]]; then
  if ! node -e 'const fs = require("node:fs"); const summary = JSON.parse(fs.readFileSync(process.argv[1], "utf8")); process.exit(summary.finalized === true ? 0 : 1);' "$VOICEOVER_ARTIFACTS_DIR/summary.json"; then
    {
      echo
      echo "## Errors"
      echo "- VoiceOver media smoke summary was written before finalization completed."
    } >> "$VOICEOVER_ARTIFACTS_DIR/summary.md"
    core_status=1
  fi
fi

echo
echo "Generated files:"
find "$VOICEOVER_ARTIFACTS_DIR" "$VOICEOVER_RECORDINGS_DIR" "$VOICEOVER_TEST_RESULTS_DIR" \
  -maxdepth 3 -type f -print 2>/dev/null | sort || true

if [[ -f "$VOICEOVER_ARTIFACTS_DIR/summary.md" ]]; then
  echo
  cat "$VOICEOVER_ARTIFACTS_DIR/summary.md"
fi

exit "$core_status"
