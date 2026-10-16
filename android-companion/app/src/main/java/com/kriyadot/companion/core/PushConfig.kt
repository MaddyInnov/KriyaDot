// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import android.content.Context
import com.google.firebase.FirebaseApp
import com.google.firebase.FirebaseOptions
import org.json.JSONObject

/**
 * Manual Firebase initialization (no google-services plugin).
 *
 * Reads `assets/fcm_config.json` (gitignored — copy
 * `assets/fcm_config.json.template` and fill in your Firebase project's
 * values; see the companion README's "Push notifications" section).
 * Returns false when the config is absent or invalid, in which case FCM is
 * disabled and the app relies on the WebSocket while foregrounded.
 */
object PushConfig {

    data class FcmConfig(
        val applicationId: String,
        val apiKey: String,
        val projectId: String,
        val senderId: String,
    )

    fun load(context: Context): FcmConfig? {
        return try {
            val text = context.assets.open("fcm_config.json").bufferedReader().readText()
            val o = JSONObject(text)
            val cfg = FcmConfig(
                applicationId = o.optString("applicationId"),
                apiKey = o.optString("apiKey"),
                projectId = o.optString("projectId"),
                senderId = o.optString("senderId"),
            )
            if (cfg.applicationId.isBlank() || cfg.apiKey.isBlank() ||
                cfg.projectId.isBlank() || cfg.senderId.isBlank()
            ) {
                null
            } else cfg
        } catch (_: Exception) {
            null
        }
    }

    /** Initializes the default FirebaseApp. Returns true when FCM is usable. */
    fun init(context: Context): Boolean {
        if (FirebaseApp.getApps(context).isNotEmpty()) return true
        val cfg = load(context) ?: return false
        return try {
            val options = FirebaseOptions.Builder()
                .setApplicationId(cfg.applicationId)
                .setApiKey(cfg.apiKey)
                .setProjectId(cfg.projectId)
                .setGcmSenderId(cfg.senderId)
                .build()
            FirebaseApp.initializeApp(context, options)
            true
        } catch (_: Exception) {
            false
        }
    }
}
