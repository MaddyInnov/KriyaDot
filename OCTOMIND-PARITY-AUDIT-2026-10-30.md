# Octomind Parity Audit — KriyaDot vs Octomind (RE-AUDIT)

**Date:** 2026-10-30 · **Audit type:** code-verified re-score of all 191 rows from the 2026-10-29 audit · **Scope:** Octomind open-source runtime; hosted Octomind Cloud re-scored as it stands (no longer excluded from scoring).

## Versions audited

- **Octomind:** clone at `hidden_files/octomind-clone/` re-verified unchanged — **v0.66.3 + 3 commits, HEAD `55b8ed87`**, identical to the original audit. All scoring is against the original 191-feature inventory (`hidden_files/octomind-inventory.md`).
- **KriyaDot:** local tree at `mvp/` == GitHub main **`39837a19`**, CI green. This tree includes both builds since the original audit: the Octomind Tier 1–3 build (`8f545f25`) and the OpenMausBot+Octop build (`2eaedad6` + `39837a19`). Every row below was re-verified against actual source and tests by six parallel verification passes; build-report claims were treated as leads, not evidence (per-row verification notes: `hidden_files/reaudit-scratch-*.md`).

## Headline counts (191 runtime features)

| Verdict | 2026-10-29 | 2026-10-30 | Delta |
| --- | --- | --- | --- |
| **Present** | 36 (19%) | **62 (32%)** | **+26** |
| **Partial** | 101 (53%) | **115 (60%)** | +14 |
| **Missing** | 54 (28%) | **14 (7%)** | **−40** |

How to read this: the Missing column collapsed — 17 rows jumped Missing → Present and 23 more Missing → Partial. The Partial column *grew* because most landings are real but narrower than the Octomind original: the builds repeatedly shipped the mechanism at library depth and stopped one step short of full parity (unwired registration, missing surface, missing named sub-feature). The closure list at the end is therefore dominated by small "finish the last 10%" items, plus a short list of genuinely unbuilt systems (attention subsystem, cold memory tier, standing supervisor, unified slash-command set).

Three rows were **downgraded** on fresh evidence — they were mis-scored in the original audit: #38 multimodal (native image parts never reach a provider; vision routing is dead code), #50 MCP OAuth (CIMD was claimed; it does not exist), #145 parallel blocks (no `max_parallel` cap on workflow levels).

### Per-layer counts

| Layer | Rows | Present | Partial | Missing | (was P/Pa/M) |
| --- | --- | --- | --- | --- | --- |
| A. Providers / Models | 13 | 7 | 6 | 0 | 6/7/0 |
| B. Multi-Agent / Orchestration | 16 | 6 | 10 | 0 | 2/8/6 |
| C. Sessions & Layers | 18 | 6 | 11 | 1 | 6/8/4 |
| D. Tools & MCP | 16 | 3 | 12 | 1 | 2/9/5 |
| E. Guardrails / Approvals | 10 | 6 | 3 | 1 | 0/4/6 |
| F. Memory / Learning | 14 | 0 | 12 | 2 | 0/10/4 |
| G. Scheduling | 5 | 3 | 2 | 0 | 2/3/0 |
| H. Channels / Integrations | 11 | 2 | 7 | 2 | 1/6/4 |
| I. CLI / Daemon / API | 13 | 6 | 7 | 0 | 3/6/4 |
| J. Sandbox / Security | 10 | 5 | 4 | 1 | 3/3/4 |
| K. Context / Compression | 16 | 6 | 6 | 4 | 2/7/7 |
| L. Workflows | 12 | 6 | 6 | 0 | 4/8/0 |
| M. Skills / Roles / Specialists | 14 | 2 | 12 | 0 | 2/7/5 |
| N. Sharing / Collaboration | 5 | 1 | 4 | 0 | 0/3/2 |
| O. Observability / Cost | 10 | 2 | 7 | 1 | 2/7/1 |
| P. Misc (runtime) | 8 | 1 | 6 | 1 | 1/5/2 |
| **Total** | **191** | **62** | **115** | **14** | **36/101/54** |

Layer F (Memory/Learning) is the weakest layer: still zero Present — the mechanisms landed but three of them are unwired in production (see flags). Layer K holds 4 of the 14 remaining Missing (attention subsystem, hash governance, `/done`, LRU eviction).

---

## Biggest movers — Missing → Present (17)

| # | Feature | What landed |
| --- | --- | --- |
| 21 | Supervisor verify-gate | `ar/supervisor.ts:verifyCompletionClaim` rejects "done" without quoted tool evidence; rejection guidance re-enters the turn, bounded, audited. Opt-in per bot; mutating-evidence turns only. |
| 25 | Supervisor recite | Plan-mode worker recites the approved plan as a numbered checklist; calibrated coverage check forces one retry on a confident miss. Opt-in, plan-mode only. |
| 27 | Hindsight retrospective | Post-turn retrospective writes a single evidence-grounded `Lesson:` into tiered memory via the host sink. Opt-in per bot. |
| 39 | Project instruction files | `ar/project-instructions.ts` loads AGENTS.md / KRIYADOT.md / `.kriyadot/instructions.md` per turn into the system prompt; tested. |
| 61 | Local project tools | `.kriyadot/tools/` executables with `@tool` headers auto-register as `local:<name>` tools; wired per turn; tested. |
| 63 | Recall of archived compression blocks | Lossless `compaction_archive` + `recall_compacted_context` tool, session-scoped, registered by the host; tested. |
| 68 | End-of-turn validators | Bot + loaded-skill validators auto-run at turn end; failures inject as the next instruction, bounded retries; tested end-to-end. |
| 69 | Pipe guardrail | `input.transform` hook fires pre-model; model sees transformed text, stored message keeps the original. Plugin-wired. |
| 71 | Skill validators | `validators:` frontmatter parsed and unioned into end-of-turn validation. |
| 73 | Commit attribution | `BotConfig.commitAttribution` flows to the tool context; `git_commit` appends it (deduped, capped). |
| 97 | ACP server mode | Real ACP server (`ar/acp-server.ts`, 342 lines, NDJSON JSON-RPC over stdio), exposed as `mvp-server acp --bot <id>`; tested. |
| 112 | Shell completions | `kriyadot completion [bash|zsh]` with dynamic bot/routine/session names baked in at generation time. |
| 113 | Exit-code contract | `cli/exits.ts` documents and implements 0/1/2/75/130; SIGINT → 130; spend-cap stop → 75; tested. |
| 118 | Landlock backend | Embedded C helper (syscalls 444–446) compiled on demand; write-escape blocked in tests when kernel ABI ≥ 1. |
| 121 | Auto-bind exact-match rule | `autoBindExact` in the MCP directory; bound via the `mcp_manage` tool; tested. |
| 129 | Background folds | Compaction serves the stale summary and folds asynchronously; host-enabled. |
| 169 | Session sharing | `POST /sessions/:id/share` publishes a sanitized transcript via the public-pages machinery at `/p/<slug>`; export endpoint; web Share button; tested. |

Also Missing → Partial (23): #15, #18, #28, #35, #47, #51, #58, #66, #82, #83, #98, #108, #110, #119, #128, #139, #157, #159, #163, #166, #167, #172, #190.
And Partial → Present (12): #3, #29, #64, #65, #89, #107, #130, #131, #136, #146, #147, #154.

---

## ⚠️ Rows that did NOT move despite the builds claiming coverage

This is the audit's most important finding. In each case the build report claimed the item (or it sat on a build list) and verification found it absent, unwired, or materially narrower:

**Still Missing (claimed or listed, not built):**
- **#70 — Policy snapshot option.** Named in the Tier-3 "small items" list. Grep finds nothing; live per-call policy evaluation stands unchanged.
- **#99 — ACP host MCP-server injection.** The ACP server ignores `session/new` params entirely; host `mcpServers` are never parsed or connected, and capabilities advertise MCP http/sse as `false`.
- **#100 — Editor integrations (Zed/JetBrains/Neovim).** No config snippet, doc, or extension artefact exists anywhere; the only trace is a "Zed et al." code comment.
- **#126 — Local-tool security model documentation.** The local-tools feature is real (#61), but no security model is documented — and the undocumented reality is host `execFile` with no sandbox wrapper, a self-declared `mutating` flag, and no `local:` rule in the default policy.
- **#135 — `/done`.** Building blocks exist separately (`compactNow()`, hindsight) but no command combines forced compression + learning kickoff; `compactNow` isn't exposed on any user surface.
- **#183 — Published benchmark.** `BENCHMARK.md` exists but explicitly disclaims the claim: "local micro-benchmarks of deterministic harness components… not model-quality benchmarks," supervisor gate timed against a mock provider. No real task suite is run or published.
- **#191 — Self-driving meta-skill.** `seed/skills/self-driving.md` teaches KriyaDot's *own bot* an internal autonomy loop. It contains no instructions for an external agent to drive KriyaDot via API/CLI/MCP. Not this row.
- **#37, #57, #81, #84, #133, #134, #140** also remain Missing (answer-part-of-reply, MCP annotations+epochs, cold memory tier, multi-pass synthesis, attention subsystem, hash governance, LRU eviction) — these had weaker or no explicit build claims.

**Still Partial because the last wiring step is missing (mechanism real, production path absent):**
- **#59 — Spill retrieval.** Tool results spill to disk with a preview that tells the model to call `read_spilled_result` — but `createSpillTools` is **never registered anywhere**; spilled content is unrecoverable by the model.
- **#67 / #101 — Script hooks.** `createScriptHookHandler` (stdout-on-failure injection) has **zero call sites** in the whole tree, tests included. No host, config, or webhook route can fire a script hook.
- **#75 — Verbatim-quote grounding.** `storeVerbatimQuote` is implemented and unit-tested; **no production caller exists** — the distiller/keeper never invoke it, so live learning still stores ungrounded atoms.
- **#80 — Verifier-gated merges.** The gate is real, but **all three host call sites omit the `mergeVerifier`**, so it is inert live. The "watermark budgets" half has no implementation at all.
- **#137 — Cache keep-warm.** `CacheWarmer` is instantiated nowhere (the OMB/Octop build report admitted this; still true), and there is no cache-token accounting in usage/pricing.
- **#156 — Specialist bootstrap.** A one-time bundle install behind an endpoint (not run at startup); no dependency install, no credential resolution, no MCP startup — bundles explicitly skip MCP entries.
- **#143 / #151 — Workflow format & dry-run.** Both libraries are solid and tested, but neither is wired to any API/CLI/UI surface; the API's `/dry-run` is an unrelated bot-message preview.

