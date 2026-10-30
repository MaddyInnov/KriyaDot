// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.provider.CalendarContract
import android.provider.CallLog
import android.provider.ContactsContract
import android.provider.Settings
import android.provider.Telephony
import androidx.core.content.ContextCompat
import org.json.JSONArray
import org.json.JSONObject

/** Error carrying a stable machine-readable code for the server. */
class PhoneDataException(val code: String) : Exception(code)

/**
 * Read-only data queries from the KriyaDot server (phone_calendar,
 * phone_contacts, phone_messages_recent, phone_location tools).
 *
 * Every read sits behind the app's normal runtime-permission model: the
 * user grants READ_CALENDAR / READ_CONTACTS / READ_SMS / location from
 * MainActivity's permission prompt (system dialog). Without the grant the
 * handler answers with a `<kind>_permission_missing` error — it never
 * prompts from here and never falls back to another data source.
 */
object PhoneDataHandlers {

    /** Execute one query; returns the `data` object for the data_result. */
    fun execute(context: Context, query: String, params: JSONObject): JSONObject {
        return when (query) {
            "calendar" -> calendar(context, params)
            "contacts" -> contacts(context, params)
            "messages_recent" -> messages(context, params)
            // Wave-4 (CT-9 / CT-7 read): SMS archive search + thread reads.
            "sms_search" -> smsSearch(context, params)
            "sms_thread" -> smsThread(context, params)
            // Wave-6 (DV-3): packaged command — call-history search.
            "call_history" -> callHistory(context, params)
            // Wave-6 (DV-6): background-control capability probe.
            "capabilities" -> capabilities(context)
            "location" -> location(context)
            else -> throw PhoneDataException("unknown_query")
        }
    }

    private fun requirePermission(context: Context, permission: String, code: String) {
        if (ContextCompat.checkSelfPermission(context, permission) != PackageManager.PERMISSION_GRANTED) {
            throw PhoneDataException(code)
        }
    }

    private fun calendar(context: Context, params: JSONObject): JSONObject {
        requirePermission(context, Manifest.permission.READ_CALENDAR, "calendar_permission_missing")
        val daysAhead = params.optInt("daysAhead", 7).coerceIn(1, 31)
        val limit = params.optInt("limit", 50).coerceIn(1, 200)
        val begin = System.currentTimeMillis()
        val end = begin + daysAhead.toLong() * 24L * 60L * 60L * 1000L
        val builder = CalendarContract.Instances.CONTENT_URI.buildUpon()
        ContentUris.appendId(builder, begin)
        ContentUris.appendId(builder, end)
        val projection = arrayOf(
            CalendarContract.Instances.TITLE,
            CalendarContract.Instances.BEGIN,
            CalendarContract.Instances.END,
            CalendarContract.Instances.EVENT_LOCATION,
        )
        val events = JSONArray()
        val cursor = context.contentResolver.query(
            builder.build(), projection, null, null, CalendarContract.Instances.BEGIN + " ASC",
        )
        cursor?.use { c ->
            while (c.moveToNext() && events.length() < limit) {
                val item = JSONObject()
                item.put("title", c.getString(0) ?: "")
                item.put("start", c.getLong(1))
                item.put("end", c.getLong(2))
                val loc = c.getString(3)
                if (!loc.isNullOrEmpty()) item.put("location", loc)
                events.put(item)
            }
        }
        return JSONObject().put("events", events)
    }

    private fun contacts(context: Context, params: JSONObject): JSONObject {
        requirePermission(context, Manifest.permission.READ_CONTACTS, "contacts_permission_missing")
        val limit = params.optInt("limit", 50).coerceIn(1, 200)
        val search = params.optString("query", "").trim()
        val projection = arrayOf(
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME,
            ContactsContract.CommonDataKinds.Phone.NUMBER,
        )
        val selection: String?
        val args: Array<String>?
        if (search.isNotEmpty()) {
            selection = ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " LIKE ?"
            args = arrayOf("%" + search + "%")
        } else {
            selection = null
            args = null
        }
        val out = JSONArray()
        val cursor = context.contentResolver.query(
            ContactsContract.CommonDataKinds.Phone.CONTENT_URI,
            projection, selection, args,
            ContactsContract.CommonDataKinds.Phone.DISPLAY_NAME + " ASC",
        )
        cursor?.use { c ->
            while (c.moveToNext() && out.length() < limit) {
                val item = JSONObject()
                item.put("name", c.getString(0) ?: "")
                item.put("phone", c.getString(1) ?: "")
                out.put(item)
            }
        }
        return JSONObject().put("contacts", out)
    }

