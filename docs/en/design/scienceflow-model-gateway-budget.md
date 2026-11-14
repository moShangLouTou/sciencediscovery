# ScienceFlow model gateway and bounded model usage

Status: **Proposed — not implemented.** Round 17 design (2026-11-14; second
revision 2026-11-15). No production code, schema, test, route, table, installer
or engine patch was added by this round. The design now names one tracked engine
change (`-P` in the engine's own `-m` child argv, §3.6); it is a prerequisite of
a future slice, not something this round built. Every plan keeps
`canStart: false` and all five blockers
(`SD` `packages/schema/src/scienceflow.ts:258-262`).

Review revision 1 (2026-11-14) answered six findings. It is kept as history;
the call graph (§1), the `models.json` control plane (§3.3) and "spend is not
enforceable" (§5.1) did not change.

| Finding | Where it was answered |
| --- | --- |
| R17-01 admission omitted settled and unknown usage; settlement deltas were ambiguous | §5.2 (a reservation row is the only source; totals are aggregates), §5.3 (column-level transitions), §5.6 (hand-computed traces) |
| R17-02 body bytes do not prove a provider input-token bound | §5.1 (the enforceable set is narrowed and the token claim is withdrawn) |
| R17-03 "one reachable peer" ignored host directories mounted into the sandbox | §3.1–§3.5 (new transport: an inherited descriptor, so `AF_UNIX` is denied outright) |
| R17-04 a child process does not inherit `sys.path`, so the assembly was unproven | §1.3 (the gap, read from code), §3.6 (the chosen assembly and its probe) |
| R17-05 retry and idempotency accounting contradicted itself | §5.4 (one admission is one dispatch; no idempotency support) |
| R17-06 the accepted owner and permission epoch were not authorities | §4.1 (the authority tuple and its checks), §4.2 (the durable row), §8 decision 7 |
| Report-budget vocabulary, forwarder process shape | §6.1, §3.2 |

Review revision 2 (2026-11-15) accepts the reservation algorithm, the token
withdrawal and the no-replay decision, and reopens three boundaries plus one
transaction-ordering defect. This revision answers each in place.

| Finding | Where it is answered now | Status of the item |
| --- | --- | --- |
| R17-03 `socketpair` is a second `AF_UNIX` creation entry | §3.4 (type and protocol checked; datagram pairs refused), §3.5 (the argument restated around "a socket that can name a peer"), §7.3 G14/G15 | **Conditional**: the argument is code-derived and the new block is unmeasured; G15 decides. Until it passes, no-bypass is *not* claimed |
| R17-04 the new child assembly conflicts with the R11 source gate; `cwd` shadowing voids the source guarantee | §3.6 (two-phase proof, the existing gate kept, `-P` chosen, probe facts classified), §1.3 (the corrected `cwd` bullet), §7.2 (the runtime-check file) | **Closed in the design**, with one tracked engine patch as a prerequisite |
| R17-06 restart identity and the no-resume contract contradicted each other | §4.1 (a per-process `runnerBootId`; restart revokes and never re-issues), §4.2 (the column), §5.6 trace E | **Closed in the design**: v1 restart revokes, reconciles and stops; no attempt 2 |
| A reservation transaction held the ledger write lock across the HTTP body | §5.2 (body read outside the transaction), §5.1 (connection, body-time and buffer limits), §7.3 G26 | **Closed in the design** |
| Trace B admitted a request the corrected aggregate refuses | §5.6 B | Corrected |
| "No upstream retry" did not constrain the reused model client | §2 (the client is not reused for the upstream leg), §3.3, §5.4, §7.3 G8 | Corrected: one raw dispatch |

The review's second-acceptance statement is followed literally: the report does
not say "all six closed". R17-01 and R17-02 are closed; R17-05's principle is
closed and its implementation is now one raw dispatch; R17-03, R17-04 and
R17-06 keep the status in the table.

This note answers one question:

> When a research execution calls a model, how does that call reach one
> Runner-enforced gateway that reserves usage before forwarding, and why can
> neither a task worker nor the report subprocess reach a model any other way?

It does not answer whether a real provider, a real credential or a product start
exists. It selects one transport, states which limits are enforceable and which
are only accounting, and defines one bounded next slice. It never claims that an
authenticated proxy is a budget, and never claims that a token ceiling is a spend
ceiling.

## 0. Scope, sources, and evidence labels

| Label | Source | Revision |
| --- | --- | --- |
| `SD` | worktree `/home/liyuan/sd-fork/sciencediscovery-wt-sfreader`, branch `feat/scienceflow-run-reader` | `fc5cc491710a9c9569f4ffdf4afbe197ffb8146b` |
| `SF` | pinned engine checkout `/home/liyuan/sd-fork/sf-engine-r16` | `d6d4b77f93061ced9ae3e3d8c10c0f70f28113a9` |
| `SF-DEP` | the engine's declared dependency `inquirycraft==0.9.8` (`SF` `pyproject.toml:40`) and `httpx 0.28.1`, read from the round-16 acceptance environment `SD` `.tmp/r/sf16-env/lib/python3.12/site-packages/` | installed from `SF` `uv.lock` |
| `R16` | `REVIEW-ROUND16-CLOSEOUT-2026-11-14.md` and round-16 report §11 | historical evidence only |

`SF` and `SF-DEP` are read-only references. Nothing here asserts that a patched
engine or a gateway is installed on any Runner.

Labels: **[code]** read out of the source above; **[report]** prior round's
evidence, not re-run; **[inference]** conclusion from code facts, not executed;
**[todo]** to be built; **[dyn]** needs dynamic verification this round did not
perform.

Trust boundaries, stated once and used everywhere:

| Party | Trusted with | Not trusted with |
| --- | --- | --- |
| Untrusted workload | its own allowance, its per-run gateway token, the bytes it is given | upstream key, other executions, the Runner's filesystem |
| Trusted Runner configuration | upstream endpoints and credentials, allowlist, limits | — (administrator-owned) |
| Gateway service (Runner process) | the upstream credential, the reservation ledger | — |
| Upstream provider | — | anything the Runner cannot observe (usage it does not report) |

## 1. The model call graph as it exists today

### 1.1 Configuration sources, in resolution order

1. **[code]** A stage field with an explicit endpoint wins: `apply_model_registry()`
   skips a stage that already has `api_key`/`api_keys` and no aliases
   (`SF` `scienceflow/foundation/config/llm/model_registry.py:166-192`,
   `:119-163`). Those fields are stage configuration, i.e. the engine's config
   YAML (`SF`
   `scienceflow/foundation/config/schema/models/contracts/schema.py:10-46`:
   `base_url`, `api_key`, `api_keys`, `base_urls`, `models`, `model_config_path`,
   `headers`, `http_timeout`, `use_proxy`, `max_tokens`).
2. **[code]** Otherwise the model registry is read from
   `$XDG_CONFIG_HOME/scienceflow/models.json`, falling back to
   `~/.config/scienceflow/models.json`
   (`SF` `.../llm/model_registry.py:20-30`), at config load time
   (`SF` `.../models/loading/serialization.py:35-58`: `_apply_env(config)` then
   `apply_model_registry(config)`), once per process.
3. **[code]** `models.json` is versioned (`version: 1`) and maps an alias to a
   concrete `model` plus endpoint lists `[{url, key}]`, optionally per role
   (`code`/`feedback`), plus `pricing`, `use_proxy` and `reasoning_replay`
   (`SF-DEP` `inquirycraft/llm/model_registry.py:86-184`, `:254-271`).
   `defaults.code_models` / `defaults.feedback_models` select the aliases.
4. **[code]** `CODE_API_KEYS` / `CODE_BASE_URLS` / `CODE_MODELS` are only a
   **projection**: the parallel runner writes them into a task worker's
   environment when the manifest supplied endpoint values
   (`SF` `.../state/subprocess_runtime.py:177-210`). No code in `SF` or
   `SF-DEP` reads them back into a stage configuration — a repository-wide
   search finds only the writer, the routing-index helper and the log summary
   (`SF` `.../parallel/config/manifest.py:127`, `.../llm_config_summary.py:29-33`).
   Round 12's §2.1 listed those names as a configuration source; that is
   **corrected here**: inside this pinned engine they are propagation, not
   authority. `models.json` under a controlled `XDG_CONFIG_HOME` is the
   mechanism this design uses.

The frozen contract cannot supply endpoints: the API contract refuses manifest
keys `agent`, `api_key`, `api_keys`, `base_url`, `base_urls`, `models`,
`llm_routing_mode`, `llm_sticky_id` (`SD`
`services/api/src/scienceflow/execution-contract.ts:497-504`, check
`manifest_model_gateway` at `:178`), and the bridge refuses any manifest or
`task.yaml` key outside its fixed sets (`SD`
`services/runner/src/scienceflow-engine-bridge.ts:215-245`, `:519-583`). A
Runner-side gateway therefore does not have to out-argue a manifest; there is no
path for one to name an endpoint.

### 1.2 Client variants — one SDK family, one request shape

- **[code]** The client is the OpenAI Python SDK: `AsyncOpenAI` (or
  `AsyncAzureOpenAI` when `api_type == "azure"`) constructed with `api_key`,
  `base_url`, optional `default_headers`, and an engine-built
  `httpx.AsyncClient` (`SF-DEP` `inquirycraft/llm/online.py:43-84`).
- **[code]** A stage with more than one endpoint becomes `PooledLLM`, which
  receives aligned `(base_url, api_key, model)` tuples and a routing mode
  (`SF` `.../llm_factory.py:24-96`; `SF-DEP` `inquirycraft/llm/factory.py:39-114`).
  With one endpoint the pool degenerates to one key and one model.
- **[code]** The transport is not the SDK default: the engine builds its own
  `httpx.AsyncClient` around an `httpx.AsyncHTTPTransport` (`retries=1`,
  `max_keepalive_connections=0`, `max_connections=20`, explicit
  connect/read/write/pool timeouts) and injects it as `http_asyncclient`
  (`SF` `scienceflow/foundation/config/llm/llm_http.py:53-63`, `:102-146`,
  `:161-175`). The one exception is the `EMPTY` API-key sentinel used by local
  mock setups, where no client is injected and the SDK default applies
  (`:110-114`).
- **[code]** `AsyncOpenAI` is constructed **without** `max_retries`
  (`SF-DEP` `inquirycraft/llm/online.py:78-84`), so the SDK default
  `DEFAULT_MAX_RETRIES = 2` applies and it retries `408`, `409`, `429` and
  `>= 500` unless the response carries `x-should-retry: false` (`SF-DEP`
  `openai/_constants.py:10`, `openai/_base_client.py:750-780`). The transport's
  own `retries=1` covers connection errors only, not status codes. One engine
  call can therefore become several HTTP requests; §5.4 accounts for each
  separately instead of assuming one.
- **[code]** Consequently **environment proxies are inert for model calls**:
  `httpx` only honours `HTTP_PROXY`-style variables when no explicit transport
  is passed (`SF-DEP` `httpx/_client.py:1399`: `allow_env_proxies = trust_env
  and transport is None`), and the only path that consults them is the opt-in
  `use_proxy: true` branch, which reads the proxy from the environment and
  builds `httpx.Proxy` explicitly (`SF` `.../llm_http.py:73-99`). Pointing
  `HTTP_PROXY` at the sandbox egress bridge therefore does **not** reroute model
  traffic. The endpoint address has to change, not an environment variable.
- **[code]** The request body the engine sends is fixed and small: `model`,
  `messages`, `max_tokens`, `temperature`, plus `stream: true` and
  `stream_options: {include_usage: true}`, and — depending on the stage —
  `top_p`, `seed`, `frequency_penalty`, and for tool turns `tools`,
  `tool_choice`, `parallel_tool_calls`
  (`SF-DEP` `inquirycraft/llm/text_stream.py:19-43`,
  `tool_requests.py:65`, `:204-207`).
- **[code]** Usage is read from the provider's OpenAI-shaped fields:
  `prompt_tokens`, `completion_tokens`, cached tokens from
  `prompt_tokens_details`/`prompt_cache_hit_tokens`
  (`SF-DEP` `inquirycraft/llm/online_support.py:40-46`). The engine keeps them
  in an in-process `TokenUsageTracker` (`SF-DEP`
  `inquirycraft/llm/usage.py:8-49`) — accounting, never a cap.
- **[inference]** The `http_timeout` stage field (default 300 s) bounds a
  single request at the client; it is not a run budget.

### 1.3 Which phases can call models, and in which process

| Phase | argv | Client | Configuration carrier |
| --- | --- | --- | --- |
| `prep` task | `[resolve_project_python(), "-m", "scienceflow.interfaces.cli", "prep", …]` (`SF` `.../execution/subprocess.py:24-41`) | none found on the paths read [inference]; any client it built would resolve the same registry | inherited environment → `models.json` |
| research task | `[resolve_project_python(), "-m", "scienceflow.runtime.parallel.execution.task_worker", …]` (`SF` `.../execution/subprocess.py:42-58`, `:69-105`) | agent code stage (`SF` `scienceflow/agent/factory/composition.py:65-71`), LNR feedback stage (`SF` `.../resource/advisory.py:528`) | same |
| reporting (baseline) | `[sys.executable, "-m", "scienceflow.runtime.parallel.control.reporting", run_id, launch_token, pid, budget]`, `stdin=DEVNULL`, `start_new_session=True`, no `env=` (`SF` `.../control/reporting/__init__.py:31-56`, `.../reporting/__main__.py:5-34`) | none — files only | inherited |
| reporting (enrichment) | same child | feedback stage (`SF` `scienceflow/research/reporting/analysis.py:354-364`) | inherited |
| supervisor (the bridge) | `[interpreter, "-I", "-B", "-", …]`, program on stdin (`SD` `research-run.ts:1787-1789`) | none [inference] | the Runner's fixed sandbox environment |

Rules that hold for every row:

- **[code]** A task child's environment is `os.environ.copy()` plus resource
  variables (`SF` `.../state/subprocess_runtime.py:92-107`), so anything the
  supervisor was given reaches every worker.
- **[code]** The child interpreter is `resolve_project_python()`: it walks up
  from `scienceflow.__file__` and returns `<dir>/.venv/bin/python` when that
  file and a sibling `pyproject.toml` exist, otherwise `sys.executable`
  (`SF` `scienceflow/runtime/environment.py:27-54`). Inside the sandbox
  `scienceflow.__file__` is under the read-only `/scienceflow-engine` mount, so
  "otherwise `sys.executable`" is the leased interpreter **only while the
  checkout carries no `.venv`**. A `.venv` in the host checkout is visible
  through the same bind and silently wins; its contents are not covered by the
  source binding R11 verified. The report child is different again: it is
  spawned with `sys.executable` directly (`SF` `.../control/reporting/__init__.py:47`),
  so it always uses the supervisor's interpreter.
- **[code]** `sys.path` is **not** inherited across `exec`. The supervisor runs
  with `-I`, which ignores `PYTHONPATH` and the user site, and reaches the
  engine only through `sys.path.insert(0, "/scienceflow-engine")`
  (`SD` `services/runner/src/scienceflow-engine-bridge.ts:840-845`). A task
  child is a separate `python -m` process whose `sys.path` is its own
  `[cwd, <PYTHONPATH entries>, <site-packages of the resolved interpreter>]`.
  The sandbox environment is `--clearenv` plus a fixed set that currently sets
  `PYTHONPATH` only when an NPU or a managed environment supplies one
  (`SD` `services/runner/src/executor.ts:938-961`); the lease environment does
  not install `scienceflow` (its site-packages carries only `_virtualenv.pth`).
  **[dyn] On the code as read, a task child cannot import
  `scienceflow` inside the sandbox at all.** Checked outside the sandbox on
  2026-11-14 — the round-16 acceptance interpreter, an empty environment and a
  `cwd` outside the checkout give
  `importlib.util.find_spec("scienceflow") is None` — but the sandboxed step is
  still unmeasured. Round 16 did not exercise it: its
  research step and its report content were the documented substitutes, so no
  real task worker or `reporting -m` process ever ran. §3.6 chooses the
  assembly that closes this, and §7.3 makes it an acceptance item.
- **[code]** `cwd` is the sandbox writable workspace (`SD` `executor.ts:363-369`)
  and, for `-m`, `sys.path[0]` is `cwd`, ahead of `PYTHONPATH`. A
  `scienceflow/` package left in the workspace therefore wins for every child.
  Revision 1 called this "result integrity, not egress" and left the fix to the
  slice; revision 2 rejects that framing. If the workspace can replace the
  engine entry, G23's source guarantee is void whatever the egress filter says.
  The chosen fix is structural, not a scan: the engine's own `-m` children get
  `-P` (`PYTHONSAFEPATH` semantics), so `cwd` is never prepended, and
  `PYTHONPATH=/scienceflow-engine` is the first ordinary entry. A pre-placed or
  later-created `scienceflow/` in the workspace cannot become the entry; §3.6
  states the patch, the probe and the residual. Research code that the engine
  runs as its own shell subprocesses is **not** given `-P`, so its existing
  sibling/cwd imports keep working; it is not the engine entry.
- **[code]** The report child is spawned with `start_new_session=True` and no
  `env=` argument: same namespace, own session, inherited environment
  (`SF` `.../control/reporting/__init__.py:46-56`), and it is reaped by the
  supervisor's budget (`:57-75`).
- **[code]** Reporting's model failure **does not change the run outcome**:
  `enrich_report()` catches every exception and degrades the report
  (`report_agent.status = "degraded"`), and the baseline report is written
  before enrichment runs
  (`SF` `scienceflow/research/reporting/analysis.py:508-567`,
  `:539-554`; `.../control/reporting/__main__.py:5-34`). A refused or un-metered
  report call can therefore be invisible in the engine's status — which is why
  the budget outcome must come from the gateway, not from `report_status`.
- **[code]** Reporting's enrichment also performs literature retrieval from the
  sandbox (`search_related_works`); with no general egress it fails inside the
  same `except` and the report degrades. Model access does not grant research
  egress.
- **[inference]** No client is constructed in the supervisor process itself on
  the paths read: `worker.supervise()` → `run_manifest()` → `ParallelRunner`
  spawns task children, and the report client lives only in the report child.
  This matters because it means the gateway must serve *children*, not a single
  in-process caller.

### 1.4 What the Runner can observe today

- **[code]** The research sandbox runs with `--unshare-all`, `--clearenv`,
  `--cap-drop ALL` and the seccomp filter at fd 3 (`SD`
  `services/runner/src/executor.ts:962-998`).
- **[code]** The research seccomp variant is the baseline minus exactly one
  entry: `socketpair`, checked against `AF_UNIX` **in its domain argument only**
  (the type is not inspected, which §3.4 tightens for the new variant);
  `socket`, `connect`, `bind`, `listen`, `accept`, `accept4` stay refused (`SD`
  `services/runner/src/seccomp.ts:42`, `:119-134`, `:147-159`; denied table at
  `:58-62`). The variant is chosen by Runner code for the workload kind, never
  by a request (`SD` `services/runner/src/research-run.ts:1939-1955`).
- **[code]** A research run receives no egress bridge: `prepareSandboxLaunch()`
  is called without an `egress` option, so the sandbox's only network is its own
  empty namespace (`SD` `services/runner/src/research-run.ts:1746-1760`).
- **[inference]** Therefore, today, a model client inside the research sandbox
  cannot open any connection at all. `canStart: false` is the honest state; this
  is the blocker `model_gateway_not_configured`, not a missing configuration
  file.

## 2. What can be reused from the agent gateway, and what cannot

`SD` `services/api/src/agent-run/jiuwenswarm-model-gateway.ts` already serves
one model, to one agent run, as an OpenAI chat-completions endpoint on
`127.0.0.1` (`:583`), authenticated by a per-run bearer token (`:263`, `:287`),
with a fixed parameter allowlist that fails closed (`:302-306`), a mandatory
`max_tokens` inside the configured ceiling (`:321-326`), stream translation
(`:478-535`), and usage projected back as OpenAI counts (`:155-162`). Its
outbound leg is `streamModelTurn()` from `@sciencediscovery/model`
(`SD` `packages/model/src/client.ts:1591-1599`), which speaks chat-completions,
Anthropic Messages and OpenAI Responses.

| Component | Reusable for a Runner gateway? | Why |
| --- | --- | --- |
| Chat-completions → native request translation, stream mapping | **Not in this slice** | [code] proven on the agent path, but this gateway passes the accepted bytes through to one OpenAI-compatible endpoint and translates nothing (§3.3); a later slice that admits a native provider needs it and its own accounting |
| Strict parameter allowlist, fail-closed refusal | **Yes** | [code] same discipline; the accepted field set differs (§3.3) |
| Outbound client (`streamModelTurn`) | **No, not for this slice** | [code] it cannot forward the accepted bytes unmodified (it rebuilds the request from `systemPrompt`/`history`/`tools`), and it has two dispatch-amplifying layers: `requestWithRetry` (`maxRetries` defaults to 2, `packages/model/src/client.ts:326-347`, `:557-650`) and the thinking-control fallback loop that reissues on a 400 (`:1012-1024`). The gateway's upstream leg is one raw request (§3.3, §5.4) |
| `normalizeUsage` (and the wire diagnostics vocabulary) | **Yes** | [code] pure functions over the provider payload; `SD` `packages/model/src/usage.ts:32`, `client.ts:41` |
| Privacy-safe wire diagnostics (`ModelWireDiagnostics`) | **Yes** | [code] counts and classifications only, no prompt or credential |
| Per-run bearer token | **Yes**, with a different identity (§4) | [code] the agent token is a per-run UUID compared by string equality (`:263`, `:287`); the Runner token is bound to the execution tuple and compared by digest (design, §4.1) |
| Loopback TCP listener on the API host | **No** | [code] remote Runner cannot reach it; and it is outside the sandbox's namespace |
| Upstream credential source | **No** | [code] the API's model catalog belongs to the API; a Runner must own its own trusted config |
| Reservation, settlement, durable accounting | **Missing** | the agent gateway has `beforeTurn`/`progress` hooks only (`:222-240`) and per-request `max_tokens`; it has no ledger |
| Execution identity (`executionId`, attempt, generation) | **Missing** | no field exists on the agent gateway |
| Revocation, restart semantics, disconnect accounting | **Missing** | the gateway closes with the run's `AbortSignal` (`:354-356`) and keeps nothing |
| A path from a sandbox to it | **Missing** | the sandbox has no interface and no egress bridge |

Two claims are kept apart in the rest of this note:

- **Attribution** — the gateway can say which execution a request belongs to.
  A per-run token already gives that.
- **Enforcement** — a request cannot be served without a successful reservation
  in durable storage, and there is no other path to a model. That needs the
  egress contract of §3 and the ledger of §5, not just a token.

`SD` `services/runner/src/execution-instance-backend.ts:36-39` states the same
boundary from the other side: it "deliberately does not … enforce a model
budget".

## 3. The transport and the egress contract

### 3.1 The candidates, and why the first draft's choice failed review

| Candidate | Verdict |
| --- | --- |
| Host loopback URL (`http://127.0.0.1:<port>`) from the sandbox | **Rejected.** [code] `--unshare-all` puts the sandbox in a fresh network namespace with no route to the host. Reaching the host's loopback would mean sharing its network namespace, which this design refuses |
| Environment proxy (`HTTP_PROXY` → egress bridge) | **Rejected.** [code] inert: the engine installs its own `httpx` transport, so proxy variables are never read (§1.2); and a CONNECT proxy would forward to a provider without metering |
| **Bind-mounted Unix socket + in-sandbox loopback relay** (the first draft) | **Rejected after review.** Reaching a filesystem socket requires `socket(AF_UNIX, …)`, and a seccomp filter cannot inspect the `sockaddr` a `connect()` points at. Mounting `/workspace`, `/scienceflow-engine`, the control directory, the input copy and the managed environment prefix puts host directories inside the sandbox; any *other* host process that can write to one of them can leave a live Unix socket there, and no start-time scan covers a socket created later. The first draft's "one reachable peer" therefore described the normal case, not a boundary |
| **Inherited descriptor + in-sandbox loopback relay** (chosen) | [code] the sandbox already receives an extra descriptor from the Runner (`--seccomp 3`, `SD` `executor.ts:1440-1457`), so the same mechanism carries a socketpair: `AF_UNIX` can then be **denied outright**, and a filesystem socket anywhere in the mount namespace becomes unreachable by construction, not by absence |

### 3.2 The chosen shape

The Runner creates a connected `AF_UNIX` socketpair before spawn and passes one
end to bwrap as descriptor `4`. The sandbox keeps its loopback listener — the
engine's client needs an HTTP endpoint — but that listener no longer reaches a
host path: it writes length-prefixed frames onto the inherited stream, and the
Runner's gateway reads them back as virtual connections.

```text
Runner process (host)
├─ socketpair(AF_UNIX, SOCK_STREAM)          created immediately before spawn
│     end A ─────────────────────────────┐
│     end B ──▶ model gateway            │
│              ├─ framing demultiplexer  │
│              ├─ http server fed by the demultiplexed duplex streams
│              ├─ authority + reservation, in the Runner ledger, before any upstream byte
│              └─ upstream leg: one raw undici request (no retry, no fallback)
└─ bwrap monitor  --unshare-all --unshare-user --clearenv --cap-drop ALL
   │   args: … --seccomp 3 ; stdio: [pipe, pipe, pipe, seccompFd, tunnelFd]
   └─ namespace init (bwrap, reads fd 3, hands fd 4 through)
      └─ model-gateway forwarder (fixed Python, stdlib only, entry command)
         │   wraps fd 4 (no socket() call), listens 127.0.0.1:18119,
         │   frames each accepted connection onto fd 4
         │   fork(); child marks fd 4 non-inheritable then execv(bootstrap)
         │   parent keeps serving, then waitpid()s and exits with the child's status
         └─ research bootstrap (fixed Python, Runner-owned)
            ├─ engine supervisor (supervise → run_manifest)
            ├─ task workers        ── model calls ──▶ 127.0.0.1:18119 → fd 4 → gateway
            └─ report subprocess   ── model calls ──▶ same
```

The forwarder's process shape is the one this codebase already ships, and the
first draft described it wrongly. `egress-bridge.ts` binds its listener,
`os.fork()`s, and in the **child** calls `os.execv(command[0], command)`; the
parent then starts the serve thread (as a daemon thread) and blocks in
`os.waitpid`, returning the child's status (`SD`
`services/runner/src/egress-bridge.ts:123-140`). The forwarder is therefore the
workload's parent and session ancestor; it never `exec`s the workload itself,
and the listener and in-flight forwarded connections are close-on-exec so the
workload does not inherit them (`:131-135`). The model forwarder keeps that
shape and adds one line in the forked child: the tunnel descriptor is marked
non-inheritable before `execv`.

