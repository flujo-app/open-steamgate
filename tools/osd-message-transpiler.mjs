// SPDX-License-Identifier: MIT
// Carry call-site exception handling into the callee without changing ABAP
// parameters. Symbol metadata cannot collide with a declared ABAP identifier.
const installed = Symbol.for('osd.nativeMessage.transpiler');
const parameters = Symbol.for('osd.nativeMessage.parameters');
const active = [];
const metadata = names => `[Symbol.for('osd.native.exceptions')]:${JSON.stringify(names)}`;

export function installNativeMessageTranspiler({Traversal,Chunk,core,CallTranspiler,MethodCallBodyTranspiler,MethodCallParamTranspiler,FieldChainTranspiler}) {
  const proto=Traversal?.prototype;
  if (!proto?.traverseStatement || !proto.traverseExpression || !CallTranspiler || !MethodCallBodyTranspiler || !MethodCallParamTranspiler || !FieldChainTranspiler) {
    throw new Error('Native messages need the selected compiler');
  }
  if (proto[installed]) return;
  const statement=proto.traverseStatement, expression=proto.traverseExpression, structure=proto.traverseStructure;
  const buildExceptions=CallTranspiler.buildExceptions;
  CallTranspiler.buildExceptions=function(node) {
    const traversal=active.at(-1);
    if (!traversal) return buildExceptions.call(this,node);
    let cases='', others=false;
    for (const exception of node.findAllExpressions(core.Expressions.ParameterException)) {
      const name=exception.getFirstToken().getStr().toUpperCase();
      const code=exception.findExpressionAfterToken('=');
      if (!code) throw new Error('Native classic exceptions require an explicit return code');
      const value=code.get() instanceof core.Expressions.Integer ? String(Number(code.concatTokens())) :
        new FieldChainTranspiler().transpile(code,traversal).getCode();
      cases+=(name === 'OTHERS' ? 'default:' : `case ${JSON.stringify(name)}:`) +
        ` abap.builtin.sy.get().subrc.set(${value}); break;\n`;
      others ||= name === 'OTHERS';
    }
    if (!others) cases+='default: throw e;\n';
    return {pre:'try {\n',post:`\nabap.builtin.sy.get().subrc.set(0);
} catch (e) {
if (!e.classic) throw e;
switch (e.classic.toUpperCase()) {
${cases}}
}`};
  };
  for (const emitter of [MethodCallBodyTranspiler,MethodCallParamTranspiler]) {
    const body=emitter.prototype.transpile;
    emitter.prototype.transpile=function(node,traversal) {
      const chunk=body.call(this,node,traversal), names=traversal[parameters]?.get(node);
      if (!names) return chunk;
      const result=new Chunk().appendString('({...(');
      if (chunk.getCode()) result.appendChunk(chunk);else result.appendString('{}');
      return result.appendString(`),${metadata(names)}})`);
    };
  }
  proto.traverseExpression=function(node) {
    const chunk=expression.call(this,node), names=this[parameters]?.get(node);
    if (!names || !(node.get() instanceof core.Expressions.FunctionParameters)) return chunk;
    return new Chunk().appendString('{...(').appendChunk(chunk).appendString(`),${metadata(names)}}`);
  };
  proto.traverseStatement=function(node) {
    if (this.options?.nativeDynpro !== true) return statement.call(this,node);
    const kind=node.get();
    if (kind instanceof core.Statements.CallFunction && ['STARTING','CALLING','UPDATE','BACKGROUND'].some(token => node.findDirectTokenByText(token))) {
      return new Chunk().append('abap.Dynpro.unsupported("asynchronous or deferred CALL FUNCTION");\n',node,this);
    }
    if (kind instanceof core.Statements.Receive) return new Chunk().append('abap.Dynpro.unsupported("RECEIVE RESULTS");\n',node,this);
    if (kind instanceof core.Statements.Message) {
      const extras=[], source=node.findDirectExpression(core.Expressions.MessageSource);
      const raising=node.findDirectExpression(core.Expressions.ExceptionName)?.concatTokens().toUpperCase();
      if (raising) extras.push(`raising:${JSON.stringify(raising)}`);
      if (source && !source.findExpressionAfterToken('ID') && !source.findDirectExpression(core.Expressions.MessageClass)) {
        const header=this.getCurrentObject().getABAPFiles().flatMap(file => file.getStatements())
          .find(item => ['Report','Program','FunctionPool','ClassPool'].includes(item.get().constructor.name));
        const id=header?.findDirectExpression(core.Expressions.MessageClass)?.concatTokens().toUpperCase();
        if (!id) throw new Error('Short MESSAGE has no default MESSAGE-ID');
        extras.push(`id:${JSON.stringify(id)}`);
      }
      const code=statement.call(this,node).getCode(), prefix='await abap.statements.message({';
      if (!code.startsWith(prefix)) throw new Error('Unknown MESSAGE emitter shape');
      return new Chunk().append(code.replace(prefix,`await abap.Dynpro.message({${extras.length ? extras.join(',')+',' : ''}`),node,this);
    }
    if (kind instanceof core.Statements.MethodImplementation) {
      // The pinned emitter omits INPUT on no-argument methods, including the
      // instance forwarder for a static method. Keep metadata in both paths.
      const code=statement.call(this,node).getCode()
        .replace(/(^|\n)(static )?async ([^\n(]+)\(\) \{/g,'$1$2async $3(INPUT) {')
        .replace(/^(return [^\n()]+)\(\);$/m,'$1(INPUT);');
      return new Chunk().append(code+`\nconst __osdProcedure = abap.Dynpro.enterProcedure('method', arguments[0]);\ntry {\n`,node,this);
    }
    if (kind instanceof core.Statements.EndMethod) {
      const code=statement.call(this,node).getCode();
      if (!/}\s*$/.test(code)) throw new Error('Unknown ENDMETHOD emitter shape');
      return new Chunk().append(code.replace(/}\s*$/,procedureEnd+'}\n'),node,this);
    }
    const exceptions=node.findFirstExpression(core.Expressions.ParameterListExceptions);
    const isCall=kind instanceof core.Statements.Call || kind instanceof core.Statements.CallFunction || kind instanceof core.Statements.CallBadi;
    if (!isCall || !exceptions) return statement.call(this,node);
    const chain=node.findDirectExpression(core.Expressions.MethodCallChain);
    // Match the owning call, not a nested call used to calculate an argument.
    const functional=chain?.findDirectExpressions(core.Expressions.MethodCall)
      .map(call => call.findDirectExpression(core.Expressions.MethodCallParam))
      .find(param => param?.findDirectExpression(core.Expressions.MethodParameters)
        ?.findDirectExpression(core.Expressions.ParameterListExceptions) === exceptions);
    const args=node.findDirectExpression(core.Expressions.FunctionParameters) || node.findDirectExpression(core.Expressions.MethodCallBody) || functional;
    if (!args || args.findDirectTokenByText('PARAMETER') || args.findDirectTokenByText('EXCEPTION')) {
      throw new Error('Native classic exception metadata needs explicit call parameters');
    }
    const names=exceptions.findAllExpressions(core.Expressions.ParameterException).map(item => item.getFirstToken().getStr().toUpperCase());
    this[parameters] ??= new WeakMap();
    this[parameters].set(args,names);
    active.push(this);
    try { return statement.call(this,node); }
    finally { active.pop();this[parameters].delete(args); }
  };
  const procedureEnd=`} catch (__osdError) { abap.Dynpro.procedureError(__osdProcedure, __osdError); }
finally { abap.Dynpro.leaveProcedure(__osdProcedure); }
`;
  proto.traverseStructure=function(node) {
    const chunk=structure.call(this,node);
    if (this.options?.nativeDynpro !== true || !(node.get() instanceof core.Structures.FunctionModule)) return chunk;
    const code=chunk.getCode(), start=/^(async function [^\n(]+\(INPUT\) \{\n)/, end=/}\nabap.FunctionModules\[/;
    if (!start.test(code) || !end.test(code)) throw new Error('Unknown FUNCTION emitter shape');
    const inserts=[
      {at:start.exec(code)[0].length,text:`const __osdProcedure = abap.Dynpro.enterProcedure('function', INPUT);\ntry {\n`},
      {at:end.exec(code).index,text:procedureEnd},
    ];
    // Both wrappers are inserted at line starts. Preserve every mapping inside
    // the function body instead of mapping the whole function to its header.
    for (const item of inserts) {
      if (item.at && code[item.at-1] !== '\n') throw new Error('FUNCTION wrapper is not at a line boundary');
      item.line=code.slice(0,item.at).split('\n').length;
      item.lines=item.text.split('\n').length-1;
    }
    let wrapped=code;
    for (const item of [...inserts].reverse()) wrapped=wrapped.slice(0,item.at)+item.text+wrapped.slice(item.at);
    const result=new Chunk(wrapped);
    result.mappings=chunk.mappings.map(mapping => ({...mapping,original:{...mapping.original},
      generated:{...mapping.generated,line:mapping.generated.line+inserts.reduce((sum,item) => sum+(mapping.generated.line >= item.line ? item.lines : 0),0)}}));
    return result;
  };
  proto[installed]=true;
}
