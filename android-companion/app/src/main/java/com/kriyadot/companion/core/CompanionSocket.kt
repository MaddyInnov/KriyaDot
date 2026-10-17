// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random

/**
 * Push channel for live updates from the KriyaDot instance:
 *   ws://<host>:<port>/api/companion/ws?token=<deviceToken>
 * pushing {type:'run-status'|'approval'|'activity', ...}.
 *
 * Auto-reconnects with exponential backoff + jitter (1s -> 60s cap) and
 * reports coarse lifecycle events so the UI can show "live / reconnecting".
 *
 * Auth failures are NOT retried (M9): when the server rejects the device
 * token (HTTP 401 on the handshake, a 4401 close, or an auth_failed
 * message), reconnecting forever would just hammer the server with a dead
 * credential — mirroring the phone-agent WsClient contract. Instead the
 * socket stops and exposes [requiresRePair] so the UI can prompt the user
 * to pair again.
 */
class CompanionSocket(
    private val store: PairingStore,
    client: OkHttpClient? = null,
) {
    interface Listener {
        /** A push event arrived; payload is the raw JSON object. */
        fun onEvent(type: String, payload: JSONObject)
        /** Connected (true) or (re)connecting (false). */
        fun onConnectionChanged(connected: Boolean)
        /**
         * The server rejected our device token. The socket has stopped
         * reconnecting; the UI should prompt the user to re-pair.
         * Default no-op so existing listeners keep compiling.
         */
        fun onRePairRequired() {}
    }

    private val http: OkHttpClient = client ?: OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    @Volatile private var running = false
    @Volatile private var ws: WebSocket? = null
    @Volatile private var attempts = 0
    /** Set once the server rejects our token: reconnects stop permanently. */
    @Volatile private var authFailed = false
    /**
     * True after an auth failure (M9). The UI observes this (via
     * [Listener.onRePairRequired]) to show the "re-pair required" state.
     * Cleared on the next [start].
     */
    @Volatile var requiresRePair: Boolean = false
        private set
    private var listener: Listener? = null
    private val lock = Any()

    fun start(listener: Listener) {
        synchronized(lock) {
            if (running) return
            running = true
            authFailed = false
            requiresRePair = false
            this.listener = listener
            attempts = 0
        }
        connect()
    }

    fun stop() {
        synchronized(lock) {
            running = false
            authFailed = false
            requiresRePair = false
            listener = null
        }
        ws?.close(1000, "stopping")
        ws = null
    }

    private fun connect() {
        if (!running || authFailed) return
        val url = "${store.wsBaseUrl}/api/companion/ws?token=${store.deviceToken}"
        val req = Request.Builder().url(url).build()
        listener?.onConnectionChanged(false)
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                attempts = 0
                listener?.onConnectionChanged(true)
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val json = runCatching { JSONObject(text) }.getOrNull() ?: return
                val type = json.optString("type").ifEmpty { return }
                // Liberal auth-failure detection (mirrors the phone-agent
                // WsClient): the query-param token normally fails the
                // handshake with HTTP 401, but an in-band auth_failed is
                // treated the same way.
                if (type == "error" && json.optString("detail") == "auth_failed") {
                    onAuthFailed()
                    return
                }
                listener?.onEvent(type, json)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                // HTTP 401 on the WebSocket handshake = bad/rotated token.
                if (response?.code == 401) {
                    onAuthFailed()
                    return
                }
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // 4401 = auth failed (phone-agent WsClient contract).
                if (code == 4401) {
                    onAuthFailed()
                    return
                }
                // Server-initiated close: reconnect unless we stopped.
                scheduleReconnect()
            }
        })
    }

    /**
     * Auth failure (M9): stop reconnecting permanently and surface the
     * re-pair state. Retrying a dead credential forever is the bug this
     * replaces.
     */
    private fun onAuthFailed() {
        synchronized(lock) {
            if (authFailed) return
            authFailed = true
            requiresRePair = true
        }
        try {
            ws?.close(4401, "auth failed")
        } catch (_: Exception) {
        }
        ws = null
        listener?.onConnectionChanged(false)
        listener?.onRePairRequired()
    }

    private fun scheduleReconnect() {
        if (!running || authFailed) return
        listener?.onConnectionChanged(false)
        val n = attempts++
        // 1s, 2s, 4s, ... capped at 60s, plus up to 500ms jitter.
        val delayMs = min(60_000L, (1L shl min(n, 10)) * 1000L) + Random.nextLong(500)
        Thread {
            try {
                Thread.sleep(delayMs)
            } catch (_: InterruptedException) {
                return@Thread
            }
            connect()
        }.apply { isDaemon = true }.start()
    }
}