**Still Partial because the claim was narrower than stated:**
- **#88 — In-session scheduling.** Tools are real, but handlers drop `ctx.sessionId`: scheduled work fires in a fresh `routine_<id>` session, not as a user message injected into the originating session.
- **#108 — Structured output.** `--schema` exists only on `mvp-server chat`, not the `kriyadot` CLI; runtime "enforcement" is JSON-parse + one retry — the reply is never validated against the schema; Anthropic/Bedrock get prompt-append only.
- **#110 — `-c` overrides.** A 5-key whitelist (`bot, provider, model, apiUrl, format`), not arbitrary config override.
- **#117 — Kernel sandbox scope.** Landlock/Seatbelt wrap only `run_command`, only as an opt-in fallback behind E2B/Docker; the default fallback is an *unsandboxed* host shell, the writable area is a temp dir (not the workspace), and file/local tools are never kernel-confined.
- **#128 — Adaptive compression.** Fold depth is computed from measured context *size*; the claimed growth-*rate* computation and amortization gate do not exist (a `sessions.ts` header comment claims the rate logic the code doesn't perform).
- **#139 / #163 / #166 / #167 — Semantic activation.** Deterministic, abstain-on-tie activation is genuinely wired — for skills only, behind a per-bot opt-in flag **no seed bot sets**. MCP/capability auto-activation, frontmatter activation rules, and any intent-search surface over bots/capabilities do not exist.
- **#150 — Workflow budgets.** Budget/retry/timeout machinery is real, but **agent and bot-turn nodes report $0 cost** (`wf/cost.ts`: "the runner holds no price table"), so budgets cannot cap LLM spend — the dominant cost. #152 and #179 inherit this emptiness.
- **#25 / #27 — Recite & hindsight** moved to Present but have **no dedicated tests** (verified by grep; coverage is code-path only).
- **Adjacent dead code:** `cli/bridge-commands.ts` (federation CLI) is not dispatched, not in help/completion, and rejected by the CLI validator — a file, not a command.

---

## Known stated limits from the builds — verification

| Stated limit | Verified? | Detail |
| --- | --- | --- |
| Email channel lacks STARTTLS | **Real** | The only `STARTTLS` occurrence in the tree is the doc comment in `api/email-transport.ts:16` ("STARTTLS upgrade is NOT implemented"). Implicit TLS or plain only. Channel is registered alongside Telegram/Discord/Slack/WhatsApp; the loop guard works (own-address mail skipped, fetched mail marked `\Seen`). |
| Delegate children lack their own modelProfiles | **Real** | `SubagentSpawnInput` carries no model profiles; `api/delegate-wiring.ts` builds the child runtime **without** `modelProfiles` or session-store options, so the host's `model-profiles.json` is silently dropped, aux purposes fall back to env only, and child sessions get no summarizer (no compression). Background runs are unaffected (they execute inside the parent runtime and inherit). |
| Workflow agent/text nodes report $0 cost | **Real** | `wf/cost.ts` states the runner holds no price table; `case 'agent'` returns plain text, `bot-turn` returns `{text, sessionId}` — neither carries usage/cost, so `extractCostUsd` yields 0 and workflow budgets cannot cap LLM spend. |
| Landlock verified live | **Real, embodied in tests** | Confinement assertion runs when the kernel reports Landlock ABI ≥ 1 (blocks `$HOME` write); otherwise the test expects fail-closed rejection. Helper is compiled on demand — nothing prebuilt ships; a C compiler is needed at first use. |
| Seatbelt execution-unverified | **Still unverified** | Code is complete and darwin-gated; only profile-generation tests exist. Unverifiable on this Linux VM — needs a macOS runner. |
| Cache keep-warm not instantiated | **Still true** | See #137 flag above. |

---

## Per-feature table

Evidence shorthand — Octomind: path in the clone. KriyaDot: path under `mvp/` (`ar/` = `packages/agent-runtime/src/`, `api/` = `apps/api/src/`, `gov/` = `packages/governance/src/`, `cli/` = `packages/cli/src/`, `wf/` = `packages/workflows/src/`, `mkt/` = `packages/marketplace/src/`).

