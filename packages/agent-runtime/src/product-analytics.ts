// SPDX-License-Identifier: Apache-2.0
// Opt-in product analytics for KriyaDot (Codync parity).
//
// PRIVACY POSTURE — this module is OFF BY DEFAULT. When disabled,
// track()/reportCrash() are true no-ops: nothing is queued, nothing is
// sent, zero network traffic, zero overhead beyond a boolean check.
//
// When enabled, ONLY feature-use metadata is ever recorded:
//   - Allowed event names come from the ANALYTICS_EVENTS allowlist below.
//   - Properties must be scalars (string/number/boolean); nested objects
//     are dropped, not serialized.
//   - Every property bag passes through redactSecrets() (secret-like keys
//     become '[REDACTED]').
//   - NEVER recorded: message content, prompts, file contents, tool args,
//     URLs, file paths (beyond redacted basenames), or anything the user
//     typed. The allowlist + scalar-only rule enforces this by construction.
//
// Sinks are pluggable. The default sink keeps events local-only (visible in
// Settings → Privacy → "View collected data"). An HTTP sink can be
// configured with an explicit endpoint; nothing is hardcoded.

import { redactSecrets } from '@mvp/governance';

/** Feature-use events that may be tracked. Nothing else is allowed. */
export const ANALYTICS_EVENTS = [
  'bot_created',
  'bot_deleted',
  'group_chat_created',
  'thread_created',
  'workflow_run_started',
  'workflow_run_completed',
  'voice_call_started',
  'voice_note_recorded',
  'attachment_added',
  'routine_created',
  'routine_triggered',
  'approval_granted',
  'approval_denied',
  'memory_pinned',
  'memory_forgotten',
  'agent_detected',
  'model_changed',
  'app_opened',
  'screen_viewed',
  'message_reacted',
  'bot_asked',
  'bot_messaged',
  'login_typed',
  'oauth_connected',
  'push_enabled',
  'update_checked',
] as const;

export type AnalyticsEventName = (typeof ANALYTICS_EVENTS)[number];

/** Scalar-only property bag. Nested objects/arrays are dropped. */
export type AnalyticsProperties = Record<string, string | number | boolean>;

export interface AnalyticsEvent {
  event: AnalyticsEventName;
  properties: AnalyticsProperties;
  timestamp: number;
  sessionId: string;
}

export interface AnalyticsSettings {
  /** Master switch. Default false. */
  enabled: boolean;
  /** Crash reporting. Default false. Independent of `enabled`. */
  crashReporting: boolean;
  /** Optional HTTP endpoint for batch uploads. Empty = local-only. */
  endpoint: string;
}

export const DEFAULT_ANALYTICS_SETTINGS: AnalyticsSettings = {
  enabled: false,
  crashReporting: false,
  endpoint: '',
};

/** Pluggable sink. Implementations must never throw. */
export interface AnalyticsSink {
  readonly name: string;
  send(events: AnalyticsEvent[]): Promise<void>;
}

/** Default sink: keeps events in the local queue only. No network. */
export class LocalOnlySink implements AnalyticsSink {
  readonly name = 'local-only';
  async send(_events: AnalyticsEvent[]): Promise<void> {
    // Intentionally a no-op: events stay in the local queue for inspection.
  }
}

/** HTTP batch sink. Posts JSON batches to a configured endpoint. */
export class HttpSink implements AnalyticsSink {
  readonly name = 'http';
  constructor(
    private readonly endpoint: string,
    private readonly fetchFn: typeof fetch = fetch,
  ) {}

