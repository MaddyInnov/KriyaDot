// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.util.Base64
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Live screen frame channel from the KriyaDot PC.
 *
 *   ws(s)://<host>:<port>/api/remote-screen/ws?sessionId=<id>&token=<deviceToken>
 *
 * Server messages (JSON text):
 *   {t:'ok', sessionId, mock}            — handshake accepted
 *   {t:'frame', png, w, h, ts, n, mock}  — one screen frame (base64 PNG/JPEG)
 *   {t:'error', detail}                  — capture_failed | not_approved | ...
 *   {t:'ended', reason}                  — session over (owner stopped, denied,
 *                                          30-min cap, capture unavailable)
 *
 * The channel is view-only: anything the client sends gets a
 * {t:'error', detail:'view_only'} reply and is ignored.
 *
 * Frames are decoded to Bitmap on OkHttp's dispatcher thread and delivered
 * via [Listener.onFrame]. Callers must hop to the main thread for UI work.
 */
class RemoteScreenSocket(
    private val store: PairingStore,
    client: OkHttpClient? = null,
) {
    interface Listener {
        fun onConnected(mock: Boolean)
        fun onFrame(bitmap: Bitmap, w: Int, h: Int, frameNo: Long)
        fun onServerError(detail: String)
        fun onEnded(reason: String)
        fun onConnectionLost(willRetry: Boolean)
    }

    private val http: OkHttpClient = client ?: OkHttpClient.Builder()
        .pingInterval(25, TimeUnit.SECONDS)
        .build()

    @Volatile private var ws: WebSocket? = null
    @Volatile private var closed = false
    private var listener: Listener? = null

    /** Open the frame channel for an approved session. */
    fun start(sessionId: String, listener: Listener) {
        stop()
        closed = false
        this.listener = listener
        val url = "${store.wsBaseUrl}/api/remote-screen/ws" +
            "?sessionId=${sessionId}" +
            "&token=${store.deviceToken}"
        val req = Request.Builder().url(url).build()
        ws = http.newWebSocket(req, object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // Wait for the {t:'ok'} message before reporting connected.
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                handleMessage(text)
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                if (!closed) listener.onConnectionLost(willRetry = false)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                if (!closed) listener.onConnectionLost(willRetry = false)
            }
        })
    }

    fun stop() {
        closed = true
        listener = null
        try {
            ws?.close(1000, "client stop")
        } catch (_: Exception) {
        }
        ws = null
    }

    private fun handleMessage(text: String) {
        val l = listener ?: return
        val o = try {
            JSONObject(text)
        } catch (_: Exception) {
            return
        }
        when (o.optString("t")) {
            "ok" -> l.onConnected(o.optBoolean("mock", false))
            "frame" -> {
                val bytes = try {
                    Base64.decode(o.optString("png", ""), Base64.DEFAULT)
                } catch (_: Exception) {
                    return
                }
                if (bytes.isEmpty()) return
                val bmp = BitmapFactory.decodeByteArray(bytes, 0, bytes.size) ?: return
                l.onFrame(bmp, o.optInt("w", bmp.width), o.optInt("h", bmp.height), o.optLong("n", 0))
            }
            "error" -> l.onServerError(o.optString("detail", "unknown"))
            "ended" -> {
                l.onEnded(o.optString("reason", "ended"))
                stop()
            }
        }
    }
}
