// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/**
 * Pairing UI + sharing controls.
 *
 * Pairing flow (explicit on-phone acceptance):
 *  1. The user reads the 6-digit code from the KriyaDot web UI and types it here.
 *  2. The app shows the code back and asks for explicit confirmation
 *     ("Accept pairing with this KriyaDot server?").
 *  3. Only after the user taps Accept does the app POST /api/phone/pair/confirm.
 *  4. The returned {deviceId, token} is stored encrypted; the token is shown once.
 */
class MainActivity : AppCompatActivity() {

    companion object {
        const val PREFS = "kriyadot_phone_agent"
        const val KEY_SERVER_URL = "server_url"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_DEVICE_NAME = "device_name"

        private const val CAPTURE_REQUEST = 1001

        private var statusView: TextView? = null

        /** Called from the capture service to reflect connection state. */
        fun postStatus(ctx: Context, connected: Boolean, detail: String) {
            (ctx as? Activity)?.runOnUiThread {
                statusView?.text = if (connected) "Connected" else "Disconnected: $detail"
            }
        }
    }

    private lateinit var serverUrlInput: EditText
    private lateinit var codeInput: EditText
    private lateinit var statusText: TextView
    private lateinit var shareButton: Button
    private val http = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .build()
    private val scope = CoroutineScope(Dispatchers.Main)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(48, 48, 48, 48)
        }
        val title = TextView(this).apply { text = "KriyaDot Phone Agent"; textSize = 22f }
        serverUrlInput = EditText(this).apply {
            hint = "Server URL (e.g. http://192.168.1.10:4567)"
            setText(prefs.getString(KEY_SERVER_URL, ""))
        }
        codeInput = EditText(this).apply { hint = "6-digit pairing code from the web UI" }
        val pairButton = Button(this).apply { text = "Pair with code…" }
        statusText = TextView(this).apply { text = pairStatusText() }
        statusView = statusText
        shareButton = Button(this).apply { text = "Start sharing screen" }
        val stopButton = Button(this).apply { text = "Stop sharing" }
        val accessButton = Button(this).apply { text = "Open Accessibility settings (for input)" }
        val unpairButton = Button(this).apply { text = "Unpair this phone" }

        layout.addView(title)
        layout.addView(serverUrlInput)
        layout.addView(codeInput)
        layout.addView(pairButton)
        layout.addView(statusText)
        layout.addView(shareButton)
        layout.addView(stopButton)
        layout.addView(accessButton)
        layout.addView(unpairButton)
        setContentView(layout)

        pairButton.setOnClickListener { onPairClicked() }
        shareButton.setOnClickListener { onStartSharing() }
        stopButton.setOnClickListener { onStopSharing() }
        accessButton.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
        }
        unpairButton.setOnClickListener { onUnpairClicked() }
    }

    override fun onDestroy() {
        statusView = null
        super.onDestroy()
    }

    private fun pairStatusText(): String {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        val id = prefs.getString(KEY_DEVICE_ID, null)
        return if (id != null) "Paired as ${prefs.getString(KEY_DEVICE_NAME, id)}" else "Not paired"
    }

    private fun serverBase(): String {
        val raw = serverUrlInput.text.toString().trim().trimEnd('/')
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().putString(KEY_SERVER_URL, raw).apply()
        return raw
    }

    private fun onPairClicked() {
        val code = codeInput.text.toString().trim()
        if (!Regex("^\\d{6}$").matches(code)) {
            toast("Enter the 6-digit code from the web UI")
            return
        }
        val base = serverBase()
        if (base.isEmpty()) {
            toast("Enter the server URL first")
            return
        }
        // Explicit on-phone acceptance BEFORE any network call.
        AlertDialog.Builder(this)
            .setTitle("Accept pairing?")
            .setMessage(
                "Pair this phone with the KriyaDot server at\n$base\n\n" +
                    "Code: $code\n\n" +
                    "Only accept if YOU generated this code in your KriyaDot web UI. " +
                    "Pairing lets the server view your screen and send input."
            )
            .setPositiveButton("Accept") { _, _ -> confirmPairing(base, code) }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun confirmPairing(base: String, code: String) {
        scope.launch {
            try {
                val body = JSONObject()
                    .put("code", code)
                    .put("deviceName", "${Build.MANUFACTURER} ${Build.MODEL}")
                    .put("platform", "android")
                    .toString()
                    .toRequestBody("application/json".toMediaType())
                val req = Request.Builder()
                    .url("$base/api/phone/pair/confirm")
                    .post(body)
                    .build()
                val resp = withContext(Dispatchers.IO) { http.newCall(req).execute() }
                val json = JSONObject(resp.body?.string() ?: "{}")
                resp.close()
                if (!resp.isSuccessful || !json.optBoolean("ok")) {
                    toast("Pairing failed: ${json.optString("error", resp.code.toString())}")
                    return@launch
                }
                val deviceId = json.getString("deviceId")
                val token = json.getString("token")
                TokenStore.saveToken(this@MainActivity, token)
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .putString(KEY_DEVICE_ID, deviceId)
                    .putString(KEY_DEVICE_NAME, "${Build.MANUFACTURER} ${Build.MODEL}")
                    .apply()
                statusText.text = pairStatusText()
                codeInput.text.clear()
                toast("Paired. You can now start sharing.")
            } catch (e: Exception) {
                toast("Pairing failed: ${e.message}")
            }
        }
    }

    private fun onStartSharing() {
        val prefs = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        if (prefs.getString(KEY_DEVICE_ID, null) == null || TokenStore.getToken(this) == null) {
            toast("Pair the phone first")
            return
        }
        val mpManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        @Suppress("DEPRECATION")
        startActivityForResult(mpManager.createScreenCaptureIntent(), CAPTURE_REQUEST)
    }

    @Deprecated("legacy onActivityResult for the capture consent dialog")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode == CAPTURE_REQUEST) {
            if (resultCode == Activity.RESULT_OK && data != null) {
                val svc = Intent(this, ScreenCaptureService::class.java)
                    .setAction(ScreenCaptureService.ACTION_START)
                    .putExtra(ScreenCaptureService.EXTRA_RESULT_CODE, resultCode)
                    .putExtra(ScreenCaptureService.EXTRA_DATA, data)
                if (Build.VERSION.SDK_INT >= 29) {
                    startForegroundService(svc)
                } else {
                    startService(svc)
                }
                statusText.text = "Sharing…"
            } else {
                toast("Screen capture was not allowed")
            }
        }
    }

    private fun onStopSharing() {
        startService(
            Intent(this, ScreenCaptureService::class.java).setAction(ScreenCaptureService.ACTION_STOP)
        )
        statusText.text = pairStatusText()
    }

    private fun onUnpairClicked() {
        AlertDialog.Builder(this)
            .setTitle("Unpair this phone?")
            .setMessage("The server will forget this device and its token. You can pair again later.")
            .setPositiveButton("Unpair") { _, _ ->
                onStopSharing()
                TokenStore.clear(this)
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                    .remove(KEY_DEVICE_ID).remove(KEY_DEVICE_NAME).apply()
                statusText.text = pairStatusText()
                toast("Unpaired")
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun toast(msg: String) {
        Toast.makeText(this, msg, Toast.LENGTH_LONG).show()
    }
}
