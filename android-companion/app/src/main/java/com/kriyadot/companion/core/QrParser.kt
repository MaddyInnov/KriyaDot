// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import android.net.Uri

/**
 * Parses the pairing QR payload shown by KriyaDot Workspace -> Devices.
 * Two flavors:
 * - LAN:    kriyadot://pair?host=<lan-ip>&port=<port>&token=<ott>
 * - Hosted: kriyadot://pair?url=https://kriyadot.example.com&token=<ott>
 *           (server has KRIYADOT_PUBLIC_URL set; the phone connects over the
 *           internet instead of the LAN)
 *
 * Returns null for anything that is not a well-formed pairing payload, so the
 * scanner UI can show "not a KriyaDot pairing code" instead of failing later.
 */
object QrParser {
    fun parse(raw: String?): PairingPayload? {
        if (raw.isNullOrBlank()) return null
        val uri = try {
            Uri.parse(raw.trim())
        } catch (_: Exception) {
            return null
        }
        if (uri.scheme != "kriyadot" || uri.host != "pair") return null
        val ott = uri.getQueryParameter("token")?.trim().orEmpty()
        if (ott.isEmpty()) return null
        val url = uri.getQueryParameter("url")?.trim().orEmpty()
        if (url.isNotEmpty()) {
            val normalized = normalizeServerUrl(url) ?: return null
            return PairingPayload(host = "", port = 0, ott = ott, serverUrl = normalized)
        }
        val host = uri.getQueryParameter("host")?.trim().orEmpty()
        val port = uri.getQueryParameter("port")?.toIntOrNull() ?: return null
        if (host.isEmpty() || port !in 1..65535) return null
        return PairingPayload(host, port, ott)
    }

    /**
     * Normalizes a manually entered or QR-provided server URL:
     * trims whitespace/trailing slashes, requires an http(s) scheme and a
     * non-empty host. Returns null when the URL is not usable.
     */
    fun normalizeServerUrl(raw: String?): String? {
        if (raw.isNullOrBlank()) return null
        val v = raw.trim().trimEnd('/')
        if (v.isEmpty()) return null
        val lower = v.lowercase()
        val withScheme = when {
            lower.startsWith("http://") || lower.startsWith("https://") -> v
            else -> return null
        }
        val afterScheme = withScheme.substringAfter("://")
        if (afterScheme.isEmpty() || afterScheme.startsWith("/")) return null
        if (afterScheme.contains(" ") || afterScheme.contains("\t")) return null
        return withScheme
    }
}
