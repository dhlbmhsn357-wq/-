package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;

import android.content.Context;
import android.content.SharedPreferences;

import androidx.security.crypto.EncryptedSharedPreferences;
import androidx.security.crypto.MasterKey;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Proves the Android Keystore-backed secure store (the same EncryptedSharedPreferences the
 * SecureStore plugin uses) round-trips a value and survives process-death / reboot / reinstall.
 * The CI job runs writeKey once, then verifyKey after each lifecycle event on the same device.
 * The value is a throwaway probe — never the real device key.
 */
@RunWith(AndroidJUnit4.class)
public class SecureStoreTest {
    private static final String FILE = "ayyam_secure_store";
    private static final String PROBE_KEY = "phaseB_probe";
    private static final String PROBE_VAL = "keystore-probe-value-99";

    private SharedPreferences prefs() throws Exception {
        Context ctx = ApplicationProvider.getApplicationContext();
        MasterKey masterKey = new MasterKey.Builder(ctx)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build();
        return EncryptedSharedPreferences.create(
                ctx, FILE, masterKey,
                EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
                EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM);
    }

    @Test
    public void writeKey() throws Exception {
        SharedPreferences p = prefs();
        p.edit().putString(PROBE_KEY, PROBE_VAL).commit();
        assertEquals("Keystore round-trip failed", PROBE_VAL, p.getString(PROBE_KEY, null));
    }

    @Test
    public void verifyKey() throws Exception {
        String v = prefs().getString(PROBE_KEY, null);
        assertNotNull("secure value missing after lifecycle event", v);
        assertEquals(PROBE_VAL, v);
    }
}
