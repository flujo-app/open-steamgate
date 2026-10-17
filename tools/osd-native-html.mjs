// SPDX-License-Identifier: MIT
// Plain forms can be used by a browser and Steamgate's existing DIAG adapter.
const escape = value => String(value ?? '').replace(/[&<>"']/g,
  character => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[character]));
const radioName = element => `radio:${element.attributes?.contName ?? element.name}`;
const writable = element => element.name && element.input && !element.invisible && element.kind !== 'okcode';
const textValue = element => String(element.value ?? '').trimEnd();
const hidden = (name, value) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`;
const button = (code, label) => `<button name="command" value="${escape(code)}">${escape(label || code)}</button>`;

export function nativeFormInput(event, body) {
  if (Number(body.get('revision')) !== event.revision) throw new Error('This screen has changed. Reload it before submitting.');
  const fields = {}, allowed = new Set(['csrf', 'revision', 'command', 'action']);
  const elements = (event.screen?.elements ?? []).filter(writable);
  for (const element of elements) allowed.add(element.kind === 'radio' ? radioName(element) : `field:${element.name}`);
  for (const [name] of body) {
    if (!allowed.has(name) || body.getAll(name).length !== 1) throw new Error('Unexpected or duplicate screen field');
  }
  if (event.kind === 'message' && body.get('command')) throw new Error('This message requires acknowledgement');
  for (const element of elements) {
    let value;
    if (element.kind === 'radio') {
      const group = radioName(element), selected = body.get(group);
      if (selected !== null && !elements.some(e => e.kind === 'radio' && radioName(e) === group && e.name === selected)) {
        throw new Error('Invalid radio selection');
      }
      value = selected === element.name ? 'X' : '';
    } else if (element.kind === 'checkbox') {
      const selected = body.get(`field:${element.name}`);
      if (selected !== null && selected !== 'X') throw new Error('Invalid checkbox value');
      value = selected ?? '';
    } else {
      value = body.get(`field:${element.name}`);
      if (value === null) throw new Error(`Missing screen field ${element.name}`);
      if (element.length && value.length > element.length) throw new Error(`Screen field ${element.name} is too long`);
    }
    // FIELD ... ON REQUEST is not triggered by every unchanged HTML input.
    if (value !== textValue(element)) fields[element.name] = value;
  }
  return {revision:event.revision, command:body.get('command') ?? '', fields};
}

export function renderNativePage({path, csrf, transactions, event, error}) {
  const title = event?.title || 'Native transactions';
  const form = contents => `<form method="post" action="${escape(path)}">${hidden('csrf', csrf)}${contents}</form>`;
  let content;
  if (event?.kind === 'message') {
    content=`<p id="msg" role="alert">${escape(event.message.text)}</p>` +
      form(hidden('action','resume')+hidden('revision',event.revision)+button('','OK')) +
      form(hidden('action','close')+hidden('revision',event.revision)+'<button>End transaction</button>');
  } else if (event?.kind === 'screen') {
    const elements = event.screen.elements;
    const fields = [];
    const labels = new Map(elements.filter(e => e.kind === 'text' && e.name).map(e => [e.name, e.text]));
    for (const [index, element] of elements.entries()) {
      if (element.invisible || element.kind === 'okcode') continue;
      const label = labels.get(element.name) || element.text || element.name;
      const id = `field-${index}`;
      if (element.kind === 'pushbutton') { fields.push(button(element.ucomm, element.text)); continue; }
      if (element.kind === 'frame') { fields.push(`<h2>${escape(element.text)}</h2>`); continue; }
      if (element.kind === 'text') {
        if (!elements.some(e => e.name === element.name && e.input)) fields.push(`<p>${escape(element.text)}</p>`);
        continue;
      }
      if (!element.input) {
        if (element.output) fields.push(`<p>${escape(label)}: ${escape(textValue(element))}</p>`);
        continue;
      }
      if (['radio', 'checkbox'].includes(element.kind)) {
        fields.push(`<label class="choice" for="${id}"><input id="${id}" type="${element.kind}" ` +
          `name="${escape(element.kind === 'radio' ? radioName(element) : `field:${element.name}`)}" ` +
          `value="${escape(element.kind === 'radio' ? element.name : 'X')}"${textValue(element) === 'X' ? ' checked' : ''}>${escape(label)}</label>`);
      } else if (['input', 'input-output'].includes(element.kind)) {
        fields.push(`<label for="${id}">${escape(label)}${element.required ? ' *' : ''}</label>` +
          `<input id="${id}" type="text" name="field:${escape(element.name)}" value="${escape(textValue(element))}" ` +
          `${element.length ? `maxlength="${Number(element.length)}"` : ''} aria-required="${!!element.required}">`);
      } else throw new Error(`Native screen control is not supported: ${element.kind}`);
    }
    const actions = (event.status?.functions ?? []).map(f => button(f.code, f.text || f.iconText));
    content = form(hidden('action', 'resume') + hidden('revision', event.revision) +
      `<div class="fields">${fields.join('')}</div><div class="toolbar">${button('', 'Continue')}${actions.join('')}</div>`) +
      form(hidden('action', 'close') + hidden('revision', event.revision) + '<button>End transaction</button>');
    // Controls have their own ABAP-generated event forms. Do not nest them in
    // the dynpro form, or silently present controls with no event dispatcher.
    if (event.controlsHtml?.trim()) throw new Error('Native control-framework event dispatch is not connected yet');
    if (event.message) content=`<p id="msg" role="${event.message.type === 'S' ? 'status' : 'alert'}">${escape(event.message.text)}</p>`+content;
  } else {
    const message = error || (event?.kind === 'error' ? event.error.message : event?.message?.text || (event ? 'Transaction ended.' : ''));
    content = (message ? `<p id="msg">${escape(message)}</p>` : '') + form(hidden('action', 'start') +
      Object.keys(transactions).map(name => `<button name="transaction" value="${escape(name)}">${escape(name)}</button>`).join(''));
  }
  if (error && ['screen','message'].includes(event?.kind)) content = `<p id="msg" role="alert">${escape(error)}</p>` + content;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escape(title)}</title><style>body{font:16px system-ui;margin:0;background:#f4f6f8;color:#172c40}main{max-width:64rem;margin:auto;padding:1.5rem}h1{font-size:1.5rem}h2{font-size:1.1rem}.toolbar{display:flex;gap:.4rem;flex-wrap:wrap}button,input{font:inherit;padding:.6rem;border:1px solid #8d9ba8;border-radius:4px}button{cursor:pointer;background:white;margin:.2rem}.fields{display:grid;gap:.6rem;max-width:36rem;margin:1rem 0}input[type=text]{min-width:0;width:100%;box-sizing:border-box}.choice{display:flex;align-items:center;gap:.6rem}#msg{padding:1rem;background:#fff1d6}@media(max-width:40rem){main{padding:.8rem}.toolbar button{flex:1 1 8rem}}</style></head><body><main><h1>${escape(title)}</h1>${content}</main></body></html>`;
}
