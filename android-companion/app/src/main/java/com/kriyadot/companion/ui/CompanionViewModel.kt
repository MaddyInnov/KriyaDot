// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.companion.ui

import android.app.Application
import android.graphics.Bitmap
import android.os.Handler
import android.os.Looper
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import com.kriyadot.companion.core.Approval
import com.kriyadot.companion.core.Bot
import com.kriyadot.companion.core.Briefing
import com.kriyadot.companion.core.ChatEvent
import com.kriyadot.companion.core.ChatMessage
import com.kriyadot.companion.core.CompanionSocket
import com.kriyadot.companion.core.PairingPayload
import com.kriyadot.companion.core.PairingStore
import com.kriyadot.companion.core.RemoteScreenSession
import com.kriyadot.companion.core.RemoteScreenSocket
import com.kriyadot.companion.core.RunSummary
import com.kriyadot.companion.core.ActivityItem
import com.kriyadot.companion.core.KriyaDotApi
import com.kriyadot.companion.core.ServerStatus
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import org.json.JSONObject

/**
 * Single source of truth for the companion app: pairing state, server data,
 * chat conversation, and the push socket.
 */
class CompanionViewModel(app: Application) : AndroidViewModel(app) {

    val store = PairingStore(app)
    private val api = KriyaDotApi(store)
    private val socket = CompanionSocket(store)

    private val _paired = MutableStateFlow(store.isPaired)
    val paired: StateFlow<Boolean> = _paired.asStateFlow()

    private val _pairingBusy = MutableStateFlow(false)
    val pairingBusy: StateFlow<Boolean> = _pairingBusy.asStateFlow()

    private val _pairingError = MutableStateFlow<String?>(null)
    val pairingError: StateFlow<String?> = _pairingError.asStateFlow()

    /** Scanned (or manually entered) payload awaiting user confirmation. */
    private val _pendingPairing = MutableStateFlow<PairingPayload?>(null)
    val pendingPairing: StateFlow<PairingPayload?> = _pendingPairing.asStateFlow()

    private val _status = MutableStateFlow<ServerStatus?>(null)
    val status: StateFlow<ServerStatus?> = _status.asStateFlow()

    private val _approvals = MutableStateFlow<List<Approval>>(emptyList())
    val approvals: StateFlow<List<Approval>> = _approvals.asStateFlow()

    private val _runs = MutableStateFlow<List<RunSummary>>(emptyList())
    val runs: StateFlow<List<RunSummary>> = _runs.asStateFlow()

    private val _activity = MutableStateFlow<List<ActivityItem>>(emptyList())
    val activity: StateFlow<List<ActivityItem>> = _activity.asStateFlow()

    private val _briefing = MutableStateFlow<Briefing?>(null)
    val briefing: StateFlow<Briefing?> = _briefing.asStateFlow()

    private val _loading = MutableStateFlow(false)
    val loading: StateFlow<Boolean> = _loading.asStateFlow()

    private val _socketLive = MutableStateFlow(false)
    val socketLive: StateFlow<Boolean> = _socketLive.asStateFlow()

    /**
     * True when the push socket stopped because the server rejected our
     * device token (M9). The UI shows a "re-pair required" prompt; cleared
     * on the next successful connect or unpair.
     */
    private val _rePairRequired = MutableStateFlow(false)
    val rePairRequired: StateFlow<Boolean> = _rePairRequired.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _messages = MutableStateFlow<List<ChatMessage>>(emptyList())
    val messages: StateFlow<List<ChatMessage>> = _messages.asStateFlow()

    private val _chatBusy = MutableStateFlow(false)
    val chatBusy: StateFlow<Boolean> = _chatBusy.asStateFlow()

    private var chatJob: Job? = null
    private var msgId = 0L

    private val _bots = MutableStateFlow<List<Bot>>(emptyList())
    val bots: StateFlow<List<Bot>> = _bots.asStateFlow()

    private val _selectedBotId = MutableStateFlow(store.selectedBotId)
    val selectedBotId: StateFlow<String?> = _selectedBotId.asStateFlow()

    private val _botsLoading = MutableStateFlow(false)
    val botsLoading: StateFlow<Boolean> = _botsLoading.asStateFlow()

    init {
        if (store.isPaired) startLive()
    }

