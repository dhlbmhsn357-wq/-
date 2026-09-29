package com.ayyam.app.bridge;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.location.Location;
import android.location.LocationManager;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;
import androidx.core.location.LocationManagerCompat;
import androidx.core.os.CancellationSignal;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Bridge for one-shot device location, used ONLY to keep prayer-time reminders accurate. It is invoked
 * exclusively when the user taps "تحديث موقعي الآن" — never at startup, never in the background. It uses
 * the AndroidX LocationManager (no Google Play Services, no Firebase — consistent with the rest of the
 * app) and declares only COARSE + FINE foreground location (never background). Nothing is stored natively;
 * the coordinate is handed to the web layer, which saves it in the existing prefs.location.
 */
@CapacitorPlugin(name = "LocationBridge", permissions = {
        @Permission(alias = "location", strings = {
                Manifest.permission.ACCESS_COARSE_LOCATION,
                Manifest.permission.ACCESS_FINE_LOCATION
        })
})
public class LocationBridgePlugin extends Plugin {

    private boolean hasFine() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    private boolean hasCoarse() {
        return ContextCompat.checkSelfPermission(getContext(), Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }
    private boolean granted() { return hasFine() || hasCoarse(); }

    private boolean servicesEnabled() {
        LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) return false;
        try { return LocationManagerCompat.isLocationEnabled(lm); } catch (Exception e) { return false; }
    }

    // The UI distinguishes states by messaging: "granted" (use it), "denied" (can ask again), and — only
    // after a real ask — "denied_permanently" (→ open settings). GPS-off is a separate `servicesEnabled`.
    private JSObject status() {
        JSObject r = new JSObject();
        r.put("permission", granted() ? "granted" : "denied");
        r.put("precise", hasFine());
        r.put("servicesEnabled", servicesEnabled());
        return r;
    }

    @PluginMethod
    public void checkStatus(PluginCall call) { call.resolve(status()); }

    @PluginMethod
    public void requestPermission(PluginCall call) {
        if (granted()) { call.resolve(status()); return; }
        requestPermissionForAlias("location", call, "locPermCb");
    }

    @PermissionCallback
    private void locPermCb(PluginCall call) {
        JSObject r = status();
        if (!granted()) {
            boolean canAsk = getActivity() != null && (
                    ActivityCompat.shouldShowRequestPermissionRationale(getActivity(), Manifest.permission.ACCESS_FINE_LOCATION)
                 || ActivityCompat.shouldShowRequestPermissionRationale(getActivity(), Manifest.permission.ACCESS_COARSE_LOCATION));
            // After a real ask: no rationale allowed + still denied ⇒ user chose "Don't ask again".
            r.put("permission", canAsk ? "denied" : "denied_permanently");
        }
        call.resolve(r);
    }

    @PluginMethod
    public void openSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS);
            i.setData(Uri.fromParts("package", getContext().getPackageName(), null));
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject("cannot_open_settings"); }
    }

    @PluginMethod
    public void getCurrent(final PluginCall call) {
        if (!granted()) { call.reject("permission"); return; }
        if (!servicesEnabled()) { call.reject("services"); return; }
        final LocationManager lm = (LocationManager) getContext().getSystemService(Context.LOCATION_SERVICE);
        if (lm == null) { call.reject("unavailable"); return; }

        // Fresh last-known fix short-circuits (fast + battery-friendly). "Fresh" = < 2 minutes old.
        Location best = lastKnown(lm);
        if (best != null && (System.currentTimeMillis() - best.getTime()) < 2 * 60 * 1000) {
            resolveLoc(call, best); return;
        }

        // Otherwise request ONE current fix on the best enabled provider, with a hard timeout.
        String provider = lm.isProviderEnabled(LocationManager.GPS_PROVIDER) ? LocationManager.GPS_PROVIDER
                : (lm.isProviderEnabled(LocationManager.NETWORK_PROVIDER) ? LocationManager.NETWORK_PROVIDER : null);
        if (provider == null) {
            if (best != null) { resolveLoc(call, best); return; } // stale is better than nothing
            call.reject("services"); return;
        }
        final CancellationSignal cancel = new CancellationSignal();
        final boolean[] done = { false };
        final Handler h = new Handler(Looper.getMainLooper());
        final Runnable timeout = () -> {
            synchronized (done) {
                if (done[0]) return; done[0] = true;
                try { cancel.cancel(); } catch (Exception ignore) {}
                Location fallback = lastKnown(lm);
                if (fallback != null) resolveLoc(call, fallback); else call.reject("timeout");
            }
        };
        h.postDelayed(timeout, 15000);
        try {
            LocationManagerCompat.getCurrentLocation(lm, provider, cancel, ContextCompat.getMainExecutor(getContext()), loc -> {
                synchronized (done) {
                    if (done[0]) return; done[0] = true;
                    h.removeCallbacks(timeout);
                    if (loc != null) resolveLoc(call, loc);
                    else { Location fb = lastKnown(lm); if (fb != null) resolveLoc(call, fb); else call.reject("no_fix"); }
                }
            });
        } catch (SecurityException e) { h.removeCallbacks(timeout); call.reject("permission"); }
        catch (Exception e) { h.removeCallbacks(timeout); call.reject("error"); }
    }

    private Location lastKnown(LocationManager lm) {
        Location best = null;
        for (String p : new String[]{ LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER, LocationManager.PASSIVE_PROVIDER }) {
            try {
                Location l = lm.getLastKnownLocation(p);
                if (l != null && (best == null || l.getTime() > best.getTime())) best = l;
            } catch (SecurityException ignore) {} catch (Exception ignore) {}
        }
        return best;
    }

    private void resolveLoc(PluginCall call, Location l) {
        JSObject r = new JSObject();
        r.put("lat", l.getLatitude());
        r.put("lng", l.getLongitude());
        r.put("precise", hasFine());
        call.resolve(r);
    }
}
