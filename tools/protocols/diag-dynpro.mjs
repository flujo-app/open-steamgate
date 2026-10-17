// SPDX-License-Identifier: MIT
// Atom layouts adapted from open-diag-go, Copyright (c) 2026 Alice Vinogradova (oisee).
// MIT permission and warranty terms are in the repository LICENSE.
// Plain dynpro codec. Wire layouts follow the MIT open-diag-go atom codec.
import {buildDiagTapeScreen, encodeAtomHeader, encodeDiagLabel, encodeDiagMessage, parseDiagItems, DIAG_ITEM} from "./diag.mjs";

// This listener currently negotiates an ASCII subset, not a Unicode code page.
export const displayText = (value, limit = 120) => String(value ?? "").normalize("NFKD")
  .replace(/[\u0300-\u036f]/g, "").replace(/[^\x20-\x7e]/g, "?").slice(0, limit);

export function inputAtom({row, col, name, value = "", width = 60, max = 120, checkbox = false, checked = false}) {
  max = Math.min(max, width);
  let body;
  if (checkbox) {
    const caption = Buffer.from(displayText(name, 80));
    body = Buffer.alloc(11 + caption.length);
    body[0] = 0x40; body[1] = checked ? 0x58 : 0x20;
    body.writeUInt16BE(caption.length, 2); body[10] = caption.length; caption.copy(body, 11);
  } else {
    // SAP GUI uses the text's occupied width to create an empty edit control.
    const text = Buffer.from(displayText(value, max).padEnd(width, " "));
    body = Buffer.alloc(7 + text.length);
    body[0] = 0x40; body[3] = text.length; body[4] = width;
    body.writeUInt16BE(max, 5); text.copy(body, 7);
  }
  return Buffer.concat([
    encodeAtomHeader({type: checkbox ? 0x80 : 0x82, row, col, body}),
    encodeAtomHeader({type: 0x72, row, col, body: Buffer.concat([Buffer.from([0x40]), Buffer.from(displayText(name, 80))])}),
  ]);
}

export function buttonAtom({row, col, caption, command}) {
  const text = Buffer.from(displayText(caption, 90) + "\0");
  const body = Buffer.alloc(7);
  body[0] = 0x40; body[1] = Math.min(94, text.length + 2); body[2] = 1;
  body.writeUInt16BE(19 + text.length, 3); body.writeUInt16BE(19, 5);
  return encodeAtomHeader({type: 0x73, row, col, body: Buffer.concat([body, text, Buffer.from("=" + command + "\0")])});
}

export function readDynproInput(items) {
  const fields = []; let command = ""; let key;
  for (const item of items) {
    if (item.type === DIAG_ITEM.SES && item.value[0] === 0x50) key = item.value[1];
    if (![DIAG_ITEM.APPL, DIAG_ITEM.APPL4].includes(item.type)) continue;
    if (item.id === 0x0c && item.sid === 0x04) command = item.value.toString("latin1").replace(/\0+$/, "").trim();
    if (item.id !== 9 || item.sid !== 2) continue;
    for (let off = 0; off < item.value.length;) {
      const data = item.value.subarray(off);
      if (data.length < 12) throw new Error("truncated dynpro atom");
      const len = data.readUInt16BE(0);
      if (len < 12 || len > data.length) throw new Error("invalid dynpro atom length");
      const type = data[4];
      if ([0x82, 0x83, 0x80].includes(type)) {
        const minimum = type === 0x80 ? 23 : 19;
        if (len < minimum) throw new Error("short dynpro field");
        // Native SAP GUI sends a 24-bit text length (often padded to 2048).
        // Only bytes before the first NUL belong to the field. SAP GUI 7.40
        // can leave unrelated buffer contents after that terminator.
        const length = type === 0x80 ? 0 : data.readUIntBE(13, 3);
        if (19 + length > len && type !== 0x80) throw new Error("dynpro field text overruns atom");
        fields.push({row: data.readUInt16BE(8), col: data.readUInt16BE(10),
          value: type === 0x80 ? data[13] === 0x58 : data.subarray(19, 19 + length).toString("latin1").split("\0", 1)[0].trimEnd()});
      }
      off += len;
    }
  }
  return {fields, command, key};
}

function functionEntry(code, caption, index) {
  const text = Buffer.from(caption + "\0\0\0");
  const head = Buffer.alloc(20);
  head.writeUInt16BE(head.length + text.length, 0);
  head[2] = index + 1; head[6] = 0x02; head[7] = code; head[8] = code;
  return Buffer.concat([head, text]);
}

const appl = (id, sid, value, type = DIAG_ITEM.APPL) => ({type, id, sid, value});

export function buildDynproScreen(screen, {sid = "OSD", initial = false, counter = 0} = {}) {
  const template = buildDiagTapeScreen({sid});
  const count = Buffer.alloc(4); count.writeUInt32BE(counter >>> 0);
  const atoms = [encodeDiagLabel({row: 0, col: 1, text: displayText(screen.title)})];
  for (const el of screen.elements) {
    if (el.kind === "field") atoms.push(inputAtom(el));
    else if (el.kind === "button") atoms.push(buttonAtom(el));
    else atoms.push(encodeDiagLabel({row: el.row, col: el.col, text: displayText(el.text)}));
  }
  const functions = Buffer.concat([[0, "Enter"], [3, "Back"], [8, "Execute"], [12, "Cancel"], [15, "Exit"]].map(([code, caption], index) => functionEntry(code, caption, index)));
  // Preserve protocol ordering: SES selects the dialog layer before its
  // window, PF status, dynpro descriptor, geometry and atoms. The first
  // response additionally installs the session capabilities and PF status.
  const redraw = new Set(["6:35", "4:38", "12:7", "4:26", "4:27", "4:28", "12:10", "12:9", "5:1", "12:6", "10:1", "9:2", "9:11"]);
  const items = parseDiagItems(template.subarray(8)).filter(it =>
    it.type !== DIAG_ITEM.EOM && it.type !== DIAG_ITEM.XML && !(it.id === 4 && it.sid === 0x18) &&
    (initial || it.type === DIAG_ITEM.SES || redraw.has(`${it.id}:${it.sid}`))).map(it => {
    let value = it.value;
    if (it.type === DIAG_ITEM.SES) {
      value = Buffer.alloc(16); value[6] = 1; value[14] = 30; value[15] = 120;
    }
    if (it.id === 5 && it.sid === 1) {
      value = Buffer.from(value); value[10] = 30; value[11] = 120;
    }
    if (it.id === 4 && it.sid === 0x26) value = count;
    if (it.id === 0x0b) value = it.sid < 3 ? Buffer.alloc(0) : functions;
    // VARINFO.0a is a fixed-width native window/icon record. Do not replace
    // it with an arbitrary-length caption (SAP GUI 7.40 Parse_Icon overflows).
    if (it.id === 9 && it.sid === 2) value = Buffer.concat(atoms);
    return {...it, value};
  });
  const status = displayText(screen.status || "Ready", 180);
  items.push(appl(6, 0x0b, Buffer.from(status)));
  items.push(appl(0x0c, 3, Buffer.from("S\0" + "00".padEnd(20) + "\0" + "001\0 \0" + status)));
  items.push({type: DIAG_ITEM.EOM});
  return encodeDiagMessage({msgInfo: 1}, items);
}
