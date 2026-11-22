import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import {
    Bind, Collection, DateValue, Decimal, OutcomeUnknownError, RecordValue, SdpError,
    TimestampValue, TimeValue, connect, contractPath,
} from 'stardataparadise';

const env = process.env;
const [password, guestPassword] = readFileSync(0, 'utf8').trimEnd().split(/\r?\n/);
const options = {
    host: env.SDP_SDK_HOST, port: Number(env.SDP_SDK_PORT), tlsName: env.SDP_SDK_TLS_NAME,
    caFile: env.SDP_SDK_CA, user: env.SDP_SDK_USER, password, timeoutMs: 12_000, autocommit: true,
};

const contractDigest = createHash('sha256').update(readFileSync(contractPath)).digest('hex');
const installedPath = relative(dirname(fileURLToPath(import.meta.url)), contractPath).replaceAll('\\', '/');
assert.equal(installedPath, 'node_modules/stardataparadise/contracts/sdp-contract-v1.zip');
assert.equal(contractDigest, env.SDP_SDK_CONTRACT_SHA256);
assert.equal(contractDigest, 'e6500900a3fa34910781ea92d5e41fe8716511fac6f6d6c689ff9cce15d578ab');
const golden = JSON.parse(readFileSync(env.SDP_SDK_GOLDEN, 'utf8')).body.values;
const expectedDecimal = golden.find(value => value.t === 'decimal');
const expectedStamp = golden.find(value => value.t === 'timestamp');
const expectedBytes = Buffer.from(golden.find(value => value.t === 'binary').hex, 'hex');
const originalNote = '\u0130stanbul\'un notu; a\0b';

const isSdp = code => error => error instanceof SdpError && error.code === code && !error.unknownOutcome;

async function query(connection, sql, parameters) {
    const result = await connection.execute(sql, parameters);
    try {
        return await result.fetchAll();
    } finally {
        await result.close();
    }
}

async function change(connection, sql, parameters) {
    const result = await connection.execute(sql, parameters);
    try {
        assert.equal(result.affectedRows, 1);
    } finally {
        await result.close();
    }
}

async function verifyTypes(connection) {
    const result = await connection.execute('SELECT note,amount,stamp,payload FROM sdk_seed ORDER BY id');
    try {
        assert.deepEqual(result.columns.map(column => column.name), ['note', 'amount', 'stamp', 'payload']);
        const first = await result.fetchOne();
        assert.equal(first[0], originalNote);
        assert.deepEqual(first[1], new Decimal(BigInt(expectedDecimal.unscaled), expectedDecimal.scale));
        assert.deepEqual(first[2], new TimestampValue(BigInt(expectedStamp.seconds), expectedStamp.nanos, expectedStamp.offset_minutes));
        assert.deepEqual(first[3], expectedBytes);
        assert.deepEqual(await result.fetchOne(), [null, null, null, null]);
        assert.equal(await result.fetchOne(), null);
    } finally {
        await result.close();
    }

    const date = DateValue.parse('2024-02-29');
    const time = TimeValue.parse('23:59:59.123456789');
    const record = new RecordValue([
        ['\u0130zmir', 'a\0b'], ['money', new Decimal(BigInt(expectedDecimal.unscaled), expectedDecimal.scale)],
        ['when', date], ['clock', time], ['null', null], ['bytes', expectedBytes],
    ]);
    const collection = new Collection([record, null, -9_223_372_036_854_775_808n, 9_223_372_036_854_775_807n]);
    const routine = await connection.execute('CALL sdk_echo(:record_value,:collection_value)', {
        ':Record_Value': record, collection_value: collection,
    });
    try {
        assert.deepEqual(await routine.fetchAll(), [[record, collection]]);
    } finally {
        await routine.close();
    }
    const temporal = await query(connection, 'SELECT :calendar_value,:time_value,:typed_null',
        { calendar_value: date, time_value: time, typed_null: Bind(null, 'TEXT') });
    assert.deepEqual(temporal, [[date, time, null]]);
}

