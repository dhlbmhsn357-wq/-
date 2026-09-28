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
  adb logcat -c 2>/dev/null || true
  local out
  out=$(adb shell am instrument -w -e class "$1" "$RUNNER" 2>&1)
  echo "$out"
  if echo "$out" | grep -q "FAILURES!!!"; then echo "TEST FAILED: $1"; dump_backend; dump_logcat; exit 1; fi
  if ! echo "$out" | grep -qE "OK \("; then echo "TEST DID NOT REPORT OK: $1"; dump_backend; dump_logcat; exit 1; fi
}
peer() { echo "== peer: $* =="; node scripts/e2e-peer.mjs "$@" --base "$BASE" || { echo "PEER FAILED"; exit 1; }; }
outage() { curl -sf -X POST "$BASE/__ctl/outage?mode=${1:-}" >/dev/null && echo "outage=${1:-off}"; }
reset_backend() { curl -sf -X POST "$BASE/__ctl/reset" >/dev/null && echo "backend reset"; }
dump_backend() { echo "---- backend log ----"; tail -40 /tmp/e2e-backend.log 2>/dev/null || true; echo "---- server state ----"; curl -s "$BASE/__ctl/db" | head -c 800 || true; echo; }
dump_logcat() { echo "---- logcat (crash / app / chromium) ----"; adb logcat -d -t 400 2>/dev/null | grep -iE "AndroidRuntime|FATAL|ayyam|Capacitor|chromium|SecureStore|NotifBridge|WidgetBridge|E/|System.err" | tail -120 || true; echo "---- end logcat ----"; }
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

C=com.ayyam.app.SyncE2ETest
TWEB="ويب-مهمة"   # must match SyncE2ETest.T_WEB
stop_app() { adb shell am force-stop "$PKG" >/dev/null 2>&1; }
# NOTE on isolation: the mock's /__ctl/outage is a GLOBAL backend outage, so the web-peer can only act
# while it is OFF. That is fine because the Android app only syncs WHILE an instrument method runs — it
# is not running between methods. So we: make Android edit under outage, force-stop it (no lingering
# sync after we lift the outage), lift the outage, let the peer act, then relaunch Android to sync.

KEY="e2e-device-key-0123456789abcdef"   # must match SyncE2ETest.KEY / tests/e2e/server.mjs
assert_no_key_in_logs() {
  if adb logcat -d 2>/dev/null | grep -F "$KEY" >/dev/null; then echo "FAIL: device key value leaked into logcat"; exit 1; fi
  echo "ok: device key not present in logs"
}

echo "### Device-key gate regression (fresh install → enter key → gate gone; wrong key → re-prompt)"
runtest "$C#tKeyEnterWithInvisibleCharsAccepted"   # correct key wrapped in bidi/zero-width marks → accepted
stop_app
runtest "$C#tKeyReopenPersistsNoPrompt"            # force-stop + reopen → key persists, no prompt
stop_app
runtest "$C#tKeyClearKey"                          # clear the stored key
stop_app
runtest "$C#tKeyWrongReprompts"                    # wrong key → gate returns (no silent pass)
stop_app

echo "### Scenario 0: reset backend + seed Keystore device key"
runtest "$C#t0_resetAndSeedKey"

echo "### Scenario 1: Android offline edit → reconnect → server receives → outbox clears"
outage down
runtest "$C#t1a_offlineEdit"
stop_app
outage ''            # back online
adb logcat -c 2>/dev/null || true    # clear, then a real app sync happens in t1b (key sent over the network, never logged)
runtest "$C#t1b_reconnectServerReceivesOutboxClears"
assert_no_key_in_logs
stop_app

echo "### Scenario 2: Web + Android multi-device → both changes persist"
peer add "$TWEB"     # backend is up
runtest "$C#t2_multiDeviceBothPersist"
stop_app

echo "### Scenario 3: Web delete + stale Android → delete wins (no resurrection)"
runtest "$C#t3a_holdStaleOffline"    # Android is stale from t2: it still holds T_WEB (backend up, not deleted yet)
stop_app
peer delete "$TWEB"                  # web deletes; Android has not seen it yet (its app is not running)
runtest "$C#t3b_staleDeleteWins"     # Android reconnects → tombstone wins → not resurrected
stop_app

echo "### Scenario 4: Web Reset + stale Android → epoch fence prevents resurrection"
outage down
runtest "$C#t4a_offlineEditBeforeReset"  # Android queues an OLD-generation edit while offline
stop_app                                  # ensure no lingering sync pushes it once the outage lifts
outage ''
peer reset                                # web bumps the epoch (new generation) — Android app is not running
runtest "$C#t4b_resetEpochFence"          # Android reconnects → adopts new epoch, parks the old edit
stop_app

echo "### Scenario 5: kill/reopen mid-pending → same op_id, sync resumes, no duplicate"
outage down
runtest "$C#t5a_offlineEditCaptureOpId"
echo "-- kill the app while the edit is pending --"
stop_app
outage ''
runtest "$C#t5b_reopenResumesNoDuplicate"

echo "ALL 5 ANDROID SYNC SCENARIOS PASSED"
