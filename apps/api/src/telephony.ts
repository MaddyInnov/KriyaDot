// SPDX-License-Identifier: Apache-2.0
// Telephony provider interface for packaged outbound business calls
// (Muse parity §4.10 CT-1 / CT-5).
//
// The packaged flow (outbound-calls.ts) never talks to a carrier directly:
// it goes through this interface. Two providers ship here:
//
//   - MockTelephonyProvider — zero-cost, deterministic, used by every test
//     and by any install without carrier credentials. Its transcripts are
//     SIMULATED and are labelled as such end-to-end (ProviderCall.simulated)
//     so a mock call can never be mistaken for a real conversation.
//   - TwilioTelephonyProvider — an env-gated adapter for a Twilio-class
//     REST carrier. It is only constructed when TWILIO_ACCOUNT_SID,
//     TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER are all present. Its live
//     behaviour is UNVERIFIED in this build (no real account was available
//     during development); the request shapes are unit-tested against an
//     injected fetch, with zero paid API use.
//
// Bring-in (CT-5) is provider-dependent by nature: the mock supports it
// natively; the Twilio adapter supports it only in conference mode
// (TWILIO_CONFERENCE_BRIDGE=1, where the outbound leg joins a named
// conference and a second participant can be added through the
// Conferences Participants API). Outside conference mode addParticipant
// throws a clear error instead of pretending.

export interface TelephonyScript {
  /** First line the agent says (already includes the AI disclosure). */
  openingLine: string;
  /** Ordered points the agent must cover. */
  talkingPoints: string[];
  /** Lines the agent must never cross (payment promises, impersonation…). */
  guardrails: string[];
  /** Closing line. */
  closingLine: string;
  /** TTS voice id chosen on the script sheet (CT-3), when any. */
  voiceId?: string;
}

export interface PlaceCallInput {
  /** Normalized destination number (+ and digits). */
  to: string;
  counterpartyName: string;
  purpose: string;
  script: TelephonyScript;
  maxDurationSec: number;
  /** Opaque correlation id (the outbound brief id). */
  correlationId: string;
}

export interface TranscriptTurn {
  speaker: 'agent' | 'counterparty' | 'system';
  text: string;
}

export type ProviderCallStatus = 'in-progress' | 'completed' | 'failed' | 'no-answer';

export interface ProviderCall {
  providerCallId: string;
  status: ProviderCallStatus;
  durationSec?: number;
  transcript: TranscriptTurn[];
  participants: string[];
  /** True when this call never touched a real carrier (mock provider). */
  simulated: boolean;
  failureReason?: string;
}