Framing, because one stream carries every connection:

| Field | Size | Meaning |
| --- | --- | --- |
| `type` | 1 byte | `1` open, `2` data, `3` close |
| `conn` | 4 bytes | connection id, allocated by the sandbox side, monotonic, never reused |
| `length` | 4 bytes | payload length; `data` payloads are capped at 16 KiB, `open`/`close` carry none |

The Runner's demultiplexer turns each `conn` into a Node `Duplex` and hands it
to the gateway's `http.Server` through its `connection` event; the gateway never
calls `listen()`. Writes are serialized per direction (one writer each way), so
no locking protocol is needed. A frame with an unknown `conn`, a length over the
cap, or a `data` frame on a closed connection closes the tunnel and fails the
attempt — a desynchronized tunnel is never resynchronized.

Fixed constants:

| Constant | Value | Meaning |
| --- | --- | --- |
| `MODEL_GATEWAY_TUNNEL_FD` | `4` | descriptor bwrap passes through (fd 3 is reserved by `--seccomp 3`) |
| `MODEL_GATEWAY_BRIDGE_PORT` | `18119` | sandbox loopback port the forwarder listens on |
| `MODEL_GATEWAY_URL` | `http://127.0.0.1:18119/v1` | the `base_url` written into the per-execution `models.json` |
| `MODEL_GATEWAY_CONFIG_MOUNT` | `/scienceflow-gateway` | read-only mount of the per-execution config directory |
| `MODEL_GATEWAY_MAX_FRAME` | `16384` | largest `data` payload |

