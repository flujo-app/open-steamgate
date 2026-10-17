// SPDX-License-Identifier: MIT
// A dialog stack for native transpiled MODULE / CALL SCREEN code. One instance
// belongs to one isolated ABAP runtime; function-group globals must not be shared
// between user sessions. Screen metadata uses open-abap-gui's parsed format.
export const nativeDynproSourceURL = import.meta.url;
const scalar = value => value?.get ? value.get() : value;
const nameOf = value => String(scalar(value) ?? '').trim().toUpperCase();
const numberOf = value => {
  const text = String(scalar(value) ?? '').trim();
  if (!/^\d{1,4}$/.test(text)) throw new Error(`Invalid screen number: ${text}`);
  return text.padStart(4, '0');
};
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return {promise, resolve, reject};
};
class LeaveScreen extends Error {
  constructor(frame) { super('Leave screen'); this.frame = frame; }
}
class LeaveProgram extends Error {}
class RepeatInput extends Error {
  constructor(frame,input) { super('Repeat dialog validation');this.frame=frame;this.input=input; }
}
class ForwardMessage extends Error {
  constructor(target) { super('Message handled by a calling function');this.target=target; }
}

export class NativeDynproRuntime {
  constructor(abap) {
    if (abap.Dynpro) throw new Error('This ABAP runtime already owns a dialog stack');
    this.abap = abap;
    this.programs = new Map();
    this.modules = new Map();
    this.bindings = new Map();
    this.stack = [];
    this.events = [];
    this.procedures = [];
    this.revision = 0;
    abap.Dynpro = this;
  }

  defineProgram(metadata) {
    const program = nameOf(metadata.programName);
    if (!program) throw new Error('Screen metadata needs a program name');
    if (this.running) throw new Error('Cannot replace screens during a dialog');
    const screens = new Map();
    for (const screen of metadata.screens ?? []) {
      const number = numberOf(screen.number);
      if (screens.has(number)) throw new Error(`Duplicate screen ${program}/${number}`);
      const flow = metadata.flowLogic?.find(f => numberOf(f.screen) === number);
      if (!flow) throw new Error(`Missing flow logic for ${program}/${number}`);
      screens.set(number, {...screen, number, flow});
    }
    this.programs.set(program, {...metadata, screens});
  }

  unsupported(feature) {
    const error=new Error(`Native dialog operation is not implemented: ${feature}`);
    error.code='NATIVE_UNSUPPORTED_STATEMENT';
    throw error;
  }

  setProfileParameters(parameters) {
    if (this.running || this.profileParameters) throw new Error('Profile parameters are fixed for the native session');
    if (!parameters || typeof parameters !== 'object' || Array.isArray(parameters)) throw new Error('Invalid profile parameter configuration');
    const values = new Map();
    for (const [name, result] of Object.entries(parameters)) {
      if (!name || name !== name.trimEnd() || !result || !Number.isInteger(result.subrc) || result.subrc < 0 ||
          (Object.hasOwn(result,'value') && typeof result.value !== 'string') ||
          (result.subrc === 0 && typeof result.value !== 'string')) throw new Error('Invalid profile parameter result');
      values.set(name,Object.freeze({...result}));
    }
    this.profileParameters = values;
  }

  profileParameter(name, target) {
    const key = String(scalar(name)).trimEnd();
    if (!this.profileParameters?.has(key)) throw new Error(`Profile parameter is not configured: ${key}`);
    if (!target || typeof target.set !== 'function') throw new Error('Profile parameter result is not writable');
    const result = this.profileParameters.get(key);
    // A failed kernel lookup can leave its FIELD operand untouched. Absence of
    // value records that observed behavior; it is distinct from an empty value.
    if (Object.hasOwn(result,'value')) target.set(result.value);
    this.system('subrc',result.subrc);
  }

  enterProcedure(kind, input) {
    const frame={kind,exceptions:new Set(input?.[Symbol.for('osd.native.exceptions')] ?? [])};
    this.procedures.push(frame);
    return frame;
  }

