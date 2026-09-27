package com.ayyam.app.notif;

import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONObject;

/** Persists the local-notification PLAN (schema-validated, atomic, last-known-good). No secrets. */
public final class NotifStore {
    private static final String FILE = "ayyam_notif";
    private static final String KEY = "plan";
    public static final int SCHEMA = 1;

    private NotifStore() {}

    private static SharedPreferences prefs(Context c) {
        return c.getApplicationContext().getSharedPreferences(FILE, Context.MODE_PRIVATE);
    }

    public static JSONObject validate(String json) {
        if (json == null || json.length() == 0 || json.length() > 500000) return null;
        try {
            JSONObject o = new JSONObject(json);
            if (o.optInt("schema", -1) != SCHEMA) return null;
            if (!o.has("items")) return null;
            o.getJSONArray("items");
            return o;
        } catch (Exception e) { return null; }
    }

    public static boolean save(Context c, String json) {
        if (validate(json) == null) return false; // reject malformed → keep last-known-good
        return prefs(c).edit().putString(KEY, json).commit();
    }

    public static JSONObject plan(Context c) {
        String s = prefs(c).getString(KEY, null);
        return s == null ? null : validate(s);
    }

    public static void clear(Context c) { prefs(c).edit().remove(KEY).commit(); }

    public static JSONObject status(Context c) {
        JSONObject out = new JSONObject();
        try {
            JSONObject p = plan(c);
            out.put("hasPlan", p != null);
            if (p != null) {
                out.put("generatedAt", p.optString("generatedAt", ""));
                out.put("count", p.getJSONArray("items").length());
            }
        } catch (Exception ignored) {}
        return out;
    }
}
