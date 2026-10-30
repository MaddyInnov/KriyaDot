// SPDX-License-Identifier: Apache-2.0
package com.kriyadot.phoneagent

import android.content.Context
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BloodGlucoseRecord
import androidx.health.connect.client.records.BloodPressureRecord
import androidx.health.connect.client.records.BodyTemperatureRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.HeightRecord
import androidx.health.connect.client.records.OxygenSaturationRecord
import androidx.health.connect.client.records.RespiratoryRateRecord
import androidx.health.connect.client.records.RestingHeartRateRecord
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant

/**
 * Health Connect read bridge (Wave-6, DV-4 — device side).
 *
 * *** SOURCE-LEVEL ONLY — UNVERIFIED ***
 * No Android SDK / Gradle toolchain exists on the build VM, so this
 * file has never been compiled. It is written against
 * androidx.health.connect:connect-client 1.1.0-alpha06 (added to
 * app/build.gradle.kts) and must pass a real Android build + an
 * on-device Health Connect grant before the feature can be claimed
 * as working.
 *
 * Answers the `health_sync` data query: reads the record types the
 * user has granted in Health Connect and returns them in the EXACT
 * sample shape the API's health-sync surface accepts
 * (apps/api/src/health-sync.ts): { samples: [ { externalId, type,
 * value, unit, startAt, endAt, source } ] }. The server-side tool
 * posts that array to POST /api/health-sync/samples; ingest there is
 * idempotent per (deviceId, externalId), so re-running a sync window
 * never duplicates samples.
 *
 * Governance mirrors PhoneDataHandlers: reads happen ONLY for types
 * whose Health Connect permission the user granted in the system
 * Health Connect UI (this app cannot grant them itself). Ungranted
 * types are reported in `skippedTypes`, never silently substituted
 * from another source.
 */
object HealthConnectHandlers {

    /** API health-sync type names this bridge can produce. */
    private val ALL_TYPES = listOf(
        "steps", "distance", "heart_rate", "resting_heart_rate", "sleep",
        "weight", "height", "blood_oxygen", "blood_pressure", "blood_glucose",
        "active_calories", "exercise", "respiratory_rate", "body_temperature",
    )

    /**
     * Execute the `health_sync` query. Suspend: Health Connect reads
     * are coroutine-based; ScreenCaptureService calls this inside its
     * data-query coroutine scope.
     *
     * Params: `types` (JSONArray of API type names; default all),
     * `hoursBack` (1..168, default 24).
     */
    suspend fun readSyncBatch(context: Context, params: JSONObject): JSONObject {
        if (HealthConnectClient.getSdkStatus(context) != HealthConnectClient.SDK_AVAILABLE) {
            throw PhoneDataException("health_connect_unavailable")
        }
        val client = HealthConnectClient.getOrCreate(context)
        val granted = client.permissionController.getGrantedPermissions()

        val requested = mutableListOf<String>()
        val typesParam = params.optJSONArray("types")
        if (typesParam != null) {
            for (i in 0 until typesParam.length()) {
                val t = typesParam.optString(i, "")
                if (t in ALL_TYPES) requested.add(t)
            }
        } else {
            requested.addAll(ALL_TYPES)
        }
        if (requested.isEmpty()) throw PhoneDataException("health_no_types_requested")

        val hoursBack = params.optInt("hoursBack", 24).coerceIn(1, 168)
        val end = Instant.now()
        val start = end.minusSeconds(hoursBack.toLong() * 3600L)
        val range = TimeRangeFilter.between(start, end)

        val samples = JSONArray()
        val skipped = JSONArray()
        for (type in requested) {
            val permission = readPermissionFor(type)
            if (permission == null || permission !in granted) {
                skipped.put(type)
                continue
            }
            readType(client, type, range, samples)
        }
        if (samples.length() == 0 && skipped.length() == requested.size) {
            throw PhoneDataException("health_permission_missing")
        }
        val out = JSONObject()
        out.put("samples", samples)
        out.put("skippedTypes", skipped)
        out.put("windowStart", start.toEpochMilli())
        out.put("windowEnd", end.toEpochMilli())
        return out
    }

    private fun readPermissionFor(type: String): String? = when (type) {
        "steps" -> HealthPermission.getReadPermission(StepsRecord::class)
        "distance" -> HealthPermission.getReadPermission(DistanceRecord::class)
        "heart_rate" -> HealthPermission.getReadPermission(HeartRateRecord::class)
        "resting_heart_rate" -> HealthPermission.getReadPermission(RestingHeartRateRecord::class)
        "sleep" -> HealthPermission.getReadPermission(SleepSessionRecord::class)
        "weight" -> HealthPermission.getReadPermission(WeightRecord::class)
        "height" -> HealthPermission.getReadPermission(HeightRecord::class)
        "blood_oxygen" -> HealthPermission.getReadPermission(OxygenSaturationRecord::class)
        "blood_pressure" -> HealthPermission.getReadPermission(BloodPressureRecord::class)
        "blood_glucose" -> HealthPermission.getReadPermission(BloodGlucoseRecord::class)
        "active_calories" -> HealthPermission.getReadPermission(ActiveCaloriesBurnedRecord::class)
        "exercise" -> HealthPermission.getReadPermission(ExerciseSessionRecord::class)
        "respiratory_rate" -> HealthPermission.getReadPermission(RespiratoryRateRecord::class)
        "body_temperature" -> HealthPermission.getReadPermission(BodyTemperatureRecord::class)
        else -> null
    }

