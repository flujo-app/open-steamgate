// SPDX-License-Identifier: MIT
import {randomBytes, timingSafeEqual} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {NativeDynproSession} from './osd-native-session.mjs';
import {nativeFormInput, renderNativePage} from './osd-native-html.mjs';

const token = () => randomBytes(24).toString('hex');
const equal = (a, b) => {
  const left = Buffer.from(a ?? ''), right = Buffer.from(b ?? '');
  return left.length === right.length && timingSafeEqual(left, right);
};

// Configuration is local host administration, not a request parameter. A
// private generation stays private; no source files are served by this route.
export function nativeConfiguration(file) {
  const configuration = JSON.parse(readFileSync(file, 'utf8'));
  const base = dirname(resolve(file));
  if (!configuration.transactions || !Object.keys(configuration.transactions).length) throw new Error('Native transactions are not configured');
  for (const [name, transaction] of Object.entries(configuration.transactions)) {
    if (!/^[A-Z0-9_/$-]{1,40}$/.test(name)) throw new Error('Invalid native transaction name');
    if (transaction.badis !== undefined && !Array.isArray(transaction.badis)) throw new Error(`Invalid BAdI configuration for ${name}`);
    if (transaction.bootstrap) transaction.bootstrap = resolve(base, transaction.bootstrap);
    else {
      if (!transaction.output || !transaction.entry) throw new Error(`Missing generation or entry for ${name}`);
      transaction.output = resolve(base, transaction.output);
      transaction.screens = (transaction.screens ?? []).map(path => resolve(base, path));
    }
    transaction.context = {...transaction.context, transaction:name};
  }
  return configuration;
}

export function mountNativeDynpro(app, path, {file = process.env.OSD_NATIVE_DYNPRO_CONFIG,
  createSession = (definition, options) => new NativeDynproSession(definition, options)} = {}) {
  if (!file) { app.all(path, (_req, res) => res.status(404).end()); return {close:async () => {}}; }
  const configuration = nativeConfiguration(file);
  const sessions = new Map();
  let stopping = false;
  const maxSessions = configuration.maxSessions ?? 4;
  const idleTimeoutMs = configuration.idleTimeoutMs ?? 20 * 60 * 1000;
  if (!Number.isInteger(maxSessions) || maxSessions < 1 || !Number.isFinite(idleTimeoutMs) || idleTimeoutMs < 1000) {
    throw new Error('Invalid native session limits');
  }
  const cookieName = 'osd_native_session';
  const dispose = async (id, session) => {
    sessions.delete(id);
    await session.worker?.close();
  };
  const expiry = setInterval(() => {
    for (const [id, session] of sessions) {
      if (!session.busy && Date.now() - session.touched > idleTimeoutMs) void dispose(id, session).catch(console.error);
    }
  }, Math.min(idleTimeoutMs, 60000));
  expiry.unref();
  app.all(path, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'self'");
    if (stopping) return res.status(503).end();
    if (!['GET', 'POST'].includes(req.method)) return res.status(405).set('Allow', 'GET, POST').end();
    if (req.headers['sec-fetch-site'] === 'cross-site') return res.status(403).end();
    const cookies = String(req.headers.cookie ?? '').split(';').map(part => part.trim().split('='));
    let id = cookies.find(([name]) => name === cookieName)?.[1];
    let session = sessions.get(id);
    if (!session) {
      if (req.method !== 'GET') return res.status(409).type('text').send('Session expired. Reload this page.');
      if (sessions.size >= maxSessions) return res.status(503).type('text').send('All native sessions are in use. Try again after a session ends.');
      id = token(); session = {csrf:token(), touched:Date.now()}; sessions.set(id, session);
      res.append('Set-Cookie', `${cookieName}=${id}; Path=${path}; HttpOnly; SameSite=Strict${req.secure ? '; Secure' : ''}`);
    }
    const render = (status = 200, error) => res.status(status).type('html').send(renderNativePage({path,
      csrf:session.csrf, transactions:configuration.transactions, event:session.event, error}));
    session.touched = Date.now();
    if (session.busy) return res.status(409).type('text').send('A transaction step is already running.');
    if (req.method === 'GET') return render();
    if (!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] ?? '')) return res.status(415).end();
    if (!Buffer.isBuffer(req.body) || req.body.length > 128 * 1024) return res.status(413).end();
    const body = new URLSearchParams(req.body.toString('utf8'));
    if (body.getAll('csrf').length !== 1 || !equal(body.get('csrf'), session.csrf)) return res.status(403).end();
    if (body.getAll('action').length !== 1) return render(400, 'Invalid transaction action.');
    session.busy = true;
    try {
      switch (body.get('action')) {
        case 'start': {
          if (session.worker) return render(409, 'End the current transaction before starting another.');
          const name = body.get('transaction');
          if (!Object.hasOwn(configuration.transactions, name)) return render(400, 'Unknown transaction.');
          session.worker = createSession(configuration.transactions[name], configuration);
          session.event = await session.worker.start();
          break;
        }
        case 'resume': {
          if (!session.worker || !['screen','message'].includes(session.event?.kind)) return render(409, 'No active transaction.');
          // Reject bad input before touching the waiting ABAP continuation.
          let input;
          try { input = nativeFormInput(session.event, body); }
          catch (error) { return render(409, error.message); }
          session.event = await session.worker.resume(input);
          break;
        }
        case 'close':
          if (['screen','message'].includes(session.event?.kind) && (body.getAll('revision').length !== 1 || Number(body.get('revision')) !== session.event.revision)) {
            return render(409, 'This screen has changed. Reload it before ending the transaction.');
          }
          await session.worker?.close();
          session.worker = undefined; session.event = {kind:'complete'};
          break;
        default: return render(400, 'Unknown transaction action.');
      }
      if (!['screen','message'].includes(session.event?.kind)) {
        await session.worker?.close(); session.worker = undefined;
      }
      return render();
    } catch (error) {
      try { await session.worker?.close(); } catch { /* preserve the original error */ }
      session.worker = undefined; session.event = {kind:'error', error:{message:error.message}};
      return render(500);
    } finally { session.busy = false; session.touched = Date.now(); }
  });
  return {async close() {
    stopping = true;
    clearInterval(expiry);
    await Promise.allSettled([...sessions].map(([id, session]) => dispose(id, session)));
  }};
}