Lifetime:

- **[todo]** The socketpair is created immediately before spawn and both ends
  are closed after termination is proven; the gateway refuses frames from a
  closed generation. Nothing is left on disk, so there is no path to unlink, no
  `sun_path` length limit, and no mode to get wrong.
- **[todo]** The forwarder binds the loopback port **before** forking, so the
  workload cannot take the port first; it exits when its child exits.
- **[todo]** The forwarder enters through the existing `commandPrefix`
  mechanism (`SD` `executor.ts:1000`, `SandboxLaunch.commandPrefix`) with the
  engine's own argv after `--`, exactly as the egress bridge does; its
  interpreter and standard library come from the same host probe and the same
  read-only mounts (`SD` `egress-bridge.ts:147-200`, `:235-253`). That is the
  only other mount this design adds, and it is the one the audited egress path
  already makes.
- **[dyn]** Whether bwrap passes descriptor `4` through to the payload is not
  verified by this round. If it does not, the launch fails closed with
  `MODEL_GATEWAY_FD_UNAVAILABLE` (reported as the existing
  `RESEARCH_LAUNCH_FAILED`, §6.3); there is **no** fallback to a bind-mounted
  socket, because that would restore the hole this section closes.
- **[dyn]** Wrapping the descriptor with `socket.socket(fileno=4)` must not
  issue a `socket()` call, because that call is filtered (§3.4). CPython
  adopts an existing descriptor without creating one, but this is measured by
  G25 together with the bwrap hand-off rather than assumed.

### 3.3 How every client is configured

The configuration path needs no engine patch; the source assembly does (§3.6,
engine change EC6). Every model client reads the same per-execution
`models.json`:

```json
{
  "version": 1,
  "models": {
    "sd-gateway": {
      "model": "<the one provider model id the Runner allowlist carries>",
      "endpoints": { "code": [{ "url": "http://127.0.0.1:18119/v1", "key": "<per-run token>" }],
                     "feedback": [{ "url": "http://127.0.0.1:18119/v1", "key": "<per-run token>" }] },
      "use_proxy": false,
      "reasoning_replay": "preserve"
    }
  },
  "defaults": { "code_models": ["sd-gateway"], "feedback_models": ["sd-gateway"], "selection": "fixed" }
}
```

- **[code]** The file is found through `XDG_CONFIG_HOME` (`SF`
  `.../model_registry.py:20-30`). The Runner sets that variable in the
  **sandbox environment** (`SD` `executor.ts:938-961`), so it reaches the
  supervisor and every child by `--setenv` and `os.environ.copy()` rather than
  by a Python assignment inside the bridge. `HOME` stays `/tmp`.
- **[code]** Every task child inherits that environment
  (`SF` `.../subprocess_runtime.py:92-107`) and the report child inherits it too
  (`SF` `.../control/reporting/__init__.py:46-56`). No child needs a patch, a
  `sitecustomize`, or an import hook: the configuration is the same file the
  engine already reads on its own.
- **[code]** `use_proxy: false` is explicit so the `use_proxy` branch cannot
  turn the gateway into an environment-proxy client
  (`SF` `.../llm_http.py:73-99`).
