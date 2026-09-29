#!/usr/bin/env bash
# Phase B persistence orchestration — runs on a booted emulator (inside android-emulator-runner).
# Proves IndexedDB + Keystore secure-store survive: process-death, reboot, APK reinstall, and that
# the app shell loads offline from local bundled assets.
set -uo pipefail

PKG=com.ayyam.app
RUNNER="$PKG.test/androidx.test.runner.AndroidJUnitRunner"
APK=android/app/build/outputs/apk/debug/app-debug.apk
TESTAPK=android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk

runtest() { # $1 = Class#method
  echo "== instrument: $1 =="
  local out
  out=$(adb shell am instrument -w -e class "$1" "$RUNNER" 2>&1)
  echo "$out"
  if echo "$out" | grep -q "FAILURES!!!"; then echo "TEST FAILED: $1"; exit 1; fi
  if ! echo "$out" | grep -qE "OK \("; then echo "TEST DID NOT REPORT OK: $1"; exit 1; fi
}
wait_boot() {
  adb wait-for-device
  until [ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" = "1" ]; do sleep 2; done
  sleep 3
}

wait_boot
adb install -r "$APK"
adb install -r "$TESTAPK"

echo "### 0) widget store validation (schema / last-known-good / rapid / no-secret)"
runtest 'com.ayyam.app.WidgetStoreValidationTest'

echo "### 0b) widget RemoteViews rendering (normal / stale / empty / all-done / no-snapshot)"
runtest 'com.ayyam.app.WidgetRenderTest'

echo "### 0c) Back handling + deep-link cold-start (Phase E)"
runtest 'com.ayyam.app.BackAndDeepLinkTest'

echo "### 0d) F1: Web Push capability probe inside the WebView"
runtest 'com.ayyam.app.WebPushProbeTest'

echo "### 0e) Local notifications: receiver stale-guard + store validation"
runtest 'com.ayyam.app.NotifReceiverTest'

echo "### 0f) Local notifications: no duplicate alarms across re-plans + boot re-schedule"
runtest 'com.ayyam.app.NotifSchedulerTest'

echo "### 0g) Widget redesign: render every size/state to PNGs for visual review"
runtest 'com.ayyam.app.WidgetScreenshotTest'
# The debug APK is debuggable → read the PNGs from the app's INTERNAL files dir via run-as (scoped
# storage on API 30 blocks a plain adb pull of Android/data).
mkdir -p widget-shots-out
for name in small_normal small_all_done medium_normal medium_privacy medium_all_done medium_empty medium_stale medium_no_snapshot large_normal; do
  adb exec-out run-as com.ayyam.app cat "files/widget-shots/$name.png" > "widget-shots-out/$name.png" 2>/dev/null || true
done
find widget-shots-out -type f -size 0 -delete 2>/dev/null || true
echo "pulled widget shots:"; ls -1 widget-shots-out 2>/dev/null || echo "(none)"

echo "### 1) fresh write (local-asset load + IDB + Keystore + widget snapshot)"
runtest 'com.ayyam.app.ShellPersistenceTest#writeMarker'
runtest 'com.ayyam.app.SecureStoreTest#writeKey'
runtest 'com.ayyam.app.WidgetSnapshotStoreTest#writeWidget'

echo "### 2) process death (force-stop) then verify"
adb shell am force-stop "$PKG"
runtest 'com.ayyam.app.ShellPersistenceTest#verifyMarker'
runtest 'com.ayyam.app.SecureStoreTest#verifyKey'
runtest 'com.ayyam.app.WidgetSnapshotStoreTest#verifyWidget'

echo "### 3) reboot then verify"
adb reboot
wait_boot
runtest 'com.ayyam.app.ShellPersistenceTest#verifyMarker'
runtest 'com.ayyam.app.SecureStoreTest#verifyKey'
runtest 'com.ayyam.app.WidgetSnapshotStoreTest#verifyWidget'

echo "### 4) APK update over same package (reinstall keeping data) then verify"
adb install -r "$APK"
runtest 'com.ayyam.app.ShellPersistenceTest#verifyMarker'
runtest 'com.ayyam.app.SecureStoreTest#verifyKey'
runtest 'com.ayyam.app.WidgetSnapshotStoreTest#verifyWidget'

echo "### 5) offline app-shell load"
adb shell svc wifi disable || true
adb shell svc data disable || true
runtest 'com.ayyam.app.ShellPersistenceTest#verifyOffline'

echo "ALL PERSISTENCE PROOFS PASSED"
