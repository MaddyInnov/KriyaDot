// SPDX-License-Identifier: Apache-2.0
// MQTT channel (Octop #71): a minimal MQTT 3.1.1 client over node:net /
// node:tls, implemented by hand — CONNECT (clean session), SUBSCRIBE
// QoS 0, PUBLISH QoS 0, PINGREQ keepalive, DISCONNECT. No dependencies.
//
// Registered as a messaging provider ('mqtt') alongside telegram/discord/
// slack/whatsapp/email:
//   - outbound send(to, text): publishes to a per-chat topic built from a
//     template (default "kriyadot/chats/{chatId}/out").
//   - inbound: messages on the subscribed topics are shaped into the
//     standard InboundMessage and handed to the injected onInbound sink
//     (the host wires it to the same recordInbound path webhooks use).
//
// Config (env):
//   MQTT_URL            mqtt://host:1883 or mqtts://host:8883
//                       (userinfo in the URL supplies username/password)
//   MQTT_TOPICS         comma-separated inbound topic filters
//                       (default "kriyadot/chats/+/in")
//   MQTT_TOPIC_TEMPLATE outbound template with {chatId}
//                       (default "kriyadot/chats/{chatId}/out")
//   MQTT_CLIENT_ID      default "kriyadot-<random>"
//   MQTT_KEEPALIVE_SEC  default 60

import net from 'node:net';
import tls from 'node:tls';
import { randomUUID } from 'node:crypto';
import { registerMessageProvider, type InboundMessage, type MessageProvider } from './messaging.js';

// ---------------------------------------------------------------------------
// Packet codec (MQTT 3.1.1)
// ---------------------------------------------------------------------------

export function encodeRemainingLength(len: number): Buffer {
  const bytes: number[] = [];
  let n = len;
  do {
    let digit = n % 128;
    n = Math.floor(n / 128);
    if (n > 0) digit |= 0x80;
    bytes.push(digit);
  } while (n > 0);
  return Buffer.from(bytes);
}

function encodeUtf8String(s: string): Buffer {
  const body = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(2);
  len.writeUInt16BE(body.length, 0);
  return Buffer.concat([len, body]);
}

function packet(typeAndFlags: number, body: Buffer): Buffer {
  return Buffer.concat([Buffer.from([typeAndFlags]), encodeRemainingLength(body.length), body]);
}

export function encodeConnect(opts: {
  clientId: string;
  keepAliveSec: number;
  username?: string;
  password?: string;
  cleanSession?: boolean;
}): Buffer {
  const variableHeader = Buffer.concat([
    encodeUtf8String('MQTT'),
    Buffer.from([4]), // protocol level 3.1.1
    Buffer.from([
      (opts.username ? 0x80 : 0) |
        (opts.password ? 0x40 : 0) |
        (opts.cleanSession === false ? 0 : 0x02),
    ]),
    (() => {
      const ka = Buffer.alloc(2);
      ka.writeUInt16BE(opts.keepAliveSec, 0);
      return ka;
    })(),
  ]);
  const payloadParts = [encodeUtf8String(opts.clientId)];
  if (opts.username) payloadParts.push(encodeUtf8String(opts.username));
  if (opts.password) payloadParts.push(encodeUtf8String(opts.password));
  return packet(0x10, Buffer.concat([variableHeader, ...payloadParts]));
}

export function encodeSubscribe(packetId: number, topics: string[]): Buffer {
  const id = Buffer.alloc(2);
  id.writeUInt16BE(packetId, 0);
  const parts: Buffer[] = [id];
  for (const topic of topics) {
    parts.push(encodeUtf8String(topic));
    parts.push(Buffer.from([0])); // QoS 0
  }
  return packet(0x82, Buffer.concat(parts));
}

export function encodePublish(topic: string, payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return packet(0x30, Buffer.concat([encodeUtf8String(topic), body]));
}

export function encodePingReq(): Buffer {
  return Buffer.from([0xc0, 0x00]);
}

export function encodeDisconnect(): Buffer {
  return Buffer.from([0xe0, 0x00]);
}

