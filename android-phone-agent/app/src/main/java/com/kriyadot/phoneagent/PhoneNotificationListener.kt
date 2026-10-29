// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.app.Notification
import android.service.notification.NotificationListenerService
import android.service.notification.StatusBarNotification

/**
 * W14 notification triage: streams notification events to the KriyaDot
 * server over the same authenticated WebSocket as screen frames
 * (WsClient.shared), where the server-side triage sorts them into
 * "needs you" vs the daily-brief digest.
 *
 * Privacy: only the app package, the app label, the notification TITLE
 * (android.app.Notification.EXTRA_TITLE) and the post time are sent.
 * The notification body (EXTRA_TEXT / EXTRA_BIG_TEXT) is sensitive and
 * is deliberately never read here, so it can never leave the phone.
 *
 * The user must grant notification access manually in Settings →
 * Notifications → Device & app notifications; the app cannot grant it
 * itself. Until then this service simply never runs.
 */
class PhoneNotificationListener : NotificationListenerService() {

    override fun onNotificationPosted(sbn: StatusBarNotification?) {
        val notification = sbn?.notification ?: return
        val packageName = sbn.packageName ?: return
        // Our own foreground-service notification is not an event.
        if (packageName == applicationContext.packageName) return
        val title = notification.extras?.getCharSequence(Notification.EXTRA_TITLE)?.toString() ?: ""
        // NOTE: EXTRA_TEXT is intentionally not read — bodies stay on-device.
        val appName = try {
            val pm = applicationContext.packageManager
            val info = pm.getApplicationInfo(packageName, 0)
            pm.getApplicationLabel(info).toString()
        } catch (e: Exception) {
            null
        }
        WsClient.sendNotificationEvent(packageName, appName, title, sbn.postTime)
    }

    override fun onNotificationRemoved(sbn: StatusBarNotification?) {
        // Removals are not triage events; nothing is sent.
    }
}
