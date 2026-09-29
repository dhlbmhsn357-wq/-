package com.ayyam.app.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;

/**
 * Asks the launcher to redraw the Ayyam widget after a new snapshot lands. Safe no-op when no widget
 * is placed. In Phase D the AyyamWidgetProvider consumes the broadcast; here it is harmless.
 */
public final class WidgetRefresh {
    private WidgetRefresh() {}

    public static void refresh(Context ctx) {
        try {
            Context app = ctx.getApplicationContext();
            ComponentName provider = new ComponentName(app, "com.ayyam.app.widget.AyyamWidgetProvider");
            AppWidgetManager mgr = AppWidgetManager.getInstance(app);
            int[] ids;
            try {
                ids = mgr.getAppWidgetIds(provider);
            } catch (Exception e) {
                ids = null; // provider not registered yet (Phase C) → nothing to refresh
            }
            if (ids != null && ids.length > 0) {
                Intent intent = new Intent(AppWidgetManager.ACTION_APPWIDGET_UPDATE);
                intent.setComponent(provider);
                intent.putExtra(AppWidgetManager.EXTRA_APPWIDGET_IDS, ids);
                app.sendBroadcast(intent);
            }
        } catch (Exception ignored) {
            // refreshing the widget must never throw into the caller
        }
    }
}
