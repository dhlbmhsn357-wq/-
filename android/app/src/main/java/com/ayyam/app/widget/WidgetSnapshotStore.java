package com.ayyam.app.widget;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/**
 * Persistent store for the widget view-model snapshot (SharedPreferences file "ayyam_widget").
 *
 * Rules:
 *  - Only a VALID snapshot (schema==1, has date, numeric done/total) is written.
 *  - A malformed/unsupported payload is REJECTED and the last-known-good is left untouched.
 *  - Writes are atomic (SharedPreferences commit is per-file atomic).
 *  - The snapshot is a view model only — it must never contain secrets; this store never adds any.
 */
public final class WidgetSnapshotStore {
    private static final String FILE = "ayyam_widget";
    private static final String KEY = "snapshot";
    public static final int SCHEMA = 2;

    private WidgetSnapshotStore() {}

    private static SharedPreferences prefs(Context ctx) {
        return ctx.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    /** Validate a snapshot JSON string. Returns the parsed object or null if invalid/unsupported. */
    public static JSONObject validate(String json) {
        if (json == null || json.length() == 0 || json.length() > 200000) return null;
        try {
            JSONObject o = new JSONObject(json);
            if (o.optInt("schema", -1) != SCHEMA) return null;
            String date = o.optString("date", "");
            if (!date.matches("\\d{4}-\\d{2}-\\d{2}")) return null;
            if (!o.has("done") || !o.has("total")) return null;
            o.getInt("done");
            o.getInt("total");
            return o;
        } catch (Exception e) {
            return null;
        }
    }

    /** Save if valid. Returns true on write, false if rejected (last-known-good preserved). */
    public static boolean save(Context ctx, String json) {
        JSONObject o = validate(json);
        if (o == null) return false;
        return prefs(ctx).edit().putString(KEY, o.toString()).commit();
    }

    public static String read(Context ctx) {
        return prefs(ctx).getString(KEY, null);
    }

    public static void clear(Context ctx) {
        prefs(ctx).edit().remove(KEY).commit();
    }

    /** Non-sensitive status for diagnostics/getStatus. */
    public static JSONObject status(Context ctx) {
        JSONObject out = new JSONObject();
        try {
            String json = read(ctx);
            out.put("hasSnapshot", json != null);
            if (json != null) {
                JSONObject o = new JSONObject(json);
                out.put("schema", o.optInt("schema", -1));
                out.put("date", o.optString("date", ""));
                out.put("generatedAt", o.optString("generatedAt", ""));
                out.put("total", o.optInt("total", 0));
                out.put("done", o.optInt("done", 0));
            }
        } catch (Exception ignored) {}
        return out;
    }
}
