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
 * Read-only Ayyam home-screen widget. Renders the last valid snapshot via WidgetRenderModel as a small
 * DAILY EXECUTION panel — progress, the NEXT (focus) task, a calm status, the open prayer periods, and a
 * few upcoming tasks — across three real layouts (small/medium/large) chosen by the widget's size. Taps
 * deep-link into the app (ayyam://today[?task=id]). A daily inexact alarm flips it to "stale" at midnight
 * without opening the app. It never reads IndexedDB, never touches Supabase, and never writes app data.
 */
public class AyyamWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_MIDNIGHT = "com.ayyam.app.WIDGET_MIDNIGHT";
    public enum Size { SMALL, MEDIUM, LARGE }

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

    private Size sizeFor(AppWidgetManager mgr, int id) {
        try {
            Bundle o = mgr.getAppWidgetOptions(id);
            int minH = o.getInt(AppWidgetManager.OPTION_APPWIDGET_MIN_HEIGHT, 0);
            if (minH > 0 && minH < 100) return Size.SMALL;   // ~4x1
            if (minH >= 200) return Size.LARGE;              // tall / 4x3+
            return Size.MEDIUM;                              // ~4x2
        } catch (Exception e) { return Size.MEDIUM; }
    }

    private int maxRowsFor(Size s) { return s == Size.LARGE ? 4 : (s == Size.MEDIUM ? 1 : 0); }

    private void updateWidget(Context context, AppWidgetManager mgr, int id) {
        Size size = sizeFor(mgr, id);
        mgr.updateAppWidget(id, buildRemoteViews(context, WidgetSnapshotStore.read(context), todayLocal(), size, id));
    }

    /** Build the widget RemoteViews from a snapshot. Public so an instrumented test can inflate it via
     *  RemoteViews.apply(...) and assert its content (and render it to a bitmap) without a launcher. */
    public RemoteViews buildRemoteViews(Context context, String snapshot, String today, Size size, int id) {
        WidgetRenderModel m = WidgetRenderModel.from(snapshot, today, maxRowsFor(size));
        int layout = size == Size.SMALL ? R.layout.widget_small
                : (size == Size.LARGE ? R.layout.widget_large : R.layout.widget_medium);
        RemoteViews rv = new RemoteViews(context.getPackageName(), layout);
        if (size == Size.SMALL) bindSmall(context, rv, m, id);
        else bindMediumLarge(context, rv, m, size, id);

        rv.setOnClickPendingIntent(R.id.widget_root, deepLink(context, "ayyam://today", id * 100 + 99));
        rv.setContentDescription(R.id.widget_root, "أيام — " + (m.dayLabel.length() > 0 ? m.dayLabel : "مهام اليوم"));
        return rv;
    }

    // ---- SMALL (4x1): brand + count, thin bar, one focus line, فتح ----
    private void bindSmall(Context ctx, RemoteViews rv, WidgetRenderModel m, int id) {
        boolean normal = m.state == WidgetRenderModel.State.NORMAL;
        boolean allDone = m.state == WidgetRenderModel.State.ALL_DONE;

        rv.setViewVisibility(R.id.w_progress_text, m.showProgress ? View.VISIBLE : View.GONE);
        rv.setViewVisibility(R.id.w_progress_bar, m.showProgress ? View.VISIBLE : View.GONE);
        if (m.showProgress) {
            rv.setTextViewText(R.id.w_progress_text, m.progressText);
            rv.setProgressBar(R.id.w_progress_bar, 100, m.progressPct, false);
        }

        if (normal) {
            rv.setViewVisibility(R.id.w_message, View.GONE);
            rv.setViewVisibility(R.id.w_next_title, View.VISIBLE);
            String focus = m.privacy ? ("التالي: مخفي  ·  " + m.remainingText) : (m.showNext ? m.nextTitle : m.remainingText);
            rv.setTextViewText(R.id.w_next_title, focus);
            if (!m.privacy && m.nextId != null && m.nextId.length() > 0)
                rv.setOnClickPendingIntent(R.id.w_next_title, deepLink(ctx, "ayyam://today?task=" + Uri.encode(m.nextId), id * 100 + 1));
        } else {
            rv.setViewVisibility(R.id.w_next_title, View.GONE);
            rv.setViewVisibility(R.id.w_message, View.VISIBLE);
            rv.setTextViewText(R.id.w_message, allDone ? WidgetRenderModel.MSG_ALL_DONE : m.message);
        }
        rv.setOnClickPendingIntent(R.id.w_open, deepLink(ctx, "ayyam://today", id * 100 + 2));
        rv.setOnClickPendingIntent(R.id.w_brand, deepLink(ctx, "ayyam://today", id * 100));
    }

    private static final int[] ROW_IDS = { R.id.w_row0, R.id.w_row1, R.id.w_row2, R.id.w_row3 };

    // ---- MEDIUM / LARGE: header, progress, next panel, status + periods, upcoming rows, footer ----
    private void bindMediumLarge(Context ctx, RemoteViews rv, WidgetRenderModel m, Size size, int id) {
        rv.setTextViewText(R.id.w_date, m.dayLabel);

        // reset optional views
        rv.setViewVisibility(R.id.w_next_block, View.GONE);
        rv.setViewVisibility(R.id.w_next_time, View.GONE);
        rv.setViewVisibility(R.id.w_message, View.GONE);
        rv.setViewVisibility(R.id.w_status, View.GONE);
        rv.setViewVisibility(R.id.w_periods, View.GONE);
        rv.setViewVisibility(R.id.w_done, View.GONE);
        int rowCount = size == Size.LARGE ? ROW_IDS.length : 1;
        for (int i = 0; i < rowCount; i++) rv.setViewVisibility(ROW_IDS[i], View.GONE);

        // progress
        rv.setViewVisibility(R.id.w_progress_text, m.showProgress ? View.VISIBLE : View.GONE);
        rv.setViewVisibility(R.id.w_progress_bar, m.showProgress ? View.VISIBLE : View.GONE);
        if (m.showProgress) {
            rv.setTextViewText(R.id.w_progress_text, m.progressText);
            rv.setProgressBar(R.id.w_progress_bar, 100, m.progressPct, false);
        }

        boolean messageState = m.state == WidgetRenderModel.State.ALL_DONE
                || m.state == WidgetRenderModel.State.EMPTY
                || m.state == WidgetRenderModel.State.STALE
                || m.state == WidgetRenderModel.State.NO_SNAPSHOT;

        if (messageState) {
            rv.setViewVisibility(R.id.w_message, View.VISIBLE);
            rv.setTextViewText(R.id.w_message, m.message);
            if (m.state == WidgetRenderModel.State.ALL_DONE) {
                rv.setViewVisibility(R.id.w_done, View.VISIBLE);
                rv.setTextViewText(R.id.w_done, m.doneText);
            }
        } else { // NORMAL (with or without privacy)
            rv.setViewVisibility(R.id.w_next_block, View.VISIBLE);
            String label = WidgetRenderModel.LABEL_NEXT + (m.nextPeriodLabel.length() > 0 ? "  ·  " + m.nextPeriodLabel : "");
            rv.setTextViewText(R.id.w_next_label, label);
            if (m.privacy) {
                rv.setTextViewText(R.id.w_next_title, "مخفية");
            } else {
                rv.setTextViewText(R.id.w_next_title, m.showNext ? m.nextTitle : "");
                if (m.nextTime != null && m.nextTime.length() > 0) {
                    rv.setViewVisibility(R.id.w_next_time, View.VISIBLE);
                    rv.setTextViewText(R.id.w_next_time, m.nextTime);
                }
                if (m.nextId != null && m.nextId.length() > 0)
                    rv.setOnClickPendingIntent(R.id.w_next_block, deepLink(ctx, "ayyam://today?task=" + Uri.encode(m.nextId), id * 100 + 1));
            }

            // status + periods
            String statusLine = m.privacy ? m.remainingText : m.statusText;
            if (statusLine != null && statusLine.length() > 0) {
                rv.setViewVisibility(R.id.w_status, View.VISIBLE);
                rv.setTextViewText(R.id.w_status, statusLine);
            }
            if (m.periodsText != null && m.periodsText.length() > 0) {
                rv.setViewVisibility(R.id.w_periods, View.VISIBLE);
                rv.setTextViewText(R.id.w_periods, m.periodsText);
            }
            rv.setViewVisibility(R.id.w_done, View.VISIBLE);
            rv.setTextViewText(R.id.w_done, m.doneText);

            // upcoming rows (never under privacy — no titles)
            if (!m.privacy) {
                for (int i = 0; i < m.rows.size() && i < rowCount; i++) {
                    WidgetRenderModel.Row row = m.rows.get(i);
                    String line = "○  " + row.title + (row.time.length() > 0 ? "   ·  " + row.time : "");
                    rv.setViewVisibility(ROW_IDS[i], View.VISIBLE);
                    rv.setTextViewText(ROW_IDS[i], line);
                    if (row.id != null && row.id.length() > 0)
                        rv.setOnClickPendingIntent(ROW_IDS[i], deepLink(ctx, "ayyam://today?task=" + Uri.encode(row.id), id * 100 + 10 + i));
                }
            }
        }

        rv.setOnClickPendingIntent(R.id.w_brand, deepLink(ctx, "ayyam://today", id * 100));
        rv.setOnClickPendingIntent(R.id.w_open, deepLink(ctx, "ayyam://today", id * 100 + 2));
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
