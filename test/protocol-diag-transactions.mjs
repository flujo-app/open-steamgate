import assert from "node:assert/strict";
import {connect} from "node:net";
import {WebguiSession, parseWebgui} from "../tools/protocols/diag-webgui.mjs";
import {buildDynproScreen, inputAtom, readDynproInput} from "../tools/protocols/diag-dynpro.mjs";
import {createDiagServer} from "../tools/protocols/diag-server.mjs";
import {parseDiagItems, encodeDiagMessage} from "../tools/protocols/diag.mjs";
import {encodeNIFrame, NIFrameDecoder} from "../tools/protocols/ni.mjs";

const base = "http://localhost:3030";
const note = `<title>Notepad</title><form method="post" action="/sap/bc/gui/sap/its/webgui/tx/?okcode=add">
<input type="hidden" name="session" value="fixture-session"><input name="note">
<input type="checkbox" name="c" value="ONE" checked><input type="checkbox" name="c" value="TWO" checked>
<button>Add</button><button formaction="/sap/bc/gui/sap/its/webgui/tx/?okcode=clear">Clear</button></form>`;
const response = body => new Response(body, {headers: {"content-type": "text/html"}});
const click = (session, screen, caption) => session.step({command: screen.elements.find(e => e.caption === caption).command});

describe("interactive DIAG transactions", () => {
  it("submits hidden state, changed fields, duplicate names and the clicked formaction", async () => {
    const requests = [];
    const session = new WebguiSession({backend: base, fetchImpl: async (url, init) => {
      requests.push({url: String(url), ...init}); return response(note);
    }});
    let screen = await session.start();
    const field = screen.elements.find(e => e.name === "note");
    screen = await session.step({fields: [{row: field.row, col: field.col, value: "a & b"}],
      command: screen.elements.find(e => e.caption === "Add").command});
    assert.equal(requests[1].method, "POST");
    const params = new URLSearchParams(requests[1].body);
    assert.equal(params.get("session"), "fixture-session"); assert.equal(params.get("note"), "a & b");
    assert.deepEqual(params.getAll("c"), ["ONE", "TWO"]);
    await click(session, screen, "Clear"); assert.match(requests[2].url, /okcode=clear$/);
  });
  it("decodes iframe srcdoc and entities without running scripts", () => {
    const page = parseWebgui(`<div class="tree" data-transaction="Example"><iframe srcdoc="&lt;h2&gt;A &amp;amp; B&lt;/h2&gt;&lt;script&gt;bad()&lt;/script&gt;"></iframe></div>`, base);
    assert.deepEqual(page.rows, [{kind: "text", text: "A & B"}]); assert.equal(page.title, "Example");
  });
  it("keeps separate client form state and refuses stale action IDs", async () => {
    let calls = 0;
    const factory = () => new WebguiSession({backend: base, fetchImpl: async () => { calls++; return response(note); }});
    const a = factory(), b = factory(); const first = await a.start(); await b.start();
    const next = await click(a, first, "Add"); const before = calls;
    const stale = await click(a, first, "Add");
    assert.match(stale.status, /older screen/); assert.equal(calls, before);
    assert.notEqual(a.page.forms[0].controls[1], b.page.forms[0].controls[1]);
    assert.equal(next.title, "Notepad");
  });
  it("rejects foreign redirects before sending session cookies and preserves the old screen", async () => {
    let count = 0;
    const session = new WebguiSession({backend: base, fetchImpl: async () => ++count === 1 ? response(note) :
      new Response(null, {status: 302, headers: {location: "https://example.invalid/steal"}})});
    const first = await session.start(); const screen = await click(session, first, "Add");
    assert.equal(count, 2); assert.equal(screen.title, "Notepad"); assert.match(screen.status, /browser/);
  });
  it("uses GET form semantics, retains edited values across pagination, and never reposts on Back", async () => {
    const requests = [];
    const html = `<form><input name="q" value="old">${"<p>Line</p>".repeat(25)}<button>Execute</button></form>`;
    const session = new WebguiSession({backend: base, fetchImpl: async (url, init) => { requests.push({url: String(url), ...init}); return response(html); }});
    let screen = await session.start(); const field = screen.elements.find(e => e.name === "q");
    screen = await session.step({fields: [{row: field.row, col: field.col, value: "new"}], command: "NEXT"});
    await click(session, screen, "Execute");
    assert.match(requests[1].url, /\?q=new$/); assert.equal(requests[1].method, "GET");
    await session.step({key: 3}); assert.equal(requests.length, 2);
  });
  it("does not submit a form for field-change or resize notifications", async () => {
    let calls = 0;
    const session = new WebguiSession({backend: base, fetchImpl: async () => { calls++; return response(note); }});
    const screen = await session.start(), field = screen.elements.find(e => e.name === "note");
    await session.step({fields: [{row: field.row, col: field.col, value: "pending"}]});
    assert.equal(calls, 1);
    await session.step({key: 8}); assert.equal(calls, 2);
  });
  it("encodes editable fields and reads bounded client atoms by position", () => {
    const value = inputAtom({row: 4, col: 33, name: "note", value: "hello"});
    assert.deepEqual(readDynproInput([{type: 0x10, id: 9, sid: 2, value}]).fields, [{row: 4, col: 33, value: "hello"}]);
    // SAP GUI 7.40 returns a 2048-byte edit buffer, unlike the headless client.
    const native = Buffer.alloc(19 + 2048, 0x20);
    value.copy(native, 0, 0, 19); native.writeUInt16BE(native.length);
    native.writeUIntBE(2048, 13, 3); Buffer.from("native input").copy(native, 19);
    assert.equal(readDynproInput([{type: 0x10, id: 9, sid: 2, value: native}]).fields[0].value, "native input");
    const broken = Buffer.from(value); broken.writeUInt16BE(65535);
    assert.throws(() => readDynproInput([{type: 0x10, id: 9, sid: 2, value: broken}]), /length/);
    const screen = {title: "Test", elements: [], status: "Ready"};
    const initial = parseDiagItems(buildDynproScreen(screen, {initial: true}).subarray(8));
    const next = parseDiagItems(buildDynproScreen(screen).subarray(8));
    assert.equal(next.find(i => i.type === 1).value[6], 1); // replace native screen controls
    assert.ok(initial.some(i => i.id === 0x0b)); assert.ok(!next.some(i => i.id === 0x0b));
  });
  it("serializes pipelined actions after the handshake and ends cleanly", async () => {
    const events = []; const screen = {title: "Test", elements: [], status: "Ready"};
    const server = createDiagServer({sessionFactory: () => ({
      async start() { await new Promise(resolve => setTimeout(resolve, 20)); events.push("start"); return screen; },
      async step(input) { events.push(input.command); return input.command === "/I" ? {exit: true} : screen; },
    })});
    await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
    const socket = connect(server.address().port, "127.0.0.1"); const decoder = new NIFrameDecoder(); const frames = [];
    socket.on("data", data => frames.push(...decoder.push(data)));
    try {
      await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
      const dp = Buffer.alloc(200); dp.fill(0xff, 0, 4);
      const hello = Buffer.concat([dp, encodeDiagMessage({comFlag: 0x10}, [{type: 0x0c}])]);
      const command = value => encodeNIFrame(encodeDiagMessage({}, [{type: 0x10, id: 12, sid: 4, value: Buffer.from(value)}]));
      socket.write(Buffer.concat([encodeNIFrame(hello), command("SE16"), command("/I")]));
      await new Promise((resolve, reject) => { socket.once("end", resolve); socket.once("error", reject); });
      assert.deepEqual(events, ["start", "SE16", "/I"]); assert.equal(frames.length, 3); assert.equal(frames[2][1], 0x0a);
    } finally { socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  });
});
