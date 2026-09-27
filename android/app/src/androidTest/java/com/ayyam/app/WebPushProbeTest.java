package com.ayyam.app;

import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertTrue;

import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;

import com.getcapacitor.BridgeActivity;

import org.junit.Test;
import org.junit.runner.RunWith;

import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;

/**
 * F1: empirically probe Web Push capability INSIDE the Capacitor Android WebView. Records whether the
 * Push API exists at all. The decisive question for keep-WebPush-vs-FCM: is 'PushManager' in window?
 * (Android System WebView does not implement the Push API — and we also disable the SW in native.)
 */
@RunWith(AndroidJUnit4.class)
public class WebPushProbeTest {

    private String runJs(ActivityScenario<MainActivity> s, String js) throws Exception {
        final AtomicReference<String> out = new AtomicReference<>(null);
        final CountDownLatch done = new CountDownLatch(1);
        s.onActivity(a -> ((BridgeActivity) a).getBridge().getWebView().evaluateJavascript(js, v -> { out.set(v); done.countDown(); }));
        done.await(10, TimeUnit.SECONDS);
        return out.get();
    }

    @Test
    public void webPushCapabilityInWebView() throws Exception {
        try (ActivityScenario<MainActivity> s = ActivityScenario.launch(MainActivity.class)) {
            Thread.sleep(5000);
            String caps = runJs(s, "(function(){return JSON.stringify({"
                    + "sw:('serviceWorker' in navigator),"
                    + "pushManager:('PushManager' in window),"
                    + "notification:('Notification' in window),"
                    + "controller:(navigator.serviceWorker&&navigator.serviceWorker.controller!=null)"
                    + "});})()");
            System.out.println("WEBPUSH_PROBE " + caps);
            assertNotNull(caps);
            String c = caps.replace("\\", ""); // evaluateJavascript double-escapes the JSON string
            // Decisive finding: the Push API and Notification API are NOT available in the Android WebView,
            // so Web Push cannot work here → the native channel must be FCM. If either ever becomes true,
            // this fails and we revisit.
            assertTrue("Android WebView unexpectedly exposes PushManager: " + caps, c.contains("\"pushManager\":false"));
            assertTrue("Android WebView unexpectedly exposes Notification: " + caps, c.contains("\"notification\":false"));
        }
    }
}
