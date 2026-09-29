package com.ayyam.app;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import android.content.Intent;
import android.net.Uri;

import androidx.lifecycle.Lifecycle;
import androidx.test.core.app.ActivityScenario;
import androidx.test.core.app.ApplicationProvider;
import androidx.test.espresso.Espresso;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.getcapacitor.BridgeActivity;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/** Phase E: Android Back closes an open view instead of exiting; deep links never crash. */
@RunWith(AndroidJUnit4.class)
public class BackAndDeepLinkTest {

    private String runJs(ActivityScenario<MainActivity> s, String js) throws Exception {
        final AtomicReference<String> out = new AtomicReference<>(null);
        final CountDownLatch done = new CountDownLatch(1);
        s.onActivity(a -> ((BridgeActivity) a).getBridge().getWebView().evaluateJavascript(js, v -> { out.set(v); done.countDown(); }));
        done.await(10, TimeUnit.SECONDS);
        return out.get();
    }

    @Test
    public void backClosesSettingsInsteadOfExiting() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            Thread.sleep(6000); // startup so the backButton listener is registered
            runJs(s, "var b=document.getElementById('openSettings'); if(b) b.click(); 'ok'");
            Thread.sleep(900);
            String open = runJs(s, "(function(){var v=document.getElementById('settingsView');return (v&&!v.classList.contains('hidden'))?'open':'closed';})()");
            assertTrue("settings should be open, got " + open, open != null && open.contains("open"));

            Espresso.pressBack(); // must be intercepted → close settings, NOT finish the activity
            Thread.sleep(900);
            assertEquals("activity must still be alive after back", Lifecycle.State.RESUMED, s.getState());
            String closed = runJs(s, "(function(){var v=document.getElementById('settingsView');return (v&&v.classList.contains('hidden'))?'closed':'open';})()");
            assertTrue("back should have closed settings, got " + closed, closed != null && closed.contains("closed"));
        }
    }

    @Test
    public void deepLinkToDeletedTaskDoesNotCrash() throws Exception {
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("ayyam://today?task=does-not-exist-123"))
                .setClassName(ApplicationProvider.getApplicationContext().getPackageName(), "com.ayyam.app.MainActivity");
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(intent)) {
            Thread.sleep(6000);
            assertEquals(Lifecycle.State.RESUMED, s.getState());   // no crash on cold-start deep link
            String origin = runJs(s, "location.origin");
            assertTrue("app should have loaded locally, origin=" + origin, origin != null && origin.contains("localhost"));
        }
    }
}
