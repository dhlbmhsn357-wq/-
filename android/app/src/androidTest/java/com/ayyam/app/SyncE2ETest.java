package com.ayyam.app;

import static org.junit.Assert.assertTrue;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.getcapacitor.BridgeActivity;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Phase G — REAL Android WebView ↔ backend sync E2E, on an emulator.
 *
 * The APK under test is the AYYAM_E2E build: the SAME production client (app.js + sync-model.js, native
 * scripts present → NATIVE=true, device key from the Keystore SecureStore) with ONLY the @supabase CDN
 * swapped for a stand-in that talks to the isolated backend (tests/e2e/server.mjs, real PGlite SQL / RLS
 * / CAS) on the CI host at http://10.0.2.2:8799. So this exercises the actual Android sync path — not a
 * reimplementation — over a real network round-trip, with the key sourced from Android Keystore.
 *
 * evaluateJavascript does NOT await Promises, so async JS sets a window global we then poll (the pattern
 * used by ShellPersistenceTest / WebPushProbeTest). Backend state is asserted from the test process via
 * HTTP to the backend's /__ctl endpoints. Orchestration that must happen BETWEEN app launches (toggling
 * the simulated outage, running the web-peer device) is driven by scripts/android-sync-e2e.sh, which
 * runs these @Test methods in order with peer/outage actions in between; cross-launch state lives on the
 * device (IndexedDB outbox + Keystore key), exactly like the real app.
 *
 * G-1 (this file): a single smoke that proves the plumbing end-to-end — seed the Keystore key, then an
 * online add reaches the backend. G-2 extends this class with the full offline/multi-device/epoch-fence
 * scenarios.
 */
@RunWith(AndroidJUnit4.class)
public class SyncE2ETest {

    static final String BACKEND = "http://10.0.2.2:8799";
    static final String KEY = "e2e-device-key-0123456789abcdef"; // matches tests/e2e/server.mjs

    // ---- WebView JS helpers ----
    private String runJs(ActivityScenario<MainActivity> s, String js) throws Exception {
        final AtomicReference<String> out = new AtomicReference<>(null);
        final CountDownLatch done = new CountDownLatch(1);
        s.onActivity(a -> ((BridgeActivity) a).getBridge().getWebView().evaluateJavascript(js, v -> { out.set(v); done.countDown(); }));
        done.await(10, TimeUnit.SECONDS);
        return out.get();
    }

    /** Kick off async JS that sets window.__probe, then poll until it is set (or timeout). */
    private String probe(ActivityScenario<MainActivity> s, String kickoffJs, int maxPolls) throws Exception {
        runJs(s, "window.__probe=undefined;(function(){try{" + kickoffJs + "}catch(e){window.__probe='JS-ERR:'+e;}})();'kicked'");
        for (int i = 0; i < maxPolls; i++) {
            Thread.sleep(500);
            String v = runJs(s, "(function(){try{return (typeof window.__probe==='undefined')?null:window.__probe;}catch(e){return 'poll-err';}})()");
            if (v != null && !v.equals("null")) return v;
        }
        return "TIMEOUT";
    }

    // ---- backend control (from the test process; cleartext allowed by the debug overlay) ----
    private String http(String method, String path) throws Exception {
        HttpURLConnection c = (HttpURLConnection) new URL(BACKEND + path).openConnection();
        c.setRequestMethod(method);
        c.setConnectTimeout(8000); c.setReadTimeout(8000);
        if (method.equals("POST")) { c.setDoOutput(true); try (OutputStream os = c.getOutputStream()) { os.write(new byte[0]); } }
        StringBuilder sb = new StringBuilder();
        try (BufferedReader r = new BufferedReader(new InputStreamReader(c.getInputStream(), "UTF-8"))) {
            String ln; while ((ln = r.readLine()) != null) sb.append(ln);
        }
        return sb.toString();
    }

