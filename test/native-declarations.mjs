import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import * as runtime from '@abaplint/runtime';
import {modulesOf} from '../tools/osd-transpile.mjs';
import {NativeDynproRuntime} from '../tools/osd-native-dynpro.mjs';

describe('native class-pool declarations', () => {
  it('initializes mixed-case nested constants and shares pool data between calls', async () => {
    const {core,Transpiler}=modulesOf(fileURLToPath(new URL('../',import.meta.url)));
    const files={
      'zcl_values.clas.locals_def.abap':`CONSTANTS base TYPE i VALUE 7.
CONSTANTS: BEGIN OF C_Values,
             MixedCase TYPE i VALUE base,
             BEGIN OF Nested,
               Item TYPE i VALUE 3,
               Empty TYPE i VALUE IS INITIAL,
             END OF Nested,
           END OF C_Values.
DATA counter TYPE i.`,
      'zcl_values.clas.abap':`CLASS zcl_values DEFINITION PUBLIC.
  PUBLIC SECTION.
    CLASS-METHODS next RETURNING VALUE(result) TYPE i.
ENDCLASS.
CLASS zcl_values IMPLEMENTATION.
  METHOD next.
    counter = counter + 1.
    result = c_values-mixedcase + c_values-nested-item + c_values-nested-empty + counter.
  ENDMETHOD.
ENDCLASS.`,
    };
    const registry=new core.Registry();
    for (const [filename,contents] of Object.entries(files)) registry.addFile(new core.MemoryFile(filename,contents));
    const result=await new Transpiler({nativeDynpro:true,skipVersionCheck:true}).run(registry);
    assert.equal(result.objects.length,1,'the main class and pool globals share a module');
    const saved=globalThis.abap;
    try {
      globalThis.abap=new runtime.ABAP();
      const engine=new NativeDynproRuntime(abap);
      const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
      for (const object of result.objects) await new AsyncFunction(object.chunk.getCode())();
      assert.equal((await abap.Classes.ZCL_VALUES.next()).get(),11);
      assert.equal((await abap.Classes.ZCL_VALUES.next()).get(),12);
      assert.equal(engine.procedures.length,0);
    } finally { globalThis.abap=saved; }
  });
});

describe('native function-group include scopes', () => {
  it('shares TOP constants and data with function bodies and a following MODULE', async () => {
    const {core,Transpiler}=modulesOf(fileURLToPath(new URL('../',import.meta.url)));
    const files={
      'zpool.fugr.xml':`<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>
<INCLUDES><SOBJ_NAME>SAPLZPOOL</SOBJ_NAME><SOBJ_NAME>LZPOOLTOP</SOBJ_NAME></INCLUDES>
<FUNCTIONS><item><FUNCNAME>ZPOOL_READ</FUNCNAME></item></FUNCTIONS>
</asx:values></asx:abap></abapGit>`,
      'zpool.fugr.saplzpool.abap':`INCLUDE lzpooltop.`,
      'zpool.fugr.lzpooltop.abap':`FUNCTION-POOL zpool.
CONSTANTS yes TYPE abap_bool VALUE abap_true.
DATA counter TYPE i.
DATA zpool_read TYPE i VALUE 5.`,
      'zpool.fugr.zpool_read.abap':`FUNCTION zpool_read.
ASSERT yes = abap_true.
zpool_read = zpool_read + 1.
counter = counter + 1.
WRITE counter.
CALL 'C_SAPGPARAM' ID 'NAME' FIELD 'demo/check' ID 'VALUE' FIELD counter.
ENDFUNCTION.
MODULE increment OUTPUT.
counter = counter + 1.
ENDMODULE.`,
    };
    const registry=new core.Registry();
    for (const [filename,contents] of Object.entries(files)) registry.addFile(new core.MemoryFile(filename,contents));
    const result=await new Transpiler({nativeDynpro:true,skipVersionCheck:true}).run(registry);
    const saved=globalThis.abap;
    try {
      globalThis.abap=new runtime.ABAP({console:new runtime.MemoryConsole()});
      const engine=new NativeDynproRuntime(abap);
      engine.setProfileParameters({'demo/check':{subrc:8}});
      const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
      for (const object of result.objects) await new AsyncFunction(object.chunk.getCode())();
      await abap.FunctionModules.ZPOOL_READ();
      await engine.modules.get('SAPLZPOOL/pbo/INCREMENT')();
      await abap.FunctionModules.ZPOOL_READ();
      assert.equal(abap.console.get(),'13');
      assert.equal(engine.field('SAPLZPOOL','COUNTER').get(),3);
      assert.equal(engine.field('SAPLZPOOL','ZPOOL_READ').get(),7);
      assert.equal(engine.procedures.length,0);
    } finally { globalThis.abap=saved; }
  });
});

describe('native FORM namespace', () => {
  it('keeps a mixed-case FORM separate from a same-named data object', async () => {
    const {core,Transpiler}=modulesOf(fileURLToPath(new URL('../',import.meta.url)));
    const files={
      'zforms.prog.abap':`REPORT zforms.
DATA toggle TYPE i.
PERFORM TOGGLE.
FORM ToGgLe.
  toggle = toggle + 1.
ENDFORM.
PERFORM toggle.
ASSERT toggle = 2.
WRITE toggle.`,
    };
    const registry=new core.Registry();
    for (const [filename,contents] of Object.entries(files)) registry.addFile(new core.MemoryFile(filename,contents));
    const result=await new Transpiler({nativeDynpro:true,skipVersionCheck:true}).run(registry);
    const saved=globalThis.abap;
    try {
      globalThis.abap=new runtime.ABAP({console:new runtime.MemoryConsole()});
      new NativeDynproRuntime(abap);
      const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
      for (const object of result.objects) await new AsyncFunction(object.chunk.getCode())();
      assert.equal(abap.console.get(),'2');
      assert.equal(typeof abap.Forms['PROG-ZFORMS-TOGGLE'],'function');
      await abap.Forms['PROG-ZFORMS-TOGGLE']();
      assert.ok(result.objects[0].exports.includes('$form$toggle'));
    } finally { globalThis.abap=saved; }
  });
});

describe('native inline declarations and argument names', () => {
  it('declares program results and preserves mixed-case method outputs and locals', async () => {
    const {core,Transpiler}=modulesOf(fileURLToPath(new URL('../',import.meta.url)));
    const files={
      'zinline.prog.abap':`REPORT zinline.
CLASS lcl_factory DEFINITION.
  PUBLIC SECTION.
    CLASS-METHODS create EXPORTING result TYPE i.
ENDCLASS.
CLASS lcl_factory IMPLEMENTATION.
  METHOD create.
    DATA(Local) = 3.
    result = local.
  ENDMETHOD.
ENDCLASS.
lcl_factory=>create( IMPORTING RESULT = DATA(First) ).
IF abap_false = abap_true.
  DATA(Unset) = 9.
ENDIF.
ASSERT first = 3.
ASSERT unset = 0.
WRITE first.`,
    };
    const registry=new core.Registry();
    for (const [filename,contents] of Object.entries(files)) registry.addFile(new core.MemoryFile(filename,contents));
    const result=await new Transpiler({nativeDynpro:true,skipVersionCheck:true}).run(registry);
    const saved=globalThis.abap;
    try {
      globalThis.abap=new runtime.ABAP({console:new runtime.MemoryConsole()});
      const engine=new NativeDynproRuntime(abap);
      const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
      for (const object of result.objects) await new AsyncFunction(object.chunk.getCode())();
      assert.equal(abap.console.get(),'3');assert.equal(engine.procedures.length,0);
    } finally { globalThis.abap=saved; }
  });
});
