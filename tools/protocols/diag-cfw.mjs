// SPDX-License-Identifier: MIT
// SAP GUI Control Framework transport. Records follow the public open-diag-go
// pkg/cfw layout; requests are generated, with handles returned by this client.
import {randomUUID} from "node:crypto";
import {parseFragment} from "parse5";
import {encodeRfcFieldChain, decodeRfcFieldChain} from "./rfc.mjs";
import {decompressSAP} from "./sap-compress.mjs";

const hex = value => Buffer.from(value, "hex");
const ascii = value => Buffer.from(value, "ascii");
const u32 = value => { const b = Buffer.alloc(4); b.writeUInt32BE(value); return b; };
const LIMIT = 1024 * 1024;
// The RFC string table uses a deliberately narrow XML serialization. Decode
// character references without normalizing CR/LF or trimming source spaces.
function stringTable(xml) {
  if (!xml) return [];
  if (xml.length > LIMIT || !xml.startsWith("<SVARS>") || !xml.endsWith("</SVARS>")) throw new Error("Invalid CFW string table");
  const values = []; let rest = xml.slice(7, -8);
  while (rest) {
    const match = /^<item><VALUE>([\s\S]*?)<\/VALUE><\/item>/.exec(rest);
    if (!match || /[<>]/.test(match[1]) || /&(?!#(?:[0-9]+|x[0-9a-fA-F]+);|(?:lt|gt|amp|quot|apos);)/.test(match[1])) {
      throw new Error("Invalid CFW string item");
    }
    values.push(match[1].replace(/&([^;]*);/g, (_, name) => {
      const named = {lt: "<", gt: ">", amp: "&", quot: '"', apos: "'"};
      if (Object.hasOwn(named, name)) return named[name];
      if (!/^#(?:[0-9]+|x[0-9a-fA-F]+)$/.test(name)) throw new Error("Invalid CFW character reference");
      const n = name[1] === "x" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      if (!Number.isSafeInteger(n) || n < 1 || n > 0x10ffff || (n >= 0xd800 && n <= 0xdfff)) throw new Error("Invalid CFW character code");
      return String.fromCodePoint(n);
    }));
    rest = rest.slice(match[0].length);
  }
  return values;
}
function padded(value, width, left = false) {
  const text = String(value);
  if (text.length > width || /[^\x20-\x7e]/.test(text)) throw new Error("CFW value exceeds its ASCII record");
  return left ? text.padStart(width) : text.padEnd(width);
}

export class CfwBatch {
  values = []; params = []; verbs = []; outputs = new Map();
  value(value = "", name = "", {literal = false} = {}) {
    if (this.values.length >= 999) throw new Error("CFW value pool limit exceeded");
    const handle = !literal && /^O\d+-?$/.test(String(value));
    const content = handle ? String(value).slice(1) : value;
    this.values.push(ascii(padded(name, 32) + "000000000" + (handle ? "O" : " ") + padded(content, 255) + "".padEnd(40)));
    return this.values.length;
  }
  text(value) {
    if (typeof value !== "string" || value.length > 255 || /[^\x09\x0a\x0d\x20-\x7e]/.test(value)) {
      throw new Error("CFW text chunk exceeds its ASCII field");
    }
    const pointer = this.value("");
    this.values[pointer - 1] = ascii("".padEnd(32) + "000000000 " + value.padEnd(255) + "".padEnd(40));
    return {ref: pointer, type: 8};
  }
  call(object, name, args = [], {flag = "C", result} = {}) {
    if (!Number.isInteger(object) || object < 1 || object > this.values.length || !["C", "S", "G"].includes(flag)) {
      throw new Error("Invalid CFW object reference or verb");
    }
    const group = this.verbs.length + 1;
    this.verbs.push(ascii(padded(object, 9, true) + " " + padded(name, 42) + flag));
    const param = (type, label, pointer) => {
      this.params.push(ascii(padded(group, 3, true) + " " + padded(type, 3, true) + " " +
        padded(label, 32) + padded(pointer, 3, true) + " "));
    };
    for (const [i, arg] of args.entries()) {
      const value = arg?.value ?? arg;
      const pointer = arg?.ref ?? this.value(value, "", {literal: typeof value === "string"});
      if (!Number.isInteger(pointer) || pointer < 1 || pointer > this.values.length) throw new Error("Invalid CFW argument reference");
      param(arg?.type ?? (typeof value === "number" ? 3 : 12), flag === "S" ? "" : `#${i + 1}`, pointer);
    }
    if (result) {
      const pointer = this.value("", "_RESULT"); param(12, "_RESULT", pointer);
      if (typeof result === "string") this.outputs.set(result, pointer);
      return pointer;
    }
  }
}

/** Inline RFC table rows avoid needing a second SAP compression encoder.
 * Keep each batch below one DIAG APPL's size limit. */
export function encodeCfwCall(batch) {
  const fields = [];
  const push = (tag, value = Buffer.alloc(0)) => fields.push({tag, value: typeof value === "string" ? ascii(value) : value});
  push(0x103, hex("00000e0b")); push(0x106, hex("0401000301030200000023"));
  push(0x161, hex("00")); push(0x15, hex("04010100"));
  push(7, "127.0.0.1"); push(0x20, "SAPGUI"); push(0x21, hex("00")); push(0x18, "localhost"); push(8, "GUI");
  push(0x11, "3"); push(0x13, "916 "); push(0x12, "816 "); push(6, "SAPGUI");
  push(0x130, "SAPLOLEA\0"); push(0x17); push(0x502); push(0x136, randomUUID() + "\0");
  push(0xb, "816"); push(0x102, "OLE_FLUSH_CALL"); push(0xb, "816"); push(0x130, "SAPLOLEA".padEnd(40));
  push(0x337); push(0x503); push(0x420, u32(0)); push(0x512);
  for (const name of ["IMPORT_XML", "SVARS", "EXCEPT_DESCRIPT", "EXPORT_XML", "SVARS"]) push(0x205, name);
  push(0x201, "IMPORT_XML"); push(0x203, hex("00")); push(0x3c02);
  push(0x3c05, "<SVARS>"); push(0x3c05, "</SVARS>"); push(0x3c02);
  const table = (name, width, rows, types) => {
    push(0x213, hex(types)); push(0x301, name); push(0x302, Buffer.concat([u32(width), u32(rows.length)]));
    for (const row of rows) { if (row.length !== width) throw new Error("Invalid CFW row width"); push(0x304, row); }
  };
  table("EXCEPTIONS", 260, [], "02080400ff01");
  table("PARAMS", 44, batch.params, "040004000400200004");
  table("RFC_QUEUE", 1853, [], "0e000800040008000400200008040404ff0104ff0104ff0104ff0104ff0104ff0104ff01");
  table("VARS", 337, batch.values, "06002006060603000100ff010028");
  table("VERBS", 53, batch.verbs, "04000a0020000a0001");
  table("XML_DATA_STREAM", 255, [], "0100ff01"); push(0xffff);
  const value = Buffer.concat([hex("010100080101010104010100"), encodeRfcFieldChain(0x101, fields), hex("ffff")]);
  if (value.length > 60000) throw new Error("CFW batch requires splitting");
  return value;
}

/** Replies can use compressed rows even when the request used inline rows. */
export function decodeCfwReply(value, batch) {
  if (value.length < 12 || value.length > LIMIT || value.readUInt16BE(0) !== 0x101) throw new Error("Invalid CFW reply envelope");
  const start = 4 + value.readUInt16BE(2);
  const {fields} = decodeRfcFieldChain(value.subarray(start), 0x101);
  const tables = new Map(), stringChunks = []; let table, scalar = "", xml = "";
  const finish = () => {
    if (!table) return;
    const length = table.width * table.count;
    if (!Number.isSafeInteger(length) || length > LIMIT) throw new Error("CFW table size limit exceeded");
    // The frontend may return compact/empty rows for unused in/out tables.
    // Only VARS slots requested by this batch are inputs to our state model.
    // PARAMS and XML_DATA_STREAM never supply server-side handles or code.
    if (table.name !== "VARS" || batch.outputs.size === 0) { table = undefined; return; }
    let data = Buffer.concat(table.parts);
    if (table.compressed && length) {
      if (data.length < 16) throw new Error("Short CFW compressed table");
      data = decompressSAP(data.subarray(8), {maxOutputLength: LIMIT});
    }
    if (data.length !== length) throw new Error(`CFW table length mismatch: ${table.width} x ${table.count}, received ${data.length}`);
    tables.set(table.name, {...table, data}); table = undefined;
  };
  for (const field of fields) {
    if (field.tag === 0x3c05) stringChunks.push(field.value);
    if (field.tag === 0x401) throw new Error("SAP GUI rejected a Control Framework call");
    if (field.tag === 0x201) scalar = field.value.toString("ascii");
    if (field.tag === 0x203 && scalar === "EXPORT_XML") xml = field.value.toString("latin1").replace(/\0+$/, "");
    if (field.tag === 0x203 && scalar === "EXCEPT_DESCRIPT" && /[^\0 ]/.test(field.value.toString("latin1"))) {
      throw new Error("SAP GUI reported a Control Framework exception");
    }
    if (field.tag === 0x301) { finish(); table = {name: field.value.toString("ascii"), width: 0, count: 0, parts: []}; }
    if (field.tag === 0x302 && table) {
      if (field.value.length !== 8) throw new Error("Invalid CFW table header");
      table.width = field.value.readUInt32BE(0); table.count = field.value.readUInt32BE(4);
    }
    if ((field.tag === 0x304 || field.tag === 0x305) && table) {
      const compressed = field.tag === 0x305;
      if (table.parts.length && table.compressed !== compressed) throw new Error("Mixed CFW table encodings");
      table.compressed = compressed; table.parts.push(field.value);
    }
    if (field.tag === 0x306) finish();
  }
  finish();
  const outputs = new Map(), vars = tables.get("VARS"),
    strings = stringTable(new TextDecoder("utf-8", {fatal: true}).decode(Buffer.concat(stringChunks)));
  for (const [name, pointer] of batch.outputs) {
    if (vars?.width !== 337 || pointer > vars.count) throw new Error("CFW reply is missing a result");
    const row = vars.data.subarray((pointer - 1) * 337, pointer * 337);
    const marker = row.subarray(0, 32).toString("ascii").trim();
    if (!["_RESULT", "_SRESULT"].includes(marker)) throw new Error("Invalid CFW result slot");
    const result = row.subarray(32, 297).toString("latin1").replace(/ +$/, "");
    if (!result.startsWith("000000000")) throw new Error("Invalid CFW result prefix");
    let content = result.slice(9).replace(/^ /, "");
    if (marker === "_SRESULT") {
      if (!/^[1-9]\d*$/.test(content) || Number(content) > strings.length) throw new Error("CFW string result index is out of range");
      content = strings[Number(content) - 1];
    }
    outputs.set(name, content);
  }
  return {outputs, xml};
}

// parse5 only reads markup; no XML entity loading or script execution. Select
// the narrow tree-event contract and never interpret arbitrary frontend code.
export function readCfwTreeEvent(items, shell = 105) {
  let result;
  for (const item of items.filter(i => i.type === 0x11)) {
    if (item.value.length > 65536) throw new Error("CFW event exceeds limit");
    const root = parseFragment(item.value.toString("latin1"));
    const attr = (node, key) => node.attrs?.find(a => a.name === key)?.value;
    const walk = (node, depth = 0) => {
      if (depth > 30) throw new Error("CFW event nesting exceeds limit");
      if (node.tagName === "event" && attr(node, "shellid") === String(shell) && attr(node, "eventid") === "25") {
        const key = node.childNodes?.find(n => n.tagName === "param" && attr(n, "pid") === "0");
        const value = key && attr(key, "value");
        if (value && /^[A-Za-z0-9_]{1,64}$/.test(value)) result = {key: value, event: 25, shell};
      }
      for (const child of node.childNodes ?? []) walk(child, depth + 1);
    };
    walk(root);
  }
  return result;
}

export function cfwContainerItems({name = "OSD_TREE", row = 4, col = 1, width = 112, height = 21} = {}) {
  padded(name, 30);
  const geometry = Buffer.alloc(9); geometry[0] = 1;
  for (const [i, value] of [row, col, width, height].entries()) geometry.writeUInt16BE(value, i * 2 + 1);
  const properties = Buffer.concat([[1, "1"], [2, name.padEnd(30)], [3, "1"], [4, String(col)],
    [5, String(row)], [6, String(height)], [7, String(width)]].map(([tag, value]) => {
    const b = Buffer.alloc(2); b.writeUInt16BE(tag); return Buffer.concat([b, ascii(value + "\0")]);
  }));
  const app = (id, sid, value) => ({type: 16, id, sid, value});
  return [app(10, 1, Buffer.alloc(9)), app(10, 10, geometry),
    app(10, 6, ascii([name, "ZOSD_DIAG", "0001", ""].join("\0"))), app(14, 1, properties)];
}
