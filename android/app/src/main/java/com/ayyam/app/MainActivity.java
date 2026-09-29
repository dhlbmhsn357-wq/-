package com.ayyam.app;

import android.os.Bundle;

import com.ayyam.app.bridge.LocationBridgePlugin;
import com.ayyam.app.bridge.NotifBridgePlugin;
import com.ayyam.app.bridge.UpdaterBridgePlugin;
import com.ayyam.app.bridge.WidgetBridgePlugin;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register local plugins BEFORE the bridge initializes.
        registerPlugin(SecureStorePlugin.class);
        registerPlugin(WidgetBridgePlugin.class);
        registerPlugin(NotifBridgePlugin.class);
        registerPlugin(LocationBridgePlugin.class);
        registerPlugin(UpdaterBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
