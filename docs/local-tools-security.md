<!-- SPDX-License-Identifier: Apache-2.0 -->
# Local project tools — security model

This document describes, honestly and as implemented, how KriyaDot's
local project tools work, what confinement does and does not apply,
and how governance treats them. It matches the code in
`packages/agent-runtime/src/local-tools.ts` (discovery + execution)
and `packages/governance/src/default-policy.ts` (the `local:` policy
rule). Where the implementation is weaker than a reader might assume,
this document says so.

## What local tools are

A bot workspace may carry executables in `.kriyadot/tools/`. A file
that is executable (`chmod +x`) and declares itself with an `@tool`
header comment is auto-registered, per turn, as a tool named
`local:<name>`:

```text
#!/usr/bin/env node
// @tool
// name: lint-fix
// description: Run the project linter with autofix on a path
// parameters: {"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}
// mutating: true
// timeoutMs: 60000
```

The host (API) discovers them fresh for each bot per turn via
`discoverLocalTools(workspaceDir)`; discovery is cached per directory
on an mtime/size/mode signature, and broken declarations are reported
as errors and skipped — never thrown, never half-registered.

Invocation contract: the call arguments are written to the process as
JSON on stdin; the tool prints a JSON result (or plain text) on
stdout. A non-zero exit code becomes an error result containing an
excerpt of stderr.

**Trust implication:** whoever can write an executable into a bot
workspace's `.kriyadot/tools/` directory can register a tool. Treat
write access to a workspace as equivalent to the ability to propose
host code execution — governance (below) is what stands between
proposal and execution.

## Execution confinement — the honest reality

Local tools are executed with Node's `execFile`:

- directly on the **host**, as the **same OS user** as the KriyaDot
  server process, with that process's environment inherited;
- working directory set to the bot workspace;
- a per-tool timeout (declared `timeoutMs`, default 60 s) and a 4 MB
  output buffer cap; stdout returned to the model is truncated to
  20,000 characters.

There is **no sandbox wrapper**: no container, VM, seccomp profile,
filesystem jail, network namespace, or privilege drop is applied to
local tool processes. A local tool can read and write anything the
server process's OS user can, open network connections, and spawn
further processes. The workspace working directory is a convenience,
not a boundary.

Confinement that exists elsewhere in the product (governance
approvals, hard floors, sandbox modes for the agent's built-in tools)
must not be assumed to confine local tools. The controls that govern
local tools are: (1) the executable bit + `@tool` declaration gate at
discovery, (2) the governance approval treatment below, (3) the
process timeout and output caps above, and (4) the audit trail every
governed call leaves.

## The self-declared `mutating` flag

The `@tool` header's `mutating:` field is **self-declared by the tool
author** and is parsed as `true` only when the header literally says
`mutating: true`; anything else (including an omitted field) is
`false`. Nothing verifies the declaration: a tool that mutates state
but declares `mutating: false` (or omits it) will be recorded as
non-mutating.

Where the flag is consumed in the runtime, it matters:

- plan mode blocks tools flagged mutating;
- the supervisor verify-gate requires verification after a turn in
  which a mutating tool ran;
- the checkpoint hook snapshots files before flagged-mutating tools.

Note the asymmetry with MCP tools: the runtime treats every `mcp:`
call as mutating regardless of declaration (effects unknown,
fail-closed), but does **not** apply the same blanket assumption to
`local:` tools — for local tools the declared flag is authoritative
today. Operators should therefore treat an undeclared `mutating`
field as unknown-risk, not as proof of read-only behaviour. The
governance layer compensates independently (next section): approval
treatment for `local:` tools does not depend on the flag at all.

## The `local:` policy rule and approval treatment

Governance classifies `local:<name>` tools as action class `write`
(the gateway's conservative default for unknown tools) and the
default policy carries an explicit rule:

```text
id:          local-tools-require-approval
toolPattern: ^local:
effect:      require-approval
```

So **every local tool call requires human approval by default**,
regardless of its declared `mutating` flag. The approval record
carries a secret-redacted snapshot of the call arguments, and the
call appears in the governance audit log like any other governed
call.

An operator who trusts a specific local tool can allow it by placing
a more specific rule ahead of the default rule (first match wins),
e.g. in the bot policy or `.kriyadot/policy.json`:

```json
{ "id": "allow-local-lint", "toolPattern": "^local:lint-fix$", "effect": "allow" }
```

That allow is a deliberate, named trust decision for that one tool —
there is no way to blanket-allow `local:` tools via the default
policy, and bot/workspace rules can also tighten treatment (e.g.
`deny` a named local tool).

What governance does **not** change for local tools: the catastrophic
hard floors are unconditional denials that no approval can override,
and they apply before any policy rule — but note they pattern-match
`run_command`-style calls; a local tool's inner behaviour is opaque
to the gateway, which sees only the `local:<name>` call and its
arguments. Approval is therefore the real control for what a local
tool does, and approvers should read the tool's script, not just its
name and description, before approving an unfamiliar one.

## Operator guidance

1. **Audit `.kriyadot/tools/` like code you run** — because it is.
   Review new or changed executables before a bot runs in that
   workspace; `git status`/`git diff` on the workspace is the
   practical review loop.
2. **Keep the default approval rule.** Only allowlist individual,
   reviewed tools by exact name, and re-review after they change
   (the allow rule matches the name, not the file's hash).
3. **Set `mutating: true` honestly** in every tool you author that
   writes, deletes, or calls mutating APIs — plan mode, the
   verify-gate, and checkpoints all depend on it.
4. **Run the server as a least-privilege OS user.** Since local
   tools inherit the server process's user and environment, that
   user's filesystem and network reach is the blast radius. Keep
   unrelated secrets out of the server environment where possible;
   local tools inherit environment variables.
5. **Prefer narrow tools.** A tool that takes a path and does one
   thing is approvable at a glance; a tool that takes a free-form
   command string is `run_command` with extra steps and should be
   treated (and reviewed) as such.
6. **Watch the audit log.** Local tool calls, approvals, and denials
   are recorded; an approval pattern you don't recognize is a signal
   to re-audit the workspace.
