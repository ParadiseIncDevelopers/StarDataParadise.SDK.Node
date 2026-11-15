import { Buffer } from 'node:buffer';

const MIN_I64 = -(1n << 63n);
const MAX_I64 = (1n << 63n) - 1n;
const TAG_TYPES = new Map([
    ['bool', 'BOOLEAN'], ['i64', 'BIGINT'], ['decimal', 'DECIMAL'], ['text', 'TEXT'],
    ['binary', 'BLOB'], ['timestamp', 'TIMESTAMP WITH TIME ZONE'], ['record', 'RECORD'],
    ['collection', 'COLLECTION'],
]);
const TYPES = new Set([...TAG_TYPES.values(), 'DATE', 'TIME']);
const BIND = Symbol('StarDataParadise bind');

function check(condition, message) {
    if (!condition) throw new TypeError(message);
}

function within(value, minimum, maximum) {
    return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function validText(value) {
    return typeof value === 'string' && value.isWellFormed();
}

function integer(value) {
    if (typeof value === 'number') {
        check(Number.isSafeInteger(value), 'Use bigint for an exact BIGINT outside the JavaScript safe integer range');
        value = BigInt(value);
    }
    check(typeof value === 'bigint' && value >= MIN_I64 && value <= MAX_I64, 'BIGINT is outside the signed 64-bit range');
    return value;
}

function wireInteger(value) {
    const match = typeof value === 'string' && /^-?(?:0|[1-9][0-9]{0,18})$/.exec(value);
    check(match && match[0] === value, 'Server BIGINT must be an exact decimal string');
    return integer(BigInt(value));
}

function digits(value) {
    return (value < 0n ? -value : value).toString();
}

export class Decimal {
    constructor(unscaled, scale = 0) {
        check(typeof unscaled === 'bigint' && within(scale, 0, 38) && digits(unscaled).length <= 38,
            'DECIMAL requires a bigint coefficient and at most 38 digits and 38 fractional places');
        this.unscaled = unscaled;
        this.scale = scale;
        Object.freeze(this);
    }

    static parse(text) {
        check(typeof text === 'string' && text.length <= 256, 'DECIMAL requires a bounded decimal string');
        const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(text);
        check(match && match[0] === text, 'Invalid DECIMAL text');
        const fraction = match[3] ?? match[4] ?? '';
        let coefficient = ((match[2] ?? '') + fraction).replace(/^0+(?=\d)/, '');
        let scale = fraction.length - Number(match[5] ?? 0);
        check(Number.isSafeInteger(scale) && scale <= 38 && coefficient.length + Math.max(-scale, 0) <= 38,
            'DECIMAL exceeds the supported precision or scale');
        if (scale < 0) {
            coefficient += '0'.repeat(-scale);
            scale = 0;
        }
        return new Decimal(BigInt((match[1] === '-' ? '-' : '') + coefficient), scale);
    }

    toString() {
        const sign = this.unscaled < 0n ? '-' : '';
        const absolute = digits(this.unscaled).padStart(this.scale + 1, '0');
        if (this.scale === 0) return sign + absolute;
        return sign + absolute.slice(0, -this.scale) + '.' + absolute.slice(-this.scale);
    }
}

export class TimestampValue {
    constructor(seconds, nanos, offsetMinutes, zone) {
        this.seconds = integer(seconds);
        check(within(nanos, 0, 999_999_999) && within(offsetMinutes, -840, 840) &&
            (zone === undefined || (validText(zone) && zone.length > 0)),
            'Invalid timestamp nanoseconds, UTC offset or zone');
        this.nanos = nanos;
        this.offsetMinutes = offsetMinutes;
        if (zone !== undefined) this.zone = zone;
        Object.freeze(this);
    }
}

export class TimeValue {
    constructor(hour, minute, second, nanos = 0) {
        check(within(hour, 0, 23) && within(minute, 0, 59) && within(second, 0, 59) &&
            within(nanos, 0, 999_999_999), 'TIME is outside the supported range');
        this.hour = hour;
        this.minute = minute;
        this.second = second;
        this.nanos = nanos;
        Object.freeze(this);
    }

    static parse(text) {
        check(typeof text === 'string', 'TIME requires a string');
        const match = /^(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?$/.exec(text);
        check(match && match[0] === text, 'Invalid TIME text');
        return new TimeValue(Number(match[1]), Number(match[2]), Number(match[3]), Number((match[4] ?? '').padEnd(9, '0')));
    }

    toString() {
        return [this.hour, this.minute, this.second].map(part => String(part).padStart(2, '0')).join(':') +
            '.' + String(this.nanos).padStart(9, '0');
    }
}

export class DateValue {
    constructor(year, month, day) {
        check(within(year, 1, 9999) && within(month, 1, 12), 'DATE year or month is outside the supported range');
        const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
        const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        check(within(day, 1, days[month - 1]), 'DATE day is invalid for the calendar month');
        this.year = year;
        this.month = month;
        this.day = day;
        Object.freeze(this);
    }

    static parse(text) {
        check(typeof text === 'string', 'DATE requires a string');
        const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
        check(match && match[0] === text, 'Invalid DATE text');
        return new DateValue(Number(match[1]), Number(match[2]), Number(match[3]));
    }

    toString() {
        return [String(this.year).padStart(4, '0'), String(this.month).padStart(2, '0'),
            String(this.day).padStart(2, '0')].join('-');
    }
}

export class RecordValue {
    constructor(entries) {
        check(Array.isArray(entries) && entries.length <= 128, 'RECORD requires at most 128 ordered fields');
        const names = new Set();
        this.entries = Object.freeze(Array.from(entries, entry => {
            check(Array.isArray(entry) && entry.length === 2, 'Use a [name, value] pair for each RECORD field');
            const [name, value] = entry;
            check(validText(name) && name.length > 0 && !names.has(name), 'RECORD field names must be unique nonempty text');
            names.add(name);
            return Object.freeze([name, value]);
        }));
        Object.freeze(this);
    }
}

export class Collection {
    constructor(values) {
        check(Array.isArray(values) && values.length <= 128, 'COLLECTION requires at most 128 ordered values');
        this.values = Object.freeze(Array.from(values));
        Object.freeze(this);
    }
}

export function Bind(value, type, precision, scale) {
    check(typeof type === 'string', 'Declare a supported SQL parameter type');
    const name = type.trim().toUpperCase();
    check(TYPES.has(name), 'Unsupported declared SQL parameter type');
    const declaration = { type: name };
    if (name === 'DECIMAL') {
        check(within(precision, 1, 38) && within(scale, 0, precision), 'DECIMAL precision or scale is outside the supported range');
        Object.assign(declaration, { precision, scale });
    } else {
        check(precision === undefined && scale === undefined, 'Precision and scale require DECIMAL');
    }
    return Object.freeze({ [BIND]: true, declaration: Object.freeze(declaration), value });
}

function encode(value, depth = 0, nodes = { count: 0 }) {
    check(depth <= 8 && ++nodes.count <= 2048, 'Compound parameter exceeds the depth or member limit');
    if (value === null) return { t: 'null' };
    if (typeof value === 'boolean') return { t: 'bool', v: value };
    if (typeof value === 'bigint' || typeof value === 'number') return { t: 'i64', v: integer(value).toString() };
    if (value instanceof Decimal) return { t: 'decimal', unscaled: value.unscaled.toString(), scale: value.scale };
    if (validText(value)) return { t: 'text', v: value };
    if (value instanceof Uint8Array) return { t: 'binary', hex: Buffer.from(value).toString('hex') };
    if (value instanceof TimestampValue) {
        const stamp = { t: 'timestamp', seconds: value.seconds.toString(), nanos: value.nanos, offset_minutes: value.offsetMinutes };
        if (value.zone !== undefined) stamp.zone = value.zone;
        return stamp;
    }
    if (value instanceof DateValue) return { t: depth === 0 ? 'text' : 'date', v: value.toString() };
    if (value instanceof TimeValue) return { t: depth === 0 ? 'text' : 'time', v: value.toString() };
    if (value instanceof RecordValue) {
        return { t: 'record', fields: value.entries.map(([name, child]) => ({ name, value: encode(child, depth + 1, nodes) })) };
    }
    if (value instanceof Collection) {
        return { t: 'collection', items: value.values.map(child => encode(child, depth + 1, nodes)) };
    }
    throw new TypeError('Unsupported bind value. Use exact SQL type wrappers for decimal, temporal and compound values');
}

function rescale(wire, declaration) {
    check(wire.t === 'i64' || wire.t === 'decimal', 'Bind value does not match DECIMAL');
    const coefficient = BigInt(wire.unscaled ?? wire.v);
    const difference = declaration.scale - (wire.scale ?? 0);
    const factor = 10n ** BigInt(Math.abs(difference));
    if (difference < 0) check(coefficient % factor === 0n, 'DECIMAL cannot be rescaled without losing digits');
    const unscaled = difference < 0 ? coefficient / factor : coefficient * factor;
    check(digits(unscaled).length <= declaration.precision, 'DECIMAL exceeds its declared precision');
    return { t: 'decimal', unscaled: unscaled.toString(), scale: declaration.scale };
}

export function bind(parameters = {}) {
    const prototype = parameters === null ? null : Object.getPrototypeOf(parameters);
    check(parameters !== null && typeof parameters === 'object' &&
        (prototype === Object.prototype || prototype === null), 'Use an object for named parameters');
    const names = new Set();
    const pairs = Object.entries(parameters).map(([raw, supplied]) => {
        const bare = raw.startsWith(':') ? raw.slice(1) : raw;
        const match = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.exec(bare);
        const name = bare.toLowerCase();
        check(match && match[0] === bare && !names.has(name), 'Invalid or duplicate canonical parameter name');
        names.add(name);
        const explicit = supplied?.[BIND] === true;
        const value = explicit ? supplied.value : supplied;
        let wire = encode(value);
        let declaration;
        if (explicit) {
            declaration = supplied.declaration;
            if (value !== null) {
                if (declaration.type === 'DECIMAL') wire = rescale(wire, declaration);
                else if (declaration.type === 'DATE' && wire.t === 'text') DateValue.parse(wire.v);
                else if (declaration.type === 'TIME' && wire.t === 'text') TimeValue.parse(wire.v);
                else check(TAG_TYPES.get(wire.t) === declaration.type, 'Bind value does not match the declared SQL type');
            }
        } else if (value instanceof Decimal) {
            declaration = { type: 'DECIMAL', precision: Math.max(digits(value.unscaled).length, value.scale), scale: value.scale };
        } else if (value instanceof DateValue) {
            declaration = { type: 'DATE' };
        } else if (value instanceof TimeValue) {
            declaration = { type: 'TIME' };
        } else {
            check(value !== null, 'Declare NULL using Bind(null, SQL_type)');
            declaration = { type: TAG_TYPES.get(wire.t) };
        }
        return [name, declaration, wire];
    });
    return {
        declarations: Object.fromEntries(pairs.map(([name, declaration]) => [name, declaration])),
        values: Object.fromEntries(pairs.map(([name, , value]) => [name, value])),
    };
}

export function decode(value, sqlType) {
    return decodeValue(value, typeof sqlType === 'object' ? sqlType?.type : sqlType, 0, { count: 0 });
}

function decodeValue(value, sqlType, depth, nodes) {
    check(value && typeof value === 'object' && depth <= 8 && ++nodes.count <= 2048, 'Invalid typed Server value or compound limit');
    switch (value.t) {
    case 'null': return null;
    case 'i64': return wireInteger(value.v);
    case 'bool':
        check(typeof value.v === 'boolean', 'Invalid Server BOOLEAN');
        return value.v;
    case 'decimal': {
        const coefficient = typeof value.unscaled === 'string' && /^-?(?:0|[1-9][0-9]{0,37})$/.exec(value.unscaled);
        check(coefficient && coefficient[0] === value.unscaled, 'Invalid Server DECIMAL coefficient');
        return new Decimal(BigInt(value.unscaled), value.scale);
    }
    case 'text':
    case 'date':
    case 'time':
        if (value.t === 'date' || sqlType === 'DATE') return DateValue.parse(value.v);
        if (value.t === 'time' || sqlType === 'TIME') return TimeValue.parse(value.v);
        check(validText(value.v), 'Invalid Server TEXT');
        return value.v;
    case 'binary': {
        const hex = typeof value.hex === 'string' && /^(?:[0-9a-f]{2})*$/.exec(value.hex);
        check(hex && hex[0] === value.hex, 'Invalid Server BLOB');
        return Buffer.from(value.hex, 'hex');
    }
    case 'timestamp':
        return new TimestampValue(wireInteger(value.seconds), value.nanos, value.offset_minutes, value.zone ?? undefined);
    case 'record':
        check(Array.isArray(value.fields) && value.fields.length <= 128, 'Invalid Server RECORD fields');
        return new RecordValue(value.fields.map(field => [field.name, decodeValue(field.value, undefined, depth + 1, nodes)]));
    case 'collection':
        check(Array.isArray(value.items) && value.items.length <= 128, 'Invalid Server COLLECTION items');
        return new Collection(value.items.map(item => decodeValue(item, undefined, depth + 1, nodes)));
    default:
        throw new TypeError('Unsupported Server result value type');
    }
}
