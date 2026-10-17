import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {modulesOf} from '../tools/osd-transpile.mjs';

const root = new URL('../',import.meta.url);
const modules = () => modulesOf(fileURLToPath(root));
async function compile(source, nativeDynpro) {
  const {Transpiler, core} = modules();
  const registry = new core.Registry();
  registry.addFile(new core.MemoryFile('zdynpro.fugr.xml',`<?xml version="1.0"?>
<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml" version="1.0"><asx:values>
<INCLUDES><SOBJ_NAME>SAPLZDYNPRO</SOBJ_NAME></INCLUDES><FUNCTIONS/>
</asx:values></asx:abap></abapGit>`));
  registry.addFile(new core.MemoryFile('zdynpro.fugr.saplzdynpro.abap',source));
  const result = await new Transpiler({skipVersionCheck:true,nativeDynpro}).run(registry);
  return result.objects.find(o => o.object.type === 'FUGR').chunk.getCode();
}
const source = `FUNCTION-POOL zdynpro.
DATA counter TYPE i.
MODULE handle OUTPUT.
  counter = counter + 1.
  SET PF-STATUS 'MAIN'.
  SET TITLEBAR 'TITLE' WITH counter.
  SUPPRESS DIALOG.
ENDMODULE.
MODULE handle INPUT.
  SET SCREEN 0.
  LEAVE SCREEN.
ENDMODULE.
FORM launch.
  CALL SCREEN 100 STARTING AT 2 3 ENDING AT 40 20.
ENDFORM.`;

describe('native dynpro compiler adapter', () => {
  it('keeps ordinary builds unchanged until the option is enabled', async () => {
    const ordinary = await compile(source,false);
    assert.doesNotMatch(ordinary,/Dynpro\.registerModule/);
    const native = await compile(source,true);
    assert.match(native,/Dynpro\.registerModule\("SAPLZDYNPRO", "pbo", "HANDLE", async/);
    assert.match(native,/Dynpro\.registerModule\("SAPLZDYNPRO", "pai", "HANDLE", async/);
    assert.match(native,/"COUNTER": \(\) => counter/);
    assert.match(native,/await abap\.Dynpro\.callScreen\("SAPLZDYNPRO"/);
    assert.match(native,/Dynpro\.suppressDialog\(\)/);
    assert.match(native,/Dynpro\.leaveScreen\(\)/);
    assert.match(native,/Dynpro\.setTitle/);
    assert.doesNotMatch(await compile(source,false),/Dynpro\.registerModule/);
  });

  it('rejects module-local emission of data with program lifetime', async () => {
    await assert.rejects(compile(`FUNCTION-POOL zdynpro.
MODULE initialize OUTPUT.
  DATA counter TYPE i.
  counter = counter + 1.
ENDMODULE.`,true),/global hoisting/);
  });

  it('keeps the profile function name separate from the NAME operand', async () => {
    const code=await compile(`FUNCTION-POOL zdynpro.
FORM read_setting.
  DATA result TYPE c LENGTH 40.
  CALL 'C_SAPGPARAM' ID 'VALUE' FIELD result ID 'NAME' FIELD 'demo/setting'.
ENDFORM.`,true);
    assert.match(code,/abap\.Dynpro\.profileParameter\([^;]*demo\/setting[^;]*, result\)/);
    assert.doesNotMatch(code,/kernel_call/);
    await assert.rejects(compile(`FUNCTION-POOL zdynpro.
FORM read_setting.
  DATA result TYPE c LENGTH 40.
  CALL 'C_SAPGPARAM' ID 'VALUE' FIELD result.
ENDFORM.`,true),/requires NAME and VALUE/);
  });
});