    private fun messages(context: Context, params: JSONObject): JSONObject {
        requirePermission(context, Manifest.permission.READ_SMS, "messages_permission_missing")
        val limit = params.optInt("limit", 20).coerceIn(1, 100)
        val projection = arrayOf(
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
        )
        val out = JSONArray()
        val cursor = context.contentResolver.query(
            Telephony.Sms.CONTENT_URI, projection, null, null, Telephony.Sms.DATE + " DESC",
        )
        cursor?.use { c ->
            while (c.moveToNext() && out.length() < limit) {
                val item = JSONObject()
                item.put("address", c.getString(0) ?: "")
                item.put("body", (c.getString(1) ?: "").take(1000))
                item.put("date", c.getLong(2))
                item.put("type", c.getInt(3))
                out.put(item)
            }
        }
        return JSONObject().put("messages", out)
    }

    /**
     * Wave-4 (CT-9): search the SMS archive. Matches message bodies and
     * addresses with a LIKE query over the Telephony provider; results are
     * newest-first and body-capped exactly like the recent-messages read.
     */
    private fun smsSearch(context: Context, params: JSONObject): JSONObject {
        requirePermission(context, Manifest.permission.READ_SMS, "messages_permission_missing")
        val query = params.optString("query", "").trim()
        if (query.isEmpty()) throw PhoneDataException("bad_query")
        val limit = params.optInt("limit", 50).coerceIn(1, 200)
        val projection = arrayOf(
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
        )
        val like = "%" + query + "%"
        val out = JSONArray()
        val cursor = context.contentResolver.query(
            Telephony.Sms.CONTENT_URI, projection,
            Telephony.Sms.BODY + " LIKE ? OR " + Telephony.Sms.ADDRESS + " LIKE ?",
            arrayOf(like, like),
            Telephony.Sms.DATE + " DESC",
        )
        cursor?.use { c ->
            while (c.moveToNext() && out.length() < limit) {
                val item = JSONObject()
                item.put("address", c.getString(0) ?: "")
                item.put("body", (c.getString(1) ?: "").take(1000))
                item.put("date", c.getLong(2))
                item.put("type", c.getInt(3))
                out.put(item)
            }
        }
        return JSONObject().put("messages", out).put("query", query)
    }

    /** Wave-4 (CT-7 read): one SMS conversation thread by address. */
    private fun smsThread(context: Context, params: JSONObject): JSONObject {
        requirePermission(context, Manifest.permission.READ_SMS, "messages_permission_missing")
        val address = params.optString("address", "").trim()
        if (address.isEmpty()) throw PhoneDataException("bad_address")
        val limit = params.optInt("limit", 50).coerceIn(1, 200)
        val projection = arrayOf(
            Telephony.Sms.ADDRESS,
            Telephony.Sms.BODY,
            Telephony.Sms.DATE,
            Telephony.Sms.TYPE,
        )
        val out = JSONArray()
        val cursor = context.contentResolver.query(
            Telephony.Sms.CONTENT_URI, projection,
            Telephony.Sms.ADDRESS + " LIKE ?",
            arrayOf("%" + address + "%"),
            Telephony.Sms.DATE + " DESC",
        )
        cursor?.use { c ->
            while (c.moveToNext() && out.length() < limit) {
                val item = JSONObject()
                item.put("address", c.getString(0) ?: "")
                item.put("body", (c.getString(1) ?: "").take(1000))
                item.put("date", c.getLong(2))
                item.put("type", c.getInt(3))
                out.put(item)
            }
        }
        return JSONObject().put("messages", out).put("address", address)
    }

