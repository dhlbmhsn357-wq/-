package com.ayyam.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.widget.WidgetSnapshotStore;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Phase C: the widget snapshot survives process-death / reboot / APK reinstall. The CI job runs
 * writeWidget once, then verifyWidget after each lifecycle event on the same device.
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
    public void verifyWidget() {
        String s = WidgetSnapshotStore.read(ctx);
        assertNotNull("widget snapshot did not survive", s);
        assertTrue(s.contains("2026-09-27"));
        assertTrue(s.contains("\"total\":7"));
    }
}
