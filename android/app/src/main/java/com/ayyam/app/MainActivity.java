package com.ayyam.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Register local plugins BEFORE the bridge initializes.
        registerPlugin(SecureStorePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
