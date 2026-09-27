package com.ayyam.app;

import static org.junit.Assert.assertTrue;

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
 * The CI job (scripts/android-persistence.sh) runs these methods with process-death / reboot /
 * reinstall / offline between them, so the SAME on-device data is checked to survive each event.
 *
 * IndexedDB is async and WebView.evaluateJavascript does NOT await Promises, so async work sets a
 * window global that we then poll. The probe uses its own DB ("ayyam_probe"), independent of the
 * app's data and device-key gate — so it works on a fresh install without a key.
 */
@RunWith(AndroidJUnit4.class)
public class ShellPersistenceTest {

    private static final String MARKER = "ayyam-phaseB-marker-42";

    /** Run JS in the app WebView, return its JSON-stringified result (blocking, single shot). */
    private String runJs(ActivityScenario<MainActivity> scenario, String js) throws Exception {
        final AtomicReference<String> out = new AtomicReference<>(null);
        final CountDownLatch done = new CountDownLatch(1);
        scenario.onActivity(a ->
                ((BridgeActivity) a).getBridge().getWebView().evaluateJavascript(js, v -> { out.set(v); done.countDown(); }));
        done.await(10, TimeUnit.SECONDS);
        return out.get();
    }

    /** Launch the app, kick off async JS that sets window.__probe, then poll until it is set. */
    private String runProbe(String kickoffJs) throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            Thread.sleep(4000); // allow the bundled index.html to load
            runJs(scenario, "window.__probe=undefined;" + kickoffJs + ";'kicked'");
            for (int i = 0; i < 50; i++) {
                Thread.sleep(500);
                String v = runJs(scenario, "(function(){try{return (typeof window.__probe==='undefined')?null:window.__probe;}catch(e){return 'poll-err';}})()");
                if (v != null && !v.equals("null")) return v;
            }
            return "TIMEOUT";
        }
    }

    private String origin() throws Exception {
        try (ActivityScenario<MainActivity> scenario = ActivityScenario.launch(MainActivity.class)) {
            Thread.sleep(4000);
            return runJs(scenario, "location.origin");
        }
    }

    private static final String WRITE_JS =
        "var o=indexedDB.open('ayyam_probe',1);"
        + "o.onupgradeneeded=function(){o.result.createObjectStore('kv',{keyPath:'k'});};"
        + "o.onsuccess=function(){var db=o.result;var t=db.transaction('kv','readwrite');"
        + "t.objectStore('kv').put({k:'marker',v:'" + MARKER + "'});"
        + "t.oncomplete=function(){window.__probe='written';};t.onerror=function(){window.__probe='tx-err';};};"
        + "o.onerror=function(){window.__probe='open-err';};";

    private static final String READ_JS =
        "var o=indexedDB.open('ayyam_probe',1);"
        + "o.onsuccess=function(){var db=o.result;try{var t=db.transaction('kv','readonly');"
        + "var g=t.objectStore('kv').get('marker');g.onsuccess=function(){window.__probe=g.result?g.result.v:'MISSING';};"
        + "g.onerror=function(){window.__probe='read-err';};}catch(e){window.__probe='no-store';}};"
        + "o.onerror=function(){window.__probe='open-err';};";

    @Test
    public void writeMarker() throws Exception {
        String o = origin();
        assertTrue("app must load from a LOCAL scheme, got " + o, o != null && o.contains("localhost"));
        String r = runProbe(WRITE_JS);
        assertTrue("IDB write failed: " + r, r != null && r.contains("written"));
    }

    @Test
    public void verifyMarker() throws Exception {
        String r = runProbe(READ_JS);
        assertTrue("IDB marker did not survive: " + r, r != null && r.contains(MARKER));
    }

    @Test
    public void verifyOffline() throws Exception {
        String o = origin();
        assertTrue("offline app shell failed to load, origin=" + o, o != null && o.contains("localhost"));
        verifyMarker();
    }
}
