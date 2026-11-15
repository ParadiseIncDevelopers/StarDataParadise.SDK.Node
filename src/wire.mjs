import {readFile} from 'node:fs/promises';
import {isIP} from 'node:net';
import * as tls from 'node:tls';
import {TextDecoder} from 'node:util';
import {OutcomeUnknownError, SdpError} from './errors.mjs';

const MAX_FRAME = 1024 * 1024;
const MAX_ID = 0xffff_ffff;
const text = new TextDecoder('utf-8', {fatal: true});
const disconnected = () => new SdpError('StarDataParadise connection closed.', {code: 1010, sqlstate: '08006'});
const expired = () => new SdpError('StarDataParadise request timed out.', {code: 1008, sqlstate: 'HYT00'});
const malformed = () => new SdpError('Invalid StarDataParadise wire response.', {code: 1001, sqlstate: '08P01'});

const plain = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validText = (value, limit) => typeof value === 'string' &&
  Buffer.byteLength(value, 'utf8') >= 1 && Buffer.byteLength(value, 'utf8') <= limit && !value.includes('\x00');

function validReply(reply, id) {
  if (!plain(reply) || reply.v !== 1 || reply.id !== id || typeof reply.ok !== 'boolean') return false;
  if (reply.ok) return plain(reply.body) && !Object.hasOwn(reply, 'error');
  const error = reply.error;
  return plain(error) && !Object.hasOwn(reply, 'body') && Number.isInteger(error.code) &&
    /^[A-Z0-9]{5}$/.test(error.sqlstate) && typeof error.message === 'string' &&
    typeof error.unknown_outcome === 'boolean';
}

function replyError(error, requestToken) {
  const attrs = {
    code: error.code,
    sqlstate: error.sqlstate,
    correlationId: error.correlation_id,
    requestToken,
    line: error.line,
    column: error.column,
  };
  return error.unknown_outcome ? new OutcomeUnknownError(undefined, attrs) : new SdpError(error.message, attrs);
}

export class Wire {
  #socket;
  #timeoutMs;
  #active = null;
  #buffer = Buffer.alloc(0);
  #id = 0;
  #closed = false;
  #sessionId;
  #productVersion;

