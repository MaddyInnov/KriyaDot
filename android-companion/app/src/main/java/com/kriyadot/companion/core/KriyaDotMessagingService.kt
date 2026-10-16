// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import androidx.core.app.NotificationCompat
import com.google.firebase.messaging.FirebaseMessagingService
import com.google.firebase.messaging.RemoteMessage
import com.kriyadot.companion.MainActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Receives FCM data messages for "done" / "needs you" / "failed" alerts
 * (Codync parity). The payload carries only ciphertext + routing fields;
 * title/body are decrypted locally with the pairing-established push key.
 * Falls back to the generic server-provided text when decryption is
 * impossible (no key, tampered payload).
 */
class KriyaDotMessagingService : FirebaseMessagingService() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onMessageReceived(message: RemoteMessage) {
        val data = message.data
        if (data.isEmpty()) return
        val store = PairingStore(this)
        if (!store.isPaired) return

        val kind = data["kind"] ?: "done"
        val sealed = data["sealed"]
        val content = SealedPush.open(sealed, store.pushKey)
        val title = content?.title ?: data["fallbackTitle"] ?: "KriyaDot"
        val body = content?.body ?: data["fallbackBody"] ?: "You have a new message."

        showNotification(
            kind = kind,
            title = title,
            body = body,
            botId = data["botId"],
            chatId = data["chatId"],
            approvalId = data["approvalId"],
        )
    }

    override fun onNewToken(token: String) {
        val store = PairingStore(this)
        if (!store.isPaired || !store.deviceId.isNotBlank()) return
        // Re-register the refreshed token with the server (best-effort).
        scope.launch {
            try {
                val url = URL("${store.baseUrl}/api/companion/devices/${store.deviceId}/fcm-token")
                val body = JSONObject().put("fcmToken", token).toString()
                val conn = (url.openConnection() as HttpURLConnection).apply {
                    requestMethod = "POST"
                    setRequestProperty("Authorization", "Bearer ${store.deviceToken}")
                    setRequestProperty("Content-Type", "application/json; charset=utf-8")
                    doOutput = true
                    connectTimeout = 10_000
                    readTimeout = 10_000
                }
                conn.outputStream.use { it.write(body.toByteArray(Charsets.UTF_8)) }
                conn.inputStream.use { it.readBytes() }
                conn.disconnect()
            } catch (_: Exception) {
                // Best-effort: the next app launch re-registers anyway.
            }
        }
    }

    private fun showNotification(
        kind: String,
        title: String,
        body: String,
        botId: String?,
        chatId: String?,
        approvalId: String?,
    ) {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        ensureChannel(nm, kind)

        val tap = Intent(this, MainActivity::class.java).apply {
            action = Intent.ACTION_MAIN
            addCategory(Intent.CATEGORY_LAUNCHER)
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
            putExtra(EXTRA_KIND, kind)
            botId?.let { putExtra(EXTRA_BOT_ID, it) }
            chatId?.let { putExtra(EXTRA_CHAT_ID, it) }
            approvalId?.let { putExtra(EXTRA_APPROVAL_ID, it) }
        }
        val pending = PendingIntent.getActivity(
            this,
            (kind + (approvalId ?: chatId ?: botId ?: "")).hashCode(),
            tap,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

        val notification = NotificationCompat.Builder(this, channelId(kind))
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setSmallIcon(android.R.drawable.ic_dialog_info)
            .setContentIntent(pending)
            .setAutoCancel(true)
            .setPriority(
                if (kind == "needsInput") NotificationCompat.PRIORITY_HIGH
                else NotificationCompat.PRIORITY_DEFAULT,
            )
            .build()
        nm.notify(notificationId(kind, approvalId ?: chatId ?: botId), notification)
    }

    private fun channelId(kind: String) =
        if (kind == "needsInput") CHANNEL_ALERTS_HIGH else CHANNEL_ALERTS

    private fun notificationId(kind: String, key: String?) =
        (kind + "|" + (key ?: "general")).hashCode()

    private fun ensureChannel(nm: NotificationManager, kind: String) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val id = channelId(kind)
        if (nm.getNotificationChannel(id) != null) return
        val (name, importance) = if (kind == "needsInput") {
            "KriyaDot — needs you" to NotificationManager.IMPORTANCE_HIGH
        } else {
            "KriyaDot alerts" to NotificationManager.IMPORTANCE_DEFAULT
        }
        nm.createNotificationChannel(NotificationChannel(id, name, importance))
    }

    companion object {
        const val CHANNEL_ALERTS = "kriyadot_alerts"
        const val CHANNEL_ALERTS_HIGH = "kriyadot_alerts_high"
        const val EXTRA_KIND = "push_kind"
        const val EXTRA_BOT_ID = "push_bot_id"
        const val EXTRA_CHAT_ID = "push_chat_id"
        const val EXTRA_APPROVAL_ID = "push_approval_id"
    }
}
