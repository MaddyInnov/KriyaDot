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
    }

    private val http: OkHttpClient = client ?: OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    @Volatile private var running = false
    @Volatile private var ws: WebSocket? = null
    @Volatile private var attempts = 0
    private var listener: Listener? = null
    private val lock = Any()

    fun start(listener: Listener) {
        synchronized(lock) {
            if (running) return
            running = true
            this.listener = listener
            attempts = 0
        }
        connect()
    }

    fun stop() {
        synchronized(lock) {
            running = false
            listener = null
        }
        ws?.close(1000, "stopping")
        ws = null
    }

    private fun connect() {
        if (!running) return
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
                listener?.onEvent(type, json)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                scheduleReconnect()
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                // Server-initiated close: reconnect unless we stopped.
                scheduleReconnect()
            }
        })
    }

    private fun scheduleReconnect() {
        if (!running) return
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