- **[code]** The engine's `-I -B -` invocation and its `sys.path.insert(0,
  ENGINE)` are unchanged (`SD` `.../scienceflow-engine-bridge.ts:839-845`,
  `research-run.ts:1787-1789`): the interpreter and source binding stay exactly
  what R11 verified for the supervisor. What that does **not** cover is the
  children; §3.6 is the separate assembly for them.
- **[todo]** If the frozen inputs ever declared a stage endpoint, the bridge's
  manifest/task key sets already refuse it (§1.1). The slice re-checks the
  derived launch manifest for the same key names as a second, cheap gate, and
  refuses the start rather than trusting the first check.

What the gateway accepts inbound is a fixed subset of chat-completions —
`model`, `messages`, `tools`, `tool_choice`, `parallel_tool_calls`,
`max_tokens`/`max_completion_tokens` (exactly one, mandatory, within the
ceiling), `temperature`, `top_p`, `seed`, `frequency_penalty`, `stop`, `n = 1`,
`stream`, `stream_options: {include_usage: true}`. Any other field, an image
part, a non-allowlisted `model`, or `n != 1` is refused with a typed 400; the
engine sees a non-retryable `BadRequestError` and the task fails fast instead of
retrying. `reasoning_effort` (a Gemini-only field in this client, `SF-DEP`
`text_stream.py:37-38`) is deliberately outside the subset: a model that needs
it is outside the allowlist for this slice.

The body is forwarded **unmodified**: the gateway is a pass-through to an
OpenAI-compatible endpoint and does not translate protocols in this slice. That
is a deliberate narrowing, because it keeps "bytes the gateway read" equal to
"bytes the gateway forwarded", which §5 depends on; a provider that needs a
native protocol is outside the allowlist until a later round defines the
translation and its own accounting.

**[todo] The upstream leg is one request, not a client call.** The gateway
issues exactly one `undici.request` — its own transport, no retry loop, no
protocol selection, no thinking-control fallback — with the validated bytes, the
configured upstream `Authorization` header and a streaming response body that
is relayed to the sandbox connection as it arrives. `streamModelTurn` is
deliberately **not** used: it reserializes the request, its `requestWithRetry`
defaults to two retries and it can reissue a 400-triggered fallback (§2). The
provider's final `usage` chunk is parsed from the relayed stream with
`normalizeUsage` and settled under §5.3. "The gateway has no retry loop" is
therefore a property of the transport chosen, not a promise about a client it
reuses.

`max_tokens` deserves its own rule: the engine's `max_tokens` is a stage default
(`SF` `.../contracts/schema.py:26`, `32768`), the manifest cannot carry one, and
the bridge never sets a config file. A request above the gateway ceiling is
refused, and the ceiling is therefore configured at or above the engine default
— refusing it after the run starts would turn a configuration mistake into a
research failure.

### 3.4 The minimal sandbox change, and its attack surface

Exactly one new seccomp variant, Runner-selected for this workload kind:

- **[todo]** `research-gateway` = the research variant plus **two**
  argument-checked blocks, and *minus* the entries that block an ordinary TCP
  client. Concretely, on x86_64 remove `41, 42, 43, 49, 50, 288` from the deny
  list and prepend the `socket()` block for `41` and the `socketpair()` block
  for `53`; on arm64 remove `198, 200, 201, 202, 203, 242` and prepend the
  blocks for `198` and `199` (`SD` `services/runner/src/seccomp.ts:52-55`,
  `:58-72`). The blocks reuse the existing `instruction()` builder, the
  `socketpair` precedent (`:147-159`) and one `BPF_ALU_AND_K` helper: for
  `socket()`, `domain == AF_INET` **and** `type & 0x0f == SOCK_STREAM`; for
  `socketpair()`, `domain == AF_UNIX` **and** `type & 0x0f == SOCK_STREAM`
  **and** `protocol == 0`. Anything else is `EPERM`.
- **The `socketpair` type/protocol check is new, and it is the point.** The
  current `research` variant checks only `socketpair`'s domain
  (`SD` `services/runner/src/seccomp.ts:147-159`), so
  `socketpair(AF_UNIX, SOCK_DGRAM, …)` would still succeed there. Revision 1
  repeated "`socketpair` keeps its `AF_UNIX`-only rule" and then claimed that
  "no Unix socket can be created"; both statements were wrong. The new variant
  reads `sockaddr`-free scalar arguments only — `args[0]` at offset 16,
  `args[1]` at 24, `args[2]` at 32 of `struct seccomp_data` — so the datagram
  and raw pair routes are refused in the filter. This design does not widen the
  existing `research` variant; it defines a stricter variant for this workload.
- **What a permitted pair can do, exactly.** Both ends are created by the
  caller and are already connected to each other, in the same process tree.
  The required property is that no permitted endpoint can be re-targeted to a
  host service. G15 measures `connect`, `bind`/`listen`, addressed
  `sendto`/`sendmsg`, and descriptor-passing routes rather than assuming an
  errno. An addressed operation may fail or communicate only with the original
  peer; neither outcome may deliver data or descriptors to a host service.
  Datagram pairs are refused by the type check. Normal stream-pair self-IPC
  must continue to work, because the engine's asyncio loop needs it. This is a
  conditional isolation argument until those routes have been measured.
- **`AF_UNIX` stays denied for `socket()`.** A process cannot create *a socket
  that can name a filesystem or abstract Unix peer* without `socket(AF_UNIX)`,
  so that denial holds no matter what appears in `/workspace`,
  `/scienceflow-engine`, the control directory or the managed environment
  prefix, before or during the run. The `socketpair` route is separate and is
  bounded by the paragraph above.
- **`SOCK_RAW` and `SOCK_DGRAM` are denied by the same blocks**, through the
  masked type test — not only by `--cap-drop ALL`. Both barriers are stated
  separately because they fail differently: the capability is a namespace
  attribute that a future launch option could widen, whereas the type test is
  in the filter.
- **This argument is conditional, not measured.** This round ran no sandbox
  attack. G15 tests host reachability rather than assuming errno behaviour for the
  pair routes against a live host service. If any route reaches a host
  endpoint, the no-bypass claim stays **blocked** and the variant is not
  accepted; the design does not fall back to "the service was not running".
- **Unchanged:** `--unshare-all`, `--unshare-user`, `--cap-drop ALL`,
  `--clearenv`, `--die-with-parent`, `--ro-bind /usr`, the interpreter masks,
  `--seccomp` at fd 3 (`SD` `executor.ts:962-998`). There is no `--share-net`,
  no blanket network variant, and no disabled filter.
- **Why loopback is enough:** the forwarder binds `AF_INET` on `127.0.0.1` in a
  `--unshare-all` sandbox on the audited egress path (`SD`
  `egress-bridge.ts:127-130`), and that path has a positive end-to-end test: a
  real `bwrap` child with the `network` filter fetches through loopback, while
  the same target from a sandbox with the baseline filter and no bridge fails
  closed (`SD` `services/runner/src/sandbox-network.test.ts:222-289`). What is
  **not** yet proven is this variant's two argument-checked blocks, which is
  why G12–G16 and G23–G29 are part of the slice (§7.3).

Attack surface added, stated plainly:

| Surface | Consequence | Why it is acceptable |
| --- | --- | --- |
| Workload may create `AF_INET`/`SOCK_STREAM` sockets and `connect()` | It can only reach addresses that have a route — inside a fresh netns, only `127.0.0.1` | [code] no interface other than loopback exists; `AF_NETLINK` is denied, so no route or interface can be created even with the namespace's `CAP_NET_ADMIN` |
| Workload may `bind`/`listen` on loopback | It can talk to itself, and could shadow the forwarder's port | The forwarder binds before forking, so the port is taken. Untrusted workload code can fabricate any result anyway; it cannot reach an upstream model without the gateway |
| Workload can read the per-run token in `models.json` | It holds its own allowance | The token is bound to one execution and expires; the upstream key is never in the sandbox |
| Workload can talk to the gateway directly over loopback | It speaks chat-completions to the same gateway | Metering and attribution are unchanged; the forwarder is transport, not the enforcement point |
| A second interpreter + stdlib mounted for the forwarder | A read-only interpreter the workload did not have | [code] already mounted on the audited egress path (`egress-bridge.ts:235-242`); no writable path is added |
| The tunnel descriptor is live in the sandbox during the run | With fd 4 a workload could write frames itself | It reaches the same gateway with the same token requirement; the forwarder marks fd 4 non-inheritable in its child, and G24 asserts the workload sees `EBADF` |
| Workload may create `AF_UNIX`/`SOCK_STREAM` socketpairs | Required guarantee: self-IPC only, as `asyncio` needs | Datagram/raw pairs are refused by the type mask; G15 must establish that every permitted pair route stays confined to its original peer (§3.4) |

The primitives that do **not** exist and must not be claimed: seccomp cannot
filter `connect()` by destination address (its argument is a pointer), and the
current filter has no `SECCOMP_RET_USER_NOTIF` broker. The no-bypass property
therefore rests on (a) no socket that can name a host Unix peer being
creatable — `socket(AF_UNIX)` is denied and `socketpair` is reduced to
self-connected stream pairs, (b) the namespace having no route off-host, and
(c) exactly one `AF_INET` listener of interest. If a later deployment adds any
interface to the sandbox namespace, reuses this variant with `--share-net`,
re-admits `AF_UNIX` for `socket()`, or relaxes the `socketpair` type/protocol
test, the guarantee is void and the start must be refused.

### 3.5 Why the workload cannot bypass the gateway

The argument is a property of the sandbox, not a promise about the engine.

**Every mount in the research launch** (`SD` `executor.ts:962-998`, in argument
order, with `research-run.ts:1746-1780` supplying the last group):

| Sandbox path | Source | Mode | Host-backed | Reaches in under this design |
| --- | --- | --- | --- | --- |
| `/usr` (+ `/bin`, `/lib`, `/lib64` symlinks) | host `/usr` | ro | yes | no unix socket reachable (means of §3.4) |
| host runtime-support binds | host paths (`hostRuntimeSupport`) | ro | yes | same |
| `/proc` | proc mount per `procMode` | — | kernel | same |
| `/dev` | fresh devtmpfs | rw | kernel | same |
| `/tmp` | tmpfs | rw | no | sandbox-private |
| managed environment prefix | `environment.prefixPath` | ro | yes | same |
| `/scienceflow-gateway` | per-execution config directory (`models.json`) | ro | yes | same — the token is readable there by design, the upstream key never is |
| forwarder interpreter + stdlib | host probe (`egress-bridge.ts:147-200`) | ro | yes | same |
| `/workspace` | `request.workspaceRoot` | rw | yes | same |
| `RESEARCH_CONTROL_MOUNT` | control channel dir | rw | yes | same |
| `RESEARCH_INPUTS_MOUNT` | Runner's input copy | ro | yes | same |
| `/scienceflow-engine` | `engine.sourceRoot` | ro | yes | same; its `.venv`, if the host has one, is masked by an empty tmpfs (§3.6) |
| `RESEARCH_ENGINE_STATE_MOUNT` | per-execution engine state | rw | yes | same |
| skill roots | packages (ro) / extensions (rw) | mixed | yes | same |

**Inherited descriptors:** `0`, `1`, `2` are pipes; `3` is the seccomp program
handed to bwrap with `--seccomp 3`; `4` is the model tunnel. Nothing else is
passed: the bwrap spawn uses exactly those five stdio entries (`SD`
`executor.ts:1456`). Whether bwrap keeps `3` and `4` open for the payload is
measured by G24/G25, not assumed.

The argument, in five parts:

1. **No socket that can name a host Unix peer can be created.**
   `socket(AF_UNIX, …)` returns `EPERM`, and `socketpair` is reduced to
   self-connected `SOCK_STREAM` pairs (§3.4). Connecting to a filesystem or
   abstract name requires a socket with a free address, so *every* host-backed
   mount in the table above is inert as an IPC path, and a socket that appears
   during the run changes nothing.
2. **No route off-host.** `socket()` accepts only `AF_INET`/`SOCK_STREAM`; the
   namespace contains only loopback; `AF_INET6`, `AF_NETLINK` and `AF_PACKET`
   are denied, and raw/packet sockets are additionally excluded by
   `--cap-drop ALL` (`executor.ts:969`). A future `--share-net` would void this
   and must be refused at the launch boundary.
3. **One reachable peer.** The only `AF_INET` listener in the namespace is the
   forwarder, whose only peer is descriptor `4` of the per-attempt gateway
   (`egress-bridge.ts:100-111`). The gateway is the only process holding an
   upstream credential.
4. **One credential, one allowance.** Every request carries the per-run token;
   the gateway refuses anything else with the same typed 401 for unknown,
   foreign, expired and revoked tokens. The upstream key exists only in the
   Runner's trusted configuration.
5. **Every child is inside the same namespace.** Task workers, prep workers and
   the report subprocess are children of the supervised engine in the same
   sandbox (`SF` `.../subprocess.py:24-58`, `.../control/reporting/__init__.py:46-56`).
   A child cannot leave the namespace; `setsid()` changes a session, not a
   namespace.

Denial evidence is part of the acceptance matrix (§7.3), not an assumption. The
review asked for a test that cannot pass by luck: **live** host IPC services are
created inside the mounted workspace before the launch — a stream listener on a
filesystem path, a stream listener on an abstract name, and a **datagram**
listener on a filesystem path — and the sandboxed process must fail while they
answer a host-side probe. G15 tries every creation route: plain
`socket(AF_UNIX, …)`, `socketpair(AF_UNIX, SOCK_DGRAM, …)`, a permitted stream
pair followed by an addressed `sendto`/`sendmsg`, and a socket that appears in
the workspace **during** the run; each must fail at creation or at the
addressed operation. A second test connects from the sandbox to a host LAN
address to prove the namespace has no route (G12), and a third proves the
workload cannot reach the tunnel descriptor (G24).

Residual limits that remain true after this design:

- The workload shares the gateway's allowance by construction. A compromised
  engine can spend its own budget; it cannot spend another execution's.
- The gateway cannot stop the workload from *choosing* not to call a model.
- `sys.path[0]` would be `cwd` for `-m`, so a `scienceflow/` package left in
  the workspace could replace the engine entry for children. Revision 1
  downgraded that to "result integrity" and deferred `PYTHONSAFEPATH`; revision
  2 treats it as a source-identity gap and closes it by argument, not a scan:
  the engine's `-m` children run with `-P`, so `cwd` is never prepended, and
  `PYTHONPATH=/scienceflow-engine` is first (§3.6). Research code run as the
  engine's own shell subprocesses keeps its current import behaviour.
- A host administrator is outside every boundary here, as in
  `controlled-execution.md` §0.1.
- The gateway is not a sandbox for the provider's content: a malicious provider
  response is a research-quality problem, not a budget one.

### 3.6 Interpreter and source binding for every client process

This section closes R17-04. It is a prerequisite of the gateway, not an
optional refinement: a child that cannot import the engine, or that imports a
different one, is a client the gateway's configuration never reaches.

**What revision 1 got wrong.** It proposed `PYTHONPATH=/scienceflow-engine` and
asserted that the lease environment carries no checkout `.pth`. That conflicts
with the gate that already runs before a research spawn:
`verifyScienceFlowSourceBinding` runs a static probe with `-I -S -B`, and
`assessStaticProbeFacts` accepts a source root only when the environment's
`.pth` has a path line naming it and the single `scienceflow` candidate
resolves there (`SD` `scienceflow-runtime-check.ts:610-709`, `:940-946`). `-I`
also makes `PYTHONPATH` invisible to that probe, so it cannot see the assembly
revision 1 proposed. The fixtures the R11 tests use are built with exactly such
a `scienceflow.pth` (`SD` `scienceflow-engine-integration.test.ts:189-200`), so
"no `.pth`" described a substitute environment, not a provisioned lease. The
new assembly must therefore **keep** that gate, not route around it.

**Two proofs, in one lease, answering different questions:**

| Proof | Launched as | What it proves | What it cannot say |
| --- | --- | --- | --- |
| **S** — the existing R11 gate, kept and not deleted | static probe `-I -S -B`; checkout bound at `binding.sourceRoot`; the lease's `.pth` visible | the lease interpreter is the declared one; the `.pth` maps `scienceflow` to that checkout; no import line, `sitecustomize`, duplicate or non-regular candidate; revision and cleanliness | it runs before the research mounts, so it says nothing about `/scienceflow-engine` or about child flags |
| **R** — the research-layout probe (new) | a separate supervised sandbox launch, same lease, same mounts as the run, `-P -B -` with the run's environment (`PYTHONPATH=/scienceflow-engine`) | under the exact child flags, `find_spec("scienceflow")` resolves to `/scienceflow-engine/scienceflow/__init__.py` and both `-m` targets are importable; a pre-planted `/workspace/scienceflow/` does not change that | it is not the run; the run's own record is judged separately |

Both run in the same environment lease, before the engine process exists, in
that order: S first, R only after S passes. A failure of either refuses the
start. S is not replaced by R: S answers "which bytes are the engine for this
environment", R answers "does the child assembly reach those bytes". R may run
a normal start because the site configuration it loads is exactly what S just
vetted; if S found an import line, a `sitecustomize` or a non-path `.pth`
entry, R never runs.

**[todo] The assembly:**

1. **The gate's source root is the mount source.** `engine.sourceRoot` must
   equal `binding.sourceRoot` (already refused otherwise, `SD`
   `research-run.ts:1614-1622`), and the launch records that the
   `/scienceflow-engine` mount is backed by that host directory in the path map
   of `controlled-execution.md` §4.4. A lease without a `.pth` naming the
   checkout is misconfigured and is refused by S; the design does not invent a
   second provenance route.
2. **Children get the fixed mount path.** `PYTHONPATH=/scienceflow-engine` is
   added to the sandbox environment. It is a Runner-fixed constant, never a
   host path, and reaches `python -m` children through `os.environ.copy()`
   (`SF` `.../state/subprocess_runtime.py:92-107`). The supervisor is
   unaffected: `-I` ignores it and keeps its explicit `sys.path.insert`
   (`SD` `scienceflow-engine-bridge.ts:839-845`).
3. **`cwd` cannot win.** The engine's own `-m` children are launched with `-P`
   before `-m`: prep and task worker in `child_cli_argv`
   (`SF` `.../execution/subprocess.py:24-58`) and the report child in
   `.../control/reporting/__init__.py:46-56`. `-P` stops Python from prepending
   `cwd`, so `/workspace` can never supply the entry package. This is a
   **tracked engine change** (`controlled-execution.md` §3.6 gains it), not
   something this round built: the pinned revision must carry it before a real
   start. The engine already classifies `-P` as a no-argument flag
   (`SF` `runtime/core/process/commands.py:57`) and requires Python `>=3.11`,
   where it exists (`SF` `pyproject.toml:12`).
4. **Research code is not the engine entry.** The engine runs research code as
   its own shell subprocesses (`SF`
   `research/onboarding/support/preparation/validation.py:46-47`); their argv
   is not built by `child_cli_argv`. They inherit `PYTHONPATH` but not `-P`, so
   a script run from `/workspace` still imports its siblings as it does today.
   Such a subprocess may resolve its own `scienceflow` package from its script
   directory or `cwd`; its code is untrusted research code. The verified source
   guarantee applies to the engine's prep/task/report entry processes launched
   with `-P`, not to arbitrary research programs. Those programs cannot change
   which package was used to enter the already-running engine worker, and they
   remain subject to the same egress and gateway authorization boundaries.
5. **The checkout's `.venv` is masked.** `resolve_project_python()` would
   otherwise return `/scienceflow-engine/.venv/bin/python` when the host
   checkout has one (`SF` `runtime/environment.py:27-54`). An empty tmpfs over
   `/scienceflow-engine/.venv` makes the walk fall back to `sys.executable`
   deterministically. **[dyn]** bwrap must accept a `--tmpfs` whose target does
   not exist; if it does not, the start is refused when the host checkout
   carries a `.venv` — the design does not run an unverified interpreter.

The roles, after items 1–5, with the `sys.path` each actually sees (the lease's
`.pth` line still names the host checkout path; in the research layout that
entry is dangling and contributes nothing):

| Role | argv | `sys.path` | Where the engine comes from |
| --- | --- | --- | --- |
| supervisor (bridge) | leased/fixture interpreter, `-I -B -` | `['/scienceflow-engine', …]` | explicit `sys.path.insert`, unchanged |
| prep / research task | `resolve_project_python()`, `-P -m …` | `['/scienceflow-engine', …, <lease site-packages>, <dangling .pth line>]` — no `cwd` | `PYTHONPATH`, first |
| reporting child | `sys.executable`, `-P -m scienceflow.runtime.parallel.control.reporting` | the same list as the task child | `PYTHONPATH`, first |
| research shell subprocess | whatever the workload runs | its own; `cwd`/script directory as today | not source-verified; script directory or `cwd` may win over `PYTHONPATH` |

**The probe's own facts.** R is a separate supervised launch with its own
boundary capture, like the R11 probes (`SD` `scienceflow-runtime-check.ts:443-554`);
it is not a step inside the research process. It writes one record —
`sys.executable`, `sys.prefix`, the interpreter flags, the origin
`find_spec("scienceflow")` reports, `find_spec` for
`scienceflow.runtime.parallel.execution.task_worker` and
`scienceflow.runtime.parallel.control.reporting`, and `cwd` — stored with the
execution's evidence and reported in the redacted form of §5.5. Classification
is explicit:

- probe ran, terminated, facts match the mount → the engine may start;
- probe failed → `research: not_started`; the probe **process** existed, so the
  execution's process fact is `terminated`, or `unknown` if termination is
  unproven — never "process not started";
- termination unproven → the environment is fenced through the existing
  `reserveRuntimeCheck` path (`SD` `research-run.ts:1638-1645`) and the run is
  `unknown`, not `not_started`.

What this does not do: it does not install the engine, add a `sitecustomize`,
or move the source binding into a writable directory. It requires one tracked
engine patch (`-P`) and keeps the `.pth` that S already verifies as the sole
source binding. G23 and G25 decide the real deployment, including the `.venv`
and pre-planted-shadow cases.

## 4. Identity and credential ownership

### 4.1 One identity tuple, one authority, one token

**[todo]** The public identity stays small, but it is not the authority. The
gateway's authority row is the whole tuple below, and it is written once, at
issuance, from the **accepted request snapshot** the Runner already holds — never
from an HTTP header, a body field, or a manifest.

```text
ModelGatewayAuthority = {
  executionId, attempt, gatewayGeneration,      // the public tuple
  sessionId, agentId,                            // the accepted owner
  permissionEpochId, environmentRevisionId,      // the accepted permission epoch
  requestDigest,                                 // the accepted request, byte for byte
  runnerInstanceId,                              // this ledger's identity (survives restarts)
  runnerBootId                                   // this process (minted anew on every boot)
}
```

| Element | Accepted source |
| --- | --- |
| `executionId` | the record identity, `^[A-Za-z0-9_:.-]{1,160}$` (`SD` `execution-manager.ts:377`, `research-run.ts:265-267`) |
| owner (`agentId`, `sessionId`) | `submitInternal` derives it as `{ agentId, sessionId: request.permissionEpoch.sessionId }` and stores it in the `executions` row's own columns (`SD` `execution-manager.ts:390`, `:427`) |
| `permissionEpochId`, `environmentRevisionId` | the `permissionEpoch` object of the request accepted for this execution (`SD` `packages/schema/src/research-run.ts:118`; the epoch's `environmentRevisionId` is also checked at spawn, `SD` `executor.ts:1523-1529`) |
| `requestDigest` | `receipt.requestDigest`, the digest of the whole accepted request (`SD` `execution-manager.ts:391`, `:402`) |
| `attempt` | the engine's attempt; v1 allows exactly one (`controlled-execution.md` §4.2), recorded by the bridge as `engine.attempt` (`SD` `packages/schema/src/research-run.ts:219-232`) |
| `gatewayGeneration` | minted by the Runner at spawn; `1` in v1, never re-issued |
| `runnerInstanceId` | `execution_metadata.runnerInstanceId`, created on first use and preserved across restarts (`SD` `execution-manager.ts:288-292`). It identifies the **ledger**, and receipts depend on it; it cannot distinguish two boots |
| `runnerBootId` | minted at process startup and written to `execution_metadata` in the same startup transaction, overwriting the previous boot's value. This — not `runnerInstanceId` — is what revokes a previous process's credentials |

**What the epoch means here, and what it does not.** The accepted epoch is the
authority under which the execution was admitted, so the gateway binds to that
epoch id, its `environmentRevisionId` and the request digest. Revocation the
Runner can enforce is the stop intent; revocation the API performs by rotating
the session's epoch is refused while a run is active (`SD`
`services/api/src/http/index.ts:3254`: `409 Cannot rotate permissions during an
active run`). A rotation that bypasses that route — a store edit, a restored
catalog — is **not observable by the Runner** and is outside this boundary; the
design says so instead of implying a re-check it cannot perform. The gateway
never accepts an epoch id, owner or digest supplied by a request.

**Admission re-checks, in the same transaction as the reservation (§5.2):**

1. the authority row for `(executionId, attempt, gatewayGeneration)` exists;
2. its `token_digest` equals `sha256(presented token)`;
3. its owner, `request_digest`, `permission_epoch` and `environment_revision`
   still equal the `executions` row for that id, the credential's
   `runner_instance` equals this ledger's `runnerInstanceId`, **and** its
   `runner_boot` equals this process's `runnerBootId`;
4. the execution record is not terminal and the attempt is the current one;
5. `revoked_at IS NULL` and `now < expires_at`.

All five failures answer identically (`401 MODEL_GATEWAY_TOKEN_INVALID`), so a
probe learns nothing about which one failed. The digest is compared as hex; the
token itself is never compared, logged or returned.

**Revocation order.** The stop intent is persisted first (`SD`
`execution-manager.ts:861-888`), and the same durable write — one
`BEGIN IMMEDIATE` transaction — sets `revoked_at` and `revoke_reason` on the
authority row. An admission takes the same write lock, so a stop and an
admission serialize **in the database**. What the lock does not serialize is the
dispatch: the upstream write happens after the admission commits, outside any
transaction.

The guarantee is therefore bounded by `maxInFlight`, not by "one request":

- **The stop commits first.** No admission after it can pass the authority
  check. The requests already admitted are at most `maxInFlight` rows. Each
  re-reads `revoked_at` immediately before writing its first upstream byte; one
  that sees the revocation becomes `not_dispatched` (no byte was written) or
  `unknown` (the byte may have been written — the re-read and the write are not
  atomic). None is replayed.
- **The admission commits first.** Its dispatch may start. At most
  `maxInFlight` admissions can be in that position, each with its own
  reservation; every one is charged, none is released.
- **After the stop is durable.** No new admission is possible; the requests that
  can still produce an upstream byte are the admitted set at the moment of the
  stop, whose size the admission transaction bounded by `maxInFlight`.

The database transaction and the network write are not one atomic system, and
the design does not claim they are. What it guarantees is a finite, counted
window — at most `maxInFlight` already-admitted requests, each charged `unknown`
or `not_dispatched`, and no request after the stop.

Token: 32 random bytes, hex encoded. The ledger stores `sha256(token)` only —
the same discipline as `launchTokenDigest` (`SD`
`docs/en/design/scienceflow-controlled-execution.md` §4.2). The plaintext exists
in exactly two places: the Runner's in-memory record for the attempt, and the
sandbox-readable `models.json`.

Lifecycle:

| Event | Behaviour |
| --- | --- |
| Admission | Any of the five checks fails → `401 MODEL_GATEWAY_TOKEN_INVALID`; the same response for "unknown", "foreign" and "revoked" |
| Issuance | After the §3.6 proofs S and R pass, immediately before spawn, and after the in-gate verification of §4.7 of `controlled-execution.md`; never before, never on request |
| Expiry | `expires_at = min(attempt deadline, hardDeadline)`. A request whose remaining time runs out is aborted and answered `408 MODEL_DEADLINE_EXCEEDED`; a request after expiry is `401` |
| Revocation | On a durable stop intent, on terminal record, on proven termination, on Runner shutdown. In-flight requests are aborted and charged |
| Cancellation | The gateway aborts the upstream request; the row becomes `unknown` (§5.3) |
| Runner restart | **v1 does not resume.** Startup first revokes every authority row whose `runner_boot` is not this boot (reason `runner_restart`), reconciles every `reserved` reservation to `unknown` (§5.3), and only then serves. No generation or token is re-issued for the old execution, and no request is replayed. `runnerInstanceId` is unchanged and does **not** distinguish the boots; `runnerBootId` and `revoked_at` do |
| Attempt 2 | Not authorized in v1. `attempt` stays `1`; a second attempt would need a newly accepted execution/start decision and is outside this slice. Section §5.6 trace E is rewritten to say so |
| Gateway disconnect | The client sees a connection error; a dispatched request is charged as unknown |
| Attempt end | The tunnel is closed and the pair is dropped after termination is proven; a later connection attempt finds no endpoint and no live generation |

### 4.2 Where the credential lives

- **Upstream credential:** the Runner's trusted configuration, following the
  existing loader shape (one environment variable names one JSON file, read once
  at startup, static errors, no partial table — `SD`
  `services/runner/src/scienceflow-runtime-config.ts:19-45`). This round does
  not build a secret store: the file is `0600`, Runner-owned, and the design
  states that a deployment needing rotation or a vault must add one before a
  real start.
- **Per-run token:** plaintext in the sandbox `models.json`; the digest in the
  ledger, in one durable row per generation:

```sql
CREATE TABLE model_gateway_credentials (
  execution TEXT NOT NULL, attempt INTEGER NOT NULL, generation INTEGER NOT NULL,
  token_digest TEXT NOT NULL,                  -- sha256(token), hex
  session TEXT NOT NULL, agent TEXT NOT NULL, request_digest TEXT NOT NULL,
  permission_epoch TEXT NOT NULL, environment_revision TEXT NOT NULL,
  runner_instance TEXT NOT NULL, runner_boot TEXT NOT NULL,
  issued_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  revoked_at TEXT, revoke_reason TEXT,
  PRIMARY KEY (execution, attempt, generation)
);
```

  This is the row §4.1 reads on every admission; there is no other authority
  state. `runner_boot` names the process that issued the token; the startup
  transaction revokes every row whose value differs from the current boot
  before the gateway serves, so a restarted Runner cannot honour an old token
  even if the row survives. Never in a public DTO, never in ledger evidence,
  never in an artifact, never in a log line.
- **Provider endpoint:** a digest and the model id may be persisted; the URL
  itself stays in the Runner's config, consistent with the "no host paths"
  rule of `controlled-execution.md` §4.2.

### 4.3 Placement

- **Single host (the only shape this round reasons about in detail).** The
  gateway lives inside the Runner process, like the egress gateway registry
  (`SD` `services/runner/src/egress-gateway.ts`). One Runner process, one
  attempt, one tunnel pair.
- **Remote API/Runner.** Nothing in this design requires the API: the gateway,
  the credential and the ledger all live on the Runner. Provisioning the
  trusted config on a remote Runner host, and its rotation, are **not
  validated** and remain a deployment prerequisite, not a claim.
- **Native Windows** is out of scope: the research workload and its seccomp
  profile are Linux-only today (`SD` `research-run.ts` refuses unsupported
  sandboxes with `RESEARCH_SANDBOX_UNSUPPORTED`).

## 5. Enforceable limits and accounting

### 5.1 Units and authorities — what is enforced, what is only measured

| Dimension | Unit | Who measures | Enforced before forwarding | Enforced at all in this slice |
| --- | --- | --- | --- | --- |
| Admissions | HTTP requests | gateway | yes | **yes** — `maxRequests` per execution |
| Inbound body bytes | bytes of the request body the gateway read | gateway (reads the whole body first) | yes | **yes** — `maxInputBytes` per execution |
| Forwarded body bytes | bytes the gateway writes upstream | gateway | after the fact | **measured, not separately capped**: the body is forwarded verbatim by §3.3, so the body ceiling is `maxInputBytes`; the difference is a fixed request-line and header allowance |
| Concurrent in-flight | requests | gateway | yes | **yes** — `maxInFlight` |
| Per-request wall clock | ms | gateway, bounded by the run deadline | yes | **yes** |
| Output tokens per request | tokens | provider, bounded by the `max_tokens` the gateway injected or validated | the parameter is enforced; its effect is a provider contract | **parameter only** — a provider that ignores it is charged as unknown (§5.3) |
| Provider-reported input tokens | tokens | provider | no | **accounting only** |
| Provider-reported output tokens (settlement) | tokens | provider | — | **accounting only**, capped at the reservation |
| Spend | currency | nobody | no | **no** |

**A claim in the first draft is withdrawn.** It said "input tokens ≤ request
body bytes is a guaranteed bound, because every token covers at least one
byte". That is not a proof: tokenization is provider-specific, chat and tool
templates add text the body does not contain, a provider may prepend its own
system content, and this design changes the protocol boundary (pass-through to
one OpenAI-compatible endpoint, §3.3) without fixing a tokenizer. A body-byte
ceiling is therefore a bound on **bytes**, not on tokens. Anyone needing a
token ceiling must first name the provider, the model, the tokenizer, the
template and the provider's output semantics; until then the token dimension
stays **accounting only** and B3's token half is not claimed (§7.4).

Nothing in a request, a manifest, a plan or a permission epoch can change a
limit. `SD` `services/api/src/scienceflow/execution-contract.ts:1292-1317`
already records budgets as `nature: "requested"`; that stays true, and this
gateway is what later makes any of them enforced.

Spend is explicitly **not promised**. The API has pricing and an estimated cost
(`SD` `services/api/src/model-usage.ts:386-409`; `SD`
`packages/schema/src/model-usage.ts:167-191` with `usageStatus: reported |
unreported`), but pricing is per-model catalog data with a currency, and the
Runner's trusted config is not that catalog. A currency guarantee would need an
authority the Runner does not have, so cost stays **post-hoc estimation by the
existing API accounting**.

Defaults are configuration, not constants of the contract. The **budget**
limits are scoped to the execution, not to the attempt, so a restart cannot
re-open them; the **transport** limits are scoped to the attempt, because the
tunnel dies with it:

| Limit | Default (proposal) | Scope | Where it may be set |
| --- | --- | --- | --- |
| `maxRequests` | 500 | execution | Runner trusted config only |
| `maxInputBytes` | 8 MiB | execution | Runner trusted config only |
| `maxOutputTokens` | 200 000 | execution | Runner trusted config only |
| `maxInFlight` | 4 | execution | Runner trusted config only |
| `maxBodyBytes` | 1 MiB | request | Runner trusted config only |
| `perRequestTimeoutMs` | 300 000 | request | Runner trusted config only |
| `upstreamDispatchesPerAdmission` | `1`, fixed | admission | not configurable |
| `maxConnections` | 16 | attempt | Runner trusted config only |
| `maxHeaderBytes` | 16 KiB | request | Runner trusted config only |
| `bodyReadTimeoutMs` | 30 000 | request | Runner trusted config only |
| `unauthenticatedTimeoutMs` | 10 000 | connection | Runner trusted config only |
| `maxBufferedBytes` | `maxInFlight × maxBodyBytes`, derived | attempt | not configurable |

### 5.2 Admission: one row is the only source, totals are aggregates

**[todo]** The reservation table joins the credential table of §4.2 in the
Runner's existing SQLite ledger, in the same `BEGIN IMMEDIATE` style as
`submit()` (`SD` `execution-manager.ts:251-259`, `:414-428`). There is **no**
counter table: the first draft kept running counters next to rows, and a
settlement that adjusted one and not the other is how double counting happens.
Here a row records what happened and the totals are derived, so they cannot
disagree.

```sql
CREATE TABLE model_reservations (
  id TEXT PRIMARY KEY,                 -- one per admitted HTTP request
  execution TEXT NOT NULL, attempt INTEGER NOT NULL, generation INTEGER NOT NULL,
  state TEXT NOT NULL,                 -- reserved | settled | unknown | not_dispatched
  input_bytes INTEGER NOT NULL,        -- the request body bytes the gateway read
  output_tokens INTEGER NOT NULL,      -- the max_tokens the gateway forwarded
  dispatched INTEGER NOT NULL DEFAULT 0,
  reported_input_tokens INTEGER, reported_output_tokens INTEGER, cache_read_tokens INTEGER,
  over_output INTEGER NOT NULL DEFAULT 0,   -- provider reported more than output_tokens
  refusal TEXT, created_at TEXT NOT NULL, settled_at TEXT
);
CREATE INDEX model_reservations_execution ON model_reservations (execution, state);
```

**Charge, by state, with units named:**

| State | Requests | Inbound bytes | Output tokens charged |
| --- | --- | --- | --- |
| `reserved` | 1 | `input_bytes` | `output_tokens` (the full reservation) |
| `settled` | 1 | `input_bytes` | `min(reported_output_tokens, output_tokens)` |
| `unknown` | 1 | `input_bytes` | `output_tokens` |
| `not_dispatched` | 1 | `input_bytes` | `0` |

A row is never deleted: `not_dispatched` is a real state, because an admitted
request that never reached a provider still consumed an admission and its bytes.
Reported counts never *increase* headroom beyond what the reservation released,
and a reported input token count is never used in a ceiling.

The totals the admission transaction reads:

```sql
SELECT count(*) AS requests,
       coalesce(sum(input_bytes), 0) AS bytes,
       coalesce(sum(CASE
         WHEN state = 'settled' THEN min(coalesce(reported_output_tokens, 0), output_tokens)
         WHEN state = 'not_dispatched' THEN 0
         ELSE output_tokens END), 0) AS out_tokens,
       coalesce(sum(state = 'reserved'), 0) AS in_flight
  FROM model_reservations WHERE execution = ?;
