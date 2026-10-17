// SPDX-License-Identifier: MIT
import {CfwBatch, encodeCfwCall, decodeCfwReply} from "./diag-cfw.mjs";
import {displayText} from "./diag-dynpro.mjs";

/** A control belongs to one NI connection. Object handles are learned from its
 * replies; node data is rebuilt from the current backend page, never a tape. */
export class CfwTreeSession {
  handles = new Map(); signature = ""; pending; plan; disabled = false;
  prepare(nodes) {
    if (!nodes || this.disabled) return;
    const signature = JSON.stringify(nodes);
    if (signature === this.signature) return;
    if (this.pending) throw new Error("A CFW tree update is already pending");
    const keys = new Set();
    if (nodes.length > 2000) throw new Error("Native tree node limit exceeded");
    for (const node of nodes) {
      if (!/^[A-Za-z0-9_]{1,64}$/.test(node.key) || keys.has(node.key) || (node.parent && !keys.has(node.parent))) {
        throw new Error("Native tree has an invalid key or parent");
      }
      keys.add(node.key);
    }
    this.plan = this.batches(nodes); this.target = signature;
    return this.next();
  }
  next() {
    const step = this.plan.next();
    this.pending = step.value;
    if (step.done) { this.signature = this.target; this.plan = undefined; return; }
    return encodeCfwCall(this.pending);
  }
  accept(value) {
    if (!this.pending) throw new Error("Unexpected CFW tree reply");
    const reply = decodeCfwReply(value, this.pending);
    for (const [name, handle] of reply.outputs) {
      if (!/^(?:O\d+|\d+)$/.test(handle)) throw new Error("SAP GUI returned an invalid control handle");
      this.handles.set(name, handle);
    }
    this.pending = undefined; return this.next();
  }
  fail() { this.disabled = true; this.pending = this.plan = undefined; }
  *batches(nodes) {
    if (!this.handles.size) {
      const b = new CfwBatch();
      // SAP GUI's built-in automation dispatcher, not a captured OLE handle.
      const root = b.value("O2-");
      const manager = b.call(root, "CreateObject", ["{83658045-6571-3232-7082-797884697868}", 1033], {result: "manager"});
      // Retain the container result: releasing its OLE reference immediately
      // destroys the native window before LinkContainer can bind it.
      b.call(manager, "CreateControl", [101, "SAPGUI.CONTAINERCTRL.1", 1342177280, 10], {result: "container"});
      b.call(manager, "SetProperty", [101, 240, 0]); b.call(manager, "LinkContainer", [101, "OSD_TREE"]);
      b.call(manager, "SetProperty", [101, 290, "1"]); b.call(manager, "SetProperty", [101, 520, "OSD_TREE"]);
      const tree = b.call(manager, "CreateControl", [105, "SAP.TableTreeControl.1", 1409286144, 101], {result: "tree"});
      b.call(manager, "SetProperty", [105, 10, 15]);
      for (const [name, value] of [["HideSelection", 0], ["ABAPRunInGUI", 1], ["SelectMode", 0], ["Events", 32767]]) {
        b.call(tree, name, [value], {flag: "S"});
      }
      b.call(tree, "Nodes", [], {flag: "G", result: "nodes"});
      b.call(manager, "RegisterCachedProp", [105, "ABAPSelNodeKey"]);
      b.call(manager, "RegisterEvent", [105, 15]); b.call(manager, "RegisterOcxEvent", [105, 25]);
      yield b;
    }
    const clear = new CfwBatch();
    clear.call(clear.value(this.handles.get("tree")), "ScreenUpdate", [0], {flag: "S"});
    clear.call(clear.value(this.handles.get("nodes")), "RemoveAll");
    yield clear;
    // Bounded batches also bound GUI latency and stay under the APPL uint16
    // length. This supports large menus without an incompatible LZH encoder.
    for (let i = 0; i < nodes.length; i += 8) {
      const b = new CfwBatch(), collection = b.value(this.handles.get("nodes")), root = b.value("O2-");
      for (const node of nodes.slice(i, i + 8)) {
        const pointer = b.call(collection, "Add", [node.parent || "", node.parent ? 6 : 1,
          node.key, displayText(node.text, 180), -1, -1], {result: true});
        b.call(pointer, "IsFolder", [node.folder ? 1 : 0], {flag: "S"});
        b.call(root, "FreeObject", [{ref: pointer, type: 9}]);
      }
      yield b;
    }
    // Expanding before children exist is ignored by the native tree. Resolve
    // folder handles after all batches have populated their descendants.
    const expanded = nodes.filter(node => node.folder && node.expanded);
    for (let i = 0; i < expanded.length; i += 8) {
      const b = new CfwBatch(), collection = b.value(this.handles.get("nodes")), root = b.value("O2-");
      for (const node of expanded.slice(i, i + 8)) {
        const pointer = b.call(collection, "Item", [node.key], {flag: "G", result: true});
        b.call(pointer, "Expanded", [1], {flag: "S"});
        b.call(root, "FreeObject", [{ref: pointer, type: 9}]);
      }
      yield b;
    }
    const finish = new CfwBatch();
    finish.call(finish.value(this.handles.get("tree")), "ScreenUpdate", [1], {flag: "S"});
    yield finish;
  }
}
