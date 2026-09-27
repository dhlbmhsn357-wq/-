package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import com.ayyam.app.widget.WidgetRenderModel;
import com.ayyam.app.widget.WidgetRenderModel.State;

import org.junit.Test;

/** JVM unit tests for the pure widget presentation logic (no emulator needed). */
public class WidgetRenderModelTest {
    private static final String TODAY = "2026-09-27";

    private String snap(String date, int done, int total, String extra) {
        return "{\"schema\":1,\"date\":\"" + date + "\",\"dayLabel\":\"الأحد ٢٧ سبتمبر\",\"done\":" + done
                + ",\"total\":" + total + (extra == null ? "" : "," + extra) + "}";
    }

    @Test public void noSnapshot() {
        WidgetRenderModel m = WidgetRenderModel.from(null, TODAY, 3);
        assertEquals(State.NO_SNAPSHOT, m.state);
        assertEquals(WidgetRenderModel.MSG_NO_SNAPSHOT, m.message);
    }

    @Test public void malformedTreatedAsNoSnapshot() {
        WidgetRenderModel m = WidgetRenderModel.from("not json", TODAY, 3);
        assertEquals(State.NO_SNAPSHOT, m.state);
    }

    @Test public void staleDateDoesNotShowYesterday() {
        WidgetRenderModel m = WidgetRenderModel.from(
                snap("2026-09-26", 3, 7, "\"next\":{\"title\":\"قديم\"}"), TODAY, 3);
        assertEquals(State.STALE, m.state);
        assertEquals(WidgetRenderModel.MSG_STALE, m.message);
        assertFalse("must not surface yesterday's next task", "قديم".equals(m.nextTitle));
    }

    @Test public void emptyDay() {
        WidgetRenderModel m = WidgetRenderModel.from(snap(TODAY, 0, 0, null), TODAY, 3);
        assertEquals(State.EMPTY, m.state);
        assertEquals(WidgetRenderModel.MSG_EMPTY, m.message);
    }

    @Test public void allDone() {
        WidgetRenderModel m = WidgetRenderModel.from(snap(TODAY, 7, 7, null), TODAY, 3);
        assertEquals(State.ALL_DONE, m.state);
        assertEquals(WidgetRenderModel.MSG_ALL_DONE, m.message);
        assertEquals("٧ / ٧", m.progressText);
        assertEquals(100, m.progressPct);
    }

    @Test public void normalShowsProgressNextAndRows() {
        String extra = "\"next\":{\"title\":\"الجيم\",\"time\":\"المغرب – العشاء\"},"
                + "\"tasks\":[{\"title\":\"الفجر\",\"done\":true,\"time\":\"قبل الفجر\"},"
                + "{\"title\":\"الجيم\",\"done\":false,\"time\":\"المغرب – العشاء\"},"
                + "{\"title\":\"ثالثة\",\"done\":false,\"time\":\"\"}]";
        WidgetRenderModel m = WidgetRenderModel.from(snap(TODAY, 3, 7, extra), TODAY, 2);
        assertEquals(State.NORMAL, m.state);
        assertEquals("٣ / ٧", m.progressText);
        assertEquals(43, m.progressPct);           // round(3/7*100)
        assertTrue(m.showNext);
        assertEquals("الجيم", m.nextTitle);
        assertEquals("المغرب – العشاء", m.nextTime); // free-text time preserved
        assertEquals(2, m.rows.size());             // capped at maxRows
        assertTrue(m.rows.get(0).done);
    }

    @Test public void privacyHidesTitlesButKeepsProgress() {
        WidgetRenderModel m = WidgetRenderModel.from(
                snap(TODAY, 1, 3, "\"privacy\":true"), TODAY, 3);
        assertEquals(State.NORMAL, m.state);
        assertEquals("١ / ٣", m.progressText);
        assertEquals(null, m.nextTitle);
        assertEquals(0, m.rows.size());
        assertTrue(m.message.contains("متبقية"));
    }

    @Test public void arabicNumerals() {
        assertEquals("٠", WidgetRenderModel.toArabicNum(0));
        assertEquals("١٢٣", WidgetRenderModel.toArabicNum(123));
    }
}