async function verifyBatchAndRoutine(connection) {
    const stream = await connection.execute('SELECT id FROM sdk_bulk ORDER BY id');
    try {
        assert.deepEqual(await stream.fetchMany(0), []);
        const first = await stream.fetchMany(129);
        assert.equal(first.length, 129);
        assert.deepEqual(first[0], [1n]);
        assert.deepEqual(first.at(-1), [129n]);
        const count = Number(env.SDP_SDK_BULK_ROWS);
        const batch = await stream.fetchAll();
        assert.equal(first.length + batch.length, count);
        assert.deepEqual(batch.at(-1), [BigInt(count)]);
        assert.equal(await stream.nextSet(), false);
    } finally {
        await stream.close();
    }

    const multiple = await connection.execute('CALL sdk_list(:input_key,NULL)', { input_key: 1n });
    try {
        assert.deepEqual(await multiple.fetchAll(), [[1n]]);
        assert.equal(await multiple.nextSet(), true);
        assert.equal(multiple.setName, 'found');
        assert.deepEqual(await multiple.fetchAll(), [[1n]]);
        assert.equal(await multiple.nextSet(), true);
        assert.equal(multiple.setName, 'all_rows');
        const read = [];
        for await (const row of multiple) read.push(row);
        assert.deepEqual(read, [[1n], [2n]]);
        assert.equal(await multiple.nextSet(), false);
    } finally {
        await multiple.close();
    }
}

async function verifyTransactions(connection) {
    await connection.begin();
    await change(connection, 'UPDATE sdk_seed SET note=:change WHERE id=1', { change: 'transaction-visible' });
    await connection.savepoint('node_save');
    await change(connection, 'UPDATE sdk_seed SET note=:change WHERE id=1', { change: 'savepoint-visible' });
    await connection.rollbackTo('node_save');
    await connection.release('node_save');
    assert.deepEqual(await query(connection, 'SELECT note FROM sdk_seed WHERE id=1'), [['transaction-visible']]);
    await connection.rollback();
    assert.deepEqual(await query(connection, 'SELECT note FROM sdk_seed WHERE id=1'), [[originalNote]]);
    const autocommit = await connection.execute("UPDATE sdk_seed SET note='confirmed' WHERE id=2");
    try {
        assert.equal(autocommit.affectedRows, 1);
        assert.equal(autocommit.requestToken, connection.lastRequestToken);
        const status = await connection.outcome(autocommit.requestToken);
        assert.equal(status.status, 'committed');
    } finally {
        await autocommit.close();
    }
}

async function verifyManagement(connection) {
    const revisions = await connection.history('sdk_seed');
    assert.ok(revisions.entries.some(entry => String(entry.revision) === env.SDP_SDK_SEED_LSN));
    const decision = await connection.validateDecision(
        'CREATE DECISION RULE observer ON sdk_seed FOR UPDATE PRIORITY 1 WHEN (NEW.id > 0) THEN DENY',
    );
    assert.equal(decision.valid, true);
    const forecast = await connection.predict(env.SDP_SDK_MODEL, { reading: 17 });
    assert.ok(Math.abs(forecast.prediction - 58) < 0.0001);
    const dataset = await connection.dataset(env.SDP_SDK_DATASET_ID);
    assert.equal(dataset.row_count, Number(env.SDP_SDK_BULK_ROWS));
    const seeded = await connection.job(env.SDP_SDK_JOB_ID);
    assert.equal(seeded.state, 'succeeded');
    const health = await connection.administrationHealth();
    assert.match(health.instance_id, /^[a-f0-9]{32}$/);
    assert.ok(Object.keys(health.checks).length > 0);
    assert.equal(await connection.cancel(), false);

    const submitted = await connection.submitCompute(1_000_000_000);
    const requested = await connection.cancelJob(submitted.job_id);
    assert.equal(requested.cancel_requested, true);
    let cancelled;
    for (let attempts = 0; attempts < 200; attempts++) {
        cancelled = await connection.job(submitted.job_id);
        if (['cancelled', 'succeeded', 'failed'].includes(cancelled.state)) break;
        await delay(20);
    }
    assert.equal(cancelled?.state, 'cancelled');
    assert.equal(cancelled.worker_pid, null);
    assert.equal(cancelled.result, null);
}

