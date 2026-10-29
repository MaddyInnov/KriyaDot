// SPDX-License-Identifier: Apache-2.0
// MQTT channel (Octop #71): hand-rolled MQTT 3.1.1 client tested against
// an in-process fake broker (node:net server on loopback) — CONNACK/SUBACK
// answered locally, PUBLISH captured, inbound publish injected.
// Zero external network.

import net from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createMqttProvider,
  decodePublish,
  encodePublish,
  MqttPacketParser,
  mqttToInbound,
  outboundTopic,
  resolveMqttConfig,
} from '../src/mqtt-channel.js';
import type { InboundMessage } from '../src/messaging.js';

interface BrokerState {
  server: net.Server;
  port: number;
  connects: number;
  subscriptions: string[];
  published: Array<{ topic: string; payload: string }>;
  pings: number;
  socket: net.Socket | null;
  injectPublish: (topic: string, payload: string) => void;
}

async function startFakeBroker(): Promise<BrokerState> {
  const state: BrokerState = {
    server: null as unknown as net.Server,
    port: 0,
    connects: 0,
    subscriptions: [],
    published: [],
    pings: 0,
    socket: null,
    injectPublish: () => undefined,
  };
  const parser = new MqttPacketParser();
  const server = net.createServer((socket) => {
    state.socket = socket;
    socket.on('data', (chunk) => {
      for (const pkt of parser.feed(chunk)) {
        if (pkt.type === 1) {
          // CONNECT → CONNACK accepted
          state.connects++;
          socket.write(Buffer.from([0x20, 0x02, 0x00, 0x00]));
        } else if (pkt.type === 8) {
          // SUBSCRIBE → record topics, SUBACK granted QoS 0
          const id = pkt.body.readUInt16BE(0);
          let o = 2;
          while (o < pkt.body.length) {
            const len = pkt.body.readUInt16BE(o);
            state.subscriptions.push(pkt.body.subarray(o + 2, o + 2 + len).toString('utf8'));
            o += 2 + len + 1;
          }
          const suback = Buffer.concat([
            Buffer.from([0x90, 0x03]),
            (() => {
              const b = Buffer.alloc(2);
              b.writeUInt16BE(id, 0);
              return b;
            })(),
            Buffer.from([0x00]),
          ]);
          socket.write(suback);
        } else if (pkt.type === 3) {
          const { topic, payload } = decodePublish(pkt);
          state.published.push({ topic, payload: payload.toString('utf8') });
        } else if (pkt.type === 12) {
          state.pings++;
          socket.write(Buffer.from([0xd0, 0x00]));
        }
      }
    });
  });
  state.server = server;
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  state.port = typeof address === 'object' && address ? address.port : 0;
  state.injectPublish = (topic, payload) => {
    state.socket?.write(encodePublish(topic, payload));
  };
  return state;
}

let broker: BrokerState | null = null;
afterEach(async () => {
  broker?.server.close();
  broker = null;
});

describe('mqtt channel against a fake broker', () => {
  it('connects (clean session), subscribes, publishes, and receives inbound', async () => {
    broker = await startFakeBroker();
    const inbound: InboundMessage[] = [];
    const provider = createMqttProvider(
      {
        url: `mqtt://127.0.0.1:${broker.port}`,
        topics: ['kriyadot/chats/+/in'],
        topicTemplate: 'kriyadot/chats/{chatId}/out',
        clientId: 'test-client',
        keepAliveSec: 1,
      },
      { onInbound: (m) => inbound.push(m) },
    );

    await provider.start();
    expect(broker.connects).toBe(1);
    expect(broker.subscriptions).toEqual(['kriyadot/chats/+/in']);

    const sent = await provider.send('room 42', 'hello over mqtt');
    expect(sent.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.published).toEqual([{ topic: 'kriyadot/chats/room_42/out', payload: 'hello over mqtt' }]);

    broker.injectPublish('kriyadot/chats/room_42/in', 'ping from device');
    await new Promise((r) => setTimeout(r, 50));
    expect(inbound).toHaveLength(1);
    expect(inbound[0]).toMatchObject({
      providerId: 'mqtt',
      chatId: 'kriyadot/chats/room_42/in',
      text: 'ping from device',
      relayed: true,
    });

    // Keepalive: keepAliveSec=1 → a PINGREQ within ~2s.
    await new Promise((r) => setTimeout(r, 1600));
    expect(broker.pings).toBeGreaterThan(0);

    await provider.stop();
  });

  it('send before start connects lazily', async () => {
    broker = await startFakeBroker();
    const provider = createMqttProvider({
      url: `mqtt://127.0.0.1:${broker.port}`,
      topics: [],
      topicTemplate: 'out/{chatId}',
      clientId: 'lazy',
      keepAliveSec: 60,
    });
    await provider.send('chat-1', 'lazy hello');
    await new Promise((r) => setTimeout(r, 50));
    expect(broker.published).toEqual([{ topic: 'out/chat-1', payload: 'lazy hello' }]);
    await provider.stop();
  });

  it('refused connections surface as errors', async () => {
    const refused = net.createServer((socket) => {
      const parser = new MqttPacketParser();
      socket.on('data', (chunk) => {
        for (const pkt of parser.feed(chunk)) {
          if (pkt.type === 1) socket.write(Buffer.from([0x20, 0x02, 0x00, 0x05])); // not authorized
        }
      });
    });
    await new Promise<void>((resolve) => refused.listen(0, '127.0.0.1', resolve));
    const address = refused.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    const provider = createMqttProvider({
      url: `mqtt://127.0.0.1:${port}`,
      topics: [],
      topicTemplate: 'out/{chatId}',
    });
    await expect(provider.start()).rejects.toThrow(/CONNACK code 5/);
    refused.close();
  });
});

describe('mqtt helpers', () => {
  it('resolveMqttConfig requires MQTT_URL and applies defaults', () => {
    expect(() => resolveMqttConfig({})).toThrow(/MQTT_URL/);
    const cfg = resolveMqttConfig({ MQTT_URL: 'mqtt://broker:1883' });
    expect(cfg.topics).toEqual(['kriyadot/chats/+/in']);
    expect(cfg.topicTemplate).toBe('kriyadot/chats/{chatId}/out');
    const custom = resolveMqttConfig({
      MQTT_URL: 'mqtts://broker:8883',
      MQTT_TOPICS: 'a/+/in, b/+/in',
      MQTT_TOPIC_TEMPLATE: 'x/{chatId}',
    });
    expect(custom.topics).toEqual(['a/+/in', 'b/+/in']);
    expect(custom.topicTemplate).toBe('x/{chatId}');
  });

  it('outboundTopic sanitizes chat ids into a single topic segment', () => {
    expect(outboundTopic('kriyadot/chats/{chatId}/out', 'a/b +c#d')).toBe('kriyadot/chats/a_b_c_d/out');
  });

  it('mqttToInbound shapes the standard inbound message', () => {
    const msg = mqttToInbound('sensors/temp', Buffer.from('21.5'));
    expect(msg.providerId).toBe('mqtt');
    expect(msg.text).toBe('21.5');
    expect(msg.relayed).toBe(true);
  });

  it('the packet parser handles fragmented + coalesced packets', () => {
    const parser = new MqttPacketParser();
    const wire = Buffer.concat([encodePublish('a/b', 'one'), encodePublish('c/d', 'two')]);
    const first = parser.feed(wire.subarray(0, 3));
    expect(first).toHaveLength(0);
    const rest = parser.feed(wire.subarray(3));
    expect(rest).toHaveLength(2);
    expect(decodePublish(rest[1]).topic).toBe('c/d');
  });
});
