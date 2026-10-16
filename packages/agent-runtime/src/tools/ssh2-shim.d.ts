// SPDX-License-Identifier: Apache-2.0
// Minimal ambient types for the `ssh2` package (v1.17 ships no bundled
// .d.ts). Covers exactly the surface vps.ts uses; kept narrow on purpose.

declare module 'ssh2' {
  import { EventEmitter } from 'node:events';
  import { Duplex } from 'node:stream';

  export interface ConnectConfig {
    host?: string;
    port?: number;
    username?: string;
    password?: string;
    privateKey?: string | Buffer;
    passphrase?: string;
    agent?: string;
    agentForward?: boolean;
    readyTimeout?: number;
    hostVerifier?: (key: Buffer, verify: (ok: boolean) => void) => boolean | void;
  }

  export class Channel extends Duplex {
    readonly stderr: Duplex;
  }

  // Structural subset of ssh2's SFTPWrapper used by vps.ts.
  export interface SFTPWrapper {
    open(
      path: string,
      mode: string,
      cb: (err: Error | undefined, handle: unknown) => void,
    ): void;
    read(
      handle: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: (err: Error | undefined, bytesRead: number, data: Buffer) => void,
    ): void;
    write(
      handle: unknown,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
      cb: (err: Error | undefined) => void,
    ): void;
    close(handle: unknown, cb: (err?: Error) => void): void;
    mkdir(path: string, cb: (err?: Error) => void): void;
  }

  export class Client extends EventEmitter {
    connect(config: ConnectConfig): void;
    exec(
      command: string,
      cb: (err: Error | undefined, channel: Channel) => void,
    ): this;
    sftp(cb: (err: Error | undefined, sftp: SFTPWrapper) => void): this;
    end(): void;
  }
}