async function withConnection(settings, action) {
    const connection = await connect(settings);
    try {
        await action(connection);
    } finally {
        await connection[Symbol.asyncDispose]();
    }
}

await assert.rejects(() => connect({ ...options, tlsName: 'wrong.invalid' }), isSdp(1011));
await assert.rejects(() => connect({ ...options, password: randomUUID() }), isSdp(1005));

await withConnection(options, async owner => {
    assert.match(owner.sessionId, /^[a-f0-9]{32}$/);
    assert.equal(typeof owner.serverVersion, 'string');
    assert.equal((await owner.capabilities()).sql_crud_v1, true);
    await verifyTypes(owner);
    await verifyBatchAndRoutine(owner);
    await verifyTransactions(owner);
    await verifyManagement(owner);
});

await withConnection({ ...options, user: env.SDP_SDK_GUEST, password: guestPassword }, async guest => {
    assert.deepEqual(await query(guest, 'SELECT id FROM sdk_seed ORDER BY id'), [[1n], [2n]]);
    await assert.rejects(() => guest.history('sdk_seed'), isSdp(1006));
    await assert.rejects(() => guest.predict(env.SDP_SDK_MODEL, { reading: 17 }), isSdp(1006));
});

await withConnection(options, async holder => {
    await withConnection(options, async victim => {
        const previous = victim.sessionId;
        await holder.begin();
        const pending = query(victim, 'SELECT id FROM sdk_seed WHERE id=1')
            .then(rows => ({ rows }), error => ({ error }));
        let accepted = false;
        try {
            const deadline = Date.now() + 4_000;
            while (!accepted && Date.now() < deadline) {
                accepted = await victim.cancel();
                if (!accepted) await delay(20);
            }
        } finally {
            await holder.rollback();
        }
        assert.ok(accepted, 'Server did not accept cancellation of the blocked query');
        const outcome = await pending;
        assert.ok(isSdp(1009)(outcome.error), 'Cancelled query did not surface typed code 1009');
        assert.equal(victim.sessionId, previous);
        assert.deepEqual(await query(victim, 'SELECT id FROM sdk_seed WHERE id=1'), [[1n]]);
    });
});

assert.ok(env.SDP_SDK_READ_FAULT_PORT, 'Run managed fixture with --drop-read');
await withConnection({ ...options, port: Number(env.SDP_SDK_READ_FAULT_PORT), retryReads: true }, async safe => {
    const previous = safe.sessionId;
    assert.deepEqual(await query(safe, 'SELECT id FROM sdk_seed WHERE id=1'), [[1n]]);
    assert.notEqual(safe.sessionId, previous);
});

assert.ok(env.SDP_SDK_FAULT_PORT, 'Run managed fixture with --drop-op tx_commit');
const requestToken = randomUUID().replaceAll('-', '');
await withConnection({ ...options, port: Number(env.SDP_SDK_FAULT_PORT), autocommit: false }, async lost => {
    await change(lost, 'UPDATE sdk_seed SET note=:outcome_note WHERE id=2', { outcome_note: 'committed before lost reply' });
    await assert.rejects(() => lost.commit({ requestToken }), error =>
        error instanceof OutcomeUnknownError && error.unknownOutcome && error.requestToken === requestToken);
});
await withConnection(options, async recovery => {
    const durable = await recovery.outcome(requestToken);
    assert.equal(durable.status, 'committed');
    assert.ok(Number(durable.lsn) > 0);
    assert.deepEqual(await query(recovery, 'SELECT note FROM sdk_seed WHERE id=2'), [['committed before lost reply']]);
});

console.log('SDP_MANAGED_OK');
