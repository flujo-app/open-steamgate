// SPDX-License-Identifier: MIT
// One worker/module graph per native ABAP transaction. This isolates globals;
// it is not a sandbox for untrusted code. Only host-owned configuration chooses
// a generation, bootstrap or entry module. HTTP input never chooses a path.
import {Worker} from 'node:worker_threads';

export class NativeDynproSession {
  constructor(configuration, {timeoutMs = 60000, closeTimeoutMs = 2000, resourceLimits} = {}) {
    this.timeoutMs = timeoutMs;
    this.closeTimeoutMs = closeTimeoutMs;
    this.serial = 0;
    this.pending = new Map();
    this.worker = new Worker(new URL('./osd-native-worker.mjs', import.meta.url), {
      workerData: configuration, resourceLimits,
    });
    this.worker.on('message', message => {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(Object.assign(new Error(message.error.message), {code: message.error.code}));
      else call.resolve(message.result);
    });
    this.worker.on('error', error => this.fail(error));
    this.worker.on('exit', code => {
      this.closed = true;
      this.fail(new Error(`Native transaction worker exited (${code})`));
    });
  }

  fail(error) {
    this.failure ??= error;
    for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(error); }
    this.pending.clear();
  }

  request(method, input, timeoutMs = this.timeoutMs) {
    if (this.closed || this.failure) return Promise.reject(this.failure ?? new Error('Native transaction is closed'));
    const id = ++this.serial;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error(`Native transaction ${method} exceeded ${timeoutMs} ms`));
        void this.worker.terminate();
      }, timeoutMs);
      this.pending.set(id, {resolve, reject, timer});
      try { this.worker.postMessage({id, method, input}); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async step(method, input) {
    if (this.busy) throw new Error('A native transaction step is already in progress');
    if (this.closing || this.terminal) throw new Error('Native transaction has ended');
    this.busy = true;
    try {
      const event = await this.request(method, input);
      if (!['screen','message'].includes(event.kind)) {
        this.terminal = true;
        await this.close();
      }
      return event;
    } finally { this.busy = false; }
  }

  start() {
    if (this.started) return Promise.reject(new Error('Native transaction already started'));
    this.started = true;
    return this.step('start');
  }

  resume(input) {
    if (!this.started) return Promise.reject(new Error('Native transaction has not started'));
    return this.step('resume', input);
  }

  close() {
    return this.closing ??= (async () => {
      try { if (!this.closed && !this.failure) await this.request('close', undefined, this.closeTimeoutMs); }
      finally {
        this.closed = true;
        this.fail(new Error('Native transaction is closed'));
        await this.worker.terminate();
      }
    })();
  }
}
