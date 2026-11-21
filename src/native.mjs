import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
import {Wire} from './wire.mjs';
import {SdpError, OutcomeUnknownError} from './errors.mjs';
import {Decimal} from './types.mjs';

const utf8=new TextDecoder('utf-8',{fatal:true});
const key=value=>{
  if(typeof value!=='string'||!/^[0-9a-f]{32}$/.test(value)) throw new TypeError('Expected 32 lowercase hexadecimal digits');
  return value;
};

export class NativeJson {
  constructor(text) {
    if(typeof text!=='string'||!text.isWellFormed()) throw new TypeError('Native JSON requires valid serialized text');
    JSON.parse(text); // Validate syntax; retain the original digits, not parsed JS Numbers.
    this.text=text; Object.freeze(this);
  }
  toString(){return this.text;}
}

export class NativeDecimal {
  constructor(text) {
    if(typeof text!=='string'||!/^\-?(?:0|[1-9][0-9]{0,64})(?:\.[0-9]{1,30})?$/.test(text)) throw new TypeError('Invalid native DECIMAL');
    const [whole,fraction='']=text.split('.');
    const digits=(whole.replace('-','')+fraction).replace(/^0+/,'');
    if(digits.length>65) throw new RangeError('Native DECIMAL exceeds 65 digits');
    this.text=text; this.scale=fraction.length; this.unscaled=BigInt(whole+fraction); Object.freeze(this);
  }
  toString(){return this.text;}
}

export class NativeTemporal {
  constructor(sqlType,text){this.sqlType=sqlType;this.text=text;Object.freeze(this);}
  toString(){return this.text;}
}

export function encodeNative(value) {
  if(value===null)return {t:'null'};
  if(value instanceof NativeJson)return {t:'json',v:value.text};
  if(value instanceof NativeDecimal||value instanceof Decimal)return {t:'decimal',v:value.toString()};
  if(value instanceof NativeTemporal)return {t:'text',v:value.text};
  if(typeof value==='boolean')return {t:'bool',v:value};
  if(typeof value==='bigint'){
    if(value<-(1n<<63n)||value>=(1n<<64n)) throw new RangeError('Native BIGINT is outside its SQL range');
    return {t:value<(1n<<63n)?'i64':'u64',v:String(value)};
  }
  if(typeof value==='number'){
    if(!Number.isFinite(value))throw new TypeError('Native number must be finite');
    if(Number.isInteger(value)){
      if(!Number.isSafeInteger(value))throw new TypeError('Use bigint for an exact large integer');
      return encodeNative(BigInt(value));
    }
    return {t:'float',v:String(value)};
  }
  if(typeof value==='string'&&value.isWellFormed())return {t:'text',v:value};
  if(Buffer.isBuffer(value)||value instanceof Uint8Array)return {t:'binary',v:Buffer.from(value).toString('hex')};
  throw new TypeError('Unsupported native SQL binding');
}

function decodeNative(value,column) {
  switch(value.t){
    case 'null':return null;
    case 'i64':case 'u64':return BigInt(value.v);
    case 'decimal':return new NativeDecimal(value.v);
    case 'float':{
      const result=Number(value.v);if(!Number.isFinite(result))throw new TypeError('Invalid native float');return result;
    }
    case 'json':return new NativeJson(value.v);
    case 'binary':{
      const result=Buffer.from(value.v,'hex');if(result.toString('hex')!==value.v)throw new TypeError('Invalid binary');return result;
    }
    case 'date':case 'time':case 'datetime':return new NativeTemporal(column.type,value.v);
    case 'text':return value.v;
    default:throw new TypeError('Unsupported native result tag');
  }
}