    private ActivityScenario<MainActivity> launch() throws Exception {
        ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class);
        Thread.sleep(5000); // allow the bundled app to load + hydrate the Keystore key + first pull
        return s;
    }

    private static String uniqueTitle() { return "أندرويد-" + System.currentTimeMillis(); }

    @Test
    public void smoke_keyThenOnlineAddReachesServer() throws Exception {
        String reset = http("POST", "/__ctl/reset");
        assertTrue("backend reachable + reset, got: " + reset, reset.contains("\"ok\":true"));

        // 1) The app runs http:// (E2E build scheme) and NATIVE bridge is present (Keystore key path).
        try (ActivityScenario<MainActivity> s = launch()) {
            String origin = runJs(s, "location.origin");
            assertTrue("E2E build must run over http scheme, origin=" + origin, origin != null && origin.contains("http://localhost"));
            String isNative = runJs(s, "(typeof AyyamNative!=='undefined' && AyyamNative.isNativeAndroid && AyyamNative.isNativeAndroid())+''");
            assertTrue("AyyamNative must be present (NATIVE=true) in the E2E build, got=" + isNative, "true".equals(isNative.replace("\"", "")));

            // Gate: the WebVIEW itself (not just the test process) must reach the backend RPC over the
            // http scheme. Isolates network (cleartext/CORS/reachability) from app-side sync logic.
            String rpc = probe(s,
                "fetch('" + BACKEND + "/rpc',{method:'POST',headers:{'Content-Type':'application/json'},"
              + "body:JSON.stringify({fn:'ayyam_pull',args:{p_key:'" + KEY + "'}})}).then(function(r){return r.json();})"
              + ".then(function(j){window.__probe='RPC:'+JSON.stringify(j);}).catch(function(e){window.__probe='FETCH-ERR:'+e;});", 20);
            assertTrue("WebView must reach the backend RPC (network/cleartext/CORS), got: " + rpc, rpc.replace("\\", "").contains("\"status\":\"ok\""));

            // 2) Seed the device key into the Android Keystore via the real bridge; assert it persisted there.
            String set = probe(s, "AyyamNative.setKey('" + KEY + "').then(function(r){window.__probe=JSON.stringify(r);});", 20);
            String setClean = set.replace("\\", "");
            assertTrue("setKey must report ok, got: " + set, setClean.contains("\"ok\":true"));
            assertTrue("device key must reach Keystore-backed storage, got: " + set, setClean.contains("\"backing\":\"keystore\""));
        }

        final String title = uniqueTitle();
        // 3) Relaunch: the key hydrates FROM the Keystore; add a task through the UI; wait for the outbox to drain.
        try (ActivityScenario<MainActivity> s = launch()) {
            String key = runJs(s, "(typeof AyyamNative!=='undefined'? (AyyamNative.getKeyCached()? 'has-key':'no-key') : 'no-native')");
            assertTrue("key must hydrate from Keystore on relaunch, got=" + key, key.contains("has-key"));

            String added = probe(s,
                "var fab=document.querySelector('#fabAdd'); if(!fab){window.__probe='NO-FAB';return;} fab.click();"
              + "setTimeout(function(){var t=document.querySelector('#taskTitle'); if(!t){window.__probe='NO-INPUT';return;}"
              + "t.value=" + jsStr(title) + "; t.dispatchEvent(new Event('input',{bubbles:true}));"
              + "var save=document.querySelector('#saveAdd'); if(!save){window.__probe='NO-SAVE';return;} save.click(); window.__probe='added';},400);",
                20);
            assertTrue("add-task UI drive failed: " + added, added.contains("added"));

            // Nudge the app's own sync triggers (online/focus) so it does not wait on a debounce/interval.
            probe(s, "window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));window.__probe='nudged';", 5);
            String drained = probe(s, outboxDrainJs(), 60);
            assertTrue("outbox did not drain (online sync), got: " + drained, drained.contains("SYNCED"));
        }

        // 4) The added task must be present on the backend (real server-side proof).
        String db = http("GET", "/__ctl/db");
        assertTrue("server must contain the added task title; db=" + trim(db), db.contains(title));
        // no-duplicate: the title must appear exactly once in the server payload
        assertTrue("added task must not be duplicated on the server", countOccurrences(db, title) == 1);
    }

    // Poll the app's own IndexedDB outbox (DB 'ayyam', store 'outbox') until empty → "SYNCED".
    static String outboxDrainJs() {
        return "var o=indexedDB.open('ayyam');o.onsuccess=function(){try{var db=o.result;var t=db.transaction('outbox').objectStore('outbox').count();"
             + "t.onsuccess=function(){window.__probe=(t.result===0)?'SYNCED':('PENDING:'+t.result);};t.onerror=function(){window.__probe='COUNT-ERR';};}"
             + "catch(e){window.__probe='NO-STORE:'+e;}};o.onerror=function(){window.__probe='OPEN-ERR';};";
    }

    static String jsStr(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    static String trim(String s) { return s == null ? "(null)" : (s.length() > 300 ? s.substring(0, 300) : s); }
    static int countOccurrences(String hay, String needle) {
        int n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length(); } return n;
    }
}
