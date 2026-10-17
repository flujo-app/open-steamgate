// SPDX-License-Identifier: MIT
// The pinned core drops REF_CLASS from function interfaces. Keep that metadata
// and resolve references using the same resolver as a TYPE REF TO declaration.
const installed = Symbol.for('osd.functionReference.syntax');
const referenceParameters = new WeakMap();
const array = value => value === undefined ? [] : Array.isArray(value) ? value : [value];

export function installFunctionReference({FunctionModuleDefinition, Procedural, TypeParser, core}) {
  const definition = FunctionModuleDefinition?.prototype;
  const procedural = Procedural?.prototype;
  if (!definition?.parse || !procedural?.addFunctionScope || !TypeParser?.prototype.resolveTypeRef) {
    throw new Error('Function reference correction needs the selected syntax resolver');
  }
  if (definition[installed]) return;
  const parse = definition.parse;
  definition.parse = function(data) {
    parse.call(this,data);
    const references = new Set();
    for (const [section,tag,direction] of [['IMPORT','RSIMP','importing'],['EXPORT','RSEXP','exporting'],['CHANGING','RSCHA','changing']]) {
      for (const parameter of array(data[section]?.[tag])) {
        if (parameter.REF_CLASS === 'X') references.add(`${direction}:${parameter.PARAMETER.toUpperCase()}`);
      }
    }
    referenceParameters.set(this,references);
  };
  const add = procedural.addFunctionScope;
  procedural.addFunctionScope = function(definition,nameToken,filename,ignoreIfAlreadyExists = false) {
    const references = referenceParameters.get(definition);
    if (!references?.size) return add.call(this,definition,nameToken,filename,ignoreIfAlreadyExists);
    const seen = new Set(), ordinary = [], corrected = [];
    for (const parameter of definition.getParameters()) {
      const name = parameter.name.toUpperCase();
      // Match the core's first-declaration rule for IMPORT/EXPORT name reuse.
      if (seen.has(name)) continue;
      seen.add(name);
      const direction = core.Types.FunctionModuleParameterDirection[parameter.direction];
      (references.has(`${direction}:${name}`) ? corrected : ordinary).push(parameter);
    }
    add.call(this,{getParameters:() => ordinary},nameToken,filename,ignoreIfAlreadyExists);
    for (const parameter of corrected) {
      if (ignoreIfAlreadyExists && this.scope.findVariable(parameter.name)) continue;
      // Parse only the declaration grammar, then resolve against the real scope.
      // This also supports data references and qualified type names correctly.
      const declaration = new core.Registry().addFile(new core.MemoryFile('zreference_parameter.prog.abap',
        `DATA reference_parameter TYPE REF TO ${parameter.type}.`)).parse();
      const statement = declaration.getFirstObject().getABAPFiles()[0].getStatements()[0];
      const chain = statement.findFirstExpression(core.Expressions.TypeName);
      if (!chain || statement.get() instanceof core.Unknown) {
        throw new Error(`Invalid reference type for function parameter ${parameter.name}`);
      }
      const type = new TypeParser({scope:this.scope,filename,issues:[]}).resolveTypeRef(chain);
      const token = new core.Tokens.Identifier(nameToken.getStart(),parameter.name);
      this.scope.addNamedIdentifier(parameter.name,new core.TypedIdentifier(token,filename,type,this.functionModuleParameterMeta(parameter)));
    }
  };
  definition[installed] = true;
}
