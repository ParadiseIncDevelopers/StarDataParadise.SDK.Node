import { randomBytes } from 'node:crypto';
import { SdpError } from './errors.mjs';
import { Wire } from './wire.mjs';
import { bind, decode } from './types.mjs';

const READ = new Set(['SELECT', 'WITH', 'EXPLAIN']);
const ROUTINE = new Set(['CALL', 'BEGIN', 'DECLARE']);
const WRITE = new Set([
  'CREATE', 'ALTER', 'DROP', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'GRANT', 'REVOKE', 'ANALYZE', 'REINDEX',
]);
const MAX_FETCH = 1024;

function verb(sql) {
  if (typeof sql !== 'string') throw new TypeError('SQL must be text');
  let body = sql.trimStart();
  while (/^(?:--|\/\*)/.test(body)) {
    const comment = /^(?:--[^\r\n]*(?:\r?\n|$)|\/\*[\s\S]*?\*\/)/.exec(body);
    if (!comment) throw new TypeError('SQL ends within a comment');
    body = body.slice(comment[0].length).trimStart();
  }
  const name = /^([A-Za-z]+)\b/.exec(body)?.[1].toUpperCase();
  if (!READ.has(name) && !ROUTINE.has(name) && !WRITE.has(name)) {
    throw new TypeError('Unsupported SQL command category');
  }
  return name;
}

function token(value) {
  if (value === undefined) return randomBytes(16).toString('hex');
  if (typeof value !== 'string' || value.length !== 32 || !/^[0-9a-f]{32}$/.test(value)) {
    throw new TypeError('Request tokens must contain 32 lowercase hexadecimal digits');
  }
  return value;
}

function state(message, sqlstate = '25000') {
  return new SdpError(message, { code: 1013, sqlstate });
}

function validate(options) {
  const {
    host = '127.0.0.1', port = 7443, user, password, caFile, tlsName, timeoutMs = 5000,
    autocommit = false, retryReads = false,
  } = options;
  for (const [name, value] of Object.entries({ host, user, password })) {
    if (typeof value !== 'string' || value.includes('\0') || !value.length || Buffer.byteLength(value) > 1024 ||
        !value.isWellFormed()) {
      throw new TypeError(name + ' must be nonempty valid UTF-8 text within the Server limit');
    }
  }
  if (tlsName !== undefined && (typeof tlsName !== 'string' || !tlsName.length || tlsName.includes('\0'))) {
    throw new TypeError('tlsName must be a nonempty TLS identity');
  }
  if (caFile !== undefined && typeof caFile !== 'string' && !(caFile instanceof URL)) {
    throw new TypeError('caFile must be a path or file URL');
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535 ||
      !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000) {
    throw new RangeError('Port or timeoutMs is outside the supported range');
  }
  if (typeof autocommit !== 'boolean' || typeof retryReads !== 'boolean') {
    throw new TypeError('autocommit and retryReads must be booleans');
  }
  return { transport: { host, port, user, password, caFile, tlsName, timeoutMs }, autocommit, retryReads };
}

export async function connect(options = {}) {
  const { transport, autocommit, retryReads } = validate(options);
  const wire = await Wire.connect(transport);
  return new Connection(wire, transport, autocommit, retryReads);
}

class Connection {
  #wire;
  #options;
  #closed = false;
  #busy = false;
  #transaction = false;
  #result = null;
  #autocommit;
  #retryReads;
  #lastRequestToken = null;

  constructor(wire, options, autocommit, retryReads) {
    this.#wire = wire;
    this.#options = options;
    this.#autocommit = autocommit;
    this.#retryReads = retryReads;
  }

