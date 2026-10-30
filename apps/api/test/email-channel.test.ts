// SPDX-License-Identifier: Apache-2.0
// Email channel: SMTP send + IMAP receive against a scripted fake
// server (zero network), provider registration, and inbound mapping.

import { describe, expect, it } from 'vitest';
import {
  fetchUnseenMail,
  parseRawMail,
  sendSmtpMail,
  type MailChannel,
} from '../src/email-transport.js';
import { createEmailProvider, emailToInbound, listMessageProviders } from '../src/messaging.js';

class FakeChannel implements MailChannel {
  readonly writes: string[] = [];
  private readonly queue: Array<string | Buffer>;
  constructor(items: Array<string | Buffer>) {
    this.queue = [...items];
  }
  async readLine(): Promise<string> {
    const next = this.queue.shift();
    if (typeof next !== 'string') throw new Error(`fake server: expected a line, got ${String(next)}`);
    return next;
  }
  async readBytes(n: number): Promise<Buffer> {
    const next = this.queue.shift();
    if (!Buffer.isBuffer(next) || next.length !== n) {
      throw new Error('fake server: literal length mismatch');
    }
    return next;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  close(): void {}
  get exhausted(): boolean {
    return this.queue.length === 0;
  }
}

const SMTP = { host: 'mx.example', port: 465, secure: true, user: 'bot@example.com', pass: 'pw', from: 'bot@example.com' };

describe('SMTP send', () => {
  it('runs the full EHLO/AUTH/DATA dialogue and returns the queue id', async () => {
    const channel = new FakeChannel([
      '220 mx.example ESMTP ready',
      '250-Hello',
      '250 AUTH LOGIN',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '235 Authentication successful',
      '250 OK',
      '250 OK',
      '354 End data with <CR><LF>.<CR><LF>',
      '250 2.0.0 Ok: queued as ABC123',
    ]);
    const result = await sendSmtpMail(
      SMTP,
      { to: 'user@example.org', subject: 'Deploy done', text: 'All green.\n.hidden line' },
      async () => channel,
    );
    expect(result.id).toBe('ABC123');
    const sent = channel.writes.join('');
    expect(sent).toContain('AUTH LOGIN\r\n');
    expect(sent).toContain(`${Buffer.from('bot@example.com').toString('base64')}\r\n`);
    expect(sent).toContain('MAIL FROM:<bot@example.com>\r\n');
    expect(sent).toContain('RCPT TO:<user@example.org>\r\n');
    expect(sent).toContain('Subject: Deploy done\r\n');
    expect(sent).toContain('..hidden line'); // dot-stuffed
    expect(channel.exhausted).toBe(true);
  });

  it('fails loudly on an AUTH rejection', async () => {
    const channel = new FakeChannel([
      '220 mx ESMTP',
      '250 Hello',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '535 Authentication failed',
    ]);
    await expect(
      sendSmtpMail(SMTP, { to: 'a@b.co', subject: 'x', text: 'y' }, async () => channel),
    ).rejects.toThrow(/AUTH password failed: 535/);
  });
});

/** FakeChannel that also supports the STARTTLS upgrade step. */
class UpgradingFakeChannel extends FakeChannel {
  upgradedWith: string | null = null;
  async upgradeToTls(servername: string): Promise<void> {
    this.upgradedWith = servername;
  }
}

describe('STARTTLS upgrade', () => {
  it('SMTP: upgrades after EHLO, re-EHLOs, and only then sends AUTH', async () => {
    const channel = new UpgradingFakeChannel([
      '220 mx.example ESMTP ready',
      '250-Hello',
      '250 STARTTLS',
      '220 2.0.0 Ready to start TLS',
      '250-Hello over TLS',
      '250 AUTH LOGIN',
      '334 VXNlcm5hbWU6',
      '334 UGFzc3dvcmQ6',
      '235 Authentication successful',
      '250 OK',
      '250 OK',
      '354 End data with <CR><LF>.<CR><LF>',
      '250 2.0.0 Ok: queued as TLS42',
    ]);
    const result = await sendSmtpMail(
      { host: 'mx.example', port: 587, secure: false, starttls: true, user: 'bot@example.com', pass: 'pw', from: 'bot@example.com' },
      { to: 'user@example.org', subject: 'Secure hi', text: 'body' },
      async () => channel,
    );
    expect(result.id).toBe('TLS42');
    expect(channel.upgradedWith).toBe('mx.example');
    const sent = channel.writes.join('');
    const starttlsAt = sent.indexOf('STARTTLS\r\n');
    const authAt = sent.indexOf('AUTH LOGIN\r\n');
    expect(starttlsAt).toBeGreaterThan(-1);
    expect(authAt).toBeGreaterThan(starttlsAt);
    // EHLO appears twice: once plaintext, once after the upgrade.
    expect(sent.match(/EHLO kriyadot\.local/g)).toHaveLength(2);
    expect(channel.exhausted).toBe(true);
  });

  it('SMTP: fails rather than sending credentials when the channel cannot upgrade', async () => {
    const channel = new FakeChannel([
      '220 mx.example ESMTP ready',
      '250 Hello',
      '220 2.0.0 Ready to start TLS',
    ]);
    await expect(
      sendSmtpMail(
        { host: 'mx.example', port: 587, secure: false, starttls: true, user: 'bot@example.com', pass: 'pw', from: 'bot@example.com' },
        { to: 'user@example.org', subject: 'x', text: 'y' },
        async () => channel,
      ),
    ).rejects.toThrow(/cannot upgrade/);
    expect(channel.writes.join('')).not.toContain('AUTH LOGIN');
  });

  it('IMAP: upgrades before LOGIN', async () => {
    const channel = new UpgradingFakeChannel([
      '* OK IMAP ready',
      'a0 OK Begin TLS negotiation now',
      'a1 OK logged in',
      '* 0 EXISTS',
      'a2 OK selected',
      '* SEARCH',
      'a3 OK search done',
      '* BYE bye',
      'a4 OK logout',
    ]);
    const mails = await fetchUnseenMail(
      { host: 'imap.example', port: 143, secure: false, starttls: true, user: 'bot@example.com', pass: 'pw' },
      async () => channel,
    );
    expect(mails).toEqual([]);
    expect(channel.upgradedWith).toBe('imap.example');
    const sent = channel.writes.join('');
    expect(sent.indexOf('a0 STARTTLS')).toBeGreaterThan(-1);
    expect(sent.indexOf('LOGIN')).toBeGreaterThan(sent.indexOf('a0 STARTTLS'));
    expect(channel.exhausted).toBe(true);
  });
});

describe('parseRawMail', () => {
  it('extracts from/subject/body from a plain message', () => {
    const parsed = parseRawMail(
      'From: Jane User <jane@example.org>\r\nSubject: Hello bot\r\nContent-Type: text/plain\r\n\r\nPlease summarize the report.\r\n',
    );
    expect(parsed.from).toBe('jane@example.org');
    expect(parsed.subject).toBe('Hello bot');
    expect(parsed.text).toContain('Please summarize the report.');
  });

  it('decodes a base64 text/plain part inside a multipart message', () => {
    const bodyB64 = Buffer.from('Multipart hello body').toString('base64');
    const raw = [
      'From: bob@example.org',
      'Subject: Multi',
      'Content-Type: multipart/alternative; boundary="BB"',
      '',
      '--BB',
      'Content-Type: text/html',
      '',
      '<p>html</p>',
      '--BB',
      'Content-Type: text/plain',
      'Content-Transfer-Encoding: base64',
      '',
      bodyB64,
      '--BB--',
    ].join('\r\n');
    const parsed = parseRawMail(raw);
    expect(parsed.text).toContain('Multipart hello body');
    expect(parsed.text).not.toContain('<p>html</p>');
  });
});

describe('IMAP fetch', () => {
  it('fetches unseen mail, parses it, and marks it seen', async () => {
    const rawMail = 'From: jane@example.org\r\nSubject: Status?\r\n\r\nHow is the deploy going?';
    const literal = Buffer.from(rawMail, 'utf8');
    const channel = new FakeChannel([
      '* OK IMAP ready',
      'a1 OK logged in',
      '* 1 EXISTS',
      'a2 OK selected',
      '* SEARCH 7',
      'a3 OK search done',
      `* 1 FETCH (UID 7 BODY[] {${literal.length}}`,
      literal,
      ')',
      'a4 OK fetch done',
      'a5 OK stored',
      '* BYE bye',
      'a6 OK logout',
    ]);
    const mails = await fetchUnseenMail(
      { host: 'imap.example', port: 993, secure: true, user: 'bot@example.com', pass: 'pw' },
      async () => channel,
    );
    expect(mails).toHaveLength(1);
    expect(mails[0]).toMatchObject({ uid: '7', from: 'jane@example.org', subject: 'Status?' });
    expect(mails[0]!.text).toContain('How is the deploy going?');
    expect(channel.writes.join('')).toContain('UID STORE 7 +FLAGS (\\Seen)');
    expect(channel.exhausted).toBe(true);
  });

  it('returns an empty list when nothing is unseen', async () => {
    const channel = new FakeChannel([
      '* OK ready',
      'a1 OK',
      'a2 OK',
      '* SEARCH',
      'a3 OK',
      '* BYE',
      'a4 OK',
    ]);
    const mails = await fetchUnseenMail(
      { host: 'h', port: 993, secure: true, user: 'u', pass: 'p' },
      async () => channel,
    );
    expect(mails).toEqual([]);
  });
});

describe('email provider registration + inbound mapping', () => {
  it('registers email as a message provider / channel', () => {
    expect(listMessageProviders()).toContain('email');
  });

  it('rejects non-email recipients before any network use', async () => {
    const provider = createEmailProvider(SMTP);
    await expect(provider.send('not-an-address', 'hello')).rejects.toThrow(/not an email address/);
  });

  it('maps fetched mail to an InboundMessage addressed back to the sender', () => {
    const inbound = emailToInbound({ uid: '42', from: 'jane@example.org', subject: 'Hi', text: 'Body text' });
    expect(inbound.providerId).toBe('email');
    expect(inbound.chatId).toBe('jane@example.org');
    expect(inbound.text).toBe('Hi\n\nBody text');
    expect(inbound.relayed).toBe(true);
  });
});
