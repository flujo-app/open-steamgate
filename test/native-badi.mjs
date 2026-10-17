import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import runtime from '@abaplint/runtime';
import {modulesOf} from '../tools/osd-transpile.mjs';
import {NativeBadiRuntime} from '../tools/osd-native-badi.mjs';
import {NativeDynproRuntime} from '../tools/osd-native-dynpro.mjs';

const cell = value => ({get:() => value, set:next => { value = next; }});
const definition = overrides => ({name:'ZBADI_POLICY',interfaceName:'ZIF_POLICY',singleUse:true,
  instantiation:'new',filters:[],fallbackClass:'ZCL_FALLBACK',implementations:[],...overrides});
function fixture() {
  const calls = [], made = [];
  const abap = {Classes:{ZIF_POLICY:{INTERNAL_TYPE:'INTF'}},statements:{
    checkCreateObjectType(Class,_Interface,name) { assert(Class.IMPLEMENTED_INTERFACES.includes(name)); },
  }};
  for (const name of ['ZCL_FALLBACK','ZCL_PRIMARY','ZCL_DEFAULT']) {
    abap.Classes[name] = class {
      static IMPLEMENTED_INTERFACES = ['ZIF_POLICY'];
      async constructor_() { made.push(name); this.count=0; return this; }
      async zif_policy$apply({total}) { calls.push(name); total.set(total.get()+1); return ++this.count; }
    };
  }
  for (const name of ['CX_BADI_NOT_IMPLEMENTED','CX_BADI_MULTIPLY_IMPLEMENTED','CX_SY_REF_IS_INITIAL']) {
    abap.Classes[name] = class extends Error { async constructor_() { this.name=name; return this; } };
  }
  return {engine:new NativeBadiRuntime(abap),abap,calls,made};
}
const implementation = (name,isDefault=false) => ({name,className:name,isDefault});

describe('native BAdI selection and lifetime', () => {
  it('runs the fallback through fresh objects and preserves changing parameters', async () => {
    const {engine,made,calls} = fixture(), total=cell(4);
    engine.define(definition());
    const first=cell(await engine.get('ZBADI_POLICY')), second=cell(await engine.get('ZBADI_POLICY'));
    assert.notEqual(first.get(),second.get());
    assert.equal(await engine.call(first,'ZBADI_POLICY','APPLY',{total}),1);
    assert.equal(await engine.call(first,'ZBADI_POLICY','APPLY',{total}),2);
    assert.equal(await engine.call(second,'ZBADI_POLICY','APPLY',{total}),1);
    assert.equal(total.get(),7);
    assert.deepEqual(made,['ZCL_FALLBACK','ZCL_FALLBACK']);
    assert.deepEqual(calls,['ZCL_FALLBACK','ZCL_FALLBACK','ZCL_FALLBACK']);
    assert.throws(() => engine.define(definition({name:'ZLATE'})),/after use/);
  });
  it('prefers ordinary implementations to default implementations and fallback', async () => {
    const {engine,made} = fixture();
    engine.define(definition({implementations:[implementation('ZCL_DEFAULT',true),implementation('ZCL_PRIMARY')]}));
    await engine.get('ZBADI_POLICY');
    assert.deepEqual(made,['ZCL_PRIMARY']);
    const fallback=fixture();
    fallback.engine.define(definition({implementations:[implementation('ZCL_DEFAULT',true)]}));
    await fallback.engine.get('ZBADI_POLICY');
    assert.deepEqual(fallback.made,['ZCL_DEFAULT']);
  });
  it('reuses an implementation only within its owning internal session', async () => {
    const {engine,made} = fixture(), total=cell(0);
    engine.define(definition({instantiation:'reuse'}));
    const [first,second]=await Promise.all([engine.get('ZBADI_POLICY'),engine.get('ZBADI_POLICY')]);
    assert.notEqual(first,second);
    assert.equal(await engine.call(cell(first),'ZBADI_POLICY','APPLY',{total}),1);
    assert.equal(await engine.call(cell(second),'ZBADI_POLICY','APPLY',{total}),2);
    assert.deepEqual(made,['ZCL_FALLBACK']);
    const other=fixture();other.engine.define(definition({instantiation:'reuse'}));
    assert.equal(await other.engine.call(cell(await other.engine.get('ZBADI_POLICY')),'ZBADI_POLICY','APPLY',{total}),1);
    await assert.rejects(other.engine.call(cell(first),'ZBADI_POLICY','APPLY',{total}),/foreign/);
  });
  it('dispatches every selected multiple-use implementation and permits an empty selection', async () => {
    const {engine,calls} = fixture(),total=cell(0);
    engine.define(definition({singleUse:false,implementations:[implementation('ZCL_PRIMARY'),implementation('ZCL_DEFAULT')]}));
    await engine.call(cell(await engine.get('ZBADI_POLICY')),'ZBADI_POLICY','APPLY',{total});
    assert.equal(total.get(),2);
    assert.deepEqual(new Set(calls),new Set(['ZCL_PRIMARY','ZCL_DEFAULT']));
    const empty=fixture();empty.engine.define(definition({singleUse:false,fallbackClass:undefined}));
    await empty.engine.call(cell(await empty.engine.get('ZBADI_POLICY')),'ZBADI_POLICY','APPLY',{total});
    assert.equal(total.get(),2);
  });
  it('raises the configured ABAP exception classes for invalid single-use selections', async () => {
    for (const [overrides,expected] of [
      [{fallbackClass:undefined},'CX_BADI_NOT_IMPLEMENTED'],
      [{implementations:[implementation('ZCL_PRIMARY'),implementation('ZCL_DEFAULT')]},'CX_BADI_MULTIPLY_IMPLEMENTED'],
    ]) {
      const {engine,abap,made}=fixture();engine.define(definition(overrides));
      await assert.rejects(engine.get('ZBADI_POLICY'),error => error instanceof abap.Classes[expected]);
      assert.deepEqual(made,[]);
    }
    const {engine,abap}=fixture();
    await assert.rejects(engine.call(cell(undefined),'ZBADI_POLICY','APPLY'),error => error instanceof abap.Classes.CX_SY_REF_IS_INITIAL);
  });
  it('rejects missing configuration, filters and context-dependent instantiation', async () => {
    const {engine}=fixture();
    await assert.rejects(engine.get('ZBADI_POLICY'),/no runtime configuration/);
    assert.throws(() => engine.define(definition({filters:['COUNTRY']})),/filters/);
    assert.throws(() => engine.define(definition({instantiation:'context'})),/context-dependent/);
    assert.throws(() => engine.define(definition({implementations:undefined})),/complete implementation selection/);
  });
});

