import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import runtime from '@abaplint/runtime';
import {modulesOf} from '../tools/osd-transpile.mjs';
import {NativeDynproRuntime} from '../tools/osd-native-dynpro.mjs';

const cell = value => ({get:() => value,set(next) { value=next?.get ? next.get() : next;return this; }});
const scalar = value => value?.get ? value.get() : value;
const mod = (phase,name,extra={}) => ({kind:'module',phase,name,...extra});
const field = (name,module) => ({kind:module ? 'field-module' : 'field',phase:'pai',field:name,name:module});
function fixture(steps) {
  const sy=Object.fromEntries(['dynnr','ucomm','pfkey','subrc','msgty','msgid','msgno'].map(name => [name,cell('')]));
  const abap={builtin:{sy:cell(sy)},compare:{initial:value => !value.get()},
    types:{String:class { constructor() { return cell(''); } }},
    ClassicError:class extends Error { constructor({classic}) { super(classic);this.classic=classic; } },
    statements:{async message(options) {
      sy.msgty.set(scalar(options.type));sy.msgid.set(scalar(options.id) ?? '');sy.msgno.set(scalar(options.number) ?? '');
      options.into.set(options.exceptionOrText ?? 'message');
    }}};
  const engine=new NativeDynproRuntime(abap), values={A:cell(''),B:cell(''),C:cell('')};
  engine.defineProgram({programName:'ZFORM',screens:[{number:'100',nextScreen:'0',
    elements:Object.keys(values).map(name => ({name,kind:'input',input:true,output:true}))}],
    flowLogic:[{screen:'100',steps}]});
  engine.registerModule('ZFORM','pbo','BIND',async () => {},Object.fromEntries(Object.entries(values).map(([key,value]) => [key,() => value])));
  return {engine,values};
}
const send = (engine,type,raising) => engine.message({type,raising,exceptionOrText:cell(`message ${type}`)});

