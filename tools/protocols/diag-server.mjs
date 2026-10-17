// SPDX-License-Identifier: MIT
// Interactive DIAG transaction listener and explicit tape fixture API.

import {identity} from "../osd-identity.mjs";
import {createServer} from "node:net";
import {describeBind, listenBound} from "../osd-bind.mjs";
import {fileURLToPath} from "node:url";
import {
  buildDiagTapeScreen, DIAG_DP_HEADER_LENGTH, DIAG_HEADER_LENGTH, DIAG_ITEM, encodeDiagMessage, parseDiagItems,
} from "./diag.mjs";
import {encodeNIFrame, NIFrameDecoder, NI_PONG, niControl} from "./ni.mjs";
import {decompressSAP} from "./sap-compress.mjs";
import {buildDynproScreen, readDynproInput} from "./diag-dynpro.mjs";
import {WebguiSession} from "./diag-webgui.mjs";

const DEFAULT_DIAG_MAX_PAYLOAD = 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_HOLD_MS = 12_000;
const DEFAULT_MAX_CONNECTIONS = 64;

function parseClientMessage(payload, first) {
  const headerOffset = first ? DIAG_DP_HEADER_LENGTH : 0;
  if (payload.length < headerOffset + DIAG_HEADER_LENGTH) {
    throw new Error(`short DIAG client message: ${payload.length} bytes`);
  }
  if (first) {
    if (!payload.subarray(0, 4).equals(Buffer.from([0xff, 0xff, 0xff, 0xff]))) {
      throw new Error("DIAG hello has no dispatcher route prefix");
    }
    if ((payload[headerOffset + 1] & 0x10) === 0) throw new Error("DIAG hello has no INI flag");
    if (payload[headerOffset + 7] !== 0) throw new Error("compressed DIAG hello is unsupported");
  }
  const compression = payload[headerOffset + 7];
  const encodedBody = payload.subarray(headerOffset + DIAG_HEADER_LENGTH);
  const body = compression === 0 ? encodedBody : decompressSAP(encodedBody);
  const items = parseDiagItems(body);
  if (first && items.length === 0) throw new Error("DIAG hello has no items");
  return {header: payload.subarray(headerOffset, headerOffset + DIAG_HEADER_LENGTH), items};
}

function isExit(items) {
  return items.some((item) => {
    if (item.type !== DIAG_ITEM.APPL || item.id !== 0x0c || item.sid !== 0x04) return false;
    return ["/I", "/NEX", "/NEND", "/N/EX"].includes(item.value.toString("latin1").trim().toUpperCase());
  });
}

export function createDiagTapeServer({
  logger = () => {}, maxPayloadLength = DEFAULT_DIAG_MAX_PAYLOAD,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS, holdMs = DEFAULT_HOLD_MS,
  maxConnections = DEFAULT_MAX_CONNECTIONS, screenPayload = buildDiagTapeScreen(),
} = {}) {
  if (!ArrayBuffer.isView(screenPayload)) throw new TypeError("DIAG screen payload must be a Buffer or Uint8Array");
  const screen = encodeNIFrame(screenPayload);
  const sessionEnd = encodeNIFrame(encodeDiagMessage({comFlag: 0x0a, msgInfo: 0x01}, []));
  const server = createServer((socket) => {
    const peer = `${socket.remoteAddress ?? "peer"}:${socket.remotePort ?? "?"}`;
    const decoder = new NIFrameDecoder({maxPayloadLength});
    let first = true;
    let holdTimer;
    logger("connect", peer);
    socket.setTimeout(idleTimeoutMs, () => {
      logger("idle-timeout", peer);
      socket.destroy();
    });
    const write = (data) => {
      if (!socket.write(data)) {
        socket.pause();
        socket.once("drain", () => socket.resume());
      }
    };
    const armHold = () => {
      clearTimeout(holdTimer);
      holdTimer = setTimeout(() => socket.end(sessionEnd), holdMs);
      holdTimer.unref();
    };
    socket.on("data", (chunk) => {
      try {
        for (const payload of decoder.push(chunk)) {
          const control = niControl(payload);
          if (control === "NI_PING") {
            write(encodeNIFrame(NI_PONG));
            continue;
          }
          if (control === "NI_PONG") continue;
          const message = parseClientMessage(payload, first);
          first = false;
          if (isExit(message.items)) {
            clearTimeout(holdTimer);
            socket.end(sessionEnd);
            continue;
          }
          write(screen);
          armHold();
        }
      } catch (error) {
        logger("protocol-error", peer, error);
        socket.destroy(error);
      }
    });
    socket.on("end", () => {
      try {
        decoder.finish();
      } catch (error) {
        logger("protocol-error", peer, error);
      }
    });
    socket.on("error", (error) => logger("socket-error", peer, error));
    socket.on("close", () => {
      clearTimeout(holdTimer);
      logger("close", peer);
    });
  });
  server.maxConnections = maxConnections;
  return server;
}