  procedureError(frame,error) {
    if (error instanceof ForwardMessage && error.target === frame) {
      throw new this.abap.ClassicError({classic:'error_message'});
    }
    throw error;
  }

  leaveProcedure(frame) {
    if (this.procedures.at(-1) !== frame) throw new Error('Native procedure stack mismatch');
    this.procedures.pop();
  }

  async message(options) {
    if (options.into && options.raising) throw new Error('Native MESSAGE INTO with RAISING is not implemented');
    const text=new this.abap.types.String();
    // Reuse the selected runtime's message catalog/exception-text formatter.
    // INTO prevents its console-only display path from running.
    await this.abap.statements.message({...options,into:options.into ?? text});
    if (options.into) return;
    const type=nameOf(this.system('msgty'));
    if (!['S','I','W','E','A','X'].includes(type)) throw new Error(`Invalid message type ${type}`);
    const current=this.procedures.at(-1), raising=nameOf(options.raising);
    if (raising && (current?.exceptions.has(raising) || current?.exceptions.has('OTHERS'))) {
      throw new this.abap.ClassicError({classic:raising.toLowerCase()});
    }
    const handler=this.procedures.findLast(frame => frame.kind === 'function' && frame.exceptions.has('ERROR_MESSAGE'));
    if (handler && ['S','I','W'].includes(type)) return;
    if (handler && type === 'E') throw new ForwardMessage(handler);
    if (handler && type === 'A') {
      // A handled abort requires all ROLLBACK WORK effects, including update
      // registrations. Database rollback alone does not satisfy that contract.
      if (!this.rollbackWork) throw new Error('Handled abort message requires a complete ROLLBACK WORK service');
      await this.rollbackWork();
      throw new ForwardMessage(handler);
    }
    const message={type,displayLike:nameOf(options.displayLike) || type,text:text.get(),
      id:this.system('msgid'),number:this.system('msgno')};
    if (type === 'S') { this.statusMessage=message;return; }
    if (type === 'A' || type === 'X') {
      const error=new Error(message.text);error.code=type === 'X' ? 'MESSAGE_TYPE_X' : 'MESSAGE_TYPE_A';throw error;
    }
    if (!this.running) throw new Error('Interactive MESSAGE needs an active dialog');
    const frame=this.stack.at(-1);
    if (type === 'I') { await this.waitForInput(frame,{message,acknowledgement:true});return; }
    const context=frame?.flowContext;
    if (!context || context.phase !== 'pai' || context.step.atExitCommand) {
      throw new Error(`Message ${type} is not implemented in this processing context`);
    }
    const response=await this.waitForInput(frame,{message,editableFields:context.fields});
    if (type === 'W' && response.command === '' && Object.keys(response.fields).length === 0) return;
    throw new RepeatInput(frame,response);
  }

  registerModule(program, phase, name, callback, bindings = {}) {
    program = nameOf(program); name = nameOf(name);
    if (!['pbo', 'pai'].includes(phase) || typeof callback !== 'function') throw new Error('Invalid dialog module');
    const key = `${program}/${phase}/${name}`;
    if (this.modules.has(key)) throw new Error(`Duplicate dialog module ${key}`);
    this.modules.set(key, callback);
    const globals = this.bindings.get(program) ?? new Map();
    for (const [field, getter] of Object.entries(bindings)) {
      if (typeof getter !== 'function') throw new Error('A screen binding must return an ABAP data object');
      globals.set(nameOf(field), getter);
    }
    this.bindings.set(program, globals);
  }

  field(program, name) {
    const [base, ...components] = nameOf(name).split('-');
    let value = base === 'SY' || base === 'SYST' ? this.abap.builtin.sy : this.bindings.get(program)?.get(base)?.();
    for (const component of components) value = value?.get?.()?.[component.toLowerCase()];
    if (!value || typeof value.get !== 'function' || typeof value.set !== 'function') {
      throw new Error(`Unbound screen field ${program}/${name}`);
    }
    return value;
  }

