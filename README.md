# StarDataParadise SDK for Node.js

Version 0.2.0 targets Node.js 22 and later and StarDataParadise Server 0.5.0 running wire v1 over TLS. The package uses Node built-ins at runtime. It includes the immutable Server contract and exposes the embedded archive through the contractPath export.

## Install

Use the 0.2.0 tarball from your distribution or build it with the commands below. From your application directory, point npm to the downloaded or built package.

~~~powershell
npm install C:/SDP/packages/stardataparadise-sdk-0.2.0.tgz
~~~

Save the example as `query.mjs` and run it with `node query.mjs`. Node also treats `.js` examples as modules when the application declares `"type": "module"` in `package.json`.

## SQL

This example reads and updates an existing `orders(id, note)` table. The account needs SELECT and UPDATE permissions. Set `SDP_USER`, `SDP_PASSWORD`, and `SDP_CA` in the process environment. The CA file establishes trust in the Server certificate. The TLS identity defaults to the connection host. Set tlsName to the matching certificate name when routing to a different address.

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

Manual commit is the default and transactions start lazily. Call `commit()` before closing the connection if you want to keep a write. begin can start one explicitly. commit and rollback finish the current transaction. savepoint, rollbackTo and release accept an identifier inside an active transaction. Closing a connection rolls back its open transaction. A successful autocommit CALL commits when its result is fully consumed or closed. Both connections and results implement Symbol.asyncDispose.

Set timeoutMs for the TLS connection and request deadline. cancel sends a same-identity cancellation request for the current wire request. Run it concurrently with a pending operation. A write or commit can reach durable storage before its acknowledgement reaches the client. OutcomeUnknownError carries requestToken. Call outcome(token) on a healthy authenticated connection to read the durable status. A status of unknown leaves the operation unresolved. The SDK sends each mutation once. retryReads enables one reconnect for an autocommit read that loses its session during preparation.

## Management

Existing wire management methods expose health, metadata, capabilities, history, Decision validation, model prediction, datasets and compute/jobs. The Server enforces capability and permission checks.

~~~js
const history = await database.history('orders', { limit: 20 });
const prediction = await database.predict('sales_forecast', { reading: 17 });
const { job_id } = await database.submitCompute(100);
const job = await database.job(job_id);
~~~

## Build and test

Run these commands from the SDK repository with Node.js 22 or later.

~~~powershell
npm test
pwsh -NoProfile -File .\ci.ps1
~~~

CI checks the embedded wire contract, runs the Node tests, creates `out/packages/stardataparadise-sdk-0.2.0.tgz`, and verifies it in a separate consumer directory. Pass `-Server`, `-OpenSsl`, and `-FixtureHarness` together to exercise a live Server and the durable commit ledger. The embedded contract archive SHA-256 is `e6500900a3fa34910781ea92d5e41fe8716511fac6f6d6c689ff9cce15d578ab`.

[Server setup and other SDKs](https://github.com/ParadiseIncDevelopers/StarDataParadiseServer) · [Installed-package acceptance example](tests/acceptance.mjs)

## Native SQL and AI

`connectNative()` opens a dedicated session on a server advertising
`native_sql_v1`; its default is autocommit. Bind values with positional `?`
markers. An entire stored procedure body is one statement.

```js
import { connectNative } from 'stardataparadise-sdk';

const db = await connectNative({ user: process.env.SDP_USER,
  password: process.env.SDP_PASSWORD, caFile: process.env.SDP_CA,
  tlsName: 'localhost' });
try {
  await db.execute('START AI CONVERSATION app.assistant'); // Existing conversation.
  await db.execute('APPEND PROMPT ?', ['Summarize the approved context.']);
  await db.execute('APPEND RESPONSE INTO @answer AS JSON RETURNING METADATA INTO @meta');
  await db.commit({ waitTimeoutMs: 20000 });
  const result = await db.execute('SELECT @answer,@meta');
  console.log(result.sets[0].rows[0].map(value => value.text));
} finally { await db.close(); }
```

Model definitions can use OpenAI, Claude or an imported local GGUF runtime.
Credentials remain in the worker's owner-bound store. Use
`commit({asynchronous:true})`, `fetchResponse(runId)` and `cancelRun(runId)` for
durable asynchronous runs.

Native SQL `HIST` (SQLgit branches/remotes) and SQL `JOB` scheduling are deferred
and are not enabled by this release. Existing wire history and compute/job APIs
remain available under the Server's advertised capabilities; they are separate
from those deferred SQL commands. AI inference and model import keep their internal queue.

Rows preserve integer values as BigInt, exact decimal text as `NativeDecimal`,
JSON source as `NativeJson`, binary data as Buffer, and signed SQL durations as
`NativeTemporal`. Parsing JSON with ordinary `JSON.parse` can round large
numbers; retain `NativeJson.text` when exact digits matter. Results expose
`sets`, `columns`, `rows` and affected-row metadata. Large results use verified
chunks within the server's bound.

Native statements are sent once. A wait error may report `commitState` and
`runId` for already committed work; fetch the run instead of repeating business
SQL. A native transport failure may have an uncertain outcome without a legacy
CRUD receipt token. No native statement is automatically reconnected or retried.
The existing `connect()` API retains its transaction and receipt behavior.
