// SPDX-License-Identifier: Apache-2.0

/**
 * Email transport (Octomind parity gap: email as a bot channel).
 *
 * Dependency-free SMTP send + IMAP receive over node:net / node:tls.
 * Node ships no mail client, so this is a deliberately small,
 * protocol-faithful subset:
 *
 *   SMTP: greeting → EHLO → AUTH LOGIN (when credentials are set) →
 *         MAIL FROM / RCPT TO / DATA with dot-stuffing → QUIT.
 *   IMAP: LOGIN → SELECT INBOX → UID SEARCH UNSEEN → UID FETCH
 *         BODY.PEEK[] → UID STORE +\Seen → LOGOUT.
 *
 * TLS is implicit (port 465/993 style); plain connections work for
 * local relays. STARTTLS upgrade is NOT implemented — point at the
 * implicit-TLS port instead (documented in the channel setup notes).
 *
 * The socket is behind a MailChannel seam so tests drive the whole
 * protocol against a scripted fake server — zero network in tests.
 */

import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

// ---------------------------------------------------------------------------
// Channel seam
// ---------------------------------------------------------------------------

export interface MailChannel {
  /** Read one CRLF/LF-terminated line, terminator stripped. */
  readLine(): Promise<string>;
  /** Read exactly n bytes (protocol literals). */
  readBytes(n: number): Promise<Buffer>;
  write(data: string): void;
  close(): void;
}

type ConnectFn = (host: string, port: number, secure: boolean) => Promise<MailChannel>;

/** Real socket channel over net/tls with buffered line/byte readers. */
export const defaultMailConnect: ConnectFn = (host, port, secure) =>
  new Promise((resolve, reject) => {
    const socket: Socket = secure
      ? tlsConnect({ host, port, servername: host })
      : netConnect({ host, port });
    let buffer = Buffer.alloc(0);
    const lineWaiters: Array<{ resolve: (line: string) => void; reject: (e: Error) => void }> = [];
    const byteWaiters: Array<{ n: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }> = [];
    let failure: Error | null = null;

    const pump = (): void => {
      for (;;) {
        if (byteWaiters.length > 0 && buffer.length >= byteWaiters[0]!.n) {
          const w = byteWaiters.shift()!;
          const out = buffer.subarray(0, w.n);
          buffer = buffer.subarray(w.n);
          w.resolve(Buffer.from(out));
          continue;
        }
        if (lineWaiters.length > 0) {
          const idx = buffer.indexOf(0x0a);
          if (idx === -1) return;
          const raw = buffer.subarray(0, idx).toString('utf8').replace(/\r$/, '');
          buffer = buffer.subarray(idx + 1);
          lineWaiters.shift()!.resolve(raw);
          continue;
        }
        return;
      }
    };
    const fail = (err: Error): void => {
      if (failure) return;
      failure = err;
      for (const w of lineWaiters.splice(0)) w.reject(err);
      for (const w of byteWaiters.splice(0)) w.reject(err);
    };
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      pump();
    });
    socket.on('error', fail);
    socket.on('close', () => fail(new Error('mail connection closed')));
    socket.once(secure ? 'secureConnect' : 'connect', () => {
      resolve({
        readLine: () =>
          failure
            ? Promise.reject(failure)
            : new Promise<string>((res, rej) => {
                lineWaiters.push({ resolve: res, reject: rej });
                pump();
              }),
        readBytes: (n) =>
          failure
            ? Promise.reject(failure)
            : new Promise<Buffer>((res, rej) => {
                byteWaiters.push({ n, resolve: res, reject: rej });
                pump();
              }),
        write: (data) => {
          socket.write(data);
        },
        close: () => socket.destroy(),
      });
    });
  });

// ---------------------------------------------------------------------------
// SMTP send
// ---------------------------------------------------------------------------

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
}

export interface OutgoingMail {
  to: string;
  subject: string;
  text: string;
}