    // ---- Pairing --------------------------------------------------------

    fun onQrScanned(payload: PairingPayload?) {
        _pendingPairing.value = payload
        _pairingError.value = if (payload == null) "That is not a KriyaDot pairing code." else null
    }

    fun clearPendingPairing() {
        _pendingPairing.value = null
        _pairingError.value = null
    }

    fun confirmPairing(deviceName: String) {
        val p = _pendingPairing.value ?: return
        _pairingBusy.value = true
        _pairingError.value = null
        viewModelScope.launch {
            try {
                val result = api.exchangePairing(p.baseUrl, p.ott, deviceName.ifBlank { "Android" })
                store.save(p.host, p.port, deviceName.ifBlank { "Android" }, result, p.serverUrl)
                _pendingPairing.value = null
                _paired.value = true
                startLive()
            } catch (e: Exception) {
                _pairingError.value = e.message ?: "Pairing failed"
            } finally {
                _pairingBusy.value = false
            }
        }
    }

    fun unpair() {
        socket.stop()
        store.clear()
        _paired.value = false
        _rePairRequired.value = false
        _status.value = null
        _approvals.value = emptyList()
        _runs.value = emptyList()
        _activity.value = emptyList()
        _briefing.value = null
        _messages.value = emptyList()
        _bots.value = emptyList()
        _selectedBotId.value = null
    }

    // ---- Live data ------------------------------------------------------

    private fun startLive() {
        refreshAll()
        registerPushToken()
        socket.start(object : CompanionSocket.Listener {
            override fun onEvent(type: String, payload: JSONObject) {
                // Any push invalidates the affected list; simplest correct
                // strategy for MVP is to re-fetch the cheap endpoints.
                when (type) {
                    "approval" -> refreshApprovals()
                    "run-status" -> { refreshStatus(); refreshRuns() }
                    "activity" -> refreshActivity()
                    else -> refreshStatus()
                }
            }

            override fun onConnectionChanged(connected: Boolean) {
                _socketLive.value = connected
                if (connected) {
                    _rePairRequired.value = false
                    refreshAll()
                }
            }

            override fun onRePairRequired() {
                _rePairRequired.value = true
            }
        })
    }

    /**
     * Registers this device's FCM token with the server so "done" / "needs
     * you" pushes arrive while the app is backgrounded. Best-effort: FCM may
     * be unconfigured (PushConfig.init false) or Play Services absent.
     */
    private fun registerPushToken() {
        viewModelScope.launch {
            try {
                val messaging = com.google.firebase.messaging.FirebaseMessaging.getInstance()
                val token = kotlinx.coroutines.tasks.await(messaging.token)
                api.registerFcmToken(token)
            } catch (_: Exception) {
                // FCM unavailable — the WebSocket covers the foreground case.
            }
        }
    }

    fun refreshAll() {
        refreshStatus()
        refreshApprovals()
        refreshRuns()
        refreshActivity()
        refreshBriefing()
        refreshBots()
    }

    fun refreshStatus() = viewModelScope.launch { load { _status.value = api.getStatus() } }
    fun refreshApprovals() = viewModelScope.launch { load { _approvals.value = api.getApprovals() } }
    fun refreshRuns() = viewModelScope.launch { load { _runs.value = api.getRuns() } }
    fun refreshActivity() = viewModelScope.launch { load { _activity.value = api.getActivity() } }
    fun refreshBriefing() = viewModelScope.launch { load { _briefing.value = api.getBriefing() } }

    /**
     * Loads the bot roster for the chat picker (called after pairing via
     * refreshAll, and when the chat screen opens via ensureBots). Keeps the
     * persisted selection when it is still on the roster; otherwise falls back
     * to the first bot. An empty roster clears the selection.
     */
    fun refreshBots() = viewModelScope.launch {
        _botsLoading.value = true
        try {
            val list = api.getBots()
            _bots.value = list
            val current = store.selectedBotId
            val resolved = if (list.any { it.id == current }) current else list.firstOrNull()?.id
            _selectedBotId.value = resolved
            store.saveSelectedBotId(resolved)
            _error.value = null
        } catch (e: Exception) {
            _error.value = e.message ?: "Failed to load bots"
        } finally {
            _botsLoading.value = false
        }
    }

