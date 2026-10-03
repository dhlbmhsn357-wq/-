package com.ayyam.app.notif;

import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.ayyam.app.MainActivity;
import com.ayyam.app.R;

/**
 * Fires a local reminder. STALE GUARD (timezone-independent): skip only if the alarm is firing far later
 * than its intended time — e.g. a Doze-deferred alarm surfacing hours after its prayer window. This avoids
 * the previous device-timezone date-key comparison, which could silently drop valid reminders when the
 * device timezone differed from the user's configured prayer-time location timezone. Tap opens ayyam://today.
 * No network, no data read.
 */
public class NotifAlarmReceiver extends BroadcastReceiver {
    // Don't surface a reminder more than this late (its prayer window has clearly passed).
    private static final long MAX_LATE_MS = 2L * 60L * 60L * 1000L; // 2 hours

    @Override
    public void onReceive(Context context, Intent intent) {
        final String id = intent.getStringExtra("id");
        final long at = intent.getLongExtra("at", 0L);
        final String title = intent.getStringExtra("title");
        final String body = intent.getStringExtra("body");
        if (title == null || body == null) return;
        // stale guard: skip an alarm that fires far after its intended moment (timezone-independent)
        if (at > 0 && System.currentTimeMillis() - at > MAX_LATE_MS) return;

        NotifScheduler.ensureChannel(context);
        int req = (id != null ? id : title).hashCode();
        Intent open = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW).setData(Uri.parse("ayyam://today"))
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent tap = PendingIntent.getActivity(context, req, open,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        NotificationCompat.Builder b = new NotificationCompat.Builder(context, NotifScheduler.CHANNEL_ID)
                .setSmallIcon(R.mipmap.ic_launcher)   // TEMP small icon — needs a monochrome asset (visual approval)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setAutoCancel(true)
                .setContentIntent(tap)
                .setPriority(NotificationCompat.PRIORITY_HIGH);
        try {
            if (NotificationManagerCompat.from(context).areNotificationsEnabled()) {
                NotificationManagerCompat.from(context).notify(req, b.build());
            }
        } catch (SecurityException ignored) { /* permission not granted (Android 13+) → skip */ }
    }
}