async function smtpExpect(channel: MailChannel, codes: string[], what: string): Promise<string> {
  // Handles multi-line replies ("250-..." until "250 ...").
  let line = await channel.readLine();
  const code = line.slice(0, 3);
  while (line.length > 3 && line[3] === '-') {
    line = await channel.readLine();
  }
  if (!codes.includes(code)) {
    throw new Error(`SMTP ${what} failed: ${line}`);
  }
  return line;
}

export async function sendSmtpMail(
  config: SmtpConfig,
  mail: OutgoingMail,
  connectFn: ConnectFn = defaultMailConnect,
): Promise<{ id?: string }> {
  const channel = await connectFn(config.host, config.port, config.secure);
  try {
    await smtpExpect(channel, ['220'], 'greeting');
    channel.write('EHLO kriyadot.local\r\n');
    await smtpExpect(channel, ['250'], 'EHLO');
    if (config.user && config.pass) {
      channel.write('AUTH LOGIN\r\n');
      await smtpExpect(channel, ['334'], 'AUTH LOGIN');
      channel.write(`${Buffer.from(config.user).toString('base64')}\r\n`);
      await smtpExpect(channel, ['334'], 'AUTH username');
      channel.write(`${Buffer.from(config.pass).toString('base64')}\r\n`);
      await smtpExpect(channel, ['235'], 'AUTH password');
    }
    channel.write(`MAIL FROM:<${config.from}>\r\n`);
    await smtpExpect(channel, ['250'], 'MAIL FROM');
    channel.write(`RCPT TO:<${mail.to}>\r\n`);
    await smtpExpect(channel, ['250', '251'], 'RCPT TO');
    channel.write('DATA\r\n');
    await smtpExpect(channel, ['354'], 'DATA');
    const headers = [
      `From: ${config.from}`,
      `To: ${mail.to}`,
      `Subject: ${mail.subject.replace(/[\r\n]+/g, ' ').slice(0, 200)}`,
      'MIME-Version: 1.0',
      'Content-Type: text/plain; charset=utf-8',
      '',
    ];
    const body = mail.text
      .replace(/\r\n/g, '\n')
      .split('\n')
      .map((line) => (line.startsWith('.') ? `.${line}` : line))
      .join('\r\n');
    channel.write(`${headers.join('\r\n')}\r\n${body}\r\n.\r\n`);
    const accepted = await smtpExpect(channel, ['250'], 'message body');
    channel.write('QUIT\r\n');
    const idMatch = /(?:id|queue|queued as)[:= ]+([A-Za-z0-9._-]+)/i.exec(accepted);
    return { id: idMatch?.[1] };
  } finally {
    channel.close();
  }
}

// ---------------------------------------------------------------------------
// IMAP receive
// ---------------------------------------------------------------------------

export interface ImapConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  pass: string;
  mailbox?: string;
}

export interface IncomingMail {
  uid: string;
  from: string;
  subject: string;
  text: string;
}

interface ImapResponse {
  lines: string[];
  literals: Buffer[];
  ok: boolean;
  finalLine: string;
}

/** Read one tagged command's full response (lines + {n} literals). */
async function imapCommand(
  channel: MailChannel,
  tag: string,
  command: string | null,
): Promise<ImapResponse> {
  if (command) channel.write(`${tag} ${command}\r\n`);
  const lines: string[] = [];
  const literals: Buffer[] = [];
  for (;;) {
    const line = await channel.readLine();
    const literalMatch = /\{(\d+)\}$/.exec(line);
    if (literalMatch) {
      lines.push(line);
      literals.push(await channel.readBytes(Number(literalMatch[1])));
      continue;
    }
    if (line.startsWith(`${tag} `)) {
      return { lines, literals, ok: /^OK\b/i.test(line.slice(tag.length + 1)), finalLine: line };
    }
    lines.push(line);
  }
}

