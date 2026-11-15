import assert from 'node:assert/strict';
import test from 'node:test';
import { Buffer } from 'node:buffer';
import { Bind, Collection, DateValue, Decimal, RecordValue, TimestampValue, TimeValue, bind, decode } from '../src/types.mjs';

test('canonical BIGINT names and explicit SQL NULL', () => {
    assert.deepEqual(bind({ ':Max': 9_223_372_036_854_775_807n, min: -9_223_372_036_854_775_808n, typed: Bind(null, 'TEXT') }), {
        declarations: { max: { type: 'BIGINT' }, min: { type: 'BIGINT' }, typed: { type: 'TEXT' } },
        values: { max: { t: 'i64', v: '9223372036854775807' }, min: { t: 'i64', v: '-9223372036854775808' },
            typed: { t: 'null' } },
    });
    assert.equal(decode({ t: 'i64', v: '-9223372036854775808' }), -9_223_372_036_854_775_808n);
    assert.equal(decode({ t: 'null' }, 'BIGINT'), null);
    for (const v of [2 ** 53, 2n ** 63n, -(2n ** 63n) - 1n, 1.5, NaN, null]) {
        assert.throws(() => bind({ v }), TypeError);
    }
    assert.throws(() => bind({ ':X': 1, x: 2 }), /duplicate/);
    assert.throws(() => bind({ 'x\n': 1 }), /parameter name/);
    assert.throws(() => decode({ t: 'i64', v: '001' }), /exact decimal string/);
});

test('decimal coefficient and declared scale stay exact without silent rounding', () => {
    const value = Decimal.parse('-1234567890123456789012345678901234.1200');
    assert.equal(value.unscaled, -12345678901234567890123456789012341200n);
    assert.equal(value.scale, 4);
    const wire = bind({ value });
    assert.deepEqual(wire.declarations.value, { type: 'DECIMAL', precision: 38, scale: 4 });
    assert.equal(decode(wire.values.value).toString(), value.toString());
    assert.equal(Decimal.parse('.5e-3').toString(), '0.0005');
    assert.equal(Decimal.parse('-0.00').toString(), '0.00');
    assert.equal(Decimal.parse('1e37').toString(), '1' + '0'.repeat(37));
    assert.deepEqual(bind({ value: Bind(Decimal.parse('-1.2500'), 'DECIMAL', 4, 3) }).values.value,
        { t: 'decimal', unscaled: '-1250', scale: 3 });
    assert.deepEqual(bind({ value: Bind(42n, 'DECIMAL', 4, 2) }).values.value,
        { t: 'decimal', unscaled: '4200', scale: 2 });
    assert.throws(() => bind({ value: Bind(Decimal.parse('-9.125'), 'DECIMAL', 4, 2) }), /losing digits/);
    assert.throws(() => bind({ value: Bind(100n, 'DECIMAL', 4, 2) }), /precision/);
    for (const input of ['1e99', '1e-99', 'Infinity', '1.2\n', '', 'not decimal']) {
        assert.throws(() => Decimal.parse(input), TypeError);
    }
});

test('DATE, TIME and timestamp preserve nanoseconds and original offset', () => {
    const date = DateValue.parse('2000-02-29');
    const time = TimeValue.parse('23:59:59.123456789');
    const stamp = new TimestampValue(-1n, 999_999_999, 180);
    const encoded = bind({ date, time, stamp });
    assert.equal(DateValue.parse('0001-01-01').toString(), '0001-01-01');
    assert.deepEqual(decode(encoded.values.date, 'DATE'), date);
    assert.deepEqual(decode(encoded.values.time, { type: 'TIME' }), time);
    assert.deepEqual(decode(encoded.values.stamp), stamp);
    assert.deepEqual(encoded.values.stamp, { t: 'timestamp', seconds: '-1', nanos: 999_999_999, offset_minutes: 180 });
    assert.equal(decode({ t: 'timestamp', seconds: '0', nanos: 1, offset_minutes: 0, zone: 'UTC' }).zone, 'UTC');
    assert.throws(() => DateValue.parse('1900-02-29'), /calendar/);
    assert.throws(() => TimeValue.parse('24:00:00'), /range/);
    assert.throws(() => new TimestampValue(0n, 1_000_000_000, 0), /nanoseconds/);
});

test('record field order and nested typed arrays are stable', () => {
    const payload = new RecordValue([
        ['İzmir', 'note\u0000ö'], ['__proto__', new Collection([null, Buffer.from('00ff', 'hex')])],
        ['when', DateValue.parse('2024-02-29')], ['at', TimeValue.parse('02:03:04.999999999')],
    ]);
    const encoded = bind({ payload }).values.payload;
    assert.deepEqual(decode(encoded), payload);
    assert.equal(encoded.fields[2].value.t, 'date');
    assert.equal(encoded.fields[3].value.t, 'time');
    assert.throws(() => new RecordValue([['dup', 1], ['dup', 2]]), /unique/);
    assert.throws(() => bind({ value: '\ud800' }), TypeError);
    assert.throws(() => decode({ t: 'binary', hex: '00xz' }), /BLOB/);
    let tooDeep = null;
    for (let index = 0; index < 10; index++) tooDeep = new Collection([tooDeep]);
    assert.throws(() => bind({ tooDeep }), /depth/);
});
