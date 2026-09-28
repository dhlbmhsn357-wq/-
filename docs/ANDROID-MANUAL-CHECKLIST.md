# أيام — Android manual device checklist (Phase G)

These are the checks that **cannot** be proven in CI (the emulator is `google_apis`, no Play services,
no real clock/time-travel, no touch/gesture reality) and that must be run on a **real phone** with the
debug APK before an Android release. Nothing here is claimed as passing until *you* run it — CI proves
the logic underneath (scheduling, stale-guard, persistence, sync convergence); the phone proves the
lived behavior.

How to install: build the debug APK in CI (artifact `ayyam-debug-apk`) or locally
(`node scripts/build-webdir.mjs && npx cap sync android && cd android && ./gradlew :app:assembleDebug`),
then `adb install -r app-debug.apk`. This is the **normal** build (real Supabase backend + Keystore
key), not the E2E build.

## Install & shell
- [ ] APK installs and opens **offline** (airplane mode) — the shell loads from bundled assets.
- [ ] App icon and label (أيام) look correct on the launcher.
- [ ] Splash screen shows briefly then the app appears (no white flash / no stuck splash).
- [ ] First run asks for the device key; entering the correct key syncs; wrong key is rejected.

## Layout & input (RTL)
- [ ] Arabic RTL layout is correct end-to-end (no mirrored-wrong icons, no clipped text).
- [ ] Soft keyboard: opening add/edit pushes content up (no covered input), closes cleanly.
- [ ] System **Back** button: closes an open sheet/modal first, then leaves the app (does not exit
      straight from a modal, does not get stuck).

## Widget (home screen)
- [ ] Add the أيام widget to the home screen; it shows today's tasks.
- [ ] Add a task in the app → widget reflects it within a short time.
- [ ] Mark a task done in the app → widget updates.
- [ ] Delete a task in the app → widget updates (task gone).
- [ ] Resize the widget → layout stays readable.
- [ ] Tap the widget → the app opens on **Today** (deep link `ayyam://today`).
- [ ] Reboot the phone → widget still renders last-known state (no crash / no blank).

## Local notifications (the parts CI cannot fire)
- [ ] First enable: tapping 🔔 prompts for the Android-13+ notification permission; **granting** it
      schedules reminders.
- [ ] **Denying** the permission: the app stays usable, shows no reminders, and does not crash or nag.
- [ ] A reminder actually **fires at a prayer time** while the app is in the **background** (leave the
      app, wait for the next due prayer with open tasks) — notification appears.
- [ ] A reminder fires while the app is **killed** (swipe it from recents, then wait for the due time).
- [ ] **Tapping** the notification opens the app on **Today**.
- [ ] **Reboot** the phone before a due time → the reminder still fires afterward (re-armed on boot).
- [ ] Change the phone **timezone / date** → the next day's reminders line up with the new local day
      (no reminder for the wrong day).
- [ ] No **duplicate** reminders for the same prayer/day after editing tasks several times.
- [ ] A **stale** day (leave the app closed past midnight) does not fire yesterday's reminder.

## Sync on a real device
- [ ] Edit offline (airplane mode): add/edit/done/delete, force-stop, reopen offline → all edits are
      still there.
- [ ] Turn networking back on → within a short time the "unsynced" indicator clears (outbox drains).
- [ ] On a second device (or the web app) the same changes appear; a delete on one device does not
      come back on the other.

## Secure storage
- [ ] Diagnostics screen shows the key backing as Keystore (not a degraded/fallback state) on a normal
      device. If it ever shows **degraded**, that state is visible (never silent) — report it.

---
When you have run these, tell me which passed / failed. I will not mark any of them as verified on my
side — they are yours to confirm on the phone.
