// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.app.Activity
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.PixelFormat
import android.hardware.display.DisplayManager
import android.hardware.display.VirtualDisplay
import android.media.ImageReader
import android.media.projection.MediaProjection
import android.media.projection.MediaProjectionManager
import android.os.Build
import android.os.Handler
import android.os.HandlerThread
import android.os.IBinder
import android.util.Base64
import android.util.DisplayMetrics
import android.view.WindowManager
import androidx.core.app.NotificationCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancel
import java.io.ByteArrayOutputStream

/**
 * Foreground service: MediaProjection → ImageReader → JPEG → WsClient.
 *
 * Started from MainActivity with the MediaProjection result (resultCode +
 * data from the system capture-consent dialog). A persistent notification is
 * always visible while sharing; killing the service stops the stream.
 */
class ScreenCaptureService : Service() {

    companion object {
        const val ACTION_START = "com.kriyadot.phoneagent.START_CAPTURE"
        const val ACTION_STOP = "com.kriyadot.phoneagent.STOP_CAPTURE"
        const val EXTRA_RESULT_CODE = "resultCode"
        const val EXTRA_DATA = "data"
        private const val CHANNEL_ID = "kriyadot_capture"
        private const val NOTIF_ID = 41
        private const val FRAME_INTERVAL_MS = 200L // ~5 fps, MJPEG v1
    }

    private var mediaProjection: MediaProjection? = null
    private var virtualDisplay: VirtualDisplay? = null
    private var imageReader: ImageReader? = null
    private var handlerThread: HandlerThread? = null
    private var wsClient: WsClient? = null
    private var frameThread: Thread? = null
    private val scope = CoroutineScope(Dispatchers.IO + Job())

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_STOP -> {
                stopCapture()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_START -> {
                val resultCode = intent.getIntExtra(EXTRA_RESULT_CODE, Activity.RESULT_CANCELED)
                val data: Intent? = if (Build.VERSION.SDK_INT >= 33) {
                    intent.getParcelableExtra(EXTRA_DATA, Intent::class.java)
                } else {
                    @Suppress("DEPRECATION")
                    intent.getParcelableExtra(EXTRA_DATA)
                }
                if (resultCode != Activity.RESULT_OK || data == null) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                startForeground(NOTIF_ID, buildNotification())
                startCapture(resultCode, data)
            }
        }
        return START_NOT_STICKY
    }

    private fun startCapture(resultCode: Int, data: Intent) {
        val prefs = getSharedPreferences(MainActivity.PREFS, Context.MODE_PRIVATE)
        val serverUrl = prefs.getString(MainActivity.KEY_SERVER_URL, "") ?: ""
        val deviceId = prefs.getString(MainActivity.KEY_DEVICE_ID, "") ?: ""
        val token = TokenStore.getToken(this) ?: ""
        if (serverUrl.isEmpty() || deviceId.isEmpty() || token.isEmpty()) {
            stopSelf(); return
        }

        val mpManager = getSystemService(Context.MEDIA_PROJECTION_SERVICE) as MediaProjectionManager
        mediaProjection = mpManager.getMediaProjection(resultCode, data)

        val wm = getSystemService(Context.WINDOW_SERVICE) as WindowManager
        val metrics = DisplayMetrics()
        @Suppress("DEPRECATION")
        wm.defaultDisplay.getRealMetrics(metrics)
        val width = metrics.widthPixels
        val height = metrics.heightPixels
        val density = metrics.densityDpi

        handlerThread = HandlerThread("kriyadot-frames").also { it.start() }
        val handler = Handler(handlerThread!!.looper)
        imageReader = ImageReader.newInstance(width, height, PixelFormat.RGBA_8888, 2)
        virtualDisplay = mediaProjection!!.createVirtualDisplay(
            "kriyadot", width, height, density,
            DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR,
            imageReader!!.surface, null, handler,
        )

        val client = WsClient(serverUrl, deviceId, token, scope)
        wsClient = client
        client.onStatus = { connected, detail ->
            MainActivity.postStatus(this, connected, detail)
        }
        client.onCommand = { msg ->
            // InputService is a separate component; route via a static hook.
            InputService.dispatchCommand(msg)
        }
        client.connect()

        // Frame pump: grab latest image, JPEG-encode, send.
        frameThread = Thread {
            var lastSent = 0L
            while (!Thread.currentThread().isInterrupted) {
                try { Thread.sleep(FRAME_INTERVAL_MS) } catch (_: InterruptedException) { break }
                val reader = imageReader ?: break
                val image = try { reader.acquireLatestImage() } catch (_: Exception) { null } ?: continue
                try {
                    val now = System.currentTimeMillis()
                    if (now - lastSent < FRAME_INTERVAL_MS) continue
                    lastSent = now
                    val plane = image.planes[0]
                    val buffer = plane.buffer
                    val pixelStride = plane.pixelStride
                    val rowStride = plane.rowStride
                    val rowPadding = rowStride - pixelStride * width
                    val bmp = Bitmap.createBitmap(
                        width + rowPadding / pixelStride, height, Bitmap.Config.ARGB_8888
                    )
                    bmp.copyPixelsFromBuffer(buffer)
                    val cropped = Bitmap.createBitmap(bmp, 0, 0, width, height)
                    bmp.recycle()
                    val out = ByteArrayOutputStream()
                    cropped.compress(Bitmap.CompressFormat.JPEG, 60, out)
                    cropped.recycle()
                    val b64 = Base64.encodeToString(out.toByteArray(), Base64.NO_WRAP)
                    client.sendFrame(b64, width, height, now)
                } catch (_: Exception) {
                    // drop frame, keep pumping
                } finally {
                    image.close()
                }
            }
        }.also { it.isDaemon = true; it.start() }
    }

    private fun stopCapture() {
        try { frameThread?.interrupt() } catch (_: Exception) { }
        try { wsClient?.disconnect() } catch (_: Exception) { }
        try { virtualDisplay?.release() } catch (_: Exception) { }
        try { imageReader?.close() } catch (_: Exception) { }
        try { mediaProjection?.stop() } catch (_: Exception) { }
        try { handlerThread?.quitSafely() } catch (_: Exception) { }
        scope.cancel()
        MainActivity.postStatus(this, false, "stopped")
    }

    private fun buildNotification(): Notification {
        val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= 26) {
            nm.createNotificationChannel(
                NotificationChannel(CHANNEL_ID, "Screen sharing", NotificationManager.IMPORTANCE_LOW)
            )
        }
        val stopIntent = Intent(this, ScreenCaptureService::class.java).setAction(ACTION_STOP)
        val stopPi = PendingIntent.getService(
            this, 0, stopIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        val openIntent = Intent(this, MainActivity::class.java)
        val openPi = PendingIntent.getActivity(
            this, 0, openIntent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle("KriyaDot Phone Agent")
            .setContentText("Sharing your screen with KriyaDot — tap to manage")
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentIntent(openPi)
            .addAction(android.R.drawable.ic_menu_close_clear_cancel, "Stop", stopPi)
            .setOngoing(true)
            .build()
    }

    override fun onDestroy() {
        stopCapture()
        super.onDestroy()
    }
}