```

**Admission is two steps: a bounded read outside the ledger, then one short
transaction.**

```text
1. outside any transaction — the transport:
   parse the request line and headers; refuse above maxHeaderBytes
   authenticate the bearer token by digest; no body is read before this
   read the body to maxBodyBytes under bodyReadTimeoutMs
   validate the allowlist and take out = max_tokens (mandatory)
   buffer at most maxInFlight bodies at once; other connections wait, counted
   against maxConnections; close an unauthenticated connection at
   unauthenticatedTimeoutMs

2. BEGIN IMMEDIATE
   authority = SELECT … FROM model_gateway_credentials
                 WHERE execution = ? AND attempt = ? AND generation = ?
   -- the five checks of §4.1 must all pass, or 401
   execution = SELECT session, agent, record FROM executions WHERE id = ?
   -- must exist, not terminal, owner and receipt.requestDigest must match
   used = SELECT … FROM model_reservations WHERE execution = ?   (the aggregate)
   reject MODEL_BUDGET_EXHAUSTED unless:
       used.requests   + 1        <= maxRequests
       used.bytes      + body     <= maxInputBytes
       used.out_tokens + maxTokens <= maxOutputTokens
       used.in_flight  + 1        <= maxInFlight
   INSERT model_reservations(id, …, state='reserved', input_bytes=body,
                             output_tokens=maxTokens, dispatched=0)
   COMMIT

