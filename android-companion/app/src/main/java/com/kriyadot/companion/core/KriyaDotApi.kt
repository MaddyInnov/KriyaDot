// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resumeWithException

/**
 * REST client for the KriyaDot companion API (phone -> PC direction).
 *
 * Contract (server workstream, MVP):
 *   POST /api/companion/pairing/exchange {ott, deviceName} -> {ok, deviceToken, deviceId}
 *   GET  /api/companion/status        -> health + active runs summary + pending approvals count
 *   GET  /api/companion/approvals     -> pending approvals
 *   POST /api/companion/approvals/:id/approve | /deny {note?}
 *   POST /api/companion/runs/:id/pause | /resume | /cancel
 *   GET  /api/companion/activity      -> activity feed
 *   GET  /api/companion/briefing      -> latest digest
 *   POST /api/companion/chat/send | /api/chat     -> chat turn (SSE stream; mirrored from apps/api)
 *
 * All calls except the pairing exchange carry
 * `Authorization: Bearer <deviceToken>`.
 */
class KriyaDotApi(
    private val store: PairingStore,
    client: OkHttpClient? = null,
) {
    private val http: OkHttpClient = client ?: OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(30, TimeUnit.SECONDS)
        .build()

    // ---- Pairing ------------------------------------------------------------

    /** One-time exchange: QR ott -> long-lived device token. Stores nothing.
     *  baseUrl is the http(s) server root (LAN "http://host:port" or a hosted
     *  https URL from the QR payload). */
    suspend fun exchangePairing(baseUrl: String, ott: String, deviceName: String): PairingResult {
        val body = JSONObject()
            .put("ott", ott)
            .put("deviceName", deviceName)
            .toString()
            .toRequestBody(JSON_MEDIA)
        val req = Request.Builder()
            .url("$baseUrl/api/companion/pairing/exchange")
            .post(body)
            .build()
        val json = awaitJson(req)
        if (!json.optBoolean("ok", false)) {
            throw IOException(json.optString("error", "Pairing exchange failed"))
        }
        val token = json.optString("deviceToken").ifEmpty { json.optString("token") }
        if (token.isEmpty()) throw IOException("Server did not return a device token")
        return PairingResult(
            deviceToken = token,
            deviceId = json.optString("deviceId", ""),
        )
    }

    // ---- Authed helpers -----------------------------------------------------

    private fun authed(path: String): Request.Builder =
        Request.Builder()
            .url(store.baseUrl + path)
            .header("Authorization", "Bearer ${store.deviceToken}")

    private suspend fun awaitJson(request: Request): JSONObject {
        val res = await(request)
        res.use {
            val text = it.body?.string().orEmpty()
            if (!it.isSuccessful) {
                val detail = runCatching { JSONObject(text).optString("error") }.getOrNull().orEmpty()
                throw IOException("HTTP ${it.code}${if (detail.isNotEmpty()) ": $detail" else ""}")
            }
            return JSONObject(text.ifEmpty { "{}" })
        }
    }

    private suspend fun await(request: Request): Response =
        suspendCancellableCoroutine { cont ->
            val call = http.newCall(request)
            cont.invokeOnCancellation { call.cancel() }
            call.enqueue(object : Callback {
                override fun onFailure(call: Call, e: IOException) {
                    if (!cont.isCompleted) cont.resumeWithException(e)
                }

                override fun onResponse(call: Call, response: Response) {
                    if (!cont.isCompleted) cont.resume(response, null)
                }
            })
        }

    private suspend fun post(path: String, body: JSONObject? = null): JSONObject {
        val reqBody = (body?.toString() ?: "{}").toRequestBody(JSON_MEDIA)
        return awaitJson(authed(path).post(reqBody).build())
    }

    // ---- Status / approvals / runs / activity / briefing -------------------

    suspend fun getStatus(): ServerStatus =
        ServerStatus.fromJson(awaitJson(authed("/api/companion/status").get().build()))

    suspend fun getApprovals(): List<Approval> =
        Approval.listFromJson(awaitJson(authed("/api/companion/approvals").get().build()))

    suspend fun getRuns(): List<RunSummary> =
        RunSummary.listFromJson(awaitJson(authed("/api/companion/runs").get().build()))

    suspend fun approve(id: String, note: String?): JSONObject =
        post("/api/companion/approvals/$id/approve", noteBody(note))

    suspend fun deny(id: String, note: String?): JSONObject =
        post("/api/companion/approvals/$id/deny", noteBody(note))

    private fun noteBody(note: String?): JSONObject =
        JSONObject().apply { if (!note.isNullOrBlank()) put("note", note) }

    suspend fun pauseRun(id: String): JSONObject = post("/api/companion/runs/$id/pause")
    suspend fun resumeRun(id: String): JSONObject = post("/api/companion/runs/$id/resume")
    suspend fun cancelRun(id: String): JSONObject = post("/api/companion/runs/$id/cancel")

    suspend fun getActivity(): List<ActivityItem> =
        ActivityItem.listFromJson(awaitJson(authed("/api/companion/activity").get().build()))

    suspend fun getBriefing(): Briefing =
        Briefing.fromJson(awaitJson(authed("/api/companion/briefing").get().build()))

    // ---- Chat (mirrors the web app's POST /chat) ----------------------------

    /**
     * Sends one chat turn and streams the SSE events back as a Flow.
     *
     * Mirrors apps/api POST /api/chat: body {botId, message, sessionId, queueMode},
     * response is `text/event-stream` with `data: {"type":"token","content":...}`
     * events and a terminal `done`/`error`/`interrupted` event; `: ping`
     * heartbeats are skipped. A non-SSE JSON reply (queueMode=queue while a
     * turn is in flight) surfaces as [ChatEvent.Queued].
     *
     * TODO(chat): DEFAULT_BOT_ID is a placeholder. The web UI picks the bot
     * per workspace but no default bot id was discoverable in the web app
     * sources; wire this to a bot picker (GET /api/bots) or a settings field
     * once the server exposes a default.
     */
    fun streamChat(message: String): Flow<ChatEvent> = flow {
        val body = JSONObject()
            .put("botId", DEFAULT_BOT_ID)
            .put("message", message)
            .put("sessionId", store.deviceId.ifEmpty { "companion" })
            .put("queueMode", "queue")
            .toString()
            .toRequestBody(JSON_MEDIA)
        val req = authed("/api/chat").post(body).build()
        val res = await(req)
        res.use {
            if (!it.isSuccessful) {
                val detail = runCatching {
                    JSONObject(it.body?.string().orEmpty()).optString("error")
                }.getOrNull().orEmpty()
                emit(ChatEvent.Error("HTTP ${it.code}${if (detail.isNotEmpty()) ": $detail" else ""}"))
                return@flow
            }
            val contentType = it.header("Content-Type").orEmpty()
            val raw = it.body?.string().orEmpty()
            if (!contentType.contains("text/event-stream")) {
                // JSON reply (e.g. {ok:true, queued:true, position:N}).
                val json = runCatching { JSONObject(raw) }.getOrNull()
                if (json != null && json.optBoolean("queued", false)) {
                    emit(ChatEvent.Queued(json.optInt("position", 0)))
                } else {
                    emit(ChatEvent.Error("Unexpected chat response"))
                }
                return@flow
            }
            val full = StringBuilder()
            for (line in raw.lineSequence()) {
                val t = line.trim()
                if (t.startsWith(":")) continue // heartbeat comment
                if (!t.startsWith("data:")) continue
                val payload = t.removePrefix("data:").trim()
                if (payload == "[DONE]") break
                val ev = runCatching { JSONObject(payload) }.getOrNull() ?: continue
                when (ev.optString("type")) {
                    "token" -> {
                        val c = ev.optString("content")
                        full.append(c)
                        emit(ChatEvent.Token(c))
                    }
                    "done" -> {
                        emit(ChatEvent.Done(full.toString()))
                        return@flow
                    }
                    "interrupted" -> {
                        emit(ChatEvent.Done(full.toString()))
                        return@flow
                    }
                    "error" -> {
                        emit(ChatEvent.Error(ev.optString("message", ev.optString("error", "Chat failed"))))
                        return@flow
                    }
                }
            }
            emit(ChatEvent.Done(full.toString()))
        }
    }.flowOn(Dispatchers.IO)

    companion object {
        private val JSON_MEDIA = "application/json; charset=utf-8".toMediaType()

        // TODO(chat): replace with a real default bot id (see streamChat docs).
        const val DEFAULT_BOT_ID = "default"
    }
}
