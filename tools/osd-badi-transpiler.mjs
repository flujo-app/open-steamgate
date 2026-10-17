// SPDX-License-Identifier: MIT
const syntaxInstalled = Symbol.for('osd.badi.syntax');
const loweringInstalled = Symbol.for('osd.badi.lowering');
const badiName = Symbol.for('osd.badi.typeName');

export function installBadiTypes({TypeParser,core,CallBadiSyntax,CallSyntax}) {
  // The pinned CALL BADI checker visits parameter expressions but never the
  // receiver or method. Reuse the ordinary method checker now that BAdI types
  // resolve their interface; this also supplies references for class attributes.
  if (CallBadiSyntax && CallSyntax && !CallBadiSyntax.prototype[syntaxInstalled]) {
    CallBadiSyntax.prototype.runSyntax = function(node,input) {
      return CallSyntax.prototype.runSyntax.call(this,node,input);
    };
    CallBadiSyntax.prototype[syntaxInstalled] = true;
  }
  const proto = TypeParser?.prototype;
  if (!proto?.resolveTypeRef) throw new Error('BAdI references need the selected type resolver');
  if (proto[syntaxInstalled]) return;
  const original = proto.resolveTypeRef;
  proto.resolveTypeRef = function(chain) {
    const result = original.call(this,chain);
    if (!chain || !(result instanceof core.BasicTypes.VoidType)) return result;
    const name = chain.concatTokens().toUpperCase();
    const scope = this.input.scope;
    const definitions = scope.getRegistry().getObjectsByType('ENHS').flatMap(object => object.listBadiDefinitions());
    const definition = definitions.find(item => item.name.toUpperCase() === name);
    if (!definition) return result;
    const found = scope.existsObject(definition.interface);
    if (!found?.id) return new core.BasicTypes.UnknownType(`BAdI interface not found: ${definition.interface}`);
    scope.addReference(chain.getFirstToken(),found.id,core.ReferenceType.ObjectOrientedReference,this.input.filename,
      {ooType:found.ooType,ooName:definition.interface});
    const type = new core.BasicTypes.ObjectReferenceType(found.id,{qualifiedName:name});
    type[badiName] = name;
    return type;
  };
  proto[syntaxInstalled] = true;
}

export function installNativeBadiTranspiler({Traversal,Chunk,core,MethodCallBodyTranspiler,CallTranspiler}) {
  const proto = Traversal?.prototype;
  if (!proto?.traverseStatement || !MethodCallBodyTranspiler || !CallTranspiler) throw new Error('BAdI lowering needs the selected compiler');
  if (proto[loweringInstalled]) return;
  const original = proto.traverseStatement;
  proto.traverseStatement = function(node) {
    if (this.options?.nativeDynpro !== true) return original.call(this,node);
    const kind = node.get();
    if (!(kind instanceof core.Statements.GetBadi) && !(kind instanceof core.Statements.CallBadi)) return original.call(this,node);
    const scope = this.findCurrentScopeByToken(node.getFirstToken());
    if (kind instanceof core.Statements.GetBadi) {
      if (node.findDirectExpression(core.Expressions.Dynamic) || node.findDirectExpression(core.Expressions.ParameterListS) ||
          node.findDirectTokenByText('CONTEXT')) throw new Error('Dynamic, filtered or context-dependent GET BADI is not implemented');
      const type = this.determineType(node,scope);
      const name = type?.[badiName];
      if (!name) throw new Error('GET BADI target has no resolved BAdI definition');
      const target = this.traverse(node.findDirectExpression(core.Expressions.Target)).getCode();
      return new Chunk().append(`${target}.set(await abap.Badi.get(${JSON.stringify(name)}));\n`,node,this);
    }
    const source = node.findDirectExpression(core.Expressions.MethodSource);
    const parts = source?.getChildren() ?? [];
    if (parts.length !== 3 || parts[1].concatTokens() !== '->' || parts[2].get() instanceof core.Expressions.Dynamic) {
      throw new Error('Dynamic CALL BADI is not implemented');
    }
    const target = new core.Nodes.ExpressionNode(new core.Expressions.Target()).setChildren(parts[0].getChildren());
    const type = this.determineType({findDirectExpression:() => target},scope);
    const name = type?.[badiName];
    if (!name) throw new Error('CALL BADI target has no resolved BAdI definition');
    const methodName = parts[2].concatTokens().toUpperCase();
    const definition = this.findInterfaceDefinition(type.getIdentifierName(),scope)?.getMethodDefinitions().getByName(methodName);
    if (!definition) throw new Error(`Unknown BAdI method ${name}/${methodName}`);
    const body = node.findDirectExpression(core.Expressions.MethodCallBody);
    if (body?.findDirectTokenByText('PARAMETER') || body?.findDirectTokenByText('EXCEPTION')) {
      throw new Error('CALL BADI parameter/exception tables are not implemented');
    }
    const parameters = body ? new MethodCallBodyTranspiler(definition).transpile(body,this).getCode() : '';
    let code = `await abap.Badi.call(${this.traverse(parts[0]).getCode()}, ${JSON.stringify(name)}, ${JSON.stringify(methodName)}, ${parameters || '{}'})`;
    const receiving = node.findFirstExpression(core.Expressions.MethodParameters)?.findExpressionAfterToken('RECEIVING');
    if (receiving) code = `${this.traverse(receiving.findDirectExpression(core.Expressions.Target)).getCode()}.set(${code})`;
    code += ';';
    const exceptions = node.findFirstExpression(core.Expressions.ParameterListExceptions);
    if (exceptions) {
      const handling = CallTranspiler.buildExceptions(exceptions);
      code = handling.pre + code + handling.post;
    }
    return new Chunk().append(code+'\n',node,this);
  };
  proto[loweringInstalled] = true;
}
