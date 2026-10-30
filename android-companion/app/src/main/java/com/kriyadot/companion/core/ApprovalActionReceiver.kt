// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.core

import android.app.NotificationManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * Handles the Allow / Deny action buttons on approval push notifications
 * (Muse parity P-2): tapping one in the notification shade decides the
 * approval through the companion's existing approval-decide path
 * (KriyaDotApi.approve / deny — POST /api/companion/approvals/:id/approve
 * | /deny, the same endpoints the in-app Approvals screen uses) without
 * opening the app. The notification is dismissed once the decision call
 * has been made; a failed call leaves it in place so the user can retry
 * from the shade or decide in the app instead.
 *
 * Intents are explicit (this receiver is not exported and the
 * PendingIntents that target it are immutable), so no other app can
 * forge a decision.
 */
class ApprovalActionReceiver : BroadcastReceiver() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action != ACTION_DECIDE) return
        val approvalId = intent.getStringExtra(EXTRA_APPROVAL_ID)?.takeIf { it.isNotBlank() } ?: return
        val approve = intent.getBooleanExtra(EXTRA_APPROVE, false)
        val store = PairingStore(context)
        if (!store.isPaired) return

        val pending = goAsync()
        scope.launch {
            try {
                val api = KriyaDotApi(store)
                if (approve) api.approve(approvalId, null) else api.deny(approvalId, null)
                // Decided: clear the shade notification for this approval.
                val nm = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
                nm.cancel(KriyaDotMessagingService.approvalNotificationId(approvalId))
            } catch (_: Exception) {
                // Best-effort: the notification stays up and the approval
                // remains decidable from the Approvals screen.
            } finally {
                pending.finish()
            }
        }
    }

    companion object {
        const val ACTION_DECIDE = "com.kriyadot.companion.action.APPROVAL_DECIDE"
        const val EXTRA_APPROVAL_ID = "approval_id"
        const val EXTRA_APPROVE = "approve"
    }
}
