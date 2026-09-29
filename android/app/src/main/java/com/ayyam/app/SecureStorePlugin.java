package com.ayyam.app;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Android Keystore-backed secure storage for the device key.
 *
 * Values are stored in an EncryptedSharedPreferences file whose master key lives in the Android
 * Keystore (hardware-backed where available). The key value is NEVER logged. Reject messages carry
 * no value. If encryption is unavailable the plugin rejects, and the JS layer (native.js) falls back
 * explicitly and surfaces a "degraded" state — the key is never silently lost.
 */
@CapacitorPlugin(name = "SecureStore")
public class SecureStorePlugin extends Plugin {
    private static final String FILE = "ayyam_secure_store";

    private SharedPreferences prefs() throws Exception {
        Context ctx = getContext();
        MasterKey masterKey = new MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                ctx,
                FILE,
                masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        );
    }

    @PluginMethod
    public void get(PluginCall call) {
        String k = call.getString("key");
        if (k == null) { call.reject("key required"); return; }
        try {
            String v = prefs().getString(k, null);
            JSObject ret = new JSObject();
            ret.put("value", v);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("secure get failed");
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String k = call.getString("key");
        String v = call.getString("value");
        if (k == null) { call.reject("key required"); return; }
        try {
            prefs().edit().putString(k, v).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("secure set failed");
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String k = call.getString("key");
        if (k == null) { call.reject("key required"); return; }
        try {
            prefs().edit().remove(k).apply();
            call.resolve();
        } catch (Exception e) {
            call.reject("secure remove failed");
        }
    }
}
