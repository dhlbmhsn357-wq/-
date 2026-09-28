package com.ayyam.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.notif.NotifAlarmReceiver;
import com.ayyam.app.notif.NotifBootReceiver;
import com.ayyam.app.notif.NotifScheduler;
import com.ayyam.app.notif.NotifStore;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Phase G §12 — local-notification scheduling hardening (what CI can prove without firing real timed
 * alarms): no DUPLICATE alarms across reschedules (stable per-day/period request codes + cancel-then-
 * schedule), dropped items are actually cancelled, and the boot receiver re-arms from the persisted
 * plan (reboot / app-update path). A scheduled alarm's existence is probed via PendingIntent.FLAG_
 * NO_CREATE with the SAME request code the scheduler uses (id.hashCode()); PendingIntent matching
 * ignores extras (filterEquals), so a same-id reschedule reuses one alarm rather than duplicating it.
 */
@RunWith(AndroidJUnit4.class)
public class NotifSchedulerTest {
    private final Context ctx = ApplicationProvider.getApplicationContext();
    private static final long FUTURE = 3600_000L; // 1h out → never fires during the test

    private PendingIntent probe(String id) {
        Intent i = new Intent(ctx, NotifAlarmReceiver.class).setAction(NotifScheduler.ACTION_FIRE);
        return PendingIntent.getBroadcast(ctx, id.hashCode(), i, PendingIntent.FLAG_NO_CREATE | PendingIntent.FLAG_IMMUTABLE);
    }

    private JSONObject planWith(String... ids) throws Exception {
        long at = System.currentTimeMillis() + FUTURE;
        JSONObject p = new JSONObject(); p.put("schema", 1);
        JSONArray arr = new JSONArray();
        for (String id : ids) {
            JSONObject it = new JSONObject();
            it.put("id", id); it.put("at", at); it.put("date", NotifScheduler.todayKey());
            it.put("title", "حان الوقت"); it.put("body", "مهمة");
            arr.put(it);
        }
        p.put("items", arr);
        return p;
    }

    @After
    public void cleanup() {
        try { NotifScheduler.cancel(ctx, NotifStore.plan(ctx)); } catch (Exception ignored) {}
        NotifStore.clear(ctx);
    }

    @Test
    public void rescheduleCancelsDroppedItemsAndNeverDuplicates() throws Exception {
        NotifStore.clear(ctx);
        // Schedule {A,B}. Reschedule to {A,C}: A must stay (single alarm, same request code), C added,
        // B (dropped) cancelled — proving no stale/duplicate alarms accumulate across re-plans.
        assertTrue(NotifScheduler.reschedule(ctx, planWith("itemA", "itemB").toString()) >= 0);
        assertNotNull("A scheduled", probe("itemA"));
        assertNotNull("B scheduled", probe("itemB"));

        assertTrue(NotifScheduler.reschedule(ctx, planWith("itemA", "itemC").toString()) >= 0);
        assertNotNull("A still scheduled after re-plan (no duplicate, same request code)", probe("itemA"));
        assertNotNull("C scheduled", probe("itemC"));
        assertNull("B was dropped from the plan → its alarm must be cancelled", probe("itemB"));
    }

    @Test
    public void bootReceiverReschedulesFromPersistedPlan() throws Exception {
        NotifStore.clear(ctx);
        // Persist a plan but do NOT schedule (simulates alarms lost on reboot). The boot receiver must
        // re-arm the future items from the persisted plan.
        assertTrue(NotifStore.save(ctx, planWith("bootItem").toString()));
        assertNull("no alarm before boot", probe("bootItem"));
        new NotifBootReceiver().onReceive(ctx, new Intent(Intent.ACTION_BOOT_COMPLETED));
        assertNotNull("boot receiver must reschedule the future item from the persisted plan", probe("bootItem"));
    }
}
