import assert from "node:assert/strict";
import {mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, readdirSync, rmSync, symlinkSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {seedWorkspace} from "../docker/image/workspace.mjs";

describe("persistent image workspace", () => {
  let dir, image, target;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "osd-workspace-"));
    image = join(dir, "image"); target = join(dir, "volume", "system");
    mkdirSync(join(image, "build/by-input/0123456789abcdef/output"), {recursive: true});
    mkdirSync(join(image, "src")); mkdirSync(join(image, "node_modules"));
    writeFileSync(join(image, "src/program.abap"), "REPORT zexample.");
    writeFileSync(join(image, "node_modules/compiler.js"), "compiler");
    writeFileSync(join(image, "release.json"), '{"commit":"seed"}');
    symlinkSync("by-input/0123456789abcdef", join(image, "build/live"));
    symlinkSync("build/live/output", join(image, "output"));
  });
  afterEach(() => rmSync(dir, {recursive: true, force: true}));
  it("keeps edited source, inactive state and compiler across reuse, with relative generation links", () => {
    assert.equal(seedWorkspace(image, target).created, true);
    assert.equal(readlinkSync(join(target, "output")).replaceAll("\\", "/"), "build/live/output");
    assert.equal(readlinkSync(join(target, "build/live")).replaceAll("\\", "/"), "by-input/0123456789abcdef");
    writeFileSync(join(target, "src/program.abap"), "saved edit");
    mkdirSync(join(target, "build/inactive"));
    writeFileSync(join(target, "build/inactive/inactive.json"), "draft state");
    assert.equal(seedWorkspace(image, target).created, false);
    assert.equal(readFileSync(join(target, "src/program.abap"), "utf8"), "saved edit");
    assert.equal(readFileSync(join(target, "build/inactive/inactive.json"), "utf8"), "draft state");
    assert.equal(readFileSync(join(target, "node_modules/compiler.js"), "utf8"), "compiler");
  });
  it("refuses an image or Node-major change without overwriting the workspace", () => {
    seedWorkspace(image, target, {nodeMajor: "24"});
    assert.throws(() => seedWorkspace(image, target, {nodeMajor: "26"}), /another image/);
    writeFileSync(join(image, "release.json"), '{"commit":"new"}');
    assert.throws(() => seedWorkspace(image, target, {nodeMajor: "24"}), /another image/);
    assert.equal(readFileSync(join(target, "release.json"), "utf8"), '{"commit":"seed"}');
  });
  it("refuses unrelated directories and an image nested in the target", () => {
    mkdirSync(target, {recursive: true}); writeFileSync(join(target, "keep"), "user data");
    assert.throws(() => seedWorkspace(image, target), /no valid seed marker/);
    assert.deepEqual(readdirSync(target), ["keep"]);
    assert.throws(() => seedWorkspace(image, dir), /separate from the image/);
    assert.throws(() => seedWorkspace(image, join(image, "nested")), /separate from the image/);
    assert.throws(() => seedWorkspace(image, "relative"), /absolute path/);
  });
});