  system(name, value) {
    const field = this.abap.builtin.sy.get()[name];
    if (!field) throw new Error(`ABAP runtime is missing SY-${name.toUpperCase()}`);
    if (arguments.length === 2) field.set(value);
    return field.get();
  }

  current() {
    const frame = this.stack.at(-1);
    if (!frame) throw new Error('No active screen');
    return frame;
  }

  publish(event) {
    if (this.reader) { const reader = this.reader; this.reader = undefined; reader.resolve(event); }
    else this.events.push(event);
  }

  next() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    if (this.reader) throw new Error('A dialog already has a pending reader');
    if (!this.running) return Promise.resolve({kind:'complete'});
    this.reader = deferred();
    return this.reader.promise;
  }

  start(entry) {
    if (this.running) throw new Error('An isolated ABAP runtime can run only one dialog at a time');
    if (this.events.length) throw new Error('Consume the previous dialog result first');
    this.cancelled = undefined;
    this.running = true;
    this.completion = Promise.resolve().then(entry).then(
      result => { this.running = false; this.publish({kind:'complete', result,...(this.statusMessage ? {message:this.statusMessage} : {})}); },
      error => {
        this.running = false;
        this.publish(error instanceof LeaveProgram ? {kind:'complete'} : {kind:'error', error});
      },
    );
    return this.next();
  }

  resume({revision, command = '', fields = {}, event = 'pai', field} = {}) {
    const pending = this.pending;
    if (!pending || revision !== pending.revision) throw new Error('Stale or duplicate screen submission');
    if (!['pai', 'pov', 'poh'].includes(event)) throw new Error('Unsupported screen event');
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) throw new Error('Invalid screen fields');
    const allowed = pending.allowed;
    if (pending.acknowledgement && (event !== 'pai' || command !== '')) throw new Error('This message requires acknowledgement');
    const values = {};
    for (const [name, value] of Object.entries(fields)) {
      if (!allowed.has(nameOf(name))) throw new Error(`Screen input is not writable: ${name}`);
      if (typeof value !== 'string') throw new Error('Screen values must be strings');
      values[nameOf(name)] = value;
    }
    if (event !== 'pai' && !allowed.has(nameOf(field))) throw new Error('Help requested for an unknown field');
    this.pending = undefined;
    pending.resolve({command:nameOf(command), fields:values, event, field:nameOf(field)});
    return this.next();
  }

  async cancel() {
    if (!this.running) return;
    this.cancelled = new Error('Dialog cancelled');
    const pending = this.pending;
    this.pending = undefined;
    pending?.reject(this.cancelled);
    await this.completion;
  }

  setScreen(number) { this.current().next = numberOf(number); }
  leaveScreen(number) {
    if (number !== undefined) this.setScreen(number);
    throw new LeaveScreen(this.current());
  }
  suppressDialog() { this.current().suppressed = true; }
  leaveProgram() { throw new LeaveProgram('Leave program'); }

  setStatus(program, name, excluding) {
    const frame = this.current();
    program = nameOf(program); name = nameOf(name);
    const status = this.programs.get(program)?.guiStatuses?.[name];
    if (!status) throw new Error(`Missing GUI status ${program}/${name}`);
    const values = excluding?.array ? excluding.array() : excluding === undefined ? [] : [excluding];
    const excluded = new Set(values.map(value => {
      const row = scalar(value);
      return nameOf(row && typeof row === 'object' ? Object.values(row)[0] : row);
    }));
    frame.status = {...status, functions:status.functions?.filter(f => !excluded.has(nameOf(f.code))),
      pfActions:status.pfActions?.filter(f => !excluded.has(nameOf(f.ucomm))), excluded:[...excluded]};
    this.system('pfkey', name);
  }

  setTitle(program, name, values = []) {
    const title = this.programs.get(nameOf(program))?.titlebars?.[nameOf(name)];
    if (!title) throw new Error(`Missing titlebar ${nameOf(program)}/${nameOf(name)}`);
    let index = 0;
    this.current().title = title.text.replace(/&([1-9])?/g, (_, number) => String(scalar(values[number ? Number(number)-1 : index++]) ?? ''));
  }

  transport(frame, name, input) {
    name = nameOf(name);
    input.transported ??= new Set();
    if (Object.hasOwn(input.fields, name) && !input.transported.has(name)) {
      this.field(frame.program, name).set(input.fields[name]);
      input.transported.add(name);
    }
  }

  isExit(frame,input) {
    return frame.status?.functions?.some(f => nameOf(f.code) === input.command && nameOf(f.type) === 'E') ?? false;
  }

  setCommand(frame,input) {
    this.system('ucomm',input.command);
    if (frame.screen.okCode) this.field(frame.program,frame.screen.okCode).set(input.command);
    input.exit=this.isExit(frame,input);
  }

  async modulesFor(frame, phase, input = {fields:{}}, {exitOnly=false} = {}) {
    const steps = frame.screen.flow.steps.filter(step => step.phase === phase);
    const contexts=[];
    let group;
    for (const [index,step] of steps.entries()) {
      if (step.kind === 'chain-begin') {
        if (group) throw new Error('Nested screen CHAIN is not supported');
        group={start:index,fields:[]};
      }
      if (step.field && group && !group.fields.includes(nameOf(step.field))) group.fields.push(nameOf(step.field));
      contexts[index]=group ? {...group,conditionFields:[...group.fields]} : {start:index,fields:step.field ? [nameOf(step.field)] : []};
      if (step.kind === 'chain-end') {
        if (!group) throw new Error('Unmatched screen ENDCHAIN');
        group=undefined;
      }
    }
    if (group) throw new Error('Unclosed screen CHAIN');
    for (let index=0;index<steps.length;index++) {
      const step=steps[index], context=contexts[index];
      if (this.cancelled) throw this.cancelled;
      if (['process','chain-begin','chain-end'].includes(step.kind)) continue;
      if (exitOnly && (!step.atExitCommand || !input.exit)) continue;
      if (!exitOnly && step.atExitCommand) continue;
      if (step.kind === 'field' || step.kind === 'field-module') {
        if (phase !== 'pbo' && !exitOnly) this.transport(frame, step.field, input);
        if (step.kind === 'field') continue;
      }
      if (!['module','field-module'].includes(step.kind)) {
        throw new Error(`Unsupported screen flow ${frame.program}/${frame.number}: ${step.source}`);
      }
      if ((phase === 'pov' || phase === 'poh') && nameOf(step.field ?? frame.screen.flow[phase]?.field) !== input.field) continue;
      const chainRequest=step.onChainRequest || /\bON\s+CHAIN-REQUEST\b/i.test(step.source ?? '');
      const chainInput=step.onChainInput || /\bON\s+CHAIN-INPUT\b/i.test(step.source ?? '');
      const fields = step.field && !chainInput && !chainRequest ? [step.field] : context.conditionFields ?? context.fields;
      if ((step.onRequest || chainRequest) && !fields.some(f => Object.hasOwn(input.fields, nameOf(f)))) continue;
      if ((step.onInput || chainInput) && !fields.some(f => !this.abap.compare.initial(this.field(frame.program, f)))) continue;
      const key = `${frame.program}/${phase === 'pbo' ? 'pbo' : 'pai'}/${nameOf(step.name)}`;
      const module = this.modules.get(key);
      if (!module) throw new Error(`Missing dialog module ${key}`);
      const previous=frame.flowContext;
      frame.flowContext={...context,phase,input,index,step};
      try { await module(); }
      catch (error) {
        if (!(error instanceof RepeatInput) || error.frame !== frame) throw error;
        const response=error.input;
        input.fields={...input.fields,...response.fields};
        for (const name of Object.keys(response.fields)) input.transported?.delete(name);
        input.command=response.command;
        this.setCommand(frame,input);
        if (input.exit) {
          await this.modulesFor(frame,'pai',input,{exitOnly:true});
          index=-1;
          continue;
        }
        const changed=new Set(Object.keys(response.fields));
        let restart=context.start;
        for (let earlier=0;earlier<index;earlier++) {
          if (contexts[earlier].fields.some(field => changed.has(field))) restart=Math.min(restart,contexts[earlier].start);
        }
        index=restart-1;
      } finally { frame.flowContext=previous; }
    }
  }

  snapshot(frame, {message,editableFields} = {}) {
    const writable=editableFields === undefined ? undefined : new Set(editableFields.map(nameOf));
    return {kind:'screen', revision:++this.revision, program:frame.program, number:frame.number,
      title:frame.title ?? frame.screen.title, status:frame.status, geometry:frame.geometry,
      message:message ?? this.statusMessage,
      screen:{...frame.screen, elements:frame.screen.elements.map(element => {
        if (!element.name || !(element.input || element.output) || element.kind === 'okcode') return {...element};
        return {...element, input:element.input && (writable === undefined || writable.has(nameOf(element.name))),
          output:element.output || (writable !== undefined && element.input),
          value:scalar(this.field(frame.program, element.name))};
      })}};
  }

  async waitForInput(frame, {message,editableFields,acknowledgement=false} = {}) {
    const snapshot=acknowledgement ? {kind:'message',revision:++this.revision,message,title:frame?.title} :
      this.snapshot(frame,{message,editableFields});
    const response=deferred();
    const allowed=new Set((snapshot.screen?.elements ?? []).filter(e => e.name && e.input && !e.invisible && e.kind !== 'okcode').map(e => nameOf(e.name)));
    this.pending={...response,revision:snapshot.revision,allowed,frame,acknowledgement};
    this.statusMessage=undefined;
    this.publish(snapshot);
    return response.promise;
  }

  async callScreen(program, number, geometry) {
    if (!this.running) throw new Error('CALL SCREEN needs an active dialog');
    program = nameOf(program);
    const metadata = this.programs.get(program);
    if (!metadata) throw new Error(`Missing screen metadata for ${program}`);
    const previous = {dynnr:this.system('dynnr'), ucomm:this.system('ucomm'), pfkey:this.system('pfkey')};
    const frame = {program, number:numberOf(number),
      geometry:geometry && Object.fromEntries(Object.entries(geometry).map(([key,value]) => [key,scalar(value)])),
      status:this.stack.at(-1)?.status};
    this.stack.push(frame);
    let hiddenSteps = 0;
    try {
      while (frame.number !== '0000') {
        if (this.cancelled) throw this.cancelled;
        frame.screen = metadata.screens.get(frame.number);
        if (!frame.screen) throw new Error(`Missing screen ${program}/${frame.number}`);
        frame.next = numberOf(frame.screen.nextScreen ?? '0');
        frame.suppressed = false;
        this.system('dynnr', frame.number);
        try {
          await this.modulesFor(frame, 'pbo');
          let input = {fields:{}, command:this.system('ucomm'), event:'pai'};
          if (frame.suppressed) {
            if (++hiddenSteps > 1000) throw new Error('Suppressed screen sequence did not yield');
          } else {
            hiddenSteps = 0;
            do {
              input = await this.waitForInput(frame);
              if (input.event !== 'pai') await this.modulesFor(frame, input.event, input);
            } while (input.event !== 'pai');
          }
          this.setCommand(frame,input);
          await this.modulesFor(frame,'pai',input,{exitOnly:true});
          const delayed = new Set(frame.screen.flow.steps.filter(s => s.phase === 'pai' && s.field).map(s => nameOf(s.field)));
          for (const name of Object.keys(input.fields)) if (!delayed.has(name)) this.transport(frame, name, input);
          await this.modulesFor(frame, 'pai', input);
        } catch (error) {
          if (!(error instanceof LeaveScreen) || error.frame !== frame) throw error;
        }
        frame.number = frame.next;
      }
    } finally {
      this.stack.pop();
      for (const [name,value] of Object.entries(previous)) this.system(name, value);
    }
  }
}
