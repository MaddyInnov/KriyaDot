// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.location.Location
import android.location.LocationManager
import android.provider.CalendarContract
import android.provider.ContactsContract
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
