export class SdpError extends Error {
  constructor(message, {code, sqlstate, requestToken, unknownOutcome = false, cause, correlationId, line, column, nativeErrno, phase, commitState, runState, runId, retry, callId, actionCommitState, causeNativeErrno, causeSqlstate} = {}) {
    super(message, {cause});
    this.name = new.target.name;
    this.code = code;
    this.sqlstate = sqlstate;
    this.requestToken = requestToken;
    this.unknownOutcome = unknownOutcome;
    this.correlationId = correlationId;
    this.line = line;
    this.column = column;
    this.nativeErrno=nativeErrno; this.phase=phase; this.commitState=commitState;
    this.runState=runState; this.runId=runId; this.retry=retry;
    this.callId=callId; this.actionCommitState=actionCommitState;
    this.causeNativeErrno=causeNativeErrno; this.causeSqlstate=causeSqlstate;
  }
}

export class OutcomeUnknownError extends SdpError {
  constructor(message = 'The write outcome is unknown. Resolve the request token on a new connection.', options = {}) {
    super(message, {...options, unknownOutcome: true});
  }
}
