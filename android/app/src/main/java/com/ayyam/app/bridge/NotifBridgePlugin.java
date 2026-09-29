package com.ayyam.app.bridge;

import android.Manifest;
import android.os.Build;

import androidx.core.app.NotificationManagerCompat;

import com.ayyam.app.notif.NotifScheduler;
import com.ayyam.app.notif.NotifStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Bridge for local (on-device) reminders. The web app builds the plan and calls setPlan; native
 * persists + schedules inexact alarms. No network, no Supabase, no task reads on the native side.
 */
@CapacitorPlugin(name = "NotifBridge", permissions = {
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
})
public class NotifBridgePlugin extends Plugin {

    private String perm() {
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
    }

    @PluginMethod
    public void setPlan(PluginCall call) {
        JSObject plan = call.getObject("plan");
        if (plan == null) { call.reject("plan required"); return; }
        int n = NotifScheduler.reschedule(getContext(), plan.toString());
        if (n < 0) { call.reject("invalid plan"); return; } // last-known-good kept
        JSObject r = new JSObject(); r.put("ok", true); r.put("scheduled", n); call.resolve(r);
    }

    @PluginMethod
    public void clear(PluginCall call) {
        NotifScheduler.cancel(getContext(), NotifStore.plan(getContext()));
        NotifStore.clear(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject r;
        try { r = JSObject.fromJSONObject(NotifStore.status(getContext())); } catch (Exception e) { r = new JSObject(); }
        r.put("permission", perm());
        call.resolve(r);
    }

    @PluginMethod
    public void checkPermission(PluginCall call) {
        JSObject r = new JSObject(); r.put("permission", perm()); call.resolve(r);
    }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < 33 || "granted".equals(perm())) {
            JSObject r = new JSObject(); r.put("permission", perm()); call.resolve(r); return;
        }
        requestPermissionForAlias("notifications", call, "permCb");
    }

    @PermissionCallback
    private void permCb(PluginCall call) {
        JSObject r = new JSObject(); r.put("permission", perm()); call.resolve(r);
    }
}
