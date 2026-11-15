# StarDataParadise SDK for Node.js

Version 0.1.0 targets Node.js 22 and later and StarDataParadise Server 0.3.0 running wire v1 over TLS. The package uses Node built-ins at runtime. It includes the immutable Server contract and exposes the embedded archive through the contractPath export.

Install the local npm tarball with npm install ./stardataparadise-sdk-0.1.0.tgz.

## SQL

This example uses an existing orders table. Set SDP_USER, SDP_PASSWORD and SDP_CA in the process environment. The CA file establishes trust in the Server certificate. The TLS identity defaults to the connection host. Set tlsName to the matching certificate name when routing to a different address.

~~~js
import { Bind, connect } from 'stardataparadise-sdk';

const database = await connect({
  host: '127.0.0.1',
  port: 7443,
  tlsName: 'localhost',
  caFile: process.env.SDP_CA,
  user: process.env.SDP_USER,
  password: process.env.SDP_PASSWORD,
});
try {
  const result = await database.execute(
    'SELECT id, note FROM orders WHERE id >= :first ORDER BY id',
    { first: 7n },
  );
  try {
    for await (const [id, note] of result) console.log(id, note);
  } finally {
    await result.close();
  }
  await database.execute(
    'UPDATE orders SET note = :note WHERE id = :id',
    { id: 7n, note: Bind(null, 'TEXT') },
  );
  await database.commit();
} finally {
  await database.close();
}
~~~

execute prepares the SQL with Server-side named parameter declarations, sends values separately, and returns the result. A connection has one active operation and one active result. Results support fetchOne, fetchMany, fetchAll, nextSet, async iteration and close. fetchOne returns null at the end of the current set. Columns are available in result.columns, affected write rows in result.affectedRows, and named PL/SQL cursor sets in result.setName after fetching. Consume rows incrementally with fetchMany or async iteration to bound memory. CALL returns an OUT set followed by emitted cursor sets. Commonly used scalar values are booleans, strings, buffers and BigInt. Decimal.parse preserves the decimal mantissa and scale. TimestampValue carries seconds, nanos and offset. RecordValue and Collection preserve nested typed values.

## Transactions and cancellation

Manual transactions start lazily. begin can start one explicitly. commit and rollback finish the current transaction. savepoint, rollbackTo and release accept an identifier inside an active transaction. Closing a connection rolls back its open transaction. A successful autocommit CALL commits when its result is fully consumed or closed. Both connections and results implement Symbol.asyncDispose.

Set timeoutMs for the TLS connection and request deadline. cancel sends a same-identity cancellation request for the current wire request. Run it concurrently with a pending operation. A write or commit can reach durable storage before its acknowledgement reaches the client. OutcomeUnknownError carries requestToken. Call outcome(token) on a healthy authenticated connection to read the durable status. A status of unknown leaves the operation unresolved. The SDK sends each mutation once. retryReads enables one reconnect for an autocommit read that loses its session during preparation.

## Management

Connection methods expose health, metadata, capabilities, history, Decision validation, model prediction, datasets and jobs. The Server enforces capability and permission checks.

~~~js
const history = await database.history('orders', { limit: 20 });
const prediction = await database.predict('sales_forecast', { reading: 17 });
const { job_id } = await database.submitCompute(100);
const job = await database.job(job_id);
~~~

Run npm pack to build the tarball or ci.ps1 to check a clean tarball installation. Pass Server, OpenSsl, and FixtureHarness together to exercise a live Server and the durable commit ledger. The embedded contract archive SHA-256 is e6500900a3fa34910781ea92d5e41fe8716511fac6f6d6c689ff9cce15d578ab.
