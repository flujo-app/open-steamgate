// SPDX-License-Identifier: MIT
import {parentPort, workerData} from 'node:worker_threads';
import {readFile} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {pathToFileURL} from 'node:url';

let engine, entry, booting, activeStep, closing = false;
const errorOf = error => ({message: error?.message ?? String(error), code: error?.code});
const importFile = file => import(pathToFileURL(resolve(file)).href);
function applyContext() {
  const fields = {user:'uname', client:'mandt', language:'langu', transaction:'tcode'};
  for (const [key, value] of Object.entries(workerData.context ?? {})) {
    if (!fields[key] || typeof value !== 'string') throw new Error(`Invalid native session context: ${key}`);
    engine.system(fields[key], value);
  }
}

async function boot() {
  if (workerData.bootstrap) {
    // A host bootstrap can supply its existing database/repository services.
    // It must return an initialized runtime and the actual ABAP entry closure.
    const module = await importFile(workerData.bootstrap);
    ({engine, entry} = await module.boot(workerData));
    applyContext();
  } else {
    const output = resolve(workerData.output);
    await importFile(join(output, '_top.mjs'));
    engine = globalThis.abap?.Dynpro;
    if (!engine) throw new Error('Generation was not compiled with nativeDynpro enabled');
    for (const file of workerData.screens ?? []) {
      engine.defineProgram(JSON.parse(await readFile(resolve(file), 'utf8')));
    }
    for (const definition of workerData.badis ?? []) engine.abap.Badi.define(definition);
    if (workerData.profileParameters) engine.setProfileParameters(workerData.profileParameters);
    applyContext();
    await importFile(join(output, 'init.mjs'));
    entry = () => importFile(resolve(output, workerData.entry));
  }
  if (!engine || typeof entry !== 'function') throw new Error('Invalid native transaction bootstrap');
}

async function database(action) {
  for (const connection of Object.values(engine?.abap.context?.databaseConnections ?? {})) await connection[action]?.();
}

async function deliver(event) {
  if (event.kind === 'error') {
    await database('rollback');
    return {kind:'error', error:errorOf(event.error)};
  }
  if (event.kind === 'screen') {
    const abap = engine.abap;
    const controls = abap.Classes?.CL_GUI_CONTROL;
    const hasContent = controls?.has_content ? await controls.has_content() : undefined;
    if (hasContent?.get() === 'X') {
      const rendered = await controls.render_html({iv_document: new abap.types.Character({length:1}).set(' ')});
      event.controlsHtml = rendered?.get ? rendered.get() : rendered;
    }
  }
  // Each displayed screen ends a database dialog step. Nothing holds a LUW
  // open while the user is deciding what to type into the next screen.
  await database('commit');
  // Entry modules return ES module namespaces, which are not structured-clone
  // values. A completed interactive transaction has no transport return value.
  return event.kind === 'complete' ? {kind:'complete',...(event.message ? {message:event.message} : {})} : event;
}

async function runStep(message) {
  if (closing) throw new Error('Native transaction is closing');
  if (message.method === 'start') {
    if (booting) throw new Error('Native transaction already started');
    booting = boot();
    await booting;
    if (closing) throw new Error('Native transaction is closing');
    return deliver(await engine.start(async () => { await entry(); }));
  }
  if (message.method === 'resume') {
    if (!engine || !booting) throw new Error('Native transaction has not started');
    return deliver(await engine.resume(message.input));
  }
  throw new Error('Unknown native transaction operation');
}

async function close() {
  closing = true;
  try { await booting; } catch { /* close resources from a partial boot */ }
  await engine?.cancel();
  try { await activeStep; } catch { /* runStep sends its own failure */ }
  await database('rollback');
  await database('disconnect');
}

parentPort.on('message', message => {
  const respond = promise => promise.then(
    result => parentPort.postMessage({id:message.id, result}),
    error => parentPort.postMessage({id:message.id, error:errorOf(error)}),
  ).catch(() => process.exit(1));
  if (message.method === 'close') { void respond(close()); return; }
  if (activeStep) { void respond(Promise.reject(new Error('A native transaction step is already in progress'))); return; }
  const work = runStep(message);
  activeStep = work;
  void respond(work.finally(() => { if (activeStep === work) activeStep = undefined; }));
});
