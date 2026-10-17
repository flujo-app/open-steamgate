import assert from 'node:assert/strict';
import * as core from '@abaplint/core';
import {FunctionModuleDefinition} from '@abaplint/core/build/src/abap/types/function_module_definition.js';
import {Procedural} from '@abaplint/core/build/src/abap/5_syntax/_procedural.js';
import {BasicTypes as TypeParser} from '@abaplint/core/build/src/abap/5_syntax/basic_types.js';
import {installFunctionReference} from '../tools/osd-function-reference.mjs';

function inspect(section,tag,{type='LCL_BOX',reference='X',global=false} = {}) {
  installFunctionReference({FunctionModuleDefinition,Procedural,TypeParser,core});
  const registry = new core.Registry();
  registry.addFile(new core.MemoryFile('zrefs.fugr.xml',`<abapGit><asx:abap xmlns:asx="http://www.sap.com/abapxml"><asx:values>
<INCLUDES><SOBJ_NAME>SAPLZREFS</SOBJ_NAME></INCLUDES><FUNCTIONS><item><FUNCNAME>ZREFS_CALL</FUNCNAME>
<GLOBAL_FLAG>${global?'X':''}</GLOBAL_FLAG><${section}><${tag}><PARAMETER>ARGUMENT</PARAMETER><TYP>${type}</TYP>
<REFERENCE>X</REFERENCE><REF_CLASS>${reference}</REF_CLASS></${tag}></${section}></item></FUNCTIONS>
</asx:values></asx:abap></abapGit>`));
  registry.addFile(new core.MemoryFile('zrefs.fugr.saplzrefs.abap',`FUNCTION-POOL zrefs.
CLASS lcl_box DEFINITION.
  PUBLIC SECTION.
    METHODS touch.
ENDCLASS.
CLASS lcl_box IMPLEMENTATION.
  METHOD touch.
  ENDMETHOD.
ENDCLASS.`));
  registry.addFile(new core.MemoryFile('zrefs.fugr.zrefs_call.abap',`FUNCTION zrefs_call.
${type==='LCL_BOX'?'argument->touch( ).':''}
ENDFUNCTION.`));
  registry.parse();
  const result = new core.SyntaxLogic(registry,registry.getObject('FUGR','ZREFS')).run();
  const variables=[];
  const visit=node => {
    const argument=node.getData().vars.ARGUMENT;
    if(argument)variables.push(argument);
    for(const child of node.getChildren())visit(child);
  };
  visit(result.spaghetti.getTop());
  return {issues:result.issues.map(issue=>issue.getMessage()),variables};
}

describe('function interface reference types', () => {
  for(const [section,tag] of [['IMPORT','RSIMP'],['EXPORT','RSEXP'],['CHANGING','RSCHA']]) {
    it(`resolves ${section} REF_CLASS and permits an instance method call`, () => {
      const {issues,variables}=inspect(section,tag);
      assert.deepEqual(issues,[]);
      assert.equal(variables.length,1);
      assert(variables[0].getType() instanceof core.BasicTypes.ObjectReferenceType);
      assert.equal(variables[0].getType().getIdentifierName().toUpperCase(),'LCL_BOX');
      assert(!variables[0].getMeta().includes('pass_by_value'));
    });
  }
  it('does not confuse pass by reference with a reference type', () => {
    const {issues,variables}=inspect('IMPORT','RSIMP',{type:'I',reference:''});
    assert.deepEqual(issues,[]);
    assert(variables[0].getType() instanceof core.BasicTypes.IntegerType);
  });
  it('retains a generic data reference', () => {
    const {issues,variables}=inspect('CHANGING','RSCHA',{type:'DATA'});
    assert.deepEqual(issues,[]);
    assert(variables[0].getType() instanceof core.BasicTypes.DataReference);
  });
  it('preserves unresolved referenced types for strict validation', () => {
    const {variables}=inspect('IMPORT','RSIMP',{type:'ZCL_MISSING'});
    assert(variables[0].getType() instanceof core.BasicTypes.UnknownType);
  });
  it('does not add a second global parameter at the function entry', () => {
    const {issues,variables}=inspect('IMPORT','RSIMP',{global:true});
    assert.deepEqual(issues,[]);
    assert.equal(variables.length,1);
    assert(variables[0].getType() instanceof core.BasicTypes.ObjectReferenceType);
  });
});