export async function listenDiagTape({port, host, env = process.env, logger, sid} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) {
    throw new RangeError(`DIAG port must be an integer from 0 to 65535, got ${port}`);
  }
  const server = createDiagTapeServer({logger, screenPayload: buildDiagTapeScreen({sid: sid ?? identity(env).sid})});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => {
      server.off("error", reject);
      resolve();
    };
    // no host given: OSD_BIND, with the ::1 twin of the loopback default
    if (host === undefined) listenBound(server, port, env, done);
    else server.listen(port, host, done);
  });
  return server;
}

/** One runtime form session per NI connection. Tape mode remains an explicit
 * fixture API; production uses this interactive listener. */
export function createDiagServer({backend = "http://127.0.0.1:3030", sid = identity().sid,
  logger = () => {}, maxPayloadLength = DEFAULT_DIAG_MAX_PAYLOAD,
  idleTimeoutMs = 15 * 60_000, maxConnections = DEFAULT_MAX_CONNECTIONS,
  sessionFactory = options => new WebguiSession(options)} = {}) {
  const sessionEnd = encodeNIFrame(encodeDiagMessage({comFlag: 0x0a, msgInfo: 1}, []));
  const server = createServer(socket => {
    const peer = `${socket.remoteAddress ?? "peer"}:${socket.remotePort ?? "?"}`;
    const decoder = new NIFrameDecoder({maxPayloadLength});
    const abort = new AbortController();
    const session = sessionFactory({backend, signal: abort.signal});
    let first = true, counter = 0, queued = 0, ending = false;
    let queue = Promise.resolve();
    const fail = error => { logger("protocol-error", peer, error); socket.destroy(); };
    socket.setTimeout(idleTimeoutMs, () => { ending = true; abort.abort(); socket.end(sessionEnd); });
    socket.on("data", chunk => {
      try {
        for (const payload of decoder.push(chunk)) {
          if (ending) break;
          const control = niControl(payload);
          if (control === "NI_PING") { socket.write(encodeNIFrame(NI_PONG)); continue; }
          if (control === "NI_PONG") continue;
          if (++queued > 8) throw new Error("too many pending DIAG requests");
          const initial = first;
          const message = parseClientMessage(payload, first); first = false;
          queue = queue.then(async () => {
            if (socket.destroyed || ending) return;
            const screen = initial ? await session.start() : await session.step(readDynproInput(message.items));
            if (socket.destroyed || ending) return;
            if (screen.exit || (!initial && (message.header[1] & 0x08))) {
              ending = true; socket.end(sessionEnd); return;
            }
            const response = encodeNIFrame(buildDynproScreen(screen, {sid, initial, counter: counter++}));
            if (!socket.write(response)) {
              socket.pause(); socket.once("drain", () => socket.resume());
            }
          }).catch(fail).finally(() => { queued--; });
        }
      } catch (error) { fail(error); }
    });
    socket.on("end", () => { try { decoder.finish(); } catch (error) { logger("protocol-error", peer, error); } });
    socket.on("error", error => logger("socket-error", peer, error));
    socket.on("close", () => { ending = true; abort.abort(); logger("close", peer); });
  });
  server.maxConnections = maxConnections;
  return server;
}

export async function listenDiag({port, host, env = process.env, ...options} = {}) {
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new RangeError("invalid DIAG port");
  const server = createDiagServer({sid: identity(env).sid, ...options});
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    const done = () => { server.off("error", reject); resolve(); };
    if (host === undefined) listenBound(server, port, env, done);
    else server.listen(port, host, done);
  });
  return server;
}

function instancePort(value) {
  if (!/^\d{2}$/.test(value)) throw new Error(`INSTANCE must be two digits, got ${JSON.stringify(value)}`);
  return 3200 + Number(value);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = process.env.DIAG_PORT ? Number(process.env.DIAG_PORT) : instancePort(process.env.INSTANCE ?? "00");
  const host = process.env.DIAG_HOST;
  const server = await listenDiag({port, host, backend: process.env.STG_ADT_BACKEND, logger: (event, peer, error) => {
    if (error) console.error(`diag ${event} ${peer}:`, error.message);
  }});
  console.log(`OSD JS DIAG transactions listening on ${host ?? describeBind()} port ${server.address().port}`);
}
