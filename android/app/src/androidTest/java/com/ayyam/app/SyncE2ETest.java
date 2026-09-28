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
 * The five critical Android-client scenarios (driven in order by android-sync-e2e.sh):
 *   t0  reset + seed the Keystore key (gate: http scheme, NATIVE, WebView reaches the backend)
 *   t1  Android offline edit → reconnect → server receives → outbox clears
 *   t2  Web + Android multi-device → both changes persist
 *   t3  Web delete + stale Android → the delete wins (no resurrection)
 *   t4  Web Reset + stale Android → epoch fence (adopt new generation, park old, no resurrection)
 *   t5  kill/reopen mid-pending → sync resumes, same durable op_id → exactly once (no duplicate)
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

    // Fixed titles the orchestration (android-sync-e2e.sh) and the web-peer share across launches.
    static final String T_AND = "س1-مهمة-أندرويد";   // Android's offline edit (S1)
    static final String T_WEB = "ويب-مهمة";            // web-peer device task (S2/S3)
    static final String T_PRE = "قبل-الريست";          // Android's offline edit before a web Reset (S4)
    static final String T_S5  = "س5-مهمة-قتل";         // Android's edit killed mid-pending (S5)
    static final String RESET_MARKER = "RESET-MARKER";  // web-peer reset generation marker (S4)

    // ===== Scenario 0: reset backend + seed the Keystore device key (gate: http scheme, NATIVE, RPC reach) =====
    @Test
    public void t0_resetAndSeedKey() throws Exception {
        String reset = http("POST", "/__ctl/reset");
        assertTrue("backend reachable + reset, got: " + reset, reset.contains("\"ok\":true"));
        try (ActivityScenario<MainActivity> s = launch()) {
            String origin = runJs(s, "location.origin");
            assertTrue("E2E build must run over http scheme, origin=" + origin, origin != null && origin.contains("http://localhost"));
            String isNative = runJs(s, "(typeof AyyamNative!=='undefined' && AyyamNative.isNativeAndroid && AyyamNative.isNativeAndroid())+''");
            assertTrue("NATIVE must be true in the E2E build, got=" + isNative, "true".equals(isNative.replace("\"", "")));
            String rpc = probe(s,
                "fetch('" + BACKEND + "/rpc',{method:'POST',headers:{'Content-Type':'application/json'},"
              + "body:JSON.stringify({fn:'ayyam_pull',args:{p_key:'" + KEY + "'}})}).then(function(r){return r.json();})"
              + ".then(function(j){window.__probe='RPC:'+JSON.stringify(j);}).catch(function(e){window.__probe='FETCH-ERR:'+e;});", 20);
            assertTrue("WebView must reach the backend RPC, got: " + rpc, rpc.replace("\\", "").contains("\"status\":\"ok\""));
            String set = probe(s, "AyyamNative.setKey('" + KEY + "').then(function(r){window.__probe=JSON.stringify(r);});", 20);
            String setClean = set.replace("\\", "");
            assertTrue("setKey ok, got: " + set, setClean.contains("\"ok\":true"));
            assertTrue("device key must reach Keystore, got: " + set, setClean.contains("\"backing\":\"keystore\""));
        }
    }

    // ===== Scenario 1a: OFFLINE edit (add + mark done). Bash sets outage=down before this. =====
    @Test
    public void t1a_offlineEdit() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            assertHasKey(s);
            assertTrue("add offline failed", probe(s, addTaskJs(T_AND), 20).contains("added"));
            assertTrue("toggle-done offline failed", probe(s, toggleDoneJs(T_AND), 10).contains("toggled"));
            String titles = probe(s, titlesJs(), 10);
            assertTrue("offline edit must be visible locally, titles=" + titles, titles.replace("\\", "").contains(T_AND));
            String ob = probe(s, outboxDrainJs(), 3);
            assertTrue("edit must be queued in the outbox while offline, got=" + ob, ob.contains("PENDING"));
        }
    }

    // ===== Scenario 1b: RECONNECT → server receives the change → outbox clears. Bash sets outage=off. =====
    @Test
    public void t1b_reconnectServerReceivesOutboxClears() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            settleSync(s);
        }
        String db = http("GET", "/__ctl/db");
        assertTrue("server must receive the offline edit; db=" + trim(db), db.contains(T_AND));
        assertTrue("no duplicate of the offline edit on the server", countOccurrences(db, T_AND) == 1);
    }

    // ===== Scenario 2: Web + Android multi-device → every change persists. Bash runs `peer add T_WEB` first. =====
    @Test
    public void t2_multiDeviceBothPersist() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            settleSync(s);
            String titles = probe(s, titlesJs(), 10).replace("\\", "");
            assertTrue("Android must show its own task after sync, titles=" + titles, titles.contains(T_AND));
            assertTrue("Android must pull the web-peer's task, titles=" + titles, titles.contains(T_WEB));
        }
        String db = http("GET", "/__ctl/db");
        assertTrue("server keeps the Android task", db.contains(T_AND));
        assertTrue("server keeps the web task", db.contains(T_WEB));
    }

    // ===== Scenario 3a: Android holds a STALE copy offline. Bash sets outage=down. =====
    @Test
    public void t3a_holdStaleOffline() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            assertHasKey(s);
            String titles = probe(s, titlesJs(), 10).replace("\\", "");
            assertTrue("Android still holds the (soon-to-be-deleted) web task offline, titles=" + titles, titles.contains(T_WEB));
        }
    }

    // ===== Scenario 3b: web deleted T_WEB while Android was offline → the delete WINS (tombstone), no resurrection.
    //        Bash runs `peer delete T_WEB` then outage=off before this. =====
    @Test
    public void t3b_staleDeleteWins() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            settleSync(s);
            String titles = probe(s, titlesJs(), 10).replace("\\", "");
            assertTrue("the deleted task must NOT be revived on Android, titles=" + titles, !titles.contains(T_WEB));
        }
        String db = http("GET", "/__ctl/db");
        assertTrue("a stale Android device must not resurrect the deleted task on the server", !db.contains(T_WEB));
    }

    // ===== Scenario 4a: Android makes an offline edit in the OLD generation. Bash sets outage=down. =====
    @Test
    public void t4a_offlineEditBeforeReset() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            assertHasKey(s);
            assertTrue("offline pre-reset add failed", probe(s, addTaskJs(T_PRE), 20).contains("added"));
            String ob = probe(s, outboxDrainJs(), 3);
            assertTrue("pre-reset edit queued, got=" + ob, ob.contains("PENDING"));
        }
    }

    // ===== Scenario 4b: web did Reset (epoch+1) → the newer epoch FENCES the stale device: it adopts the new
    //        generation, parks its old edit for recovery, and never forces the old edit onto the new epoch.
    //        Bash runs `peer reset` then outage=off before this. =====
    @Test
    public void t4b_resetEpochFence() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            settleSync(s);
            String titles = probe(s, titlesJs(), 10).replace("\\", "");
            assertTrue("Android must adopt the reset generation, titles=" + titles, titles.contains(RESET_MARKER));
            assertTrue("the stale pre-reset edit must NOT survive into the new generation, titles=" + titles, !titles.contains(T_PRE));
            String rec = probe(s, recoveryJs(), 10);
            assertTrue("the fenced (parked) old generation must be kept for recovery, got=" + rec, rec.replace("\\", "").matches(".*REC:[1-9].*"));
        }
        String db = http("GET", "/__ctl/db");
        assertTrue("server is the reset generation", db.contains(RESET_MARKER));
        assertTrue("epoch fence: stale offline edit must not be resurrected on the server", !db.contains(T_PRE));
    }

    // ===== Scenario 5a: OFFLINE edit; capture its outbox op_id. Bash sets outage=down. Bash then force-stops
    //        the app (kill mid-pending) and sets outage=off before t5b. =====
    @Test
    public void t5a_offlineEditCaptureOpId() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            assertHasKey(s);
            assertTrue("s5 offline add failed", probe(s, addTaskJs(T_S5), 20).contains("added"));
            String op = probe(s, opIdJs(), 10);
            System.out.println("S5_OPID " + op); // recorded for the report; op_id is reused across the kill by design
            assertTrue("s5 edit must be queued with an op_id, got=" + op, op.contains("OP:"));
        }
    }

    // ===== Scenario 5b: reopen after the kill → sync RESUMES, commits the SAME durable op_id → exactly once
    //        (server op_id idempotency), no duplicate. Bash force-stopped the app + set outage=off before this. =====
    @Test
    public void t5b_reopenResumesNoDuplicate() throws Exception {
        try (ActivityScenario<MainActivity> s = launch()) {
            settleSync(s);
        }
        String db = http("GET", "/__ctl/db");
        assertTrue("sync must resume after the kill and reach the server; db=" + trim(db), db.contains(T_S5));
        assertTrue("the killed-mid-sync edit must appear EXACTLY ONCE (idempotent op_id, no duplicate)", countOccurrences(db, T_S5) == 1);
    }

    // ---- shared step helpers ----
    private void assertHasKey(ActivityScenario<MainActivity> s) throws Exception {
        String key = runJs(s, "(typeof AyyamNative!=='undefined'? (AyyamNative.getKeyCached()? 'has-key':'no-key') : 'no-native')");
        assertTrue("device key must hydrate from Keystore, got=" + key, key.contains("has-key"));
    }
    // Nudge the app's own online/focus sync triggers, then wait for the outbox to drain (fail with diag).
    private void settleSync(ActivityScenario<MainActivity> s) throws Exception {
        assertHasKey(s);
        probe(s, "window.dispatchEvent(new Event('online'));window.dispatchEvent(new Event('focus'));window.__probe='nudged';", 5);
        String drained = probe(s, outboxDrainJs(), 60);
        if (!drained.contains("SYNCED")) {
            String diag = probe(s, dumpStateJs(), 20);
            assertTrue("outbox did not drain; drain=" + drained + " | " + diag, false);
        }
    }

    // Poll the app's own IndexedDB outbox (DB 'ayyam', store 'outbox') until empty → "SYNCED".
    static String outboxDrainJs() {
        return "var o=indexedDB.open('ayyam');o.onsuccess=function(){try{var db=o.result;var t=db.transaction('outbox').objectStore('outbox').count();"
             + "t.onsuccess=function(){window.__probe=(t.result===0)?'SYNCED':('PENDING:'+t.result);};t.onerror=function(){window.__probe='COUNT-ERR';};}"
             + "catch(e){window.__probe='NO-STORE:'+e;}};o.onerror=function(){window.__probe='OPEN-ERR';};";
    }

    // On failure: dump the app's own diagnostics (DB 'ayyam' store 'diag' = sync-error events), the
    // pending outbox op, and navigator.onLine — the ground truth for why a sync did not commit.
    static String dumpStateJs() {
        return "var o=indexedDB.open('ayyam');o.onsuccess=function(){var db=o.result;try{var tx=db.transaction(['diag','outbox']);"
             + "var d=tx.objectStore('diag').getAll();var b=tx.objectStore('outbox').getAll();"
             + "d.onsuccess=function(){b.onsuccess=function(){window.__probe='onLine='+navigator.onLine"
             + "+' diag='+JSON.stringify((d.result||[]).slice(-10))"
             + "+' outbox='+JSON.stringify((b.result||[]).map(function(x){return {op:(x.op_id||'').slice(0,8),reason:x.reason,state:x.state,err:x.last_error};}));};};}"
             + "catch(e){window.__probe='DIAG-ERR:'+e;}};o.onerror=function(){window.__probe='OPEN-ERR';};";
    }

    // Add a task through the real UI (FAB → title → save), mirroring the app's own flow.
    static String addTaskJs(String title) {
        return "var fab=document.querySelector('#fabAdd'); if(!fab){window.__probe='NO-FAB';return;} fab.click();"
             + "setTimeout(function(){var t=document.querySelector('#taskTitle'); if(!t){window.__probe='NO-INPUT';return;}"
             + "t.value=" + jsStr(title) + "; t.dispatchEvent(new Event('input',{bubbles:true}));"
             + "var save=document.querySelector('#saveAdd'); if(!save){window.__probe='NO-SAVE';return;} save.click(); window.__probe='added';},400);";
    }
    // Toggle done on the task row whose title matches (clicks its .check button).
    static String toggleDoneJs(String title) {
        return "var rows=[].slice.call(document.querySelectorAll('.task'));"
             + "var row=rows.filter(function(r){var t=r.querySelector('.task-title');return t&&t.textContent===" + jsStr(title) + ";})[0];"
             + "if(!row){window.__probe='NO-ROW';return;}var c=row.querySelector('.check');if(!c){window.__probe='NO-CHECK';return;}c.click();window.__probe='toggled';";
    }
    // JSON array of the task titles currently on screen.
    static String titlesJs() {
        return "window.__probe=JSON.stringify([].slice.call(document.querySelectorAll('.task-title')).map(function(e){return e.textContent;}));";
    }
    // The first pending outbox op's op_id (DB 'ayyam' store 'outbox').
    static String opIdJs() {
        return "var o=indexedDB.open('ayyam');o.onsuccess=function(){try{var b=o.result.transaction('outbox').objectStore('outbox').getAll();"
             + "b.onsuccess=function(){var a=b.result||[];window.__probe=a.length?('OP:'+a[0].op_id):'NO-OP';};}catch(e){window.__probe='ERR:'+e;}};o.onerror=function(){window.__probe='OPEN-ERR';};";
    }
    // Count of parked recovery generations (DB 'ayyam' kv 'recovery') → proves epoch-fenced data is kept.
    static String recoveryJs() {
        return "var o=indexedDB.open('ayyam');o.onsuccess=function(){try{var g=o.result.transaction('kv').objectStore('kv').get('recovery');"
             + "g.onsuccess=function(){var v=(g.result&&g.result.v)||[];window.__probe='REC:'+v.length;};g.onerror=function(){window.__probe='REC-ERR';};}catch(e){window.__probe='ERR:'+e;}};o.onerror=function(){window.__probe='OPEN-ERR';};";
    }

    static String jsStr(String s) { return "\"" + s.replace("\\", "\\\\").replace("\"", "\\\"") + "\""; }
    static String trim(String s) { return s == null ? "(null)" : (s.length() > 300 ? s.substring(0, 300) : s); }
    static int countOccurrences(String hay, String needle) {
        int n = 0, i = 0; while ((i = hay.indexOf(needle, i)) >= 0) { n++; i += needle.length(); } return n;
    }
}
