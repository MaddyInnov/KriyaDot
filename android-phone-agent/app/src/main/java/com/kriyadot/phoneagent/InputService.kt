// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.graphics.Rect
import android.net.Uri
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo
import org.json.JSONObject
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Executes input commands from the KriyaDot server via the accessibility API.
 *
 * The user must enable this service manually in Settings → Accessibility;
 * the app cannot enable it programmatically. Coordinates arrive normalized
 * (0..1) and are scaled to the real display size here.
 */
class InputService : AccessibilityService() {

    companion object {
        @Volatile private var instance: InputService? = null
        private val pending = ConcurrentLinkedQueue<JSONObject>()

        /** Called from ScreenCaptureService when a command arrives. */
        fun dispatchCommand(msg: JSONObject) {
            val svc = instance
            if (svc == null) {
                pending.offer(msg)
                return
            }
            svc.handleCommand(msg)
        }

        /**
         * W14: called from ScreenCaptureService when a server-dispatched
         * action ({type:'action', id, action, params}) arrives. Unlike
         * fire-and-forget input commands, actions report back exactly once
         * through [respond] so the server-side tool call can complete.
         * Actions are NOT queued when the service is disabled — the user
         * must enable accessibility first, and the caller needs to know.
         */
        fun dispatchAction(msg: JSONObject, respond: (id: String, ok: Boolean, error: String?) -> Unit) {
            val id = msg.optString("id", "")
            val svc = instance
            if (svc == null) {
                respond(id, false, "accessibility_not_enabled")
                return
            }
            svc.handleAction(msg, respond)
        }
    }

    override fun onServiceConnected() {
        instance = this
        while (true) {
            val msg = pending.poll() ?: break
            handleCommand(msg)
        }
    }

