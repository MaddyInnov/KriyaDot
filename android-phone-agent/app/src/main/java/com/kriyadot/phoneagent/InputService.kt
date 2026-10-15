// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.graphics.Path
import android.os.Bundle
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
