package com.ayyam.app.widget;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * PURE widget presentation logic — decides WHAT the widget shows from a snapshot + today's date.
 * No Android dependencies, so it is unit-tested on the JVM (WidgetRenderModelTest). The provider
 * only maps this model onto RemoteViews. Handles stale-date, empty, all-done, no-snapshot and privacy.
 */
public final class WidgetRenderModel {
    public enum State { NORMAL, ALL_DONE, EMPTY, STALE, NO_SNAPSHOT }

    public State state = State.NO_SNAPSHOT;
    public String dayLabel = "";
    public String progressText = "";   // e.g. "٤ / ٧"
    public int progressPct = 0;        // 0..100
    public boolean showProgress = false;
    public String nextTitle = null;    // null when none / privacy
    public String nextTime = null;
    public String nextId = null;
    public boolean showNext = false;
    public final List<Row> rows = new ArrayList<>();
    public String message = "";        // for ALL_DONE / EMPTY / STALE / NO_SNAPSHOT
    public boolean privacy = false;

    public static final class Row {
        public final String id; public final String title; public final boolean done; public final String time;
        Row(String id, String t, boolean d, String tm) { this.id = id; title = t; done = d; time = tm; }
    }

    public static final String MSG_ALL_DONE = "أتممت مهام اليوم ✓";
    public static final String MSG_EMPTY = "لا توجد مهام لليوم";
    public static final String MSG_STALE = "افتح أيام لتحديث مهام اليوم";
    public static final String MSG_NO_SNAPSHOT = "افتح أيام لإعداد الودجت";
    public static final String LABEL_NEXT = "التالي";

    public static String toArabicNum(long n) {
        char[] map = {'٠','١','٢','٣','٤','٥','٦','٧','٨','٩'};
        StringBuilder sb = new StringBuilder();
        String s = Long.toString(n);
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            sb.append(c >= '0' && c <= '9' ? map[c - '0'] : c);
        }
        return sb.toString();
    }

    /** Build the presentation model. `todayDate` is the device-local YYYY-MM-DD. */
    public static WidgetRenderModel from(String snapshotJson, String todayDate, int maxRows) {
        WidgetRenderModel m = new WidgetRenderModel();
        if (snapshotJson == null || snapshotJson.length() == 0) {
            m.state = State.NO_SNAPSHOT; m.message = MSG_NO_SNAPSHOT; return m;
        }
        JSONObject o;
        try { o = new JSONObject(snapshotJson); } catch (Exception e) {
            m.state = State.NO_SNAPSHOT; m.message = MSG_NO_SNAPSHOT; return m;
        }
        String date = o.optString("date", "");
        m.dayLabel = o.optString("dayLabel", "");
        m.privacy = o.optBoolean("privacy", false);

        // Stale: the snapshot is for a different (earlier/other) day than today → never show it as today.
        if (todayDate != null && date.length() > 0 && !date.equals(todayDate)) {
            m.state = State.STALE; m.message = MSG_STALE; return m;
        }

        int done = o.optInt("done", 0);
        int total = o.optInt("total", 0);
        m.progressText = toArabicNum(done) + " / " + toArabicNum(total);
        m.progressPct = total > 0 ? Math.round((done * 100f) / total) : 0;
        m.showProgress = true;

        if (total == 0) { m.state = State.EMPTY; m.message = MSG_EMPTY; m.showProgress = false; return m; }
        if (done >= total) { m.state = State.ALL_DONE; m.message = MSG_ALL_DONE; }
        else m.state = State.NORMAL;

        if (m.privacy) {
            // No titles/times available; show remaining count as the message when not all done.
            int remaining = total - done;
            if (m.state == State.NORMAL) m.message = "لديك " + toArabicNum(remaining) + " مهام متبقية";
            return m;
        }

        JSONObject next = o.optJSONObject("next");
        if (next != null && m.state == State.NORMAL) {
            m.nextTitle = next.optString("title", "");
            m.nextTime = next.optString("time", "");
            m.nextId = next.optString("id", "");
            m.showNext = m.nextTitle.length() > 0;
        }
        JSONArray tasks = o.optJSONArray("tasks");
        if (tasks != null) {
            for (int i = 0; i < tasks.length() && m.rows.size() < maxRows; i++) {
                JSONObject t = tasks.optJSONObject(i);
                if (t == null) continue;
                String title = t.optString("title", "");
                if (title.length() == 0) continue;
                m.rows.add(new Row(t.optString("id", ""), title, t.optBoolean("done", false), t.optString("time", "")));
            }
        }
        return m;
    }
}