describe('native MESSAGE dialog behavior', () => {
  it('restarts the failed CHAIN, enables every field in it and does not rerun PBO', async () => {
    const steps=[mod('pbo','PBO'),mod('pai','BEFORE'),{kind:'chain-begin',phase:'pai'},
      field('A'),mod('pai','CHECK'),field('B'),{kind:'chain-end',phase:'pai'},mod('pai','AFTER')];
    const {engine,values}=fixture(steps),trace=[];
    engine.registerModule('ZFORM','pbo','PBO',async () => { trace.push('pbo'); });
    engine.registerModule('ZFORM','pai','BEFORE',async () => { trace.push('before'); });
    engine.registerModule('ZFORM','pai','CHECK',async () => {
      trace.push('check');
      if (values.A.get() !== 'ok') await send(engine,'E');
      trace.push('accepted');
    });
    engine.registerModule('ZFORM','pai','AFTER',async () => { trace.push('after'); });
    const screen=await engine.start(() => engine.callScreen('ZFORM',100));
    const error=await engine.resume({revision:screen.revision,fields:{A:'bad',B:'pending',C:'retained'}});
    assert.equal(error.message.type,'E');
    assert.deepEqual(error.screen.elements.filter(e => e.input).map(e => e.name),['A','B']);
    assert.deepEqual(trace,['pbo','before','check']);
    assert.throws(() => engine.resume({revision:error.revision,fields:{C:'forged'}}),/not writable/);
    assert.equal((await engine.resume({revision:error.revision,fields:{A:'ok'}})).kind,'complete');
    assert.deepEqual(trace,['pbo','before','check','check','accepted','after']);
    assert.equal(values.B.get(),'pending');
    assert.equal(values.C.get(),'retained');
  });
  it('repeats earlier validation for a changed field that appears in multiple FIELD statements', async () => {
    const {engine,values}=fixture([field('A','FIRST'),field('A','SECOND')]),trace=[];
    engine.registerModule('ZFORM','pai','FIRST',async () => { trace.push(`first:${values.A.get()}`); });
    engine.registerModule('ZFORM','pai','SECOND',async () => {
      trace.push(`second:${values.A.get()}`);
      if (values.A.get() === 'bad') await send(engine,'E');
    });
    const screen=await engine.start(() => engine.callScreen('ZFORM',100));
    const error=await engine.resume({revision:screen.revision,fields:{A:'bad'}});
    await engine.resume({revision:error.revision,fields:{A:'ok'}});
    assert.deepEqual(trace,['first:bad','second:bad','first:ok','second:ok']);
  });
  it('acknowledges an unchanged warning at its suspended statement', async () => {
    const {engine}=fixture([field('A','CHECK')]),trace=[];
    engine.registerModule('ZFORM','pai','CHECK',async () => { trace.push('before');await send(engine,'W');trace.push('after'); });
    const screen=await engine.start(() => engine.callScreen('ZFORM',100));
    const warning=await engine.resume({revision:screen.revision,fields:{A:'review'}});
    assert.equal(warning.message.type,'W');
    assert.deepEqual(trace,['before']);
    assert.equal((await engine.resume({revision:warning.revision})).kind,'complete');
    assert.deepEqual(trace,['before','after']);
  });
  it('runs exit commands before transporting screen input, including during error correction', async () => {
    const {engine,values}=fixture([mod('pbo','STATUS'),mod('pai','EXIT',{atExitCommand:true}),field('A','CHECK')]);
    engine.programs.get('ZFORM').guiStatuses={MAIN:{functions:[{code:'BACK',type:'E'}]}};
    engine.registerModule('ZFORM','pbo','STATUS',async () => engine.setStatus('ZFORM','MAIN'));
    const seen=[];
    engine.registerModule('ZFORM','pai','EXIT',async () => { seen.push(values.A.get());engine.leaveScreen(0); });
    engine.registerModule('ZFORM','pai','CHECK',async () => send(engine,'E'));
    let screen=await engine.start(() => engine.callScreen('ZFORM',100));
    assert.equal((await engine.resume({revision:screen.revision,command:'BACK',fields:{A:'not transported'}})).kind,'complete');
    assert.deepEqual(seen,['']);
    screen=await engine.start(() => engine.callScreen('ZFORM',100));
    const error=await engine.resume({revision:screen.revision,fields:{A:'bad'}});
    assert.equal((await engine.resume({revision:error.revision,command:'BACK',fields:{A:'not transported'}})).kind,'complete');
    assert.deepEqual(seen,['','bad']);
  });
  it('pauses information messages and unwinds a cancelled message wait', async () => {
    const {engine}=fixture([]),trace=[];
    const message=await engine.start(async () => { await send(engine,'I');trace.push('after'); });
    assert.equal(message.kind,'message');assert.deepEqual(trace,[]);
    assert.throws(() => engine.resume({revision:message.revision,fields:{A:'no'}}),/not writable/);
    assert.equal((await engine.resume({revision:message.revision})).kind,'complete');
    assert.deepEqual(trace,['after']);
    await engine.start(() => send(engine,'I'));
    await engine.cancel();
    assert.equal((await engine.next()).kind,'error');
  });
  it('formats INTO without a pause and never continues after an abort', async () => {
    const {engine}=fixture([]),target=cell(''),trace=[];
    await engine.message({type:'E',into:target,exceptionOrText:cell('text')});
    assert.equal(target.get(),'text');
    for (const type of ['A','X']) {
      const event=await engine.start(async () => { await send(engine,type);trace.push('after'); });
      assert.equal(event.kind,'error');assert.equal(event.error.code,`MESSAGE_TYPE_${type}`);
    }
    assert.deepEqual(trace,[]);
  });
  it('handles RAISING only for the immediate procedure and propagates ERROR_MESSAGE to its function', async () => {
    const {engine}=fixture([]), key=Symbol.for('osd.native.exceptions');
    const outer=engine.enterProcedure('function',{[key]:['ERROR_MESSAGE']});
    const method=engine.enterProcedure('method',{[key]:['DENIED']});
    try { await assert.rejects(send(engine,'S','DENIED'),error => error.classic === 'denied'); }
    finally { engine.leaveProcedure(method); }
    const nested=engine.enterProcedure('method');
    try {
      await send(engine,'S','DENIED'); // ignored by the outer ERROR_MESSAGE handler
      assert.equal(engine.statusMessage,undefined);
      let forwarded;
      try { await send(engine,'E'); } catch(error) { forwarded=error; }
      assert.throws(() => engine.procedureError(nested,forwarded),error => error === forwarded);
      assert.throws(() => engine.procedureError(outer,forwarded),error => error.classic === 'error_message');
    } finally { engine.leaveProcedure(nested);engine.leaveProcedure(outer); }
    assert.equal(engine.procedures.length,0);
  });
});

