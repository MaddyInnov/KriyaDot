# Octomind Parity Audit — KriyaDot vs Octomind

**Date:** 2026-10-29 · **Audit type:** code-verified (Octomind side) + source-verified (KriyaDot side) · **Scope:** Octomind open-source runtime; hosted Octomind Cloud inventoried separately as vendor-claimed.

## Versions audited

- **Octomind:** `github.com/Muvon/octomind`, full clone (all history/tags) at `hidden_files/octomind-clone/` — **v0.66.3 + 3 commits, HEAD `55b8ed87`** (2026-10-29, "fix(session): restore model and role state on resume"). 574 Rust source files. Inventory: 191 runtime features, each cited to clone evidence (full inventory preserved at `hidden_files/octomind-inventory.md`).
- **KriyaDot:** local tree at `mvp/`, pushed head **`abf52594`** (CI, Android, iOS all green). Every score below was verified against actual source under `packages/` and `apps/` (verification notes at `hidden_files/kriyadot-verification.md`, plus targeted spot-greps for this audit).

## Headline counts (191 runtime features)

| Verdict | Count | Share |
| --- | --- | --- |
| **Present** | 36 | 19% |
| **Partial** | 101 | 53% |
| **Missing** | 54 | 28% |

How to read this: Octomind is a single-purpose, terminal-first **coding-agent harness**; KriyaDot is a broad multi-bot platform (web/desktop/mobile, marketplace, multiplayer, voice, purchasing). KriyaDot matches or beats Octomind on platform breadth (orchestration, MCP, scheduling, channels, multiplayer, voice) but is thinner almost everywhere Octomind goes deep on the *agent harness itself*: supervision/verification, guardrails-as-code, learning, compression science, and CLI/session craft. The 101 Partials are mostly "KriyaDot has the mechanism in a simpler or differently-shaped form" — the build list below is ordered by what closing them is worth.

Octomind items D1–D10 in the inventory are dev tooling (CI gates, cross-compile, bench harness) and are excluded from the 191.

---

## Per-feature table

Evidence shorthand — Octomind: path in the clone. KriyaDot: path under `mvp/` (`ar/` = `packages/agent-runtime/src/`, `api/` = `apps/api/src/`).

### A. Providers / Models

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 1 | Multi-provider runtime, `provider:model` addressing (`src/providers.rs`) | **Present** | `ar/providers/catalog.ts` + `factory.ts` |
| 2 | OctoHub gateway + device-code login, one balance (`src/commands/login.rs`) | Partial | Subscription CLI bridges exist (`ar/providers/cli-bridge.ts`); no unified gateway login / single-balance credits |
| 3 | Purpose-based model profiles: main / supervisor / compression (`config-templates/default.toml`) | Partial | Task-type routing + fixed aux models only (`ar/routing.ts`, `ar/reviewer.ts`, `api/summarizer.ts` hard-wired to Groq); no purpose profile table |
| 4 | 30+ direct providers (Vertex, Bedrock, Cerebras, Together, Fireworks, xAI…) (`doc/usage/04-providers.md`) | Partial | 12 presets + custom OpenAI-compatible synthesis + ~20 agent CLIs; fewer first-class direct presets |
| 5 | ChatGPT subscription as provider (`octomind login chatgpt`) | **Present** | `codex-subscription` + `claude-subscription` presets, consent-gated |
| 6 | Local models: Ollama + OpenAI-compatible local endpoint | **Present** | `ollama` + `llamacpp` presets (`local: true`), `ar/local-llm.ts` |
| 7 | Local CLI-backed models as providers | **Present** | `ar/providers/agent-cli.ts` + `agent-registry.json` (~20 CLIs, PATH-detected) |
| 8 | Per-role model override incl. temperature/top_p/max_tokens/reasoning (`doc/usage/06-roles.md`) | Partial | Per-bot model + `modelOptions` exist; no per-role table across a turn |
| 9 | Mid-session model switching + one-run override (`/model`) | **Present** | Per-turn `providerId/model` override in `api/routes.ts`; `Space.modelOverride` |
| 10 | Reasoning-effort control per profile + mid-session (`/effort`) | **Present** | `ar/types.ts` `reasoningEffort`, honoured in `ar/providers/openai-compatible.ts` |
| 11 | Per-profile retry/timeout controls | Partial | Failover with backoff exists (`ar/failover.ts`); per-profile retry/timeout knobs not exposed |
| 12 | Credential precedence env → config .env → project .env; CLI refuses to store keys | Partial | Env + vault-based credentials (`packages/vault`); KriyaDot deliberately stores keys in its vault instead of refusing |
| 13 | Bundled local neural embedding model (ONNX ~130 MB) for semantic discovery (`src/embeddings/`) | Partial | Local embedder is a char-trigram **hash** embedder (384-dim, `ar/hybrid-search.ts`); no neural embedding model or provider wired |