    private fun sample(
        externalId: String, type: String, value: Any, unit: String,
        startAt: Instant, endAt: Instant, source: String,
    ): JSONObject {
        val o = JSONObject()
        o.put("externalId", externalId)
        o.put("type", type)
        o.put("value", value)
        o.put("unit", unit)
        o.put("startAt", startAt.toEpochMilli())
        o.put("endAt", endAt.toEpochMilli())
        if (source.isNotEmpty()) o.put("source", source)
        return o
    }

    /** Stable fallback id when a record carries no metadata id. */
    private fun fallbackId(type: String, startAt: Instant, origin: String): String =
        "hc-$type-${startAt.toEpochMilli()}-${origin.hashCode().toUInt().toString(16)}"

    private suspend fun readType(
        client: HealthConnectClient, type: String,
        range: TimeRangeFilter, out: JSONArray,
    ) {
        when (type) {
            "steps" -> client.readRecords(ReadRecordsRequest(StepsRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.startTime, origin) },
                    type, r.count, "count", r.startTime, r.endTime, origin))
            }
            "distance" -> client.readRecords(ReadRecordsRequest(DistanceRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.startTime, origin) },
                    type, r.distance.inMeters, "m", r.startTime, r.endTime, origin))
            }
            "heart_rate" -> client.readRecords(ReadRecordsRequest(HeartRateRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                r.samples.forEachIndexed { i, s ->
                    out.put(sample("${r.metadata.id.ifEmpty { fallbackId(type, r.startTime, origin) }}#$i",
                        type, s.beatsPerMinute, "bpm", s.time, s.time, origin))
                }
            }
            "resting_heart_rate" -> client.readRecords(ReadRecordsRequest(RestingHeartRateRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, r.beatsPerMinute, "bpm", r.time, r.time, origin))
            }
            "sleep" -> client.readRecords(ReadRecordsRequest(SleepSessionRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                val durationMs = r.endTime.toEpochMilli() - r.startTime.toEpochMilli()
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.startTime, origin) },
                    type, durationMs, "ms", r.startTime, r.endTime, origin))
            }
            "weight" -> client.readRecords(ReadRecordsRequest(WeightRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, r.weight.inKilograms, "kg", r.time, r.time, origin))
            }
            "height" -> client.readRecords(ReadRecordsRequest(HeightRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, r.height.inMeters, "m", r.time, r.time, origin))
            }
            "blood_oxygen" -> client.readRecords(ReadRecordsRequest(OxygenSaturationRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, r.percentage.value, "%", r.time, r.time, origin))
            }
            "blood_pressure" -> client.readRecords(ReadRecordsRequest(BloodPressureRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                val v = JSONObject()
                v.put("systolic", r.systolic.inMillimetersOfMercury)
                v.put("diastolic", r.diastolic.inMillimetersOfMercury)
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, v, "mmHg", r.time, r.time, origin))
            }
            "blood_glucose" -> client.readRecords(ReadRecordsRequest(BloodGlucoseRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, r.level.inMillimolesPerLiter, "mmol/L", r.time, r.time, origin))
            }
            "active_calories" -> client.readRecords(ReadRecordsRequest(ActiveCaloriesBurnedRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.startTime, origin) },
                    type, r.energy.inKilocalories, "kcal", r.startTime, r.endTime, origin))
            }
            "exercise" -> client.readRecords(ReadRecordsRequest(ExerciseSessionRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                val durationMs = r.endTime.toEpochMilli() - r.startTime.toEpochMilli()
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.startTime, origin) },
                    type, durationMs, "ms", r.startTime, r.endTime, origin))
            }
            "respiratory_rate" -> client.readRecords(ReadRecordsRequest(RespiratoryRateRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, r.rate, "rpm", r.time, r.time, origin))
            }
            "body_temperature" -> client.readRecords(ReadRecordsRequest(BodyTemperatureRecord::class, range)).records.forEach { r ->
                val origin = r.metadata.dataOrigin.packageName
                out.put(sample(r.metadata.id.ifEmpty { fallbackId(type, r.time, origin) },
                    type, r.temperature.inCelsius, "Cel", r.time, r.time, origin))
            }
        }
    }
}
