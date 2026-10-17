// SPDX-License-Identifier: MIT
// Render the runtime's server-side HTML forms as plain DIAG dynpros. No browser
// scripts, capture replay, transaction-specific data or second ABAP engine.
import {parse} from "parse5";
import {displayText} from "./diag-dynpro.mjs";
import {editorSource} from "./diag-editor.mjs";

const HOME = "/sap/bc/gui/sap/its/webgui/";
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const has = (node, name) => node.attrs?.some(a => a.name === name);
const children = node => node.childNodes ?? [];
const text = node => node.nodeName === "#text" ? node.value : children(node).map(text).join(" ");
const rawText = node => node.nodeName === "#text" ? node.value : children(node).map(rawText).join("");
const clean = value => value.replace(/\s+/g, " ").trim();
const all = (node, predicate) => [ ...(predicate(node) ? [node] : []), ...children(node).flatMap(n => all(n, predicate)) ];
const byTag = (node, tag) => all(node, n => n.tagName === tag);
const classHas = (node, name) => (attr(node, "class") ?? "").split(/\s+/).includes(name);

export function parseWebgui(html, url) {
  const document = parse(html);
  const pane = all(document, n => classHas(n, "tree"))[0];
  const page = {title: clean(text(byTag(document, "title")[0] ?? {childNodes: []})),
    status: all(document, n => attr(n, "id") === "msg" || ["err", "bad", "ok"].some(c => classHas(n, c)))
      .map(n => clean(text(n))).filter(Boolean).join(" | "),
    rows: [], forms: [], url};
  // Repository pages have a tree plus a selector form. Only the Easy Access
  // shell treats its tree as the entire page body.
  const root = pane && !attr(pane, "data-workbench") ? pane : byTag(document, "body")[0] ?? document;
  // Preserve the backend's own folder/leaf hierarchy alongside the plain
  // dynpro list. URLs remain subject to the same session-origin restrictions.
  function importTree(treePane) {
    const nodes = [];
    const visit = (node, parent = "", depth = 0) => {
      if (depth > 80 || nodes.length > 2000) throw new Error("Menu tree exceeds DIAG limits");
      if (node.tagName === "details") {
        const summary = children(node).find(n => n.tagName === "summary");
        const key = `N${nodes.length}`;
        nodes.push({key, parent, text: clean(text(summary ?? node)), folder: true, expanded: has(node, "open")});
        for (const child of children(node).filter(n => n !== summary)) visit(child, key, depth + 1);
        return;
      }
      if (classHas(node, "leaf")) {
        const caption = all(node, n => classHas(n, "lbl"))[0];
        const technical = all(node, n => classHas(n, "tech"))[0];
        nodes.push({key: `N${nodes.length}`, parent, text: clean(text(caption ?? node)) +
          (technical ? ` (${clean(text(technical))})` : ""), folder: false, href: attr(node, "href")});
        return;
      }
      for (const child of children(node)) visit(child, parent, depth + 1);
    };
    visit(treePane); if (nodes.length) page.tree = nodes;
  }
  if (pane && !attr(pane, "data-transaction")) importTree(pane);
  if (pane && attr(pane, "data-transaction")) page.title = attr(pane, "data-transaction");
  let serial = 0;
  const add = row => {
    if (page.rows.length >= 2000) throw new Error("This page is too large for DIAG; open it in WebGUI.");
    page.rows.push(row);
  };
  const label = value => {
    const content = clean(value);
    for (let i = 0; i < content.length; i += 112) add({kind: "text", text: content.slice(i, i + 112)});
  };
  // Toolbar buttons can precede their form and associate by HTML form=id.
  // Resolve within each document: iframe IDs must not bind to the outer page.
  const formNodes = new WeakMap();
  function formOwners(document) {
    const owners = new Map();
    for (const node of byTag(document, "form")) {
      const form = {method: (attr(node, "method") ?? "get").toUpperCase(), action: attr(node, "action") ?? url,
        controls: [], buttons: [], labels: new Map(byTag(node, "label").map(n => [attr(n, "for"), clean(text(n))]))};
      formNodes.set(node, form);
    }
    for (const node of all(document, n => has(n, "id"))) {
      const id = attr(node, "id");
      if (!owners.has(id)) owners.set(id, formNodes.get(node));
    }
    return owners;
  }
  function useForm(form) {
    if (form && !page.forms.includes(form)) page.forms.push(form);
    return form;
  }
  function walk(node, form, depth = 0, owners = documentOwners) {
    if (depth > 80) throw new Error("HTML nesting limit exceeded");
    const tag = node.tagName;
    if (["head", "style", "script", "svg", "noscript"].includes(tag) || has(node, "hidden") || has(node, "disabled")) return;
    if (tag === "iframe") {
      const source = attr(node, "srcdoc");
      if (source !== undefined) {
        const inner = parse(source);
        const tree = all(inner, n => classHas(n, "tree") && attr(n, "data-workbench"))[0];
        if (tree) importTree(tree);
        walk(byTag(inner, "body")[0], undefined, depth + 1, formOwners(inner));
      }
      else label("This transaction needs a browser control. Open it in WebGUI.");
      return;
    }
    if (tag === "form") {
      form = useForm(formNodes.get(node));
    }
    if (["input", "textarea", "select", "button"].includes(tag) && has(node, "form")) form = useForm(owners.get(attr(node, "form")));
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = tag === "textarea" ? "textarea" : (attr(node, "type") ?? "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) {
        if (type === "submit") submit(node, form, attr(node, "value") || "Submit");
        return;
      }
      if (!form || !attr(node, "name")) return;
      if (tag === "select" || !["hidden", "text", "search", "number", "checkbox", "radio", "textarea"].includes(type)) {
        form.unsupported = true; label("This form contains a control that requires WebGUI."); return;
      }
      const name = attr(node, "name");
      const control = {name, value: type === "textarea" ? rawText(node) : attr(node, "value") ?? (["checkbox", "radio"].includes(type) ? "on" : ""), type,
        checked: has(node, "checked"), readonly: has(node, "readonly"), id: `F${++serial}`,
        max: Math.max(1, Math.min(64, Number(attr(node, "maxlength")) || 64))};
      form.controls.push(control);
      if (type !== "hidden") {
        const caption = form.labels.get(attr(node, "id")) || (["checkbox", "radio"].includes(type) ? `${name}_${control.value}` : name);
        if (type === "textarea") control.baseline = control.value;
        add({kind: type === "textarea" ? "editor" : "field", control, name: caption, form});
      }
      return;
    }
    if (tag === "button") {
      if ((attr(node, "type") ?? "submit") === "submit") submit(node, form,
        attr(node, "aria-label") || clean(text(node)) || attr(node, "title") || "Submit");
      return;
    }
    if (tag === "label" && form && attr(node, "for")) return; // rendered beside its field
    if (tag === "pre") {
      // Keep syntax-colouring spans on the same line. Line-number spans are
      // presentation, not source, and each rendered line gets a clear gutter.
      const content = n => classHas(n, "ln") ? "" : n.nodeName === "#text" ? n.value : children(n).map(content).join("");
      for (const [index, line] of content(node).replace(/\r\n?/g, "\n").split("\n").entries()) {
        const chunks = Math.max(1, Math.ceil(line.length / 104));
        for (let part = 0; part < chunks; part++) add({kind: "text", text:
          (part ? "      " : String(index + 1).padStart(4) + "  ") + line.slice(part * 104, (part + 1) * 104)});
      }
      return;
    }
    if (tag === "a") {
      const href = attr(node, "href");
      if (href) add({kind: "button", caption: clean(text(node)) || attr(node, "title") || "Open", action: {href}});
      return;
    }
    if (tag === "tr" && !byTag(node, "input").length && !byTag(node, "button").length && !byTag(node, "a").length) {
      label(children(node).filter(n => ["th", "td"].includes(n.tagName)).map(n => clean(text(n))).join(" | ")); return;
    }
    if (["h1", "h2", "h3", "p", "li", "label", "summary"].includes(tag) &&
        !all(node, n => ["input", "textarea", "select", "a", "button", "form"].includes(n.tagName)).length) { label(text(node)); return; }
    if (node.nodeName === "#text") { label(node.value); return; }
    for (const child of children(node)) walk(child, form, depth + 1, owners);
  }
  function submit(node, form, caption) {
    if (!form) return;
    const action = {form, action: attr(node, "formaction"), name: attr(node, "name"), value: attr(node, "value") ?? ""};
    form.buttons.push(action); add({kind: "button", caption, action});
  }
  const documentOwners = formOwners(document);
  walk(root);
  for (const form of page.forms) {
    for (const control of form.controls.filter(c => c.type === 'radio')) {
      control.radioPeers = form.controls.filter(c => c.type === 'radio' && c.name === control.name);
    }
  }
  // A native editor occupies the source pane. Mixed/multiple textarea forms
  // need a richer layout; never submit their unseen fields accidentally.
  const editors = page.rows.filter(r => r.kind === "editor");
  if (editors.length === 1 && !editors[0].form.unsupported &&
      editors[0].form.controls.every(c => c === editors[0].control || c.type === "hidden")) page.editor = editors[0];
  else for (const row of editors) row.form.unsupported = true;
  return page;
}

