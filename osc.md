# OSC and TET

Notes on terminal OSC sequences, what the three agents do with them, and whether TET could use
OSC 7501 as a readiness signal. Everything below is marked as **measured** (seen in a pty on this
machine), **read** (taken from source or a binary, not observed running) or **reported** (secondary
source only).

## What OSC is

An Operating System Command is an escape sequence a program writes to its terminal for something
that is not screen text: `ESC ]`, a number, `;`, data, a terminator (`BEL` or `ESC \`, "ST"). The
number says what it is for; a terminal ignores numbers it does not know.

| Number | Meaning |
|---|---|
| 0 / 2 | window title |
| 8 | hyperlink |
| 52 | write to the clipboard (useful when the program runs somewhere else than the terminal: SSH, container) |
| 7501 | Program Status Protocol: the program reports its state |

## OSC 7501, the Program Status Protocol

Specified by Superlogical (Rex); reported as implemented by libghostty, Rex, Claude Code, Crush and
others. Spec: <https://www.superlogical.com/rex/docs/build/program-status> (read).

- Report: `ESC ] 7501 ; state=<state>:app=<name>[:kind=…][:progress=…][:msg=<base64>] ST`
- Support query: `ESC ] 7501 ; ? ST`. A terminal that supports the protocol answers with an OSC 7501
  whose payload starts with `?` (pi's matcher: `^\x1b\]7501;\?[^\x07\x1b]*(\x07|\x1b\\)$`; Claude Code
  accepts any OSC 7501 as the answer).
- States seen in the agents: `idle`, `working`, `blocked` (with `kind=permission|question|auth`),
  `done`, `error`, `clear`.
- Reports never carry prompts or model output. They carry **no session id**.

## What each agent does

### pi (1.2.0, 1.1.0 introduced it)

- **Measured**: with nothing set, pi writes the query at startup and sends no status. When the
  query is answered (`ESC]7501;?ESC\`) it sends `state=idle:app=pi` about 10 ms later. With
  `PI_PROGRAM_STATUS=1` it sends `state=idle:app=pi` at once without asking; `=0` turns it off.
- **Read** (`pi-tui/dist/terminal.js`, `modes/interactive/program-status-reporter.js`): the query
  shares the device-attributes (DA) sentinel. A reply to the query must reach pi **before** the DA
  reply; the DA reply ends the pending window and counts as "no support". Support is decided once per
  `start()`.
- **Read**: states reported: `working` during a run and during compaction, `blocked` while an
  extension dialog or a login waits (kinds `question`, `auth`), then `done`, `error` or `idle` when
  the run settles; `idle` also after an abort. Idle is reported right after `ui.start()` in
  `init()`, i.e. after extensions loaded.
- Related, not OSC 7501: `agent_settled` has carried `aborted` since 1.1.0; TET's extension already
  uses it (`piStopCutShort`).

### Claude Code (2.1.296; support came with 2.1.295)

- **Measured**: writes `ESC]7501;?ST` at startup (about 0.8–1.1 s) and sends nothing until it is
  answered. After an answer it sent `state=idle:app=claude-code` about 0.4 s later (started in the
  TET repository directory, already trusted).
- **Read** (strings in `claude.exe`): support starts as "not asked yet"; any OSC 7501 reply counts
  as support (`probe: OSC 7501 reply`). Reports are `state=…:app=claude-code[:id=…][:kind=…]
  [:progress=…][:title=…][:msg=…]`, `state=clear` on exit. Disabled by `CLAUDE_CODE_DISABLE_TERMINAL_TITLE`
  and for background workers (`CLAUDE_CODE_SESSION_KIND=bg`). No environment variable that forces it
  on was found.
- **Not measured**: `working` / `blocked` / `done`, the trust dialog in an unknown directory, whether
  `idle` comes before or after the dialog.

### Codex (0.162.1 stable)

- **Measured**: nothing. No OSC 7501 (query or report) in the binary, and no reply from a pty answer.
- **Read** (`openai/codex`): `codex-rs/tui/src/terminal_program_status.rs` came with one commit on
  2026-10-09 ("Report terminal program status with OSC 7501", #52725). The tag `rust-v0.162.1` does
  not contain it, `rust-v0.163.0-alpha.9` does. States: `Idle`, `Working`, `Blocked`. The module
  gates on `current_terminal_program_status_support()` (terminal detection); how that decides was
  **not read**, so it is unknown whether Codex asks the query or detects by terminal name.
- Codex's other status OSC is 21337 (iTerm2 only).

## Windows: conpty

**Measured** with `node-pty` 1.2.0-beta.14:

- With the inbox conhost (`useConptyDll` unset) an OSC reply written to the pty **never reaches the
  program**: both `ESC]7501;?ESC\` and `ESC]7501;?BEL` were dropped, a DA reply passed.
- With the bundled `conpty.dll` (`useConptyDll: true`, which is what `src/main/terminals/pty.ts`
  sets) both reached the program.

So an answer works in TET only because TET uses the DLL. Linux and macOS ptys were not tested.

## What TET does today

- **Ready check**: `AgentTerminal.createIsCliReady` per agent. pi uses
  `createByteThresholdCheck(1000)`, a byte count, not a signal. It is fed in
  `session-manager.ts` `startSession` → `onOutput`.
- **Turn marks** (working, waiting, finished): from hooks over the control channel (`tet-ctl hook`),
  addressed by `TET_TAB_ID`; pi's extension posts the same request. AGENTS.md: nothing is read off
  the terminal. The ready check is the one place that reads output.
- **Clipboard**: the renderer loads xterm's `ClipboardAddon` (`terminal-views.ts`), so OSC 52 from any
  agent already works. Claude Code and Codex contain OSC 52 and OSC 8 code (strings in the binaries;
  when they send them was not measured). pi 1.2.0 added `PI_CLIPBOARD_OSC52=1` to also send OSC 52
  after its local clipboard write; it is not set by TET.
- No code in `src/` handles 7501.

## Could OSC 7501 be TET's ready signal?

For pi and Claude Code: yes, on the evidence above. For Codex: not before 0.163, and unknown how it
decides to send.

Why not for turn marks: the status has no session id (TET binds a tab to its session by it), and it
arrives as terminal output while the turn state lives in the main process.

### Conditions and how they are met

1. **The answer must reach the agent before xterm's DA answer.** Answer in the main process, in
   `onOutput`, by writing straight to the session when the query is seen. The window's xterm can only
   answer DA after an IPC round trip, so it is behind. Not yet tested inside TET.
2. **conpty must pass the reply.** Already true (`useConptyDll: true`).
3. **The query can be split across two chunks**: keep a short tail of the previous chunk.
4. **Agent-specific**: a field of `AgentDefinition` for the agents that ask (pi, Claude Code), never a
   branch on an id. Codex keeps the byte threshold. An older agent version that does not ask also
   needs the byte threshold as the fallback.
5. After the answer the agents keep printing `state=…` reports into the pty output; the window's
   xterm is assumed to ignore unknown OSC numbers (not checked).

### Not verified

- Linux and macOS ptys.
- The sandbox tab: whether `sbx` passes the query out and the answer in.
- `working`, `blocked`, `done` of Claude Code; the trust dialog and login cases of either agent.
- Codex 0.163's gating.
- The answer written from `onOutput` inside the running TET (only a standalone pty was used).

## Possible smaller changes (not made)

- `sandbox.env` `PI_CLIPBOARD_OSC52=1` for pi in a sandbox, if copying out of a sandbox tab fails
  today (untested; needs a kit image with pi ≥ 1.2.0).
- Raise pi's `install.verifiedVersion` from 1.1.0 to 1.2.0. 1.2.0 changes `-p` to exit 1 when the
  answer is cut off at the output token limit; `ask.ts` reads the exit code, so a cut-off commit
  message becomes an error. 1.2.0's other breaking changes (`before_agent_start` for extension
  triggered runs, the theme schema, MCP resources) do not touch TET's extension, which only listens
  to `agent_start`, `agent_settled` and `ui_prompt_start/end`.

## How it was measured

Throwaway scripts outside the repository (session scratchpad): `probe.cjs` spawns an agent in a pty
with `node-pty` (`useConptyDll: true`, 120×30), logs each chunk's OSC numbers and queries, answers
`ESC[6n`, DA and optionally the 7501 query (7501 first, then DA); `inpath.cjs` writes OSC replies into
a pty whose child echoes its raw stdin. pi was started as `node …/pi-coding-agent/dist/bundle/cli.js`
(`cmd.exe /c pi` does not work through node-pty). Binaries were searched with `grep -a` for the
number, which misses sequences built from a constant (Claude Code writes it as `PROGRAM_STATUS:7501`).