async function compile(files,nativeDynpro=true) {
  const {core,Transpiler}=modulesOf(fileURLToPath(new URL('../',import.meta.url)));
  const registry=new core.Registry();
  for (const [filename,contents] of Object.entries(files)) registry.addFile(new core.MemoryFile(filename,contents));
  return new Transpiler({nativeDynpro,skipVersionCheck:true}).run(registry);
}
async function execute(result) {
  const saved=globalThis.abap;
  try {
    globalThis.abap=new runtime.ABAP({console:new runtime.MemoryConsole()});
    const engine=new NativeDynproRuntime(abap);
    abap.MSAG.ZMSG={'001':'Denied'};
    const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
    for (const object of [...result.objects.filter(item => item.object.type !== 'PROG'),...result.objects.filter(item => item.object.type === 'PROG')]) {
      await new AsyncFunction(object.chunk.getCode())();
    }
    return {text:abap.console.get(),procedures:engine.procedures.length,status:engine.statusMessage};
  } finally { globalThis.abap=saved; }
}
describe('native MESSAGE compiler metadata', () => {
  it('stops explicitly if execution reaches unavailable list or transaction dispatch', async () => {
    const result=await compile({'zmessage.prog.abap':`REPORT zmessage.
LEAVE TO LIST-PROCESSING.
WRITE 'must not continue'.`});
    await assert.rejects(execute(result),error => error.code === 'NATIVE_UNSUPPORTED_STATEMENT');
    const transaction=await compile({'zmessage.prog.abap':`REPORT zmessage.
LEAVE TO TRANSACTION 'ZOTHER'.
WRITE 'must not continue'.`});
    await assert.rejects(execute(transaction),error => error.code === 'NATIVE_UNSUPPORTED_STATEMENT');
    const dialog=await compile({'zmessage.prog.abap':`REPORT zmessage.
CALL DIALOG 'ZOTHER'.
WRITE 'must not continue'.`});
    await assert.rejects(execute(dialog),error => error.code === 'NATIVE_UNSUPPORTED_STATEMENT');
  });
  it('fails at an unavailable asynchronous call without changing the synchronous branch', async () => {
    const source=`REPORT zmessage.
DATA background TYPE abap_bool VALUE abap_false.
IF background = abap_true.
  CALL FUNCTION 'Z_NO_ASYNC_TASK' STARTING NEW TASK 'T'.
ENDIF.
WRITE 'synchronous'.`;
    assert.equal((await execute(await compile({'zmessage.prog.abap':source}))).text,'synchronous');
    await assert.rejects(execute(await compile({'zmessage.prog.abap':source.replace('VALUE abap_false','VALUE abap_true')})),
      error => error.code === 'NATIVE_UNSUPPORTED_STATEMENT');
  });
  it('carries classic exception handlers through parenthesized calls and RECEIVING', async () => {
    const result=await compile({'zmessage.prog.abap':`REPORT zmessage.
CLASS lcl_check DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS check RETURNING VALUE(result) TYPE i EXCEPTIONS denied.
    CLASS-METHODS signal EXCEPTIONS denied.
ENDCLASS.
CLASS lcl_check IMPLEMENTATION.
  METHOD check.
    ASSERT result IS SUPPLIED.
    MESSAGE 'denied' TYPE 'S' RAISING denied.
    result = 99.
  ENDMETHOD.
  METHOD signal.
    MESSAGE 'denied' TYPE 'S' RAISING denied.
    WRITE 'unhandled'.
  ENDMETHOD.
ENDCLASS.
DATA result TYPE i VALUE 12.
CONSTANTS rejected TYPE i VALUE 4.
lcl_check=>check( RECEIVING result = result EXCEPTIONS denied = rejected ).
ASSERT sy-subrc = 4.
ASSERT result = 12.
lcl_check=>signal( EXCEPTIONS OTHERS = 7 ).
ASSERT sy-subrc = 7.
lcl_check=>signal( ).`});
    const outcome=await execute(result);
    assert.equal(outcome.text,'unhandled');assert.equal(outcome.procedures,0);
  });
  it('preserves a default MESSAGE-ID and handled/unhandled RAISING with early return cleanup', async () => {
    const result=await compile({'zmessage.prog.abap':`REPORT zmessage MESSAGE-ID zmsg.
CLASS lcl_check DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS check EXCEPTIONS denied.
ENDCLASS.
CLASS lcl_check IMPLEMENTATION.
  METHOD check.
    MESSAGE s001 RAISING denied.
    WRITE 'continued'.
    RETURN.
  ENDMETHOD.
ENDCLASS.
CALL METHOD lcl_check=>check EXCEPTIONS denied = 4.
ASSERT sy-subrc = 4.
CALL METHOD lcl_check=>check.
WRITE 'done'.`});
    const outcome=await execute(result);
    assert.equal(outcome.text,'continueddone');
    assert.equal(outcome.procedures,0);
    assert.equal(outcome.status.id.trim(),'ZMSG');
    assert.equal(outcome.status.text,'Denied');
  });
  it('propagates a nested method message to the calling function ERROR_MESSAGE handler', async () => {
    const result=await compile({
      'zmessages.fugr.xml':`<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>
<INCLUDES><SOBJ_NAME>SAPLZMESSAGES</SOBJ_NAME></INCLUDES><FUNCTIONS><item><FUNCNAME>ZMESSAGES_CALL</FUNCNAME></item></FUNCTIONS>
</asx:values></asx:abap></abapGit>`,
      'zmessages.fugr.saplzmessages.abap':`FUNCTION-POOL zmessages.
CLASS lcl_check DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS check EXCEPTIONS denied.
ENDCLASS.
CLASS lcl_check IMPLEMENTATION.
  METHOD check.
    MESSAGE 'stop' TYPE 'E'.
    WRITE 'wrong-method'.
  ENDMETHOD.
ENDCLASS.`,
      'zmessages.fugr.zmessages_call.abap':`FUNCTION zmessages_call.
CALL METHOD lcl_check=>check EXCEPTIONS OTHERS = 9.
WRITE 'wrong-function'.
ENDFUNCTION.`,
      'zconsumer.prog.abap':`REPORT zconsumer.
CALL FUNCTION 'ZMESSAGES_CALL' EXCEPTIONS error_message = 7.
ASSERT sy-subrc = 7.
WRITE 'caught'.`,
    });
    const outcome=await execute(result);
    assert.equal(outcome.text,'caught');assert.equal(outcome.procedures,0);
  });
  it('does not swallow an unmatched classic exception', async () => {
    const result=await compile({'zmessage.prog.abap':`REPORT zmessage.
CLASS lcl_check DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS check EXCEPTIONS denied other.
ENDCLASS.
CLASS lcl_check IMPLEMENTATION.
  METHOD check.
    RAISE other.
  ENDMETHOD.
ENDCLASS.
CALL METHOD lcl_check=>check EXCEPTIONS denied = 4.`});
    await assert.rejects(execute(result),error => error.classic === 'other');
  });
});
