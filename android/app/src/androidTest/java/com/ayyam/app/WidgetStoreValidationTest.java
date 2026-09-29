package com.ayyam.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.widget.WidgetSnapshotStore;

import org.junit.Test;
import org.junit.runner.RunWith;

/** Phase C: WidgetSnapshotStore validation, last-known-good, rapid updates, and no-secret checks. */
@RunWith(AndroidJUnit4.class)
public class WidgetStoreValidationTest {
    private final Context ctx = ApplicationProvider.getApplicationContext();
    private static final String VALID =
        "{\"schema\":2,\"date\":\"2026-09-27\",\"dayLabel\":\"الأحد\",\"done\":2,\"total\":3,\"tasks\":[]}";

    @Test
    public void savesValidSnapshot() {
        assertTrue(WidgetSnapshotStore.save(ctx, VALID));
        assertNotNull(WidgetSnapshotStore.read(ctx));
        assertTrue(WidgetSnapshotStore.read(ctx).contains("2026-09-27"));
    }

    @Test
    public void rejectsMalformedJsonAndKeepsLastGood() {
        assertTrue(WidgetSnapshotStore.save(ctx, VALID));
        assertFalse(WidgetSnapshotStore.save(ctx, "this is not json"));
        assertFalse(WidgetSnapshotStore.save(ctx, "{\"schema\":1")); // truncated
        // last-known-good preserved
        assertTrue(WidgetSnapshotStore.read(ctx).contains("2026-09-27"));
    }

    @Test
    public void rejectsUnsupportedSchema() {
        assertTrue(WidgetSnapshotStore.save(ctx, VALID));
        assertFalse(WidgetSnapshotStore.save(ctx, "{\"schema\":9,\"date\":\"2026-09-27\",\"done\":0,\"total\":0}"));
        assertTrue(WidgetSnapshotStore.read(ctx).contains("\"done\":2")); // unchanged
    }

    @Test
    public void rapid100UpdatesLandOnLast() {
        for (int i = 0; i < 100; i++) {
            WidgetSnapshotStore.save(ctx, "{\"schema\":2,\"date\":\"2026-09-27\",\"done\":" + i + ",\"total\":100}");
        }
        assertTrue(WidgetSnapshotStore.read(ctx).contains("\"done\":99"));
    }

    @Test
    public void storedSnapshotHasNoSecret() {
        assertTrue(WidgetSnapshotStore.save(ctx, VALID));
        String s = WidgetSnapshotStore.read(ctx).toLowerCase();
        for (String bad : new String[]{"devicekey", "p256dh", "\"auth\"", "supabase", "revision", "epoch", "recovery", "outbox"}) {
            assertFalse("stored snapshot must not contain " + bad, s.contains(bad));
        }
    }
}
