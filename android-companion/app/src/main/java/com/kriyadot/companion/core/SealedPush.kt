// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import android.util.Base64
import org.json.JSONObject
import javax.crypto.Cipher
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * Decrypts sealed push payloads (Codync parity).
 *
 * The server seals {title, body} with AES-256-GCM under the per-device push
 * key established at pairing. FCM only ever carries the ciphertext; this
 * runs locally on the phone. Mirrors apps/api/src/push.ts sealPayload.
 */
object SealedPush {

    data class Content(val title: String, val body: String)

    /**
     * @param sealedB64 base64url of {"v":1,"nonce":"<b64>","ct":"<b64>"}
     * @param pushKeyB64 base64 of the 32-byte device push key
     * @return decrypted content, or null when the key is missing/invalid or
     *         the payload fails authentication (caller shows the fallback).
     */
    fun open(sealedB64: String?, pushKeyB64: String?): Content? {
        if (sealedB64.isNullOrBlank() || pushKeyB64.isNullOrBlank()) return null
        return try {
            val key = Base64.decode(pushKeyB64, Base64.DEFAULT)
            if (key.size != 32) return null
            val sealed = JSONObject(String(Base64.decode(sealedB64, Base64.URL_SAFE), Charsets.UTF_8))
            if (sealed.optInt("v", -1) != 1) return null
            val nonce = Base64.decode(sealed.getString("nonce"), Base64.DEFAULT)
            val raw = Base64.decode(sealed.getString("ct"), Base64.DEFAULT)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(
                Cipher.DECRYPT_MODE,
                SecretKeySpec(key, "AES"),
                GCMParameterSpec(128, nonce),
            )
            val plain = String(cipher.doFinal(raw), Charsets.UTF_8)
            val o = JSONObject(plain)
            Content(
                title = o.optString("title").take(80),
                body = o.optString("body").take(400),
            ).takeIf { it.title.isNotBlank() || it.body.isNotBlank() }
        } catch (_: Exception) {
            null
        }
    }
}
