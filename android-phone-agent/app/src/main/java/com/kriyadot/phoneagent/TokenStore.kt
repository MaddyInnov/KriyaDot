// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/** Encrypted storage for the 256-bit pairing token (never in plain prefs). */
object TokenStore {
    private const val FILE = "kriyadot_secure"
    private const val KEY_TOKEN = "pairing_token"

    private fun prefs(ctx: Context) =
        EncryptedSharedPreferences.create(
            ctx.applicationContext,
            FILE,
            MasterKey.Builder(ctx.applicationContext)
                .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
                .build(),
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )

    fun saveToken(ctx: Context, token: String) {
        prefs(ctx).edit().putString(KEY_TOKEN, token).apply()
    }

    fun getToken(ctx: Context): String? =
        prefs(ctx).getString(KEY_TOKEN, null)

    fun clear(ctx: Context) {
        prefs(ctx).edit().remove(KEY_TOKEN).apply()
    }
}
