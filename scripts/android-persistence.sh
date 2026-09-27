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

echo "### 1) fresh write (local-asset load + IDB write + Keystore write)"
runtest 'com.ayyam.app.ShellPersistenceTest#writeMarker'
runtest 'com.ayyam.app.SecureStoreTest#writeKey'

echo "### 2) process death (force-stop) then verify"
adb shell am force-stop "$PKG"
runtest 'com.ayyam.app.ShellPersistenceTest#verifyMarker'
runtest 'com.ayyam.app.SecureStoreTest#verifyKey'

echo "### 3) reboot then verify"
adb reboot
wait_boot
runtest 'com.ayyam.app.ShellPersistenceTest#verifyMarker'
runtest 'com.ayyam.app.SecureStoreTest#verifyKey'

echo "### 4) APK update over same package (reinstall keeping data) then verify"
adb install -r "$APK"
runtest 'com.ayyam.app.ShellPersistenceTest#verifyMarker'
runtest 'com.ayyam.app.SecureStoreTest#verifyKey'

echo "### 5) offline app-shell load"
adb shell svc wifi disable || true
adb shell svc data disable || true
runtest 'com.ayyam.app.ShellPersistenceTest#verifyOffline'

echo "ALL PERSISTENCE PROOFS PASSED"
