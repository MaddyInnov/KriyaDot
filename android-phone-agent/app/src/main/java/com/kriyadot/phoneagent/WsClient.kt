// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * WebSocket client for the KriyaDot phone protocol (see phone-PROTOCOL.md).
 *
 * Lifecycle: connect() → send {t:'hello', deviceId, token} → on 'ok', the
 * server accepts frames. Inbound {t:'tap'|'swipe'|'text'|'key'} messages are
 * dispatched to [onCommand]. Reconnects with backoff while [wantConnected].
 */
class WsClient(
    private val serverUrl: String,
    private val deviceId: String,
    private val token: String,
    private val scope: CoroutineScope,
) {
    var onCommand: ((JSONObject) -> Unit)? = null
    var onStatus: ((connected: Boolean, detail: String) -> Unit)? = null

    private val client = OkHttpClient.Builder()
        .pingInterval(20, TimeUnit.SECONDS)
        .build()
    private var ws: WebSocket? = null
    @Volatile var wantConnected = false
        private set
    @Volatile private var authed = false

    fun connect() {
        wantConnected = true
        doConnect()
    }

    fun disconnect() {
        wantConnected = false
        authed = false
        try { ws?.close(1000, "client stop") } catch (_: Exception) { }
        ws = null
    }

    private fun doConnect() {
        if (!wantConnected) return
        val url = serverUrl.trimEnd('/') + "/api/phone/ws"
        val req = Request.Builder().url(url).build()
        ws = client.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                val hello = JSONObject()
                    .put("t", "hello")
                    .put("deviceId", deviceId)
                    .put("token", token)
                webSocket.send(hello.toString())
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val msg = try { JSONObject(text) } catch (_: Exception) { return }
                when (msg.optString("t")) {
                    "ok" -> {
                        authed = true
                        onStatus?.invoke(true, "connected")
                    }
                    "error" -> {
                        onStatus?.invoke(false, "server: ${msg.optString("detail")}")
                        if (msg.optString("detail") == "auth_failed") {
                            // Bad token: stop retrying, the user must re-pair.
                            wantConnected = false
                            webSocket.close(4401, "auth failed")
                        }
                    }
                    "tap", "swipe", "text", "key" -> {
                        if (authed) onCommand?.invoke(msg)
                    }
                }
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                authed = false
                onStatus?.invoke(false, t.message ?: "connection failed")
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                authed = false
                if (code != 4401) {
                    onStatus?.invoke(false, "closed: $reason")
                    scheduleReconnect()
                }
            }
        })
    }

    private var backoffMs = 1000L
    private fun scheduleReconnect() {
        if (!wantConnected) return
        val delay = backoffMs
        backoffMs = minOf(backoffMs * 2, 30_000L)
        scope.launch(Dispatchers.IO) {
            try { Thread.sleep(delay) } catch (_: InterruptedException) { return@launch }
            if (wantConnected) doConnect()
        }
    }

    /** Send one MJPEG frame. Drops the frame if the socket is busy (backpressure). */
    fun sendFrame(jpgBase64: String, w: Int, h: Int, ts: Long): Boolean {
        val s = ws ?: return false
        if (!authed) return false
        val frame = JSONObject()
            .put("t", "frame")
            .put("jpg", jpgBase64)
            .put("w", w)
            .put("h", h)
            .put("ts", ts)
        return try { s.send(frame.toString()) } catch (_: Exception) { false }
    }
}
