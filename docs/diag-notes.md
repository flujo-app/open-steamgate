# DIAG listener and transaction bridge

## Interactive listener

`tools/protocols/server.mjs` now starts `listenDiag`, which connects each DIAG
socket to the existing runtime's WebGUI transaction handlers. The backend is
`STG_ADT_BACKEND`, or the local `STG_PORT` HTTP listener. Native SAP GUI uses
the instance's `32NN` port; a headless DIAG client uses the same endpoint.
The explicit `createDiagTapeServer` / `listenDiagTape` APIs remain for fixtures.

Enter a transaction such as `SE16` or `ZOSD_NOTE` in the command field (or use
`/nSE16`). Labels, text inputs, checkboxes, links, form submission, and HTML
viewer `srcdoc` content are rendered as plain dynpro controls. The runtime
executes the transaction, including its existing ABAP PBO/PAI and session
storage; the listener does not implement another transaction engine. Hidden
fields, duplicate form names and individual submit-button actions survive
the translation. Use Next/Previous page for longer forms and table results.
Fields retain edits across pages. Back/F3 restores the previous view without
replaying a POST; Home or `/n` returns to the transaction menu. F8/Enter submits
the first form action; `/i` and Exit end the connection.

Each connection has separate form, history, and cookie state. Requests run
serially, with bounded NI payloads, request queues, HTML responses, history,
and backend timeouts. Old button IDs cannot submit a newer screen. Backend
requests follow only same-origin WebGUI/OSD paths and never execute scripts.
The initial shell/PF status is emitted once; subsequent dialog steps replace
the dynpro and increment the roundtrip counter. Idle sessions expire after
15 minutes rather than the fixture's 12-second hold.

This is a **private development listener with a demo identity**, not SAP
authentication or an SAP dispatcher replacement. Keep it on a trusted
interface or authenticated tunnel. It exposes the transactions that the
runtime can already execute. It does not add a general dynpro processor,
arbitrary report execution, general ALV/CFW/browser controls, selection lists,
multi-window `/o`, or Unicode codepage negotiation. Editable text is currently
ASCII, with 64 characters per plain field; display text is transliterated. The
opt-in native source editor described below has a separate 128 KiB limit.
Native edit buffers use a 24-bit text length, including padded buffers larger
than 255 bytes; content is bounded by the declared character capacity and
the first NUL, ignoring unused native buffer bytes. Each
screen replacement resets the native controls. Unsupported destinations or
controls report that WebGUI is required. A timeout after a POST can leave an
unknown outcome, so check state before repeating a mutating action.

Regression coverage is in `test/protocol-diag-transactions.mjs`; the historical
wire research and original tape fixture are documented below.

### Native menu tree (development)

The menu's **Tree view** action creates a native SAP GUI tree from the backend's
existing HTML folder/leaf hierarchy. **List view** keeps the plain dynpro path
available to clients without a Control Framework implementation. A double-click
uses the leaf's existing URL, with the same origin/path restrictions as other
actions. Back restores the previous tree and its frontend selection/expansion.
This path does not add transactions that the backend cannot execute.

`diag-cfw.mjs` encodes fixed-width VARS/PARAMS/VERBS through the existing RFC
field-chain codec. `diag-tree.mjs` owns each connection's returned frontend
handles, creates the container, fills nodes in bounded batches and restores
initial expansion after children exist. Requests use inline table rows; replies
reuse the SAP decompressor already present here. No capture replay or SAP source
is part of this implementation. A failed control setup falls back to List view;
a missing reply times out rather than leaving the connection busy indefinitely.

Native SAP GUI 7.40 has rendered the live backend menu and opened a transaction
by double-click, with Back and List view working. The implementation is still a
development change: release validation/deployment and headless tree support are
pending. The headless client's existing plain dynpro path remains available.
Regression coverage is registered in `test/protocol-diag-cfw.mjs`; no general
editor, ALV or original SE38/SE80 support is implied by this tree transport.

### Native source editor (development)

An editor form with one textarea and hidden metadata offers **Native editor**.
It creates `SAPGUI.TextEditCtrl.1` through the same per-connection CFW transport.
The backend's submit buttons stay available above the editor; **Messages** shows
the complete form and diagnostics, and returning to the editor retains its
buffer and caret. Mixed or multiple textarea forms still require the browser.
Plain clients need not request a native control to browse other transactions.

