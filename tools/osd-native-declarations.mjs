// SPDX-License-Identifier: MIT
// Keep ABAP declaration scopes/namespaces when emitting JavaScript modules.
const installed = Symbol.for('osd.nativeDeclarations.transpiler');

// A spelling change within one generated line must also shift later mappings
// on that line. The source locations and all other generated lines stay put.
function replaceSpelling(chunk,before,after,Chunk) {
  const code=chunk.getCode(),at=code.indexOf(before);
  if (at < 0 || code.indexOf(before,at+before.length) >= 0 || before.includes('\n') || after.includes('\n')) {
    throw new Error('Unknown native declaration emitter shape');
  }
  const line=code.slice(0,at).split('\n').length,column=at-code.lastIndexOf('\n',at-1)-1;
  const result=new Chunk(code.slice(0,at)+after+code.slice(at+before.length));
  result.mappings=chunk.mappings.map(mapping => {
    const generated={...mapping.generated};
    if (generated.line === line && generated.column >= column) {
      generated.column=generated.column >= column+before.length ? generated.column+after.length-before.length : column;
    }
    return {...mapping,original:{...mapping.original},generated};
  });
  return result;
}

export function installNativeDeclarations({Traversal,Chunk,core,DataTranspiler,FieldChainTranspiler,HandleABAP,InlineDeclarations}) {
  const proto=Traversal?.prototype;
  if (!proto?.findCurrentScopeByToken || !DataTranspiler || !FieldChainTranspiler || !InlineDeclarations || !HandleABAP?.prototype.rearrangeClassLocals) throw new Error('Native declarations need the selected compiler');
  if (proto[installed]) return;
  const lookup=proto.findCurrentScopeByToken, structure=proto.traverseStructure, statement=proto.traverseStatement;
  const expression=proto.traverseExpression,isTypePool=proto.isTypePool;
  const formName=name => '$form$'+Traversal.escapeNamespace(name.toLowerCase());
  proto.isTypePool=function(token) {
    const found=isTypePool.call(this,token);
    if (found || this.options?.nativeDynpro !== true) return found;
    // Some syntax positions (notably classic return codes) have no recorded
    // read reference. The resolved variable still identifies its type pool.
    const variable=this.findCurrentScopeByToken(token)?.findVariable(token.getStr());
    const filename=variable?.getFilename();
    if (!filename?.toLowerCase().endsWith('.type.abap')) return undefined;
    const file=this.reg.getFileByName(filename),object=file&&this.reg.findObjectForFile(file);
    return object instanceof core.Objects.TypePool ? object.getName() : undefined;
  };
  proto.traverseExpression=function(node) {
    if (this.options?.nativeDynpro === true) {
      if (node.get() instanceof core.Expressions.Target) {
        const inline=node.findDirectExpression(core.Expressions.InlineData);
        if (inline) {
          if (node.getChildren().length !== 1) throw new Error('Unsupported inline target shape');
          const name=inline.findDirectExpression(core.Expressions.TargetField)?.concatTokens();
          if (!name) throw new Error('Inline target has no identifier');
          return new Chunk().append(Traversal.prefixVariable(Traversal.escapeNamespace(name.toLowerCase())),inline,this);
        }
      }
      if (node.get() instanceof core.Expressions.ParameterT) {
        const name=node.findDirectExpression(core.Expressions.ParameterName)?.getFirstToken();
        if (!name) throw new Error('Target parameter has no name');
        return new Chunk().append(JSON.stringify(name.getStr().toLowerCase())+': ',name,this)
          .appendChunk(this.traverse(node.findDirectExpression(core.Expressions.Target)));
      }
    }
    return expression.call(this,node);
  };
  proto.traverseStatement=function(node) {
    const chunk=statement.call(this,node);
    if (this.options?.nativeDynpro !== true) return chunk;
    if (node.get() instanceof core.Statements.Form) {
      const name=node.findFirstExpression(core.Expressions.FormName)?.concatTokens();
      if (!name) throw new Error('Native FORM has no name');
      return replaceSpelling(chunk,`async function ${name}(`,`async function ${formName(name)}(`,Chunk);
    }
    if (node.get() instanceof core.Statements.Perform && !node.concatTokens().toUpperCase().includes(' IN PROGRAM ')) {
      const name=node.findDirectExpression(core.Expressions.FormName)?.concatTokens();
      if (name) return replaceSpelling(chunk,`await ${name}(`,`await ${formName(name)}(`,Chunk);
    }
    return chunk;
  };
  proto.findCurrentScopeByToken=function(token) {
    const found=lookup.call(this,token);
    if (found || this.options?.nativeDynpro !== true) return found;
    if (!this.getCurrentObject().getABAPFiles().some(file => file.getFilename() === this.getFilename())) return undefined;
    const global=this.getSpaghetti().getFirstChild();
    if (global?.getIdentifier().stype !== core.ScopeType.Global) return undefined;
    if (this.getCurrentObject() instanceof core.Objects.Class) return global;
    // Include-file top-level expressions and MODULEs after ENDFUNCTION belong
    // to the function group's scope, whose filename names only its main file.
    if (this.getCurrentObject() instanceof core.Objects.FunctionGroup) {
      const group=global.getFirstChild();
      if (group?.getIdentifier().stype === core.ScopeType.FunctionGroup) return group;
    }
    return undefined;
  };
  proto.traverseStructure=function(node) {
    if (this.options?.nativeDynpro !== true) return structure.call(this,node);
    if (node === this.getFile().getStructure() && this.getCurrentObject() instanceof core.Objects.Program) {
      const globals={findAllExpressionsRecursive:kind => node.findAllExpressionsRecursive(kind).filter(inline => {
        const target=inline.findFirstExpression(core.Expressions.TargetField) || inline.findFirstExpression(core.Expressions.TargetFieldSymbol);
        const scope=this.findCurrentScopeByToken(inline.getFirstToken());
        return target && scope?.findScopeForVariable(target.concatTokens())?.stype === core.ScopeType.Program;
      })};
      const declarations=InlineDeclarations.buildDeclarations(globals,this);
      return new Chunk().appendString(declarations).appendChunk(structure.call(this,node));
    }
    if (node.get() instanceof core.Structures.FunctionModule) {
      const name=node.findFirstStatement(core.Statements.FunctionModule)?.findDirectExpression(core.Expressions.Field)?.concatTokens();
      if (!name) throw new Error('Native function module has no name');
      const oldName=Traversal.escapeNamespace(name.toLowerCase()),newName='$function$'+oldName;
      const renamed=replaceSpelling(structure.call(this,node),`async function ${oldName}(`,`async function ${newName}(`,Chunk);
      const registry=`abap.FunctionModules['${name.toUpperCase()}'] = `;
      return replaceSpelling(renamed,registry+oldName+';',registry+newName+';',Chunk);
    }
    if (node.get() instanceof core.Structures.Form) {
      const chunk=structure.call(this,node);
      if (this.getCurrentObject().getType() !== 'PROG') return chunk;
      const name=node.findFirstStatement(core.Statements.Form)?.findDirectExpression(core.Expressions.FormName)?.concatTokens();
      const registry=`abap.Forms['PROG-${this.getCurrentObject().getName().toUpperCase()}-${name.toUpperCase()}'] = `;
      return replaceSpelling(chunk,registry+name.toLowerCase()+';',registry+formName(name)+';',Chunk);
    }
    if (!(node.get() instanceof core.Structures.Constants)) return structure.call(this,node);
    const begin=node.findDirectStatement(core.Statements.ConstantBegin), data=new DataTranspiler();
    if (!begin) throw new Error('Structured constants have no declaration');
    const result=data.transpile(begin,this).ensureStartMapping(begin,this).appendString('\n');
    const initialize=(block,prefix) => {
      for (const child of block.getChildren()) {
        if (child.get() instanceof core.Structures.Constants) {
          const name=child.findDirectStatement(core.Statements.ConstantBegin)?.findDirectExpression(core.Expressions.DefinitionName)?.concatTokens();
          if (!name) throw new Error('Nested constants have no name');
          initialize(child,`${prefix}.get()[${JSON.stringify(name.toLowerCase())}]`);
        } else if (child.get() instanceof core.Statements.Constant) {
          const name=child.findDirectExpression(core.Expressions.DefinitionName)?.concatTokens();
          const value=child.findDirectExpression(core.Expressions.Value);
          if (!name || !value) throw new Error('Constant has no name or value');
          const source=value.findDirectExpression(core.Expressions.Constant) || value.findDirectExpression(core.Expressions.SimpleFieldChain);
          if (source) result.appendString(`${prefix}.get()[${JSON.stringify(name.toLowerCase())}].set(`)
            .appendChunk(source.get() instanceof core.Expressions.SimpleFieldChain ?
              new FieldChainTranspiler().transpile(source,this) : this.traverse(source)).appendString(');\n');
          else if (value.concatTokens().toUpperCase() !== 'VALUE IS INITIAL') throw new Error('Unsupported constant initializer');
        }
      }
    };
    initialize(node,data.getVariableName());
    return result;
  };
  const findExports=HandleABAP.prototype.findExports;
  HandleABAP.prototype.findExports=function(node) {
    if (this.options?.nativeDynpro !== true) return findExports.call(this,node);
    const names=[];
    for (const kind of [core.Statements.ClassDefinition,core.Statements.Interface]) {
      for (const declaration of node?.findAllStatements(kind) ?? []) {
        const name=declaration.findFirstExpression(kind === core.Statements.Interface ? core.Expressions.InterfaceName : core.Expressions.ClassName)?.concatTokens();
        if (name) names.push(name.toLowerCase());
      }
    }
    for (const declaration of node?.findAllStatements(core.Statements.Form) ?? []) {
      const name=declaration.findFirstExpression(core.Expressions.FormName)?.concatTokens();
      if (name) names.push(formName(name));
    }
    return names;
  };
  const rearrange=HandleABAP.prototype.rearrangeClassLocals;
  HandleABAP.prototype.rearrangeClassLocals=function(object,outputs) {
    if (this.options?.nativeDynpro !== true || !(object instanceof core.Objects.Class)) return rearrange.call(this,object,outputs);
    // Keep one lexical scope, as the function-group handler already does. Join
    // chunks before imports/exports are added, preserving their source maps.
    if (outputs.some(output => output.filename.endsWith('.clas.testclasses.mjs'))) {
      throw new Error('Native class-pool test includes need a shared unit-test entry');
    }
    const mainName=object.getMainABAPFile()?.getFilename().replace('.abap','.mjs').toLowerCase();
    const main=outputs.find(output => output.filename === mainName);
    if (!main) throw new Error('Native class pool has no main module');
    const ownFiles=new Set(outputs.map(output => output.filename));
    ownFiles.add(mainName.replace('.clas.mjs','.clas.locals.mjs'));
    const requires=new Map(),chunk=new Chunk(),exports=new Set();
    for (const output of outputs) {
      chunk.appendChunk(output.chunk).appendString('\n');
      for (const name of output.exports) exports.add(name);
      for (const dependency of output.requires) {
        if (!ownFiles.has(dependency.filename.replace('.abap','.mjs').toLowerCase())) {
          requires.set(JSON.stringify(dependency),dependency);
        }
      }
    }
    return [{...main,chunk,exports:[...exports],requires:[...requires.values()]}];
  };
  proto[installed]=true;
}
