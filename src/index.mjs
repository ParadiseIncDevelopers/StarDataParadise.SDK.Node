import { fileURLToPath } from 'node:url';

export { connect } from './provider.mjs';
export { SdpError, OutcomeUnknownError } from './errors.mjs';
export { Bind, Decimal, TimestampValue, TimeValue, DateValue, RecordValue, Collection } from './types.mjs';

export const contractPath = fileURLToPath(new URL('../contracts/sdp-contract-v1.zip', import.meta.url));
