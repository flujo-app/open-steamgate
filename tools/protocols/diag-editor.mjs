// SPDX-License-Identifier: MIT
import {CfwBatch, encodeCfwCall, decodeCfwReply} from "./diag-cfw.mjs";

// Leave room in the 1 MiB NI envelope for worst-case XML character references.
const MAX_SOURCE = 128 * 1024;
export function editorSource(value) {
  if (typeof value !== "string" || value.length > MAX_SOURCE || /[^\x09\x0a\x0d\x20-\x7e]/.test(value)) {
    throw new Error("This native editor supports ASCII source up to 128 KiB. Keep this source in the browser editor.");
  }
  return value.replace(/\r\n?/g, "\n");
}

/** Text is returned as CR-terminated lines, including a final terminator for
 * the last (possibly empty) line. Unlike TextStream, that terminator protects
 * the last line's trailing spaces from RFC string padding/trimming. */
export function sourceFromEditor(text, lineCount) {
  const count = Number(lineCount);
  if (!Number.isInteger(count) || count < 1 || count > MAX_SOURCE + 1 || typeof text !== "string" ||
      !text.endsWith("\r") || text.includes("\n") || text.split("\r").length - 1 !== count) {
    throw new Error("The native editor returned an incomplete source; nothing was submitted.");
  }
  return editorSource(text.slice(0, -1));
}

export class CfwEditorSession {
  handles = new Map(); pending; plan; loaded; target; disabled = false;
  prepare(editor) {
    if (!editor || this.disabled) return;
    const source = editorSource(editor.value);
    if (this.pending) throw new Error("The native editor is busy");
    if (this.loaded?.id === editor.id && this.loaded.source === source && this.loaded.readonly === !!editor.readonly) return;
    this.target = {id: editor.id, source, readonly: !!editor.readonly}; this.plan = this.load(source);
    return this.next();
  }
  read() {
    if (!this.loaded || this.disabled || this.pending) throw new Error("The native editor is not ready");
    this.plan = this.readCurrent(); return this.next();
  }
  next() {
    const next = this.plan.next(); this.pending = next.value;
    if (next.done) { this.plan = undefined; return; }
    return encodeCfwCall(this.pending);
  }
  accept(value) {
    if (!this.pending) throw new Error("Unexpected editor control reply");
    const reply = decodeCfwReply(value, this.pending);
    for (const name of ["manager", "container", "editor"]) {
      if (!reply.outputs.has(name)) continue;
      const handle = reply.outputs.get(name);
      if (!/^(?:O\d+|\d+)$/.test(handle)) throw new Error("Invalid editor handle");
      this.handles.set(name, handle);
    }
    if (reply.outputs.has("source")) {
      this.source = sourceFromEditor(reply.outputs.get("source"), reply.outputs.get("lines"));
    }
    this.pending = undefined; return this.next();
  }
  fail() { this.disabled = true; this.pending = this.plan = undefined; }
  cancel() { this.pending = this.plan = undefined; }
  *readCurrent() {
    yield* this.readSource();
    this.loaded = {...this.loaded, source: this.source};
  }
  *readSource() {
    const b = new CfwBatch(), control = b.value(this.handles.get("editor"));
    b.call(control, "LineCount", [], {flag: "G", result: "lines"});
    b.call(control, "Text", [], {flag: "G", result: "source"});
    yield b;
  }
  *load(source) {
    if (!this.handles.size) {
      const b = new CfwBatch();
      const manager = b.call(b.value("O2-"), "CreateObject", ["{83658045-6571-3232-7082-797884697868}", 1033], {result: "manager"});
      b.call(manager, "CreateControl", [201, "SAPGUI.CONTAINERCTRL.1", 1342177280, 10], {result: "container"});
      b.call(manager, "SetProperty", [201, 240, 0]); b.call(manager, "LinkContainer", [201, "OSD_EDIT"]);
      b.call(manager, "SetProperty", [201, 290, "1"]); b.call(manager, "SetProperty", [201, 520, "OSD_EDIT"]);
      const control = b.call(manager, "CreateControl", [205, "SAPGUI.TextEditCtrl.1", 1409286144, 201], {result: "editor"});
      b.call(manager, "SetProperty", [205, 10, 15]);
      for (const [name, value] of [["ReadOnly", 0], ["UseFixedFont", 1], ["ToolBarVisible", 0], ["StatusBarVisible", 1], ["WordWrapMode", 0]]) {
        b.call(control, name, [value], {flag: "S"});
      }
      yield b;
    }
    const clear = new CfwBatch(), control = clear.value(this.handles.get("editor"));
    clear.call(control, "ReadOnly", [0], {flag: "S"});
    clear.call(control, "AutoRedraw", [0]); clear.call(control, "Text", [""], {flag: "S"});
    clear.call(control, "SetSelectionIndexes", [0, 0]); yield clear;
    // A short RFC character field loses trailing spaces. Append a marker,
    // insert the chunk, then remove only that marker through the editor's
    // selection API. Thus even a chunk made entirely of spaces is preserved.
    // Native selection indexes count a CRLF pair as one character.
    const windows = source.replace(/\n/g, "\r\n"); let offset = 0, position = 0;
    while (offset < windows.length) {
      const b = new CfwBatch(), edit = b.value(this.handles.get("editor"));
      for (let chunks = 0; chunks < 6 && offset < windows.length; chunks++) {
        let end = Math.min(windows.length, offset + 200);
        if (windows[end - 1] === "\r" && windows[end] === "\n") end--;
        const text = windows.slice(offset, end); position += text.replace(/\r\n/g, "\r").length;
        b.call(edit, "SelectedText", [b.text(text + "X")], {flag: "S"});
        b.call(edit, "SetSelectionIndexes", [position, position + 1]);
        b.call(edit, "SelectedText", [""], {flag: "S"}); offset = end;
      }
      yield b;
    }
    const finish = new CfwBatch(), edit = finish.value(this.handles.get("editor"));
    finish.call(edit, "SetSelectionIndexes", [0, 0]); finish.call(edit, "EmptyUndoBuffer");
    finish.call(edit, "TextModified", [0], {flag: "S"});
    finish.call(edit, "ReadOnly", [this.target.readonly ? 1 : 0], {flag: "S"});
    finish.call(edit, "AutoRedraw", [1]); yield finish;
    // Verify the complete native buffer before allowing the form to submit.
    yield* this.readSource();
    if (this.source !== source) throw new Error("The editor did not preserve the complete source; nothing was submitted.");
    this.loaded = this.target;
  }
}
