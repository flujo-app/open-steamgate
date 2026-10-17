// SPDX-License-Identifier: MIT
// ANOMALY-2026-10-17-reference-occurs: the pinned syntax resolver returns
// a reference row before applying the obsolete OCCURS table declaration.
const installed = Symbol.for('osd.referenceOccurs.syntax');
export function installReferenceOccurs(TypeParser, core) {
  const proto = TypeParser?.prototype;
  if (!proto?.parseType || !proto?.isOccurs || !core?.BasicTypes?.TableType) {
    throw new Error('Reference OCCURS correction needs the selected syntax resolver');
  }
  if (proto[installed]) return;
  const original = proto.parseType;
  proto.parseType = function(node, qualifiedName) {
    const result = original.call(this,node,qualifiedName);
    const type = (node.findFirstExpression(core.Expressions.Type) ?? node.findFirstExpression(core.Expressions.TypeTable))
      ?.concatTokens().toUpperCase();
    if (result && !(result instanceof core.BasicTypes.TableType) && type?.startsWith('TYPE REF TO ') && this.isOccurs(node)) {
      return new core.BasicTypes.TableType(result, {
        withHeader:node.concatTokens().toUpperCase().includes(' WITH HEADER LINE'),
        keyType:core.BasicTypes.TableKeyType.default,
      },qualifiedName);
    }
    return result;
  };
  proto[installed] = true;
}
