#!/usr/bin/env bash
# Phase G §15 — Android release security scan. Fails (exit 1) on any violation, so it doubles as a CI
# regression guard. Scans tracked source only (node_modules / www build output / .git excluded).
set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
EX='--exclude-dir=node_modules --exclude-dir=www --exclude-dir=.git --exclude-dir=build'
say()  { echo "  $*"; }
bad()  { echo "FAIL: $*"; FAIL=1; }
ok()   { echo "ok:   $*"; }

check_absent() { # <label> <regex> <paths...>
  local label="$1"; shift; local re="$1"; shift
  local hits; hits=$(grep -rnE $EX "$re" "$@" 2>/dev/null || true)
  if [ -n "$hits" ]; then bad "$label"; echo "$hits" | sed 's/^/    /'; else ok "$label"; fi
}

echo "== no Firebase / FCM toolchain =="
check_absent "no com.google.gms / firebase gradle refs" "com\.google\.gms|com\.google\.firebase|firebase-messaging|FirebaseMessaging" android
check_absent "no @capacitor/push-notifications dependency" "@capacitor/push-notifications" package.json package-lock.json capacitor.config.json capacitor.config.e2e.json
if [ -f android/app/google-services.json ]; then bad "google-services.json must not exist"; else ok "no google-services.json"; fi

echo "== no secrets / service role in shipped source =="
check_absent "no service_role" "service_role|SUPABASE_SERVICE" js native-web android/app/src/main
check_absent "no private key blocks" "BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY" js native-web android scripts supabase

echo "== device key never hardcoded in shipped assets =="
# The E2E fixture key may live ONLY in test/orchestration code, never in native-web/ or main app source.
check_absent "no E2E device key in shipped client" "e2e-device-key-0123456789abcdef" native-web js android/app/src/main

echo "== release manifest locked down =="
M=android/app/src/main/AndroidManifest.xml
grep -qE 'android:usesCleartextTraffic="false"' "$M" && ok "release usesCleartextTraffic=false" || bad "release must set usesCleartextTraffic=false in $M"
if grep -qE 'android:debuggable="true"' "$M"; then bad "release manifest must not set debuggable=true"; else ok "no debuggable=true in release manifest"; fi
# cleartext is allowed ONLY via the debug overlay (never main/release)
if grep -qE 'usesCleartextTraffic="true"' "$M"; then bad "main manifest must not enable cleartext"; else ok "cleartext enabled only in debug overlay"; fi

echo "== external navigation locked =="
if grep -qE '"allowNavigation":[[:space:]]*\[\]' capacitor.config.json; then ok "allowNavigation is empty (no external nav)"; else bad "capacitor.config.json must keep allowNavigation empty"; fi

echo "== widget snapshot carries no secret =="
# The widget view-model is built from titles/counts only; assert the device key is never put in it.
if grep -rnE "device_key|getKeyCached|ayyam_device_key" android/app/src/main/java/com/ayyam/app/widget 2>/dev/null; then
  bad "widget code must not reference the device key"; else ok "widget snapshot references no key"; fi

echo
if [ "$FAIL" -eq 0 ]; then echo "SECURITY SCAN PASSED"; else echo "SECURITY SCAN FAILED"; fi
exit $FAIL
