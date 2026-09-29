package com.ayyam.app.notif;

import android.app.AlarmManager;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;

/**
 * Schedules local reminders from a JS-built plan using INEXACT alarms (setAndAllowWhileIdle) — fires
 * in Doze, needs no SCHEDULE_EXACT_ALARM/USE_EXACT_ALARM permission. A few minutes' latency is fine for
 * a prayer-window reminder. Reschedule cancels the previous plan's alarms first (stable request codes).
 */
public final class NotifScheduler {
    public static final String CHANNEL_ID = "ayyam_reminders";
    public static final String ACTION_FIRE = "com.ayyam.app.NOTIF_FIRE";

    private NotifScheduler() {}

    public static String todayKey() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance().getTime());
    }

    public static void ensureChannel(Context c) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager nm = (NotificationManager) c.getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "أيام — التذكيرات", NotificationManager.IMPORTANCE_HIGH);
                ch.setDescription("تذكيرات مهامك مع كل صلاة");
                nm.createNotificationChannel(ch);
            }
        }
    }

    private static PendingIntent fireIntent(Context c, JSONObject item, boolean forCancel) {
        Intent i = new Intent(c, NotifAlarmReceiver.class).setAction(ACTION_FIRE);
        int req = item.optString("id", "").hashCode();
        if (!forCancel) {
            i.putExtra("id", item.optString("id", ""));
            i.putExtra("date", item.optString("date", ""));
            i.putExtra("title", item.optString("title", ""));
            i.putExtra("body", item.optString("body", ""));
        }
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                | (forCancel ? PendingIntent.FLAG_NO_CREATE : 0);
        return PendingIntent.getBroadcast(c, req, i, flags);
    }

    /** Cancel every alarm belonging to a plan (call with the OLD plan before overwriting). */
    public static void cancel(Context c, JSONObject plan) {
        if (plan == null) return;
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        try {
            JSONArray items = plan.getJSONArray("items");
            for (int i = 0; i < items.length(); i++) {
                PendingIntent pi = fireIntent(c, items.getJSONObject(i), true);
                if (pi != null) { am.cancel(pi); pi.cancel(); } // cancel the alarm AND release the PendingIntent (no leak)
            }
        } catch (Exception ignored) {}
    }

    /** Schedule inexact alarms for every FUTURE item in the plan. Returns how many were scheduled. */
    public static int schedule(Context c, JSONObject plan) {
        if (plan == null) return 0;
        ensureChannel(c);
        AlarmManager am = (AlarmManager) c.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return 0;
        int n = 0;
        long now = System.currentTimeMillis();
        try {
            JSONArray items = plan.getJSONArray("items");
            for (int i = 0; i < items.length(); i++) {
                JSONObject it = items.getJSONObject(i);
                long at = it.optLong("at", 0);
                if (at <= now) continue; // only future
                PendingIntent pi = fireIntent(c, it, false);
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi);
                else am.set(AlarmManager.RTC_WAKEUP, at, pi);
                n++;
            }
        } catch (Exception ignored) {}
        return n;
    }

    /** Replace the schedule: cancel the previous plan, persist + schedule the new one. */
    public static int reschedule(Context c, String newPlanJson) {
        cancel(c, NotifStore.plan(c));
        if (!NotifStore.save(c, newPlanJson)) return -1; // invalid → last-known-good kept, nothing scheduled new
        return schedule(c, NotifStore.plan(c));
    }
}
