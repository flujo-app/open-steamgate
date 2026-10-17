// SPDX-License-Identifier: MIT
// Render the runtime's server-side HTML forms as plain DIAG dynpros. No browser
// scripts, capture replay, transaction-specific data or second ABAP engine.
import {parse} from "parse5";
import {displayText} from "./diag-dynpro.mjs";

const HOME = "/sap/bc/gui/sap/its/webgui/";
const attr = (node, name) => node.attrs?.find(a => a.name === name)?.value;
const has = (node, name) => node.attrs?.some(a => a.name === name);
const children = node => node.childNodes ?? [];
const text = node => node.nodeName === "#text" ? node.value : children(node).map(text).join(" ");
const clean = value => value.replace(/\s+/g, " ").trim();
const all = (node, predicate) => [ ...(predicate(node) ? [node] : []), ...children(node).flatMap(n => all(n, predicate)) ];
const byTag = (node, tag) => all(node, n => n.tagName === tag);
const classHas = (node, name) => (attr(node, "class") ?? "").split(/\s+/).includes(name);

export function parseWebgui(html, url) {
  const document = parse(html);
  const pane = all(document, n => classHas(n, "tree"))[0];
  const page = {title: clean(text(byTag(document, "title")[0] ?? {childNodes: []})),
    status: clean(text(all(document, n => attr(n, "id") === "msg")[0] ?? {childNodes: []})),
    rows: [], forms: [], url};
  const root = pane ?? byTag(document, "body")[0] ?? document;
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
  function walk(node, form, depth = 0) {
    if (depth > 80) throw new Error("HTML nesting limit exceeded");
    const tag = node.tagName;
    if (["head", "style", "script", "svg", "noscript"].includes(tag) || has(node, "hidden") || has(node, "disabled")) return;
    if (tag === "iframe") {
      const source = attr(node, "srcdoc");
      if (source !== undefined) walk(byTag(parse(source), "body")[0], undefined, depth + 1);
      else label("This transaction needs a browser control. Open it in WebGUI.");
      return;
    }
    if (tag === "form") {
      form = {method: (attr(node, "method") ?? "get").toUpperCase(), action: attr(node, "action") ?? url,
        controls: [], buttons: []};
      page.forms.push(form);
    }
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (attr(node, "type") ?? "text").toLowerCase();
      if (["submit", "button", "reset", "image"].includes(type)) {
        if (type === "submit") submit(node, form, attr(node, "value") || "Submit");
        return;
      }
      if (!form || !attr(node, "name")) return;
      if (tag === "select" || tag === "textarea" || !["hidden", "text", "search", "number", "checkbox"].includes(type)) {
        form.unsupported = true; label("This form contains a control that requires WebGUI."); return;
      }
      const name = attr(node, "name");
      const control = {name, value: attr(node, "value") ?? (type === "checkbox" ? "on" : ""), type,
        checked: has(node, "checked"), readonly: has(node, "readonly"), id: `F${++serial}`,
        max: Math.max(1, Math.min(64, Number(attr(node, "maxlength")) || 64))};
      form.controls.push(control);
      if (type !== "hidden") {
        const forLabel = all(root, n => n.tagName === "label" && attr(n, "for") === attr(node, "id"))[0];
        const caption = type === "checkbox" ? `${name}_${control.value}` : name;
        if (forLabel) label(text(forLabel));
        add({kind: "field", control, name: caption, form});
      }
      return;
    }
    if (tag === "button") { if ((attr(node, "type") ?? "submit") === "submit") submit(node, form, clean(text(node))); return; }
    if (tag === "a") {
      const href = attr(node, "href");
      if (href) add({kind: "button", caption: clean(text(node)) || attr(node, "title") || "Open", action: {href}});
      return;
    }
    if (tag === "tr" && !byTag(node, "input").length && !byTag(node, "button").length && !byTag(node, "a").length) {
      label(children(node).filter(n => ["th", "td"].includes(n.tagName)).map(n => clean(text(n))).join(" | ")); return;
    }
    if (["h1", "h2", "h3", "p", "li", "label", "summary"].includes(tag) &&
        !all(node, n => ["input", "a", "button", "form"].includes(n.tagName)).length) { label(text(node)); return; }
    if (node.nodeName === "#text") { label(node.value); return; }
    for (const child of children(node)) walk(child, form, depth + 1);
  }
  function submit(node, form, caption) {
    if (!form) return;
    const action = {form, action: attr(node, "formaction"), name: attr(node, "name"), value: attr(node, "value") ?? ""};
    form.buttons.push(action); add({kind: "button", caption, action});
  }
  walk(root);
  return page;
}

