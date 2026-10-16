// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import org.json.JSONObject

/**
 * Lenient model parsing for the companion contract.
 *
 * The server workstream is being built in parallel, so every field here is
 * read with opt* accessors: unknown or missing fields degrade to defaults
 * instead of crashing the app. Tighten these once the server contract is
 * frozen.
 */

/**
 * Parsed from the pairing QR payload. Two flavors:
 * - LAN:    kriyadot://pair?host=<lan-ip>&port=<port>&token=<ott>
 * - Hosted: kriyadot://pair?url=https://kriyadot.example.com&token=<ott>
 *           (server has KRIYADOT_PUBLIC_URL set; phone connects over the internet)
 */
data class PairingPayload(
    val host: String,
    val port: Int,
    val ott: String,
    val serverUrl: String? = null,
) {
    val isHosted: Boolean get() = !serverUrl.isNullOrEmpty()

    /** Human label for confirm dialogs and the connection indicator. */
    val serverLabel: String get() = serverUrl ?: "$host:$port"

    /** http(s) base URL for REST calls. */
    val baseUrl: String get() = serverUrl ?: "http://$host:$port"
}

data class PairingResult(
    val deviceToken: String,
    val deviceId: String,
    /** base64 AES-256 key for sealed pushes; empty when the server predates push keys. */
    val pushKey: String = "",
)

data class ServerStatus(
    val healthy: Boolean,
    val serverName: String,
    val version: String,
    val activeRuns: Int,
    val pendingApprovals: Int,
) {
    companion object {
        fun fromJson(o: JSONObject): ServerStatus {
            val runs = o.optJSONArray("runs") ?: o.optJSONArray("activeRuns")
            return ServerStatus(
                healthy = o.optBoolean("ok", true) && o.optBoolean("healthy", true),
                serverName = o.optJSONObject("server")?.optString("name", "KriyaDot")
                    ?: o.optString("serverName", "KriyaDot"),
                version = o.optJSONObject("server")?.optString("version", "")
                    ?: o.optString("version", ""),
                activeRuns = runs?.length()
                    ?: o.optInt("activeRuns", o.optInt("runCount", 0)),
                pendingApprovals = o.optInt("pendingApprovals", o.optInt("pendingApprovalCount", 0)),
            )
        }
    }
}

data class Approval(
    val id: String,
    val title: String,
    val detail: String,
    val sessionId: String,
    val createdAt: String,
) {
    companion object {
        fun listFromJson(o: JSONObject): List<Approval> {
            val arr = o.optJSONArray("approvals") ?: o.optJSONArray("items") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { i ->
                val a = arr.optJSONObject(i) ?: return@mapNotNull null
                Approval(
                    id = a.optString("id"),
                    title = a.optString("title", a.optString("kind", "Approval requested")),
                    detail = a.optString("detail", a.optString("description", a.optString("prompt", ""))),
                    sessionId = a.optString("sessionId", ""),
                    createdAt = a.optString("createdAt", a.optString("ts", "")),
                ).takeIf { it.id.isNotEmpty() }
            }
        }
    }
}

data class RunSummary(
    val id: String,
    val label: String,
    val state: String, // running | paused | queued | ...
    val detail: String,
) {
    companion object {
        fun listFromJson(o: JSONObject): List<RunSummary> {
            val arr = o.optJSONArray("runs") ?: o.optJSONArray("items") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { i ->
                val r = arr.optJSONObject(i) ?: return@mapNotNull null
                RunSummary(
                    id = r.optString("id"),
                    label = r.optString("label", r.optString("title", r.optString("botId", "Run"))),
                    state = r.optString("state", r.optString("status", "unknown")),
                    detail = r.optString("detail", r.optString("summary", "")),
                ).takeIf { it.id.isNotEmpty() }
            }
        }
    }
}

data class ActivityItem(
    val id: String,
    val text: String,
    val kind: String,
    val createdAt: String,
) {
    companion object {
        fun listFromJson(o: JSONObject): List<ActivityItem> {
            val arr = o.optJSONArray("activity") ?: o.optJSONArray("items") ?: return emptyList()
            return (0 until arr.length()).mapNotNull { i ->
                val a = arr.optJSONObject(i) ?: return@mapNotNull null
                ActivityItem(
                    id = a.optString("id", "$i"),
                    text = a.optString("text", a.optString("message", a.optString("summary", ""))),
                    kind = a.optString("kind", a.optString("type", "")),
                    createdAt = a.optString("createdAt", a.optString("ts", "")),
                ).takeIf { it.text.isNotEmpty() }
            }
        }
    }
}

data class Briefing(
    val title: String,
    val body: String,
    val generatedAt: String,
) {
    companion object {
        fun fromJson(o: JSONObject): Briefing = Briefing(
            title = o.optString("title", "Daily briefing"),
            body = o.optString("body", o.optString("text", o.optString("summary", ""))),
            generatedAt = o.optString("generatedAt", o.optString("ts", "")),
        )
    }
}

/** One chat message in the conversation view. */
data class ChatMessage(
    val id: Long,
    val role: String, // "user" | "assistant" | "system"
    val text: String,
)

/** Streaming events from POST /chat (SSE). */
sealed interface ChatEvent {
    data class Token(val text: String) : ChatEvent
    data class Done(val fullText: String) : ChatEvent
    /** Server queued the message because a turn is already in flight. */
    data class Queued(val position: Int) : ChatEvent
    data class Error(val message: String) : ChatEvent
}