export interface MqttPacket {
  type: number;
  flags: number;
  body: Buffer;
}

/** Incremental packet parser: feed chunks, get complete packets back. */
export class MqttPacketParser {
  private buffer = Buffer.alloc(0);

  feed(chunk: Buffer): MqttPacket[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const packets: MqttPacket[] = [];
    for (;;) {
      const parsed = this.tryParse();
      if (!parsed) break;
      packets.push(parsed);
    }
    return packets;
  }

  private tryParse(): MqttPacket | null {
    const buf = this.buffer;
    if (buf.length < 2) return null;
    // Remaining-length varint.
    let multiplier = 1;
    let remaining = 0;
    let idx = 1;
    for (;;) {
      if (idx >= buf.length) return null;
      const digit = buf[idx];
      remaining += (digit & 0x7f) * multiplier;
      idx++;
      if ((digit & 0x80) === 0) break;
      multiplier *= 128;
      if (multiplier > 128 * 128 * 128) throw new Error('MQTT: malformed remaining length');
    }
    if (buf.length < idx + remaining) return null;
    const pkt: MqttPacket = {
      type: buf[0] >> 4,
      flags: buf[0] & 0x0f,
      body: buf.subarray(idx, idx + remaining),
    };
    this.buffer = buf.subarray(idx + remaining);
    return pkt;
  }
}

