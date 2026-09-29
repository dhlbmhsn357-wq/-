package com.ayyam.app.bridge;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;

/**
 * Direct-distribution in-app updater (NOT for the Play build). Downloads a release APK over https to the
 * app cache, verifies its SHA-256 against the manifest, then hands it to the SYSTEM package installer —
 * the user always confirms the install on the OS screen (no silent install is possible or claimed). The
 * new APK MUST be signed with the same certificate as the installed app, or Android itself rejects the
 * update at install time. Requires REQUEST_INSTALL_PACKAGES (declared in the manifest for this build only).
 */
@CapacitorPlugin(name = "UpdaterBridge")
public class UpdaterBridgePlugin extends Plugin {

    private static final String APK_NAME = "ayyam-update.apk";

    // Whether the OS currently allows this app to request package installs (API 26+ gate).
    @PluginMethod
    public void canInstall(PluginCall call) {
        JSObject r = new JSObject();
        boolean can = true;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try { can = getContext().getPackageManager().canRequestPackageInstalls(); } catch (Exception e) { can = false; }
        }
        r.put("canInstall", can);
        r.put("sdk", Build.VERSION.SDK_INT);
        call.resolve(r);
    }

    // Send the user to the "Install unknown apps" screen for THIS app (only when they chose to update).
    @PluginMethod
    public void openInstallSettings(PluginCall call) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                Intent i = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                        Uri.parse("package:" + getContext().getPackageName()));
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(i);
            }
            call.resolve();
        } catch (Exception e) { call.reject("cannot_open_settings"); }
    }

    // Download apkUrl → cache, emit progress, verify sha256. Resolves { path } or rejects with a reason.
    @PluginMethod
    public void download(final PluginCall call) {
        final String url = call.getString("url");
        final String expectedSha = call.getString("sha256", "").toLowerCase();
        if (url == null || !url.toLowerCase().startsWith("https://")) { call.reject("bad_url"); return; }
        if (expectedSha.length() != 64) { call.reject("bad_sha"); return; }
        new Thread(() -> {
            HttpURLConnection conn = null;
            File out = new File(getContext().getCacheDir(), APK_NAME);
            try {
                conn = (HttpURLConnection) new URL(url).openConnection();
                conn.setInstanceFollowRedirects(true);
                conn.setConnectTimeout(20000);
                conn.setReadTimeout(30000);
                conn.connect();
                int code = conn.getResponseCode();
                if (code < 200 || code >= 300) { call.reject("http_" + code); return; }
                long total = conn.getContentLength(); // int is enough for an APK; getContentLengthLong is API 24+
                MessageDigest md = MessageDigest.getInstance("SHA-256");
                try (InputStream in = conn.getInputStream(); FileOutputStream fos = new FileOutputStream(out)) {
                    byte[] buf = new byte[8192];
                    long read = 0; int n; long lastEmit = 0;
                    while ((n = in.read(buf)) != -1) {
                        fos.write(buf, 0, n); md.update(buf, 0, n); read += n;
                        long pct = total > 0 ? (read * 100 / total) : 0;
                        if (pct != lastEmit) { lastEmit = pct;
                            JSObject p = new JSObject(); p.put("loaded", read); p.put("total", total); p.put("percent", pct);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                    fos.flush();
                }
                StringBuilder sb = new StringBuilder();
                for (byte b : md.digest()) sb.append(String.format("%02x", b & 0xff));
                String actual = sb.toString();
                if (!actual.equalsIgnoreCase(expectedSha)) {
                    if (out.exists()) out.delete(); // never keep a mismatched file
                    call.reject("sha_mismatch");
                    return;
                }
                JSObject r = new JSObject(); r.put("path", out.getAbsolutePath()); r.put("sha256", actual);
                call.resolve(r);
            } catch (Exception e) {
                if (out.exists()) out.delete();
                call.reject("download_failed");
            } finally { if (conn != null) conn.disconnect(); }
        }).start();
    }

    // Launch the SYSTEM installer for the downloaded APK. User confirms on the OS screen. Android enforces
    // signature match against the installed app — a differently-signed APK is rejected by the system.
    @PluginMethod
    public void install(PluginCall call) {
        String path = call.getString("path");
        if (path == null) { call.reject("no_path"); return; }
        File apk = new File(path);
        if (!apk.exists()) { call.reject("missing_file"); return; }
        try {
            Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", apk);
            Intent i = new Intent(Intent.ACTION_VIEW);
            i.setDataAndType(uri, "application/vnd.android.package-archive");
            i.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            Activity act = getActivity();
            (act != null ? (android.content.Context) act : getContext()).startActivity(i);
            call.resolve();
        } catch (Exception e) { call.reject("install_failed"); }
    }
}