  constructor(socket, timeoutMs) {
    this.#socket = socket;
    this.#timeoutMs = timeoutMs;
    socket.on('data', chunk => this.#receive(chunk));
    socket.on('end', () => this.#terminate(disconnected()));
    socket.on('close', () => this.#terminate(disconnected()));
    socket.on('error', () => this.#terminate(disconnected()));
  }

  static async connect({host = '127.0.0.1', port = 7443, user, password, caFile, tlsName = host, timeoutMs = 5000} = {}) {
    if (!validText(host, 253) || !validText(tlsName, 253) || !Number.isInteger(port) || port < 1 || port > 65_535 ||
        !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000 ||
        !validText(user, 128) || !validText(password, 1024)) {
      throw new TypeError('Invalid StarDataParadise connection options.');
    }
    let ca;
    if (caFile !== undefined) {
      try { ca = await readFile(caFile); }
      catch (cause) { throw new SdpError('Unable to read the TLS trust file.', {code: 1011, sqlstate: '08006', cause}); }
      if (ca.length < 1 || ca.length > MAX_FRAME) {
        throw new SdpError('Invalid TLS trust file size.', {code: 1011, sqlstate: '08006'});
      }
    }
    const socket = tls.connect({
      host, port, ca, minVersion: 'TLSv1.2', rejectUnauthorized: true,
      servername: isIP(tlsName) ? undefined : tlsName,
      checkServerIdentity: (_serverName, certificate) => tls.checkServerIdentity(tlsName, certificate),
    });
    const wire = new Wire(socket, timeoutMs);
    try {
      await new Promise((resolve, reject) => {
        const finish = error => {
          clearTimeout(timer);
          socket.removeListener('secureConnect', ready);
          socket.removeListener('error', fail);
          socket.removeListener('close', close);
          if (error) reject(error);
          else resolve();
        };
        const fail = cause => finish(new SdpError('StarDataParadise TLS connection failed.', {
          code: 1011, sqlstate: '08006', cause,
        }));
        const close = () => fail();
        const ready = () => socket.authorized ? finish() : fail();
        const timer = setTimeout(() => finish(expired()), timeoutMs);
        socket.once('secureConnect', ready);
        socket.once('error', fail);
        socket.once('close', close);
      });
      const hello = await wire.call('hello', {client: 'StarDataParadise.SDK.Node'});
      if (!/^[0-9a-f]{32}$/i.test(hello.session_id) || hello.protocol_version !== 1 ||
          !validText(hello.product_version, 64)) throw malformed();
      wire.#sessionId = hello.session_id;
      wire.#productVersion = hello.product_version;
      const auth = await wire.call('auth', {username: user, password});
      if (auth.authenticated !== true) throw malformed();
      return wire;
    } catch (error) {
      wire.close();
      throw error;
    }
  }

  get open() { return !this.#closed && !this.#socket.destroyed; }
  get sessionId() { return this.#sessionId; }
  get productVersion() { return this.#productVersion; }
  get pending() {
    return this.#active ? Object.freeze({id: this.#active.id, op: this.#active.op}) : null;
  }

  async call(op, body = {}, requestToken) {
    if (!this.open) throw disconnected();
    if (this.#active) throw new SdpError('A wire request is already active.', {code: 1013, sqlstate: '25000'});
    if (!/^[a-z][a-z_.]{0,63}$/.test(op) || !plain(body)) throw new TypeError('Invalid wire operation or body.');
    if (this.#id === MAX_ID) {
      this.close();
      throw disconnected();
    }
    const id = this.#id + 1;
    const payload = Buffer.from(JSON.stringify({v: 1, id, op, body}), 'utf8');
    if (!payload.length || payload.length > MAX_FRAME)
      throw new SdpError('Request exceeds the wire frame limit.', {code: 1002, sqlstate: '54000'});
    const frame = Buffer.allocUnsafe(4 + payload.length);
    frame.writeUInt32BE(payload.length);
    payload.copy(frame, 4);
    this.#id = id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.#terminate(expired()), this.#timeoutMs);
      this.#active = {id, op, resolve, reject, timer, requestToken};
      try { this.#socket.write(frame); } catch { this.#terminate(disconnected()); }
    });
  }

  close() {
    this.#terminate(disconnected());
  }

  #terminate(error) {
    if (this.#closed) return;
    this.#closed = true;
    this.#buffer = Buffer.alloc(0);
    this.#socket.destroy();
    const active = this.#takeActive();
    if (!active) return;
    const {reject, requestToken} = active;
    if (requestToken) {
      reject(new OutcomeUnknownError(undefined, {
        code: error.code, sqlstate: error.sqlstate, requestToken, cause: error,
      }));
    } else reject(error);
  }

  #takeActive() {
    const active = this.#active;
    this.#active = null;
    if (active) clearTimeout(active.timer);
    return active;
  }

  #receive(chunk) {
    if (this.#closed) return;
    if (!this.#active) {
      this.#terminate(malformed());
      return;
    }
    this.#buffer = this.#buffer.length ? Buffer.concat([this.#buffer, chunk]) : chunk;
    if (this.#buffer.length < 4) return;
    const size = this.#buffer.readUInt32BE();
    if (size < 1 || size > MAX_FRAME || this.#buffer.length > size + 4) {
      this.#terminate(malformed());
      return;
    }
    if (this.#buffer.length < size + 4) return;
    let reply;
    try { reply = JSON.parse(text.decode(this.#buffer.subarray(4))); }
    catch { this.#terminate(malformed()); return; }
    if (!validReply(reply, this.#active.id)) {
      this.#terminate(malformed());
      return;
    }
    this.#buffer = Buffer.alloc(0);
    const active = this.#takeActive();
    if (reply.ok) active.resolve(reply.body);
    else active.reject(replyError(reply.error, active.requestToken));
  }
}
