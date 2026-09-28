package com.ayyam.app;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.util.TypedValue;
import android.view.View;
import android.view.View.MeasureSpec;
import android.widget.FrameLayout;

import androidx.test.core.app.ApplicationProvider;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.ayyam.app.widget.AyyamWidgetProvider;
import com.ayyam.app.widget.AyyamWidgetProvider.Size;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.io.File;
import java.io.FileOutputStream;

/**
 * Renders each widget layout/state to a PNG in the app's external files dir (widget-shots/), so CI can
 * pull them as artifacts for visual review — no launcher needed. Not an assertion test (best-effort).
 */
@RunWith(AndroidJUnit4.class)
public class WidgetScreenshotTest {
    private final Context ctx = ApplicationProvider.getApplicationContext();
    private final AyyamWidgetProvider provider = new AyyamWidgetProvider();

    private int dp(int v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, ctx.getResources().getDisplayMetrics())); }

    private void shot(String name, String snapshot, Size size, int wDp, int hDp) throws Exception {
        View v = provider.buildRemoteViews(ctx, snapshot, "2026-09-28", size, 1).apply(ctx, new FrameLayout(ctx));
        int w = dp(wDp), h = dp(hDp);
        v.measure(MeasureSpec.makeMeasureSpec(w, MeasureSpec.EXACTLY), MeasureSpec.makeMeasureSpec(h, MeasureSpec.EXACTLY));
        v.layout(0, 0, w, h);
        Bitmap bmp = Bitmap.createBitmap(w, h, Bitmap.Config.ARGB_8888);
        Canvas c = new Canvas(bmp);
        c.drawColor(0xFF2A2622); // neutral home-screen-ish backdrop so the rounded card edges are visible
        v.draw(c);
        File dir = new File(ctx.getFilesDir(), "widget-shots");
        dir.mkdirs();
        try (FileOutputStream os = new FileOutputStream(new File(dir, name + ".png"))) {
            bmp.compress(Bitmap.CompressFormat.PNG, 100, os);
        }
        System.out.println("WIDGET_SHOT " + name + " -> " + new File(dir, name + ".png").getAbsolutePath());
    }

    private static final String NORMAL =
        "{\"schema\":2,\"date\":\"2026-09-28\",\"dayLabel\":\"الاثنين ٢٨ سبتمبر\",\"done\":22,\"total\":29,\"remaining\":7,\"pct\":76,"
        + "\"next\":{\"id\":\"n\",\"title\":\"مجلس العصر + الشغل\",\"time\":\"العصر – المغرب\",\"period\":\"asr\"},"
        + "\"upcoming\":[{\"id\":\"u1\",\"title\":\"الجيم\",\"time\":\"المغرب – العشاء\",\"period\":\"maghrib\"},"
        + "{\"id\":\"u2\",\"title\":\"خارطة الثغور (ساعتان)\",\"period\":\"isha\"},{\"id\":\"u3\",\"title\":\"اجتماع النقط\",\"period\":\"isha\"}],"
        + "\"remainingPeriods\":[\"asr\",\"maghrib\",\"isha\"]}";
    private static final String PRIVACY =
        "{\"schema\":2,\"date\":\"2026-09-28\",\"dayLabel\":\"الاثنين ٢٨ سبتمبر\",\"done\":22,\"total\":29,\"remaining\":7,\"pct\":76,\"privacy\":true,"
        + "\"next\":{\"id\":\"n\",\"period\":\"asr\"},\"remainingPeriods\":[\"asr\",\"maghrib\"]}";
    private static final String ALL_DONE = "{\"schema\":2,\"date\":\"2026-09-28\",\"dayLabel\":\"الاثنين ٢٨ سبتمبر\",\"done\":29,\"total\":29}";
    private static final String EMPTY = "{\"schema\":2,\"date\":\"2026-09-28\",\"dayLabel\":\"الاثنين ٢٨ سبتمبر\",\"done\":0,\"total\":0}";
    private static final String STALE = "{\"schema\":2,\"date\":\"2026-09-27\",\"dayLabel\":\"الأحد\",\"done\":3,\"total\":7,\"next\":{\"id\":\"y\",\"title\":\"مهمة أمس\"}}";

    @Test
    public void renderAll() throws Exception {
        shot("small_normal", NORMAL, Size.SMALL, 320, 74);
        shot("small_all_done", ALL_DONE, Size.SMALL, 320, 74);
        shot("medium_normal", NORMAL, Size.MEDIUM, 330, 155);
        shot("medium_privacy", PRIVACY, Size.MEDIUM, 330, 155);
        shot("medium_all_done", ALL_DONE, Size.MEDIUM, 330, 155);
        shot("medium_empty", EMPTY, Size.MEDIUM, 330, 155);
        shot("medium_stale", STALE, Size.MEDIUM, 330, 155);
        shot("medium_no_snapshot", null, Size.MEDIUM, 330, 155);
        shot("large_normal", NORMAL, Size.LARGE, 330, 300);
    }
}