export interface TelephonyProvider {
  readonly id: string;
  readonly label: string;
  readonly configured: boolean;
  /** Why it is unusable, when !configured. */
  readonly hint?: string;
  placeCall(input: PlaceCallInput): Promise<ProviderCall>;
  getCall(providerCallId: string): Promise<ProviderCall>;
  /** CT-5: bring a third party (usually the user) into a live call. */
  addParticipant(providerCallId: string, number: string): Promise<ProviderCall>;
  hangup(providerCallId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Mock provider (zero-cost, deterministic)
// ---------------------------------------------------------------------------

export type MockAnswerMode = 'answer' | 'no-answer' | 'fail';

export interface MockTelephonyOptions {
  answerMode?: MockAnswerMode;
  /** Fixed in-progress first, completed on getCall — for bring-in tests. */
  stayLive?: boolean;
}

export class MockTelephonyProvider implements TelephonyProvider {
  readonly id = 'mock';
  readonly label = 'Mock telephony (offline, simulated)';
  readonly configured = true;
  readonly placed: PlaceCallInput[] = [];
  private readonly calls = new Map<string, ProviderCall & { input: PlaceCallInput }>();
  private seq = 0;

  constructor(private readonly opts: MockTelephonyOptions = {}) {}

  async placeCall(input: PlaceCallInput): Promise<ProviderCall> {
    this.placed.push(input);
    this.seq += 1;
    const providerCallId = `mockcall_${this.seq}`;
    const mode = this.opts.answerMode ?? 'answer';
    let call: ProviderCall & { input: PlaceCallInput };
    if (mode === 'fail') {
      call = {
        providerCallId, input, status: 'failed', transcript: [], participants: [],
        simulated: true, failureReason: 'mock carrier failure',
      };
    } else if (mode === 'no-answer') {
      call = {
        providerCallId, input, status: 'no-answer', durationSec: 0,
        transcript: [{ speaker: 'system', text: 'The number rang out with no answer (simulated).' }],
        participants: [], simulated: true,
      };
    } else {
      const firstPoint = input.script.talkingPoints[0] ?? input.purpose;
      const transcript: TranscriptTurn[] = [
        { speaker: 'agent', text: input.script.openingLine },
        { speaker: 'counterparty', text: `(simulated reply) Hello, this is ${input.counterpartyName}.` },
        { speaker: 'agent', text: `I'm calling about: ${firstPoint}` },
        { speaker: 'counterparty', text: '(simulated reply) Understood — please go ahead and send the details.' },
        { speaker: 'agent', text: input.script.closingLine },
      ];
      call = {
        providerCallId, input,
        status: this.opts.stayLive ? 'in-progress' : 'completed',
        durationSec: this.opts.stayLive ? undefined : 47,
        transcript, participants: [], simulated: true,
      };
    }
    this.calls.set(providerCallId, call);
    return this.view(call);
  }

  async getCall(providerCallId: string): Promise<ProviderCall> {
    const call = this.calls.get(providerCallId);
    if (!call) throw new Error(`unknown mock call "${providerCallId}"`);
    if (call.status === 'in-progress') {
      // A live mock call completes when next polled (unless hangup came first).
      call.status = 'completed';
      call.durationSec = 63;
    }
    return this.view(call);
  }

  async addParticipant(providerCallId: string, number: string): Promise<ProviderCall> {
    const call = this.calls.get(providerCallId);
    if (!call) throw new Error(`unknown mock call "${providerCallId}"`);
    if (call.status !== 'in-progress') throw new Error('bring-in requires a live (in-progress) call');
    call.participants.push(number);
    call.transcript.push({ speaker: 'system', text: `Brought ${number} into the call.` });
    return this.view(call);
  }

  async hangup(providerCallId: string): Promise<void> {
    const call = this.calls.get(providerCallId);
    if (call && call.status === 'in-progress') {
      call.status = 'completed';
      call.durationSec = call.durationSec ?? 30;
    }
  }

  private view(call: ProviderCall & { input: PlaceCallInput }): ProviderCall {
    const { input: _input, ...rest } = call;
    return { ...rest, transcript: [...rest.transcript], participants: [...rest.participants] };
  }
}

// ---------------------------------------------------------------------------
// Twilio-class adapter (env-gated, live behaviour UNVERIFIED)
// ---------------------------------------------------------------------------

export interface TwilioConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string;
  /** When true, outbound legs join a named conference so bring-in works. */
  conferenceBridge?: boolean;
}

export type FetchFn = (url: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}>;

export function twilioConfigFromEnv(env: NodeJS.ProcessEnv = process.env): TwilioConfig | null {
  const accountSid = env.TWILIO_ACCOUNT_SID?.trim();
  const authToken = env.TWILIO_AUTH_TOKEN?.trim();
  const fromNumber = env.TWILIO_FROM_NUMBER?.trim();
  if (!accountSid || !authToken || !fromNumber) return null;
  return { accountSid, authToken, fromNumber, conferenceBridge: env.TWILIO_CONFERENCE_BRIDGE === '1' };
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** TwiML for the outbound leg: disclosure + opening line (+ conference join in bridge mode). */
export function buildTwilioTwiml(input: PlaceCallInput, conferenceBridge: boolean): string {
  const say = `<Say>${xmlEscape(input.script.openingLine)}</Say>`;
  if (conferenceBridge) {
    return `<Response>${say}<Dial><Conference>kd-${xmlEscape(input.correlationId)}</Conference></Dial></Response>`;
  }
  return `<Response>${say}<Pause length="2"/></Response>`;
}

export class TwilioTelephonyProvider implements TelephonyProvider {
  readonly id = 'twilio';
  readonly label = 'Twilio (env-gated, live unverified)';
  readonly configured = true;
  private readonly base: string;
  private readonly authHeader: string;
  private readonly conferenceByCall = new Map<string, string>();

  constructor(
    private readonly cfg: TwilioConfig,
    private readonly fetchFn: FetchFn = (url, init) => fetch(url, init as RequestInit) as ReturnType<FetchFn>,
  ) {
    this.base = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(cfg.accountSid)}`;
    // The credential is used only as an outbound Authorization header to
    // api.twilio.com; it is never logged or returned to callers.
    this.authHeader = `Basic ${Buffer.from(`${cfg.accountSid}:${cfg.authToken}`).toString('base64')}`;
  }

  private async api(path: string, form?: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchFn(`${this.base}${path}`, {
      method: form ? 'POST' : 'GET',
      headers: {
        Authorization: this.authHeader,
        ...(form ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {}),
      },
      ...(form ? { body: new URLSearchParams(form).toString() } : {}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`telephony provider error (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    return (await res.json()) as Record<string, unknown>;
  }

  async placeCall(input: PlaceCallInput): Promise<ProviderCall> {
    const data = await this.api('/Calls.json', {
      To: input.to,
      From: this.cfg.fromNumber,
      Twiml: buildTwilioTwiml(input, this.cfg.conferenceBridge === true),
    });
    const sid = String(data.sid ?? '');
    if (!sid) throw new Error('telephony provider returned no call id');
    if (this.cfg.conferenceBridge) this.conferenceByCall.set(sid, `kd-${input.correlationId}`);
    return {
      providerCallId: sid,
      status: 'in-progress',
      transcript: [],
      participants: [],
      simulated: false,
    };
  }

  async getCall(providerCallId: string): Promise<ProviderCall> {
    const data = await this.api(`/Calls/${encodeURIComponent(providerCallId)}.json`);
    const raw = String(data.status ?? '');
    const status: ProviderCallStatus =
      raw === 'completed' ? 'completed' : raw === 'no-answer' || raw === 'busy' ? 'no-answer'
      : raw === 'failed' || raw === 'canceled' ? 'failed' : 'in-progress';
    return {
      providerCallId,
      status,
      durationSec: typeof data.duration === 'string' ? Number(data.duration) || undefined : undefined,
      transcript: [],
      participants: [],
      simulated: false,
    };
  }

  async addParticipant(providerCallId: string, number: string): Promise<ProviderCall> {
    const conference = this.conferenceByCall.get(providerCallId);
    if (!this.cfg.conferenceBridge || !conference) {
      throw new Error(
        'bring-in on this provider requires conference mode (TWILIO_CONFERENCE_BRIDGE=1) so the live call is in a named conference',
      );
    }
    await this.api(`/Conferences/${encodeURIComponent(conference)}/Participants.json`, {
      From: this.cfg.fromNumber,
      To: number,
    });
    const call = await this.getCall(providerCallId);
    return { ...call, participants: [number] };
  }

  async hangup(providerCallId: string): Promise<void> {
    await this.api(`/Calls/${encodeURIComponent(providerCallId)}.json`, { Status: 'completed' });
  }
}

/**
 * Select the telephony provider: an explicit id wins; otherwise Twilio when
 * its env is complete, else the mock. `configured:false` (with a hint) is
 * returned for an explicit 'twilio' request whose env is incomplete — the
 * caller must surface the hint, never silently fall back for a real call.
 */
export function selectTelephonyProvider(
  requested: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  fetchFn?: FetchFn,
): TelephonyProvider {
  const id = (requested ?? '').trim().toLowerCase();
  if (id === 'mock' || (id === '' && !twilioConfigFromEnv(env))) {
    if (id === '' || id === 'mock') return new MockTelephonyProvider();
  }
  if (id === 'twilio' || id === '') {
    const cfg = twilioConfigFromEnv(env);
    if (cfg) return new TwilioTelephonyProvider(cfg, fetchFn);
    return {
      id: 'twilio', label: 'Twilio (env-gated, live unverified)', configured: false,
      hint: 'Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM_NUMBER to enable real calling.',
      placeCall: async () => { throw new Error('telephony provider "twilio" is not configured'); },
      getCall: async () => { throw new Error('telephony provider "twilio" is not configured'); },
      addParticipant: async () => { throw new Error('telephony provider "twilio" is not configured'); },
      hangup: async () => { throw new Error('telephony provider "twilio" is not configured'); },
    };
  }
  throw new Error(`unknown telephony provider "${requested}" (expected mock | twilio)`);
}
