package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.widget.AyyamWidgetProvider;
import com.ayyam.app.R;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Inflates the widget RemoteViews (via apply) WITHOUT a launcher and asserts the rendered content.
 * This is the automatable slice of the widget UI; visual/launcher validation (add to home screen,
 * resize, tap) is documented as a manual device pass.
 */
@RunWith(AndroidJUnit4.class)
public class WidgetRenderTest {
    private final Context ctx = ApplicationProvider.getApplicationContext();
    private final AyyamWidgetProvider provider = new AyyamWidgetProvider();

    private View inflate(String snapshot, String today) {
        return provider.buildRemoteViews(ctx, snapshot, today, 3, 1).apply(ctx, new FrameLayout(ctx));
    }
    private String txt(View v, int id) { return ((TextView) v.findViewById(id)).getText().toString(); }
    private int vis(View v, int id) { return v.findViewById(id).getVisibility(); }

    @Test
    public void normalRendersProgressAndNext() {
        String snap = "{\"schema\":1,\"date\":\"2026-09-27\",\"dayLabel\":\"الأحد ٢٧ سبتمبر\",\"done\":3,\"total\":7,"
                + "\"next\":{\"id\":\"x\",\"title\":\"الجيم\",\"time\":\"المغرب – العشاء\"},"
                + "\"tasks\":[{\"id\":\"a\",\"title\":\"الفجر\",\"done\":true},{\"id\":\"x\",\"title\":\"الجيم\",\"done\":false}]}";
        View v = inflate(snap, "2026-09-27");
        assertEquals("الأحد ٢٧ سبتمبر", txt(v, R.id.w_date));
        assertEquals("٣ / ٧", txt(v, R.id.w_progress_text));
        assertEquals(View.VISIBLE, vis(v, R.id.w_next_block));
        assertEquals("الجيم", txt(v, R.id.w_next_title));
        assertEquals(View.VISIBLE, vis(v, R.id.w_next_time));
    }

    @Test
    public void staleShowsRefreshMessageNotYesterday() {
        String snap = "{\"schema\":1,\"date\":\"2026-09-26\",\"dayLabel\":\"السبت\",\"done\":1,\"total\":5,"
                + "\"next\":{\"id\":\"y\",\"title\":\"مهمة أمس\"}}";
        View v = inflate(snap, "2026-09-27");
        assertEquals(View.VISIBLE, vis(v, R.id.w_message));
        assertTrue(txt(v, R.id.w_message).contains("لتحديث"));
        assertEquals(View.GONE, vis(v, R.id.w_next_block)); // yesterday's next is NOT shown
    }

    @Test
    public void emptyAndAllDoneMessages() {
        View empty = inflate("{\"schema\":1,\"date\":\"2026-09-27\",\"done\":0,\"total\":0}", "2026-09-27");
        assertTrue(txt(empty, R.id.w_message).contains("لا توجد مهام"));
        View allDone = inflate("{\"schema\":1,\"date\":\"2026-09-27\",\"done\":5,\"total\":5}", "2026-09-27");
        assertTrue(txt(allDone, R.id.w_message).contains("أتممت"));
    }

    @Test
    public void noSnapshotMessage() {
        View v = inflate(null, "2026-09-27");
        assertEquals(View.VISIBLE, vis(v, R.id.w_message));
        assertTrue(txt(v, R.id.w_message).contains("لإعداد"));
    }
}
