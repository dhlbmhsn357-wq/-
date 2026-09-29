package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.ayyam.app.widget.WidgetRenderModel;
import com.ayyam.app.widget.WidgetRenderModel.State;

import org.junit.Test;

/** Pure JVM unit tests for the widget presentation model (the "assistant" logic). */
public class WidgetRenderModelTest {
    private static final String TODAY = "2026-09-28";

    @Test
    public void normalV2_next_status_periods_rows() {
        String snap = "{\"schema\":2,\"date\":\"2026-09-28\",\"dayLabel\":\"الاثنين ٢٨ سبتمبر\",\"done\":22,\"total\":29,"
                + "\"remaining\":7,\"pct\":76,"
                + "\"next\":{\"id\":\"n\",\"title\":\"مجلس العصر\",\"time\":\"العصر – المغرب\",\"period\":\"asr\"},"
                + "\"upcoming\":[{\"id\":\"u1\",\"title\":\"الجيم\",\"time\":\"المغرب – العشاء\",\"period\":\"maghrib\"},"
                + "{\"id\":\"u2\",\"title\":\"خارطة الثغور\",\"period\":\"isha\"}],"
                + "\"remainingPeriods\":[\"asr\",\"maghrib\",\"isha\"]}";
        WidgetRenderModel m = WidgetRenderModel.from(snap, TODAY, 4);
        assertEquals(State.NORMAL, m.state);
        assertEquals("٢٢ / ٢٩", m.progressText);
        assertEquals(76, m.progressPct);
        assertTrue(m.showNext);
        assertEquals("مجلس العصر", m.nextTitle);
        assertEquals("العصر – المغرب", m.nextTime);
        assertEquals("العصر", m.nextPeriodLabel);
        assertEquals("أنجزت ٢٢ من ٢٩", m.doneText);
        assertEquals("المتبقي: ٧ مهام", m.remainingText);
        assertEquals("المتبقي: العصر والمغرب والعشاء", m.periodsText);
        assertEquals("أتممت معظم يومك — تبقّى القليل", m.statusText); // pct>=75
        assertEquals(2, m.rows.size());
        assertEquals("الجيم", m.rows.get(0).title);
        assertEquals("خارطة الثغور", m.rows.get(1).title);
    }

    @Test
    public void rowsExcludeNextAndDone() {
        String snap = "{\"schema\":2,\"date\":\"2026-09-28\",\"done\":1,\"total\":4,"
                + "\"next\":{\"id\":\"b\",\"title\":\"ب\"},"
                + "\"upcoming\":[{\"id\":\"b\",\"title\":\"ب\"},{\"id\":\"c\",\"title\":\"ج\",\"done\":false},{\"id\":\"d\",\"title\":\"د\",\"done\":true}]}";
        WidgetRenderModel m = WidgetRenderModel.from(snap, TODAY, 4);
        assertEquals(1, m.rows.size());          // b is the next (excluded), d is done (excluded)
        assertEquals("ج", m.rows.get(0).title);
    }

    @Test
    public void privacyNormal_noTitles_keepsPeriodsAndCounts() {
        String snap = "{\"schema\":2,\"date\":\"2026-09-28\",\"done\":22,\"total\":29,\"remaining\":7,\"pct\":76,\"privacy\":true,"
                + "\"next\":{\"id\":\"n\",\"period\":\"asr\"},\"remainingPeriods\":[\"asr\",\"maghrib\"]}";
        WidgetRenderModel m = WidgetRenderModel.from(snap, TODAY, 4);
        assertEquals(State.NORMAL, m.state);
        assertTrue(m.privacy);
        assertEquals(null, m.nextTitle);
        assertFalse(m.showNext);
        assertEquals("العصر", m.nextPeriodLabel);          // period is not secret
        assertEquals("المتبقي: ٧ مهام", m.remainingText);
        assertEquals("المتبقي: العصر والمغرب", m.periodsText);
        assertEquals(0, m.rows.size());                    // no rows under privacy
        assertEquals(WidgetRenderModel.NEXT_HIDDEN, m.message);
    }

    @Test
    public void allDone() {
        WidgetRenderModel m = WidgetRenderModel.from("{\"schema\":2,\"date\":\"2026-09-28\",\"done\":5,\"total\":5}", TODAY, 4);
        assertEquals(State.ALL_DONE, m.state);
        assertEquals(WidgetRenderModel.MSG_ALL_DONE, m.message);
        assertEquals(100, m.progressPct);
    }

    @Test
    public void empty() {
        WidgetRenderModel m = WidgetRenderModel.from("{\"schema\":2,\"date\":\"2026-09-28\",\"done\":0,\"total\":0}", TODAY, 4);
        assertEquals(State.EMPTY, m.state);
        assertEquals(WidgetRenderModel.MSG_EMPTY, m.message);
        assertFalse(m.showProgress);
    }

    @Test
    public void staleNeverShowsYesterday() {
        String snap = "{\"schema\":2,\"date\":\"2026-09-27\",\"done\":1,\"total\":5,\"next\":{\"id\":\"y\",\"title\":\"أمس\"}}";
        WidgetRenderModel m = WidgetRenderModel.from(snap, TODAY, 4);
        assertEquals(State.STALE, m.state);
        assertEquals(WidgetRenderModel.MSG_STALE, m.message);
        assertFalse(m.showNext);
    }

    @Test
    public void noSnapshot() {
        assertEquals(State.NO_SNAPSHOT, WidgetRenderModel.from(null, TODAY, 4).state);
        assertEquals(State.NO_SNAPSHOT, WidgetRenderModel.from("not json", TODAY, 4).state);
    }

    @Test
    public void schema1SnapshotStillRenders() { // an old build's snapshot must not break after update
        String snap = "{\"schema\":1,\"date\":\"2026-09-28\",\"done\":1,\"total\":3,"
                + "\"next\":{\"id\":\"n\",\"title\":\"القديم\",\"time\":\"الظهر\"},"
                + "\"tasks\":[{\"id\":\"a\",\"title\":\"منجز\",\"done\":true},{\"id\":\"c\",\"title\":\"باقٍ\",\"done\":false}]}";
        WidgetRenderModel m = WidgetRenderModel.from(snap, TODAY, 4);
        assertEquals(State.NORMAL, m.state);
        assertEquals("القديم", m.nextTitle);
        assertEquals(1, m.rows.size());            // falls back to `tasks`, keeps only incomplete non-next
        assertEquals("باقٍ", m.rows.get(0).title);
    }

    @Test
    public void statusCueScales() {
        assertEquals("ابدأ بمهمتك التالية", WidgetRenderModel.from("{\"schema\":2,\"date\":\"2026-09-28\",\"done\":1,\"total\":10}", TODAY, 4).statusText);
        assertEquals("أنت في منتصف يومك", WidgetRenderModel.from("{\"schema\":2,\"date\":\"2026-09-28\",\"done\":5,\"total\":10}", TODAY, 4).statusText);
    }
}