function decodeTransfer(body: string, encoding: string | undefined): string {
  if (/base64/i.test(encoding ?? '')) {
    try {
      return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    } catch {
      return body;
    }
  }
  if (/quoted-printable/i.test(encoding ?? '')) {
    return body
      .replace(/=\r?\n/g, '')
      .replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
  }
  return body;
}

/** Extract headers + the first text/plain body from a raw RFC822 message. */
export function parseRawMail(raw: string): { from: string; subject: string; text: string } {
  const headerEnd = raw.search(/\r?\n\r?\n/);
  const headers = headerEnd === -1 ? raw : raw.slice(0, headerEnd);
  const body = headerEnd === -1 ? '' : raw.slice(headerEnd).replace(/^\r?\n\r?\n/, '');
  const headerValue = (name: string): string => {
    const m = new RegExp(`^${name}:\\s*(.*)$`, 'im').exec(headers);
    return (m?.[1] ?? '').trim();
  };
  const from = headerValue('From').replace(/^.*<([^>]+)>.*$/, '$1').trim();
  const subject = headerValue('Subject');
  let text = body;
  const boundary = /boundary="?([^";\s]+)"?/i.exec(headerValue('Content-Type'))?.[1];
  if (boundary) {
    // Multipart: take the first text/plain segment.
    const segments = body.split(`--${boundary}`);
    const plain = segments.find((s) => /Content-Type:\s*text\/plain/i.test(s)) ?? segments[1] ?? '';
    const segBody = plain.replace(/^[\s\S]*?\r?\n\r?\n/, '');
    const enc = /Content-Transfer-Encoding:\s*(\S+)/i.exec(plain)?.[1];
    text = decodeTransfer(segBody, enc);
  } else {
    text = decodeTransfer(body, headerValue('Content-Transfer-Encoding'));
  }
  return { from, subject, text: text.trim().slice(0, 8000) };
}

export async function fetchUnseenMail(
  config: ImapConfig,
  connectFn: ConnectFn = defaultMailConnect,
  maxMessages = 10,
): Promise<IncomingMail[]> {
  const channel = await connectFn(config.host, config.port, config.secure);
  try {
    const greeting = await channel.readLine();
    if (!greeting.startsWith('* OK')) throw new Error(`IMAP greeting failed: ${greeting}`);
    const login = await imapCommand(
      channel,
      'a1',
      `LOGIN ${JSON.stringify(config.user)} ${JSON.stringify(config.pass)}`,
    );
    if (!login.ok) throw new Error(`IMAP login failed: ${login.finalLine}`);
    const select = await imapCommand(channel, 'a2', `SELECT ${JSON.stringify(config.mailbox ?? 'INBOX')}`);
    if (!select.ok) throw new Error(`IMAP select failed: ${select.finalLine}`);
    const search = await imapCommand(channel, 'a3', 'UID SEARCH UNSEEN');
    if (!search.ok) throw new Error(`IMAP search failed: ${search.finalLine}`);
    const searchLine = search.lines.find((l) => /^\* SEARCH/i.test(l)) ?? '';
    const uids = (searchLine.replace(/^\* SEARCH/i, '').trim().split(/\s+/).filter(Boolean) ?? []).slice(0, maxMessages);
    const out: IncomingMail[] = [];
    let tagSeq = 4;
    for (const uid of uids) {
      const tag = `a${tagSeq++}`;
      const fetched = await imapCommand(channel, tag, `UID FETCH ${uid} (BODY.PEEK[])`);
      if (!fetched.ok || fetched.literals.length === 0) continue;
      const raw = fetched.literals[0]!.toString('utf8');
      const parsed = parseRawMail(raw);
      out.push({ uid, ...parsed });
      const storeTag = `a${tagSeq++}`;
      await imapCommand(channel, storeTag, `UID STORE ${uid} +FLAGS (\\Seen)`);
    }
    await imapCommand(channel, `a${tagSeq}`, 'LOGOUT').catch(() => undefined);
    return out;
  } finally {
    channel.close();
  }
}
