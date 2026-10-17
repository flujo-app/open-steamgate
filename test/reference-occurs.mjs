import assert from 'node:assert/strict';
import * as core from '@abaplint/core';
import {BasicTypes as TypeParser} from '@abaplint/core/build/src/abap/5_syntax/basic_types.js';
import {installReferenceOccurs} from '../tools/osd-reference-occurs.mjs';

describe('obsolete table types with reference rows', () => {
  it('resolves OCCURS reference types for APPEND, LOOP and constructor expressions', () => {
    installReferenceOccurs(TypeParser,core);
    const source = `REPORT zreference_occurs.
CLASS lcl_item DEFINITION.
ENDCLASS.
CLASS lcl_item IMPLEMENTATION.
ENDCLASS.
TYPES ty_refs TYPE REF TO lcl_item OCCURS 0.
TYPES ty_data TYPE REF TO data OCCURS 10.
DATA refs TYPE ty_refs.
DATA data_refs TYPE ty_data.
DATA item TYPE REF TO lcl_item.
DATA data_ref TYPE REF TO data.
APPEND item TO refs.
APPEND data_ref TO data_refs.
refs = VALUE #( ( item ) ).
LOOP AT refs INTO item.
ENDLOOP.`;
    const registry = new core.Registry().addFile(new core.MemoryFile('zreference_occurs.prog.abap',source)).parse();
    const {issues} = new core.SyntaxLogic(registry,registry.getFirstObject()).run();
    assert.deepEqual(issues.map(i => i.getMessage()),[]);
  });

  it('keeps a reference without OCCURS as a reference', () => {
    installReferenceOccurs(TypeParser,core);
    const source = `REPORT zreference_scalar.
TYPES ty_ref TYPE REF TO object.
DATA reference TYPE ty_ref.
APPEND reference TO reference.`;
    const registry = new core.Registry().addFile(new core.MemoryFile('zreference_scalar.prog.abap',source)).parse();
    const {issues} = new core.SyntaxLogic(registry,registry.getFirstObject()).run();
    assert(issues.some(i => /not a table type/i.test(i.getMessage())));
  });
});
