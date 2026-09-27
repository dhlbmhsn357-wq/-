package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.widget.WidgetSnapshotStore;

import org.json.JSONObject;
import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Phase C: a VALID widget snapshot survives process-death / reboot / APK reinstall. Note that when the
 * app (MainActivity/WebView) launches during the shell tests, it writes its own snapshot through the
 * bridge — so verifyWidget asserts that a valid snapshot is present (which proves the app→bridge→store
 * pipeline AND persistence), not a hardcoded value the app would overwrite.
 */
@RunWith(AndroidJUnit4.class)
public class WidgetSnapshotStoreTest {
    private final Context ctx = ApplicationProvider.getApplicationContext();
    private static final String SNAP =
        "{\"schema\":1,\"date\":\"2026-09-27\",\"dayLabel\":\"الأحد\",\"done\":4,\"total\":7,\"tasks\":[]}";

    @Test
    public void writeWidget() {
        assertTrue(WidgetSnapshotStore.save(ctx, SNAP));
    }

    @Test
    public void verifyWidget() throws Exception {
        String s = WidgetSnapshotStore.read(ctx);
        assertNotNull("no widget snapshot present after lifecycle event", s);
        JSONObject o = new JSONObject(s);                 // throws → malformed = test error
        assertEquals(1, o.getInt("schema"));
        assertTrue("date must be YYYY-MM-DD", o.getString("date").matches("\\d{4}-\\d{2}-\\d{2}"));
        assertTrue(o.has("done") && o.has("total"));
    }
}
