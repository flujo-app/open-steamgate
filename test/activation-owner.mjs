import {expect} from "chai";
import {mkdtempSync,readFileSync,writeFileSync,rmSync,mkdirSync} from "node:fs";
import {execFileSync} from "node:child_process";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {acquireJournalOwner} from "../tools/osd-journal-owner.mjs";

describe("durable activation journal ownership", () => {
  let root;
  const host = {pid: 20, identity: () => "new-start", bootId: "new-boot", probe: () => {}};
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), "osd-owner-")); });
  afterEach(() => rmSync(root,{recursive:true,force:true}));
  const owner = () => readFileSync(join(root,"owner.pid"),"utf8");
  const save = record => writeFileSync(join(root,"owner.pid"),JSON.stringify(record));
  it("records the boot and process identity and permits its own current owner", () => {
    acquireJournalOwner(root,host); const before=owner(); acquireJournalOwner(root,host);
    expect(owner()).to.equal(before);
    expect(JSON.parse(before)).to.deep.equal({pid:20,identity:"new-start",bootId:"new-boot"});
  });
  it("reclaims a prior boot even when its PID now belongs to a protected process", () => {
    save({pid:10,identity:"new-start",bootId:"old-boot"});
    acquireJournalOwner(root,{...host,probe:()=>{throw Object.assign(new Error("protected"),{code:"EPERM"});}});
    expect(JSON.parse(owner()).pid).to.equal(20);
  });
  it("reclaims a reused PID within the same boot", () => {
    save({pid:20,identity:"old-start",bootId:"new-boot"});
    acquireJournalOwner(root,host); expect(JSON.parse(owner()).identity).to.equal("new-start");
  });
  it("preserves a live owner and conservatively refuses unverifiable legacy owners", () => {
    for(const record of [10,{pid:10,identity:"new-start",bootId:"new-boot"}]){
      save(record); const before=owner();
      expect(()=>acquireJournalOwner(root,host)).to.throw("another source host");
      expect(()=>acquireJournalOwner(root,{...host,probe:()=>{throw Object.assign(new Error(),{code:"EPERM"});}})).to.throw("cannot be verified");
      expect(owner()).to.equal(before);
    }
  });
  it("reclaims a confirmed dead legacy owner", () => {
    save(10); acquireJournalOwner(root,{...host,probe:()=>{throw Object.assign(new Error(),{code:"ESRCH"});}});
    expect(JSON.parse(owner()).pid).to.equal(20);
  });
  it("lets a transient compiler store read beside a live source host without taking its journal", () => {
    const directory = join(root, ".local", "activation", "http-3030");
    mkdirSync(directory, {recursive:true});
    acquireJournalOwner(directory);
    writeFileSync(join(directory, "last-outcomes.json"), "{}");
    const before = readFileSync(join(directory, "owner.pid"), "utf8");
    const module = new URL("../tools/osd-activation-journal.mjs", import.meta.url).href;
    const script = `import {forgetMissingObjectOutcomes} from ${JSON.stringify(module)};
      forgetMissingObjectOutcomes({root:process.argv[1], exists(){throw Error("child reconciled the owner's journal");}});`;
    execFileSync(process.execPath, ["--input-type=module", "-e", script, root],
      {env:{...process.env, STG_PORT:"3030"}, stdio:"pipe"});
    expect(readFileSync(join(directory,"owner.pid"),"utf8")).to.equal(before);
  });
});
