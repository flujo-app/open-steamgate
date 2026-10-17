import assert from "node:assert/strict";
import {CfwBatch, encodeCfwCall, decodeCfwReply, cfwContainerItems, readCfwTreeEvent} from "../tools/protocols/diag-cfw.mjs";
import {CfwTreeSession} from "../tools/protocols/diag-tree.mjs";
import {editorSource, sourceFromEditor} from "../tools/protocols/diag-editor.mjs";
import {decodeRfcFieldChain, encodeRfcFieldChain} from "../tools/protocols/rfc.mjs";
import {WebguiSession} from "../tools/protocols/diag-webgui.mjs";

const header = Buffer.from("010100080101010104010100", "hex");
const field = (tag, value = "") => ({tag, value: Buffer.isBuffer(value) ? value : Buffer.from(value)});
function reply(batch, handles) {
  const fields = [];
  if (batch.outputs.size) {
    const meta = Buffer.alloc(8); meta.writeUInt32BE(337); meta.writeUInt32BE(batch.values.length, 4);
    fields.push(field(0x301, "VARS"), field(0x302, meta));
    for (let i = 1; i <= batch.values.length; i++) {
      const entry = [...batch.outputs].find(([, pointer]) => pointer === i);
      const row = entry ? "_RESULT".padEnd(32) + ("000000000" + handles[entry[0]]).padEnd(305) : "".padEnd(337);
      fields.push(field(0x304, row));
    }
    fields.push(field(0x306));
  }
  fields.push(field(0xffff));
  return Buffer.concat([header, encodeRfcFieldChain(0x101, fields)]);
}