  get sessionId() { return this.#wire.sessionId; }
  get serverVersion() { return this.#wire.productVersion; }
  get autocommit() { return this.#autocommit; }
  get lastRequestToken() { return this.#lastRequestToken; }

  _requireOpen() {
    if (this.#closed || !this.#wire.open) {
      throw new SdpError('Connection is closed', { code: 1010, sqlstate: '08006' });
    }
  }

  async _run(operation, requireOpen = true) {
    if (this.#busy) throw state('Another operation is using the connection');
    if (requireOpen) this._requireOpen();
    this.#busy = true;
    try {
      return await operation();
    } finally {
      this.#busy = false;
    }
  }

  async _call(operation, body, requestToken) {
    this._requireOpen();
    try {
      return await this.#wire.call(operation, body, requestToken);
    } finally {
      if (!this.#wire.open) this.#transaction = false;
    }
  }

  #requireIdle() {
    if (this.#result) throw state('Close the active result before starting another operation');
  }

  async #connectAgain() {
    if (this.#closed) throw state('An explicitly closed connection cannot be reopened');
    this.#requireIdle();
    if (this.#wire.open && this.#transaction) throw state('Finish the transaction before reconnecting');
    this.#wire.close();
    this.#transaction = false;
    this.#wire = await Wire.connect(this.#options);
  }

  reconnect() { return this._run(() => this.#connectAgain(), false); }

  async cancel() {
    this._requireOpen();
    const wire = this.#wire;
    const requestId = wire.pending?.id;
    if (!requestId) return false;
    const control = await Wire.connect(this.#options);
    try {
      if (wire !== this.#wire || requestId !== wire.pending?.id) return false;
      const reply = await control.call('query_cancel', { session_id: wire.sessionId, request_id: requestId });
      return reply.accepted === true;
    } finally {
      control.close();
    }
  }

  async #begin() {
    if (this.#transaction) return;
    await this._call('tx_begin');
    this.#transaction = true;
  }

  begin() {
    return this._run(async () => {
      this.#requireIdle();
      if (this.#transaction) throw state('A transaction is already active');
      await this.#begin();
    });
  }

  async #finish(commit, requestToken) {
    if (!this.#transaction) return;
    try {
      if (commit) {
        const key = token(requestToken);
        this.#lastRequestToken = key;
        return await this._call('tx_commit', { request_token: key }, key);
      }
      return await this._call('tx_rollback');
    } catch (error) {
      if (this.#wire.open && commit) {
        try { await this._call('tx_rollback'); } catch { this.#wire.close(); }
      } else if (this.#wire.open) {
        this.#wire.close();
      }
      throw error;
    } finally {
      this.#transaction = false;
    }
  }

  commit({ requestToken } = {}) {
    if (requestToken !== undefined) token(requestToken);
    return this._run(async () => {
      if (this.#result) {
        const receipt = await this.#result._end(true, requestToken);
        if (receipt !== undefined) return receipt;
      }
      return await this.#finish(true, requestToken);
    });
  }

  rollback() {
    return this._run(async () => {
      if (this.#result) await this.#result._end(false);
      return await this.#finish(false);
    });
  }

  #savepoint(operation, name) {
    if (typeof name !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(name)) {
      throw new TypeError('Savepoint names must be ordinary SQL identifiers');
    }
    return this._run(() => {
      this.#requireIdle();
      if (!this.#transaction) throw state('Savepoints require an active transaction');
      return this._call(operation, { name });
    });
  }

  savepoint(name) { return this.#savepoint('tx_savepoint', name); }
  rollbackTo(name) { return this.#savepoint('tx_rollback_to', name); }
  release(name) { return this.#savepoint('tx_release', name); }

  execute(sql, parameters = {}, { requestToken } = {}) {
    const statementKind = verb(sql);
    const encoded = bind(parameters);
    if (requestToken !== undefined) token(requestToken);
    return this._run(() => {
      this.#requireIdle();
      return this.#execute(sql, statementKind, encoded, requestToken);
    });
  }

  async #execute(sql, kind, { declarations, values }, requestToken) {
    const owned = this.#autocommit && !this.#transaction && ROUTINE.has(kind);
    if (requestToken !== undefined && (READ.has(kind) || this.#transaction || !this.#autocommit)) {
      throw state('Request tokens apply to independent autocommit mutations');
    }
    const retrySafe = READ.has(kind) && this.#autocommit && this.#retryReads && !this.#transaction;
    if (owned || !this.#autocommit) await this.#begin();
    const key = owned || (!this.#transaction && WRITE.has(kind)) ? token(requestToken) : undefined;
    if (key !== undefined) this.#lastRequestToken = key;
    let statement;
    let result;
    try {
      const preparation = { sql, parameter_types: declarations };
      let prepared;
      try {
        prepared = await this._call('query.prepare', preparation);
      } catch (error) {
        if (!retrySafe || error.code !== 1010 || error.unknownOutcome || this.#wire.open) throw error;
        await this.#connectAgain();
        prepared = await this._call('query.prepare', preparation);
      }
      statement = prepared.statement_id;
      const body = { statement_id: statement, parameters: values };
      if (!owned && key !== undefined) body.request_token = key;
      const reply = await this._call('execute', body, body.request_token);
      result = new Result(this, reply, statement, owned, key);
      if (reply.result_id !== undefined) this.#result = result;
      else await result._end(true);
      return result;
    } catch (error) {
      try {
        if (!result) await this._endResult(null, statement, undefined, false, owned, false, key);
        else await result._end(false);
      } catch {
        this.#wire.close();
      }
      throw error;
    }
  }

  async _endResult(result, statement, resultId, drained, owned, commit, requestToken) {
    try {
      if (this.#wire.open) {
        if (resultId !== undefined && !drained) await this._call('result_cancel', { result_id: resultId });
        if (statement !== undefined) await this._call('statement_close', { statement_id: statement });
        if (owned) return await this.#finish(commit, requestToken);
      }
    } catch (error) {
      this.#wire.close();
      throw error;
    } finally {
      if (this.#result === result) this.#result = null;
    }
  }

  close() {
    return this._run(async () => {
      if (this.#closed) return;
      try {
        if (this.#result) await this.#result._end(false);
        await this.#finish(false);
      } finally {
        this.#wire.close();
        this.#closed = true;
        this.#options = null;
      }
    }, false);
  }

  [Symbol.asyncDispose]() { return this.close(); }

  #control(operation, body, requestToken) {
    return this._run(() => {
      this.#requireIdle();
      return this._call(operation, body, requestToken);
    });
  }

  capabilities() { return this.#control('capabilities').then(reply => reply.features); }
  health() { return this.#control('health'); }
  metadata() { return this.#control('metadata'); }
  history(target, { limit = 128 } = {}) { return this.#control('history_log', { target, limit }); }
  validateDecision(sql) { return this.#control('decision_validate', { sql }); }
  predict(name, features) { return this.#control('model_predict', { name, features }); }
  dataset(id) { return this.#control('dataset_get', { dataset_id: id }); }
  job(id) { return this.#control('job_status', { job_id: id }); }
  cancelJob(id) { return this.#control('job_cancel', { job_id: id }); }
  administrationHealth() { return this.#control('admin_health'); }

  submitCompute(count) {
    const key = token();
    return this._run(() => {
      this.#requireIdle();
      this.#lastRequestToken = key;
      return this._call('job_submit', { kind: 'compute', count, request_token: key }, key);
    });
  }

  outcome(requestToken) { return this.#control('tx_outcome', { request_token: token(requestToken) }); }
}

class Result {
  #connection;
  #statement;
  #resultId;
  #owned;
  #setIndex = 0;
  #batchIndex = 0;
  #rows = [];
  #offset = 0;
  #endSet = false;
  #endResults = false;
  #closed = false;
  #columns;
  #setName = null;
  #affectedRows;
  #requestToken;

  constructor(connection, reply, statement, owned, requestToken) {
    this.#connection = connection;
    this.#statement = statement;
    this.#resultId = reply.result_id;
    this.#owned = owned;
    this.#columns = reply.columns ?? [];
    this.#affectedRows = reply.affected_rows;
    this.#requestToken = requestToken ?? null;
  }

  get columns() { return this.#columns.map(column => ({ ...column })); }
  get setName() { return this.#setName; }
  get affectedRows() { return this.#affectedRows; }
  get requestToken() { return this.#requestToken; }

  async #fill(size) {
    try {
      const { batch } = await this.#connection._call('fetch', {
        result_id: this.#resultId, batch_rows: size,
      });
      if (batch.result_set !== this.#setIndex || batch.batch_index !== this.#batchIndex ||
          (batch.end_of_results && !batch.end_of_set) || (!batch.end_of_set && !batch.rows.length)) {
        throw new SdpError('Invalid result sequence', { code: 1001, sqlstate: '08P01' });
      }
      if (!this.#batchIndex) {
        this.#columns = batch.columns;
        this.#setName = batch.set_name ?? null;
      }
      this.#batchIndex += 1;
      this.#endSet = batch.end_of_set;
      this.#endResults = batch.end_of_results;
      this.#rows = batch.rows.map(fields => {
        if (fields.length !== this.#columns.length) {
          throw new SdpError('Unexpected row width', { code: 1001, sqlstate: '08P01' });
        }
        return fields.map((field, index) => decode(field, this.#columns[index].type));
      });
      this.#offset = 0;
    } catch (error) {
      try { await this._end(false); } catch { /* Preserve the original error. */ }
      throw error;
    }
  }

  async #next(size) {
    if (this.#closed) return null;
    if (this.#offset === this.#rows.length && !this.#endSet) await this.#fill(size);
    if (this.#offset === this.#rows.length) {
      if (this.#endResults) await this._end(true);
      return null;
    }
    return this.#rows[this.#offset++];
  }

  fetchOne() { return this.#connection._run(() => this.#next(128), !this.#closed); }

  fetchMany(size = 128) {
    if (!Number.isSafeInteger(size) || size < 0) throw new RangeError('Fetch size must be a nonnegative integer');
    return this.#connection._run(async () => {
      const rows = [];
      while (rows.length < size) {
        const row = await this.#next(Math.min(MAX_FETCH, size - rows.length));
        if (row === null) break;
        rows.push(row);
      }
      return rows;
    }, !this.#closed);
  }

  fetchAll() {
    return this.#connection._run(async () => {
      const rows = [];
      for (let row = await this.#next(128); row !== null; row = await this.#next(128)) rows.push(row);
      return rows;
    }, !this.#closed);
  }

  nextSet() {
    return this.#connection._run(async () => {
      if (this.#closed) return false;
      while (!this.#endSet) await this.#fill(128);
      if (this.#endResults) {
        await this._end(true);
        return false;
      }
      this.#setIndex += 1;
      this.#batchIndex = 0;
      await this.#fill(128);
      return true;
    }, !this.#closed);
  }

  async _end(commit, requestToken = this.requestToken ?? undefined) {
    if (this.#closed) return;
    this.#closed = true;
    this.#rows = [];
    return await this.#connection._endResult(
      this, this.#statement, this.#resultId, this.#endResults, this.#owned, commit, requestToken,
    );
  }

  close() { return this.#connection._run(() => this._end(true), false); }
  [Symbol.asyncDispose]() { return this.close(); }

  async *[Symbol.asyncIterator]() {
    for (let row = await this.fetchOne(); row !== null; row = await this.fetchOne()) yield row;
  }
}
