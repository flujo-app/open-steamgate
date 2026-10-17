// A durable journal outlives containers. A PID alone does not identify its
// owner after a reboot, or after the operating system reuses that PID.
import {readFileSync, writeFileSync, mkdirSync, unlinkSync, rmdirSync} from "node:fs";
import {join} from "node:path";
import {processIdentity} from "./osd-process-identity.mjs";

const conflict = message => Object.assign(new Error(message), {code: "CONFLICT"});
function bootIdentity() {
  try { return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); }
  catch { return undefined; }
}

export function acquireJournalOwner(directory, {pid = process.pid, identity = processIdentity,
  bootId = bootIdentity(), probe = value => process.kill(value, 0)} = {}) {
  const file = join(directory, "owner.pid");
  const claim = JSON.stringify({pid, identity: identity(pid), bootId});
  try { writeFileSync(file, claim, {flag: "wx"}); return; }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  const previous = readFileSync(file, "utf8");
  let record;
  try { record = JSON.parse(previous); }
  catch { throw conflict("invalid activation journal owner"); }
  // Numeric records from older releases remain conservative: an alive PID
  // with no process identity cannot safely be assumed to be a stale owner.
  if (typeof record === "number") record = {pid: record};
  if (!Number.isInteger(record?.pid) || record.pid <= 0) throw conflict("invalid activation journal owner");
  const observed = identity(record.pid);
  let stale = (record.bootId !== undefined && bootId !== undefined && record.bootId !== bootId)
    || (record.identity !== undefined && observed !== undefined && record.identity !== observed);
  if (!stale) {
    try { probe(record.pid); }
    catch (error) {
      if (error.code === "ESRCH") stale = true;
      else throw conflict("activation journal owner cannot be verified");
    }
  }
  if (!stale) {
    if (record.pid === pid) return;
    throw conflict("activation journal is owned by another source host");
  }
  const takeover = join(directory, "takeover.lock");
  try { mkdirSync(takeover); }
  catch { throw conflict("activation journal ownership takeover is busy"); }
  try {
    if (readFileSync(file, "utf8") !== previous) throw conflict("activation journal owner changed");
    unlinkSync(file);
    writeFileSync(file, claim, {flag: "wx"});
  } finally { rmdirSync(takeover); }
}
