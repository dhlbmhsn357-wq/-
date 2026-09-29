package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.view.View;
import android.widget.TextView;
import android.widget.FrameLayout;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.widget.AyyamWidgetProvider;
import com.ayyam.app.widget.AyyamWidgetProvider.Size;
import com.ayyam.app.R;

import org.junit.Test;
import org.junit.runner.RunWith;

/**
 * Inflates the widget RemoteViews (via apply) WITHOUT a launcher and asserts rendered content for each
 * SIZE and STATE. Visual/launcher validation (add to home screen, resize, tap) is a manual device pass;
 * WidgetScreenshotTest renders the same layouts to PNGs for review.
 */
@RunWith(AndroidJUnit4.class)
public class WidgetRenderTest {
    private final Context ctx = ApplicationProvider.getApplicationContext();
    private final AyyamWidgetProvider provider = new AyyamWidgetProvider();

    private View inflate(String snapshot, String today, Size size) {
        return provider.buildRemoteViews(ctx, snapshot, today, size, 1).apply(ctx, new FrameLayout(ctx));
    }
    private String txt(View v, int id) { return ((TextView) v.findViewById(id)).getText().toString(); }
    private int vis(View v, int id) { return v.findViewById(id).getVisibility(); }

    private static final String NORMAL =
        "{\"schema\":2,\"date\":\"2026-09-28\",\"dayLabel\":\"الاثنين ٢٨ سبتمبر\",\"done\":22,\"total\":29,\"remaining\":7,\"pct\":76,"
        + "\"next\":{\"id\":\"n\",\"title\":\"مجلس العصر\",\"time\":\"العصر – المغرب\",\"period\":\"asr\"},"
        + "\"upcoming\":[{\"id\":\"u1\",\"title\":\"الجيم\",\"period\":\"maghrib\"}],"
        + "\"remainingPeriods\":[\"asr\",\"maghrib\"]}";

    @Test
    public void mediumNormal_showsNextStatusPeriodsAndRow() {
        View v = inflate(NORMAL, "2026-09-28", Size.MEDIUM);
        assertEquals("الاثنين ٢٨ سبتمبر", txt(v, R.id.w_date));
        assertEquals("٢٢ / ٢٩", txt(v, R.id.w_progress_text));
        assertEquals(View.VISIBLE, vis(v, R.id.w_next_block));
        assertEquals("مجلس العصر", txt(v, R.id.w_next_title));
        assertEquals(View.VISIBLE, vis(v, R.id.w_next_time));
        assertEquals(View.VISIBLE, vis(v, R.id.w_status));
        assertTrue(txt(v, R.id.w_done).contains("٢٢"));       // "أنجزت ٢٢ من ٢٩"
        assertEquals(View.GONE, vis(v, R.id.w_periods));       // periods + upcoming rows are LARGE-only
        assertEquals(View.GONE, vis(v, R.id.w_row0));
    }

    @Test
    public void smallNormal_showsCountAndFocusLine() {
        View v = inflate(NORMAL, "2026-09-28", Size.SMALL);
        assertEquals("٢٢ / ٢٩", txt(v, R.id.w_progress_text));
        assertEquals(View.VISIBLE, vis(v, R.id.w_next_title));
        assertEquals("مجلس العصر", txt(v, R.id.w_next_title));
        assertEquals(View.GONE, vis(v, R.id.w_message));
    }

    @Test
    public void largeNormal_showsMultipleRows() {
        String snap = "{\"schema\":2,\"date\":\"2026-09-28\",\"done\":1,\"total\":5,\"remaining\":4,\"pct\":20,"
            + "\"next\":{\"id\":\"n\",\"title\":\"التالي\",\"period\":\"dhuhr\"},"
            + "\"upcoming\":[{\"id\":\"a\",\"title\":\"مهمة أ\"},{\"id\":\"b\",\"title\":\"مهمة ب\"},{\"id\":\"c\",\"title\":\"مهمة ج\"}],"
            + "\"remainingPeriods\":[\"dhuhr\",\"asr\"]}";
        View v = inflate(snap, "2026-09-28", Size.LARGE);
        assertEquals(View.VISIBLE, vis(v, R.id.w_row0));
        assertEquals(View.VISIBLE, vis(v, R.id.w_row1));
        assertEquals(View.VISIBLE, vis(v, R.id.w_row2));
        assertTrue(txt(v, R.id.w_row2).contains("مهمة ج"));
    }

    @Test
    public void privacyMedium_noTitleButCountsAndPeriods() {
        String snap = "{\"schema\":2,\"date\":\"2026-09-28\",\"done\":22,\"total\":29,\"remaining\":7,\"pct\":76,\"privacy\":true,"
            + "\"next\":{\"id\":\"n\",\"period\":\"asr\"},\"remainingPeriods\":[\"asr\",\"maghrib\"]}";
        View v = inflate(snap, "2026-09-28", Size.MEDIUM);
        assertEquals("مخفية", txt(v, R.id.w_next_title));
        assertTrue(txt(v, R.id.w_status).contains("المتبقي"));    // remaining count, not a title
        assertTrue(txt(v, R.id.w_periods).contains("العصر"));
        assertEquals(View.GONE, vis(v, R.id.w_row0));             // no rows under privacy
    }

    @Test
    public void staleShowsRefreshNotYesterday() {
        String snap = "{\"schema\":2,\"date\":\"2026-09-27\",\"dayLabel\":\"الأحد\",\"done\":1,\"total\":5,"
            + "\"next\":{\"id\":\"y\",\"title\":\"مهمة أمس\"}}";
        View v = inflate(snap, "2026-09-28", Size.MEDIUM);
        assertEquals(View.VISIBLE, vis(v, R.id.w_message));
        assertTrue(txt(v, R.id.w_message).contains("لتحديث"));
        assertEquals(View.GONE, vis(v, R.id.w_next_block));
    }

    @Test
    public void emptyAllDoneNoSnapshot() {
        View empty = inflate("{\"schema\":2,\"date\":\"2026-09-28\",\"done\":0,\"total\":0}", "2026-09-28", Size.MEDIUM);
        assertTrue(txt(empty, R.id.w_message).contains("لا توجد مهام"));
        View allDone = inflate("{\"schema\":2,\"date\":\"2026-09-28\",\"done\":5,\"total\":5}", "2026-09-28", Size.MEDIUM);
        assertTrue(txt(allDone, R.id.w_message).contains("أتممت"));
        View none = inflate(null, "2026-09-28", Size.MEDIUM);
        assertTrue(txt(none, R.id.w_message).contains("لإعداد"));
    }
}