export class WebguiSession {
  constructor({backend, fetchImpl = fetch, signal, timeoutMs = 15000, editorTimeoutMs = 300000} = {}) {
    this.backend = new URL(backend); this.fetch = fetchImpl; this.signal = signal; this.timeoutMs = timeoutMs;
    this.editorTimeoutMs = editorTimeoutMs;
    this.page = undefined; this.offset = 0; this.history = []; this.cookies = new Map(); this.revision = 0;
    this.actions = new Map(); this.fields = new Map(); this.command = "";
    this.nativeTree = false; this.pageSerial = 0;
    this.nativeEditor = false; this.editorMessages = false; this.pendingNavigation = undefined;
  }
  url(value, base = this.page?.url ?? this.backend) {
    const url = new URL(value, base);
    if (url.origin !== this.backend.origin || url.username || url.password ||
      !/^\/sap\/bc\/(?:gui\/sap\/its\/webgui(?:\/|$)|osd\/)/.test(url.pathname)) {
      throw new Error("This destination needs WebGUI in a browser.");
    }
    return url;
  }
  async load(value, {method = "GET", body, remember = true, timeoutMs = this.timeoutMs} = {}) {
    let url = this.url(value);
    const signal = AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(this.signal ? [this.signal] : [])]);
    for (let redirects = 0; redirects < 6; redirects++) {
      const headers = {accept: "text/html"};
      if (body) headers["content-type"] = "application/x-www-form-urlencoded";
      if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
      const response = await this.fetch(url, {method, body, headers, redirect: "manual", signal});
      for (const cookie of response.headers.getSetCookie?.() ?? []) {
        const pair = cookie.split(";", 1)[0], at = pair.indexOf("=");
        if (at > 0 && this.cookies.size < 32) this.cookies.set(pair.slice(0, at), pair.slice(at + 1));
      }
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        await response.body?.cancel(); url = this.url(response.headers.get("location"), url);
        if (response.status === 303 || ((response.status === 301 || response.status === 302) && method === "POST")) { method = "GET"; body = undefined; }
        continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error(`Transaction backend returned HTTP ${response.status}.`); }
      if (!(response.headers.get("content-type") ?? "").includes("text/html")) {
        await response.body?.cancel(); throw new Error("This transaction is not an HTML form; use WebGUI.");
      }
      const buffers = []; let length = 0;
      for await (const chunk of response.body) {
        length += chunk.length;
        if (length > 1024 * 1024) throw new Error("Transaction page exceeds the DIAG size limit.");
        buffers.push(chunk);
      }
      const next = parseWebgui(Buffer.concat(buffers).toString("utf8"), url.href);
      next.serial = ++this.pageSerial;
      if (remember && this.page) { this.history.push({page: this.page, offset: this.offset}); if (this.history.length > 16) this.history.shift(); }
      this.page = next; this.offset = 0; this.command = ""; return;
    }
    throw new Error("Too many transaction redirects.");
  }
  async start() {
    try { await this.load(HOME); return this.render(); }
    catch { return this.render("Transaction backend unavailable. Choose Home to retry."); }
  }
  async step({fields = [], command = "", key, treeEvent, textEdit} = {}) {
    try {
      const editor = this.page?.editor?.control;
      if (textEdit) {
        if (!editor || textEdit.id !== `P${this.page.serial}_${editor.id}`) throw new Error("The edited source belongs to an older screen.");
        if (!editor.readonly) editor.value = editorSource(textEdit.value);
        editor.verified = true;
      }
      for (const field of fields) {
        const target = this.fields.get(`${field.row}:${field.col}`);
        if (!target) continue;
        if (target.command) this.command = String(field.value).slice(0, 40);
        else if (!target.readonly) {
          if (target.type === 'radio') {
            if (field.value === true || field.value === 'X') {
              for (const peer of target.radioPeers) peer.checked = peer === target;
            }
          } else if (target.type === "checkbox") target.checked = field.value === true || field.value === "X";
          else {
            if (/[^\x20-\x7e]/.test(String(field.value))) throw new Error("DIAG input currently supports ASCII characters only.");
            target.value = String(field.value).slice(0, target.max);
          }
        }
      }
      command = command.replace(/^=/, "");
      if (!command && this.command) command = this.command;
      if (command === "KEEP_EDITING") { this.pendingNavigation = undefined; this.command = ""; return this.render(); }
      let navigationAction;
      if (command === "DISCARD_EDITS") {
        if (!this.pendingNavigation) throw new Error("There is no pending navigation.");
        navigationAction = this.pendingNavigation.action;
        ({command, key, treeEvent} = this.pendingNavigation); this.pendingNavigation = undefined;
        editor.value = editor.baseline;
      } else if (this.pendingNavigation) {
        return this.render("Source has unsaved changes. Keep editing or discard changes to continue.");
      } else if (editor && editor.value !== editor.baseline) {
        const action = this.actions.get(command);
        const staying = ["EDITOR_VIEW", "EDITOR_MESSAGES", "NEXT", "PREV"].includes(command) ||
          action?.form === this.page.editor.form || (!command && ![3, 12].includes(key));
        if (!staying) {
          // Retain the action itself: rendering a confirmation changes IDs.
          this.pendingNavigation = {command, key, treeEvent, action}; this.command = "";
          return this.render("Source has unsaved changes. Keep editing or discard changes to continue.");
        }
      }
      const upper = command.toUpperCase();
      if (["/I", "/NEX", "/NEND", "/N/EX"].includes(upper) || key === 15) return {exit: true};
      if (upper.startsWith("/O")) throw new Error("Open another client connection for a separate session.");
      if (navigationAction) await this.perform(navigationAction);
      else if (treeEvent && this.nativeTree && this.page?.tree) {
        const node = this.page.tree.find(n => `P${this.page.serial}_${n.key}` === treeEvent.key);
        if (!node) throw new Error("The selected tree node belongs to an older screen.");
        if (node.href) await this.load(node.href);
        else if (!node.folder) throw new Error("This menu entry has no transaction to open.");
      } else if (command === "EDITOR_VIEW") { this.nativeEditor = true; this.editorMessages = false; }
      else if (command === "EDITOR_MESSAGES") this.editorMessages = true;
      else if (command === "TREE_VIEW") this.nativeTree = true;
      else if (command === "LIST_VIEW") this.nativeTree = false;
      else if (upper === "/N" || command === "HOME") { this.history = []; await this.load(HOME, {remember: false}); }
      else if (command === "BACK" || key === 3 || key === 12) {
        const previous = this.history.pop();
        if (previous) { this.page = previous.page; this.offset = previous.offset; }
        else await this.load(HOME, {remember: false});
      } else if (command === "NEXT" && this.page) this.offset = Math.min(this.offset + 21, Math.max(0, this.page.rows.length - 1));
      else if (command === "PREV") this.offset = Math.max(0, this.offset - 21);
      else if (this.actions.has(command)) await this.perform(this.actions.get(command));
      else if (command.startsWith("A" + this.revision + "_")) throw new Error("The action is no longer available.");
      else if (command && !/^A\d+_E?\d+$/.test(command)) {
        const tcode = upper.replace(/^\/N/, "");
        if (!/^[A-Z0-9_/$-]{1,40}$/.test(tcode)) throw new Error("Enter a transaction code, for example SE16.");
        this.history = []; await this.load(`${HOME}?okcode=${encodeURIComponent(tcode)}`, {remember: false});
      } else if (!command && (key === 0 || key === 8)) {
        const form = this.page?.forms.find(f => f.buttons.length);
        if (form) await this.perform(form.buttons[0]);
      } else if (command) throw new Error("The action belongs to an older screen. Try again.");
      return this.render();
    } catch (error) { return this.render(error.name === "TimeoutError" ? "Transaction timed out; the result may be unknown. Check before repeating." : error.message); }
  }
  async perform(action) {
    if (action.href) { await this.load(action.href); return; }
    const form = action.form;
    if (form.unsupported || !["GET", "POST"].includes(form.method)) throw new Error("Use WebGUI for this form.");
    const source = form.controls.find(c => c.type === "textarea");
    if (source && !source.verified) throw new Error("Open the native editor before submitting source, or use WebGUI.");
    const params = new URLSearchParams();
    for (const control of form.controls) {
      if (["checkbox", "radio"].includes(control.type) && !control.checked) continue;
      params.append(control.name, control.value);
    }
    if (action.name) params.append(action.name, action.value);
    const url = this.url(action.action ?? form.action);
    // Activation can rebuild the generation. Its bounded deadline must cover
    // that work, rather than inheriting the ordinary navigation timeout.
    const options = {remember: !source, timeoutMs: source ? this.editorTimeoutMs : this.timeoutMs};
    if (form.method === "GET") { url.search = params.toString(); await this.load(url, options); }
    else await this.load(url, {...options, method: "POST", body: params.toString()});
    // Check does not save. Only an explicit success from the source-editor
    // endpoint establishes a new saved baseline; failures remain dirty.
    const current = this.page.editor?.control;
    if (source && current) {
      const saved = /^\/sap\/bc\/osd\/edit\/?$/.test(url.pathname) && action.name === "do" &&
        ["save", "activate"].includes(action.value) && /^(?:Saved\.|activated,)/i.test(this.page.status);
      current.baseline = saved ? current.value : source.baseline;
    }
  }
  render(error) {
    this.revision++; this.actions.clear(); this.fields.clear();
    const elements = [
      {kind: "text", row: 1, col: 1, text: "Transaction"},
      {kind: "field", row: 1, col: 14, name: "OSD_OKCODE", value: this.command, width: 40, max: 40},
      {kind: "button", row: 2, col: 1, caption: "Back", command: "BACK"},
      {kind: "button", row: 2, col: 16, caption: "Home", command: "HOME"},
    ];
    this.fields.set("1:14", {command: true});
    const page = this.page ?? {title: "Steamgate", rows: [], status: ""};
    const source = page.editor?.control;
    const editor = source && this.nativeEditor && !this.editorMessages ?
      {id: `P${page.serial}_${source.id}`, value: source.value, readonly: source.readonly} : undefined;
    if (source) elements.push({kind: "button", row: 2, col: 32, caption: editor ? "Messages" : "Native editor",
      command: editor ? "EDITOR_MESSAGES" : "EDITOR_VIEW"});
    if (editor) {
      let col = 52;
      for (const [index, item] of page.rows.filter(r => r.kind === "button" && r.action.form === page.editor.form).entries()) {
        const command = `A${this.revision}_E${index}`; this.actions.set(command, item.action);
        elements.push({kind: "button", row: 2, col, caption: item.caption, command}); col += 19;
      }
      elements.push({kind: "text", row: 26, col: 1, text: source.value !== source.baseline ? "Unsaved changes" : "Source loaded"});
    }
    if (this.pendingNavigation) {
      elements.push({kind: "button", row: 27, col: 1, caption: "Keep editing", command: "KEEP_EDITING"},
        {kind: "button", row: 27, col: 25, caption: "Discard changes", command: "DISCARD_EDITS"});
    }
    if (page.tree) elements.push({kind: "button", row: 2, col: 32, caption: this.nativeTree ? "List view" : "Tree view",
      command: this.nativeTree ? "LIST_VIEW" : "TREE_VIEW"});
    const tree = this.nativeTree && page.tree ? page.tree.map(n => ({...n, key: `P${page.serial}_${n.key}`,
      parent: n.parent ? `P${page.serial}_${n.parent}` : ""})) : undefined;
    for (const [index, item] of (tree || editor ? [] : page.rows.slice(this.offset, this.offset + 21)).entries()) {
      const row = index + 4;
      if (item.kind === "field") {
        const control = item.control;
        if (control.readonly) { elements.push({kind: "text", row, col: 1, text: `${item.name}: ${control.value}`}); continue; }
        elements.push({kind: "text", row, col: 1, text: displayText(item.name, 30)});
        elements.push({kind: "field", row, col: 33, name: item.name, value: control.value, width: 64,
          max: control.max, checkbox: ["checkbox", "radio"].includes(control.type), checked: control.checked});
        this.fields.set(`${row}:33`, control);
      } else if (item.kind === "button") {
        const command = `A${this.revision}_${index}`; this.actions.set(command, item.action);
        elements.push({kind: "button", row, col: 1, caption: item.caption, command});
      } else elements.push({kind: "text", row, col: 1, text: item.kind === "editor" ? "Source: choose Native editor, or open this form in WebGUI." : item.text});
    }
    if (!tree && !editor && this.offset) elements.push({kind: "button", row: 26, col: 1, caption: "Previous page", command: "PREV"});
    if (!tree && !editor && this.offset + 21 < page.rows.length) elements.push({kind: "button", row: 26, col: 24, caption: "Next page", command: "NEXT"});
    elements.push({kind: "text", row: 28, col: 1, text: tree ? "Double-click a menu entry to open it." :
      editor ? "Check validates source. Save writes it. Activate rebuilds the runtime. Messages shows the full result." :
      `Page ${Math.floor(this.offset / 21) + 1}/${Math.max(1, Math.ceil(page.rows.length / 21))} - Enter a transaction or choose an action.`});
    return {title: page.title || "Steamgate", elements, tree, editor, status: error || page.status || "Ready"};
  }
}