Before an action leaves the editor, the listener reads its complete native
buffer. Source has its own page identity and never passes through the 64-character
dynpro field limit. A read failure submits nothing and keeps the live editor
visible. Back, Home and transaction navigation prompt before discarding dirty
source. Check preserves the dirty baseline; only an explicit successful Save
or Activate response from the editor endpoint establishes a new saved baseline.
Editor POST results replace the current view rather than adding another copy of
unsaved source to Back history. Closing the frontend ends its session.

Short RFC strings trim trailing spaces. Loading uses bounded ASCII chunks with
a temporary final marker, removed through the control's selection API. The
`Text` getter returns CR-terminated logical lines, including a final terminator;
unlike `TextStream`, this protects trailing spaces on the last line. Long result
slots use `_SRESULT` with a one-based index into `SVARS`. The decoder preserves
whitespace and character references, and a complete readback must equal the
source before the editor is considered loaded. Input is limited to ASCII and
128 KiB so XML escaping still fits the bounded NI reply. Unsupported characters
are rejected rather than transliterated into source.

Native SAP GUI 7.40 has loaded a live 93-line repository program through this
path, retained an edited buffer across Messages/Native editor, and prompted on
Back with unsaved changes. Isolated release acceptance also created a program,
rejected an undefined variable without writing it, checked corrected source and
saved that source through the native control. ADT read back the exact source.
Headless CFW support and final deployment remain pending. Regression cases are in
the existing DIAG transaction and CFW suites. The release preflight now passes
those suites together with the workbench/editor integration checks.

### Workbench entry points (development)

`SE38` now declares the clean-room `ZCL_OSD_WORKBENCH` transaction and `SE80`
declares its Object Navigator entry, `ZCL_OSD_SE80`. Their selector forms post to
`/sap/bc/osd/workbench/`. Display and Change use the existing ABAP editor; Create
uses ADT's typed STORE helper, repository ownership checks and source lock.
Package and object navigation comes from the same store used by ADT. It is
rendered as a native tree when Tree view is selected, including when the initial
transaction document is inside the HTML viewer's `srcdoc`.

Execute requires an existing active program and resolves it through the generated
`ZCL_OSD_BATCH_REPORT=>DIALOG_PROGRAM` mapping. Only strict converter output
produces an executable transaction target. Partial/skeleton conversion, unknown
programs and inactive changes are explicit refusals; no wrapper name is guessed
from user input. The generated report wrapper then owns selection-screen and
list processing through open-abap-gui. Creation and execution require POST.

Full compilation and the release integration suites pass. An isolated Fly
candidate also passed real headless MCP navigation: SE38 Display/Back, Execute
with an entered report parameter, and SE80 package-to-source navigation.
The candidate subsequently published a newly created report and a fresh headless
DIAG client executed it with an entered parameter. Final image persistence and
deployment acceptance remain pending.
They do not import SAP's transaction source or claim the complete original
Workbench, module-pool execution, debugger or every SE80 object operation.
Release coverage is registered in `test/workbench.mjs`, alongside the existing
report, editor and DIAG suites.

The editor emits an extra initial textarea LF because an HTML parser removes
one immediately after the opening tag. This preserves source that begins with
blank lines. Source submissions have a separate bounded five-minute timeout for
Check/Activate; ordinary navigation keeps its shorter timeout. A timed-out
mutation still has an unknown outcome and must be checked before retrying.

Report toolbars can place icon buttons outside the selection form. The DIAG
parser resolves explicit `form` ownership in the same HTML document (including
forward references) and uses accessible labels for icon-only buttons. This is
required for open-abap-gui's Execute button; iframe IDs cannot bind to an outer
document's form.

The editor distinguishes validation from publication. A deferred activation
shows **Activation pending** and offers **Refresh activation status** under
Messages; the existing STORE activation journal supplies the eventual published
or failed result. A store refusal no longer prints a successful activation
verdict below its error. Check and activation retain the object's source path
and writable metadata. Regression coverage includes failed publication and a
ticket belonging to another object.

