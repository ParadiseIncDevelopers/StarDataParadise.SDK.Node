import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createHash} from 'node:crypto';
import {NativeConnection,NativeJson,NativeDecimal,encodeNative} from '../src/native.mjs';
import {Wire} from '../src/wire.mjs';
import {OutcomeUnknownError} from '../src/errors.mjs';

const result=()=>({sets:[{columns:[{name:'doc',type:'JSON'}],rows:[[{t:'json',v:'{"id":9007199254740993}'}]],affected_rows:'0'}],in_transaction:false,autocommit:true});
class Stub{
  calls=[];closed=false;
  async call(...args){this.calls.push(args);return result();}
  close(){this.closed=true;}
}

test('native JSON and extended decimal retain source digits',()=>{
  const json=new NativeJson('{"id":9007199254740993}');
  assert.equal(json.text,'{"id":9007199254740993}');
  const decimal=new NativeDecimal('1234567890123456789012345678901234567890.1234567890');
  assert.equal(decimal.toString(),'1234567890123456789012345678901234567890.1234567890');
  assert.equal(decimal.unscaled,12345678901234567890123456789012345678901234567890n);
  assert.deepEqual(encodeNative(2n**64n-1n),{t:'u64',v:'18446744073709551615'});
  assert.throws(()=>encodeNative(9007199254740993),TypeError);
});

test('native SQL binds values separately and never enables read retry',async()=>{
  const wire=new Stub(),db=new NativeConnection(wire,75000,true);
  const value="'); DELETE FROM sample; --";
  const response=await db.execute('APPEND PROMPT ?',[value]);
  assert.equal(wire.calls.length,1);
  assert.equal(wire.calls[0][1].sql,'APPEND PROMPT ?');
  assert.deepEqual(wire.calls[0][1].parameters,[{t:'text',v:value}]);
  assert.equal(wire.calls[0][3],true);
  assert.equal(response.sets[0].rows[0][0].text,'{"id":9007199254740993}');
});

test('invalid async wait is rejected before execution; key is bound',async()=>{
  const wire=new Stub(),db=new NativeConnection(wire,75000,true);
  assert.throws(()=>db.commit({asynchronous:true,waitTimeoutMs:1}),TypeError);
  assert.equal(wire.calls.length,0);
  await db.commit({asynchronous:true,requestKey:'a'.repeat(32)});
  assert.equal(wire.calls[0][1].sql,'COMMIT ASYNC WITH (request_key=?)');
  assert.deepEqual(wire.calls[0][1].parameters,[{t:'text',v:'a'.repeat(32)}]);
});

test('large native UTF-8 result verifies chunks without repeating SQL',async()=>{
  const value='İğ'.repeat(200000),doc=JSON.stringify({text:value});
  const raw=Buffer.from(JSON.stringify({...result(),sets:[{columns:[{name:'doc',type:'JSON'}],rows:[[{t:'json',v:doc}]],affected_rows:'0'}]}));
  const sha=createHash('sha256').update(raw).digest('hex'),calls=[];
  const wire={close(){},async call(op,body){
    calls.push(op);const offset=op==='native.execute'?0:body.offset,bytes=raw.subarray(offset,offset+256*1024);
    return {native_result:{id:'a'.repeat(32),offset,total_bytes:raw.length,sha256:sha,chunk:bytes.toString('base64'),end:offset+bytes.length===raw.length}};
  }};
  const response=await new NativeConnection(wire,75000,true).execute('HIST SHOW LAST');
  assert.equal(JSON.parse(response.sets[0].rows[0][0].text).text,value);
  assert.equal(calls.filter(op=>op==='native.execute').length,1);
  assert.ok(calls.includes('native.fetch'));
});

test('wire tool rollback keeps cause distinct from native wrapper errno',async()=>{
  class Socket extends EventEmitter{
    destroyed=false;
    write(data){
      const request=JSON.parse(data.subarray(4).toString());
      const raw=Buffer.from(JSON.stringify({v:1,id:request.id,ok:false,error:{
        code:510005,native_errno:61085,sqlstate:'45000',message:'Tool transaction rolled back.',
        retryable:false,unknown_outcome:false,phase:'tool',commit_state:'committed',
        run_id:'a'.repeat(32),call_id:'b'.repeat(32),action_commit_state:'rolled_back',
        cause_native_errno:3024,cause_sqlstate:'HY000'}}));
      const header=Buffer.alloc(4);header.writeUInt32BE(raw.length);
      queueMicrotask(()=>this.emit('data',Buffer.concat([header,raw])));
    }
    destroy(){this.destroyed=true;}
  }
  const wire=new Wire(new Socket(),1000);
  try{
    await assert.rejects(wire.call('native.execute',{sql:'EXECUTE AI TOOL CALL ?'},undefined,true),error=>{
      assert.equal(error.code,510005);assert.equal(error.nativeErrno,61085);
      assert.equal(error.causeNativeErrno,3024);assert.equal(error.causeSqlstate,'HY000');
      assert.equal(error.callId,'b'.repeat(32));assert.equal(error.commitState,'committed');
      assert.equal(error.actionCommitState,'rolled_back');assert.equal(error.unknownOutcome,false);
      return true;
    });
  }finally{wire.close();}
});

test('native transport failure is uncertain even without a CRUD token',async()=>{
  class Socket extends EventEmitter{
    destroyed=false;writes=0;
    write(){this.writes++;throw Error('disconnect');}
    destroy(){this.destroyed=true;}
  }
  const socket=new Socket(),wire=new Wire(socket,1000);
  await assert.rejects(wire.call('native.execute',{sql:'COMMIT'},undefined,true),error=>{
    assert.ok(error instanceof OutcomeUnknownError);
    assert.equal(error.unknownOutcome,true);assert.equal(error.requestToken,undefined);
    return true;
  });
  assert.equal(socket.writes,1);assert.equal(wire.open,false);
});