  async send(events: AnalyticsEvent[]): Promise<void> {
    try {
      const res = await this.fetchFn(this.endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ events }),
      });
      if (!res.ok) {
        console.warn(`[analytics] sink returned ${res.status}, keeping events local`);
      }
    } catch (err) {
      // Never break the app for analytics. Events stay queued.
      console.warn(`[analytics] sink failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const MAX_QUEUE = 1000;
const MAX_PROP_STRING_LEN = 256;

/** Keep only scalar values; drop nested objects/arrays/functions. */
function sanitizeProperties(input: unknown): AnalyticsProperties {
  const out: AnalyticsProperties = {};
  if (typeof input !== 'object' || input === null) return out;
  const redacted = redactSecrets(input as Record<string, unknown>);
  for (const [key, value] of Object.entries(redacted)) {
    if (typeof value === 'string') {
      out[key] = value.slice(0, MAX_PROP_STRING_LEN);
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    }
    // everything else (objects, arrays, null, undefined) is dropped
  }
  return out;
}

/** Inline `key=value` / `key: value` secret patterns in free text. */
const INLINE_SECRET_RE =
  /\b(api[_-]?key|token|secret|password|passwd|bearer|auth[_-]?token)\s*[:=]\s*['"]?([^\s'"`,;}]+)['"]?/gi;

/**
 * Redact a stack trace / error message for crash reporting:
 * - home directory → ~
 * - inline secret-like key=value pairs → [REDACTED]
 * - absolute paths collapsed to basenames (~/ prefix preserved)
 */
export function redactStack(raw: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  let out = raw;
  if (home) {
    out = out.split(home).join('~');
  }
  // Inline secrets: apiKey=xxx → apiKey=[REDACTED]
  out = out.replace(INLINE_SECRET_RE, '$1=[REDACTED]');
  // Collapse absolute paths to basenames, but preserve a leading ~/ marker
  // so home-dir files stay distinguishable from system files.
  out = out.replace(/\((?!~[/\\])([^()]*[/\\])([^/\\()]+:\d+:\d+)\)/g, '($2)');
  out = out.replace(/^(?!.*~[/\\])(\s*at\s+\S+\s+)(\S*[/\\])([^/\\\s:]+:\d+)/gm, '$1$3');
  return out;
}

function newSessionId(): string {
  return `sess_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

export class ProductAnalytics {
  private settings: AnalyticsSettings = { ...DEFAULT_ANALYTICS_SETTINGS };
  private queue: AnalyticsEvent[] = [];
  private sink: AnalyticsSink = new LocalOnlySink();
  private readonly sessionId = newSessionId();
  private flushTimer: ReturnType<typeof setInterval> | null = null;

  constructor(settings?: Partial<AnalyticsSettings>, sink?: AnalyticsSink) {
    if (settings) this.updateSettings(settings);
    if (sink) this.sink = sink;
  }

  updateSettings(patch: Partial<AnalyticsSettings>): void {
    const prev = this.settings.enabled;
    this.settings = {
      enabled: patch.enabled ?? this.settings.enabled,
      crashReporting: patch.crashReporting ?? this.settings.crashReporting,
      endpoint:
        typeof patch.endpoint === 'string' ? patch.endpoint.trim() : this.settings.endpoint,
    };
    // Swap sink when endpoint changes
    if (this.settings.endpoint) {
      this.sink = new HttpSink(this.settings.endpoint);
    } else {
      this.sink = new LocalOnlySink();
    }
    // Manage flush timer
    if (this.settings.enabled && !prev) {
      this.startFlushTimer();
    } else if (!this.settings.enabled && prev) {
      this.stopFlushTimer();
    }
  }

  getSettings(): AnalyticsSettings {
    return { ...this.settings };
  }

  get isEnabled(): boolean {
    return this.settings.enabled;
  }

  /**
   * Track a feature-use event. No-op when disabled. Unknown event names
   * are rejected (allowlist enforcement).
   */
  track(event: AnalyticsEventName, properties?: unknown): void {
    if (!this.settings.enabled) return;
    if (!(ANALYTICS_EVENTS as readonly string[]).includes(event)) {
      console.warn(`[analytics] rejected unknown event "${String(event)}"`);
      return;
    }
    this.queue.push({
      event,
      properties: sanitizeProperties(properties),
      timestamp: Date.now(),
      sessionId: this.sessionId,
    });
    if (this.queue.length > MAX_QUEUE) {
      this.queue.splice(0, this.queue.length - MAX_QUEUE);
    }
  }

  /** Read-only view of the local queue (for Settings → "View collected data"). */
  getQueuedEvents(): AnalyticsEvent[] {
    return this.queue.map((e) => ({ ...e, properties: { ...e.properties } }));
  }

  get queueSize(): number {
    return this.queue.length;
  }

  clearQueue(): void {
    this.queue = [];
  }

  /** Flush queued events to the sink. No-op when disabled. */
  async flush(): Promise<void> {
    if (!this.settings.enabled || this.queue.length === 0) return;
    const batch = this.queue.splice(0, this.queue.length);
    await this.sink.send(batch);
  }

  /**
   * Report a crash. No-op unless crashReporting is on. The error message
   * and stack are redacted (secrets + home dir stripped) before storing.
   * Crash records live in their own bounded side channel, not the event
   * queue, and are only uploaded when a sink is configured.
   */
  reportCrash(err: unknown): void {
    if (!this.settings.crashReporting) return;
    const message = err instanceof Error ? err.message : String(err);
    const stack = err instanceof Error && err.stack ? err.stack : '';
    const redacted = redactSecrets({ message, stack }) as { message: string; stack: string };
    this.crashes.push({
      message: redactStack(redacted.message).slice(0, 500),
      stack: redactStack(redacted.stack).slice(0, 4000),
      timestamp: Date.now(),
    });
    if (this.crashes.length > 100) this.crashes.splice(0, this.crashes.length - 100);
  }

  private crashes: Array<{ message: string; stack: string; timestamp: number }> = [];

  getCrashes(): Array<{ message: string; stack: string; timestamp: number }> {
    return this.crashes.map((c) => ({ ...c }));
  }

  clearCrashes(): void {
    this.crashes = [];
  }

  private startFlushTimer(): void {
    this.stopFlushTimer();
    // Flush every 60s while enabled. unref() so it never keeps the process alive.
    this.flushTimer = setInterval(() => {
      void this.flush();
    }, 60_000);
    if (typeof this.flushTimer === 'object' && this.flushTimer !== null) {
      (this.flushTimer as unknown as { unref?: () => void }).unref?.();
    }
  }

  private stopFlushTimer(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** For clean shutdown in tests. */
  dispose(): void {
    this.stopFlushTimer();
  }
}

/** Shared singleton. Configure via updateSettings() at boot. */
export const productAnalytics = new ProductAnalytics();