describe("DIAG native Control Framework", () => {
  it("preserves source line endings, empty final lines, tabs and trailing spaces", () => {
    const source = "  REPORT zexample.\n" + " ".repeat(600) + "\nWRITE '< & >'.\t   \n";
    const native = source.replace(/\n/g, "\r") + "\r";
    assert.equal(sourceFromEditor(native, 4), source);
    assert.equal(sourceFromEditor("\r", 1), "");
    assert.equal(sourceFromEditor("   \r", 1), "   ");
    assert.equal(editorSource(source.replace(/\n/g, "\r\n")), source);
    assert.throws(() => sourceFromEditor(native, 3), /incomplete/);
    assert.throws(() => sourceFromEditor("text", 1), /incomplete/);
    assert.throws(() => sourceFromEditor("text\r\n", 1), /incomplete/);
    assert.throws(() => editorSource("\u00e9"), /ASCII/);
    assert.throws(() => editorSource("x".repeat(128 * 1024 + 1)), /128 KiB/);
  });
  it("uses exact fixed columns and keeps O-prefixed captions distinct from object handles", () => {
    const b = new CfwBatch(), root = b.value("O2-");
    b.call(root, "CreateObject", ["OSD_TREE", 1033], {result: "manager"});
    assert.equal(b.params[0].length, 44);
    assert.equal(b.params[0].subarray(8, 40).toString().trim(), "#1");
    assert.equal(b.params[0].subarray(40, 43).toString().trim(), "2");
    assert.equal(b.values[1].subarray(32).toString().trimEnd(), "000000000 OSD_TREE");
    const fields = decodeRfcFieldChain(encodeCfwCall(b).subarray(12), 0x101).fields;
    assert.ok(fields.some(f => f.tag === 0x304));
    assert.ok(!fields.some(f => f.tag === 0x305));
    assert.throws(() => b.value("x".repeat(296)), /record/);
  });
  it("binds subsequent updates to this frontend's returned handles, with bounded batches", () => {
    const tree = new CfwTreeSession();
    const nodes = Array.from({length: 79}, (_, i) => ({key: `N${i}`, parent: i ? "N0" : "", text: `Node ${i}`, folder: !i}));
    let value = tree.prepare(nodes), calls = 0;
    assert.ok(value);
    const learned = {manager: " 9", container: "O730", tree: "O731", nodes: "O732"};
    while (value) {
      assert.ok(value.length < 60000);
      value = tree.accept(reply(tree.pending, learned)); calls++;
      if (calls === 1) {
        assert.ok(tree.pending.values.some(v => v.toString().includes("000000000O732")));
        assert.ok(!tree.pending.values.some(v => v.toString().includes("000000000O4 ")));
      }
    }
    assert.equal(calls, 13); assert.equal(tree.prepare(nodes), undefined);
    assert.throws(() => tree.accept(Buffer.alloc(12)), /Unexpected/);
    const second = new CfwTreeSession(); second.prepare(nodes);
    assert.equal(second.handles.size, 0);
  });
  it("rejects missing results, oversized tables, malformed trees and server-side exceptions", () => {
    const b = new CfwBatch(); b.call(b.value("O2-"), "CreateObject", [], {result: "manager"});
    assert.throws(() => decodeCfwReply(reply(new CfwBatch(), {}), b), /missing/);
    const meta = Buffer.alloc(8); meta.writeUInt32BE(337); meta.writeUInt32BE(0xffffffff, 4);
    const oversized = Buffer.concat([header, encodeRfcFieldChain(0x101, [field(0x301, "VARS"), field(0x302, meta), field(0xffff)])]);
    assert.throws(() => decodeCfwReply(oversized, b), /limit/);
    const error = Buffer.concat([header, encodeRfcFieldChain(0x101, [field(0x401, "exception"), field(0xffff)])]);
    assert.throws(() => decodeCfwReply(error, b), /rejected/);
    assert.throws(() => new CfwTreeSession().prepare([{key: "N1", parent: "unknown"}]), /parent/);
  });
  it("does not interpret compact rows from unused parameter tables as returned handles", () => {
    const meta = Buffer.alloc(8); meta.writeUInt32BE(44); meta.writeUInt32BE(1, 4);
    const value = Buffer.concat([header, encodeRfcFieldChain(0x101, [field(0x301, "PARAMS"),
      field(0x302, meta), field(0x304, Buffer.from([0])), field(0xffff)])]);
    assert.equal(decodeCfwReply(value, new CfwBatch()).outputs.size, 0);
  });
  it("resolves long string results without trimming whitespace or normalizing CRLF", () => {
    const b = new CfwBatch(); const pointer = b.call(b.value("O3"), "TextStream", [], {flag: "G", result: "source"});
    const value = reply(b, {source: " 1"});
    const fields = decodeRfcFieldChain(value.subarray(12), 0x101).fields;
    const record = fields.filter(f => f.tag === 0x304)[pointer - 1];
    Buffer.from("_SRESULT".padEnd(32)).copy(record.value);
    const xml = "<SVARS><item><VALUE>  REPORT zsource.\r\nWRITE &#39;&#60;&#38;&#62;&#39;.  \r\n</VALUE></item></SVARS>";
    const encoded = Buffer.concat([header, encodeRfcFieldChain(0x101, [field(0x3c02), field(0x3c05, xml), field(0x3c02), ...fields])]);
    assert.equal(decodeCfwReply(encoded, b).outputs.get("source"), "  REPORT zsource.\r\nWRITE '<&>'.  \r\n");
    assert.throws(() => decodeCfwReply(Buffer.concat([header, encodeRfcFieldChain(0x101, fields)]), b), /index/);
  });
  it("decodes only the registered tree event and supplies the native container binding", () => {
    const item = value => ({type: 17, value: Buffer.from(value)});
    const event = `<DATAMANAGER><EVENTS><EVENT SHELLID="105" EVENTID="25"><PARAM PID="0" VALUE="P1_N3"/></EVENT></EVENTS></DATAMANAGER>`;
    assert.deepEqual(readCfwTreeEvent([item(event)]), {key: "P1_N3", shell: 105, event: 25});
    assert.equal(readCfwTreeEvent([item(event.replace('SHELLID="105"', 'SHELLID="106"'))]), undefined);
    assert.equal(readCfwTreeEvent([item(event.replace('EVENTID="25"', 'EVENTID="18"'))]), undefined);
    const binding = cfwContainerItems();
    assert.ok(binding.some(i => i.id === 14 && i.sid === 1));
    assert.equal(binding.find(i => i.id === 10 && i.sid === 10).value.readUInt16BE(7), 21);
  });
  it("uses the backend menu hierarchy and URLs and rejects stale node events", async () => {
    const menu = `<div class="tree"><details open><summary>Reports</summary><div class="kids"><a class="leaf" href="/sap/bc/osd/example"><span class="lbl">Example</span><span class="tech">ZEXAMPLE</span></a></div></details></div>`;
    const requests = [];
    const s = new WebguiSession({backend: "http://localhost:3030", fetchImpl: async url => {
      requests.push(String(url)); return new Response(requests.length === 1 ? menu : "<title>Example</title><p>Report opened</p>", {headers: {"content-type": "text/html"}});
    }});
    await s.start(); let screen = await s.step({command: "TREE_VIEW"});
    assert.equal(screen.tree.length, 2); assert.equal(screen.tree[1].parent, screen.tree[0].key);
    assert.equal(screen.tree[1].text, "Example (ZEXAMPLE)");
    const leaf = screen.tree[1].key;
    screen = await s.step({treeEvent: {key: "P0_N1"}});
    assert.match(screen.status, /older screen/); assert.equal(requests.length, 1);
    screen = await s.step({treeEvent: {key: leaf}});
    assert.equal(screen.title, "Example"); assert.equal(screen.tree, undefined);
    assert.equal(requests[1], "http://localhost:3030/sap/bc/osd/example");
    screen = await s.step({key: 3}); assert.equal(screen.tree[1].key, leaf);
    assert.equal(requests.length, 2);
  });
  it("retains workbench selectors and the nested native repository tree", async () => {
    const body = '<form action="/sap/bc/osd/workbench/"><label for="program">Program</label><input id="program" name="name"><button>Display</button></form>' +
      '<div class="tree" data-workbench="SE80"><details open><summary>Local package</summary><a class="leaf" href="/sap/bc/osd/edit/?type=PROG&amp;name=ZEXAMPLE"><span class="lbl">ZEXAMPLE</span></a></details></div>';
    const escaped = body.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    for (const html of [body, `<div class="tree" data-transaction="SE80"><iframe srcdoc="${escaped}"></iframe></div>`]) {
      const session = new WebguiSession({backend: "http://localhost:3030", fetchImpl: async () =>
        new Response(html, {headers: {"content-type": "text/html"}})});
      const plain = await session.start();
      assert.ok(plain.elements.some(e => e.kind === "field" && e.name === "Program"));
      assert.ok(plain.elements.some(e => e.caption === "Tree view"));
      const native = await session.step({command: "TREE_VIEW"});
      assert.equal(native.tree.length, 2); assert.equal(native.tree[1].text, "ZEXAMPLE");
    }
  });
});