const sourceFiles = source => [
  {filename:'zpolicy.enhs.xml',contents:`<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>
<BADI_DATA><ENH_BADI_DATA><BADI_NAME>ZBADI_POLICY</BADI_NAME><INTERFACE_NAME>ZIF_POLICY</INTERFACE_NAME>
</ENH_BADI_DATA></BADI_DATA></asx:values></asx:abap></abapGit>`},
  {filename:'zif_policy.intf.abap',contents:`INTERFACE zif_policy PUBLIC.
METHODS read RETURNING VALUE(result) TYPE i.
METHODS adjust IMPORTING delta TYPE i CHANGING total TYPE i.
ENDINTERFACE.`},
  {filename:'zcl_fallback.clas.abap',contents:`CLASS zcl_fallback DEFINITION PUBLIC FINAL CREATE PUBLIC.
PUBLIC SECTION.
INTERFACES zif_policy.
METHODS constructor.
PRIVATE SECTION.
CLASS-DATA created TYPE i.
DATA ordinal TYPE i.
ENDCLASS.
CLASS zcl_fallback IMPLEMENTATION.
METHOD constructor.
  created = created + 1.
  ordinal = created.
ENDMETHOD.
METHOD zif_policy~read.
  result = ordinal.
ENDMETHOD.
METHOD zif_policy~adjust.
  total = total + delta.
ENDMETHOD.
ENDCLASS.`},
  {filename:'zconsumer.prog.abap',contents:source},
];
const consumer = `REPORT zconsumer.
DATA first TYPE REF TO zbadi_policy.
DATA second TYPE REF TO zbadi_policy.
DATA value TYPE i.
DATA total TYPE i VALUE 4.
GET BADI first.
GET BADI second.
CALL BADI first->read RECEIVING result = value.
ASSERT value = 1.
CALL BADI second->read RECEIVING result = value.
ASSERT value = 2.
CALL BADI first->adjust EXPORTING delta = 5 CHANGING total = total.
ASSERT total = 9.
WRITE 'ok'.`;
async function compile(source,nativeDynpro=true) {
  const {Transpiler,core}=modulesOf(fileURLToPath(new URL('../',import.meta.url)));
  const registry=new core.Registry();
  for (const file of sourceFiles(source)) registry.addFile(new core.MemoryFile(file.filename,file.contents));
  return new Transpiler({skipVersionCheck:true,nativeDynpro}).run(registry);
}

describe('native BAdI compiler adapter', () => {
  it('executes generated GET/CALL BADI with receiving and changing parameters', async () => {
    const result=await compile(consumer), saved=globalThis.abap;
    try {
      globalThis.abap=new runtime.ABAP({console:new runtime.MemoryConsole()});
      new NativeDynproRuntime(abap);
      new NativeBadiRuntime(abap).define(definition());
      const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
      // In-memory synthetic objects have no external dependencies. Preserve the
      // compiler's dependency order and execute the consumer only after loading.
      for (const object of result.objects.filter(o => o.object.type !== 'PROG')) {
        await new AsyncFunction(object.chunk.getCode().replace(/^import .*$/mg,''))();
      }
      const report=result.objects.find(o => o.object.name === 'ZCONSUMER');
      await new AsyncFunction(report.chunk.getCode())();
      assert.equal(abap.console.get(),'ok');
    } finally { globalThis.abap=saved; }
  });
  it('checks the interface method and parameter names instead of accepting a void type', async () => {
    await assert.rejects(compile(consumer.replace('first->read','first->missing')),/not found|Unknown BAdI method/);
    await assert.rejects(compile(consumer.replace('delta = 5','misspelled = 5')),/parameter|Parameter/);
  });
  it('rejects unsupported selection modes and leaves ordinary lowering disabled', async () => {
    await assert.rejects(compile(consumer.replace('GET BADI first.','GET BADI first TYPE (\'ZBADI_POLICY\').')),/Dynamic/);
    await assert.rejects(compile(consumer.replace('GET BADI first.','GET BADI first CONTEXT first.')),/context-dependent/);
    await assert.rejects(compile(consumer,false),/Statement GetBadi not supported/);
  });
});