    /**
     * Ensures the roster is loaded once; later calls are no-ops while the
     * cached list is non-empty. Safe to call on every chat-screen open.
     */
    fun ensureBots() {
        if (_bots.value.isNotEmpty() || _botsLoading.value) return
        refreshBots()
    }

    /** Persists an explicit chat bot-picker selection. */
    fun selectBot(id: String) {
        if (_bots.value.none { it.id == id }) return
        _selectedBotId.value = id
        store.saveSelectedBotId(id)
    }

    private suspend fun load(block: suspend () -> Unit) {
        _loading.value = true
        try {
            block()
            _error.value = null
        } catch (e: Exception) {
            _error.value = e.message ?: "Request failed"
        } finally {
            _loading.value = false
        }
    }

    fun clearError() { _error.value = null }

    // ---- Approvals ------------------------------------------------------

    fun decideApproval(id: String, approve: Boolean, note: String?) {
        viewModelScope.launch {
            _loading.value = true
            try {
                if (approve) api.approve(id, note) else api.deny(id, note)
                _approvals.value = api.getApprovals()
                _error.value = null
            } catch (e: Exception) {
                _error.value = e.message ?: "Decision failed"
            } finally {
                _loading.value = false
            }
        }
    }

    // ---- Runs -----------------------------------------------------------

    fun runAction(id: String, action: String) {
        viewModelScope.launch {
            _loading.value = true
            try {
                when (action) {
                    "pause" -> api.pauseRun(id)
                    "resume" -> api.resumeRun(id)
                    "cancel" -> api.cancelRun(id)
                }
                _runs.value = api.getRuns()
                _error.value = null
            } catch (e: Exception) {
                _error.value = e.message ?: "Run action failed"
            } finally {
                _loading.value = false
            }
        }
    }

    // ---- Chat -----------------------------------------------------------

    fun sendChat(text: String) {
        val trimmed = text.trim()
        if (trimmed.isEmpty() || _chatBusy.value) return
        if (_selectedBotId.value.isNullOrEmpty()) {
            _error.value = if (_bots.value.isEmpty()) "No bots available." else "Pick a bot before sending."
            return
        }
        chatJob?.cancel()
        _messages.value = _messages.value +
            ChatMessage(++msgId, "user", trimmed) +
            ChatMessage(++msgId, "assistant", "")
        _chatBusy.value = true
        chatJob = viewModelScope.launch {
            val acc = StringBuilder()
            api.streamChat(trimmed)
                .catch { e -> appendAssistant("Error: ${e.message}") }
                .collect { ev ->
                    when (ev) {
                        is ChatEvent.Token -> {
                            acc.append(ev.text)
                            appendAssistant(acc.toString())
                        }
                        is ChatEvent.Done -> {
                            appendAssistant(ev.fullText.ifEmpty { acc.toString() })
                            _chatBusy.value = false
                        }
                        is ChatEvent.Queued ->
                            appendAssistant("(queued at position ${ev.position})")
                        is ChatEvent.Error -> {
                            appendAssistant("Error: ${ev.message}")
                            _chatBusy.value = false
                        }
                    }
                }
            if (_chatBusy.value) _chatBusy.value = false
        }
    }

    private fun appendAssistant(text: String) {
        _messages.value = _messages.value.dropLast(1) + ChatMessage(++msgId, "assistant", text)
    }

    fun clearChat() { _messages.value = emptyList() }

    override fun onCleared() {
        socket.stop()
        stopScreenShare()
        super.onCleared()
    }

    // ---- Remote screen (phone -> PC live view) ------------------------------

    private val screenSocket = RemoteScreenSocket(store)
    private val mainHandler = Handler(Looper.getMainLooper())

    private val _screenSession = MutableStateFlow<RemoteScreenSession?>(null)
    val screenSession: StateFlow<RemoteScreenSession?> = _screenSession.asStateFlow()

    private val _screenBitmap = MutableStateFlow<Bitmap?>(null)
    val screenBitmap: StateFlow<Bitmap?> = _screenBitmap.asStateFlow()

    /** Human-readable status line for the screen UI (approval wait, errors…). */
    private val _screenNote = MutableStateFlow<String?>(null)
    val screenNote: StateFlow<String?> = _screenNote.asStateFlow()

    private var screenPollJob: Job? = null

