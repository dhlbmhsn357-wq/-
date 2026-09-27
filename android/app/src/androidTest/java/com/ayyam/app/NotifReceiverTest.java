package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.app.NotificationManager;
import android.content.Context;
import android.content.Intent;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.notif.NotifAlarmReceiver;
import com.ayyam.app.notif.NotifScheduler;
import com.ayyam.app.notif.NotifStore;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Phase F (local notifications): the alarm receiver shows a reminder for a TODAY item and — via the
 * stale-date guard — shows nothing for a past-day item. Plus NotifStore validation/last-known-good.
 * Runs on api-30 (notifications enabled by default, no runtime POST_NOTIFICATIONS).
 */
@RunWith(AndroidJUnit4.class)
public class NotifReceiverTest {
    private final Context ctx = ApplicationProvider.getApplicationContext();
    private NotificationManager nm() { return (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE); }

    private void fire(String id, String date, String title, String body) {
        Intent i = new Intent(ctx, NotifAlarmReceiver.class).setAction(NotifScheduler.ACTION_FIRE);
        i.putExtra("id", id); i.putExtra("date", date); i.putExtra("title", title); i.putExtra("body", body);
        new NotifAlarmReceiver().onReceive(ctx, i);
    }

    @Test
    public void todayItemShowsNotification() throws Exception {
        nm().cancelAll(); Thread.sleep(400);
        fire("k:dhuhr", NotifScheduler.todayKey(), "حان وقت الظهر", "عليك مهمة: ورد القرآن");
        Thread.sleep(600);
        assertTrue("a today reminder must post a notification", nm().getActiveNotifications().length >= 1);
    }

    @Test
    public void staleItemShowsNothing() throws Exception {
        nm().cancelAll(); Thread.sleep(400);
        fire("old:fajr", "2020-01-01", "قديم", "مهمة أمس");
        Thread.sleep(600);
        assertEquals("a past-day reminder must be suppressed", 0, nm().getActiveNotifications().length);
    }

    @Test
    public void storeValidatesAndKeepsLastGood() {
        assertTrue(NotifStore.save(ctx, "{\"schema\":1,\"items\":[]}"));
        assertNotNull(NotifStore.plan(ctx));
        assertFalse(NotifStore.save(ctx, "not json"));            // rejected
        assertNotNull("last-known-good preserved", NotifStore.plan(ctx));
        assertFalse(NotifStore.save(ctx, "{\"schema\":9,\"items\":[]}")); // unsupported schema
    }
}