Persistent source hosts record journal ownership using both the process start
identity and the Linux boot identity. Reused PIDs after a container restart must
not block activation or be mistaken for the journal's original process. Legacy
numeric owners with an alive, unverifiable PID are conservatively refused.

### Upstream reuse audit (2026-10-17)

The implementation keeps the existing substrate. `libs.lock.json` already
pins open-abap-core, the transpiler and open-abap-gui. The latter's current
[converter and framework](https://github.com/open-abap/open-abap-gui) support
classic reports and dynpro processing rendered as HTML; Steamgate's report
wrappers drive that host (see [gui-reports.md](gui-reports.md)). Updating that
library alone does not add a DIAG transport.

[open-diag-go](https://github.com/oisee/open-diag-go), audited at
`62029ee085bca840ba48778dad51c893e98d0ebc`, is MIT-licensed. Its `pkg/diag`
and `pkg/frame` are the source of the atom and PAI layouts used here; its
`pkg/lsd` / `cmd/osd-up` integration still serves a still-screen or animation
stub, without transaction dispatch. [sap-lsd](https://github.com/oisee/sap-lsd)
is a demo application using the same protocol research, not an ABAP backend.
The needed seam is thus runtime HTML forms to DIAG dialog steps. The existing
JavaScript protocol host owns that seam, without adding a second Go service
or duplicating Lars's ABAP execution framework.

### Native workbench and tree follow-up (2026-10-17)

The workbench entries described above implement a clean-room subset of SE38
and SE80, including repository navigation and report editing/execution. The ABAP editor,
`ZCL_OSD_EDIT`, reaches the same `ObjectStore` used by ADT through
`StoreDestination`; it already exposes source reads/writes, syntax checks
and activation. Reuse that backend for any workbench implementation rather
than adding a separate repository or compiler.

Further upstream inspection found:

| Project / inspected revision | Reusable part | Boundary |
| --- | --- | --- |
| [open-abap-gui](https://github.com/open-abap/open-abap-gui/tree/50186bd2041836283447764af3d5c653785439f3) | Report converter, host PBO/PAI, tree models, text editor, containers | Controls render through HTML; no native DIAG server transport. |
| [larshp/gg-gui](https://github.com/larshp/gg-gui/tree/f26234d13175684517205f2de956053bebbfd806) | MIT reference reports, including `ZGG_GUI_COMPOSITE` with navigation tree, toolbar, grid, editor and splitters | Examples and a browser host, not SAP's Workbench implementation. Useful as portable acceptance programs. |
| [open-diag-go](https://github.com/oisee/open-diag-go/tree/62029ee085bca840ba48778dad51c893e98d0ebc) | NI/DIAG codecs; `pkg/cfw` models automation verbs, parameter descriptors, value records and frontend handles | CFW is principally a client decoder/response model. `cmd/server` remains a demo; no general server-side tree/editor execution. |

The GUI pin is the oisee fork at `b65c4431d71c7b23468d08bd955b18785fd2ca6c`.
GitHub's comparison with the inspected upstream head reports divergence:
33 upstream commits and five fork commits. Both simple-tree and base-tree
source blobs differ. An upstream update needs a review of the fork changes
and converter/host compatibility; changing the pin alone is not a DIAG fix.

The native tree requires another transport layer after the plain dynpro:
Control Framework `RFC_TR` requests, per-session frontend handles, data
provider transfers, and tree event routing. An existing authorized reference
trace already contains an Easy Access initialization with 152 automation
verbs. It includes container creation/binding, tree table setup,
`ABAPExpandNodes`, cached selection properties, and native double-click /
expand event registration. This is enough to begin that transport work
without starting another SAP system. Raw captures and identifiers stay
outside tracked files; a trace-shaped reply must not become the server's
execution model.

Original SAP transaction source alone would not supply its dependent
repository, function groups, dynpros, GUI statuses, DDIC and kernel services.
The clean-room boundary in `CLAUDE.md` still applies. A functional workbench
using this runtime and executing SAP's original Workbench are different
deliverables; neither is proven by the current form bridge.

## Historical dispatcher-side survey

The compatibility graph now tells Eclipse this system can drive SAP GUI
([`adt-facade.mjs`](../tools/adt-facade.mjs), `COM.SAP.ADT.SAPGUI`), so running
a report from the editor hands off to SAP GUI, which opens **DIAG** on the
dispatcher port — `32NN` for instance NN, where the ADT bridge answers the
gateway port `33NN`. Two different doors; we have built the first and this is
the survey of the second.

These are protocol facts measured from a passive tap of one SAP GUI session
against a sandbox, and from what SAP GUI sent our own recorder when it tried.
No captures are in this repository; nothing below names a system, a user or a
session. This began as the C.2 measurement of the DIAG side quest (backlog track C);
the stub it sized is now built and measured, below.

---

## The opening, and where SAP GUI stops against us

```
SAP GUI ──▶ dispatcher :32NN
  C→S  NI route request (ffffffff…)   the connect, carrying the intent
  S→C  DIAG frame                      session setup + the first screen
  C→S  DIAG frame                      the user's first action
  …
```

The recorder (`diag-catch`, in open-rfc-go) accepts the connection, writes the
frame down and deliberately never replies, so SAP GUI says as much as it will
before giving up. What it said, on an F8 from Eclipse: an **NI route request**,
317 bytes, of which 221 are byte-identical to the same request against a real
system — same shape, same terminal id. Its payload carries the navigation
intent in clear text, `_NAVIGATION=X;D_WB_ACTION=EXECUTE;D_ECLIPSE_PROJECT=…`,
which is Eclipse telling SAP GUI to run the object and come back.

So the client reaches us and waits for a screen. It never gets one, which is
the whole of why the result is a blank window.

## The frame

A DIAG frame is an **8-byte header** and a body. The body is optionally
SAP-LZH compressed, and the header says which: one of its bytes is a
compression flag, and the setup frames a real system sends are **uncompressed**
(flag zero). That matters more than anything else here — a stub can answer
uncompressed, so it needs no LZH *writer*, which is the one piece this side of
the family only has a *reader* for (`vsp/pkg/sapcompress`, decode-only).

When a frame is compressed it is the same container the RFC metadata tables
use: the `1f 9d` magic, algorithm `0x12`, a length, then a two-bit prefix and
raw DEFLATE. It decodes with the same code and, in Python, with
`zlib.decompressobj(-15)` after the prefix shift.

## The items

The body is a stream of items, each a type byte and then its payload. Two
carry a length and are how everything variable travels:

| type | name | operand |
| --- | --- | --- |
| `0x10` | APPL | id, sid, 16-bit length, value |
| `0x12` | APPL4 | id, sid, 32-bit length, value |
| `0x0c` | end of message | — |

An APPL item is addressed by an **(id, sid)** pair — a category and a subtype.
Measured over the setup and screen frames, the categories a screen is built
from are:

| id | what it carries (by its sids) |
| --- | --- |
| session-parameters | the codepage, the protocol level, the system id, the host, the client, the whole function-key table, the dynpro defaults — the frame that sets a session up |
| menu | the menu bar and menus, one sid per top-level entry, the text inline |
| title | the window title and the transaction/screen title, the text inline |
| session/status | language, user, and the status bar line |
| screen-geometry | the screen's rows and columns |

The first server frame is the biggest: it is the session parameters and the
first dynpro together, which is why a real one runs to thousands of bytes
decompressed. A smaller screen is a title, a geometry, the fields, and the end
marker.

## The stub, as built (C.4, done 2026-09-16)

No field-item layout had to be measured after all. The family already had
the writer: [open-diag-go](https://github.com/oisee/open-diag-go)'s `lsd`
is a self-contained DIAG server — the setup and wrapper frames it splices
its screens into are embedded, scrubbed of every identifier, so it needs no
capture and no external file — and its `pkg/frame` builds a dynpro from
`Text`, `Frame`, `Lines` and the rest. What was added is one flag,
`-stub guru|spectrum`: answer *every* client frame with the same still
screen, push nothing, and end the session cleanly on the window close.

```
lsd -listen :3201 -stub guru        # instance 01: 3201 is DIAG, 3301 the RFC bridge
```

Measured with a stock Eclipse: F8 on `ZOSD_TEST_DEMO_PROG` hands the
embedded SAP GUI to that port, and the guru is what it paints — the box
with "Software Failure. Press left mouse button to continue." and
`Guru Meditation #4F534400.000000F8` (4F5344 spells OSD; F8 is the key).
The GUI sent three frames: the hello (317 bytes, 7 items), one after the
first screen (454 bytes, 22 items), and 51 bytes on close. Each got the
same screen; the last got the session end. A "connection held" is nothing
more than that: DIAG is request and answer, and the socket stays open until
the client says it is leaving.

What the light-show did before the flag existed is worth recording, because
it is the failure mode of every stub that thinks it is a game: it treated the
GUI's second frame as a keypress and froze mid-scene, which is the "junk"
screen a plain SAP GUI showed on a double-click.

## What it took to make it stable, and what each defect taught

The first screen appeared within the hour. Making it survive a second F8
took five more defects, and every one of them was found by measurement —
the tap on the dispatcher port, which records both directions, and once,
decisively, SAP GUI's own crash dump. None was visible by reading the code.

| what was wrong | how it showed | how it was found |
| --- | --- | --- |
| `isClose` knew only the OK-code `/i` | the stub answered the goodbye with another screen and the GUI tore down its command pipe | the closing frame in our capture carries `/NEX`, not `/i` |
| every frame had 200 bytes cut off its front | `compress=72` on a frame that is not compressed, the body failing to decompress, and a screen sent in reply to something we had not understood | the log line, once the capture showed the frame was well formed |
| the page was painted 24×80 | the first F8 was clean and the second glitched: columns past our width kept the previous session | the wrapper's `CHL` declares 26 rows and 120 columns, twice |
| the whole wrapper was re-sent every frame | SAP GUI died painting a toolbar button it had already freed | **the crash dump**: an access violation in `COldToolBar::DoPaintExternalButton` by way of `CMyPFBitmapButton::SetSystemToolbarIconTextWithKey`, with `CTextfield2::Parse: Invalid object type!` beside it |
| the stub waited to be closed | Eclipse reported a broken pipe on every second and third F8 | the control experiment, below |

The first of those is the reason the DP header matters at all: **the
client's first frame carries a 200-byte DP header and no later one does**,
so "have we answered yet" has to be its own flag. The light-show could
infer it from whether it had started pushing frames; a stub starts nothing.

### The one that needed a control experiment

The pipe complaint survived every protocol fix, and our farewell frame was
byte-identical to the real system's — `000a000000010000`, header only —
with the client sending nothing after it. Measurement inside our own
capture had run out.

So: the same jump against a real system. It was clean. That made it ours,
and told us where to look — not at how we answer the close, but at whether
the close should happen at all.

**A real F8 session ends server-side.** In the whole A4H capture the client
never sends `/NEX`. The server answers the last exchange, the `RFC_TR`
payload disappears because there is nothing more to show, and about two
seconds later it sends the bare end-of-session frame on its own. SAP GUI
then shuts its own window and hands control back to Eclipse. That is what
"jumping into SAP GUI and back" is.

Our stub sat there until somebody closed the window, and *that* path — the
client asking to leave — is the one Eclipse complains about. So the stub
holds its screen for a while and then ends the session itself. Which is
also the better experience: F8 shows the tape error for a few seconds and
puts you back in the editor.

### Where the line fell: a dynpro, not a list

The classic list channel gives what a dynpro cannot — a fixed-pitch grid,
colour bands that are foreground and background together, and therefore a
filled screen and a border. The Spectrum's striped loading border came out
of it exactly right, all four bands confirmed on the wire.

It also has more to go wrong, and it did: a list is cumulative, it is
written a row at a time and never painted over, and it has a declared page
geometry that must be filled. Each of those was a defect of its own.

So the default is the least the protocol can be asked to do: one dynpro, a
group box and a line of text, 4.6 KB against the list's 9.6. A group box
is a single atom and needs no colour, so the border survives the move to
monochrome. The list version is a flag (`-stub-list`), because it is a
thing to opt into rather than a thing to inherit.

```
lsd -listen :3201                  # one still screen, a frame, and the tape error
lsd -listen :3201 -stub-list       # the same in colour, with the striped border
lsd -listen :3201 -stub-hold 0     # wait for the window to be closed instead
```

## Who is calling: the session identity in the hello

The two client frames of the F8 oracle (a real system, tapped on its
dispatcher port) answer the question "how does the dispatcher know it is
you" to the byte.

**Frame 1, the hello — 403 bytes, uncompressed.** The NI route request, a
200-byte DP header, and seven `ST_USER` items. The one that matters is
`ST_USER.14`, 88 bytes of XML:

```
<LOGIN CLIENT="001" LANGUAGE="E" COOKIE="…"/>
```

`COOKIE` is a **reentrance ticket**. Before it starts SAP GUI, Eclipse asks
the ADT server for one — `GET /sap/bc/adt/core/http/reentranceticket`, which
here travels over the RFC bridge to the façade — and passes it to the GUI on
its command line. The GUI presents it in the hello instead of a password,
and the dispatcher's logon turns it into a user. Beside it ride
`GUI_SESSION_UUID` (16 bytes) and `RFC_PARENT_UUID` (32 bytes): the identity
of the session the hand-off came from.

**Frame 2, after the session screen — 595 bytes, compressed.** `VARINFO.04`
carries the OK-code, which is a transaction with its parameters:

```
/n*SADT_START_WB_URI D_OBJECT_URI=/sap/bc/adt/programs/programs/<prog>/source/main;
  D_ECLIPSE_NAVIGATION=X;D_WB_ACTION=EXECUTE;D_ECLIPSE_PROJECT=<project>;
  D_TID=;D_IDE_ID=;D_REQUEST_USER=<user>;D_IDE_USER=<user>;D_GUID=<uuid>
```

What to run and who asks. `D_REQUEST_USER` is what the client *claims*; the
`COOKIE` in frame 1 is what the system *checks*. Around it: the Windows, IE
and Office versions (`ST_USER.1f/20/21`), a `DYNN` item and a 263-byte
`DATAMANAGER` XML.

**But that hello is not the one that reaches us.** The 403-byte hello with
the `LOGIN COOKIE` is the *initial, authenticated* logon (connection 1 of the
oracle). A reconnection an hour later (connection 3) is **317 bytes and
carries no `ST_USER.14` at all** — no cookie, just the UUIDs and the
language. And 317-bytes-no-cookie is exactly what a stock Eclipse sent our
own recorder, and the stub, on F8 against OSD. So the honest state of things:

| where | first hello | cookie present |
| --- | --- | --- |
| Eclipse → real A4H, initial logon | 403 bytes, `ST_USER.14` | yes, `<LOGIN … COOKIE=…/>` |
| Eclipse → real A4H, later reconnect | 317 bytes | no |
| Eclipse → OSD (bridge + stub), F8 | 317 bytes | **no** |

That means **a ticket check bolted on today would reject Eclipse**, because
Eclipse is not sending us a ticket — it opens SAP GUI against OSD anonymously
and it works only because the stub admits everyone. The cookie is real and
measured, but it is the real system's *initial* logon, and we have not made
Eclipse produce it against us.

Why the difference is client-side: Eclipse builds the SAP GUI connection
(the shortcut it hands the GUI) from what it knows about the system's
authentication. Against A4H it had an SSO ticket to pass; against OSD it
decided none was needed. So "make SSO work" is two steps, not one, and the
check is the *second*:

1. **Make the launch carry the ticket.** This is the missing half and it is
   about what ADT tells Eclipse at the `COM.SAP.ADT.SAPGUI` navigation event
   and the reentrance endpoint, so that Eclipse puts a ticket in the GUI
   connection. It has to be measured — the 403 hello is the target, and the
   difference between the A4H navigation response and ours is where it lives.
   Until this lands, there is nothing to verify.
2. **Then verify it.** Once the cookie arrives, the check below is what makes
   it mean something.

Beware the two "reentrance tickets" are not obviously the same one. The
`GET …/core/http/reentranceticket` we serve answers with a **307 redirect to
a loopback URL** carrying the ticket in its query — that is for Eclipse's
*embedded browser* to re-enter the HTTP session (a Fiori or Web Dynpro view
inside Eclipse), measured on both A4H and OSD. Whether the SAP-GUI `COOKIE`
is the same value by another road, or a distinct MYSAPSSO2, is the first
thing step 1 must settle.

**Two things worth knowing about that cookie.** The hello is uncompressed,
so the ticket lies on the wire in clear — compression was never protection,
and the protection DIAG has is SNC, which is out of scope here. And a
reentrance ticket is meant to be short-lived and single-use: it exists to
re-enter the same system from another channel within seconds, not to be a
credential.

## SSO across the three doors: what the cookie could do for us

The measurement above says the same ticket shape logs on through every
door a system has, and this project now has all three doors:

| door | who answers | how a ticket travels | today |
| --- | --- | --- | --- |
| HTTP (ADT, OData, a Web GUI page) | the façade, `:3030` / `:44300` | a cookie on the request | the façade mints a reentrance ticket (24 random bytes, base64url) and forgets it: bound to nothing, checked by nobody |
| RFC (Eclipse over the gateway port, an RFC client) | the bridge, `:33NN` | the logon record's credential field as `TagTicket` (0x0670): a ticket instead of a password. `open-rfc-go` already encodes it on the client side (`internal/cpic/logon.go`, `Ticket`) | the bridge checks no logon at all — every caller is anonymous |
| DIAG (SAP GUI, F8) | the stub, `:32NN` | `<LOGIN … COOKIE="…"/>` in the hello — **measured against A4H's initial logon, but not yet produced against OSD** | the stub reads nothing and lets everyone in; today's F8 hello carries no cookie |

So "can we enter SAP GUI by cookie" is yes in principle — the wire has the
field and a real system uses it — but two things are missing, not one. An
**authority**: one place that mints tickets and one rule that verifies them,
shared by all three doors. And, for DIAG specifically, the **launch path**:
Eclipse must be made to put the ticket in the GUI connection, which it does
against a real system and does not yet against us (see above). RFC is further
along: the wire has the tag (0x0670) and our client already writes it, so
there the only gap is the authority.

**The design, small on purpose.** The façade is the identity authority; it
already owns sessions, CSRF and the reentrance endpoint.

1. **A ticket is a signed claim, not a random string**: `user | client |
   issued-at | nonce`, HMAC-signed with a secret the façade generates on
   first start and keeps under `.local/`. Sixty seconds of life, single use
   (the façade remembers the nonce until it expires).
2. **Every door verifies with the same secret, offline**: the DIAG stub
   checks `COOKIE`, the RFC bridge checks `TagTicket`, the HTTP middleware
   accepts the same value as a cookie. No door calls the façade to ask
   "whose ticket is this"; they share the secret through the same config
   file the sidecar already reads. A door that cannot verify refuses — an
   unknown ticket is a 401, not an anonymous session.
3. **The reentrance endpoint issues for the session that asks**: the user of
   the ADT session (today `DEVELOPER`, client 001, from the façade's
   identity) goes into the claim. That closes the loop Eclipse expects: the
   GUI arrives as the user who pressed F8, and the stub can say so on the
   screen and cross-check `D_REQUEST_USER`.
4. **The jump from a page works the same way**: a Web GUI or launchpad page
   served by the façade asks the same endpoint for a ticket and starts SAP
   GUI with it, which is exactly what Eclipse does. The GUI-side switch that
   takes the ticket is the client's business and was not measured here;
   the DIAG side is settled.
5. **The reverse direction, RFC and DIAG into HTTP**: a session that logged
   on by ticket at the bridge or the stub can be handed a cookie of the same
   shape, so a client that came in over RFC and then opens a browser is the
   same person to the façade.

What this buys beyond correctness: dumps and where-used answers per user,
a personalised guru, and — the real one — the bridge finally checking a
logon, which is the precondition for OSD ever facing anything but a laptop.
It is a session-day of work across the three repositories, and the order is
the façade first (mint and verify), then the stub (one `COOKIE` check), then
the bridge (one `TagTicket` check).

## See also

- [`layers-we-own.md`](layers-we-own.md) — the DIAG reader/writer split across the family
- [`backlog/diag-rfc.md`](backlog/diag-rfc.md) — track C, the side quest and its steps
- [`adt-over-rfc.md`](adt-over-rfc.md) — the gateway door, which is built