### A. Providers / Models

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 1 | Multi-provider runtime, `provider:model` addressing | Present → **Present** | `ar/providers/catalog.ts` + `factory.ts`; `provider/model` parsing in `routing.ts`/`model-profiles.ts`; tests |
| 2 | OctoHub gateway + device-code login, one balance | Partial → Partial | No `octohub`/device-code anywhere; per-CLI subscription bridges only; no unified gateway login or shared balance |
| 3 | Purpose-based model profiles: main / supervisor / compression | Partial → **Present** | `ar/model-profiles.ts` (9 purposes), loaded from `model-profiles.json`, consumed by runtime/supervisor/summarizer/reviewer/extract/evaluate. Caveat: `routing`/`triage` purposes are declared but have no call sites (see #141) |
| 4 | 30+ direct providers (Vertex, Bedrock, Cerebras…) | Partial → Partial | 23 presets now; real dedicated drivers for Vertex (JWT→OAuth) and Bedrock (SigV4+Converse); the rest are OpenAI-compatible presets on a shared driver. Count and per-provider drivers still short of 30+ |
| 5 | ChatGPT subscription as provider | Present → **Present** | `codex-subscription` bridge, consent-gated CLI token; tests |
| 6 | Local models: Ollama + OpenAI-compatible local endpoint | Present → **Present** | Dedicated `ollama`/`llamacpp`/`lmstudio` drivers + `custom-*` BYO endpoints |
| 7 | Local CLI-backed models as providers | Present → **Present** | `agent-cli.ts` + `cli-driver.ts` + ACP engine fleet; tests |
| 8 | Per-role model override incl. temperature/top_p/max_tokens/reasoning | Partial → Partial | `PurposeModelProfile` carries the full knob set and the main path forwards it, but reviewer/supervisor/evaluate resolve only the model id (supervisor hard-codes temperature 0); summarizer drops topP/effort |
| 9 | Mid-session model switching + one-run override (`/model`) | Present → **Present** | CLI `/model`, per-turn overrides, `-c` overrides, `PUT /api/bots/:id/model` |
| 10 | Reasoning-effort control per profile + mid-session | Present → **Present** | `ar/reasoning-profiles.ts` maps effort across OpenAI/Anthropic/DeepSeek drivers |
| 11 | Per-profile retry/timeout controls | Partial → Partial | Honored on the main OpenAI-compatible path (+Vertex by delegation); Anthropic ignores `maxRetries`, Bedrock honors neither; aux purposes never forward theirs |
| 12 | Credential precedence env → config .env → project .env; CLI refuses to store keys | Partial → Partial | Actual chain: env → `providers.local.json` (0600). **No `.env` support at all** and the chain is undocumented; vault/file storage stance (deliberate difference) unchanged |
| 13 | Bundled local neural embedding model (ONNX ~130 MB) | Partial → Partial | Real neural embedder exists (`embeddings.ts` HTTP `/embeddings`, incl. local Ollama models) but is **opt-in**; the trigram hash embedder remains the default, the sync leg, and the failure fallback. No bundled ONNX model |

### B. Multi-Agent / Orchestration

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 14 | `tap` tool: discover/run/list/stop/resume background specialists, results injected later | Partial → Partial | `BackgroundRunRegistry` + `delegate_background`/`list_background_runs`/`stop_background_run`; results inject as a user message at the origin session's **next turn**. No resume, no discover verb in this tool set, no injection into a live in-progress turn |
| 15 | Semantic role discovery by intent embedding (`tap discover`) | Missing → Partial | `ar/discovery.ts:discoverByIntent` ranks bots/skills/MCP/capabilities by cosine similarity, but production wiring feeds it **skills only**; no discovery tool for bots/roles, delegation doesn't use it |
| 16 | Config-defined ACP sub-agents as `agent_<name>` tools | Present → **Present** | `delegate via:'acp'` against bot ACP config + `acp-sessions.ts` + engine fleet (surface shape as originally credited) |
| 17 | Async ACP agents, concurrency cap, result injected on completion | Partial → Partial | ACP delegation is still synchronous `await client.prompt(...)`; completion-injection covers in-process background runs only; **no concurrency cap** on ACP or background spawns |
| 18 | Dynamic in-process agents minted at runtime (`agent` tool) | Missing → Partial | Ephemeral specialists are mintable per run (`ephemeralName/Prompt/Model`, 155-profile library) but live for exactly one run — no add/enable/disable/remove lifecycle, no named re-invocation |
| 19 | Session-owned dynamic-tool isolation | Partial → Partial | Per-bot isolation real (incl. delegate subset registries); the tool registry is still one host-shared map — no per-session dynamic registry |
| 20 | Supervisor: separate-model overseer that plans, gates, steers | Partial → Partial | A separate-model overseer exists but acts **only at the final-answer boundary** (verify-gate + token buffering). It does not plan or steer; planning is human plan mode, steering is the user SteerQueue |
| 21 | Supervisor verify-gate: "done" rejected without quoted runtime evidence | Missing → **Present** | `ar/supervisor.ts` + runtime `endOfTurnCorrection`; zero-evidence claims rejected without a model call; bounded retries; audited. Opt-in per bot / env |
| 22 | Supervisor stall/loop detectors | Present → **Present** | `progress-guard.ts` + span loop detection; tests |
| 23 | Supervisor authorizer: independent tool-authorization layer | Partial → Partial | Reviewer is invoked at exactly one site, inside auto-approve mode only; the supervisor authorizes completions, not tool calls. No independent authorizer outside approval modes |
| 24 | Supervisor condense at token threshold | Partial → Partial | Session compaction is stronger (adaptive, background, archived), but the supervisor is stateless per gate call — there is no supervisor state to condense |
| 25 | Supervisor recite: worker recites resolved request checklist | Missing → **Present** | Plan path recites the approved plan as a checklist with a calibrated coverage check + one retry. Opt-in, plan-mode only, **no dedicated test** |
| 26 | Supervisor steer / delegate / resolve primitives | Partial → Partial | The primitives exist scattered (SteerQueue, delegate tools, group-goals/chief) — none are supervisor-owned; `supervisor.ts` exports only the gate + model resolver |
| 27 | Hindsight retrospective-evaluation integration | Missing → **Present** | `generateRetrospective` writes one evidence-grounded lesson per tool-using turn into tiered memory. Opt-in, best-effort, **no dedicated test** |
| 28 | Calibrated `evaluate` seam: typed noun/choice/score probability questions | Missing → Partial | `ar/evaluate.ts:evaluateQuestion` is a real typed seam returning probabilities — but its only caller is the recite check. The verify-gate, validators, and routing **do not use it**, despite the build claim naming them |
| 29 | Parallel tool policy: read-only concurrent, mutating serialized | Partial → **Present** | `executeWithToolDiscipline`: mutating calls (incl. `mcp:` fail-closed) are barriers that drain reads and run alone; this is now the execution path; tested |

### C. Sessions & Layers

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 30 | One session engine, five surfaces (CLI, pipe, daemon, WS, ACP) | Present → **Present** | One `runTurn` now also backs the ACP server (same session store) |
| 31 | Plain line-prompt UI, markdown rendering, terminal themes | Partial → Partial | Themes now exist in the TUI (5 palettes); **no markdown rendering in any terminal surface**; CLI REPL is a plain prompt streaming raw text |
| 32 | Named sessions, resume by name / most-recent, session picker | Partial → Partial | CLI name-based resume exists (named-session store, `send <name>`) but names are CLI-local config while web titles live in a separate store — two disjoint naming systems; no most-recent/`--continue` resume |
| 33 | Crash-safe persistent sessions | Present → **Present** | SQLite WAL store + orphaned-turn crash recovery; tests |
| 34 | Provider-native output items preserved across resume | Partial → Partial | Sessions persist role/content/tool fields only; provider-native items (reasoning items etc.) are neither captured nor replayed |
| 35 | `/reply` — quote an earlier reply point-by-point into the next prompt | Missing → Partial | `/reply` exists (API chat, tested) but quotes **one whole message**, has no web UI affordance, and the CLI REPL **rejects it** as an unknown command |
| 36 | `/new` `/rename` `/clear` session lifecycle commands | Present → **Present** | Thread CRUD across web + CLI + TUI |
| 37 | Answer-part-of-a-reply interaction | Missing → **Missing** | No fragment/selection reply mechanic; closest are whole-message reply/thread actions |
| 38 | Multimodal sessions: image/video attachments | Present → **Partial** ⬇ | **Downgraded (original mis-score).** Images reach the model only as OCR text/metadata; native image content parts are never sent; `decideVisionRoute` has no production caller; no video handling at all |
| 39 | Project instructions auto-loaded (AGENTS.md-style) | Missing → **Present** | `ar/project-instructions.ts`, per-turn, capped + cached; tests |
| 40 | Template variables `{{CWD}} {{ROLE}} {{GIT_TREE}}…` + `vars` inspector | Partial → Partial | Only narrow substitutions (`{args}`, `{{payload}}`, workflow `{{input}}`); no system variable set, no inspector |
| 41 | Layers: staged orchestration with per-stage role/model + IO modes | Partial → Partial | In-session layers exist (`BotConfig.layers`, prepare/review stages with per-stage prompt+model+inputMode; tested) — but no output modes (fixed by kind), only two stage kinds, no role per stage, no API/web configuration surface |
| 42 | Custom commands (`/run <name>`), shipped `reduce` | Partial → Partial | Slash commands still only expand prompt templates; no slash → workflow/layer execution; no `reduce` |
| 43 | Prompt templates (`[[prompts]]`) via `/prompt` | Present → **Present** | User-defined slash prompt templates + seeds (functional equivalent, as originally credited) |
| 44 | Unified session inbox (async completions, schedules, monitors, hooks, bg jobs) | Partial → Partial | Background results now inject into the origin session and the team inbox aggregates the human side — but bg runs, schedules, monitors, and hooks never converge into one per-session inbox; the bg registry is in-memory (lost on restart) |
| 45 | Cancellation model | Present → **Present** | AbortControllers, disconnect aborts, REPL/TUI/ACP cancel, SIGINT → 130 |
| 46 | Standing session rules persisting across sessions | Partial → Partial | Standing material is bot-, workspace- (project instructions), or governance-scoped; no session-level standing rules settable in-session |
| 47 | Human time & energy estimation per session | Missing → Partial | `api/human-accounting.ts` reports approval counts + decision latencies — global/by-bot, approvals only; not per-session, no time-saved estimate, **no dedicated test**, not surfaced in web |

### D. Tools & MCP

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 48 | MCP-native core: all repo access delivered as MCP tools | Partial → Partial | Architectural difference unchanged: native built-in core tools; the platform MCP server re-exposes the registry externally, but runtime execution does not go through MCP |
| 49 | MCP client: stdio + Streamable HTTP | Present → **Present** | `ar/mcp.ts`, TOFU schema pinning; tests |
| 50 | MCP OAuth: discovery, CIMD, PKCE, persistent token store | Present → **Partial** ⬇ | **Downgraded (original mis-score).** Discovery (RFC 8414), PKCE, DCR (RFC 7591), encrypted token store all real — but **CIMD does not exist** (grep: nothing); identity via pre-registration or DCR only |
| 51 | MCP elicitation routed per surface | Missing → Partial | Elicitation handler exists and is wired to **one route only** — the in-flight turn's chat widget host. No terminal/CLI, WS-owner, or ACP route; headless turns decline |
| 52 | Five builtin MCP servers | Partial → Partial | Still one builtin server (`mvp-platform-mcp`) exposing registry tools + chat + telemetry resources |
| 53 | Runtime MCP management tool | Partial → Partial | `mcp_manage` tool exists (list/status/health_check/restart/bind) — but no add/install, remove/uninstall, or persist-new-server actions |
| 54 | MCP override files (`mcp-<name>.toml` auto-bind) | Partial → Partial | No override-file mechanism exists (grep: nothing); per-bot enable overrides only |
| 55 | Per-server tool filtering with wildcards | Partial → Partial | Scopes are per-exact-tool-name toggles; regex patterns exist only in governance policy, not as per-server filters |
| 56 | MCP health monitoring: 120 s checks, dead stdio auto-restart, terminal Failed state | Partial → Partial | Health loop is real, host-started, with one auto-restart attempt — but the interval is **60 s, not 120 s**, and the status enum has no terminal `Failed` state (`error` servers leave the probe set unmarked) |
| 57 | MCP tool annotations + context epochs | Missing → **Missing** | Server emits name/description/inputSchema only; the internal `mutating` flag is never emitted as annotations; no context epochs anywhere |
| 58 | Misuse hints ("wrong tool, use X" appended to results) | Missing → Partial | "Did you mean X?" hints fire on unknown/mistyped tool names (runtime + MCP stubs; tested). No semantic wrong-tool guidance on successful-but-wrong calls |
| 59 | Large-result handling: token threshold + spill/truncation | Partial → Partial | Spill-to-disk is real and applies to all tool results (32 KB **byte** threshold) — but the `read_spilled_result` retrieval tool is **never registered**, so spilled content is unrecoverable by the model |
| 60 | External FS / semantic code-search companion servers | Partial → Partial | Native code tools are lexical/syntactic; hybrid search covers memory/skills, not code; no built-in semantic code search |
| 61 | Local project tools: executables in a project tools dir auto-register | Missing → **Present** | `ar/local-tools.ts` (`.kriyadot/tools/`, `@tool` header, `local:<name>`); tested. Caveat: unsandboxed host execution — see #117/#126 |
| 62 | Structured plan tooling owned by the supervisor | Partial → Partial | Supervisor is a verify-gate only; plan state is the human-approved plan gate with no persistent structured plan object and no plan tool |
| 63 | `recall` tool dereferencing archived compression blocks | Missing → **Present** | Lossless archive + `recall_compacted_context`, session-scoped, host-registered; tested |

### E. Guardrails / Approvals (Policy as Code)

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 64 | Repo-local guardrails file, deterministic, no popups | Partial → **Present** | `<workspace>/.kriyadot/policy.json` loaded and merged workspace > bot > global, first-match-wins; allow/deny resolve pre-call with no popup. (JSON at `.kriyadot/`, not TOML at `.agents/` — depth comparable, artifact differs.) Tested |
| 65 | Pre-call guards: deny by capability + argument regex | Partial → **Present** | `PolicyRule.argPattern` compiles a regex against the named argument pre-call, fail-closed; tested |
| 66 | Conditional guards on session history | Missing → Partial | `requiresHistory {toolPattern, minCount}` is enforced with a runtime-maintained session tool history — but history records tool **names only**, so conditions cannot be argument-qualified (`+shell(command=git status)` is not expressible) |
| 67 | Post-result hooks: script failure injects stdout → self-correction | Partial → Partial | HookBus grew to 5 events; `tool.after`/`turn.ending` injections are wired and tested. But `createScriptHookHandler` is registered by **no host/config** — production runs plugin/JS handlers only; script hooks are an embedder API |
| 68 | End-of-turn validators | Missing → **Present** | `ar/validators.ts` auto-runs bot + skill validators at turn end; failures become the next instruction (≤2 attempts); tested end-to-end |
| 69 | Pipe guardrail: pre-model input transform script | Missing → **Present** | `input.transform` hook (plugin-wired); stored message keeps the original text. It is a hook, not a config-declared pipe script |
| 70 | Guardrail scripts snapshotted at session start | Missing → **Missing** | No snapshot mode exists; live evaluation stands (deliberate difference, but the opt-in snapshot option from the build list was not added) |
| 71 | Skill validators auto-run at end of turn (with retries) | Missing → **Present** | `validators:` frontmatter parsed; loaded skills' validators union into the end-of-turn run with the shared 2-attempt bound; tested |
| 72 | Spend-threshold approval contract (interactive y/N; non-interactive stop + exit 75, resumable) | Partial → Partial | Exit-75 leg now satisfied (CLI contract, spend-cap event mapping). Still **no threshold-ask**: the gate is a binary allow/hard-stop, no interactive y/N at a threshold anywhere |
| 73 | Configurable commit attribution for agent commits | Missing → **Present** | `BotConfig.commitAttribution` → tool context → `git_commit` appends it. No dedicated test; settable via bot config only (no API/UI field) |

### F. Memory / Learning

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 74 | Cross-session learning, file-backed as sole authority, project-scoped + role-filtered | Partial → Partial | Authority is still per-bot SQLite; the one file-backed learning store (routing rules) is data-dir-global. No project scoping, no role-filtered retrieval |
| 75 | Two grounded memory types: verbatim-quote user rules + citation-backed experiences, fail-closed verification | Partial → Partial | `storeVerbatimQuote` enforces literal-substring grounding fail-closed and is unit-tested — but has **no production caller**; live distillation never uses it, and there is no distinct two-type model |
| 76 | Orientation memory vs long-lived experience memory as distinct stores | Partial → Partial | L0/L2/L3 tiers + about-me profile; no orientation-store concept |
| 77 | Learning extraction on `/done` + background `distill` pipeline | Partial → Partial | Per-turn distillation + reflection + idle/nightly passes; no `/done` trigger or explicit distill pipeline (see #135) |
| 78 | Active Memory Pack: one token-bounded pack per turn, credit only for material use | Partial → Partial | Recall renders a char-capped "What I remember" block; the only "Memory Pack" in code is the portability export format. No per-turn pack object, no material-use credit |
| 79 | Linked retrieval: stable IDs + `session://` evidence links, one-hop expansion | Partial → Partial | Memory fabric has stable IDs + typed links (relates/contradicts/supersedes), but no `session://` links and recall never traverses links |
| 80 | Hot/cold retention: watermark budgets, verifier-gated merges, archive-after-replace | Partial → Partial | Verifier-gated merges implemented + tested — but **unwired** (all host call sites omit the verifier, so the gate is inert live). No watermark budgets at all; replaced atoms are deactivated in place, not archived |
| 81 | Cold recall by lexical paging over archive catalog; promotion on material use | Missing → **Missing** | No cold memory tier. The compaction archive is a different mechanism (session messages, ID-addressed, whole-recall) |
| 82 | Learning evolution: candidate → verifier → shadow arm → bounded trial → promote only if it beats shadow | Missing → Partial | Real shadow-trial pipeline with the claimed bar (3 trials / 80%) — for **routing rules only**. No independent verifier stage (agreement scoring instead) and trials are unbounded (no window/expiry) |
| 83 | Evolution governance in-session (`/learning evolution approve/reject/rollback`) | Missing → Partial | Promote/rollback exist as API endpoints (`/api/routing/rules/:id/…`); no in-session/CLI commands, no distinct reject, endpoints untested at the API layer |
| 84 | Multi-pass learning synthesis / proposal composition | Missing → **Missing** | Nothing found; closest is a single reflection pass |
| 85 | Standing global rules recognised by learning; scoped pairing vs recurrence similarity | Partial → Partial | Scoped pairing sharpened inside routing-learn (taskType + message-pattern rules); memory-side standing rules are pinned atoms only; nothing outside routing learns scoped rules |
| 86 | Lesson management (`/learning list/show/delete/clear`, provenance metadata, glob filters) | Partial → Partial | Provenance inspector is real and wired (atoms list/show/delete + journal, provenance incl. source/quote) — API only: no `/learning` command set, no clear-all, no glob filters, no outcome provenance; inspector endpoints lack API test coverage |
| 87 | Adaptive external planning memory (plan state preserves critical knowledge across compression) | Partial → Partial | Session knowledge survives folds via summaries + lossless archive, but no explicit plan state is carried across compression as a protected artifact |

### G. Scheduling

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 88 | `schedule` tool + `/schedule`: inject a message as a future user message | Partial → Partial | `schedule_task`/`create_trigger` tools are real, registered, tested — but they create routines that fire in a **fresh `routine_<id>` session**; the creating session's id is dropped and nothing injects into it. No `/schedule` command |
| 89 | Three trigger kinds: clock / idle-triggered / recurring | Partial → **Present** | Idle kind implemented end-to-end (validation, scheduler tick, re-arm on activity, persisted watermark, `lastBotActivityAt` wiring); tested |
| 90 | Persistent schedule storage surviving resume | Present → **Present** | SQLite routine store + persisted watermarks + missed-run reconciliation |
| 91 | `monitor` tool: long-lived event streams, batched rate-limited inbox injection | Partial → Partial | `create_monitor` is an interval routine with an escalation *prompt*; watch-rules cover connected apps. No long-lived stream, no arbitrary command/process monitor, no batching/rate-limit layer |
| 92 | Scheduled tasks / event-driven agents / CI review as first-class patterns | Present → **Present** | Routines, event triggers, workflow webhooks, headless serve |

### H. Channels / Integrations

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 93 | WebSocket server: remote sessions, auth token, origin allowlist | Present → **Present** | Multiple WS hubs, device-token auth, origin allowlist on every upgrade |
| 94 | Resumable WS sessions, session control, request-linked costs | Partial → Partial | Reconnect = fresh hello + snapshot (no resume token, sequence numbers, or replay); run control is REST, not socket; status pushes carry no cost fields |
| 95 | WS transport hardening (heartbeat, bounded resources, dead-client close) | Partial → Partial | 30 s heartbeat + 16 MB frame cap exist and are tested — but heartbeat is broadcast-only: **no dead-client eviction**, and no outbound backpressure |
| 96 | Session commands exposed to WS clients | Partial → Partial | The WS protocol accepts only `hello`/`ping` from clients; all commands ride the HTTP/SSE path instead |
| 97 | ACP agent mode: runs **as** a sub-agent in other stacks/editors | Missing → **Present** | `ar/acp-server.ts` (initialize, session/new, streaming session/prompt, session/cancel, request_permission via governance gateway), exposed via `mvp-server acp`; tested |
| 98 | ACP session semantics as server (load_session, capabilities, cost side-channel) | Missing → Partial | Capabilities are advertised, but `loadSession` is explicitly `false` (no `session/load` handler), no set_mode/set_config, and **no cost side-channel** — usage events are dropped by the forwarder |
| 99 | ACP MCP-server injection by the host into the session | Missing → **Missing** | `session/new` ignores its params entirely; host MCP servers are never parsed, connected, or advertised |
| 100 | Editor integrations via ACP (Zed, JetBrains, Neovim) | Missing → **Missing** | No editor artefact of any kind (no `agent_servers` snippet, docs, or extension); only a "Zed et al." comment |
| 101 | Webhook hooks: config scripts fired by external HTTP events | Partial → Partial | Webhooks still trigger routines/workflows only; the script-hook primitive exists but is unwired (#67), so no webhook can fire a script |
| 102 | Inject listener / `octomind send` into a running daemon session | Partial → Partial | `kriyadot send <name>` + `POST /sessions/:id/steer` exist — but `send` starts a *new* turn via the API; nothing injects into a live running session process by name |
| 103 | Tap registry as distribution channel (GitHub-repo taps, local taps, built-in tap) | Partial → Partial | SkillHub network installs are real (SHA-256-verified, disabled-on-install, tested) — for **skills only**. No tap concept, no GitHub-repo parsing; a repo works only if it serves SkillHub JSON over a raw URL |

**Email channel verification (parent-requested, not an Octomind row):** registered as a messaging provider alongside Telegram/Discord/Slack/WhatsApp (`api/messaging.ts:385`), SMTP send + IMAP poll inbound, loop guard present (own-address mail skipped, fetched mail marked `\Seen`), tests exist. **STARTTLS confirmed absent** — implicit TLS or plain only, as the build stated.

### I. CLI / Daemon / API Surfaces

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 104 | CLI subcommand breadth | Present → **Present** | Broader than before (adds send, sessions, status, completion…). Caveat: `cli/bridge-commands.ts` (federation) is dead code — never dispatched |
| 105 | Interactive REPL session | Present → **Present** | TTY REPL with streaming + inline approvals; tests |
| 106 | Non-interactive piped mode for scripts/CI | Present → **Present** | Stdin message path on both CLIs |
| 107 | JSONL machine-readable event output (`--format jsonl`) | Partial → **Present** | Typed `ChatEvent` stream, one JSON object per line, diagnostics on stderr; tested. Scope: chat/run turns (grouped commands remain text/json) |
| 108 | Structured output enforcement (`--schema`) | Missing → Partial | Native `response_format` in the OpenAI-compatible driver; `--schema` on `mvp-server chat`. Gaps: **no `--schema` on the `kriyadot` CLI**; enforcement is JSON-parse + one retry, never schema validation; Anthropic/Bedrock are prompt-append only |
| 109 | Daemon mode: named session kept alive, work injected later | Partial → Partial | Named sessions are real and heavily tested — as a persisted name → session record. No daemon *process* is kept alive; each run/send is a fresh invocation |
| 110 | Per-run config override (`-c key=value` over any TOML value) | Missing → Partial | `-c` exists with tests — over a **5-key whitelist** (`bot, provider, model, apiUrl, format`), chat/run only. Arbitrary override is rejected by design |
| 111 | Config CLI: generate/show/**validate** (incl. unknown-key warnings) | Partial → Partial | Still get/set/path over two keys; no validate, no generate; unknown keys are silently ignored on load |
| 112 | Shell completions incl. dynamic agent/workflow completion | Missing → **Present** | bash/zsh generators with dynamic bot/routine/session names (baked at generation time, 800 ms API cap, static fallback); tested |
| 113 | Documented exit-code contract (0/1/2/75/130) | Missing → **Present** | `cli/exits.ts` + help text + tests; SIGINT → 130, resumable stop → 75 |
| 114 | ~30 in-session slash commands | Partial → Partial | ≈11 built-ins total across surfaces (seed `/plan /review /work`, chat `/context /reply`, REPL set) + the user-template system. **All** probed Octomind commands are absent as commands: `/share /analyze /copy /done /info /report /usage /status /learning /schedule /compact /new` |
| 115 | Multi-file TOML config merge (alphabetical, deep-merge, migrations) | Partial → Partial | Unchanged: env + single JSON CLI config + per-file JSON overlays. No TOML, no multi-file merge, no migrations |
| 116 | Cross-platform single binary + curl/brew/scoop/cargo/docker installs, checksum-verified | Partial → Partial | Single-binary build scripts (bun compile) + Tauri installers + docker-compose. No curl/brew/scoop/cargo channel; **no published checksums** |

### J. Sandbox / Security

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 117 | OS-level FS sandbox: process + children write-confined to workdir | Partial → Partial | Kernel backends exist but wrap **`run_command` only**, as an opt-in fallback behind E2B/Docker; the no-backend path is an unsandboxed host shell; writable area is a temp dir, not the workspace; file and local tools are never kernel-confined |
| 118 | Landlock backend (Linux) | Missing → **Present** | Embedded C helper compiled on demand (syscalls 444–446, no-new-privs); tests block a `$HOME` write when ABI ≥ 1. Caveat: needs a C compiler at first use; nothing prebuilt ships |
| 119 | Seatbelt backend (macOS) | Missing → Partial | Profile + `sandbox-exec` invocation are code-complete and darwin-gated; only profile-generation tests — execution unverifiable on this Linux VM |
| 120 | Role-based tool permissions: per-role server_refs + allowed_tools wildcards | Present → **Present** | Per-bot tool/server lists + governance regex tool patterns + MCP scopes (equivalent stack, as originally credited) |
| 121 | Auto-bind exact-match rule | Missing → **Present** | `autoBindExact` (case-sensitive, null on zero/duplicate), wired into `mcp_manage bind`; tested. TOFU pinning coexists |
| 122 | Capability domain gating (capability bound to domains) | Partial → Partial | Read/Write/Egress scopes unchanged; egress is a boolean toggle, not a domain allowlist; no domain-bound capability bundles |
| 123 | Environment-gated capabilities (skipped when required env keys missing) | Partial → Partial | Provider-level gating is systematic (fail-closed on missing key); but there is no `requiredEnv` on tools/skills/MCP servers — an installed capability whose key is absent fails at call time instead of being skipped |
| 124 | Privacy-preserving telemetry | Present → **Present** | Off by default, allowlisted events, scalar-only, redaction |
| 125 | Secret hygiene in diagnostics | Present → **Present** | Redaction across telemetry/spans/analytics; vault-backed secrets |
| 126 | Documented local-tool security model | Missing → **Missing** | The feature exists (#61) but no security model is documented anywhere — and the reality is undocumented-risky: host `execFile`, no confinement wrapper, self-declared `mutating`, no `local:` policy rule |

### K. Context / Compression / Token Efficiency

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 127 | Context compression: token-threshold trigger + model-window ceiling | Present → **Present** | Auto-compaction + context-budget warnings. Caveat: the ceiling is a fixed configured budget (default 60 k tokens), not derived from the model's window |
| 128 | Adaptive fire line: fold depth from measured growth rate; amortization gate | Missing → Partial | Fold depth is computed from measured context **size** against the token budget (host-enabled, tested). **No growth-rate computation and no amortization/cost gate** — a code comment claims rate logic the code doesn't perform |
| 129 | Background folds (compression without blocking the task) | Missing → **Present** | Stale summary served immediately, fold completes async; tested. First fold per session is synchronous by design |
| 130 | Separate compression model profile | Partial → **Present** | Summarizer resolves the configurable `compression` purpose profile in both hosts; the old Groq hard-wire is now a documented fallback |
| 131 | Lossless archive + recall of compressed blocks | Partial → **Present** | Verbatim archive before folding + `recall_compacted_context` (see #63). Note: the recall *result* is capped (1 k chars/message, 12 k total) with a truncation notice — a bounded excerpt, not unbounded re-insertion |
| 132 | Knowledge-retention budgets deciding what survives a fold | Partial → Partial | A token budget now drives folds (70% tail allocation, floors/caps) — but survival is recency-only; no per-category retention quotas (decisions/files/tool-results/user turns) |
| 133 | Attention subsystem for keep/drop decisions | Missing → **Missing** | No attention/salience scoring anywhere near compaction |
| 134 | Attention governance with hash verification of retained blocks | Missing → **Missing** | Archive rows carry no hash; corrupted archive JSON is parsed best-effort with no integrity signal |
| 135 | `/done`: forced compression + background learning kickoff | Missing → **Missing** | No `/done` on any surface; `compactNow()` exists as a store method but is not exposed as a command |
| 136 | `/context` inspection of exactly what's in context | Partial → **Present** | `/context` chat command + `GET /sessions/:id/context` (counts by role, token estimates, archives); tested. Web/API only (no CLI), counts/estimates rather than a per-item listing |
| 137 | Prompt-cache awareness: cache accounting + keepalive pings | Partial → Partial | `cache-warm.ts` module is real and tested — but `CacheWarmer` is **instantiated nowhere** and no config field enables it; usage/pricing have **no cache-token fields at all** |
| 138 | Intent-driven context minimisation (load tools/skills on demand) | Partial → Partial | Lazy MCP stubs + progressive skill disclosure + 128-tool fitting. But all resolved tools load every turn (then get stubbed/truncated), and skill auto-activation is opt-in with no seed bot enabling it |
| 139 | Deterministic capability auto-activation (embedding triggers, abstain-on-tie, no LLM) | Missing → Partial | `decideAutoActivation` is pure/deterministic with threshold + margin + tie-abstention, wired per message — over the **skill catalog only**; MCP servers/capabilities are never auto-activated this way |
| 140 | LRU eviction of active capabilities (soft cap, refcount-aware) | Missing → **Missing** | No persistent active-capability set exists to evict from; MCP connections persist uncapped |
| 141 | Fast decision seam: cheap-model toggles for routine routing decisions | Partial → Partial | The purpose-profile seam is now consumed by summarizer/reviewer/supervisor/evaluate/extraction/main — but `routing` and `triage` purposes are **dead config** (no consumers; the router is deterministic, triage uses its own seam) |
| 142 | Token counting, message dedup, smart summarizer utilities | Present → **Present** | Context meter, estimators, dedupe, profile-routed summarizer with extractive fallback |

**Delegate modelProfiles check (parent-requested):** confirmed as a real limit. The `delegate`-tool spawn path builds a child runtime without the host's model-profile table and without session-store options — children run effectively single-model (the target bot's model) with env-only aux-profile fallback, and child sessions get no summarizer at all. Background runs (which execute inside the parent runtime) do inherit. This caps rows #3/#17 in the delegation path specifically.

### L. Workflows

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 143 | TOML-defined workflows; per-step role/model/toolset/skills | Partial → Partial | A versioned file format exists (`kriyadot.workflow` v1, round-trip + validation, tested) but is **JSON, not TOML**, is **wired to no import/export surface** (only n8n conversion + seed loading), and per-step role/model/toolset/skills are **not expressible** — agent nodes read only `config.botId` + `config.prompt` |
| 144 | Sequential steps + variable substitution | Present → **Present** | `renderTemplate` (`{{input}}`, `{{nodes.<id>.output…}}`, `{{item}}/{{index}}`); topological levels; tested |
| 145 | Parallel blocks with `max_parallel` cap | Present → **Partial** ⬇ | **Downgraded.** Levels run in parallel but level width is **uncapped**; a cap exists only inside `match` nodes. The original audit credited Fusion's worker cap, not a workflow-level cap |
| 146 | Dynamic fan-out (`match` over runtime data) | Partial → **Present** | First-class `match` node (source path, per-item body, `maxParallel` default 4, ordered results); tested |
| 147 | Loop blocks (generator/evaluator until accepted) | Partial → **Present** | First-class `loop` node (body + evaluator, `maxIterations`, accept path, `if`-node evaluator); tested |
| 148 | Conditional blocks | Present → **Present** | `if` node + branch-labelled edges; tested |
| 149 | Graph routing (non-linear step graphs) | Present → **Present** | Validated DAG, topological levels, cycle rejection |
| 150 | Workflow cost budget + per-step retries/timeouts | Partial → Partial | Per-workflow budget + per-step retry/timeout are real and tested — **but agent/bot-turn nodes report $0 cost** (runner holds no price table), so the budget cannot cap LLM spend |
| 151 | Workflow dry-run / validate (print plan, spawn nothing) | Partial → Partial | `dryRun()` + plan builder exist and are tested — as a **library only**; no endpoint/CLI/UI exposes a workflow dry-run |
| 152 | Workflow observability: per-step + aggregated cost events (JSONL) | Partial → Partial | Per-step `costUsd` on node states + telemetry + SSE run stream — but **no JSONL** event stream/export anywhere, and per-step cost is usually $0 in practice (#150) |
| 153 | Tap-distributed workflows (installable like agents) | Partial → Partial | Marketplace installs workflows from the local registry; SkillHub network installs cover skills only; no remote/tap distribution for workflows |
| 154 | Shipped workflow templates (sequential/fan-out/graph/research) | Partial → **Present** | `wf/templates.ts` ships exactly those four shapes; tests parse, dry-run, and execute them end-to-end (+5 seed workflows). Caveat: templates use built-in nodes only, no agent steps |

### M. Skills / Roles / Specialists

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 155 | Specialists: packaged agent run by `category:variant` name | Partial → Partial | Bundles are real (bot payload incl. skills/tools/MCP; one-unit bundle install; tested). No `category:variant` naming, no run-by-package-name, and bundle MCP entries are **skipped, never installed** |
| 156 | First-use specialist bootstrap (fetch manifest, install deps, resolve credentials, start servers) | Partial → Partial | `bootstrapFirstRun` installs a getting-started bundle once, via an endpoint (not at startup). No dependency install, no credential resolution, no MCP server startup |
| 157 | Tap authoring: `tap init` scaffolds/validates/registers | Missing → Partial | `scaffoldSkill()` writes a single skill file via API (slug-safe, tested). No `tap init` CLI, no package scaffold, no validate/register step |
| 158 | Manifest placeholders + per-capability/model overrides from user config | Partial → Partial | `requiredEnv` placeholders are written as nulls; model overrides exist elsewhere in the system. No placeholder substitution into manifests, no per-capability override layer |
| 159 | Manifest caching with configurable freshness | Missing → Partial | Registry caching exists (mtime/size change detection, tested). **No configurable freshness** — no TTL/max-age anywhere |
| 160 | Roles: local definitions with prompt + model + permissions; shipped defaults | Present → **Present** | Seed bots + 155-profile library + 16 personas. Caveat: subagent profiles carry prompt+tools only (model/permissions live on BotConfig) |
| 161 | Mid-session role switching (`/role`) | Partial → Partial | Persona is editable per bot and per-turn overrides exist — but no `/role`-style switch on a live session on any surface |
| 162 | Skills as packs (SKILL.md + scripts/ + references/ + assets/ + resource catalog) | Partial → Partial | Directory packs load (`<name>/SKILL.md` + resource enumeration; tested) — but there is **no resource catalog**, the enumeration is surfaced through no tool/API/UI, and **no pack ships** (all 33 seed skills are single files) |
| 163 | Declarative skill auto-activation rules (frontmatter logic per user message) | Missing → Partial | Embedding-based half exists (#139). The **frontmatter-rules half is absent** — frontmatter carries only name/description/validators |
| 164 | Manual/env skill control (`/skill`, skill tool, env force-load) | Partial → Partial | API skill-store (enable/disable/attach) + `read_skill` exist. No `/skill` command; no env force-load |
| 165 | Capabilities: named TOML bundles of servers + tool filters, tap-distributed | Partial → Partial | Nearest units are marketplace bundles + per-bot MCP sets; the discovery `capability` kind is never produced. No named distributable capability-bundle entity with tool filters |
| 166 | Semantic discovery of capabilities/skills (embedding intent search) | Missing → Partial | `discoverByIntent` + a real neural embedder (opt-in; trigram fallback by default) — but the only consumer ranks skills for auto-activation; no intent-search tool/API/UI over bots, capabilities, or MCP |
| 167 | Language/domain skills auto-activate inside a generalist specialist | Missing → Partial | The #163 mechanism does this inside any bot with the flag on — but it is opt-in, off by default, no seed bot enables it, and there is no specialist-scoped rule |
| 168 | Shipped example specialist config in-repo | Present → **Present** | Seed bots, registry examples, plugin demo skill |

### N. Sharing / Collaboration

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 169 | Session sharing: `/share` → permanent public link to the full session log | Missing → **Present** | `api/session-share.ts`: share publishes a sanitized transcript via public-pages at `/p/<slug>`; export (md/JSON) endpoint; web Share button; routes mounted; tested |
| 170 | `/analyze`: local session viewer via loopback bridge, nothing uploaded | Partial → Partial | No `/analyze`; the Activity UI + `/context` inspector serve the purpose locally, in a different form |
| 171 | Specialist sharing as the primary collaboration unit (publish a manifest) | Partial → Partial | Deepened: expert publishing (published-bots) + org library + checksummed team manifests — but all deployment-local/org-scoped; no portable manifest installable from a network registry |
| 172 | Clipboard export of conversation (`/copy last/assistant/user/all`) | Missing → Partial | Per-message Copy buttons exist in web chat (any single message). No `/copy` command and no segment selectors (last/all-assistant/all-user/whole-conversation) |
| 173 | Multi-process collaboration on one live session | Partial → Partial | Per-session writes are serialized (queue/scheduler); federation is instance-to-instance with per-peer sessions. Two writers still cannot co-drive one live session |

### O. Observability / Cost

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 174 | Per-session spend thresholds enforced, incl. before spawning children | Present → **Present** | Pre-call gate factory covers chat/rooms/routines/fusion/children; fail-closed with in-flight reservations |
| 175 | `/info`: session tokens/cost/cache/compression in one view | Partial → Partial | `/context` now covers tokens/compression in-session and the Usage page covers cost — but no single view combines tokens + cost + cache + compression; no `/info` command |
| 176 | `/report`: per-request usage breakdown | Partial → Partial | Breakdown API (by feature and step) + full ledger + CSV export on the Usage page; no in-session `/report` command |
| 177 | `/usage` + account balance in-session | Partial → Partial | Usage page exists; no in-session `/usage` command and **no account-balance concept** (self-hosted BYOK) |
| 178 | `/status`: live tap/agent runs, monitors, background/shell jobs | Partial → Partial | Background runs are now exposed via API + Activity panels — but runs/monitors/jobs remain scattered across tabs/endpoints; no unified `/status` surface or command |
| 179 | Cost side-channels on ACP / WebSocket / workflow surfaces | Partial → Partial | Chat usage events + workflow per-step cost fields exist — but the ACP server carries **no cost at all** and workflow per-step cost is $0 for agent nodes (#150) |
| 180 | Supervisor statistics accumulator across concurrent sessions | Partial → Partial | Spans aggregate errors/retries and decisions are logged — but `supervisor.ts` has **no statistics** (no gates-fired/rejections/steers totals anywhere) |
| 181 | Structured logging with runtime log-level control | Partial → Partial | Structured records exist — but there is **no log-level control at all** (grep across runtime/API/CLI: nothing, not even an env var) |
| 182 | Telemetry pipeline explicitly separated from local stats and session records | Present → **Present** | Separate metadata-only telemetry pipeline + separate Langfuse exporter and analytics channels |
| 183 | Published benchmark results (octobench: 24/25 real-PR tasks) | Missing → **Missing** | `BENCHMARK.md` publishes harness micro-benchmarks only and explicitly disclaims model/task quality; no real task suite is run or published |

### P. Misc (runtime)

| # | Octomind feature | 29 Oct → 30 Oct | KriyaDot evidence / limitation |
| --- | --- | --- | --- |
| 184 | Edit mode: file ranges + hashed line identifiers for exact edits | Partial → Partial | `patch` (line-verified diff) + `edit` (exact-string) exist; **no hashed line identifiers**, no range parameter on `edit` |
| 185 | Assistant-output hygiene (internal metadata filtered, invented reminders stripped) | Partial → Partial | Adjacent machinery (provenance wrapping, untrusted tags) only; no hygiene pass over assistant text |
| 186 | Terminal rendering: thinking/tool display, syntax highlight, markdown links | Partial → Partial | TUI renders typed lines for tool calls/approvals; no syntax highlighting or markdown links in the terminal; no distinct thinking display |
| 187 | Interactive terminal polish (reedline input, animations, job managers) | Partial → Partial | REPL is Node readline; no reedline-style editor, no animations/spinners, no terminal job manager |
| 188 | Tool-error tracking: repeated errors change behaviour | Partial → Partial | Progress guard reacts to repetition; error counts exist in spans/telemetry — as observability only, not a per-tool behaviour input |
| 189 | Extensive environment-variable surface (100+ documented vars) | Present → **Present** | 128 distinct env vars referenced in source. Caveat: `.env.example` documents only 13 |
| 190 | Recorded end-to-end demo example shipped in-repo | Missing → Partial | `examples/fix-a-bug/` ships a real planted-bug demo kit with a 5-step script — but it is a **live-demo kit, not a recording**: no transcript or captured run output ships with it |
| 191 | Meta-skill for driving Octomind itself from other agents | Missing → **Missing** | The shipped `self-driving.md` seed teaches KriyaDot's own bot an internal loop; no skill teaches an external agent to drive KriyaDot via API/CLI/MCP |

---

## Octomind Cloud — re-scored as it stands

The original audit excluded the hosted-cloud rows under the user's standing order. Per this re-audit's brief they are scored as they stand; the Lightning AI cloud layer is **not built yet** and belongs to the next build. Verdicts: Present-equivalent / Partial / Missing-Excluded (hosted capability, no self-hosted equivalent attempted).

| Cloud feature (vendor-claimed) | KriyaDot position (2026-10-30) |
| --- | --- |
| Octos: 10/30 named agents, own folder/memory/routines, auto-created from first job | **Partial** — local bots have own workspace/memory/routines and 12+ ship in seed; no hosted octos and no auto-creation from a first job |
| Cloud machines (sizes, sleep-when-idle, wake on message, cold archive) | **Missing-Excluded** — self-hosted only; user VPS profiles are not managed machines |
| Hands on the machine: browser shell sudo+Docker, custom images, live URLs | **Missing-Excluded** — local computer-use operates the user's own machine; no hosted equivalent |
| The Hub: one login, all models at provider price, prepaid credits | **Missing-Excluded** — BYOK with vault-stored keys; local metering + spend caps only |
| Specialist auto-routing by cloud orchestrator with visible byline | **Partial** — local routing/chief delegation + profiles exist; web chat stamps the answering bot's name (a byline equivalent); no hosted-crew auto-routing |
| Channels bound to octos; `/octos` + `/use` switching | **Partial** — channels are local and per-bot configured; no in-channel `/octos`/`/use` switching |
| Routines on the cloud | **Present-equivalent** — routines are fully local (cron/interval/webhook/event/idle/startup) |
| Developer API (POST /octos, octo_id sessions, OpenAPI, plan rate limits) | **Partial** — a local developer API with OpenAPI docs exists; no octo-style public API or plan-based rate limits |
| Metered add-ons (voice $/min, media generation, web search $/1k, browser) | **Partial** — voice (TTS breadth now real) and web search exist locally, unmetered. **Media generation is still Missing**: the only provider is a mock (1×1 fixture PNG, `mock://` URLs) whose resolver "always returns the mock" pending founder credentials |
| Plans (Free/Pro/Max/Team, pooled billing) | **Missing-Excluded** — billing is local cost tracking + caps |
| Octo presence UX (status marks, colours, crew-tile home) | **Partial** — web has its own bot roster/tiles and chat bylines; no octo presence surface |
| `/share` hosting at octomind.run/r/<id> + hosted viewer | **Missing-Excluded** — hosting itself excluded; the share *capability* is now **Present** at #169 via self-hosted `/p/<slug>` links |

Cloud blockers for the closure build: the Lightning AI layer is undesigned-in-code (no code exists), public shipping is gated on confirming Lightning's ToS position on the credential-delegation pattern, and media generation is gated on provider/founder credentials.

---

## Closure list — every remaining Partial and Missing row

129 rows: 115 Partial + 14 Missing. Sizes: **S** ≈ a day or less of focused work, **M** ≈ several days / multi-file feature, **L** ≈ a week-plus or architectural. Tally: **S 47 · M 75 · L 7**. Blockers/dependencies noted where they exist; unmarked rows have none beyond engineering time.

### A. Providers / Models (6)
- **#2** (Partial) — Unified gateway login (device-code flow) + single shared balance across providers. Area: `cli/` login, `ar/providers/cli-bridge.ts`. **L**. Blocker: product decision — a hosted gateway conflicts with the local-first/BYOK stance; the Lightning-layer design in the next build is the natural home for any decision here.
- **#4** (Partial) — 30+ first-class providers: add the remaining presets and provider-specific drivers beyond Vertex/Bedrock (today's breadth beyond those two is shared-driver presets). Area: `ar/providers/catalog.json`, `ar/providers/`. **M**.
- **#8** (Partial) — Forward the full per-purpose knob set (temperature/topP/maxTokens/reasoningEffort) to reviewer/supervisor/evaluate/summarizer drivers; today they resolve model id only (supervisor hard-codes temperature 0). Area: `ar/reviewer.ts`, `ar/supervisor.ts`, `ar/evaluate.ts`, `api/summarizer.ts`. **S**.
- **#11** (Partial) — Honor per-profile retry/timeout in the Anthropic driver (ignores `maxRetries`), the Bedrock driver (neither), and all aux purposes. Area: `ar/providers/anthropic.ts`, `ar/providers/bedrock.ts`, aux call sites. **S**.
- **#12** (Partial) — `.env` chain support (config `.env` → project `.env`) or a documented deliberate-difference note in user docs; today there is no `.env` loading at all. Area: `ar/providers/catalog.ts:resolveApiKey`, docs. **S**.
- **#13** (Partial) — A bundled local neural embedding model (ONNX) or making the neural embedder the default; today neural is opt-in and the trigram hash is the default + fallback. Area: `ar/embeddings.ts`, `ar/hybrid-search.ts`, packaging. **M**.

### B. Multi-Agent / Orchestration (10)
- **#14** (Partial) — Background-run `resume` operation and injection into a live in-progress turn (today: next-turn injection only). Area: `ar/background-runs.ts`, `ar/tools/background.ts`, `ar/runtime.ts`. **M**.
- **#15** (Partial) — Wire intent discovery for bots/roles (a `tap discover`-style tool; delegation and bot-team selection use the ranker). Today production wiring feeds it skills only. Area: `ar/discovery.ts`, `ar/runtime.ts`, `ar/tools/bot-team.ts`. **M**.
- **#17** (Partial) — Async ACP agents (results injected on completion) + a concurrency cap on ACP and background spawns. Area: `ar/acp.ts`, `ar/acp-sessions.ts`, `ar/background-runs.ts`. **M**.
- **#18** (Partial) — Ephemeral-agent lifecycle: named registration with add/enable/disable/remove and re-invocation by name (today: one-shot spawns). Area: `ar/tools/background.ts`, `ar/runtime.ts`, `ar/subagent-profiles.ts`. **M**.
- **#19** (Partial) — Per-session dynamic-tool registry (session-owned tools invisible to other sessions). Area: `ar/runtime.ts` tool resolution. **M**.
- **#20** (Partial) — A standing supervisor that plans and steers the whole run (today: final-answer gate only). Area: `ar/supervisor.ts`, `ar/runtime.ts`. **L**.
- **#23** (Partial) — Independent supervisor authorizer for tool calls operating outside/alongside approval modes (reviewer today runs only inside auto-approve). Area: `ar/reviewer.ts`, `ar/supervisor.ts`, runtime tool loop. **M**.
- **#24** (Partial) — Supervisor-state condensation at a token threshold (requires supervisor state to exist — depends on #20). Area: `ar/supervisor.ts`. **M**.
- **#26** (Partial) — Supervisor-owned steer/delegate/resolve primitives (today scattered across SteerQueue, delegate tools, chief/group-goals). Area: `ar/supervisor.ts`. **M**.
- **#28** (Partial) — Wire `evaluateQuestion` into the verify-gate, end-of-turn validators, and routing, with probability thresholding (today: recite is the only caller). Area: `ar/supervisor.ts`, `ar/validators.ts`, `ar/routing.ts`. **S**.

### C. Sessions & Layers (12)
- **#31** (Partial) — Markdown rendering in the terminal surfaces (CLI REPL + TUI). Area: `cli/repl.ts`, `apps/tui/`. **M**.
- **#32** (Partial) — One naming system: server-side session names shared by CLI and web, plus most-recent/`--continue` resume. Area: `ar/sessions.ts`, `cli/config.ts`, `api/chat-threads-routes.ts`. **M**.
- **#34** (Partial) — Capture, store, and replay provider-native output items (reasoning items etc.) across resume. Area: `ar/sessions.ts`, `ar/types.ts`, provider drivers. **M**.
- **#35** (Partial) — Point-by-point `/reply` quoting, a web UI affordance, and CLI REPL support (today: whole-message, API-typed only, CLI rejects it). Area: `api/session-craft.ts`, `web/`, `cli/repl.ts`. **M**.
- **#37** (Missing) — Answer-part-of-a-reply: select a fragment of a reply and respond to just that fragment. Area: `web/` chat + `api/` chat route. **M**.
- **#38** (Partial) — Native multimodal turns: image content parts sent to vision-capable providers (today OCR-text only) and video attachment handling; wire or remove the dead vision-routing code. Area: `api/routes.ts`, `api/vision-pipeline.ts`, `ar/types.ts`. **M**.
- **#40** (Partial) — System template-variable set (`{{CWD}}`, `{{ROLE}}`, `{{GIT_TREE}}`, …) + a `vars` inspector surface. Area: `ar/` prompt assembly, `cli/`, `api/`. **S**.
- **#41** (Partial) — Layer depth: output modes per stage, stage kinds beyond prepare/review, a role/profile per stage, and an API/web configuration surface. Area: `ar/types.ts` (`BotConfig.layers`), `ar/runtime.ts`, `api/`, `web/`. **M**.
- **#42** (Partial) — Slash commands that execute: `/run <name>` running a workflow/layer, and a shipped `reduce` command. Area: `api/slash-commands.ts`, `api/routes.ts`, seed. **M**.
- **#44** (Partial) — A unified per-session inbox converging background completions, schedules, monitors, and hooks; persist the background registry across restarts. Area: `ar/background-runs.ts`, `api/` inbox surfaces. **M**.
- **#46** (Partial) — Session-level standing rules a user/agent can set in-session and carry across sessions. Area: `ar/sessions.ts`, `api/`. **S**.
- **#47** (Partial) — Per-session human time/energy accounting (today global/by-bot approvals only), a dedicated test, and a web surface. Area: `api/human-accounting.ts`, `web/`. **S**.

### D. Tools & MCP (13)
- **#48** (Partial) — MCP as the core-tool substrate. Area: `ar/tools/`, `ar/mcp-server.ts`, runtime. **L**. Note: architectural deliberate shape; closing means re-platforming core tool execution onto MCP — recommend an explicit user decision before scheduling.
- **#50** (Partial) — CIMD (client ID metadata documents) support in MCP OAuth. Area: `ar/mcp-oauth.ts`. **S**.
- **#51** (Partial) — Per-surface elicitation routing: terminal/CLI, WS-owner, and ACP routes (today: chat-widget route only; headless declines). Area: `ar/mcp.ts`, `cli/`, `api/` WS + ACP server. **M**.
- **#52** (Partial) — Split the single builtin MCP server into the five-server suite (core/orchestration/runtime/agent/local). Area: `ar/mcp-server.ts`. **M**.
- **#53** (Partial) — `mcp_manage` add/install, remove/uninstall, and persist-new-server actions mid-session. Area: `api/mcp-manage-tool.ts`, `ar/mcp-directory.ts`. **S**.
- **#54** (Partial) — Layered MCP override files (`mcp-<name>` files that auto-bind and win over base config). Area: `ar/mcp-directory.ts`, config loading. **M**.
- **#55** (Partial) — Per-server tool allow/deny filtering with wildcard patterns. Area: `ar/mcp-scopes.ts`. **S**.
- **#56** (Partial) — Spec-exact health loop: 120 s interval + a terminal `Failed` state for servers whose restart fails. Area: `ar/mcp-directory.ts` (`LazyMcpManager`). **S**.
- **#57** (Missing) — Emit MCP tool annotations (readOnly/destructive hints from the internal `mutating` flag) and implement context epochs. Area: `ar/mcp-server.ts`, `ar/mcp.ts`. **M**.
- **#58** (Partial) — Semantic misuse hints: right-task/wrong-tool guidance on successful-but-wrong calls (today: name-typo hints only). Area: `ar/tool-hints.ts`, runtime tool loop. **M**.
- **#59** (Partial) — Register `read_spilled_result` (defined, never wired) and make the spill threshold token-based. Area: `ar/runtime.ts` (`createSpillTools`), `api/index.ts` tool registration, `ar/tool-spill.ts`. **S**. Highest value-per-effort item in this list: the model is currently directed to a tool it does not have.
- **#60** (Partial) — Built-in semantic code search. Area: `ar/tools/coding.ts`, `ar/hybrid-search.ts` (embeddings dependency: #13 improves quality). **M**.
- **#62** (Partial) — Supervisor-owned persistent structured plan tooling/state. Area: `ar/supervisor.ts`, `ar/approval-modes.ts`. **M**. Depends on #20's direction.

### E. Guardrails / Approvals (4)
- **#66** (Partial) — Argument-qualified history conditions: record tool name **and** argument digest in session history so `requiresHistory` can express "tool X ran with these arguments." Area: `ar/runtime.ts` history seeding, `gov/gateway.ts`. **S**.
- **#67** (Partial) — Register script hooks: a config/plugin path that installs `createScriptHookHandler` (today zero call sites), plus tests. Area: `ar/hooks.ts`, `api/plugin-routes.ts`, bot/workspace config. **S**.
- **#70** (Missing) — Opt-in policy snapshot at session start (snapshot rules/scripts at session open instead of live evaluation). Area: `gov/policy-file.ts`, `api/governance-adapter.ts`. **S**. Note: live evaluation is a deliberate difference; the closure item is the *option*, defaults unchanged.
- **#72** (Partial) — Threshold-ask contract: interactive y/N when a turn crosses a spend threshold (the exit-75 leg is done). Area: `packages/billing/`, CLI + web approval surfaces. **M**.

### F. Memory / Learning (14)
- **#74** (Partial) — Project scoping + role-filtered retrieval for learned memory (authority/file questions are the deeper half). Area: `ar/memory.ts`. **M**.
- **#75** (Partial) — Call `storeVerbatimQuote` from the live distiller/keeper so user rules are stored grounded, and model the two grounded types (user rules vs experiences) distinctly. Area: `ar/memory.ts` distiller paths. **M**. Mechanism exists and is tested; this is wiring + typing.
- **#76** (Partial) — An orientation store distinct from long-lived experience memory. Area: `ar/memory.ts`. **M**.
- **#77** (Partial) — A `/done`-triggered (or explicit) distill pipeline. Area: `api/slash-commands.ts`, memory upkeep. **S**. Pairs with #135.
- **#78** (Partial) — A materialized per-turn memory pack object with an explicit token budget + material-use credit tracking. Area: `ar/memory.ts` recall paths, `ar/runtime.ts`. **M**.
- **#79** (Partial) — `session://` evidence links from atoms to session evidence + one-hop link expansion during recall. Area: `ar/memory.ts` fabric + recall. **M**.
- **#80** (Partial) — Wire `mergeVerifier` at all three host call sites (gate exists, inert live), add watermark budgets, and archive-after-replace. Area: `api/memory-upkeep-routes.ts`, `ar/memory-upkeep.ts`. **M** (the wiring half alone is S).
- **#81** (Missing) — A cold memory tier: archive catalog with paged lexical recall + promotion on material use. Area: `ar/memory.ts`, upkeep. **L**.
- **#82** (Partial) — Extend shadow-trial evolution beyond routing rules (memory/lessons), add an independent verifier stage, and bound the trial window. Area: `ar/routing-learn.ts`, `ar/memory-upkeep.ts`. **M**.
- **#83** (Partial) — In-session `/learning evolution` approve/reject/rollback commands (today API-only) + a distinct reject + API-level tests. Area: `cli/`, `api/routing-learn-routes.ts`, slash commands. **S**.
- **#84** (Missing) — Multi-pass learning synthesis / proposal composition over learned material. Area: `ar/memory.ts` reflection pipeline. **L**.
- **#85** (Partial) — Standing-global-rule recognition in memory learning (today routing-only) and scoped rule learning outside routing. Area: `ar/memory.ts`, `ar/routing-learn.ts`. **M**.
- **#86** (Partial) — `/learning` command set (list/show/delete/clear) on CLI/chat, glob filters, clear-all, outcome provenance, and API tests for the inspector. Area: `api/memory-upkeep-routes.ts`, `cli/`. **S**.
- **#87** (Partial) — Carry explicit plan state across compression folds as a protected artifact. Area: `ar/sessions.ts` compaction, plan state (#62). **M**.

### G. Scheduling (2)
- **#88** (Partial) — Originating-session semantics for in-session scheduling: pass `ctx.sessionId` through, and fire as a user message injected into that session (today a fresh `routine_<id>` session). Plus a `/schedule` command surface. Area: `api/schedule-tools.ts`, `api/trigger-tools.ts`, `api/routine-schedules.ts`. **M**.
- **#91** (Partial) — A generic monitor tool: long-lived event streams (commands/processes/feeds) with batched, rate-limited inbox injection. Area: `api/schedule-tools.ts`, `api/watch-*`. **M**.

### H. Channels / Integrations (9)
- **#94** (Partial) — Resumable WS sessions: resume token, sequence numbers, missed-event replay; request-linked costs on the WS surface. Area: `api/companion.ts` + sibling hubs. **M**.
- **#95** (Partial) — Dead-client eviction (pong-timeout/last-seen reaping) + outbound backpressure checks. Area: WS hubs (`api/companion.ts`, `phone.ts`, `computer-view.ts`, `remote-screen.ts`). **S**.
- **#96** (Partial) — Session commands over the WS protocol (prompt/cancel/model/slash), not just `hello`/`ping`. Area: `api/companion.ts`. **M**.
- **#98** (Partial) — ACP server completeness: `session/load` support + a cost/usage side-channel (stop dropping usage events). Area: `ar/acp-server.ts`. **M**.
- **#99** (Missing) — ACP host MCP-server injection: parse `mcpServers` from `session/new`, connect them into the session, advertise the capability. Area: `ar/acp-server.ts`. **M**.
- **#100** (Missing) — Editor integration artefacts: a Zed `agent_servers` snippet + JetBrains/Neovim setup docs for the (working) ACP server. Area: `docs/`, `examples/`. **S**.
- **#101** (Partial) — Webhook → script firing (a webhook route that runs a configured script hook). Depends on #67's registration path. Area: `api/webhooks.ts`, `api/routine-hooks.ts`. **S**.
- **#102** (Partial) — A true inject listener: deliver a message into a live, already-running named session process (today `send` starts a new turn). Area: `cli/`, `api/` daemon surface. **M**.
- **#103** (Partial) — Tap distribution: GitHub-repo and local taps as named channels (today SkillHub covers skills via index/package URLs only). Area: `api/skillhub.ts`, `packages/marketplace/`. **M**.

### I. CLI / Daemon / API Surfaces (7)
- **#108** (Partial) — `--schema` on the `kriyadot` CLI; real JSON-Schema validation of the final reply (today parse-only + one retry); native `response_format` for Anthropic/Bedrock drivers. Area: `cli/`, `ar/runtime.ts`, `ar/providers/anthropic.ts`, `ar/providers/bedrock.ts`. **M**.
- **#109** (Partial) — A kept-alive named daemon process that work can be injected into (today: persisted name → session record). Area: `cli/`, `api/`. **M**. Pairs with #102.
- **#110** (Partial) — Arbitrary `-c key=value` overrides beyond the 5-key whitelist. Area: `cli/overrides.ts`. **S**.
- **#111** (Partial) — `config validate` with unknown-key warnings + a generate/init command. Area: `cli/commands.ts`, `cli/config.ts`. **S**.
- **#114** (Partial) — The missing in-session command set (~19 commands: `/share /analyze /copy /done /info /report /usage /status /learning /schedule /compact /new` …) on web + CLI. Several depend on other closure items (#135, #169 ✓, #172, #175–#178, #83). Area: `api/session-craft.ts`, `api/routes.ts`, `cli/repl.ts`, `web/`. **M**.
- **#115** (Partial) — Multi-file config: TOML support, alphabetical deep-merge, migrations. Area: `api/config.ts`, `cli/config.ts`, bot-settings overlays. **M**.
- **#116** (Partial) — Distribution channels: curl installer, Homebrew/Scoop manifests, and published checksums for release artifacts. Area: `scripts/`, `.github/workflows/release.yml`. **M**.

### J. Sandbox / Security (5)
- **#117** (Partial) — Kernel confinement as the default for local `run_command` (not an opt-in fallback), the bot workspace as the writable root, and confinement coverage for local tools. Area: `ar/tools/sandbox.ts`, `ar/tools/builtin.ts`, `ar/local-tools.ts`. **M**.
- **#119** (Partial) — Seatbelt execution verification + profile parity with Landlock's read paths. Implemented; the gap is proof. Area: `ar/tools/sandbox-kernel.ts`, CI. **S**. **Blocker: requires a macOS runner/machine** — cannot be closed from this Linux VM.
- **#122** (Partial) — Domain-bound capabilities: bind a capability to an allowed domain set (egress as an allowlist, not a boolean). Area: `ar/mcp-scopes.ts`, `gov/`. **M**.
- **#123** (Partial) — Systematic capability env gating: `requiredEnv` on tools/skills/MCP servers, skipped (not call-time-failed) when keys are missing. Area: `ar/types.ts`, `ar/skills.ts`, `ar/mcp-directory.ts`. **S**.
- **#126** (Missing) — Document the local-tool security model (confinement, trust, approval treatment) + add a `local:` rule to the default policy so the documented model is real. Area: `docs/`, `gov/default-policy.ts`, `ar/local-tools.ts`. **S**.

### K. Context / Compression / Token Efficiency (10)
- **#128** (Partial) — True growth-rate-adaptive fold depth + an amortization gate (fold only when summarizer cost < tokens saved); fix the misleading code comment either way. Area: `ar/sessions.ts:planCompaction`. **M**.
- **#132** (Partial) — Per-category knowledge-retention budgets (decisions/files/tool-results/user turns) deciding fold survival, replacing recency-only. Area: `ar/sessions.ts`, summarizer. **M**.
- **#133** (Missing) — An attention/salience subsystem feeding keep/drop decisions in folds. Area: `ar/sessions.ts`, new module. **L**.
- **#134** (Missing) — Hash verification of archived/retained blocks (hash column + verify on read). Area: `ar/sessions.ts` (`compaction_archive`). **S**.
- **#135** (Missing) — A `/done` command: forced compression + background learning kickoff, exposed on web/CLI (building blocks exist: `compactNow()`, hindsight). Area: `api/session-craft.ts`, `cli/`, slash commands. **S**. Pairs with #77.
- **#137** (Partial) — Instantiate `CacheWarmer` behind a per-bot/host config field + add cache-read/write token fields to usage accounting and pricing. Area: `ar/cache-warm.ts`, `api/index.ts`, `ar/usage.ts`, `ar/pricing.ts`. **S**.
- **#138** (Partial) — Intent-driven tool loading (select the turn's tool set by intent instead of loading all + truncating). Area: `ar/runtime.ts`, `ar/tool-fitting.ts`, `ar/discovery.ts`. **M**.
- **#139** (Partial) — Extend deterministic auto-activation beyond skills to MCP servers/capabilities. Area: `ar/discovery.ts`, `ar/runtime.ts`, `ar/mcp-directory.ts`. **M**.
- **#140** (Missing) — A persistent active-capability set with a soft cap and LRU/refcount eviction. Area: `ar/mcp-directory.ts`, runtime activation state. **M**.
- **#141** (Partial) — Resolve the dead config: route `routing`/`triage` decisions through the purpose-profile table, or remove the unused purposes. Area: `ar/model-profiles.ts`, `ar/message-router.ts`, `api/notification-triage.ts`. **S**.

### L. Workflows (6)
- **#143** (Partial) — Wire the workflow file format to real import/export endpoints/CLI/UI; express per-step role/model/toolset/skills in node config; TOML variant if parity is literal. Area: `wf/format.ts`, `wf/runner.ts`, `api/`, `web/`. **M**.
- **#145** (Partial) — A `max_parallel` cap on parallel blocks/levels (today only inside `match`). Area: `wf/runner.ts`, `wf/types.ts`. **S**.
- **#150** (Partial) — Price agent/bot-turn node usage (give the runner a price table) so node costs are real and workflow budgets can cap LLM spend. Area: `wf/cost.ts`, `wf/runner.ts`, `ar/pricing.ts`. **M**. Also unblocks honest numbers for #152/#179. (Parent-flagged limit, verified real.)
- **#151** (Partial) — A user-facing workflow dry-run (endpoint + CLI/UI) over the existing `dryRun()` library. Area: `api/`, `cli/`, `web/` workflows page. **S**.
- **#152** (Partial) — Workflow JSONL observability: per-step + aggregated cost events as a stream/export. Depends on #150 for meaningful costs. Area: `wf/`, `api/` workflow routes, run-health. **M**.
- **#153** (Partial) — Network/tap distribution for workflows (SkillHub-style), not just the local registry. Area: `api/skillhub.ts`, `packages/marketplace/`. **M**. Pairs with #103.

### M. Skills / Roles / Specialists (12)
- **#155** (Partial) — `category:variant` specialist naming + run-by-package-name; install bundle MCP entries instead of skipping them. Area: `mkt/bundles.ts`, `mkt/installer.ts`, `cli/`. **M**.
- **#156** (Partial) — Real first-use bootstrap: dependency install, credential resolution, MCP server startup; invoke at server startup, not only via endpoint. Area: `mkt/bundles.ts`, `api/index.ts`. **M**.
- **#157** (Partial) — `tap init`: a CLI scaffold for packages (bot/workflow/tap) with validate + register steps (today: single skill file via API). Area: `mkt/bundles.ts`, `cli/`. **M**.
- **#158** (Partial) — Manifest placeholder substitution from user config + per-capability/model override layer on manifests. Area: `mkt/installer.ts`, `mkt/registry.ts`. **M**.
- **#159** (Partial) — Configurable manifest-cache freshness (TTL/max-age) beyond mtime/size change detection. Area: `mkt/registry.ts`. **S**.
- **#161** (Partial) — A first-class mid-session role switch (`/role`) on a live session. Area: `api/` chat route, `web/`, `cli/repl.ts`. **S**.
- **#162** (Partial) — A skill-pack resource catalog (manifest of scripts/references/assets), surfaced via tool/API/UI, + ship at least one real pack in seed. Area: `ar/skills.ts`, `seed/skills/`. **S**.
- **#163** (Partial) — Declarative activation rules in skill frontmatter, evaluated per user message (the embedding half exists). Area: `ar/skills.ts`, `ar/runtime.ts`. **M**.
- **#164** (Partial) — A `/skill` command surface + env force-load for skills. Area: `api/slash-commands.ts`, `ar/skills.ts`. **S**.
- **#165** (Partial) — A named, distributable capability-bundle entity (servers + tool filters as one unit), produced by discovery as `capability` items. Area: `packages/marketplace/`, `ar/discovery.ts`. **M**.
- **#166** (Partial) — An intent-search surface (tool/API/UI) over bots, capabilities, and MCP bundles — the ranker exists but only feeds skill auto-activation. Quality improves with #13. Area: `ar/discovery.ts`, `api/`, `web/`. **M**.
- **#167** (Partial) — Specialist-scoped activation defaults/rules (e.g. enable + scope auto-activation per specialist; today a global opt-in no seed bot sets). Area: `ar/types.ts` (`BotConfig`), seed bots. **S**.

### N. Sharing / Collaboration (4)
- **#170** (Partial) — A `/analyze`-style local session viewer (loopback, nothing uploaded) — or a documented decision that Activity + `/context` is the answer. Area: `web/` Activity, `api/session-craft.ts`. **S**.
- **#171** (Partial) — Portable specialist publishing: a public manifest others can install from a network registry (today org-scoped/local only). Area: `api/published-bots.ts`, `api/org-library.ts`, `packages/marketplace/`. **M**. Pairs with #103/#153.
- **#172** (Partial) — A `/copy` action with segment selectors (last / all-assistant / all-user / whole conversation). Area: `web/` chat, `api/session-craft.ts`. **S**.
- **#173** (Partial) — Multi-writer collaboration on one live session (today writes are serialized per session; federation is per-peer sessions). Area: `ar/turn-scheduler.ts`, `api/chat-queue.ts`. **L**.

### O. Observability / Cost (8)
- **#175** (Partial) — A single `/info` view combining session tokens + cost + cache + compression. Depends on #137 for cache figures. Area: `api/session-craft.ts`, `web/`, `cli/`. **S**.
- **#176** (Partial) — An in-session `/report` command over the existing breakdown/ledger APIs. Area: `api/session-craft.ts`, `cli/repl.ts`. **S**.
- **#177** (Partial) — An in-session `/usage` command (the balance half is not applicable to self-hosted BYOK and should be documented as such). Area: `api/session-craft.ts`, `cli/`. **S**.
- **#178** (Partial) — A unified `/status` surface aggregating workflow runs, background jobs, monitors, and shell jobs. Area: `web/components/activity/`, `api/`, `cli/`. **M**.
- **#179** (Partial) — Cost side-channels: ACP usage events (#98) + real workflow per-step costs (#150). Area: `ar/acp-server.ts`, `wf/`. **M**.
- **#180** (Partial) — A supervisor statistics accumulator (gates fired, rejections, steers) exposed on a surface. Area: `ar/supervisor.ts`, `ar/spans.ts`, Activity. **S**.
- **#181** (Partial) — Log-level control — runtime toggle (API/config/command); today none exists at any level. Area: `ar/` logging, `api/`, `cli/`. **S**.
- **#183** (Missing) — Run and publish a real task suite (defined tasks, pass scores) — BENCHMARK.md currently publishes harness timings only and disclaims the rest. Area: `packages/agent-runtime/benchmarks/`, `BENCHMARK.md`. **M**. Note: meaningful scores need capable models; the project's zero-paid-API test convention means the suite design (local models vs a one-off budgeted run) needs a decision.

### P. Misc (runtime) (7)
- **#184** (Partial) — Hashed line identifiers + range parameters for exact edits. Area: `ar/tools/coding.ts`. **M**.
- **#185** (Partial) — An assistant-output hygiene pass (strip internal metadata / invented reminders from assistant text). Area: `ar/runtime.ts` output path. **M**.
- **#186** (Partial) — Terminal rendering depth: syntax highlighting, markdown links, a distinct thinking display in the TUI. Area: `apps/tui/`. **M**.
- **#187** (Partial) — Terminal polish: a reedline-class line editor, progress animation, a terminal job manager. Area: `cli/repl.ts`, `apps/tui/`. **M**.
- **#188** (Partial) — Per-tool error counters that feed behaviour (beyond the progress guard). Area: `ar/runtime.ts`, `ar/progress-guard.ts`. **S**.
- **#190** (Partial) — Record the shipped demo: capture a real end-to-end run of `examples/fix-a-bug/` and ship the transcript/artefact with it. Area: `examples/fix-a-bug/`. **S**.
- **#191** (Missing) — Write the actual meta-skill: a SKILL.md teaching an *external* agent to drive KriyaDot via its API/CLI/MCP server. Area: `seed/skills/` or `skills/`. **S**.

### Cloud closure items (next build — Lightning AI layer)
- **C2/C3/C4/C10/C12** (Missing-Excluded) — Hosted machines, hands-on-machine surfaces, the Hub gateway/credits, plans/pooled billing, hosted share viewer. **Blocker: the Lightning AI cloud layer is not built yet (it is the next build's scope), and publicly shipping the credential-delegation pattern is gated on confirming Lightning's ToS position.** Area: new `api/` cloud module + `web/` surfaces.
- **C9 media generation** (Partial; generation itself Missing) — Replace the mock media provider with a real one. **Blocker: provider/founder credentials** (the resolver "always returns the mock" pending them). Area: `packages/muse-modules/src/media/`.
- **C1/C5/C6/C8/C11** (Partial) — Octo-style auto-creation, orchestrator auto-routing, in-channel `/use` switching, octo-style public API, presence UX: all become designable once the cloud layer exists; locally they are shape differences, not defects.

---

## Method and honesty notes

- All 191 rows were re-scored from the original audit's table — none dropped, none added. The Octomind side did not move (clone HEAD re-verified: `55b8ed87`), so every delta is KriyaDot-side.
- Scores follow the original standard: Present = comparable depth; Partial = exists but shallower/narrower **in a named way**; Missing = absent. Code that exists but is not wired into any host/runtime path was scored Partial at best, with the wiring gap named (this rule alone accounts for #59, #67, #75, #80, #101, #137, #143, #151).
- **Original-audit mis-scores found (3):** #38 multimodal (Present → Partial: native image parts never reached a provider), #50 MCP OAuth (Present → Partial: CIMD was credited but does not exist), #145 parallel blocks (Present → Partial: the cap credited was Fusion's, not the workflow runner's). All three are corrections of the original audit, not regressions in KriyaDot.
- Deliberate differences are scored as they stand, per this re-audit's brief: #12 (vault/file key storage vs refuse-to-store — Partial), #48 (native core tools vs MCP-native — Partial), #70 (live policy evaluation vs snapshots — Missing, option not built), #2/#4-cloud (no hosted gateway — Partial/Missing-Excluded).
- KriyaDot additions with no Octomind counterpart (federation, plugins, proactive care, representative assistant, TTS breadth, SSO/tenancy, OCR KB) were **not** scored into Octomind rows; they changed a row only where they are the mechanism behind an Octomind feature (e.g. the email channel check, SkillHub at #103).
- Test-coverage gaps worth knowing independent of scores: recite (#25) and hindsight (#27) have no dedicated tests; commit attribution (#73) has no dedicated test; the memory-inspector (#86) and evolution (#83) endpoints lack API-level tests; human accounting (#47) is untested.
- Analysis only: no Octomind code or branding was copied; no KriyaDot source was modified in this pass. Verification notes per section: `hidden_files/reaudit-scratch-AB.md`, `-CD.md`, `-EF.md`, `-GHI.md`, `-JK.md`, `-LP-cloud.md`.