    override fun onUnbind(intent: android.content.Intent?): Boolean {
        instance = null
        return super.onUnbind(intent)
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {}
    override fun onInterrupt() {}

    private fun handleCommand(msg: JSONObject) {
        val metrics = resources.displayMetrics
        val w = metrics.widthPixels.toFloat()
        val h = metrics.heightPixels.toFloat()
        when (msg.optString("t")) {
            "tap" -> {
                val x = (msg.optDouble("x", -1.0)).toFloat()
                val y = (msg.optDouble("y", -1.0)).toFloat()
                if (x in 0f..1f && y in 0f..1f) tap(x * w, y * h)
            }
            "swipe" -> {
                val x1 = msg.optDouble("x1", -1.0).toFloat()
                val y1 = msg.optDouble("y1", -1.0).toFloat()
                val x2 = msg.optDouble("x2", -1.0).toFloat()
                val y2 = msg.optDouble("y2", -1.0).toFloat()
                val ms = msg.optInt("ms", 300).coerceIn(50, 5000).toLong()
                if (listOf(x1, y1, x2, y2).all { it in 0f..1f }) {
                    swipe(x1 * w, y1 * h, x2 * w, y2 * h, ms)
                }
            }
            "text" -> {
                val text = msg.optString("text", "").take(1024)
                if (text.isNotEmpty()) typeText(text)
            }
            "key" -> when (msg.optString("key")) {
                "back" -> performGlobalAction(GLOBAL_ACTION_BACK)
                "home" -> performGlobalAction(GLOBAL_ACTION_HOME)
                // No direct "wake" global action; back+home cover the v1 keys.
                // Wake is approximated by turning the screen on via key event
                // fallback below if a device-specific path is added.
                "wake" -> performGlobalAction(GLOBAL_ACTION_HOME)
            }
        }
    }

    // ------------------------------------------------------------------
    // W14 phone-app actions
    // ------------------------------------------------------------------
    // Every action here was approved on the server (governance) before it
    // was dispatched. send_message types and sends EXACTLY the text from
    // the approved action params — nothing is composed on-device.

    private val mainHandler = Handler(Looper.getMainLooper())

    private fun handleAction(msg: JSONObject, respond: (id: String, ok: Boolean, error: String?) -> Unit) {
        val id = msg.optString("id", "")
        val action = msg.optString("action", "")
        val params = msg.optJSONObject("params") ?: JSONObject()
        when (action) {
            "open_app" -> {
                val pkg = params.optString("packageName", "")
                if (pkg.isEmpty()) {
                    respond(id, false, "missing_package_name")
                    return
                }
                val opened = openApp(pkg)
                respond(id, opened, if (opened) null else "app_not_found_or_not_launchable")
            }
            "tap" -> {
                val text = params.optString("text", "")
                if (text.isNotEmpty()) {
                    val hit = tapByText(text)
                    respond(id, hit, if (hit) null else "element_not_found")
                    return
                }
                val metrics = resources.displayMetrics
                val x = params.optDouble("x", -1.0).toFloat()
                val y = params.optDouble("y", -1.0).toFloat()
                if (x in 0f..1f && y in 0f..1f) {
                    tap(x * metrics.widthPixels.toFloat(), y * metrics.heightPixels.toFloat())
                    respond(id, true, null)
                } else {
                    respond(id, false, "bad_coordinates")
                }
            }
            "type" -> {
                val text = params.optString("text", "").take(1024)
                if (text.isEmpty()) {
                    respond(id, false, "missing_text")
                    return
                }
                val ok = typeTextReturning(text)
                respond(id, ok, if (ok) null else "no_focused_field")
            }
            "scroll" -> {
                val direction = params.optString("direction", "down")
                val amount = params.optDouble("amount", 0.6).toFloat().coerceIn(0.1f, 1f)
                scrollBy(direction, amount)
                respond(id, true, null)
            }
            "send_message" -> sendMessage(id, params, respond)
            "call" -> {
                val number = params.optString("number", "")
                if (number.isEmpty()) {
                    respond(id, false, "missing_number")
                    return
                }
                try {
                    val intent = Intent(Intent.ACTION_CALL, Uri.parse("tel:" + Uri.encode(number)))
                    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    startActivity(intent)
                    respond(id, true, null)
                } catch (e: SecurityException) {
                    respond(id, false, "call_permission_missing")
                } catch (e: Exception) {
                    respond(id, false, "call_failed")
                }
            }
            else -> respond(id, false, "unknown_action")
        }
    }

    /** Launch an app by package name. Returns false when not launchable. */
    private fun openApp(packageName: String): Boolean {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        return try {
            startActivity(intent)
            true
        } catch (e: Exception) {
            false
        }
    }

    /** Find a visible element by its text (or content description) and tap it. */
    private fun tapByText(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val matches = root.findAccessibilityNodeInfosByText(text)
        val node = matches?.firstOrNull() ?: findNodeByContentDescription(root, text) ?: return false
        var target: AccessibilityNodeInfo? = node
        while (target != null && !target.isClickable) {
            target = target.parent
        }
        if (target != null) {
            return target.performAction(AccessibilityNodeInfo.ACTION_CLICK)
        }
        val rect = Rect()
        node.getBoundsInScreen(rect)
        if (rect.width() <= 0 || rect.height() <= 0) return false
        tap(rect.centerX().toFloat(), rect.centerY().toFloat())
        return true
    }

    private fun findNodeByContentDescription(node: AccessibilityNodeInfo, text: String): AccessibilityNodeInfo? {
        val desc = node.contentDescription?.toString() ?: ""
        if (desc.equals(text, ignoreCase = true)) return node
        for (i in 0 until node.childCount) {
            val child = node.getChild(i) ?: continue
            val hit = findNodeByContentDescription(child, text)
            if (hit != null) return hit
        }
        return null
    }

    /** Type into the focused input field; false when nothing is focused. */
    private fun typeTextReturning(text: String): Boolean {
        val root = rootInActiveWindow ?: return false
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return false
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        return focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    private fun scrollBy(direction: String, amount: Float) {
        val metrics = resources.displayMetrics
        val w = metrics.widthPixels.toFloat()
        val h = metrics.heightPixels.toFloat()
        val cx = w / 2f
        val cy = h / 2f
        val dx = w * amount / 2f
        val dy = h * amount / 2f
        when (direction) {
            "up" -> swipe(cx, cy + dy, cx, cy - dy, 300)
            "left" -> swipe(cx + dx, cy, cx - dx, cy, 300)
            "right" -> swipe(cx - dx, cy, cx + dx, cy, 300)
            else -> swipe(cx, cy - dy, cx, cy + dy, 300) // "down"
        }
    }

    /**
     * Open the messaging app at the contact's conversation and send the
     * exact approved text. Steps are staged with delays because the app
     * UI loads asynchronously; the ack fires once the Send control has
     * been tapped, or with an error when a step cannot find its target.
     */
    private fun sendMessage(id: String, params: JSONObject, respond: (id: String, ok: Boolean, error: String?) -> Unit) {
        val packageName = params.optString("packageName", "")
        val contact = params.optString("contact", "")
        val text = params.optString("text", "").take(1024)
        if (packageName.isEmpty() || contact.isEmpty() || text.isEmpty()) {
            respond(id, false, "missing_send_message_params")
            return
        }
        if (!openApp(packageName)) {
            respond(id, false, "app_not_found_or_not_launchable")
            return
        }
        mainHandler.postDelayed({
            if (!tapByText(contact)) {
                respond(id, false, "conversation_not_found")
                return@postDelayed
            }
            mainHandler.postDelayed({
                if (!typeTextReturning(text)) {
                    respond(id, false, "no_message_field")
                    return@postDelayed
                }
                mainHandler.postDelayed({
                    val sent = tapByText("Send")
                    respond(id, sent, if (sent) null else "send_button_not_found")
                }, 600)
            }, 800)
        }, 1200)
    }

    private fun tap(x: Float, y: Float) {
        val path = Path().apply { moveTo(x, y) }
        val stroke = GestureDescription.StrokeDescription(path, 0, 50)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    private fun swipe(x1: Float, y1: Float, x2: Float, y2: Float, ms: Long) {
        val path = Path().apply {
            moveTo(x1, y1)
            lineTo(x2, y2)
        }
        val stroke = GestureDescription.StrokeDescription(path, 0, ms)
        dispatchGesture(GestureDescription.Builder().addStroke(stroke).build(), null, null)
    }

    private fun typeText(text: String) {
        val root = rootInActiveWindow ?: return
        val focused = root.findFocus(AccessibilityNodeInfo.FOCUS_INPUT) ?: return
        val args = Bundle().apply {
            putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, text)
        }
        focused.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }
}
