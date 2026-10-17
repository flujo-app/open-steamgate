import {expect} from "chai";
import {startServer} from "./start.mjs";
import {parseWebgui, WebguiSession} from "../tools/protocols/diag-webgui.mjs";
import {batchRegistrySource} from "../tools/osd-gui-convert.mjs";
import {createRequire} from "node:module";

const origin = `http://localhost:${process.env.STG_PORT ?? 3030}`;
const endpoint = `${origin}/sap/bc/osd/workbench/`;
const post = fields => fetch(endpoint, {method: "POST", redirect: "manual",
  headers: {"content-type": "application/x-www-form-urlencoded"}, body: new URLSearchParams(fields).toString()});

describe("repository workbench", function () {
  this.timeout(180000);
  let server;
  before(() => { server = startServer(true); });
  after(() => server?.close());

  it("publishes only strict converted programs as dialog execution targets", () => {
    const source = batchRegistrySource([
      {programName: "ZSTRICT", className: "ZCL_STRICT", tcode: "ZGUI_STRICT", mode: "strict", wired: true},
      {programName: "ZPARTIAL", className: "ZCL_PARTIAL", tcode: "ZGUI_PARTIAL", mode: "partial/skeleton", wired: true},
      {programName: "ZREFUSED", skipped: "unsupported construct"},
    ]);
    const {Registry, Config, MemoryFile} = createRequire(import.meta.url)("@abaplint/core");
    const registry = new Registry(Config.getDefault());
    registry.addFile(new MemoryFile("zcl_osd_batch_report.clas.abap", source)); registry.parse();
    expect(registry.findIssues().filter(i => ["structure", "parser_error"].includes(i.getKey()))).to.have.length(0);
    const dialog = source.split("METHOD dialog_program.")[1].split("ENDMETHOD.")[0];
    expect(dialog).to.include("rs_program-tcode = `ZGUI_STRICT`");
    expect(dialog).not.to.include("ZGUI_PARTIAL");
    expect(dialog).to.include("Only a partial conversion");
    expect(dialog).to.include("unsupported construct");
    expect(dialog).to.include("Activate it first");
  });

  it("enters SE38 and SE80 through registered transaction classes", async () => {
    for (const tcode of ["SE38", "SE80"]) {
      const url = `${origin}/sap/bc/gui/sap/its/webgui/?okcode=${tcode}`;
      const html = await (await fetch(url)).text();
      const page = parseWebgui(html, url);
      expect(page.forms.some(f => f.action === "/sap/bc/osd/workbench/")).to.equal(true);
      expect(page.rows.some(r => r.caption === "Display")).to.equal(true);
      expect(page.rows.some(r => r.caption === "Execute")).to.equal(true);
      expect(html).not.to.contain(`Transaction ${tcode} does not exist`);
    }
  });
  it("browses real packages and links their objects to the shared editor", async () => {
    const url = `${endpoint}?mode=SE80&package=$ZOSD_TEST_SRC`;
    const page = parseWebgui(await (await fetch(url)).text(), url);
    expect(page.tree.some(n => n.text.includes("ZOSD_TEST_DEMO_PROG"))).to.equal(true);
    const leaf = page.tree.find(n => n.href?.includes("name=ZOSD_TEST_DEMO_PROG"));
    const response = await fetch(new URL(leaf.href, url));
    expect(await response.text()).to.contain("zosd_test_demo_prog");
  });
  it("uses POST fields for Display and Change without losing the selected program", async () => {
    for (const action of ["display", "change"]) {
      const response = await post({mode: "SE38", name: "zosd_test_demo_prog", do: action});
      expect(response.status).to.equal(303);
      const target = new URL(response.headers.get("location"), endpoint);
      expect(target.pathname).to.equal("/sap/bc/osd/edit/");
      expect(target.searchParams.get("name")).to.equal("ZOSD_TEST_DEMO_PROG");
      expect(target.searchParams.has("change")).to.equal(action === "change");
    }
  });
  it("starts the active converted program through its generated transaction", async () => {
    const response = await post({mode: "SE38", name: "ZOSD_SUB_CTX", do: "execute"});
    expect(response.status).to.equal(303);
    const target = new URL(response.headers.get("location"), endpoint);
    expect(target.searchParams.get("okcode")).to.equal("ZGUI_OSD_SUB_CTX");
    const session = new WebguiSession({backend: origin});
    await session.load(target);
    let screen = session.render();
    const field = screen.elements.find(e => e.name === "P_VALUE");
    expect(field, "the report's selection parameter").not.to.equal(undefined);
    screen = await session.step({fields: [{row: field.row, col: field.col, value: "WBPROBE"}]});
    for (let page = 0; page < 10 && !screen.elements.some(e => /Execute/.test(e.caption)); page++) {
      if (!screen.elements.some(e => e.command === "NEXT")) break;
      screen = await session.step({command: "NEXT"});
    }
    const execute = screen.elements.find(e => /Execute/.test(e.caption));
    expect(execute, "report actions: " + JSON.stringify(session.page.rows.filter(r => r.kind === "button").map(r => r.caption)))
      .not.to.equal(undefined);
    screen = await session.step({command: execute.command});
    const output = screen.elements.map(e => e.text ?? "").join(" ");
    expect(output).to.contain("DIALOG");
    expect(output).to.contain("WBPROBE");
  });
  it("refuses unknown programs and does not accept create or execute from a GET", async () => {
    const missing = await post({mode: "SE38", name: "Z_NO_SUCH_WORKBENCH_REPORT", do: "execute"});
    expect(missing.status).to.equal(200);
    expect(await missing.text()).to.contain("does not exist");
    for (const action of ["create", "execute"]) {
      const response = await fetch(`${endpoint}?mode=SE38&name=Z_NO_SUCH_WORKBENCH_REPORT&do=${action}`);
      expect(response.status).to.equal(200);
      expect(await response.text()).to.contain("Use the form button");
    }
  });
});