export class NativeConnection {
  #wire;#timeoutMs;#closed=false;#busy=false;#inTransaction=false;#autocommit;
  constructor(wire,timeoutMs,autocommit){this.#wire=wire;this.#timeoutMs=timeoutMs;this.#autocommit=autocommit;}
  get inTransaction(){return this.#inTransaction;}
  get autocommit(){return this.#autocommit;}
  get sessionId(){return this.#wire.sessionId;}

  async execute(sql,parameters=[],{maxRows=1000}={}){
    if(this.#closed||this.#busy)throw new SdpError('Native session is closed or busy',{code:1013,sqlstate:'25000'});
    if(typeof sql!=='string'||!sql||sql.includes('\0')||!sql.isWellFormed()||!Array.isArray(parameters))throw new TypeError('Native SQL requires text and positional ? bindings');
    if(!Number.isInteger(maxRows)||maxRows<1||maxRows>10000)throw new RangeError('maxRows is outside 1..10000');
    const body={sql,parameters:parameters.map(encodeNative),max_rows:maxRows,timeout_ms:Math.min(300000,Math.max(1000,this.#timeoutMs-2000))};
    this.#busy=true;
    try{
      let result=await this.#wire.call('native.execute',body,undefined,true);
      try{
        if(Object.hasOwn(result,'native_result')){
          const first=result.native_result;
          if(!Number.isInteger(first.total_bytes)||first.total_bytes<1||first.total_bytes>16*1024*1024||!/^[0-9a-f]{64}$/.test(first.sha256))throw new TypeError();
          const payload=Buffer.alloc(first.total_bytes);let offset=0;
          for(;;){
            const part=result.native_result;
            if(part.id!==first.id||part.offset!==offset||part.total_bytes!==payload.length||part.sha256!==first.sha256)throw new TypeError();
            const bytes=Buffer.from(part.chunk,'base64');
            if(!bytes.length||bytes.toString('base64')!==part.chunk||offset+bytes.length>payload.length)throw new TypeError();
            bytes.copy(payload,offset);offset+=bytes.length;
            if(part.end===true)break;
            if(part.end!==false)throw new TypeError();
            result=await this.#wire.call('native.fetch',{result_id:first.id,offset},undefined,true);
          }
          if(offset!==payload.length||createHash('sha256').update(payload).digest('hex')!==first.sha256)throw new TypeError();
          result=JSON.parse(utf8.decode(payload));
        }
        if(typeof result.in_transaction!=='boolean'||typeof result.autocommit!=='boolean'||!Array.isArray(result.sets))throw new TypeError();
        const sets=result.sets.map(part=>Object.freeze({columns:part.columns,
          rows:part.rows.map(row=>row.map((value,i)=>decodeNative(value,part.columns[i]))),
          affectedRows:BigInt(part.affected_rows),lastInsertId:BigInt(part.last_insert_id??'0')}));
        this.#inTransaction=result.in_transaction;this.#autocommit=result.autocommit;
        return Object.freeze({sets,inTransaction:this.#inTransaction,autocommit:this.#autocommit});
      }catch(error){
        if(error instanceof SdpError)throw error;
        this.close();throw new OutcomeUnknownError('Malformed native result; query the run/outcome before retrying',{commitState:'unknown',cause:error});
      }
    }finally{this.#busy=false;}
  }
  begin(){return this.execute('START TRANSACTION');}
  rollback(){return this.execute('ROLLBACK');}
  commit({requestKey,waitTimeoutMs,asynchronous=false}={}){
    if(typeof asynchronous!=='boolean'||(asynchronous&&waitTimeoutMs!==undefined))throw new TypeError('ASYNC cannot capture or wait for a response');
    const pairs=[],values=[];
    if(requestKey!==undefined){pairs.push('request_key=?');values.push(key(requestKey));}
    if(waitTimeoutMs!==undefined){
      if(!Number.isInteger(waitTimeoutMs)||waitTimeoutMs<1||waitTimeoutMs>this.#timeoutMs-3000)throw new RangeError('SQL wait deadline must fit inside the connection timeout');
      pairs.push('wait_timeout_ms=?');values.push(waitTimeoutMs);
    }
    return this.execute((asynchronous?'COMMIT ASYNC':'COMMIT')+(pairs.length?' WITH ('+pairs.join(', ')+')':''),values);
  }
  fetchResponse(runId){return this.execute('FETCH RESPONSE FROM RUN ?',[key(runId)]);}
  cancelRun(runId){return this.execute('CANCEL RUN ?',[key(runId)]);}
  close(){if(!this.#closed){this.#closed=true;this.#wire.close();}}
  [Symbol.asyncDispose](){this.close();return Promise.resolve();}
}

export async function connectNative(options={}){
  const {autocommit=true,timeoutMs=75000,...transport}=options;
  if(typeof autocommit!=='boolean')throw new TypeError('autocommit must be a boolean');
  const wire=await Wire.connect({...transport,timeoutMs});
  try{
    if((await wire.call('capabilities')).features.native_sql_v1!==true)throw new SdpError('Server does not advertise native_sql_v1',{code:1004,sqlstate:'0A000'});
    await wire.call('native.open',{autocommit});
    return new NativeConnection(wire,timeoutMs,autocommit);
  }catch(error){wire.close();throw error;}
}
