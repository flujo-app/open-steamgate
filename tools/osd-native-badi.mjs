// SPDX-License-Identifier: MIT
// The native session owns BAdI objects and plugin instances. Configuration is a
// complete, host-supplied selection of active implementations, never user input.
export const nativeBadiSourceURL = import.meta.url;
const nameOf = value => String(value?.get ? value.get() : value ?? '').trim().toUpperCase();
const identifier = value => {
  const name = nameOf(value);
  if (!/^(?:\/[A-Z0-9_]+\/)?[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error('Invalid BAdI identifier');
  return name;
};
const methodKey = (interfaceName,method) => `${interfaceName}~${method}`.toLowerCase().replaceAll('/','$').replace('~','$');

export class NativeBadiRuntime {
  #definitions = new Map();
  #handles = new WeakMap();
  #instances = new Map();
  #used = false;
  constructor(abap) {
    if (abap.Badi) throw new Error('This runtime already owns BAdI state');
    this.abap = abap;
    abap.Badi = this;
  }

  define(definition) {
    if (this.#used) throw new Error('Cannot change BAdI configuration after use');
    const name = identifier(definition.name);
    if (this.#definitions.has(name)) throw new Error(`Duplicate BAdI definition ${name}`);
    if (typeof definition.singleUse !== 'boolean' || !Array.isArray(definition.implementations)) {
      throw new Error(`BAdI ${name} needs a complete implementation selection`);
    }
    if (!['new','reuse'].includes(definition.instantiation) || !Array.isArray(definition.filters) || definition.filters.length) {
      throw new Error(`BAdI ${name}: filters or context-dependent instantiation are not implemented`);
    }
    const seen = new Set();
    const implementations = definition.implementations.map(implementation => {
      const key = identifier(implementation.name);
      if (seen.has(key) || typeof implementation.isDefault !== 'boolean') throw new Error(`Invalid BAdI implementation ${key}`);
      seen.add(key);
      return {name:key,className:identifier(implementation.className),isDefault:implementation.isDefault};
    });
    this.#definitions.set(name,{name,interfaceName:identifier(definition.interfaceName),
      singleUse:definition.singleUse,instantiation:definition.instantiation,implementations,
      fallbackClass:definition.fallbackClass ? identifier(definition.fallbackClass) : undefined});
  }

  async #raise(className) {
    const Class = this.abap.Classes[className];
    if (!Class) throw new Error(`${className}: exception class is not loaded`);
    throw await (new Class()).constructor_();
  }

  async #instantiate(className,definition) {
    const create = async () => {
      const Class = this.abap.Classes[className];
      const Interface = this.abap.Classes[definition.interfaceName];
      if (!Class || !Interface) throw new Error(`BAdI ${definition.name}: missing compiled class or interface ${className}/${definition.interfaceName}`);
      this.abap.statements.checkCreateObjectType(Class,Interface,definition.interfaceName);
      return (new Class()).constructor_();
    };
    if (definition.instantiation === 'new') return create();
    // Reuse belongs to the implementation class within the internal session,
    // including when that class implements more than one BAdI interface.
    let pending = this.#instances.get(className);
    if (!pending) {
      pending = create();
      this.#instances.set(className,pending);
      try { return await pending; }
      catch (error) { this.#instances.delete(className); throw error; }
    }
    const instance = await pending;
    const Class = this.abap.Classes[className], Interface = this.abap.Classes[definition.interfaceName];
    if (!Interface) throw new Error(`Missing compiled BAdI interface ${definition.interfaceName}`);
    this.abap.statements.checkCreateObjectType(Class,Interface,definition.interfaceName);
    return instance;
  }

  async get(name) {
    name = identifier(name);
    const definition = this.#definitions.get(name);
    if (!definition) throw new Error(`BAdI ${name} has no runtime configuration`);
    this.#used = true;
    let selected = definition.implementations.filter(item => !item.isDefault);
    if (!selected.length) selected = definition.implementations.filter(item => item.isDefault);
    if (!selected.length && definition.fallbackClass) selected = [{className:definition.fallbackClass}];
    if (definition.singleUse && !selected.length) return this.#raise('CX_BADI_NOT_IMPLEMENTED');
    if (definition.singleUse && selected.length > 1) return this.#raise('CX_BADI_MULTIPLY_IMPLEMENTED');
    const plugins = [];
    for (const item of selected) plugins.push(await this.#instantiate(item.className,definition));
    const handle = Object.freeze({});
    this.#handles.set(handle,{definition,plugins});
    return handle;
  }

  async call(reference,definitionName,method,parameters = {}) {
    const handle = reference?.get?.();
    if (!handle) return this.#raise('CX_SY_REF_IS_INITIAL');
    const data = this.#handles.get(handle);
    if (!data || data.definition.name !== identifier(definitionName)) throw new Error('Invalid or foreign BAdI object');
    const key = methodKey(data.definition.interfaceName,identifier(method));
    let result;
    for (const plugin of data.plugins) {
      if (typeof plugin[key] !== 'function') throw new Error(`BAdI method is not compiled: ${key}`);
      result = await plugin[key](parameters);
    }
    return result;
  }
}
