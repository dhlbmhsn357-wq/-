#!/usr/bin/env bash
# Phase G — REAL Android WebView ↔ backend sync E2E orchestration. Runs on a booted emulator (inside
# android-emulator-runner) with the isolated backend (tests/e2e/server.mjs) started here on the host;
# the emulator's WebView reaches it at 10.0.2.2. The APK under test is the AYYAM_E2E build.
#
# This script interleaves the on-device instrumented @Test methods (SyncE2ETest) with the two things
# that must happen BETWEEN app launches: toggling the simulated backend outage, and running the
# "web-peer" device (scripts/e2e-peer.mjs) against the same backend. Cross-launch state lives on the
# device (IndexedDB outbox + Keystore key), exactly like the real app.
set -uo pipefail

PKG=com.ayyam.app
RUNNER="$PKG.test/androidx.test.runner.AndroidJUnitRunner"
APK=android/app/build/outputs/apk/debug/app-debug.apk
TESTAPK=android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk
BASE=http://localhost:8799

runtest() { # $1 = Class#method
  echo "== instrument: $1 =="
  local out
  out=$(adb shell am instrument -w -e class "$1" "$RUNNER" 2>&1)
  echo "$out"
  if echo "$out" | grep -q "FAILURES!!!"; then echo "TEST FAILED: $1"; dump_backend; exit 1; fi
  if ! echo "$out" | grep -qE "OK \("; then echo "TEST DID NOT REPORT OK: $1"; dump_backend; exit 1; fi
}
peer() { echo "== peer: $* =="; node scripts/e2e-peer.mjs "$@" --base "$BASE" || { echo "PEER FAILED"; exit 1; }; }
outage() { curl -sf -X POST "$BASE/__ctl/outage?mode=${1:-}" >/dev/null && echo "outage=${1:-off}"; }
reset_backend() { curl -sf -X POST "$BASE/__ctl/reset" >/dev/null && echo "backend reset"; }
dump_backend() { echo "---- backend log ----"; tail -40 /tmp/e2e-backend.log 2>/dev/null || true; echo "---- server state ----"; curl -s "$BASE/__ctl/db" | head -c 800 || true; echo; }
wait_boot() {
  adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
  sleep 3
}

# ---- start the isolated backend on the host ----
node tests/e2e/server.mjs > /tmp/e2e-backend.log 2>&1 &
BACKEND_PID=$!
trap 'kill $BACKEND_PID 2>/dev/null || true' EXIT
for i in $(seq 1 40); do curl -sf "$BASE/__ctl/db" >/dev/null 2>&1 && break; sleep 1; done
curl -sf "$BASE/__ctl/db" >/dev/null 2>&1 || { echo "backend failed to start"; cat /tmp/e2e-backend.log; exit 1; }
echo "backend up (pid $BACKEND_PID)"

wait_boot
adb install -r "$APK"
adb install -r "$TESTAPK"

echo "### G-1 smoke: Keystore key + online add reaches the isolated backend"
reset_backend
runtest 'com.ayyam.app.SyncE2ETest#smoke_keyThenOnlineAddReachesServer'

echo "ANDROID SYNC E2E (G-1 smoke) PASSED"
