# Native dialog transactions (in development)

The opt-in native path keeps the transpiled ABAP call stack suspended while a
screen waits for input. Each transaction owns a worker, including its function
group globals, class statics and database connections. Ending or expiring a
session closes that worker. Workers isolate state; they do not sandbox source.

This path has not passed release acceptance. It does not yet support control
framework events, subscreens/table controls, MODULE data declarations, or the
complete screen validation and MESSAGE lifecycle. Unsupported constructs must
fail explicitly. A parsed source or rendered synthetic form is not evidence
that an imported application works.

Native generation is currently available through the checkout's Node toolchain;
bundled hosts refuse the option when they lack the native compiler adapter.
Passing compiler validation alone does not cover execution.

The draft MESSAGE adapter preserves default MESSAGE-ID and RAISING, and passes
classic exception metadata to the immediate method or function, including
parenthesized method calls with EXCEPTIONS. An unhandled
RAISING uses the message's normal behavior. A function's ERROR_MESSAGE handler
can receive errors from nested calls. An abort handled this way needs a host
`engine.rollbackWork` implementation covering the complete SAP LUW; otherwise
it fails explicitly. Asynchronous/deferred function calls and RECEIVE RESULTS
raise `NATIVE_UNSUPPORTED_STATEMENT` when reached. Unselected branches may be
compiled, but they do not gain an emulated asynchronous implementation.

The dialog draft pauses I messages for acknowledgement, carries S messages to
the next screen, and terminates on unhandled A/X messages. In PAI, E/W messages
enable the associated FIELD or entire CHAIN. Corrections repeat the applicable
validation without PBO; an unchanged warning can be acknowledged at the paused
statement. Exit-command modules run before field transport, including during
correction. E/W in other processing contexts and MESSAGE INTO with RAISING are
not implemented. Automatic dictionary/required-field validation, complete
request-flag semantics and message formatting/localization still need work.
The registered compiler, runtime and HTTP regressions have not yet been run.

Class-pool compilation also needs shared globals across its locals includes
and main class. The native declaration adapter restores that scope and
initializes nested constants using ABAP's case-insensitive names. A native
class pool emits one shared module, retaining mappings to the original files.
Unit-test includes currently fail explicitly because their shared entry is not
implemented. The shared layout still awaits behavioral verification.
Function-group TOP includes and MODULEs following ENDFUNCTION reuse the group
scope. Native LEAVE TO LIST-PROCESSING, LEAVE TO TRANSACTION and CALL DIALOG
also raise explicit runtime errors; interactive lists, transaction switching
and legacy dialog-module dispatch are not implemented.
FORM and function-module names use separate JavaScript namespaces so same-named
DATA objects remain valid. Calls, exports and registry entries stay consistent.

These semantics follow SAP's documentation for
[field and chain validation](https://help.sap.com/SAPHELP_SCM700_EHP02/helpdata/EN/4a/43a1d75a503f04e10000000a421937/content.htm)
and [messages in procedures](https://help.sap.com/saphelp_em900/helpdata/en/4a/44c7f4c6bf0451e10000000a421937/content.htm).

The native adapter adds static GET BADI / CALL BADI using a resolved enhancement
definition and its interface. Each worker owns its BAdI handles and implementation
instances. Trusted transaction configuration supplies `badis`: definitions with
`name`, `interfaceName`, `singleUse`, `instantiation` (`new` or `reuse`), empty
`filters`, optional `fallbackClass`, and the complete active `implementations`
selection. Each implementation has `name`, `className` and `isDefault`.
Ordinary implementations take precedence over defaults, then the fallback.
The original compiled class executes the method. Filters, context-dependent
instances and dynamic method/definition names are currently refused. Selection
must already reflect active switches; the runtime does not infer switch state.
Object reflection on BAdI handles is not implemented. These additions still
await behavioral validation and do not establish application acceptance.
The exception names used for a missing or ambiguous single-use implementation
are public contracts documented by SAP in
[Multiple Use](https://help.sap.com/saphelp_autoid2007/helpdata/en/e4/5c3642eca5033be10000000a1550b0/content.htm).

`profileParameters` records observed kernel lookup results by parameter name,
for example `{"demo/setting":{"subrc":0,"value":"configured"}}`. Omitting
`value` preserves the FIELD operand on a failed read. Unknown names fail
explicitly; they never receive an invented default. The worker installs these
services before initialization and class constructors. A custom bootstrap must
install them itself. Configuration is fixed within the internal session.

Compile a dedicated generation with `options.nativeDynpro: true` and leave
`options.importProg` off. Both bootstrap variants install the dialog stack
before loading function groups. The normal dynamic initializer reuses
`_top.mjs`, allowing the worker to set screen metadata and session identity
before class constructors execute. The generation's setup owns its database
and repository services; a separate in-memory database is not a shared
repository. Database setup and class constructors must be reviewed before
pointing multiple workers at persistent data.

The normal Steamgate front registers `/sap/bc/osd/native-dynpro`. It returns 404
unless `OSD_NATIVE_DYNPRO_CONFIG` names a local JSON configuration, for example:

```json
{
  "transactions": {
    "ZDEMO": {
      "output": "./generation",
      "entry": "zdemo.prog.mjs",
      "screens": ["./zdemo.metadata.json"],
      "context": {"client": "123", "user": "DEVELOPER", "language": "E"}
    }
  },
  "maxSessions": 2,
  "idleTimeoutMs": 1200000,
  "timeoutMs": 60000
}
```

Paths resolve relative to the configuration file. Screen metadata is the
existing open-abap-gui converter format. Transaction codes select configured
entries; HTTP input cannot supply module paths. The route serves HTML forms,
with a session cookie, a form nonce, and a screen revision. Radio selection
works through the common DIAG form adapter. The entry is imported once inside
the worker, after its generation and database have initialized.

A host with additional services can provide a trusted `bootstrap` module in
place of `output`, `entry` and `screens`. Its exported async `boot(configuration)`
returns `{engine, entry}`: an initialized `NativeDynproRuntime` and an async
closure that executes the actual ABAP entry. The bootstrap receives the
session context and must apply it before executing initialization logic that
depends on identity. It must also provide the application's real database and
repository services. A fixture bootstrap is only a lifecycle test.

Release pre-flight includes `test/suites.d/native-dynpro.json`, the DIAG form
regressions, and the requested application's actual user journey. The current
draft tests cover isolation, nested calls, field transport, suppression,
cancellation, stale submissions, CSRF rejection and radio selection. They do
not certify an application dependency closure or control framework support.