### B. Multi-Agent / Orchestration

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 14 | `tap` tool: discover/run/list/stop/resume background specialist roles, results injected later (`src/mcp/orchestration/tap.rs`) | Partial | `ar/tools/delegate.ts` + subagents + Fusion exist, but runs are turn-scoped; no background role-run registry injecting results into a live session |
| 15 | Semantic role discovery by intent embedding (`tap discover`) | Missing | Bot choice is by name/LLM (chief tools); no embedding-based role discovery |
| 16 | Config-defined ACP sub-agents as `agent_<name>` tools (`src/mcp/agent/functions.rs`) | **Present** | `ar/acp.ts`, `ar/acp-sessions.ts`, `ar/providers/acp-engines.ts`, delegate `via: 'acp'` |
| 17 | Async ACP agents, concurrency cap, result injected on completion | Partial | ACP sessions stream/persist; completion-injection into a parent session is not the model |
| 18 | Dynamic in-process agents minted at runtime (`agent` tool: add/enable/disable/remove) (`src/mcp/runtime/dynamic_agents.rs`) | Missing | Bots are created via UI/API/marketplace, not by an in-session tool as ephemeral agents |
| 19 | Session-owned dynamic-tool isolation | Partial | Per-**bot** MCP/tool isolation is real (`BotConfig.mcpServers`); per-session dynamic registry absent (see #18) |
| 20 | Supervisor: separate-model overseer that plans, gates, steers (`src/supervisor/`) | Partial | Reviewer model vets tool calls in auto-approve (`ar/reviewer.ts`) + plan gate; no standing supervisor over the whole run |
| 21 | Supervisor verify-gate: "done" rejected without quoted runtime evidence (`src/supervisor/gate.rs`) | Missing | `ar/tools/verify.ts` is advisory only; nothing blocks a completion claim |
| 22 | Supervisor stall/loop detectors (`src/supervisor/detect.rs`) | **Present** | `ar/progress-guard.ts` + W13 span loop detection (`ar/spans.ts`) |
| 23 | Supervisor authorizer: independent tool-authorization layer (`src/supervisor/authorizer.rs`) | Partial | Reviewer auto-approve is a second layer only inside approval modes, not an independent authorizer |
| 24 | Supervisor condense at token threshold (`src/supervisor/condense.rs`) | Partial | Session auto-compaction exists (#127); supervisor-state condensation as such does not |
| 25 | Supervisor recite: worker recites resolved request checklist (`src/supervisor/recite.rs`) | Missing | No recite mechanic |
| 26 | Supervisor steer / delegate / resolve primitives (`src/supervisor/`) | Partial | Steering exists via chief/group-goal envelopes (`ar/group-goals.ts`), not as supervisor primitives |
| 27 | Hindsight retrospective-evaluation integration (`src/supervisor/hindsight.rs`) | Missing | Memory reflection (every 50 turns) is a different, lighter mechanism |
| 28 | Calibrated `evaluate` seam: typed noul/choice/score probability questions (`src/commands/evaluate.rs`) | Missing | Offline eval suites exist (`ar/evals.ts`); no calibrated probability decision seam |
| 29 | Parallel tool policy: read-only concurrent, mutating serialized (`src/session/chat/response/tool_execution.rs`) | Partial | KriyaDot runs **all** approved calls in parallel (`runtime.ts` `Promise.allSettled`); the read-only/mutating serialization discipline is absent |

### C. Sessions & Layers

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 30 | One session engine, five surfaces (CLI, pipe, daemon, WebSocket, ACP) | **Present** | Same runtime behind web/desktop/TUI/CLI/mobile/API (`ar/runtime.ts`, `api/index.ts`) |
| 31 | Plain line-prompt UI, markdown rendering, terminal themes | Partial | CLI REPL exists (`packages/cli/src/repl.ts`); terminal markdown/theme polish is not a focus (rich rendering lives in web) |
| 32 | Named sessions, resume by name / most-recent, session picker | Partial | Resume by id + thread list/titles (`ar/sessions.ts`, `api/chat-threads-routes.ts`); name-based resume + picker semantics differ |
| 33 | Crash-safe persistent sessions (JSONL journals, zstd, torn-frame-safe) | **Present** | SQLite `SessionStore` persists all sessions; interrupted-turn crash recovery in `api/index.ts` (storage format differs) |
| 34 | Provider-native output items preserved across resume | Partial | Transcripts persist; provider-native item fidelity (e.g. reasoning items) is not a designed guarantee |
| 35 | `/reply` — quote an earlier reply point-by-point into the next prompt | Missing | No equivalent command |
| 36 | `/new` `/rename` `/clear` session lifecycle commands | **Present** | Thread create/rename/branch/delete across web + CLI (`threads` commands) |
| 37 | Answer-part-of-a-reply interaction | Missing | No partial-reply answering mechanic |
| 38 | Multimodal sessions: image/video attachments | **Present** | Chat file uploads (`api/routes.ts` uploads), vision-capable turns, companion apps |
| 39 | Project instructions auto-loaded (AGENTS.md-style) (`src/session/project_context.rs`) | Missing | `buildSystemPrompt` uses bot prompt + persona + memory + skills only; no per-workspace instruction file |
| 40 | Template variables `{{CWD}} {{ROLE}} {{GIT_TREE}}…` + `octomind vars` inspector | Partial | Slash-command templates take args; no system template-variable set or vars inspector |
| 41 | Layers: staged orchestration with per-stage role/model + input/output modes (`src/session/layers/`) | Partial | DAG workflows + Fusion approximate staging; no in-session layers with IO modes (see verification #3) |
| 42 | Custom commands (`/run <name>`), shipped `reduce` | Partial | Custom slash commands are prompt templates; commands that execute a workflow/layer are not the same mechanism |
| 43 | Prompt templates (`[[prompts]]`: review/explain/optimize/test/debug) via `/prompt` | **Present** | User-defined slash-command prompt templates + seeds (`api/slash-commands.ts`, `seed/slash-commands.json`) |
| 44 | Unified session inbox (async completions, schedules, monitors, hooks, bg jobs) (`src/session/inbox.rs`) | Partial | Team inbox + needs-you aggregation (W5/W7) cover the human side; no unified in-session async inbox |
| 45 | Cancellation model (first Ctrl+C cancels op, second force-stops; per-session tokens) | **Present** | Turn cancellation across API/CLI; interrupted-run recovery |
| 46 | Standing session rules persisting across sessions | Partial | Per-bot policy rules + memory persist; rules are governance-scoped, not session-standing instructions |
| 47 | Human time & energy estimation per session (`src/session/timing.rs`) | Missing | No human-time/energy accounting |

### D. Tools & MCP

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 48 | MCP-native core: all repo access delivered as MCP tools | Partial | KriyaDot core tools are native built-ins (`ar/tools/builtin.ts`, `coding.ts`); MCP is the extension + server surface, not the core-tool substrate |
| 49 | MCP client: stdio + Streamable HTTP (`src/mcp/client.rs`) | **Present** | `ar/mcp.ts` (SDK transports, TOFU schema pinning) |
| 50 | MCP OAuth: discovery, CIMD, PKCE, persistent token store (`src/mcp/oauth/`) | **Present** | `ar/mcp-oauth.ts` (OAuth 2.1 + PKCE + RFC 8414/8707/7591) |
| 51 | MCP elicitation routed per surface (terminal / WS owner / ACP) (`src/mcp/elicitation.rs`) | Missing | No elicitation handling found in the MCP client |
| 52 | Five builtin MCP servers (core/orchestration/runtime/agent/local) | Partial | `ar/mcp-server.ts` exposes platform tools + bot invocation as one server; not a builtin multi-server suite |
| 53 | Runtime MCP management tool (add/remove/persist servers mid-session) | Partial | Server management via settings UI + CLI (`mcp list`); no agent-facing in-session management tool |
| 54 | MCP override files (`mcp-<name>.toml` auto-bind, wins over base config) | Partial | Servers persist in bot/platform config; no layered override-file mechanism |
| 55 | Per-server tool filtering with wildcards | Partial | Per-bot tool resolution + Read/Write/Egress scopes (`ar/mcp-scopes.ts`); wildcard filter patterns not the mechanism |
| 56 | MCP health monitoring: 120 s checks, dead stdio auto-restart, terminal Failed state | Partial | Directory/registry track server state (`ar/mcp-directory.ts`); no timed health loop with auto-restart policy |
| 57 | MCP tool annotations + context epochs | Missing | Neither annotations nor context epochs found in `ar/mcp.ts` / `ar/mcp-server.ts` |
| 58 | Misuse hints (💡 "wrong tool, use X" appended to results) | Missing | No hint mechanism in the MCP/tool layer |
| 59 | Large-result handling: token threshold + spill/truncation (`src/utils/spill.rs`) | Partial | Tool-output truncation exists (`ar/providers/cli-driver.ts`); no general spill-to-disk + threshold policy for all tools |
| 60 | External FS / semantic code-search companion servers (`octofs`/`octocode`) | Partial | Native file/code tools + any external MCP server can connect; semantic **code** search is not built in (hybrid search covers memory) |
| 61 | Local project tools: executables in `.agents/tools/` auto-register as tools (`src/mcp/core/local_tool.rs`) | Missing | No project-directory executable tool discovery; skills are markdown, user skills live in the data dir |
| 62 | Structured plan tooling owned by the supervisor (`src/mcp/core/plan/`) | Partial | Plan mode is real (human-approved plan gate, `ar/approval-modes.ts`); supervisor-owned persistent plan state is not |
| 63 | `recall` tool dereferencing archived compression blocks | Missing | Compression is summarization; no archive-block registry or recall tool |

### E. Guardrails / Approvals (Policy as Code)

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 64 | Repo-local guardrails file, deterministic, no popups (`.agents/guardrails.toml`) | Partial | Declarative per-bot rules exist but live in `bot-policies.json` via API/UI; KriyaDot's model is approval-centric by design |
| 65 | Pre-call guards: deny by capability + **argument regex** (`src/session/guardrails.rs`) | Partial | Rules match tool-name regex + action class only (`packages/governance/src/bot-policy.ts`); argument inspection exists only inside built-in hard floors |
| 66 | Conditional guards on session history (`when = ["+shell(command=git status)"]`) | Missing | No session-state conditions in the rule language (verified) |
| 67 | Post-result hooks: script failure injects stdout into the agent's inbox → self-correction | Partial | `HookBus` exists with `tool.after` (`ar/hooks.ts`) but only 3 events; no script-hook → inbox correction pattern |
| 68 | End-of-turn validators (scripts the agent must answer next turn) | Missing | `verify_changes` is a voluntary tool, not an automatic end-of-turn validator |
| 69 | Pipe guardrail: pre-model input transform script (`src/session/pipe.rs`) | Missing | No input-transform hook before the model |
| 70 | Guardrail scripts snapshotted at session start | Missing | KriyaDot evaluates live policy each call (deliberate difference; snapshot semantics absent) |
| 71 | Skill validators auto-run at end of turn (with retries) | Missing | Skills have no validate scripts; user-skill lifecycle gate is a different mechanism |
| 72 | Spend-threshold approval contract (interactive y/N; non-interactive stop + exit 75, resumable) | Partial | Hard spend caps enforced pre-call (`packages/billing/src/spend-caps.ts`) — stronger in some ways; the threshold-ask + exit-code resume contract absent |
| 73 | Configurable commit attribution for agent commits | Missing | `git_commit` tool exists; no attribution setting |

### F. Memory / Learning

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 74 | Cross-session learning, file-backed as sole authority, project-scoped + role-filtered (`src/supervisor/learning/`) | Partial | Tiered memory is SQLite per-bot (`ar/memory.ts`); project/role scoping and file authority differ |
| 75 | Two grounded memory types: verbatim-quote user rules + citation-backed experiences, fail-closed verification | Partial | Keeper distillation produces atoms incl. lesson/procedure categories; verbatim-quote storage + grounding verifier absent |
| 76 | Orientation memory vs long-lived experience memory as distinct stores | Partial | L0/L2/L3 tiers are a different axis; no orientation store |
| 77 | Learning extraction on `/done` + background `distill` pipeline | Partial | Per-turn keeper + idle upkeep + 50-turn reflection (`ar/memory-upkeep.ts`); no distill command/pipeline |
| 78 | Active Memory Pack: one token-bounded pack per turn, credit only for material use | Partial | Recall is injected into the system prompt ("What I remember"); pack materialization + material-use credit absent |
| 79 | Linked retrieval: stable IDs + `session://` evidence links, one-hop expansion | Partial | Atoms carry IDs/categories; evidence links + link expansion absent |
| 80 | Hot/cold retention: watermark budgets, verifier-gated merges, archive-after-replace | Partial | Nightly dedupe/contradiction tidy exists; verifier-gated merges + watermark budgets absent |
| 81 | Cold recall by lexical paging over archive catalog; promotion on material use | Missing | No cold archive tier with paged recall |
| 82 | Learning evolution: candidate → verifier → shadow arm → bounded trial → promote only if it beats shadow | Missing | No evolution/A-B pipeline for learned rules |
| 83 | Evolution governance in-session (`/learning evolution approve/reject/rollback`) | Missing | No equivalent commands |
| 84 | Multi-pass learning synthesis / proposal composition | Missing | Not present |
| 85 | Standing global rules recognised by learning; scoped pairing vs recurrence similarity | Partial | `ar/routing-learn.ts` learns generalizable rules from user corrections (routing only) |
| 86 | Lesson management (`/learning list/show/delete/clear`, provenance metadata, glob filters) | Partial | Memory is inspectable via web/API; no `/learning` command set with provenance/outcome metadata |
| 87 | Adaptive external planning memory (plan state preserves critical knowledge across compression) | Partial | Session summaries persist; plan-state-across-compression does not |

### G. Scheduling

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 88 | `schedule` tool + `/schedule`: inject a message as a future user message (`src/mcp/orchestration/schedule/`) | Partial | Routines + thread-scheduler run scheduled bot turns (`api/bot-routines.ts`, `api/thread-scheduler.ts`); no in-session self-scheduling tool |
| 89 | Three trigger kinds: clock / idle-triggered / recurring | Partial | once/daily/cron/interval + webhook + connected-app events + limit-reset; **idle** trigger absent |
| 90 | Persistent schedule storage surviving resume | **Present** | Routines and thread schedules persisted, overlap policies enforced |
| 91 | `monitor` tool: long-lived event streams, batched rate-limited inbox injection (`src/mcp/orchestration/monitor.rs`) | Partial | Watch rules/watcher monitor connected apps with triage (`api/watch-rules.ts`); no generic monitor tool over arbitrary commands |
| 92 | Scheduled tasks / event-driven agents / CI review as first-class patterns | **Present** | Routines, Composio event triggers, headless `kriyadot serve` for CI |

### H. Channels / Integrations

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 93 | WebSocket server: remote sessions, auth token, origin allowlist (`src/websocket/`) | **Present** | WS for voice calls/companion/computer/screen + authenticated API server (`api/index.ts`) |
| 94 | Resumable WS sessions, session control, request-linked costs | Partial | Companion sockets reconnect; a resumable-session protocol with request-linked costs is not the design |
| 95 | WS transport hardening (heartbeat, bounded resources, dead-client close) | Partial | Present in basic form; not hardened/documented to this degree |
| 96 | Session commands exposed to WS clients | Partial | Chat commands work over the API/SSE path; full command parity over WS not established |
| 97 | ACP agent mode: Octomind runs **as** a sub-agent in other stacks/editors (`src/acp/`) | Missing | KriyaDot is ACP **client** only (verified); it cannot be driven by an ACP host |
| 98 | ACP session semantics as server (load_session, capabilities, cost side-channel) | Missing | No ACP server implementation |
| 99 | ACP MCP-server injection by the host into the session | Missing | Depends on #97 |
| 100 | Editor integrations via ACP (Zed, JetBrains, Neovim) | Missing | No editor extension/integration code |
| 101 | Webhook hooks: config scripts fired by external HTTP events (`src/session/webhook_listener.rs`) | Partial | Inbound webhooks trigger routines/workflows with HMAC + dedupe (`api/routine-hooks.ts`); script-endpoint hook contract absent |
| 102 | Inject listener / `octomind send` into a running daemon session | Partial | Messages can be posted to threads via the API (how all clients work); named-session IPC send is not a distinct mechanism |
| 103 | Tap registry as distribution channel (GitHub-repo taps, local taps, built-in tap) | Partial | Marketplace distributes bot/skill/workflow/mcp-server (`packages/marketplace`); GitHub-repo-as-tap distribution absent |

### I. CLI / Daemon / API Surfaces

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 104 | CLI subcommand breadth (run/server/acp/login/config/tap/vars/send/evaluate/workflow/completion…) | **Present** | `packages/cli`: chat, run, bots, routines, threads, models, mcp, team, pause, login, config, serve |
| 105 | Interactive REPL session | **Present** | `kriyadot chat <bot>` TTY REPL with streaming + inline approvals |
| 106 | Non-interactive piped mode for scripts/CI | **Present** | Message from args/`--message`/stdin; clean non-TTY errors |
| 107 | JSONL machine-readable event output (`--format jsonl`) | Partial | `--format json` per command; no streamed typed-event JSONL for runs/workflows |
| 108 | Structured output enforcement (`--schema` JSON Schema on final response) | Missing | No `response_format`/`json_schema` in any provider driver (verified) |
| 109 | Daemon mode: named session kept alive, work injected later | Partial | The API server is the daemon; per-session `run --daemon` + named injection absent |
| 110 | Per-run config override (`-c key=value` over any TOML value) | Missing | Env vars + `config set` only; no single-run arbitrary override |
| 111 | Config CLI: generate/show/**validate** (incl. unknown-key warnings) | Partial | `config get/set/path` exist; validation with unknown-key detection absent |
| 112 | Shell completions incl. dynamic agent/workflow completion | Missing | No completion command found in the CLI |
| 113 | Documented exit-code contract (0/1/2/75/130) | Missing | Exit codes are implicit; no documented contract, no 75-style resumable stop |
| 114 | ~30 in-session slash commands (`/model /role /effort /share /analyze /copy /context /done…`) | Partial | A smaller built-in + custom set (`/goal`, `/plan`, seeds); several Octomind commands have no equivalent on any one surface |
| 115 | Multi-file TOML config merge (alphabetical, deep-merge, migrations) | Partial | Layered JSON overlays exist (`bot-models.json`, `bot-policies.json`); TOML merge/migration semantics absent |
| 116 | Cross-platform single binary + curl/brew/scoop/cargo/docker installs, checksum-verified | Partial | Tauri desktop installers (exe/AppImage/deb) + docker-compose; no single-binary CLI distribution or package-manager channels |

### J. Sandbox / Security

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 117 | OS-level FS sandbox: process + children write-confined to workdir (`--sandbox`) (`src/sandbox/`) | Partial | Docker/E2B sandbox for `run_command` + workspace confinement for file tools (`ar/confine.ts`, `BotConfig.sandboxMode`); no whole-process kernel sandbox |
| 118 | Landlock backend (Linux) | Missing | Not implemented |
| 119 | Seatbelt backend (macOS) | Missing | Not implemented |
| 120 | Role-based tool permissions: per-role server_refs + allowed_tools wildcards | **Present** | Per-bot tool lists, `BotConfig.mcpServers`, MCP scopes, approval modes |
| 121 | Auto-bind exact-match rule (role tag must match fully) | Missing | KriyaDot uses TOFU schema pinning instead; no auto-bind rule |
| 122 | Capability domain gating (capability bound to domains) | Partial | Read/Write/Egress scopes + per-bot isolation; domain-bound capability bundles absent |
| 123 | Environment-gated capabilities (skipped when required env keys missing) | Partial | Providers fail closed without keys (free-only routing guard); capability-level env gating not systematic |
| 124 | Privacy-preserving telemetry (anonymous, content-free, opt-out) | **Present** | Analytics **off by default**, allowlisted events, metadata-only (`ar/product-analytics.ts`, `ar/telemetry.ts`) |
| 125 | Secret hygiene in diagnostics (redaction, no env leakage) | **Present** | Telemetry sanitizer, span payload redaction/caps, vault-backed secrets |
| 126 | Documented local-tool security model | Missing | Follows #61 — no local-tool feature to document |

### K. Context / Compression / Token Efficiency

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 127 | Context compression: token-threshold trigger + model-window ceiling (`src/session/chat/conversation_compression/`) | **Present** | `SessionStore` auto-compaction past keep-N + threshold, summarized once, watermarked (`ar/sessions.ts`) |
| 128 | Adaptive fire line: fold depth computed from measured growth rate; amortization gate | Missing | Fixed keep-N/threshold policy; no computed depth or cost gate |
| 129 | Background folds (compression without blocking the task) | Missing | Compaction is inline |
| 130 | Separate compression model profile | Partial | Summarizer is a distinct cheap model but hard-wired (`api/summarizer.ts` → Groq); not a configurable profile |
| 131 | Lossless archive + recall of compressed blocks | Partial | Full history persists in SQLite and is FTS-searchable; compressed context itself is lossy summary, with no recall-into-context tool |
| 132 | Knowledge-retention budgets deciding what survives a fold | Partial | Last-100-verbatim + summarizer; explicit retention budgets absent |
| 133 | Attention subsystem for keep/drop decisions | Missing | Not present |
| 134 | Attention governance with hash verification of retained blocks | Missing | Not present |
| 135 | `/done`: forced compression + background learning kickoff | Missing | No `/done` command; compaction is automatic only |
| 136 | `/context` inspection of exactly what's in context | Partial | Context meter + 80% warning + usage views; no in-session context listing |
| 137 | Prompt-cache awareness: cache accounting + keepalive pings | Partial | Token/cost accounting exists; cache-specific accounting and keepalive absent |
| 138 | Intent-driven context minimisation (load tools/skills on demand) | Partial | Lazy MCP (`mcp_search_tools`) + skill progressive disclosure exist; activation is model-driven, not intent-scored |
| 139 | Deterministic capability auto-activation (embedding triggers, abstain-on-tie, no LLM) | Missing | No deterministic activation; embeddings are hash-based |
| 140 | LRU eviction of active capabilities (soft cap, refcount-aware) | Missing | Not present |
| 141 | Fast decision seam: cheap-model toggles for routine routing decisions (`[decision]`) | Partial | Cheap-model seams exist piecemeal (router, reviewer, summarizer); no unified decision config |
| 142 | Token counting, message dedup, smart summarizer utilities | **Present** | `ar/usage.ts` contextMeter, `ar/pricing.ts`, memory-upkeep dedupe, `api/summarizer.ts` |

### L. Workflows

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 143 | TOML-defined workflows; per-step role/model/toolset/skills (`src/workflow/`) | Partial | DAG workflows with agent/bot-turn nodes (`packages/workflows`) — per-node bot ≈ role+model; TOML format and per-step skills absent |
| 144 | Sequential steps + variable substitution (`{{input}}`, prior outputs) | **Present** | Workflow runner data flow between nodes |
| 145 | Parallel blocks with `max_parallel` cap | **Present** | Level-parallel DAG execution; Fusion worker pool capped at 4 |
| 146 | Dynamic fan-out (`match` over runtime data) | Partial | Fusion's planner generates subtasks dynamically; no workflow `match` block |
| 147 | Loop blocks (generator/evaluator until accepted) | Partial | Coordinator loops exist in group goals; no workflow loop node type |
| 148 | Conditional blocks | **Present** | `if`-node branch edges in the DAG runner |
| 149 | Graph routing (non-linear step graphs) | **Present** | True validated DAG, topological levels |
| 150 | Workflow cost budget + per-step retries/timeouts | Partial | Global/per-bot spend caps + Fusion budget abort; per-workflow budget and per-step retry/timeout policy not established |
| 151 | Workflow dry-run / validate (print plan, spawn nothing) | Partial | DAG validation exists; a user-facing dry-run plan print not established |
| 152 | Workflow observability: per-step + aggregated cost events (JSONL) | Partial | Runs visible via run-health + spans; no workflow JSONL event stream |
| 153 | Tap-distributed workflows (installable like agents) | Partial | Marketplace has a `workflow` kind; tap distribution absent |
| 154 | Shipped workflow templates (sequential/fan-out/graph/research) | Partial | Seeds focus on skills/commands/personas; a comparable template set not shipped |

### M. Skills / Roles / Specialists

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 155 | Specialists: packaged agent (prompt + model + servers + permissions + skills) run by `category:variant` name | Partial | Marketplace bots bundle prompt+model+tools and install; skills bundling + one-command named run only approximated |
| 156 | First-use specialist bootstrap (fetch manifest, install deps, resolve credentials, start servers) | Partial | Marketplace installer + safety scan exist; dependency auto-install + credential resolution on first run partial |
| 157 | Tap authoring: `tap init` scaffolds/validates/registers a new tap | Missing | No package-authoring scaffolding CLI |
| 158 | Manifest placeholders + per-capability/model overrides from user config | Partial | Custom provider presets + per-bot overrides exist in a different shape |
| 159 | Manifest caching with configurable freshness | Missing | No caching found in `packages/marketplace/src/registry.ts` |
| 160 | Roles: local definitions with prompt + model + permissions; shipped defaults | **Present** | Bots are exactly this (per-bot prompt/model/tools) + 16 personas + seeds |
| 161 | Mid-session role switching (`/role`) | Partial | Per-turn model/bot override exists; switching the persona/role of a live session is not a first-class action |
| 162 | Skills as packs (SKILL.md + scripts/ + references/ + assets/ + resource catalog) | Partial | Skills are single markdown files with frontmatter + progressive disclosure (`ar/skills.ts`); no scripts/assets in the pack format |
| 163 | Declarative skill auto-activation rules (frontmatter logic per user message) | Missing | Skills activate via model-invoked `read_skill`; no rule engine |
| 164 | Manual/env skill control (`/skill`, skill tool, env force-load) | Partial | Skill lifecycle gate + `read_skill` exist; env force-load and a `/skill` command surface partial |
| 165 | Capabilities: named TOML bundles of servers + tool filters, tap-distributed | Partial | Per-bot MCP sets + scopes approximate bundles; named distributable capability units absent |
| 166 | Semantic discovery of capabilities/skills (embedding intent search) | Missing | No embedding-based discovery (see #13/#15) |
| 167 | Language/domain skills auto-activate inside a generalist specialist | Missing | Same missing mechanism as #163 |
| 168 | Shipped example specialist config in-repo (`developer:rust`) | **Present** | Seed bots/skills/personas ship in `seed/` |

### N. Sharing / Collaboration

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 169 | Session sharing: `/share` → permanent public link to the full session log | Missing | No session share/export anywhere (verified); sharing exists only for pages (`api/public-pages.ts`) |
| 170 | `/analyze`: local session viewer via loopback bridge, nothing uploaded | Partial | Activity UI with span waterfall + replay over local data (W13) serves the same purpose in a different form |
| 171 | Specialist sharing as the primary collaboration unit (publish a manifest) | Partial | Marketplace publishing of bots/skills/workflows exists |
| 172 | Clipboard export of conversation (`/copy last/assistant/user/all`) | Missing | No conversation export/copy command found |
| 173 | Multi-process collaboration on one live session (send + webhooks + WS attach) | Partial | Many clients attach to one server/threads; webhooks inject events; no single live-session multi-writer model |

### O. Observability / Cost

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 174 | Per-session spend thresholds enforced, incl. before spawning children | **Present** | Per-turn budgets + per-bot/global daily/monthly caps consulted pre-call (`packages/billing`) |
| 175 | `/info`: session tokens/cost/cache/compression in one view | Partial | Usage views + context meter exist (web/API); no single in-session `/info` |
| 176 | `/report`: per-request usage breakdown | Partial | Append-only cost ledger + span-level detail in Activity; no per-request report command |
| 177 | `/usage` + account balance in-session | Partial | Billing/usage lives in web settings; no in-session account command (local-first: no vendor account) |
| 178 | `/status`: live tap/agent runs, monitors, background/shell jobs | Partial | Activity Runs tab + run-health cover runs; shell-job status surface partial |
| 179 | Cost side-channels on ACP / WebSocket / workflow surfaces | Partial | Usage events stream in chat; ACP cost side-channel and workflow cost events partial |
| 180 | Supervisor statistics accumulator across concurrent sessions | Partial | Span/run-health aggregates exist; no supervisor-specific stats |
| 181 | Structured logging with runtime log-level control | Partial | Structured logs exist; runtime `/loglevel` toggle not established |
| 182 | Telemetry pipeline explicitly separated from local stats and session records | **Present** | Three separated stores: telemetry ring (metadata-only), persisted spans, opt-in analytics |
| 183 | Published benchmark results (octobench: 24/25 real-PR tasks) | Missing | KriyaDot has offline evals (`ar/evals.ts`) but no published comparative benchmark |

### P. Misc (runtime)

| # | Octomind feature (evidence) | KriyaDot | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 184 | Edit mode: file ranges + hashed line identifiers for exact edits | Partial | Coding tools (`patch`/`edit`/`grep`/`lsp_*`) exist; hashed line IDs + range-attach UX absent |
| 185 | Assistant-output hygiene (internal metadata filtered, invented reminders stripped) | Partial | Redaction/filtering exists in telemetry/spans; output-hygiene rules as such not established |
| 186 | Terminal rendering: thinking/tool display, syntax highlight, markdown links | Partial | Rich rendering lives in web/TUI; terminal-specific polish partial |
| 187 | Interactive terminal polish (reedline input, animations, job managers) | Partial | Ink TUI + CLI REPL exist (`apps/tui`, `packages/cli`) |
| 188 | Tool-error tracking: repeated errors change behaviour | Partial | Progress guard + span loop detection react to repetition; per-tool error tracking as such partial |
| 189 | Extensive environment-variable surface (100+ documented vars) | **Present** | Large documented env surface (`.env.example`, config routes) |
| 190 | Recorded end-to-end demo example shipped in-repo (`examples/fix-a-bug`) | Missing | No equivalent verified demo artefact |
| 191 | Meta-skill for driving Octomind itself from other agents (`skills/octomind/SKILL.md`) | Missing | KriyaDot is drivable via API/CLI/MCP server, but ships no self-driving skill doc |

---

## Octomind Cloud — vendor-claimed surface (NOT code-verified)

Inventoried from octomind.run (homepage, `/blog/meet-your-octos`, `/pricing`) on 2026-10-29. None of this is in the open-source clone; treat every line as the vendor's claim. The "octo" is the cloud's unit: a named agent for one workstream with its own folder, memory, conversations and routines on a hosted machine.

| Cloud feature (vendor-claimed) | KriyaDot position |
| --- | --- |
| Octos: 10 (Pro) / 30 (Max) named agents, each its own folder `/home/octo/octos/<name>`, own memory + routines; created automatically from your first job | Local equivalent exists in shape: KriyaDot bots are per-workstream agents with own memory/tools/routines — but self-hosted, no hosted machines |
| Cloud machines: Small (5 octos) / Medium (10) / Large (20), shared packing, sleep-when-idle (1 h default), wake on message, never reclaimed, cold archive after 3 days suspended | **Excluded** (hosted compute) |
| Your hands on the machine: browser shell with sudo + Docker, custom Docker images (5/20/50 by plan), live URLs for built apps (5/20/50, private by default) | **Excluded** (hosting); KriyaDot's local analog is per-bot computer/browser surfaces + public page publishing |
| The Hub: one login connects every model at provider price, prepaid credits, 3% top-up fee, $5 starter credit for a GitHub star | **Excluded** (hosted gateway/billing); runtime BYO keys + aggregators are Present locally |
| Specialist auto-routing: cloud orchestrator reads the job and hands off to a registry specialist automatically, with a visible byline | Partial locally — chief/`coordinate_bots` + marketplace approximate it; automatic invisible specialist selection with byline is not a KriyaDot behaviour |
| Channels bound to octos: Telegram, WhatsApp, Slack, GitHub; `/octos` + `/use` switching; group chats bound to one octo | Channels themselves are **Present** locally (`api/messaging.ts`: Telegram, Discord, Slack, WhatsApp); per-agent chat binding model differs |
| Routines (scheduled agent runs) on the cloud | Present locally (routines engine) |
| Developer API: `POST /octos`, session creation with `octo_id`, activity paging, OpenAPI doc; 180–600 req/min by plan | KriyaDot has its own local API surface; no octo-style public developer API |
| Metered add-ons: voice in/out ($0.010/$0.025 per min), media generation (images/video/audio), web search ($5/1k), browser starts/time | Voice is Present locally with own keys; web search Present; **media generation Missing** locally (no generation code found); metering is a cloud-billing concern |
| Plans: Free (hub only) / Pro $50/mo ($20 first month) / Max $200 / Team $500 pooled, per-member caps, unlimited members by invite | **Excluded** (hosted plans); KriyaDot multiplayer + spend caps exist locally without pooled vendor billing |
| Octo presence UX: status marks (working/awake/asleep/limit-paused), 12 colours, avatar export, one-screen home of crew tiles | Cloud UX; KriyaDot web has bot tiles/status in its own design language |
| `/share` hosting at octomind.run/r/<id> and the hosted session viewer | Hosting **excluded**; the share *capability* is scored Missing in the runtime table (#169) because a self-hosted equivalent (via KriyaDot's public-pages infra) is buildable |

---

## Excluded by standing order (not gaps, not in the build list)

Per the user's standing order, KriyaDot is not building cloud hosting. The following Octomind items are therefore excluded from the gap count and the build list:

- Hosted cloud machines (provisioning, sleep/wake, packing, cold archive) and the machine-slot/storage pricing model
- Live URLs / public hosting of agent-built apps on vendor infrastructure
- The Hub as a hosted model gateway with credits, top-up fees and pooled team billing
- Hosted routines/machines "that keep working while you're away" as a vendor service (the *capability* exists locally via KriyaDot's own daemon + routines)
- Octomind Cloud plans (Pro/Max/Team) and the octos panel as a hosted product surface
- The hosted share viewer at octomind.run (the client-side share capability is **not** excluded — see build list #7)

Everything in the open-source **runtime** is in scope, including features Octomind's cloud happens to use.

---

## Ranked build list (Partial + Missing, by user impact)

Each item: what to build in KriyaDot, in one line. Numbers reference the table above.

### Tier 1 — trust and automation fundamentals

1. **Supervisor verify-gate (#21, Missing; with #62, #68)** — add a completion gate: a separate cheap-model supervisor that rejects "done" unless the final claim cites runtime evidence (tool results/test output), with a bounded retry loop. Builds on `ar/reviewer.ts` + `ar/tools/verify.ts`; this is Octomind's single biggest quality differentiator.
2. **Structured output enforcement (#108, Missing)** — add `response_format`/JSON-Schema support to the provider drivers and a `--schema` / per-turn schema option in runtime + CLI. Unblocks CI/scripted use of KriyaDot agents.
3. **Guardrails as code, deepened (#64, #65, #66)** — extend `BotPolicyRule` beyond tool-name regex: argument matching, and session-history conditions ("only allow X after Y ran"); accept a repo-local policy file per workspace in addition to `bot-policies.json`.
4. **Project instruction files (#39, Missing)** — load `AGENTS.md` (and fallbacks) from the bot's workspace into the system prompt per turn, with the same trust/pinning treatment skills get. Cheap, table stakes for coding use.
5. **End-of-turn validators + self-correcting post-result hooks (#68, #67, #71)** — let bots/skills declare validator scripts (or built-in checks) that run automatically at turn end; a failure injects its output as the next instruction instead of ending the turn.
6. **Neural embeddings provider (#13, Partial)** — implement a real embedder (hosted API and/or local model) behind the existing `SyncEmbedder` interface, replacing trigram-hash vectors; prerequisite for #7 and for trustworthy semantic memory.
7. **Semantic discovery (#15, #166, #139)** — with #6 in place: embedding-based discovery of bots/skills/capabilities by intent, plus optional deterministic auto-activation of skills/MCP bundles per message (with abstain-on-tie).

### Tier 2 — harness depth

8. **Session sharing (#169, #172, Missing)** — reuse the public-pages machinery (`/p/<slug>`, sanitizer + CSP) to publish a read-only session transcript link, plus a plain export (markdown/JSON) of a thread.
9. **ACP server mode (#97–#100, Missing)** — implement an ACP agent endpoint so KriyaDot bots can be driven from Zed/JetBrains/Neovim and other agent stacks; KriyaDot already speaks ACP as a client and MCP as a server.
10. **Purpose-based model profiles (#3, #8, #130, #141)** — one configurable table for main / supervisor / compression / routing / reviewer models (with sampling params), replacing the hard-wired summarizer and scattered aux-model choices.
11. **Adaptive compression (#128, #129, #131, #63, #132, #135)** — compute fold depth from measured growth, run folds in the background, keep a dereferenceable archive of compressed ranges with a `recall`-style tool, and add a manual "compact now" action.
12. **Learning hardening (#75, #80, #78, #86)** — store user rules as verbatim quotes with a grounding check before a distilled atom is trusted; verifier-gated memory merges; a memory/lesson inspector with provenance (list/show/delete) on web + CLI.
13. **Layers inside a turn (#41, #42)** — optional per-bot stage pipeline (e.g. refine → execute → review) where each stage has its own prompt + model and defined IO modes, generalizing today's stage prompts and Fusion.
14. **Provider catalog breadth (#4, #11)** — add first-class presets for the missing direct providers (Vertex AI, Bedrock, xAI, Together, Fireworks, Cerebras, MiniMax, Moonshot) and per-profile retry/timeout knobs.
15. **Background specialist runs (#14, #17, #18)** — a background run registry: delegate to a bot/specialist asynchronously, list/stop/resume, and inject the result into the originating session when it lands; plus ephemeral in-session agent definitions.
16. **Local project tools (#61, #126)** — auto-register executables from a workspace `.kriyadot/tools/` directory as tools (header-declared schema), with the sandbox/confinement story documented.
17. **MCP completion pass (#51, #56, #58, #53)** — elicitation handling per surface, health loop with auto-restart for stdio servers, wrong-tool misuse hints, and an agent-facing MCP management tool.
18. **Tool-parallelism discipline (#29)** — classify tools read-only vs mutating and serialize mutating calls within a turn (today everything approved runs in parallel).

### Tier 3 — reach and polish

19. **In-session scheduling + monitoring (#88, #89, #91)** — a `schedule` tool (incl. idle trigger) and a generic `monitor` tool feeding the team/needs-you inbox, on top of the existing routines engine.
20. **Recite + hindsight (#25, #27)** — optional plan-gate mode where the bot recites the resolved checklist before executing, and a post-run retrospective pass feeding memory.
21. **Calibrated evaluate seam (#28)** — a cheap-model yes/no/choice/score helper with probabilities, usable by the verify-gate (#1), validators and routing.
22. **Evolution pipeline for learned rules (#82, #83, #84)** — shadow-trial promotion for routing/memory rules that prove themselves against a control arm, with approve/rollback UI.
23. **Kernel sandbox backends (#118, #119, #117)** — Landlock (Linux) / Seatbelt (macOS) write-confinement for local (non-Docker) tool execution.
24. **Workflow format pass (#143, #146, #147, #150, #151, #154)** — file-based workflow definitions (import/export), `match` fan-out and loop node types, per-workflow budget + per-step retry/timeout, dry-run plan print, shipped templates.
25. **Specialist packaging pass (#155, #156, #157, #162, #165)** — marketplace packages that bundle skills with the bot, first-run dependency/credential bootstrap, a package-authoring scaffold command, and skill packs with scripts/references/assets.
26. **CLI craft (#107, #110, #112, #113, #109)** — streamed JSONL output for runs/workflows, per-run `-c key=value` overrides, shell completions, a documented exit-code contract, named daemon sessions.
27. **Session craft (#35, #37, #136, #114)** — reply-quoting into the next prompt, a `/context` inspector, and the missing in-session commands (`/info`, `/report`, `/status` equivalents) on web + CLI.
28. **Email as a bot channel** (from verification #10 — not an Octomind item, noted for completeness) — register the email provider `apps/api/src/people.ts` already references, completing the channel set.
29. **Small items** — commit attribution setting (#73), pipe input transform (#69), policy snapshot option (#70), human time & energy accounting (#47), published benchmark run (#183), shipped demo artefact (#190), self-driving skill doc (#191), manifest caching (#159), misuse of `auto_bind`-style exact-match safety for MCP auto-loading (#121).

---

## Method and honesty notes

- Octomind features were inventoried from the clone's code, docs and config templates (191 items, `hidden_files/octomind-inventory.md`); external companion servers (`octofs`, `octocode`) are schema-loaded at runtime, so only their integration surface is inventoried.
- KriyaDot verdicts come from reading the actual source (full notes: `hidden_files/kriyadot-verification.md`). Stubs, doc-only claims and unwired code were scored Partial at best. Where a KriyaDot mechanism exists in a deliberately different shape (e.g. approval cards vs Octomind's no-popup policy, vault-stored keys vs refuse-to-store), the item is Partial with the difference stated rather than Missing.
- Several KriyaDot strengths have no Octomind counterpart and are therefore not in this table: marketplace with revenue share, approval-gated purchasing, multiplayer people/relays/team inbox, voice calls, phone-app operation, public page publishing, per-bot persistent browser profiles, iOS/Android companions, observability span waterfall/replay. This audit measures Octomind parity only.
- Analysis only: no Octomind code or branding was copied; no KriyaDot source was modified in this pass.