    /**
     * Wave-6 (DV-3): call-history search over CallLog.Calls. Read-only,
     * newest-first, capped. `query` matches the cached name or the number;
     * `type` maps the server's names onto CallLog type constants; `daysBack`
     * bounds the window. Behind READ_CALL_LOG like every other read here.
     */
    private fun callHistory(context: Context, params: JSONObject): JSONObject {
        requirePermission(context, Manifest.permission.READ_CALL_LOG, "call_log_permission_missing")
        val limit = params.optInt("limit", 30).coerceIn(1, 200)
        val daysBack = params.optInt("daysBack", 30).coerceIn(1, 365)
        val query = params.optString("query", "").trim()
        val typeCode = when (params.optString("type", "")) {
            "incoming" -> CallLog.Calls.INCOMING_TYPE
            "outgoing" -> CallLog.Calls.OUTGOING_TYPE
            "missed" -> CallLog.Calls.MISSED_TYPE
            "rejected" -> CallLog.Calls.REJECTED_TYPE
            "blocked" -> CallLog.Calls.BLOCKED_TYPE
            else -> -1
        }
        val since = System.currentTimeMillis() - daysBack.toLong() * 24L * 60L * 60L * 1000L
        val projection = arrayOf(
            CallLog.Calls.CACHED_NAME,
            CallLog.Calls.NUMBER,
            CallLog.Calls.TYPE,
            CallLog.Calls.DATE,
            CallLog.Calls.DURATION,
        )
        val clauses = mutableListOf(CallLog.Calls.DATE + " >= ?")
        val args = mutableListOf(since.toString())
        if (typeCode >= 0) {
            clauses.add(CallLog.Calls.TYPE + " = ?")
            args.add(typeCode.toString())
        }
        if (query.isNotEmpty()) {
            clauses.add("(" + CallLog.Calls.CACHED_NAME + " LIKE ? OR " + CallLog.Calls.NUMBER + " LIKE ?)")
            args.add("%" + query + "%")
            args.add("%" + query + "%")
        }
        val typeNames = mapOf(
            CallLog.Calls.INCOMING_TYPE to "incoming",
            CallLog.Calls.OUTGOING_TYPE to "outgoing",
            CallLog.Calls.MISSED_TYPE to "missed",
            CallLog.Calls.VOICEMAIL_TYPE to "voicemail",
            CallLog.Calls.REJECTED_TYPE to "rejected",
            CallLog.Calls.BLOCKED_TYPE to "blocked",
        )
        val out = JSONArray()
        val cursor = context.contentResolver.query(
            CallLog.Calls.CONTENT_URI, projection,
            clauses.joinToString(" AND "), args.toTypedArray(),
            CallLog.Calls.DATE + " DESC",
        )
        cursor?.use { c ->
            while (c.moveToNext() && out.length() < limit) {
                val item = JSONObject()
                val name = c.getString(0)
                if (!name.isNullOrEmpty()) item.put("name", name)
                item.put("number", c.getString(1) ?: "")
                item.put("type", typeNames[c.getInt(2)] ?: "unknown")
                item.put("date", c.getLong(3))
                item.put("durationSeconds", c.getLong(4))
                out.put(item)
            }
        }
        return JSONObject().put("calls", out)
    }

    /**
     * Wave-6 (DV-6): capability probe for the background-control report.
     * Reports ONLY state (never data): SDK level, whether THIS app's
     * accessibility service is enabled, and which runtime permissions are
     * currently granted. The server turns this into an honest support
     * verdict; nothing here can prove OEM battery residency.
     */
    private fun capabilities(context: Context): JSONObject {
        val out = JSONObject()
        out.put("sdkInt", android.os.Build.VERSION.SDK_INT)
        val enabledServices = try {
            Settings.Secure.getString(context.contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: ""
        } catch (e: Exception) {
            ""
        }
        out.put(
            "accessibilityEnabled",
            enabledServices.split(':').any { it.startsWith(context.packageName + "/") },
        )
        val perms = JSONObject()
        for ((key, perm) in listOf(
            "READ_CALENDAR" to Manifest.permission.READ_CALENDAR,
            "READ_CONTACTS" to Manifest.permission.READ_CONTACTS,
            "READ_SMS" to Manifest.permission.READ_SMS,
            "SEND_SMS" to Manifest.permission.SEND_SMS,
            "CALL_PHONE" to Manifest.permission.CALL_PHONE,
            "READ_CALL_LOG" to Manifest.permission.READ_CALL_LOG,
            "ACCESS_FINE_LOCATION" to Manifest.permission.ACCESS_FINE_LOCATION,
        )) {
            perms.put(key, ContextCompat.checkSelfPermission(context, perm) == PackageManager.PERMISSION_GRANTED)
        }
        out.put("permissions", perms)
        return out
    }

    private fun location(context: Context): JSONObject {
        val fine = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_FINE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            context, Manifest.permission.ACCESS_COARSE_LOCATION,
        ) == PackageManager.PERMISSION_GRANTED
        if (!fine && !coarse) throw PhoneDataException("location_permission_missing")
        val manager = context.getSystemService(Context.LOCATION_SERVICE) as LocationManager
        var best: Location? = null
        // Last-known fixes only: a one-shot read must not keep GPS running.
        // getLastKnownLocation can throw SecurityException on some OEM builds
        // when only coarse permission was granted to a provider; guard per provider.
        for (provider in manager.getProviders(true)) {
            val loc: Location? = try {
                manager.getLastKnownLocation(provider)
            } catch (e: SecurityException) {
                null
            } catch (e: IllegalArgumentException) {
                null
            }
            if (loc != null) {
                val current = best
                if (current == null || loc.time > current.time) {
                    best = loc
                }
            }
        }
        val found = best ?: return JSONObject().put("available", false)
        val out = JSONObject()
        out.put("available", true)
        out.put("latitude", found.latitude)
        out.put("longitude", found.longitude)
        if (found.hasAccuracy()) out.put("accuracyMeters", found.accuracy.toDouble())
        out.put("time", found.time)
        val providerName = found.provider
        if (!providerName.isNullOrEmpty()) out.put("provider", providerName)
        return out
    }
}