export class WebguiSession {
  constructor({backend, fetchImpl = fetch, signal, timeoutMs = 15000} = {}) {
    this.backend = new URL(backend); this.fetch = fetchImpl; this.signal = signal; this.timeoutMs = timeoutMs;
    this.page = undefined; this.offset = 0; this.history = []; this.cookies = new Map(); this.revision = 0;
    this.actions = new Map(); this.fields = new Map(); this.command = "";
  }
  url(value, base = this.page?.url ?? this.backend) {
    const url = new URL(value, base);
    if (url.origin !== this.backend.origin || url.username || url.password ||
      !/^\/sap\/bc\/(?:gui\/sap\/its\/webgui(?:\/|$)|osd\/)/.test(url.pathname)) {
      throw new Error("This destination needs WebGUI in a browser.");
    }
    return url;
  }
  async load(value, {method = "GET", body, remember = true} = {}) {
    let url = this.url(value);
    const signal = AbortSignal.any([AbortSignal.timeout(this.timeoutMs), ...(this.signal ? [this.signal] : [])]);
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
      if (remember && this.page) { this.history.push({page: this.page, offset: this.offset}); if (this.history.length > 16) this.history.shift(); }
      this.page = next; this.offset = 0; this.command = ""; return;
    }
    throw new Error("Too many transaction redirects.");
  }
  async start() {
    try { await this.load(HOME); return this.render(); }
    catch { return this.render("Transaction backend unavailable. Choose Home to retry."); }
  }
  async step({fields = [], command = "", key} = {}) {
    try {
      for (const field of fields) {
        const target = this.fields.get(`${field.row}:${field.col}`);
        if (!target) continue;
        if (target.command) this.command = String(field.value).slice(0, 40);
        else if (!target.readonly) {
          if (target.type === "checkbox") target.checked = field.value === true || field.value === "X";
          else {
            if (/[^\x20-\x7e]/.test(String(field.value))) throw new Error("DIAG input currently supports ASCII characters only.");
            target.value = String(field.value).slice(0, target.max);
          }
        }
      }
      command = command.replace(/^=/, "");
      if (!command && this.command) command = this.command;
      const upper = command.toUpperCase();
      if (["/I", "/NEX", "/NEND", "/N/EX"].includes(upper) || key === 15) return {exit: true};
      if (upper.startsWith("/O")) throw new Error("Open another client connection for a separate session.");
      if (upper === "/N" || command === "HOME") { this.history = []; await this.load(HOME, {remember: false}); }
      else if (command === "BACK" || key === 3 || key === 12) {
        const previous = this.history.pop();
        if (previous) { this.page = previous.page; this.offset = previous.offset; }
        else await this.load(HOME, {remember: false});
      } else if (command === "NEXT" && this.page) this.offset = Math.min(this.offset + 21, Math.max(0, this.page.rows.length - 1));
      else if (command === "PREV") this.offset = Math.max(0, this.offset - 21);
      else if (this.actions.has(command)) await this.perform(this.actions.get(command));
      else if (command.startsWith("A" + this.revision + "_")) throw new Error("The action is no longer available.");
      else if (command && !/^A\d+_\d+$/.test(command)) {
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
    const params = new URLSearchParams();
    for (const control of form.controls) {
      if (control.type === "checkbox" && !control.checked) continue;
      params.append(control.name, control.value);
    }
    if (action.name) params.append(action.name, action.value);
    const url = this.url(action.action ?? form.action);
    if (form.method === "GET") { url.search = params.toString(); await this.load(url); }
    else await this.load(url, {method: "POST", body: params.toString()});
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
    for (const [index, item] of page.rows.slice(this.offset, this.offset + 21).entries()) {
      const row = index + 4;
      if (item.kind === "field") {
        const control = item.control;
        if (control.readonly) { elements.push({kind: "text", row, col: 1, text: `${item.name}: ${control.value}`}); continue; }
        elements.push({kind: "text", row, col: 1, text: displayText(item.name, 30)});
        elements.push({kind: "field", row, col: 33, name: item.name, value: control.value, width: 64,
          max: control.max, checkbox: control.type === "checkbox", checked: control.checked});
        this.fields.set(`${row}:33`, control);
      } else if (item.kind === "button") {
        const command = `A${this.revision}_${index}`; this.actions.set(command, item.action);
        elements.push({kind: "button", row, col: 1, caption: item.caption, command});
      } else elements.push({kind: "text", row, col: 1, text: item.text});
    }
    if (this.offset) elements.push({kind: "button", row: 26, col: 1, caption: "Previous page", command: "PREV"});
    if (this.offset + 21 < page.rows.length) elements.push({kind: "button", row: 26, col: 24, caption: "Next page", command: "NEXT"});
    elements.push({kind: "text", row: 28, col: 1, text: `Page ${Math.floor(this.offset / 21) + 1}/${Math.max(1, Math.ceil(page.rows.length / 21))} - Enter a transaction or choose an action.`});
    return {title: page.title || "Steamgate", elements, status: error || page.status || "Ready"};
  }
}