    /** Recycle the current frame bitmap (if any) before dropping the reference. */
    private fun recycleScreenBitmap() {
        _screenBitmap.value?.let { old ->
            if (!old.isRecycled) {
                try { old.recycle() } catch (_: Exception) { /* best effort */ }
            }
        }
        _screenBitmap.value = null
    }

    /** Ask the PC to share its screen. The owner must approve in the web UI. */
    fun startScreenShare() {
        if (_screenSession.value != null) return
        _screenNote.value = null
        recycleScreenBitmap()
        viewModelScope.launch {
            try {
                val s = api.startRemoteScreen()
                _screenSession.value = s
                _screenNote.value = "Waiting for approval on your PC…"
                pollScreenSession(s)
            } catch (e: Exception) {
                _error.value = "Couldn't start screen sharing: ${e.message}"
            }
        }
    }

    private fun pollScreenSession(first: RemoteScreenSession) {
        screenPollJob?.cancel()
        screenPollJob = viewModelScope.launch {
            var session = first
            while (isActive) {
                delay(session.pollMs.coerceIn(1000L, 10_000L))
                try {
                    session = api.getRemoteScreenSession(session.sessionId)
                } catch (e: Exception) {
                    _screenNote.value = "Lost contact with the PC: ${e.message}"
                    break
                }
                _screenSession.value = session
                when {
                    session.isLive -> {
                        _screenNote.value = if (session.mock) "Preview mode (test feed)" else "Live"
                        connectScreenSocket(session.sessionId)
                        break
                    }
                    session.isTerminal -> {
                        _screenNote.value = when (session.status) {
                            "denied" -> "Screen sharing was declined on the PC."
                            "expired" -> "The approval request expired."
                            else -> "Screen sharing ended."
                        }
                        _screenSession.value = null
                        break
                    }
                    else -> _screenNote.value = "Waiting for approval on your PC…"
                }
            }
        }
    }

    private fun connectScreenSocket(sessionId: String) {
        screenSocket.start(sessionId, object : RemoteScreenSocket.Listener {
            override fun onConnected(mock: Boolean) {
                mainHandler.post {
                    _screenNote.value = if (mock) "Preview mode (test feed)" else "Live"
                }
            }

            override fun onFrame(bitmap: Bitmap, w: Int, h: Int, frameNo: Long) {
                mainHandler.post {
                    // HIGH fix: recycle the previous frame before replacing it
                    // (OOM safety). Posted on the main thread — the same
                    // thread Compose draws on — so no draw can be in flight
                    // with the old bitmap at this point.
                    val old = _screenBitmap.value
                    _screenBitmap.value = bitmap
                    if (old != null && !old.isRecycled) {
                        try { old.recycle() } catch (_: Exception) { /* best effort */ }
                    }
                }
            }

            override fun onServerError(detail: String) {
                mainHandler.post {
                    _screenNote.value = when (detail) {
                        "capture_failed" -> "The PC couldn't capture its screen."
                        "not_approved" -> "Not approved on the PC."
                        else -> "Screen error: $detail"
                    }
                }
            }

            override fun onEnded(reason: String) {
                mainHandler.post {
                    _screenNote.value = when (reason) {
                        "max_duration" -> "Screen sharing stopped (30-minute limit)."
                        "capture_unavailable" -> "Screen capture unavailable on the PC."
                        else -> "Screen sharing ended."
                    }
                    _screenSession.value = null
                    recycleScreenBitmap()
                }
            }

            override fun onConnectionLost(willRetry: Boolean) {
                mainHandler.post {
                    _screenNote.value = "Connection to the PC lost."
                    _screenSession.value = null
                    recycleScreenBitmap()
                }
            }
        })
    }

    /** Stop sharing (also tells the PC to end the session). */
    fun stopScreenShare() {
        screenPollJob?.cancel()
        screenPollJob = null
        screenSocket.stop()
        val id = _screenSession.value?.sessionId
        _screenSession.value = null
        recycleScreenBitmap()
        _screenNote.value = null
        if (id != null) {
            viewModelScope.launch {
                try {
                    api.stopRemoteScreen(id)
                } catch (_: Exception) {
                }
            }
        }
    }

    class Factory(private val app: Application) : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <T : ViewModel> create(modelClass: Class<T>): T =
            CompanionViewModel(app) as T
    }
}
