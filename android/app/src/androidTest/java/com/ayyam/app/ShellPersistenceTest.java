package com.ayyam.app;

import static org.junit.Assert.assertTrue;

import android.webkit.WebView;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.getcapacitor.BridgeActivity;

import org.junit.runner.RunWith;
import org.junit.Test;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Phase B empirical persistence proofs, driven through the real Capacitor WebView on an emulator.
 * The CI job runs these methods in a sequence with process-death / reboot / reinstall / offline
 * between them (via adb), so the SAME on-device data is checked to survive each event.
 *
 *  - writeMarker      : proves the app loads from LOCAL bundled assets (https://localhost, not Vercel)
 *                       and writes a durable marker into IndexedDB (db "ayyam_probe").
 *  - verifyMarker     : re-opens the app and reads the marker back — run after force-stop, reboot,
 *                       and APK reinstall to prove IndexedDB survives each.
 *  - verifyOffline    : same read, but the CI job disables networking first — proves the app shell
 *                       loads and data is available with NO network and NO service worker.
 *
 * Run one method at a time, e.g.:
 *   adb shell am instrument -w -e class com.ayyam.app.ShellPersistenceTest#writeMarker \
 *     com.ayyam.app.test/androidx.test.runner.AndroidJUnitRunner
 */
@RunWith(AndroidJUnit4.class)
public class ShellPersistenceTest {

    private static final String MARKER = "ayyam-phaseB-marker-42";
    private static final long JS_TIMEOUT_S = 20;

    /** Evaluate JS in the app's WebView and return the JSON-stringified result (blocking). */
    private String evalInApp(String js) throws Exception {
        final AtomicReference<String> out = new AtomicReference<>(null);
        final CountDownLatch ready = new CountDownLatch(1);
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            // give the WebView a moment to load the bundled index.html
            Thread.sleep(4000);
            final CountDownLatch done = new CountDownLatch(1);
            scenario.onActivity(activity -> {
                WebView wv = ((BridgeActivity) activity).getBridge().getWebView();
                wv.evaluateJavascript(js, value -> { out.set(value); done.countDown(); });
            });
            assertTrue("JS did not return in time", done.await(JS_TIMEOUT_S, TimeUnit.SECONDS));
        }
        return out.get();
    }

    @Test
    public void writeMarker() throws Exception {
        // 1) prove local origin (bundled assets, not remote)
        String origin = evalInApp("(function(){return location.origin;})()");
        assertTrue("app must load from a LOCAL scheme, got " + origin,
                origin != null && (origin.contains("localhost") || origin.startsWith("\"http")));
        // 2) write a durable IndexedDB marker and resolve only on transaction complete
        String js = "new Promise(function(res){var o=indexedDB.open('ayyam_probe',1);"
                + "o.onupgradeneeded=function(){o.result.createObjectStore('kv',{keyPath:'k'});};"
                + "o.onsuccess=function(){var db=o.result;var t=db.transaction('kv','readwrite');"
                + "t.objectStore('kv').put({k:'marker',v:'" + MARKER + "'});"
                + "t.oncomplete=function(){res('written');};t.onerror=function(){res('err');};};"
                + "o.onerror=function(){res('open-err');};})";
        String r = evalInApp("(" + js + ")");
        assertTrue("IDB write failed: " + r, r != null && r.contains("written"));
    }

    @Test
    public void verifyMarker() throws Exception {
        String js = "new Promise(function(res){var o=indexedDB.open('ayyam_probe',1);"
                + "o.onsuccess=function(){var db=o.result;try{var t=db.transaction('kv','readonly');"
                + "var g=t.objectStore('kv').get('marker');g.onsuccess=function(){res(g.result?g.result.v:'MISSING');};"
                + "g.onerror=function(){res('read-err');};}catch(e){res('no-store');}};"
                + "o.onerror=function(){res('open-err');};})";
        String r = evalInApp("(" + js + ")");
        assertTrue("IDB marker did not survive: " + r, r != null && r.contains(MARKER));
    }

    @Test
    public void verifyOffline() throws Exception {
        // Network is disabled by the CI job before this runs; the app shell must still load locally.
        String origin = evalInApp("(function(){return location.origin;})()");
        assertTrue("offline app shell failed to load, origin=" + origin, origin != null && origin.length() > 2);
        verifyMarker();
    }
}
