package com.ayyam.app.bridge;

import com.ayyam.app.widget.WidgetRefresh;
import com.ayyam.app.widget.WidgetSnapshotStore;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Bridge from the web app to the native widget snapshot store. The web app owns the truth (IndexedDB);
 * the widget is a derived, best-effort mirror. This plugin only persists a validated view-model
 * snapshot and asks the widget to redraw — it never touches Supabase or the app's real data, and a
 * failure here must never affect the web app's own save.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    @PluginMethod
    public void updateSnapshot(PluginCall call) {
        JSObject snap = call.getObject("snapshot");
        if (snap == null) { call.reject("snapshot required"); return; }
        boolean ok = WidgetSnapshotStore.save(getContext(), snap.toString());
        if (!ok) { call.reject("invalid snapshot"); return; } // last-known-good preserved
        WidgetRefresh.refresh(getContext());
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void clearSnapshot(PluginCall call) {
        WidgetSnapshotStore.clear(getContext());
        WidgetRefresh.refresh(getContext());
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject ret;
        try {
            ret = JSObject.fromJSONObject(WidgetSnapshotStore.status(getContext()));
        } catch (Exception e) {
            ret = new JSObject();
            ret.put("hasSnapshot", false);
        }
        call.resolve(ret);
    }
}
