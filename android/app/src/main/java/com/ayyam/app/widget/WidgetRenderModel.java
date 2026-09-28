package com.ayyam.app.widget;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;

/**
 * PURE widget presentation logic — decides WHAT the widget shows from a snapshot + today's date.
 * No Android dependencies, so it is unit-tested on the JVM (WidgetRenderModelTest). The provider only
 * maps this model onto RemoteViews. Handles stale-date / empty / all-done / no-snapshot / privacy.
 *
 * v2: the model is an "assistant" — beyond progress it exposes the NEXT (focus) task, a curated list of
 * UPCOMING incomplete tasks, which prayer PERIODS still have open tasks, and a calm status cue, so the
 * widget answers "what now?" and "how much is left?". Task selection is the app's real order only (the
 * snapshot's `next`/`upcoming`), never time-parsed. Tolerant of a schema-1 snapshot left by an older
 * build (falls back to `tasks`), so an app update never shows a broken widget.
 */
public final class WidgetRenderModel {
    public enum State { NORMAL, ALL_DONE, EMPTY, STALE, NO_SNAPSHOT }

    public State state = State.NO_SNAPSHOT;
    public String dayLabel = "";
    public boolean privacy = false;

    // progress
    public boolean showProgress = false;
    public String progressText = "";   // "٤ / ٧"
    public int progressPct = 0;        // 0..100

    // next / focus task
    public boolean showNext = false;
    public String nextTitle = null;
    public String nextTime = null;
    public String nextId = null;
    public String nextPeriodLabel = ""; // Arabic period label of the next task (may be empty)

    // summary + status
    public String doneText = "";       // "أنجزت ٢٢ من ٢٩"
    public String remainingText = "";  // "المتبقي: ٧ مهام"
    public String periodsText = "";     // "المتبقي: العصر والمغرب"  (may be empty)
    public String statusText = "";      // calm cue (may be empty)

    // curated upcoming rows (incomplete)
    public final List<Row> rows = new ArrayList<>();

    public String message = "";        // for ALL_DONE / EMPTY / STALE / NO_SNAPSHOT / privacy-next

    public static final class Row {
        public final String id; public final String title; public final boolean done;
        public final String time; public final String periodLabel;
        Row(String id, String t, boolean d, String tm, String pl) { this.id = id; title = t; done = d; time = tm; periodLabel = pl; }
    }

    public static final String MSG_ALL_DONE = "أتممت مهام اليوم ✓";
    public static final String MSG_EMPTY = "لا توجد مهام لليوم";
    public static final String MSG_STALE = "افتح أيام لتحديث مهام اليوم";
    public static final String MSG_NO_SNAPSHOT = "افتح أيام لإعداد الودجت";
    public static final String LABEL_NEXT = "التالي";
    public static final String NEXT_HIDDEN = "المهمة التالية: مخفية";

    private static String periodLabel(String p) {
        if (p == null) return "";
        switch (p) {
            case "fajr": return "الفجر";
            case "dhuhr": return "الظهر";
            case "asr": return "العصر";
            case "maghrib": return "المغرب";
            case "isha": return "العشاء";
            default: return "";
        }
    }

    // Arabic task-count grammar (matches the reminders wording).
    private static String tasksCount(int n) {
        if (n == 1) return "مهمة واحدة";
        if (n == 2) return "مهمتان";
        if (n <= 10) return toArabicNum(n) + " مهام";
        return toArabicNum(n) + " مهمة";
    }

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
        int remaining = o.has("remaining") ? o.optInt("remaining", total - done) : (total - done);
        m.progressText = toArabicNum(done) + " / " + toArabicNum(total);
        m.progressPct = o.has("pct") ? clamp(o.optInt("pct", 0)) : (total > 0 ? Math.round((done * 100f) / total) : 0);
        m.showProgress = true;

        if (total == 0) { m.state = State.EMPTY; m.message = MSG_EMPTY; m.showProgress = false; return m; }
        if (done >= total) { m.state = State.ALL_DONE; m.message = MSG_ALL_DONE; m.progressPct = 100; return m; }
        m.state = State.NORMAL;

        // Summary strings (privacy-safe: counts + periods, no titles).
        m.doneText = "أنجزت " + toArabicNum(done) + " من " + toArabicNum(total);
        m.remainingText = "المتبقي: " + tasksCount(remaining);
        m.periodsText = openPeriodsText(o);
        m.statusText = statusCue(m.progressPct, remaining, total);

        JSONObject next = o.optJSONObject("next");
        if (next != null) {
            m.nextId = next.optString("id", "");
            m.nextPeriodLabel = periodLabel(next.optString("period", null));
            if (!m.privacy) {
                m.nextTitle = next.optString("title", "");
                m.nextTime = next.optString("time", "");
                m.showNext = m.nextTitle.length() > 0;
            } else {
                m.message = NEXT_HIDDEN; // shown in the next slot under privacy
            }
        }

        // Curated upcoming rows: prefer v2 `upcoming` (incomplete only); fall back to schema-1 `tasks`.
        JSONArray up = o.optJSONArray("upcoming");
        if (up == null) up = o.optJSONArray("tasks");
        if (up != null && !m.privacy) {
            for (int i = 0; i < up.length() && m.rows.size() < maxRows; i++) {
                JSONObject t = up.optJSONObject(i);
                if (t == null) continue;
                if (t.optBoolean("done", false)) continue;          // rows show what's LEFT to do
                String title = t.optString("title", "");
                if (title.length() == 0) continue;
                if (m.nextId != null && m.nextId.length() > 0 && m.nextId.equals(t.optString("id", "")))
                    continue;                                        // never duplicate the focus task
                m.rows.add(new Row(t.optString("id", ""), title, false, t.optString("time", ""), periodLabel(t.optString("period", null))));
            }
        }
        return m;
    }

    private static int clamp(int p) { return p < 0 ? 0 : (p > 100 ? 100 : p); }

    // "المتبقي: العصر والمغرب" from remainingPeriods (canonical order); empty when unavailable.
    private static String openPeriodsText(JSONObject o) {
        JSONArray rp = o.optJSONArray("remainingPeriods");
        if (rp == null || rp.length() == 0) return "";
        StringBuilder sb = new StringBuilder();
        int shown = 0;
        for (int i = 0; i < rp.length(); i++) {
            String lbl = periodLabel(rp.optString(i, null));
            if (lbl.length() == 0) continue;
            if (shown > 0) sb.append(" و");
            sb.append(lbl);
            shown++;
        }
        return shown == 0 ? "" : "المتبقي: " + sb;
    }

    // Calm, professional status cue — never childish, never a fake time claim.
    private static String statusCue(int pct, int remaining, int total) {
        if (pct >= 75) return "أتممت معظم يومك — تبقّى القليل";
        if (remaining <= 2 && total > 2) return "ركّز على مهامك الأخيرة";
        if (pct >= 40) return "أنت في منتصف يومك";
        return "ابدأ بمهمتك التالية";
    }
}
