// SPDX-License-Identifier: MIT
// Opt-in native dynpro lowering. Unconverted module pools/function groups use
// async callbacks so a nested CALL SCREEN retains the caller's JS/ABAP stack.
const installed = Symbol.for('osd.nativeDynpro.transpiler');

function programName(object) {
  const name = object.getName().toUpperCase();
  if (object.getType() === 'PROG') return name;
  if (object.getType() === 'FUGR') {
    const namespace = /^(\/[^/]+\/)(.*)$/.exec(name);
    return namespace ? `${namespace[1]}SAPL${namespace[2]}` : `SAPL${name}`;
  }
  throw new Error(`Native screen statement in unsupported object type ${object.getType()}`);
}

export function installNativeDynproTranspiler({Traversal, Chunk, core}) {
  const proto = Traversal?.prototype;
  if (!proto?.traverseStatement || !proto?.traverseStructure || !Chunk || !core) {
    throw new Error('Native dynpro lowering needs the selected transpiler Traversal, Chunk and core');
  }
  if (proto[installed]) return;
  const statement = proto.traverseStatement;
  const structure = proto.traverseStructure;
  const enabled = traversal => traversal.options?.nativeDynpro === true;
  const value = (node, traversal) => {
    if (!node) throw new Error('Missing native screen operand');
    return traversal.traverse(node).getCode();
  };
  proto.traverseStatement = function(node) {
    if (!enabled(this)) return statement.call(this, node);
    const kind = node.get();
    const source = () => node.findDirectExpression(core.Expressions.Source);
    const operand = keyword => node.findExpressionAfterToken(keyword);
    const append = text => new Chunk().append(text+'\n', node, this);
    const program = () => JSON.stringify(programName(this.getCurrentObject()));
    if (kind instanceof core.Statements.CallDialog) return append('abap.Dynpro.unsupported("CALL DIALOG");');
    if (kind instanceof core.Statements.CallKernel && node.getChildren()[1]?.concatTokens().toUpperCase() === "'C_SAPGPARAM'") {
      // Keep the kernel function name separate from its NAME argument. The
      // pinned generic emitter puts both in the same JS object property.
      const argumentsByName = new Map();
      for (const parameter of node.findDirectExpressions(core.Expressions.KernelId)) {
        const key = parameter.getChildren()[1].concatTokens().toUpperCase();
        if (!["'NAME'","'VALUE'"].includes(key) || argumentsByName.has(key)) throw new Error('Unsupported C_SAPGPARAM arguments');
        argumentsByName.set(key,value(parameter.getChildren()[3],this));
      }
      if (argumentsByName.size !== 2) throw new Error('C_SAPGPARAM requires NAME and VALUE');
      return append(`abap.Dynpro.profileParameter(${argumentsByName.get("'NAME'")}, ${argumentsByName.get("'VALUE'")});`);
    }
    if (kind instanceof core.Statements.CallScreen) {
      const sources = node.findDirectExpressions(core.Expressions.Source).map(n => value(n, this));
      const options = sources.length === 1 ? 'undefined' :
        `{left:${sources[1]},top:${sources[2]}${sources.length === 5 ? `,right:${sources[3]},bottom:${sources[4]}` : ''}}`;
      return append(`await abap.Dynpro.callScreen(${program()}, ${sources[0]}, ${options});`);
    }
    if (kind instanceof core.Statements.SetScreen) return append(`abap.Dynpro.setScreen(${value(source(), this)});`);
    if (kind instanceof core.Statements.SuppressDialog) return append('abap.Dynpro.suppressDialog();');
    if (kind instanceof core.Statements.Leave) {
      const text = node.concatTokens().toUpperCase();
      if (/^LEAVE (TO )?SCREEN\b/.test(text)) {
        return append(`abap.Dynpro.leaveScreen(${source() ? value(source(), this) : ''});`);
      }
      if (/^LEAVE PROGRAM\s*\.$/.test(text)) return append('abap.Dynpro.leaveProgram();');
      if (/^LEAVE (TO )?LIST-PROCESSING\b/.test(text)) return append('abap.Dynpro.unsupported("LEAVE TO LIST-PROCESSING");');
      if (/^LEAVE TO (CURRENT )?TRANSACTION\b/.test(text)) return append('abap.Dynpro.unsupported("LEAVE TO TRANSACTION");');
      throw new Error(`Unsupported native dialog statement: ${text}`);
    }
    if (kind instanceof core.Statements.SetPFStatus) {
      if (node.getTokens().some(t => t.getStr().toUpperCase() === 'IMMEDIATELY')) {
        throw new Error('SET PF-STATUS IMMEDIATELY needs an active-list renderer');
      }
      return append(`abap.Dynpro.setStatus(${operand('PROGRAM') ? value(operand('PROGRAM'), this) : program()}, ` +
        `${value(source(), this)}, ${operand('EXCLUDING') ? value(operand('EXCLUDING'), this) : 'undefined'});`);
    }
    if (kind instanceof core.Statements.SetTitlebar) {
      const children = node.getChildren();
      const withAt = children.findIndex(c => c.getFirstToken().getStr().toUpperCase() === 'WITH');
      const values = withAt < 0 ? [] : children.slice(withAt + 1)
        .filter(c => c instanceof core.Nodes.ExpressionNode && c.get() instanceof core.Expressions.Source)
        .map(c => value(c, this));
      return append(`abap.Dynpro.setTitle(${operand('PROGRAM') ? value(operand('PROGRAM'), this) : program()}, ` +
        `${value(source(), this)}, [${values.join(',')}]);`);
    }
    return statement.call(this, node);
  };
  proto.traverseStructure = function(node) {
    if (!enabled(this) || !(node.get() instanceof core.Structures.Module)) return structure.call(this, node);
    const header = node.findFirstStatement(core.Statements.Module);
    const name = header.findDirectExpression(core.Expressions.FormName)?.concatTokens().toUpperCase();
    if (!name) throw new Error('Dialog module has no name');
    const phase = header.getTokens().some(t => t.getStr().toUpperCase() === 'OUTPUT') ? 'pbo' : 'pai';
    // A MODULE has program-level data. Refuse declarations until their emission
    // is hoisted to the group closure, rather than resetting them on every PAI.
    const declarationKinds = ['Data','DataBegin','DataEnd','Constant','ConstantBegin','FieldSymbol','Static'];
    const declarations = node.findAllStatementNodes().filter(s => declarationKinds.includes(s.get().constructor.name));
    if (declarations.length || node.findAllExpressionsRecursive(core.Expressions.InlineData).length ||
        node.findAllExpressionsRecursive(core.Expressions.InlineFS).length) {
      throw new Error('Native MODULE data declarations require global hoisting');
    }
    let scope = this.findCurrentScopeByToken(header.getFirstToken());
    while (scope && ![core.ScopeType.Program, core.ScopeType.FunctionGroup].includes(scope.getIdentifier().stype)) scope = scope.getParent();
    if (!scope) throw new Error('Dialog module has no program scope');
    const bindings = Object.values(scope.getData().vars).map(variable => {
      const identifier = variable.getName();
      const jsName = Traversal.prefixVariable(Traversal.escapeNamespace(identifier.toLowerCase()));
      return `${JSON.stringify(identifier.toUpperCase())}: () => ${jsName}`;
    });
    const chunk = new Chunk().append(`abap.Dynpro.registerModule(${JSON.stringify(programName(this.getCurrentObject()))}, ` +
      `${JSON.stringify(phase)}, ${JSON.stringify(name)}, async () => {\n`, header, this);
    for (const child of node.getChildren()) {
      if (child.get() instanceof core.Statements.Module || child.get() instanceof core.Statements.EndModule) continue;
      chunk.appendChunk(this.traverse(child));
    }
    return chunk.appendString(`\n}, {${bindings.join(',')}});\n`);
  };
  proto[installed] = true;
}