/** Decode an inbound PUBLISH packet body → { topic, payload, packetId? }. */
export function decodePublish(pkt: MqttPacket): { topic: string; payload: Buffer; packetId?: number } {
  const body = pkt.body;
  const topicLen = body.readUInt16BE(0);
  const topic = body.subarray(2, 2 + topicLen).toString('utf8');
  const qos = (pkt.flags >> 1) & 0x03;
  let offset = 2 + topicLen;
  let packetId: number | undefined;
  if (qos > 0) {
    packetId = body.readUInt16BE(offset);
    offset += 2;
  }
  return { topic, payload: body.subarray(offset), ...(packetId !== undefined ? { packetId } : {}) };
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

export interface MqttClientOptions {
  url: string;
  clientId?: string;
  keepAliveSec?: number;
  /** Socket factory (tests may inject; default net/tls by URL scheme). */
  connectSocket?: (opts: { host: string; port: number; secure: boolean }) => net.Socket;
  onMessage?: (topic: string, payload: Buffer) => void;
  onError?: (err: Error) => void;
}

const PACKET_CONNACK = 2;
const PACKET_PUBLISH = 3;
const PACKET_PUBACK = 4;
const PACKET_SUBACK = 9;
const PACKET_PINGRESP = 13;

export class MqttClient {
  private socket: net.Socket | null = null;
  private readonly parser = new MqttPacketParser();
  private packetId = 1;
  private keepAliveTimer: NodeJS.Timeout | null = null;
  private connectResolve: (() => void) | null = null;
  private connectReject: ((err: Error) => void) | null = null;
  private readonly pendingSubacks = new Map<number, () => void>();
  readonly clientId: string;
  private readonly keepAliveSec: number;

  constructor(private readonly opts: MqttClientOptions) {
    this.clientId = opts.clientId ?? `kriyadot-${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    this.keepAliveSec = opts.keepAliveSec ?? 60;
  }

  connect(): Promise<void> {
    if (this.socket) return Promise.resolve();
    const url = new URL(this.opts.url);
    const secure = url.protocol === 'mqtts:' || url.protocol === 'mqtt+ssl:';
    if (!secure && url.protocol !== 'mqtt:') {
      return Promise.reject(new Error(`MQTT URL must be mqtt:// or mqtts:// (got ${url.protocol})`));
    }
    const host = url.hostname;
    const port = url.port ? Number(url.port) : secure ? 8883 : 1883;
    const username = url.username ? decodeURIComponent(url.username) : undefined;
    const password = url.password ? decodeURIComponent(url.password) : undefined;

    return new Promise<void>((resolve, reject) => {
      this.connectResolve = resolve;
      this.connectReject = reject;
      const socket = this.opts.connectSocket
        ? this.opts.connectSocket({ host, port, secure })
        : secure
          ? tls.connect({ host, port, servername: host })
          : net.connect({ host, port });
      this.socket = socket;
      socket.on('data', (chunk: Buffer) => this.onData(chunk));
      socket.on('error', (err: Error) => {
        this.connectReject?.(err);
        this.connectReject = null;
        this.opts.onError?.(err);
      });
      socket.on('close', () => {
        this.stopKeepAlive();
        this.socket = null;
      });
      socket.on('connect', () => {
        socket.write(
          encodeConnect({
            clientId: this.clientId,
            keepAliveSec: this.keepAliveSec,
            username,
            password,
            cleanSession: true,
          }),
        );
      });
    });
  }

  private onData(chunk: Buffer): void {
    let packets: MqttPacket[];
    try {
      packets = this.parser.feed(chunk);
    } catch (err) {
      this.opts.onError?.(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    for (const pkt of packets) {
      if (pkt.type === PACKET_CONNACK) {
        const returnCode = pkt.body.length >= 2 ? pkt.body[1] : 5;
        if (returnCode === 0) {
          this.startKeepAlive();
          this.connectResolve?.();
        } else {
          this.connectReject?.(new Error(`MQTT broker refused connection (CONNACK code ${returnCode})`));
        }
        this.connectResolve = null;
        this.connectReject = null;
      } else if (pkt.type === PACKET_SUBACK) {
        const id = pkt.body.readUInt16BE(0);
        this.pendingSubacks.get(id)?.();
        this.pendingSubacks.delete(id);
      } else if (pkt.type === PACKET_PUBLISH) {
        const { topic, payload, packetId } = decodePublish(pkt);
        if (packetId !== undefined) {
          // QoS 1 inbound: acknowledge with PUBACK.
          const id = Buffer.alloc(2);
          id.writeUInt16BE(packetId, 0);
          this.socket?.write(packet(PACKET_PUBACK << 4, id));
        }
        this.opts.onMessage?.(topic, payload);
      } else if (pkt.type === PACKET_PINGRESP) {
        // keepalive healthy — nothing to do
      }
    }
  }

  private startKeepAlive(): void {
    this.stopKeepAlive();
    if (this.keepAliveSec <= 0) return;
    const ms = Math.max(1000, Math.floor(this.keepAliveSec * 750));
    this.keepAliveTimer = setInterval(() => {
      this.socket?.write(encodePingReq());
    }, ms);
    this.keepAliveTimer.unref?.();
  }

  private stopKeepAlive(): void {
    if (this.keepAliveTimer) clearInterval(this.keepAliveTimer);
    this.keepAliveTimer = null;
  }

  subscribe(topics: string[]): Promise<void> {
    if (!this.socket) return Promise.reject(new Error('MQTT client is not connected'));
    const id = this.packetId++ & 0xffff;
    return new Promise<void>((resolve) => {
      this.pendingSubacks.set(id, resolve);
      this.socket!.write(encodeSubscribe(id, topics));
    });
  }

  publish(topic: string, payload: string | Buffer): void {
    if (!this.socket) throw new Error('MQTT client is not connected');
    this.socket.write(encodePublish(topic, payload));
  }

  async close(): Promise<void> {
    this.stopKeepAlive();
    if (this.socket) {
      try {
        this.socket.write(encodeDisconnect());
      } catch {
        // already gone
      }
      this.socket.end();
      this.socket.destroy();
      this.socket = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Messaging-provider integration
// ---------------------------------------------------------------------------

export interface MqttChannelConfig {
  url: string;
  topics: string[];
  topicTemplate: string;
  clientId?: string;
  keepAliveSec?: number;
}

export const MQTT_URL_ENV = 'MQTT_URL';
export const MQTT_TOPICS_ENV = 'MQTT_TOPICS';
export const MQTT_TOPIC_TEMPLATE_ENV = 'MQTT_TOPIC_TEMPLATE';
export const MQTT_CLIENT_ID_ENV = 'MQTT_CLIENT_ID';
export const MQTT_KEEPALIVE_ENV = 'MQTT_KEEPALIVE_SEC';

export const DEFAULT_MQTT_INBOUND_TOPIC = 'kriyadot/chats/+/in';
export const DEFAULT_MQTT_TOPIC_TEMPLATE = 'kriyadot/chats/{chatId}/out';

export function resolveMqttConfig(env: Record<string, string | undefined> = process.env): MqttChannelConfig {
  const url = (env[MQTT_URL_ENV] ?? '').trim();
  if (!url) {
    throw new Error(`MQTT is not configured: set ${MQTT_URL_ENV} (e.g. mqtt://localhost:1883).`);
  }
  const topics = (env[MQTT_TOPICS_ENV] ?? DEFAULT_MQTT_INBOUND_TOPIC)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean);
  const keepAliveRaw = Number(env[MQTT_KEEPALIVE_ENV] ?? '');
  return {
    url,
    topics: topics.length ? topics : [DEFAULT_MQTT_INBOUND_TOPIC],
    topicTemplate: (env[MQTT_TOPIC_TEMPLATE_ENV] ?? '').trim() || DEFAULT_MQTT_TOPIC_TEMPLATE,
    clientId: (env[MQTT_CLIENT_ID_ENV] ?? '').trim() || undefined,
    keepAliveSec: Number.isFinite(keepAliveRaw) && keepAliveRaw > 0 ? Math.floor(keepAliveRaw) : 60,
  };
}

/** Topic names cannot carry wildcard/space characters from a chat id. */
export function sanitizeTopicSegment(raw: string): string {
  return raw.replace(/[+#\s/]+/g, '_').slice(0, 128) || 'unknown';
}

export function outboundTopic(template: string, chatId: string): string {
  return template.replaceAll('{chatId}', sanitizeTopicSegment(chatId));
}

/** Inbound MQTT publish → the standard InboundMessage shape. */
export function mqttToInbound(topic: string, payload: Buffer): InboundMessage {
  const text = payload.toString('utf8');
  return {
    id: `mqtt_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
    providerId: 'mqtt',
    receivedAt: Date.now(),
    from: topic,
    chatId: topic,
    text,
    raw: { topic, payload: text },
    relayed: true,
  };
}

export interface MqttMessageProvider extends MessageProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
  readonly client: MqttClient;
}

export function createMqttProvider(
  config: MqttChannelConfig,
  opts: {
    onInbound?: (message: InboundMessage) => void;
    connectSocket?: MqttClientOptions['connectSocket'];
    onError?: (err: Error) => void;
  } = {},
): MqttMessageProvider {
  const client = new MqttClient({
    url: config.url,
    clientId: config.clientId,
    keepAliveSec: config.keepAliveSec,
    connectSocket: opts.connectSocket,
    onError: opts.onError,
    onMessage: (topic, payload) => {
      opts.onInbound?.(mqttToInbound(topic, payload));
    },
  });
  let started = false;
  return {
    id: 'mqtt',
    name: 'MQTT',
    client,
    async start() {
      if (started) return;
      await client.connect();
      if (config.topics.length) await client.subscribe(config.topics);
      started = true;
    },
    async stop() {
      started = false;
      await client.close();
    },
    async send(to: string, text: string) {
      if (!to) throw new Error('MQTT send: "to" (chat id) is required');
      if (!text) throw new Error('MQTT send: text is required');
      if (!started) await this.start();
      const topic = outboundTopic(config.topicTemplate, to);
      client.publish(topic, text);
      return { ok: true, id: topic };
    },
  };
}

/** Register the MQTT channel with the messaging provider registry (env-configured). */
export function registerMqttChannel(
  opts: { onInbound?: (message: InboundMessage) => void } = {},
): void {
  registerMessageProvider('mqtt', () =>
    createMqttProvider(resolveMqttConfig(), { onInbound: opts.onInbound }),
  );
}
