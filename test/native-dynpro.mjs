import assert from 'node:assert/strict';
import {NativeDynproRuntime} from '../tools/osd-native-dynpro.mjs';

const cell = value => ({get:() => value, set:next => { value = next?.get ? next.get() : next; }});
function runtime() {
  const sy = {dynnr:cell('0000'),ucomm:cell(''),pfkey:cell(''),subrc:cell(0)};
  return new NativeDynproRuntime({builtin:{sy:cell(sy)}, compare:{initial:value => !String(value.get()).trim()}});
}
const mod = (phase,name) => ({kind:'module',phase,name});
function define(engine, program, screens) {
  engine.defineProgram({programName:program,
    screens:screens.map(s => ({elements:[],nextScreen:'0000',...s})),
    flowLogic:screens.map(s => ({screen:s.number,steps:s.steps ?? []}))});
}

describe('native dynpro call stack', () => {
  it('preserves configured profile read values, return codes and untouched failure targets', () => {
    const engine=runtime(),target=cell('before');
    const configuration={'demo/success':{subrc:0,value:'configured'},'demo/missing':{subrc:8}};
    engine.setProfileParameters(configuration);
    configuration['demo/success'].value='changed after configuration';
    engine.profileParameter(cell('demo/success   '),target);
    assert.equal(target.get(),'configured');
    assert.equal(engine.system('subrc'),0);
    engine.profileParameter(cell('demo/missing'),target);
    assert.equal(target.get(),'configured');
    assert.equal(engine.system('subrc'),8);
    assert.throws(() => engine.profileParameter('demo/unconfigured',target),/not configured/);
    assert.throws(() => engine.setProfileParameters({}),/fixed/);
    assert.throws(() => runtime().setProfileParameters({'demo/invalid':{subrc:0}}),/Invalid profile/);
  });

  it('suspends inside a nested group and returns to the original caller', async () => {
    const engine = runtime(), trace = [];
    define(engine,'SAPLZOUTER',[{number:'100',steps:[mod('pbo','open'),mod('pai','finish')]}]);
    define(engine,'SAPLZINNER',[{number:'100',steps:[mod('pai','close')]}]);
    engine.registerModule('SAPLZOUTER','pbo','open',async () => {
      trace.push('outer before');
      await engine.callScreen('SAPLZINNER',100);
      trace.push('outer after');
    });
    engine.registerModule('SAPLZINNER','pai','close',async () => { trace.push('inner'); engine.leaveScreen(0); });
    engine.registerModule('SAPLZOUTER','pai','finish',async () => { trace.push('outer input'); engine.leaveScreen(0); });
    const inner = await engine.start(async () => { await engine.callScreen('SAPLZOUTER',100); return 'returned'; });
    assert.equal(inner.program,'SAPLZINNER');
    assert.deepEqual(trace,['outer before']);
    const outer = await engine.resume({revision:inner.revision,command:'BACK'});
    assert.equal(outer.program,'SAPLZOUTER');
    assert.deepEqual(trace,['outer before','inner','outer after']);
    assert.throws(() => engine.resume({revision:inner.revision}),/Stale/);
    const result = await engine.resume({revision:outer.revision,command:'BACK'});
    assert.deepEqual(result,{kind:'complete',result:'returned'});
    assert.equal(engine.system('dynnr'),'0000');
    assert.deepEqual(trace,['outer before','inner','outer after','outer input']);
  });

  it('runs suppressed PBO and PAI without displaying an intermediate screen', async () => {
    const engine = runtime(), trace = [];
    define(engine,'SAPLZSTART',[{number:'200',steps:[mod('pbo','start'),mod('pai','start')]}]);
    engine.registerModule('SAPLZSTART','pbo','start',async () => { trace.push('pbo'); engine.suppressDialog(); });
    engine.registerModule('SAPLZSTART','pai','start',async () => { trace.push('pai'); engine.leaveScreen(0); });
    const event = await engine.start(() => engine.callScreen('SAPLZSTART',200));
    assert.equal(event.kind,'complete');
    assert.deepEqual(trace,['pbo','pai']);
    assert.equal(engine.revision,0);
  });

  it('transports fields at their flow position and rejects unseen fields', async () => {
    const engine = runtime(), value = cell('before'), command = cell(''), seen = [];
    define(engine,'SAPLZFORM',[{number:'100',okCode:'COMMAND',
      elements:[{name:'VALUE',kind:'input',input:true,output:true},{name:'COMMAND',kind:'okcode',input:true}],
      steps:[mod('pai','before'),{kind:'field',phase:'pai',field:'VALUE'},mod('pai','after')]}]);
    engine.registerModule('SAPLZFORM','pai','before',async () => { seen.push(value.get()); },{VALUE:() => value,COMMAND:() => command});
    engine.registerModule('SAPLZFORM','pai','after',async () => { seen.push(value.get()); engine.leaveScreen(0); });
    const screen = await engine.start(() => engine.callScreen('SAPLZFORM',100));
    assert.equal(screen.screen.elements[0].value,'before');
    assert.throws(() => engine.resume({revision:screen.revision,fields:{UNKNOWN:'x'}}),/not writable/);
    assert.throws(() => engine.resume({revision:screen.revision,fields:{COMMAND:'x'}}),/not writable/);
    const result = await engine.resume({revision:screen.revision,command:'SAVE',fields:{VALUE:'after'}});
    assert.equal(result.kind,'complete');
    assert.deepEqual(seen,['before','after']);
    assert.equal(command.get(),'SAVE');
  });

  it('unwinds a cancelled nested stack and permits another transaction', async () => {
    const engine = runtime();
    define(engine,'SAPLZCANCEL',[{number:'100'}]);
    await engine.start(() => engine.callScreen('SAPLZCANCEL',100));
    assert.throws(() => engine.start(() => {}),/one dialog/);
    await engine.cancel();
    const error = await engine.next();
    assert.equal(error.kind,'error');
    assert.match(error.error.message,/cancelled/);
    assert.equal(engine.stack.length,0);
    assert.equal(engine.system('dynnr'),'0000');
    assert.deepEqual(await engine.start(() => 42),{kind:'complete',result:42});
  });

  it('fails explicitly for flow constructs the bridge cannot execute', async () => {
    const engine = runtime();
    define(engine,'SAPLZUNKNOWN',[{number:'100',steps:[{phase:'pbo',kind:'source',source:'LOOP.'}]}]);
    const event = await engine.start(() => engine.callScreen('SAPLZUNKNOWN',100));
    assert.equal(event.kind,'error');
    assert.match(event.error.message,/Unsupported screen flow/);
    assert.equal(engine.stack.length,0);
  });
});
