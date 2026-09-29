package com.ayyam.app.notif;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/** After reboot, AlarmManager alarms are gone → reschedule the future items from the persisted plan. */
public class NotifBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        final String a = intent.getAction();
        if (a == null) return;
        if (a.equals(Intent.ACTION_BOOT_COMPLETED)
                || a.equals("android.intent.action.QUICKBOOT_POWERON")
                || a.equals(Intent.ACTION_MY_PACKAGE_REPLACED)) {   // also re-arm after an app update
            try { NotifScheduler.schedule(context, NotifStore.plan(context)); } catch (Exception ignored) {}
        }
    }
}