3. after the commit, outside the transaction: one dispatch, preceded by the
   revocation re-read of §4.1
```

**Why the body is not read inside the transaction.** Revision 1 read it there.
The body comes from an untrusted client and may trickle for a long time; holding
the ledger's single writer while waiting would block every other execution's
records, the stop intent and the revocation, and `maxBodyBytes` bounds size, not
waiting time. The body is therefore read and validated first, under its own
byte, time and concurrency bounds, and the transaction contains no network
await and no provider call. The cost is that the aggregate is read *after* the
body arrives — which is the order this design wants: the reservation is decided
against the state at admission time, not against a state captured before a slow
upload.

The check and the insert are in the same write transaction, so two concurrent
admissions cannot both read the pre-insert total: SQLite serializes writers, and
a blocked writer that exceeds `busy_timeout` is a `503
MODEL_GATEWAY_LEDGER_UNAVAILABLE`, never an admitted request.

**Tunnel resource bounds.** The frame cap is not the only bound: an attempt
admits at most `maxConnections` open connections, keeps at most
`maxBufferedBytes` across them, applies backpressure (it stops reading the
tunnel descriptor when a connection's duplex reports a full buffer), and closes
a connection that has not authenticated within `unauthenticatedTimeoutMs`. A
single 16 KiB frame limit does not make the tunnel bounded by itself.

**Invariants, and where each one is held:**

1. `Σ charge_out ≤ maxOutputTokens`, `Σ input_bytes ≤ maxInputBytes`,
   `count(*) ≤ maxRequests` for every execution. Held by construction: each
   insert checks the aggregate it is about to change, inside the write lock.
   These are *not* checked after the fact — a violated total would already be a
   request that went out.
2. `in_flight = count(state = 'reserved')`. It is the same query, not a second
   number.
3. A terminal state never returns to `reserved`, and a repeated terminal
   transition changes nothing (§5.3).
4. `output_tokens` on a row never changes after insert; `settled` only ever
   reduces the charge for that request.

### 5.3 Settlement, abandonment, and crash windows

Every transition is a conditional update on one row, and the condition is the
idempotency mechanism:

```sql
UPDATE model_reservations SET state = ?, … WHERE id = ? AND state = 'reserved';
```

| Transition | Trigger | Row change | Charge effect |
| --- | --- | --- | --- |
| `reserved → settled` | the upstream leg finished and reported usage | `state`, `reported_input_tokens`, `reported_output_tokens`, `cache_read_tokens`, `over_output = reported_output_tokens > output_tokens`, `settled_at` | output drops to the reported value, capped at the reservation; bytes unchanged |
| `reserved → unknown` | dispatched, no usable usage: provider error, cut stream, request timeout, client disconnect we could not finish, gateway abort | `state`, `refusal`, `settled_at` | output stays at the full reservation |
| `reserved → not_dispatched` | the request failed before any upstream request byte was written (connection refused, refused by the provider at connect time, aborted while still queued) | `state`, `refusal`, `settled_at` | output drops to `0`; the admission and the bytes stay charged |
| `reserved → unknown` at startup | a Runner restart found the row still reserved | `state`, `refusal = 'runner_restart'`, `settled_at` | output stays at the full reservation |

A second `settle` for the same id matches zero rows (`state` is no longer
`reserved`) and is not an error; the first recorded outcome stands. There is no
"adjust" transition, so nothing can be charged twice or refunded twice.

`dispatched` is set immediately before the first upstream byte is written,
after the pre-dispatch revocation re-read of §4.1. It is evidence only: no
total depends on it, and a crash between the reservation commit and that
update leaves it `0` while the row is still `reserved` — which startup
reconciliation turns into `unknown`, exactly like a dispatch that happened.
That is why the two crash windows are treated identically instead of guessing
from the flag.

**Crash windows.** (a) crash after the reservation commit and before dispatch,
and (b) crash after dispatch and before settlement are *indistinguishable* in
the ledger, so both become `unknown` at startup and neither is released or
replayed. (c) a crash during settlement is atomic in SQLite: the row is either
still `reserved` or already terminal. Startup reconciliation runs in the same
place the manager already rewrites non-terminal executions to `unknown`
(`SD` `execution-manager.ts:273-298`), before the gateway accepts anything. The
same startup transaction writes the new `runnerBootId` and revokes every
credential row issued by an earlier boot; the gateway does not serve until that
transaction commits, so a restarted process cannot honour an old token even
briefly.

**Accounting storage unavailable is a refusal, not a fallback.** If the ledger
cannot be written, the gateway answers `503 MODEL_GATEWAY_LEDGER_UNAVAILABLE`
and forwards nothing. There is no "allow but log" mode.

### 5.4 Streaming, omission, disconnects, retries, idempotency

Three counts are kept apart, and the first draft conflated them:

- **logical request** — one engine call site;
- **admission** — one HTTP request the gateway accepted;
- **dispatch** — one upstream request the gateway sent.

**One admission is one dispatch. The gateway never retries upstream.** Every
retry in this stack happens on the client side, and each retry is a new HTTP
request, a new admission and a new reservation:

| Client-side retry | Source | Becomes |
| --- | --- | --- |
| `httpx` transport `retries=1` | [code] connection errors only, before any request is sent (`SF` `llm_http.py:53`, `:131-136`) | the same admission, or none if the connect never completed |
| OpenAI SDK `DEFAULT_MAX_RETRIES = 2` | [code] retries `408`, `409`, `429`, `>= 500`, and honours `x-should-retry` (`SF-DEP` `openai/_constants.py:10`, `_base_client.py:750-780`) | a new admission per retry |
| `PooledLLM` endpoint failover | [code] up to one attempt per endpoint plus transient passes (`SF-DEP` `inquirycraft/llm/pooled.py:193-253`) | a new admission per attempt |

**The gateway's own leg** is one `undici.request` (§3.3). It does **not** call
`streamModelTurn`, so that client's `requestWithRetry` (default
`maxRetries = 2`) and its thinking-control fallback loop cannot add dispatches.
If a later slice reuses that client, the contract is only kept by setting
`maxRetries: 0`, disabling the fallback and showing one dispatch; "the gateway
code has no loop" is not the guarantee — the transport being a single call is.

The gateway adds `x-should-retry: false` to every error response **it**
generates, so its own refusals (401/403/400/408/502/503) are never amplified by
an SDK retry; responses relayed from the provider are passed through unchanged.

| Situation | Accounting rule |
| --- | --- |
| Normal stream with usage in the final chunk | `settled` on the reported counts |
| Stream ends with no usage record | `unknown`, full reservation |
| Client disconnects mid-stream | the gateway keeps reading the upstream response until its own `perRequestTimeoutMs` to obtain usage; if it obtains it, `settled`; otherwise `unknown`. The partial text the client already read is not re-served |
| Provider 5xx/429 before any response body | `unknown` (a dispatched request may have been billed); the client's own retry is a new admission |
| Provider connection refused before any request byte | `not_dispatched`, output charge zero |
| Request rejected before admission (400/401/403) | no row at all: nothing was reserved, nothing is charged |
| `Idempotency-Key` header present | rejected `400 MODEL_REQUEST_UNSUPPORTED`. There is no body replay and no duplicate suppression; the engine's client sends no such header, so this refuses a request shape the design does not implement rather than pretending to support it |
| Duplicate request bytes without a key | two admissions, two charges — the guarantee is the ceiling, not exactness |

**Why a retry cannot reset the budget:** the limits are aggregates over rows
keyed by execution; the token is minted once per generation with no renewal
path; there is no endpoint that clears or extends a budget; a client that opens
a new connection presents the same token and hits the same aggregate in the
same write transaction. The worst a retrying client can do is consume its own
allowance faster.

### 5.5 What is durable, and what the public evidence may say

Durable: `model_gateway_credentials`, `model_reservations`, and the probe record
of §3.6, all inside the Runner's existing ledger file. The gateway's in-memory
state is a cache; on disagreement the rows win and the gateway fails closed.

Public, redacted, additive evidence (`[todo]`, to join `ResearchRunStatus`):

```text
model: {
  gatewayGeneration, modelId?, endpointDigest?,          // no URL, no key
  requests: {admitted, refused: {code: count}},
  inputBytes, forwardedBytes,
  outputTokensReserved, outputTokensSettled, outputTokensUnknown,
  inputTokensReported, cacheReadTokensReported,
  overOutputReported,                                    // provider exceeded max_tokens
  outcome: "within" | "exhausted" | "unknown"
}
```

Never public: the token, the upstream credential, the endpoint URL, prompts,
completions, or a per-request body digest that could be correlated to content.
`outcome: "unknown"` covers an unproven termination, a crash-orphaned
reservation, a provider report that contradicts the reservation, and an
unreadable ledger — never "within".

### 5.6 Worked traces

Every trace starts from an execution with no rows. "charge" is the output-token
total of §5.2; `≤` is intentional (a request that exactly fills the ceiling is
admitted).

**A — sequential 60 + 60 against 100** (the review's counter-example):

| Step | used.out | Need | Check | Result |
| --- | --- | --- | --- | --- |
| A admitted | 0 | 60 | `0 + 60 ≤ 100` | row A `reserved(60)`, charge 60 |
| A settles, reported 60 | 60 | — | — | charge `min(60, 60) = 60` |
| B needs 60 | 60 | 60 | `60 + 60 = 120 > 100` | **refused 403**, no row |
| B retries with 40 | 60 | 40 | `60 + 40 = 100 ≤ 100` | row B `reserved(40)`, charge 100 |

The first draft admitted B's 60 and called the over-run "unknown" afterwards;
that is exactly what this revision removes.

**B — concurrent reservations**: `maxOutputTokens = 100`, `maxInFlight = 2`.

| Step | used.out | in_flight | Result |
| --- | --- | --- | --- |
| A needs 40 | 0 | 0 | admit → used 40, in_flight 1 |
| B needs 40 | 40 | 1 | admit → used 80, in_flight 2 |
| C needs 30 | 80 | 2 | refuse: `80 + 30 = 110 > 100`, and in_flight is full |
| A settles, reports 40 | 80 | 1 | A's row charge stays 40; the total is **still 80** |
| C needs 30 again | 80 | 1 | still refused (`110 > 100`): A used its whole reservation, so settlement released nothing |
| B settles, reports 10 | 50 | 0 | B's charge drops from 40 to 10; total 80 → 50 |
| C needs 30 | 50 | 0 | admit → used 80, in_flight 1 |
| C settles, reports 30 | 80 | 0 | total stays 80 |

Revision 1's table read "A settles → 40" and admitted C at 70; that counted only
A's row and forgot B's live reservation. A reservation is charged from the
moment it is inserted, and settlement reduces the charge only by the part of the
reservation the provider did not report — an exactly-used reservation releases
nothing.

**C — unknown occupancy blocks later requests**: limit 100. A dispatches with 60
and the connection dies. A → `unknown`, charge 60. B needs 50: `60 + 50 = 110 >
100` → refused, even though A may have been billed nothing. The run's evidence
says `unknown`; it never says "within".

**D — duplicate settlement and restart**: execution total 100 composed of two
rows: A `reserved(60)` and B `settled(40, reported 40)`. A repeated settle for B
matches zero rows (`state` is no longer `reserved`), so B's **row** charge stays
40 and the **execution total** stays 100 — the two numbers are not
interchangeable. A Runner restart finds A still `reserved`, makes it `unknown`
with charge 60: the total is again 100, no row is released and no request is
replayed. Every further admission for that execution is refused.

**E — a restart neither resumes nor re-issues**: attempt 1 settles 60, so no row
is `reserved`. The Runner restarts; its startup transaction writes a new
`runnerBootId`, revokes generation 1's credential with reason `runner_restart`,
reconciles any surviving `reserved` row to `unknown`, and only then accepts
admissions. No generation 2 and no token are minted for that execution, and no
request is replayed; a second attempt is **not authorized in v1** (§4.1,
lifecycle "Attempt 2"). The aggregate stays per-execution, so a future slice that
accepts a second attempt would inherit the 60 — that is a later contract, not a
property this one gets to assume.

**F — bytes, including a not-dispatched request**: `maxInputBytes = 1 MiB`.
Three bodies of 300 KiB are admitted (900 KiB). A fourth of 300 KiB is refused
(`1.2 MiB > 1 MiB`). If the third request is admitted and its upstream connect
is refused, it becomes `not_dispatched`: the bytes stay charged (they were
read), the output charge is zero, and the admission count stays used.

**G — stop with four in flight**: `maxInFlight = 4`. Four requests A–D are
admitted (`reserved`) and have not written an upstream byte. The stop commits.
Each pre-dispatch re-read of §4.1 sees `revoked_at` and the row becomes
`not_dispatched`; zero upstream bytes are written. If one of the four had
already written its first byte, it becomes `unknown` instead. A fifth request
arriving after the stop is `401`. The window is four, not one.

**H — a slow body does not hold the ledger**: execution X opens a connection and
trickles its body. Execution Y's admission commits immediately, because X is
outside any transaction while its body arrives (§5.2). X is cut at
`bodyReadTimeoutMs` and gets `408` with no row (nothing was reserved). The
connection slot it occupied is bounded by `maxConnections` and released at the
cut.

## 6. Lifecycle and failure behaviour

The gateway is a *usage* authority, not the run's lifecycle authority. The four
orthogonal facts of `controlled-execution.md` §5.1 keep their meanings.

### 6.1 Exhaustion during research versus reporting

| Moment | Engine behaviour | Public result |
| --- | --- | --- |
| Research: a task's model call is refused (403 `MODEL_BUDGET_EXHAUSTED`) | The call is non-retryable; the task fails; the engine's record decides `research_status` (`failed`, or `completed` if the engine recovered by other means) | `execution` from the Runner ledger/boundary proof; `research` from the engine record; `model.outcome = "exhausted"` |
| Research: a stop intent and exhaustion coincide | The stop stays the cause of termination; the gateway has already revoked on the durable intent | `cancelled` + `research: stopped` (or `not-started` per the E3 short-circuit); `model.outcome` records the refusals that happened before the stop |
| Reporting: the enrichment call is refused | `enrich_report()` catches it and degrades: the report is still written from baseline evidence (`SF` `analysis.py:539-554`) | `research` unchanged; `report` from `report_status`; `model.outcome = "exhausted"` is the only place the exhaustion is visible |
| Reporting: the report budget expires first | The supervisor kills the report child at its own budget and reads no ready manifest (`SF` `…/control/reporting/__init__.py:57-91`), so the record is written as `report_status = "generation_failed"` and, because research had completed, the run's `status` becomes `failed` (`SF` `…/control/worker.py:249-275`) | `report: generation_failed`; `research` preserved as the engine recorded it; gateway reservations charged unknown |
| Reporting: a durable stop cancels the report | The supervisor reaps the report process group and keeps the cancellation distinct (`SF` `…/control/worker.py:239-245`, `:269-272`) | `report: incomplete`; `research` preserved; this is the only path that yields `incomplete` |

The two rows are deliberately separate: a timeout is a *generation* failure and
a stop is an *incompleteness*, and the first draft collapsed them.

**A completed research phase is never turned into a failure by the gateway.**
The gateway has no write path to `research_status`; the mapping of
`controlled-execution.md` §5.1 stands unchanged.

### 6.2 Interaction with the existing stop, deadline and fences

- The gateway subscribes to the same stop intent the control channel uses: the
  Runner revokes on intent persistence, before any kill, so a stopped run cannot
  spend after its stop is durable.
- The per-request deadline is `min(perRequestTimeout, deadlineAt − now)`, and
  `deadlineAt` is the run's `hardDeadline`
  (`controlled-execution.md` §5.6). The gateway never extends it.
- Gateway shutdown is not a resource fence. The workspace, environment and
  device fences stay where they are (`SD` `execution-manager.ts`
  `execution_resources`), and an unproven termination still leaves the run
  `unknown` with every fence held — the model ledger adds no new release path.
- A refused gateway start (missing config, the tunnel descriptor not delivered,
  the source probe failing, ledger unavailable, relay unsupported) refuses
  **research startup** with a fixed code. Configuration failures detected before
  any launch have no process; failures detected in a probe or forwarder retain
  the actual process evidence and require termination proof (§3.6, G20).
  There is no "run without metering" mode.
  The persisted refusal vocabulary is closed (`RESEARCH_REFUSAL_CODES`, `SD`
  `packages/schema/src/research-run.ts:179-209`), so this slice does **not**
  extend it: these conditions are reported through the existing
  `RESEARCH_LAUNCH_FAILED` with a fixed, redacted reason string, and adding
  dedicated codes is a later schema decision, not something this round assumes.

### 6.3 Fixed error codes and redaction

New, additive, fixed vocabulary (the persisted `RESEARCH_REFUSAL_CODES` keep
their meaning, `SD` `packages/schema/src/research-run.ts:179-209`):

| Code | HTTP | What the client does (evidence) | Meaning |
| --- | --- | --- | --- |
| `MODEL_GATEWAY_TOKEN_INVALID` | 401 | not retried — the SDK's retry set excludes 4xx except 408/409/429 | unknown, foreign, expired or revoked token, or an authority check that no longer matches the accepted execution (one code for all five checks of §4.1, so a probe learns nothing) |
| `MODEL_BUDGET_EXHAUSTED` | 403 | not retried, same reason | a ceiling would be exceeded |
| `MODEL_NOT_ALLOWED` | 403 | not retried | model outside the Runner allowlist |
| `MODEL_REQUEST_UNSUPPORTED` | 400 | not retried | field, shape, image, `n != 1`, missing `max_tokens`, or an `Idempotency-Key` |
| `MODEL_DEADLINE_EXCEEDED` | 408 | **would be retried** by the SDK; the gateway sends `x-should-retry: false` so it is not | run deadline reached |
| `MODEL_GATEWAY_UNAVAILABLE` | 503 | **in the SDK's retry set**; suppressed the same way on responses the gateway generates | the tunnel is closed, the generation is over, or the gateway is not accepting |
| `MODEL_GATEWAY_LEDGER_UNAVAILABLE` | 503 | suppressed the same way (it must fail the task, not retry) | accounting storage cannot be written |
| `MODEL_UPSTREAM_FAILED` | 502 | **yes**: the provider's own response is relayed unchanged, so the provider's status and the SDK's policy decide; each retry is a new admission and a new reservation | provider error after dispatch; the gateway did not retry it |
| `MODEL_USAGE_AMBIGUOUS` | — | — | outcome field only: a dispatched request was charged without a usage report |

The third column is what the installed client actually does, not what the
gateway would prefer: `_should_retry` retries `408`, `409`, `429` and `>= 500`
and honours `x-should-retry` (`SF-DEP` `openai/_base_client.py:750-780`,
`_constants.py:10`). That is why the two `503` rows and the `408` row depend on
a header rather than on the status code.

403 and 400 are chosen over 429 on purpose: this client retries 429 and
`PooledLLM` fails over on it, and a budget refusal must end the call, not teach
the engine to try again. Every error response the gateway generates also carries
`x-should-retry: false`, so a refusal is not amplified into a retry storm.
Errors never include the prompt, the completion, the token, the URL, or a
provider body.

`MODEL_GATEWAY_UNAVAILABLE` on a live attempt means the tunnel is gone (the
Runner crashed or the attempt was closed); the engine's transport error is not
retried into a second unmetered path — there is none.

## 7. The next implementation slice

### 7.1 Goal and boundary

**[todo]** One Runner-owned model gateway for the research workload, with a
synthetic local provider, no real credential, no model cost, and no API start
action. It removes the *mechanism* half of B2 (a gateway exists, is reachable
only through the sandbox contract, and refuses to run unmetered) and the
*request/byte/concurrency/time* half of B3. The token half of B3 stays
accounting-only (§5.1) and is **not** claimed. It does not clear B2's product
half (real credential, real provider), does not clear spend, and touches no
other blocker.

### 7.2 Files and contracts

| File | Change |
| --- | --- |
| `packages/schema/src/model-budget.ts` (new) | authority tuple, limit shape, refusal codes, observation type, redaction rules |
| `services/runner/src/model-gateway-tunnel.ts` (new) | frame codec, demultiplexer, one duplex per connection, descriptor lifecycle, the connection/buffer bounds and backpressure of §5.2 |
| `services/runner/src/model-gateway.ts` (new) | chat-completions handling over the demultiplexed streams (no `listen()`), inbound allowlist, header auth before the body, authority and reservation checks, and the upstream leg as **one raw `undici.request`** (no retry, no protocol selection, no fallback — §3.3) |
| `services/runner/src/model-budget-store.ts` (new) | the two tables, the aggregates of §5.2, admit (short transaction after the body read), settle/abandon, startup reconciliation and boot revocation |
| `services/runner/src/model-gateway-config.ts` (new) | trusted config loader, versioned JSON, static errors (shape of `scienceflow-runtime-config.ts`) |
| `services/runner/src/model-gateway-bridge.ts` (new) | the fixed forwarder script (descriptor wrap, framing, loopback listener) and the environment it contributes |
| `services/runner/src/executor.ts` | the extra stdio descriptor, `research-gateway` variant selection, the `/scienceflow-engine/.venv` mask, `PYTHONPATH` and `XDG_CONFIG_HOME` for the workload |
| `services/runner/src/seccomp.ts` | the variant, its `socket()` domain+type block, the `BPF_ALU_AND_K` helper |
| `services/runner/src/research-run.ts` | create the pair and the gateway around one attempt; assert `engine.sourceRoot === binding.sourceRoot` and record the mount source in the path map; run proofs S and R of §3.6 (S already exists here); materialize `models.json`; carry the observation into the ledger |
| `services/runner/src/scienceflow-runtime-check.ts` | the research-layout proof R: a second probe layout (checkout at `/scienceflow-engine`, the run's `PYTHONPATH`, `-P -B -`) with its own origin check and process-fact classification. The existing static gate and `assessStaticProbeFacts` are kept; this is an extension, not a replacement |
| `services/runner/src/execution-manager.ts` | write `runnerBootId` and revoke earlier boots' credentials in the existing startup transaction; reconcile `reserved` rows |
| `services/runner/src/scienceflow-engine-bridge.ts` | re-check the derived launch manifest for endpoint keys |
| `services/runner/package.json` | add the `@sciencediscovery/model` workspace dependency (used for `normalizeUsage` and the diagnostics vocabulary, not for the upstream leg) |
| tests | see §7.3 |

**A tracked engine change is a prerequisite, not part of this table.** The
engine's own `-m` children need `-P` (§3.6): `child_cli_argv` for prep/task and
the report child's argv. It is not in this slice because it edits the pinned
checkout, but the design does not leave it to the implementation round: without
it, `cwd` is `sys.path[0]` and the workspace can replace the engine entry, so
G23 cannot pass. `controlled-execution.md` §3.6 gains it; until the tracked
revision carries it, a real start stays refused.

The production Runner server still registers **no** research start route (`SD`
`services/runner/src/server.ts:488-490`), and the research executor is
constructed only by the test assembly (`SD`
`services/runner/src/research-run.ts:1123`); the slice adds no route and no
`canStart` change.

### 7.3 Acceptance matrix (targeted, real bwrap, synthetic provider)

The synthetic provider is a local HTTP server in the test process, serving
chat-completions with a scripted usage record; credentials are generated at
runtime, never literals.

| # | Precondition | Action | Expected |
| --- | --- | --- | --- |
| G1 | Gateway configured, synthetic provider, real bwrap | One non-streaming request from a real task child | 200; `settled` with reported usage; `within` |
| G2 | Same | One streaming request with `stream_options` | SSE deltas forwarded; usage settled from the final chunk |
| G3 | `maxInFlight = 2` | Three simultaneous requests | Third refused 403; `in_flight` never exceeds 2; no aggregate exceeds a limit |
| G4 | `maxRequests = 1` | Two requests | Second refused 403; the provider sees one request |
| G5 | `maxOutputTokens` small | Request whose `max_tokens` exceeds the remaining allowance | Refused before dispatch; provider sees no request |
| G6 | Provider reports no usage | Complete request | `unknown`; `model.outcome = "unknown"`; reservation not released |
| G7 | Client disconnects mid-stream | Abort | The gateway finishes reading upstream if it can; exactly one upstream request; row `settled` or `unknown` |
| G8 | Provider answers 500, then (second run) a 400 whose body names a thinking control | One admission each | **Exactly one** upstream request from the gateway in both runs; row `unknown` (500) or the provider's 400 relayed unchanged with no reissue; the client's SDK retry, if any, is a second admission with its own row |
| G9 | Request carrying `Idempotency-Key` | Send it | 400 `MODEL_REQUEST_UNSUPPORTED`; no row |
| G10 | Two byte-identical requests, no key | Send both | Two rows, two charges — the ceiling is the guarantee |
| G11 | Durable stop intent while a request is in flight | Stop | Token revoked in the same write; in-flight row `unknown`; every later admission 401 |
| G12 | Real task child connects to a host LAN address | Bypass attempt | `ENETUNREACH`; the gateway ledger is unchanged |
| G13 | Real task child resolves a hostname | Bypass attempt | Resolution fails; no request leaves the namespace |
| G14 | Real task child calls `socket()` with `AF_UNIX`, `AF_INET6`, `AF_NETLINK`, `AF_PACKET`, `SOCK_RAW`, `SOCK_DGRAM`, and `socketpair()` with `AF_UNIX`/`SOCK_DGRAM`, `AF_UNIX`/`SOCK_RAW`, `AF_INET`/`SOCK_STREAM` | Bypass attempt | `EPERM` for each; only `socket(AF_INET, SOCK_STREAM)` and `socketpair(AF_UNIX, SOCK_STREAM, 0)` succeed |
| G15 | **Live host IPC services** under the mounted `/workspace` at launch time — a stream listener on a filesystem path, a stream listener on an abstract name, and a **datagram** listener on a filesystem path; a second socket appears during the run | Real task child tries plain `socket(AF_UNIX)`, datagram socketpairs, and connect/bind/listen, addressed sendto/sendmsg and descriptor passing from a permitted stream pair, including the socket created mid-run | Forbidden creation returns `EPERM`; a permitted pair can communicate only with its original peer. Host services receive no test data or descriptors and continue answering host-side probes. Addressed operations need not share one errno. If any route reaches a host service, no-bypass **stays blocked** |
| G16 | Real task child calls the gateway with no token / another execution's token | Bypass attempt | 401; no row |
| G17 | Real report subprocess makes a model call | Attribution | The call is admitted into the same execution's rows; a refusal leaves `report_status` as the engine recorded it and shows only in `model.outcome` |
| G18 | Real prep/task child clears its environment and hard-codes `127.0.0.1:18119` | Fail-closed | Without the token: 401; with the token: metered. Neither reaches the provider unmetered |
| G19 | Ledger write fails (injected) | Start a request | 503 `MODEL_GATEWAY_LEDGER_UNAVAILABLE`; nothing forwarded |
| G20 | Tunnel descriptor not delivered by bwrap | Start the run | Research bootstrap does not start (`RESEARCH_LAUNCH_FAILED`, fixed reason); any probe/forwarder process that did start is recorded and reclaimed, with boundary proof required. No fallback transport and no claim that no process was spawned |
| G21 | Crash window: kill the Runner between reservation and settlement | Restart, re-read | Row `unknown` with `runner_restart`; no release, no replay |
| G22 | Run ends normally | Observe | Tunnel closed; `model` evidence present; `outcome = "within"` |
| G23 | Proof R: the research-layout probe, with a `scienceflow/` package **pre-planted** in `/workspace` | Read the record and compare with the real task child | `find_spec("scienceflow")` origin is `/scienceflow-engine/scienceflow/__init__.py` for the probe **and** the child; `sys.executable`/`sys.prefix` are the expected interpreter; `resolve_project_python()` is the expected value with the `.venv` mask; the pre-planted package does not win |
| G24 | Real task child inspects descriptor 4 | `os.fstat(4)` | `EBADF`; the forwarder alone holds the tunnel |
| G25 | Two launches, one with the `.venv` mask removed | Compare the probes | With the mask: deterministic interpreter; without it and with a host `.venv` present: the launch is refused rather than run on an unbounded interpreter |
| G26 | Execution X trickles a body on one connection; execution Y submits | Both allowed to run | Y's reservation commits while X is still uploading; X is cut at `bodyReadTimeoutMs` with no row; the ledger is never held across X's body |
| G27 | Kill and restart the Runner while a generation-1 credential exists | Restart, present the old token | Startup writes a new `runnerBootId`, revokes the old row (`runner_restart`), reconciles `reserved` rows to `unknown`, then serves; the old token is 401; no generation 2 and no token are issued for the execution |
| G28 | `maxInFlight = 4`; four requests admitted and not yet dispatched; stop is persisted | Stop, then a fifth request | No new admission (401); each of the four is `not_dispatched` (or `unknown` if a first upstream byte was written); the fifth is refused; the window is four, not one |
| G29 | A pre-authenticated connection stalls before its body; `maxConnections` reached | Open one more | The stalled connection is closed at `bodyReadTimeoutMs`/`unauthenticatedTimeoutMs`; the extra connection is refused; buffer use never exceeds `maxBufferedBytes` |

Every row is a design expectation. G1–G11 and G19–G22, G26–G28 exercise the
gateway and the store; G12–G18 and G23–G25 must run inside a real bwrap sandbox
with the `research-gateway` filter and real child processes, because the bypass
claim is about the kernel and the import claim is about `exec`, not about
TypeScript; G29 exercises the transport bounds inside the same sandbox.

### 7.4 What stays blocked, and the evidence liyuan must supply

After this slice, and only with the real-provider evidence below:

| Claim | Status after the slice | Evidence still required |
| --- | --- | --- |
| B2 `model_gateway_not_configured` | blocked | one real model call through the gateway with a real credential that exists only in the Runner config; the provider must not see the sandbox's token; the same run repeated with a revoked token |
| B3 requests, bytes, concurrency, time | mechanism only | a real run that reaches each ceiling, plus a real streamed call whose provider usage equals the settled ledger counts (including cache tokens) |
| B3 provider tokens as a ceiling | **not claimed** | the provider, model, tokenizer, template and output semantics would have to be fixed and evidenced first (§5.1); until then reported tokens are accounting |
| B3 spend | blocked | not in this slice; needs a Runner-side pricing authority, which does not exist |
| B1/B4/B5 | unchanged | out of scope |
| Remote Runner, native Windows | not validated | separate deployments |
| No-bypass | targeted evidence only | G12–G16 and G24 reproduced with the pinned engine, the real image and the real host kernel, including the live stream and datagram services and the `socketpair` routes |
| Child interpreter and source binding | design + probe only | G23 and G25 on the real deployment image, including the `.venv` case, the pre-planted workspace shadow and the tracked `-P` revision |
| Restart contract | design + store test only | G27 on a real restart: old token 401, reservations `unknown`, no generation 2, no replay |
| Ledger under a slow client | design + store test only | G26 with a real trickled body and a second execution's writer |
| Descriptor inheritance through bwrap | **[dyn]** | G20 and G25; if bwrap does not pass descriptor 4, the start is refused and the transport needs a different primitive |

No token, spend or no-bypass claim may rest on mocks alone. The tests prove the
mechanism; the product claim needs the real boundary.

## 8. Decisions and remaining blockers

Resolved here:

1. **The engine's endpoint is configuration, not environment.** The control is a
   per-execution `models.json` reached through `XDG_CONFIG_HOME`, because the
   engine's client installs its own transport and ignores proxy variables, and
   because `CODE_*` is only a projection in this engine.
2. **The transport is an inherited descriptor (a socketpair end) behind the
   existing sandbox forwarder's shape.** No host loopback URL, no
   `--share-net`, no proxy environment, and no bind-mounted socket: a
   filesystem socket is only reachable through a socket that can name it, and
   this design denies `socket(AF_UNIX)` and reduces `socketpair` to
   self-connected `SOCK_STREAM` pairs, so any host socket left in a mounted
   directory is unreachable by construction rather than by not existing.
3. **The sandbox change is one seccomp variant** that allows
   `socket(AF_INET, SOCK_STREAM)` only and `socketpair(AF_UNIX, SOCK_STREAM, 0)`
   only — domain, type and protocol checked, `AF_UNIX` denied for `socket()` —
   while keeping `--unshare-all`, `--cap-drop ALL` and the cleared environment.
   The no-bypass argument rests on (a) no socket that can name a host Unix peer
   being creatable, (b) the namespace having no route, and (c) one listener of
   interest; it does not rest on an address filter, which the current seccomp
   primitive cannot express, and it is conditional on G15.
4. **Every child is covered by construction**, because the configuration is
   inherited and the namespace is shared — but only once the child can import
   the engine at all. §3.6 keeps the existing source gate (S), adds the
   research-layout proof (R), sets `PYTHONPATH=/scienceflow-engine`, masks the
   checkout's `.venv` and requires the tracked engine change `-P` on the
   engine's own `-m` children, so `cwd` cannot replace the entry. Reporting is
   metered on the same allowance, and its failure degrades or fails the report
   rather than the research.
5. **Reservation is a durable SQL transaction before dispatch**, and one row is
   the only source of truth: settled, unknown and in-flight requests are all
   charged, totals are aggregates over those rows, and ambiguous dispatches are
   charged, never released. The body is read and validated **outside** that
   transaction, so an untrusted upload cannot hold the ledger's writer.
6. **Spend is not enforceable and not promised; provider tokens are not an
   enforceable ceiling either.** What this slice enforces is admissions,
   inbound bytes, forwarded bytes, concurrency, the request deadline, the
   connection and buffering bounds, and the `max_tokens` parameter. Reported
   token counts are accounting.
7. **The accepted owner and permission epoch are authorities**, captured at
   issuance from the accepted request and re-checked on every admission; the
   Runner cannot observe a store-side epoch rotation, and says so. Restart
   revocation is tied to a per-process `runnerBootId`, not to the persistent
   `runnerInstanceId`, and v1 restarts revoke and reconcile without resuming
   or re-issuing.
8. **A gateway that cannot meter refuses the start.** There is no bypass mode
   and no fallback transport.

Remaining blockers and prerequisites:

- A Runner-side trusted model config with an upstream credential, and its
  rotation story, before any real call.
- Two **[dyn]** mechanics before the transport can be implemented: bwrap
  passing descriptor 4 through to the payload (§3.2), and `--tmpfs` masking a
  `.venv` that does not exist (§3.6). Both are measured by G20/G25; neither has
  a silent fallback.
- **G15 decides the no-bypass claim.** The `socketpair` argument is
  code-derived; if the live-host test finds a route, the claim stays blocked.
- Real-provider evidence (§7.4) before B2 moves.
- A pricing authority on the Runner before any spend claim.
- A tracked engine revision is still required for a real start
  (`controlled-execution.md` §3.6), and it must now carry the `-P` change of
  §3.6 here. This design names that change but adds no engine patch.
- The start route, input delivery for datasets, and the API start action are
  untouched.

None of this authorizes a start: the five blockers and `canStart: false`
remain until each has execution-time evidence.
