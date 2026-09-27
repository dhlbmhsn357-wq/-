package com.ayyam.app.widget;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.view.View;
import android.widget.RemoteViews;

import com.ayyam.app.MainActivity;
import com.ayyam.app.R;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Locale;

/**
 * Read-only Ayyam home-screen widget (Phase D). Renders the last valid snapshot via WidgetRenderModel,
 * with stale-date / empty / all-done / no-snapshot states. Taps deep-link into the app (ayyam://today
 * [?task=id]). A daily (inexact) alarm flips the widget to "stale" at midnight without opening the app.
 * The widget never reads IndexedDB, never touches Supabase, and never writes app data.
 */
public class AyyamWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_MIDNIGHT = "com.ayyam.app.WIDGET_MIDNIGHT";
    private static final int[] ROW_IDS = { R.id.w_row0, R.id.w_row1, R.id.w_row2, R.id.w_row3, R.id.w_row4 };

    private static String todayLocal() {
        return new SimpleDateFormat("yyyy-MM-dd", Locale.US).format(Calendar.getInstance().getTime());
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager mgr, int[] ids) {
        for (int id : ids) updateWidget(context, mgr, id);
        scheduleMidnight(context);
    }

    @Override
    public void onAppWidgetOptionsChanged(Context context, AppWidgetManager mgr, int id, Bundle opts) {
        updateWidget(context, mgr, id);
    }

    @Override
    public void onEnabled(Context context) { scheduleMidnight(context); }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        if (ACTION_MIDNIGHT.equals(intent.getAction())) {
            AppWidgetManager mgr = AppWidgetManager.getInstance(context);
            int[] ids = mgr.getAppWidgetIds(new ComponentName(context, AyyamWidgetProvider.class));
            for (int id : ids) updateWidget(context, mgr, id);
            scheduleMidnight(context);
        }
    }

    private PendingIntent deepLink(Context context, String uri, int reqCode) {
        Intent i = new Intent(context, MainActivity.class)
                .setAction(Intent.ACTION_VIEW)
                .setData(Uri.parse(uri))
                .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flags = PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE;
        return PendingIntent.getActivity(context, reqCode, i, flags);
    }

    private int maxRowsFor(AppWidgetManager mgr, int id) {
        try {
            Bundle o = mgr.getAppWidgetOptions(id);
            int minH = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            if (minH > 0 && minH < 90) return 0;      // ~4x1: header/progress/next only
            if (minH >= 200) return 5;                // tall: more rows
            return 3;                                  // 4x2 base
        } catch (Exception e) { return 3; }
    }

    private void updateWidget(Context context, AppWidgetManager mgr, int id) {
        mgr.updateAppWidget(id, buildRemoteViews(context, WidgetSnapshotStore.read(context), todayLocal(), maxRowsFor(mgr, id), id));
    }

    /** Build the widget RemoteViews from a snapshot. Public so an instrumented test can inflate it
     *  via RemoteViews.apply(...) and assert its content without a launcher. */
    public RemoteViews buildRemoteViews(Context context, String snapshot, String today, int maxRows, int id) {
        RemoteViews rv = new RemoteViews(context.getPackageName(), R.layout.widget_ayyam);
        WidgetRenderModel m = WidgetRenderModel.from(snapshot, today, maxRows);

        rv.setTextViewText(R.id.w_date, m.dayLabel);

        // reset dynamic views
        rv.setViewVisibility(R.id.w_progress_row, View.GONE);
        rv.setViewVisibility(R.id.w_message, View.GONE);
        rv.setViewVisibility(R.id.w_next_block, View.GONE);
        rv.setViewVisibility(R.id.w_next_time, View.GONE);
        for (int r : ROW_IDS) rv.setViewVisibility(r, View.GONE);

        if (m.showProgress) {
            rv.setViewVisibility(R.id.w_progress_row, View.VISIBLE);
            rv.setTextViewText(R.id.w_progress_text, m.progressText);
            rv.setProgressBar(R.id.w_progress_bar, 100, m.progressPct, false);
        }

        boolean showMessage = m.state == WidgetRenderModel.State.ALL_DONE
                || m.state == WidgetRenderModel.State.EMPTY
                || m.state == WidgetRenderModel.State.STALE
                || m.state == WidgetRenderModel.State.NO_SNAPSHOT
                || (m.privacy && m.message.length() > 0);
        if (showMessage) {
            rv.setViewVisibility(R.id.w_message, View.VISIBLE);
            rv.setTextViewText(R.id.w_message, m.message);
        }

        if (m.state == WidgetRenderModel.State.NORMAL && !m.privacy) {
            if (m.showNext) {
                rv.setViewVisibility(R.id.w_next_block, View.VISIBLE);
                rv.setTextViewText(R.id.w_next_title, m.nextTitle);
                if (m.nextTime != null && m.nextTime.length() > 0) {
                    rv.setViewVisibility(R.id.w_next_time, View.VISIBLE);
                    rv.setTextViewText(R.id.w_next_time, m.nextTime);
                }
                if (m.nextId != null && m.nextId.length() > 0) {
                    rv.setOnClickPendingIntent(R.id.w_next_block,
                            deepLink(context, "ayyam://today?task=" + Uri.encode(m.nextId), id * 100 + 1));
                }
            }
            for (int i = 0; i < m.rows.size() && i < ROW_IDS.length; i++) {
                WidgetRenderModel.Row row = m.rows.get(i);
                String line = (row.done ? "✓ " : "○ ") + row.title + (row.time.length() > 0 ? "  ·  " + row.time : "");
                rv.setViewVisibility(ROW_IDS[i], View.VISIBLE);
                rv.setTextViewText(ROW_IDS[i], line);
                rv.setInt(ROW_IDS[i], "setTextColor", row.done ? 0xFF6E7787 : 0xFFCFD6E4);
                if (row.id != null && row.id.length() > 0) {
                    rv.setOnClickPendingIntent(ROW_IDS[i],
                            deepLink(context, "ayyam://today?task=" + Uri.encode(row.id), id * 100 + 10 + i));
                }
            }
        }

        // Header / whole-widget tap → open Today.
        rv.setOnClickPendingIntent(R.id.w_brand, deepLink(context, "ayyam://today", id * 100));
        rv.setOnClickPendingIntent(R.id.widget_root, deepLink(context, "ayyam://today", id * 100 + 99));

        rv.setContentDescription(R.id.widget_root, "أيام — " + (m.dayLabel.length() > 0 ? m.dayLabel : "مهام اليوم"));
        return rv;
    }

    private void scheduleMidnight(Context context) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            Calendar c = Calendar.getInstance();
            c.add(Calendar.DAY_OF_YEAR, 1);
            c.set(Calendar.HOUR_OF_DAY, 0); c.set(Calendar.MINUTE, 0); c.set(Calendar.SECOND, 5); c.set(Calendar.MILLISECOND, 0);
            Intent i = new Intent(context, AyyamWidgetProvider.class).setAction(ACTION_MIDNIGHT);
            PendingIntent pi = PendingIntent.getBroadcast(context, 777, i,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            am.set(AlarmManager.RTC, c.getTimeInMillis(), pi); // inexact → no exact-alarm permission needed
        } catch (Exception ignored) {}
    }
}
