// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Encrypted storage for the pairing: server address + long-lived device token.
 * The one-time token (ott) from the QR code is exchanged once and never stored.
 */
class PairingStore(context: Context) {

    private val masterKey: MasterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        PREFS_NAME,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    val isPaired: Boolean
        get() = prefs.getString(KEY_DEVICE_TOKEN, null)?.isNotEmpty() == true &&
            (prefs.getString(KEY_HOST, null)?.isNotEmpty() == true ||
                prefs.getString(KEY_SERVER_URL, null)?.isNotEmpty() == true)

    val host: String get() = prefs.getString(KEY_HOST, "") ?: ""
    val port: Int get() = prefs.getInt(KEY_PORT, 3000)
    val deviceToken: String get() = prefs.getString(KEY_DEVICE_TOKEN, "") ?: ""
    val deviceId: String get() = prefs.getString(KEY_DEVICE_ID, "") ?: ""
    val deviceName: String get() = prefs.getString(KEY_DEVICE_NAME, "") ?: ""

    /**
     * Per-device AES-256 key (base64) for sealed push payloads, issued at
     * pairing. Null for pairings made before push keys existed — pushes then
     * fall back to generic text.
     */
    val pushKey: String? get() = prefs.getString(KEY_PUSH_KEY, null)?.ifEmpty { null }

    /**
     * Bot id chosen in the chat picker (persisted after each roster load or
     * explicit selection). Null until the roster has been loaded once.
     */
    val selectedBotId: String? get() = prefs.getString(KEY_SELECTED_BOT_ID, null)?.ifEmpty { null }

    /** Hosted-mode public base URL (https://…), or null for LAN pairing. */
    val serverUrl: String? get() = prefs.getString(KEY_SERVER_URL, null)?.ifEmpty { null }

    /** Human label for the connection indicator: URL in hosted mode, host:port on LAN. */
    val serverLabel: String get() = serverUrl ?: "$host:$port"

    /** http(s) base URL for REST calls. */
    val baseUrl: String get() = serverUrl ?: "http://$host:$port"

    /** ws(s) base URL for the push socket — https upgrades to wss. */
    val wsBaseUrl: String
        get() {
            val b = baseUrl
            return when {
                b.startsWith("https://", ignoreCase = true) ->
                    "wss://" + b.substringAfter("://")
                b.startsWith("http://", ignoreCase = true) ->
                    "ws://" + b.substringAfter("://")
                else -> b
            }
        }

    fun save(host: String, port: Int, deviceName: String, result: PairingResult, serverUrl: String? = null) {
        val e = prefs.edit()
            .putString(KEY_HOST, host)
            .putInt(KEY_PORT, port)
            .putString(KEY_SERVER_URL, serverUrl ?: "")
            .putString(KEY_DEVICE_NAME, deviceName)
            .putString(KEY_DEVICE_TOKEN, result.deviceToken)
            .putString(KEY_DEVICE_ID, result.deviceId)
        if (result.pushKey.isNotBlank()) e.putString(KEY_PUSH_KEY, result.pushKey)
        e.apply()
    }

    /** Persists the chat bot-picker selection (null clears it). */
    fun saveSelectedBotId(id: String?) {
        val e = prefs.edit()
        if (id.isNullOrEmpty()) e.remove(KEY_SELECTED_BOT_ID) else e.putString(KEY_SELECTED_BOT_ID, id)
        e.apply()
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS_NAME = "kriyadot_pairing"
        private const val KEY_HOST = "host"
        private const val KEY_PORT = "port"
        private const val KEY_SERVER_URL = "server_url"
        private const val KEY_DEVICE_NAME = "device_name"
        private const val KEY_DEVICE_TOKEN = "device_token"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_PUSH_KEY = "push_key"
        private const val KEY_SELECTED_BOT_ID = "selected_bot_id"
    }
}
