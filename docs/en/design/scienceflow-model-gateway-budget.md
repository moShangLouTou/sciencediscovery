# ScienceFlow model gateway and bounded model usage

Status: **Proposed — not implemented.** Round 17 design (2026-11-14). No
production code, schema, test, route, table, installer or engine patch was added
by this round. Every plan keeps `canStart: false` and all five blockers
(`SD` `packages/schema/src/scienceflow.ts:258-262`).

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
- **[code]** The transport is always a custom `httpx.AsyncHTTPTransport`
  (`retries=1`, no keep-alive, explicit connect/read/write timeouts) built by
  the engine (`SF` `.../llm_http.py:102-146`, `:161-175`).
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

| Phase | Process | Client | Configuration carrier |
| --- | --- | --- | --- |
| `prep` task | child `python -m scienceflow.interfaces.cli prep …` (`SF` `.../execution/subprocess.py:24-41`) | none found on the paths read [inference]; any client it built would resolve the same registry | inherited environment → `models.json` |
| research task | child `python -m scienceflow.runtime.parallel.execution.task_worker …` (`SF` `.../execution/subprocess.py:42-58`) | agent code stage (`SF` `scienceflow/agent/factory/composition.py:65-71`), LNR feedback stage (`SF` `.../resource/advisory.py:528`) | same |
| reporting (baseline) | child `python -m scienceflow.runtime.parallel.control.reporting …`, no `env=` given, so it inherits (`SF` `.../control/reporting/__init__.py:31-56`) | none — files only | — |
| reporting (enrichment) | same child | feedback stage (`SF` `scienceflow/research/reporting/analysis.py:354-364`) | same |

Rules that hold for every row:

- **[code]** A task child's environment is `os.environ.copy()` plus resource
  variables (`SF` `.../state/subprocess_runtime.py:92-107`), so anything the
  supervisor was given reaches every worker.
- **[code]** The child interpreter is `resolve_project_python()`, i.e. a
  project `.venv/bin/python` beside `pyproject.toml` if one exists, else
  `sys.executable` (`SF` `scienceflow/runtime/environment.py:27-54`) — under the
  Runner that is the leased environment's interpreter, the same one the R11
  check verified.
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
  entry: `socketpair` for `AF_UNIX` only; `socket`, `connect`, `bind`,
  `listen`, `accept`, `accept4` stay refused (`SD`
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
| Chat-completions → native request translation, stream mapping | **Yes** (narrower subset) | [code] proven on the agent path; the engine's request shape is a subset of it |
| Strict parameter allowlist, fail-closed refusal | **Yes** | [code] same discipline; the accepted field set differs (§3.3) |
| Outbound client (`streamModelTurn`) and `normalizeUsage` | **Yes** | [code] `SD` `packages/model` depends only on `schema`, `runtime-core`, `undici` |
| Privacy-safe wire diagnostics (`ModelWireDiagnostics`) | **Yes** | [code] counts and classifications only, no prompt or credential |
| Per-run bearer token | **Yes**, with a different identity (§4) | [code] the agent token is a per-run UUID compared by string equality (`:263`, `:287`); the Runner token is bound to the execution tuple and compared by digest (design, §4.1) |
| Loopback TCP listener on the API host | **No** | [code] remote Runner cannot reach it; and it is outside the sandbox's namespace |
| Upstream credential source | **No** | [code] the API's model catalog belongs to the API; a Runner must own its own trusted config |
| Reservation, settlement, durable counters | **Missing** | the agent gateway has `beforeTurn`/`progress` hooks only (`:222-240`) and per-request `max_tokens`; it has no ledger |
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

### 3.1 The three candidates and why two are rejected

| Candidate | Why it fails as the enforcement point |
| --- | --- |
| Host loopback URL (`http://127.0.0.1:<port>`) from the sandbox | [code] `--unshare-all` puts the sandbox in a fresh network namespace with no route to the host; `connect` is denied by seccomp. The Runner's listener is not reachable, and allowing it would mean sharing the host network namespace (`--share-net`), which this design refuses |
| Environment proxy (`HTTP_PROXY` → egress bridge) | [code] inert: the engine's client installs its own `httpx` transport, so `httpx` never reads proxy variables (`SF-DEP` `httpx/_client.py:1399`); and a CONNECT proxy would forward to the provider without metering. `use_proxy: true` would work mechanically but re-introduces an unmetered tunnel |
| Bind-mounted Unix socket + in-sandbox loopback relay | **Chosen** — [code] this is exactly the primitive the audited egress path already ships |

### 3.2 The chosen shape

The audited egress primitive already does what is needed: a Runner-owned Unix
socket bind-mounted into the sandbox, and a small stdlib-only Python forwarder
inside the sandbox that listens on the sandbox's own loopback and pipes each
connection to that socket (`SD` `services/runner/src/egress-bridge.ts:22-41`,
`:44-51`, `:72-145`, `:235-253`). The egress gateway's own header states the
property being reused: the sandbox "has no network interface of its own, so
this socket is the only way out" (`SD`
`services/runner/src/egress-gateway.ts:39-54`).

Round 17 uses the same mounts and the same forwarder with a **different host
end**: not the general proxy (which may reach allowlisted domains), but one
per-attempt model gateway that terminates chat-completions and forwards through
the product model client. The sandbox's only reachable peer becomes the gateway.

```text
Runner process (host)
├─ per-attempt model gateway  http server on <short>/<executionId>.sock
│    ├─ requires Bearer <per-run token>
│    ├─ reserves in the Runner ledger before any upstream byte
│    └─ forwards via streamModelTurn() to the trusted upstream endpoint
└─ bwrap monitor  --unshare-all --clearenv --cap-drop ALL --seccomp 3
   └─ namespace init (bwrap)
      └─ model-gateway forwarder (fixed Python, stdlib only)
         │   listens 127.0.0.1:18119, pipes to /run/sciencediscovery/model-gateway.sock
         │   execs its child and exits with its status →
         └─ research bootstrap (fixed Python, Runner-owned)
            ├─ engine supervisor (supervise → run_manifest)
            ├─ task workers        ── model calls ──▶ 127.0.0.1:18119 → socket → gateway
            └─ report subprocess   ── model calls ──▶ same
```

Fixed constants, in the same style as the egress bridge:

| Constant | Value | Meaning |
| --- | --- | --- |
| `MODEL_GATEWAY_SOCKET_PATH` | `/run/sciencediscovery/model-gateway.sock` | sandbox path of the bind-mounted socket |
| `MODEL_GATEWAY_BRIDGE_PORT` | `18119` | sandbox loopback port the forwarder listens on |
| `MODEL_GATEWAY_URL` | `http://127.0.0.1:18119/v1` | the `base_url` written into the per-execution `models.json` |
| `MODEL_GATEWAY_CONFIG_MOUNT` | `/scienceflow-gateway` | read-only mount of the per-execution config dir |

Ownership, mounts, lifetime:

- **[todo]** The socket file lives in a Runner-owned, short-path directory
  (reusing `resolveEgressSocketDirectory`, `SD`
  `services/runner/src/egress-socket-root.ts`, because `sun_path` is 107 bytes),
  named from a per-attempt random id, mode `0600`, created by the Runner before
  spawn and removed after termination is proven.
- **[todo]** It is mounted `--bind` (a Unix socket must stay writable to be
  `connect()`ed), after `workspaceBindArgs`, following the existing mount-order
  rule (`SD` `docs/en/design/scienceflow-controlled-execution.md` §4.3; the
  executor appends egress binds before workspace binds today, `SD`
  `services/runner/src/executor.ts:983-989`, and the gateway binds must follow
  the same later-wins rule).
- **[todo]** The per-execution config directory
  (`<stateRoot>/model-gateway/scienceflow/models.json`) is mounted `--ro-bind`
  at `MODEL_GATEWAY_CONFIG_MOUNT`, also after the workspace binds.
- **[todo]** The forwarder is the existing fixed script
  (`egress-bridge.ts:72-145`) started with `--socket` and `--port` and the real
  bootstrap argv after `--`; it `execv`s the bootstrap, so the workload and its
  children keep it as an ancestor.
- **[todo]** Both the socket and the forwarder die with the attempt: the Runner
  closes the gateway after the namespace is proven empty, and the forwarder
  exits when its child exits. A Runner restart does not recreate either.

### 3.3 How every client is configured, without engine patches

The Runner materializes one `models.json` per execution:

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
  `.../model_registry.py:20-30`); the bootstrap sets it before importing the
  engine (`SD` `services/runner/src/scienceflow-engine-bridge.ts:828-845`
  already sets `XDG_STATE_HOME` the same way). `HOME` stays `/tmp`.
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
  what R11 verified, so this design adds no new import surface.
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

`max_tokens` deserves its own rule: the engine's `max_tokens` is a stage default
(`SF` `.../contracts/schema.py:26`, `32768`), the manifest cannot carry one, and
the bridge never sets a config file. A request above the gateway ceiling is
refused, and the ceiling is therefore configured at or above the engine default
— refusing it after the run starts would turn a configuration mistake into a
research failure.

### 3.4 The minimal sandbox change, and its attack surface

Exactly one new seccomp variant, Runner-selected for this workload kind:

- **[todo]** `research-gateway` = the baseline's socket-family list (x64 `41,
  42, 43, 49, 50, 53, 288`; arm64 `198, 199, 200, 201, 202, 203, 242`, `SD`
  `seccomp.ts:52-55`), with the `socket()` domain checked by the same BPF
  argument test the research variant already uses for `socketpair`
  (`seccomp.ts:147-159`): allow `AF_UNIX` and `AF_INET`, deny everything else
  (`AF_INET6`, `AF_NETLINK`, `AF_PACKET`, raw). `socketpair` keeps its
  `AF_UNIX`-only rule.
- **Unchanged:** `--unshare-all` (a fresh network namespace with only loopback),
  `--unshare-user`, `--cap-drop ALL`, `--clearenv`, `--die-with-parent`,
  `--ro-bind /usr`, the interpreter masks, and `--seccomp` at fd 3. There is no
  `--share-net`, no blanket network variant, and no disabled filter (`SD`
  `executor.ts:962-998`).
- **Why loopback is enough:** the forwarder binds `AF_INET` on `127.0.0.1` in
  a `--unshare-all` sandbox on the audited egress path (`SD`
  `egress-bridge.ts:127-130`), and that path has a positive end-to-end test: a
  real `bwrap` child with the `network` filter and the forwarder prefix fetches
  through loopback and reaches the gateway, while the same loopback target from
  a sandbox with the baseline filter and no bridge fails closed (`SD`
  `services/runner/src/sandbox-network.test.ts:222-289`), including a direct
  loopback attempt without any socket (`:278-284`). What is **not** yet proven
  for this design is the new `socket()`-domain variant itself, which is why
  G12–G18 are part of the slice (§7.3).

Attack surface added, stated plainly:

| Surface | Consequence | Why it is acceptable |
| --- | --- | --- |
| Workload may create `AF_INET` sockets and `connect()` | It can only reach addresses that have a route — inside a fresh netns, only `127.0.0.1` | [code] no interface other than loopback exists; `AF_NETLINK` is denied, so no route or interface can be created even with the namespace's `CAP_NET_ADMIN` |
| Workload may `bind`/`listen` on loopback | It can talk to itself, and could shadow the forwarder's port | Result integrity is already outside this boundary: untrusted workload code can fabricate any result. It cannot reach an upstream model without the gateway |
| Workload can read the per-run token in `models.json` | It holds its own allowance | The token is bound to one execution and expires; the upstream key is never in the sandbox |
| Workload can connect to the mounted socket directly | It speaks chat-completions to the same gateway | Metering and attribution are unchanged; the relay is a convenience for HTTP clients, not the enforcement |
| Second interpreter + stdlib mounted for the forwarder | A read-only interpreter the workload did not have | [code] already mounted on the audited egress path (`egress-bridge.ts:235-242`); no writable path is added |

The primitive that does **not** exist and must not be claimed: **seccomp cannot
filter `connect()` by destination address** (its argument is a pointer), and the
current filter has no `SECCOMP_RET_USER_NOTIF` broker. The no-bypass property
therefore rests on the network namespace having no route off-host plus the
absence of a second reachable peer — not on an address check inside the filter.
If a later deployment adds any interface to the sandbox namespace, or reuses
this variant with `--share-net`, the guarantee is void and the start must be
refused.

### 3.5 Why the workload cannot bypass the gateway

The argument has five parts; each is a property of the sandbox, not a promise
about the engine's behaviour:

1. **No route.** The namespace contains only loopback; `socket(AF_INET6)`,
   `socket(AF_NETLINK)` are denied by the domain test, and raw/packet sockets
   need `CAP_NET_RAW`, which `--cap-drop ALL` removes (`SD` `seccomp.ts:44-55`,
   `:147-159`, `executor.ts:969`). Neither an IPv6 path nor a route/interface
   can therefore be created ([inference] from the namespace shape at
   `executor.ts:966-968`).
2. **One reachable peer.** The only `AF_INET` listener in the namespace is the
   forwarder, and its only peer is the per-attempt socket the Runner bind-mounted
   (`SD` `egress-bridge.ts:100-111`, `:235-242`). The host's other Unix sockets
   are not mounted, so they are `ENOENT`, not access-controlled.
3. **One credential, one allowance.** Every request carries the per-run token;
   the gateway refuses anything else with a typed 401. The upstream key exists
   only in the Runner's trusted configuration.
4. **Fail closed.** A client that ignores the configuration (clears its
   environment, rewrites `HOME`, or hard-codes a provider URL) does not get an
   unmetered request: it gets `ENETUNREACH`, `EPERM`, or a refused connection.
   The worst case is a call that cannot be made, never a call that is not
   counted.
5. **Every child is inside the same namespace.** Task workers, prep workers and
   the report subprocess are children of the supervised engine in the same
   sandbox (`SF` `.../subprocess.py:24-58`, `.../control/reporting/__init__.py:46-56`).
   A child cannot leave the namespace; `setsid()` changes a session, not a
   namespace.

Denial evidence is part of the acceptance matrix (§7.3), not an assumption:
`AF_INET` to a provider address, DNS resolution, `AF_NETLINK`, an unmounted
socket path, and a token-less request are each attempted from real bwrap children
— a prep/task worker and the report subprocess.

Residual limits that remain true after this design:

- The workload shares the gateway's allowance by construction. A compromised
  engine can spend its own budget; it cannot spend another execution's.
- The gateway cannot stop the workload from *choosing* not to call a model.
- A host administrator is outside every boundary here, as in
  `controlled-execution.md` §0.1.
- The gateway is not a sandbox for the provider's content: a malicious provider
  response is a research-quality problem, not a budget one.

## 4. Identity and credential ownership

### 4.1 One identity tuple, one token

**[todo]**

```text
ModelBudgetIdentity = { executionId, attempt, gatewayGeneration }
```

- `executionId` — the existing deterministic identity, `^[A-Za-z0-9_:.-]{1,160}$`
  (`SD` `execution-manager.ts:377`).
- `attempt` — the engine's attempt; v1 allows exactly one
  (`controlled-execution.md` §4.2), and the bridge records it as
  `engine.attempt` (`SD` `packages/schema/src/research-run.ts:219-232`).
- `gatewayGeneration` — minted by the Runner at spawn and equal to `1` in v1.
  It exists so a future attempt/resume can never inherit a previous allowance
  by accident. A generation is never re-issued.

Token: 32 random bytes, hex encoded. The ledger stores `sha256(token)` only,
compared in constant time — the same discipline as `launchTokenDigest`
(`SD` `docs/en/design/scienceflow-controlled-execution.md` §4.2). The plaintext
exists in exactly two places: the Runner's in-memory record for the attempt, and
the sandbox-readable `models.json`.

Lifecycle:

| Event | Behaviour |
| --- | --- |
| Admission | A request whose token digest is unknown, revoked, expired, or bound to another execution gets `401` with `MODEL_GATEWAY_TOKEN_INVALID`; the same response for "unknown" and "foreign", so a probe learns nothing |
| Issuance | Immediately before spawn, after the in-gate verification of §4.7 of `controlled-execution.md`; never before, never on request |
| Expiry | At `hardDeadline` the token is revoked, so a later request is `401 MODEL_GATEWAY_TOKEN_INVALID`; a request admitted before the deadline whose remaining time runs out is aborted and answered `408 MODEL_DEADLINE_EXCEEDED` |
| Revocation | On a durable stop intent, on terminal record, on proven termination, on Runner shutdown; in-flight requests are aborted |
| Cancellation | The gateway aborts the upstream request; the reservation is charged (§5.4) |
| Runner restart | The token is gone with the process; open reservations are charged conservatively; no token is re-issued and no request is replayed |
| Gateway disconnect | The client sees a connection error; the gateway charges the reservation if it had already dispatched upstream |
| Attempt end | The socket is unlinked after termination is proven; a later connection attempt is `ENOENT` |

### 4.2 Where the credential lives

- **Upstream credential:** the Runner's trusted configuration, following the
  existing loader shape (one environment variable names one JSON file, read once
  at startup, static errors, no partial table — `SD`
  `services/runner/src/scienceflow-runtime-config.ts:19-45`). This round does
  not build a secret store: the file is `0600`, Runner-owned, and the design
  states that a deployment needing rotation or a vault must add one before a
  real start.
- **Per-run token:** the ledger (digest) and the sandbox `models.json`
  (plaintext). Never in a public DTO, never in ledger evidence, never in an
  artifact, never in a log line.
- **Provider endpoint:** a digest and the model id may be persisted; the URL
  itself stays in the Runner's config, consistent with the "no host paths"
  rule of `controlled-execution.md` §4.2.

### 4.3 Placement

- **Single host (the only shape this round reasons about in detail).** The
  gateway is a listener inside the Runner process, like the egress gateway
  registry (`SD` `services/runner/src/egress-gateway.ts`). One Runner process,
  one attempt, one socket.
- **Remote API/Runner.** Nothing in this design requires the API: the gateway,
  the credential and the ledger all live on the Runner. Provisioning the
  trusted config on a remote Runner host, and its rotation, are **not
  validated** and remain a deployment prerequisite, not a claim.
- **Native Windows** is out of scope: the research workload and its seccomp
  profile are Linux-only today (`SD` `research-run.ts` refuses unsupported
  sandboxes with `RESEARCH_SANDBOX_UNSUPPORTED`).

## 5. Enforceable limits and accounting

### 5.1 Units and authorities

| Dimension | Unit | Authority | Enforceable before forwarding? | Enforceable at all in this slice? |
| --- | --- | --- | --- | --- |
| Requests | count | gateway | yes | **yes** |
| Input size | request body bytes | gateway | yes (read the body, then admit) | **yes** — and `input tokens ≤ body bytes` is a guaranteed bound, because every token covers at least one byte |
| Input tokens | tokens | provider report | no | **accounting**; a token ceiling is enforced through the byte bound above |
| Output tokens | tokens | request `max_tokens` (mandatory) | yes | **yes**, per request; the ceiling subtracts the reservation before dispatch |
| Concurrent in-flight | count | gateway | yes | **yes** |
| Wall clock | ms | gateway request deadline; Runner schedule for the run | yes | **yes** (per request), plus the run's absolute deadline (§5.6 of `controlled-execution.md`) |
| Spend | currency | nobody | no | **no** |

Spend is explicitly **not promised**. The API has pricing and an estimated cost
(`SD` `services/api/src/model-usage.ts:386-409`; `SD`
`packages/schema/src/model-usage.ts:167-191` with `usageStatus: reported |
unreported`), but pricing is per-model catalog data with a currency, and the
Runner's trusted config is not that catalog. A currency guarantee would need an
authority the Runner does not have, so this design keeps cost as **post-hoc
estimation by the existing API accounting** and says so in the public evidence.
B3 stays blocked for spend; its token/time half is what this slice can evidence.

Defaults are configuration, not constants of the contract:

| Limit | Default (proposal) | Where it may be set |
| --- | --- | --- |
| `maxRequests` | 500 per attempt | Runner trusted config only |
| `maxInputBytes` | 8 MiB per attempt | Runner trusted config only |
| `maxOutputTokens` | 200 000 per attempt | Runner trusted config only |
| `maxInFlight` | 4 | Runner trusted config only |
| `perRequestTimeoutMs` | 300 000 | Runner trusted config only |
| `upstreamMaxAttempts` | `1 + maxRetries` (product default 3) | Runner trusted config only |

Nothing in a request, a manifest, a plan or a permission epoch can change them.
`SD` `services/api/src/scienceflow/execution-contract.ts:1292-1317` already
records budgets as `nature: "requested"`; that stays true, and this gateway is
what later makes any of them enforced.

### 5.2 Reservation before forwarding

**[todo]** One durable table in the Runner's existing SQLite ledger, written in
the same `BEGIN IMMEDIATE` style as `submit()` (`SD`
`execution-manager.ts:251-259`, `:414-428`):

```sql
CREATE TABLE model_budget (
  execution TEXT NOT NULL, attempt INTEGER NOT NULL, generation INTEGER NOT NULL,
  requests_accepted INTEGER NOT NULL DEFAULT 0,
  in_flight INTEGER NOT NULL DEFAULT 0,
  input_bytes_reserved INTEGER NOT NULL DEFAULT 0,
  output_tokens_reserved INTEGER NOT NULL DEFAULT 0,
  input_tokens_settled INTEGER NOT NULL DEFAULT 0,
  output_tokens_settled INTEGER NOT NULL DEFAULT 0,
  unknown_usage_charged INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (execution, attempt, generation)
);
CREATE TABLE model_reservations (
  id TEXT PRIMARY KEY,
  execution TEXT NOT NULL, attempt INTEGER NOT NULL, generation INTEGER NOT NULL,
  request_digest TEXT NOT NULL, idempotency_key TEXT,
  input_bytes INTEGER NOT NULL, output_tokens INTEGER NOT NULL, attempts INTEGER NOT NULL,
  state TEXT NOT NULL,            -- reserved | settled | charged_unknown | released
  input_tokens INTEGER, output_tokens INTEGER, cache_read_tokens INTEGER,
  refusal TEXT, created_at TEXT NOT NULL, settled_at TEXT,
  UNIQUE (execution, attempt, generation, idempotency_key)
);
```

**Admission is one transaction, before any upstream byte:**

```text
BEGIN IMMEDIATE
  load the bound limits (Runner config) and the row for (execution, attempt, generation)
  reject unless: token digest matches, not revoked, now < deadlineAt
  in    = request body bytes
  out   = max_tokens (mandatory, <= per-request ceiling)
  need  = attempts (= 1 + maxRetries) * (in, out)
  reject BUDGET_EXHAUSTED unless:
      requests_accepted + 1 <= maxRequests
      in_flight + 1 <= maxInFlight
      input_bytes_reserved  + need.in  <= maxInputBytes
      output_tokens_reserved + need.out <= maxOutputTokens
  requests_accepted += 1; in_flight += 1
  input_bytes_reserved += need.in; output_tokens_reserved += need.out
  insert reservation(state=reserved, attempts)
COMMIT
then dispatch upstream
```

Invariants, checked by the store on every read (a violated row is a refused
start, never a repaired one):

- `input_bytes_reserved + input_tokens_settled ≤ maxInputBytes`
- `output_tokens_reserved + output_tokens_settled ≤ maxOutputTokens`
- `requests_accepted ≤ maxRequests`
- `in_flight` equals the count of `reserved` rows for the identity.

The first invariant is sound despite mixing units, and only because of the bound
above: a settled request's reported input tokens never exceed the bytes it
reserved, so `settled tokens + bytes still reserved` cannot grow past the
ceiling. If a provider ever breaks that (reports more input tokens than bytes),
it is the `over-reservation` case below — never subtracted or clamped.

The input-unit mixing is deliberate and stated: the **ceiling** is in bytes and
is a hard bound on input tokens; the **settlement** is in provider-reported
tokens and only releases reservation. A provider that reports more input tokens
than body bytes would be a contract violation of the bound; in that case the
ledger records the reported count and marks the row `over-reservation`, and the
run's budget outcome becomes `unknown` rather than `within` — the Gateway never
silently "repairs" a count.

### 5.3 Settlement, abandonment, and crash windows

| Transition | When | Effect |
| --- | --- | --- |
| `settle` | The upstream legs are done and usage was reported | One transaction: `reserved → settled`, add reported `input_tokens`/`output_tokens`/`cache_read_tokens`, release `need − reported` from the reservation counters; idempotent by reservation id |
| `abandon(not-dispatched)` | Refused, aborted, or the upstream connection failed before any request byte was written | Release the full reservation, delete the row (or mark `released`) |
| `abandon(dispatched)` | Client disconnect, gateway cancellation, provider timeout/error after dispatch, or a stream cut before the usage record | `reserved → charged_unknown`: charge the **whole** reservation, add to `unknown_usage_charged`, because an ambiguous upstream call may have been billed |
| `expire` | `hardDeadline` reached | All `reserved` rows for the identity become `charged_unknown`; the token is revoked |
| `revoke` | Stop intent, terminal record, shutdown | No new admission; in-flight requests are aborted and charged as above |
| Crash windows | (a) crash after the reservation commit and before dispatch, (b) crash after dispatch and before settle, (c) crash during settle | (a) and (b) look identical to the ledger; on restart both are `charged_unknown` — never released, never retried. (c) is atomic in SQLite: either the settle or the reservation stands |

**Accounting storage unavailable is a refusal, not a fallback.** If the ledger
cannot be written, the gateway answers `503 MODEL_GATEWAY_LEDGER_UNAVAILABLE`
and forwards nothing. There is no "allow but log" mode.

### 5.4 Streaming, omission, disconnects, retries, idempotency

| Situation | Accounting rule |
| --- | --- |
| Normal stream with usage in the final chunk | Settle on reported counts; release the remainder |
| Stream ends with no usage record | Charge the reservation (`charged_unknown`); the response the client received is still delivered |
| Client disconnects mid-stream | Abort upstream, charge the reservation; the partial text the client already read is not re-served |
| Provider 5xx/429 before the first token | The gateway's own client may retry up to `attempts`; the reservation already covers `attempts × (in, out)`; if every attempt fails without any reported usage, charge the reservation |
| Provider returns usage for a retried attempt only | Settle the reported attempt; the failed attempts stay inside the charged reservation |
| Request rejected before dispatch (400/401/403) | No charge; the request counter does not advance |
| `Idempotency-Key` header present | Unique `(execution, attempt, generation, key)`: a repeat returns the recorded outcome and does not reserve again, within the attempt's lifetime |
| No idempotency key (today's engine client sends none) | Each TCP request is a separate admission; **no duplicate suppression is promised**. The guarantee is the ceiling, not exactness |

That last row is the honest limitation: the engine's OpenAI client sets no
request identifier, and adding one would be an engine change. The bound that
survives without it is the budget itself.

**Why a client retry cannot reset the budget:** the counters live in the Runner
ledger keyed by the identity tuple, not in the client; the token is minted once
per spawn and has no renewal path; there is no endpoint that clears or extends a
budget; and a client that opens a new connection still presents the same token
and hits the same counters in the same transaction. The engine's own retries
(`httpx` transport retry, `PooledLLM` failover, the gateway client's pre-stream
retry) each become admissions that the reservation already anticipated.

### 5.5 What is durable, and what the public evidence may say

Durable: the two tables above, written before forwarding and settled after,
inside the Runner's existing ledger file. The gateway's in-memory state is a
cache of them.

Public, redacted, additive evidence (`[todo]`, to join `ResearchRunStatus`):

```text
model: {
  gatewayGeneration, modelId?, endpointDigest?,          // no URL, no key
  requests: {accepted, refused: {code: count}, completed},
  inputBytes, outputTokensReserved, outputTokensSettled,
  inputTokensSettled, cacheReadTokensSettled, unknownUsageCharged,
  outcome: "within" | "exhausted" | "unknown"
}
```

Never public: the token, the upstream credential, the endpoint URL, prompts,
completions, or a per-request body digest that could be correlated to content.
`outcome: "unknown"` covers an unproven termination, a crash-orphaned
reservation, a provider-report/byte-bound contradiction, and an unreadable
ledger — never "within".

## 6. Lifecycle and failure behaviour

The gateway is a *usage* authority, not the run's lifecycle authority. The four
orthogonal facts of `controlled-execution.md` §5.1 keep their meanings.

### 6.1 Exhaustion during research versus reporting

| Moment | Engine behaviour | Public result |
| --- | --- | --- |
| Research: a task's model call is refused (403 `MODEL_BUDGET_EXHAUSTED`) | The call is non-retryable; the task fails; the engine's record decides `research_status` (`failed`, or `completed` if the engine recovered by other means) | `execution` from the Runner ledger/boundary proof; `research` from the engine record; `model.outcome = "exhausted"` |
| Research: a stop intent and exhaustion coincide | The stop stays the cause of termination; the gateway has already revoked on the durable intent | `cancelled` + `research: stopped` (or `not-started` per the E3 short-circuit); `model.outcome` records the refusals that happened before the stop |
| Reporting: the enrichment call is refused | `enrich_report()` catches it and degrades: the report is still written from baseline evidence (`SF` `analysis.py:539-554`) | `research` unchanged; `report` from `report_status`; `model.outcome = "exhausted"` is the only place the exhaustion is visible |
| Reporting: the report budget expires first | The supervisor kills the report child at its own budget (`SF` `…/control/reporting/__init__.py:57-75`) | `report: incomplete`; `research` preserved; gateway reservations charged unknown |

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
- A refused gateway start (missing config, socket cannot be created, ledger
  unavailable, relay unsupported) refuses **the start**, before spawn, with a
  fixed code. There is no "run without metering" mode.

### 6.3 Fixed error codes and redaction

New, additive, fixed vocabulary (the persisted `RESEARCH_REFUSAL_CODES` keep
their meaning, `SD` `packages/schema/src/research-run.ts:179-209`):

| Code | HTTP | Retryable by the engine | Meaning |
| --- | --- | --- | --- |
| `MODEL_GATEWAY_TOKEN_INVALID` | 401 | no | unknown, foreign, expired or revoked token |
| `MODEL_GATEWAY_IDENTITY_MISMATCH` | 401 | no | token bound to another execution/attempt/generation |
| `MODEL_BUDGET_EXHAUSTED` | 403 | no | a ceiling would be exceeded |
| `MODEL_NOT_ALLOWED` | 403 | no | model outside the Runner allowlist |
| `MODEL_REQUEST_UNSUPPORTED` | 400 | no | field, shape, image, `n != 1`, or missing `max_tokens` |
| `MODEL_DEADLINE_EXCEEDED` | 408 | no | run deadline reached |
| `MODEL_GATEWAY_UNAVAILABLE` | 503 | yes (transport) | gateway not listening, or the attempt is over |
| `MODEL_GATEWAY_LEDGER_UNAVAILABLE` | 503 | no (fails the task) | accounting storage cannot be written |
| `MODEL_UPSTREAM_FAILED` | 502 | yes (bounded) | provider error after dispatch |
| `MODEL_USAGE_AMBIGUOUS` | — | — | outcome field only: a dispatched request was charged without a usage report |

403 and 400 are chosen over 429 on purpose: this client treats 429 as a
retryable rate limit (`SF` `…/llm_pool.py` failover and cooldown), and a budget
refusal must end the call, not teach the engine to try again. Errors never
include the prompt, the completion, the token, the URL, or a provider body.

`MODEL_GATEWAY_UNAVAILABLE` on a live attempt means the socket is gone (Runner
crashed or the attempt was closed); the engine's transport error is not retried
into a second unmetered path — there is none.

## 7. The next implementation slice

### 7.1 Goal and boundary

**[todo]** One Runner-owned model gateway for the research workload, with a
synthetic local provider, no real credential, no model cost, and no API start
action. It removes the *mechanism* half of B2 (a gateway exists, is reachable
only through the sandbox contract, and refuses to run unmetered) and the
*request/token/concurrency/time* half of B3. It does not clear B2's product half
(real credential, real provider), does not clear spend, and touches no other
blocker.

### 7.2 Files and contracts

| File | Change |
| --- | --- |
| `packages/schema/src/model-budget.ts` (new) | identity tuple, limit shape, refusal codes, observation type, redaction rules |
| `services/runner/src/model-gateway.ts` (new) | Unix-socket HTTP server, inbound allowlist, token check, reservation/settlement calls, upstream leg via `streamModelTurn` |
| `services/runner/src/model-budget-store.ts` (new) | the two tables, transactional admit/settle/abandon/expire, invariant checks |
| `services/runner/src/model-gateway-config.ts` (new) | trusted config loader, versioned JSON, static errors (shape of `scienceflow-runtime-config.ts`) |
| `services/runner/src/model-gateway-bridge.ts` (new) | fixed forwarder script + bind/commandPrefix/env builders, mirroring `egress-bridge.ts` |
| `services/runner/src/executor.ts` | a Runner-owned `modelGateway` launch option contributing `bindArgs`, `commandPrefix`, `XDG_CONFIG_HOME`; the `research-gateway` seccomp variant |
| `services/runner/src/seccomp.ts` | the variant and its `socket()` domain filter |
| `services/runner/src/research-run.ts` | create/close the gateway around one attempt; materialize `models.json`; carry the observation into the ledger |
| `services/runner/src/scienceflow-engine-bridge.ts` | set `XDG_CONFIG_HOME` to the mounted config dir; re-check the derived manifest for endpoint keys |
| `services/runner/package.json` | add the `@sciencediscovery/model` workspace dependency |
| tests | see §7.3 |

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
| G3 | `maxInFlight = 2` | Two simultaneous requests, then a third | Third waits or is refused with `MODEL_BUDGET_EXHAUSTED`; counters never exceed limits |
| G4 | `maxRequests = 1` | Two requests | Second refused 403; no upstream call |
| G5 | `maxOutputTokens` small | Request with `max_tokens` above the remaining allowance | Refused before dispatch; provider sees no request |
| G6 | Provider reports no usage | Complete request | `charged_unknown`; `model.outcome = "unknown"`; reservation not released |
| G7 | Client disconnects mid-stream | Abort | Upstream aborted; reservation charged; no second request |
| G8 | Provider 500 on attempt 1, success on attempt 2 | One request | One admission; settlement from attempt 2; attempts ≤ `upstreamMaxAttempts` |
| G9 | Two requests with the same `Idempotency-Key` | Repeat | Second returns the recorded outcome; `requests_accepted` unchanged |
| G10 | Two requests with different keys | Repeat | Two admissions; ceiling still honoured |
| G11 | Durable stop intent while a request is in flight | Stop | Token revoked; in-flight aborted and charged; no request after the stop |
| G12 | Real task child connects to the synthetic provider's IP:port directly | Bypass attempt | `ENETUNREACH` or `EPERM`; gateway ledger unchanged |
| G13 | Real task child resolves a hostname | Bypass attempt | DNS fails; no socket reaches the provider |
| G14 | Real task child calls `socket(AF_NETLINK)` / `AF_PACKET` | Bypass attempt | `EPERM` from seccomp |
| G15 | Real task child connects to an unmounted host socket path | Bypass attempt | `ENOENT` |
| G16 | Real task child calls the gateway without a token / with another execution's token | Bypass attempt | 401; no admission |
| G17 | Real report subprocess makes a model call | Attribution | The request appears in the same attempt's budget, proving reporting is metered |
| G18 | Real prep/task child clears its environment and hard-codes the loopback URL | Fail-closed | Without the token: 401; with the token: metered. Neither reaches the provider unmetered |
| G19 | Ledger write fails (injected) | Start a request | 503 `MODEL_GATEWAY_LEDGER_UNAVAILABLE`; nothing forwarded |
| G20 | Gateway cannot create its socket or relay | Start the run | Start refused before spawn with a fixed code; no workload |
| G21 | Crash window: kill the Runner between reservation and settle | Restart, re-read | Row `charged_unknown`; counters never reset; no replay |
| G22 | Sealed run ends normally | Observe | Socket removed; `model` evidence present; `outcome = "within"` |

Every row is a design expectation. G3–G11 exercise the store; G12–G18 must run
inside a real bwrap sandbox with the `research-gateway` filter, because the
bypass claim is about the kernel, not about TypeScript.

### 7.4 What stays blocked, and the evidence liyuan must supply

After this slice, and only with the real-provider evidence below:

| Claim | Status after the slice | Evidence still required |
| --- | --- | --- |
| B2 `model_gateway_not_configured` | blocked | one real model call through the gateway with a real credential that exists only in the Runner config; the provider must not see the sandbox's token; the same run repeated with a revoked token |
| B3 tokens/requests/time | mechanism only | a real run that reaches each ceiling, plus a real streamed call whose provider usage equals the settled ledger counts (including cache tokens) |
| B3 spend | blocked | not in this slice; needs a Runner-side pricing authority, which does not exist |
| B1/B4/B5 | unchanged | out of scope |
| Remote Runner, native Windows | not validated | separate deployments |
| No-bypass | targeted evidence only | the G12–G18 denials reproduced with the pinned engine and the real image, on the real host kernel |

No token, spend or no-bypass claim may rest on mocks alone. The tests prove the
mechanism; the product claim needs the real boundary.

## 8. Decisions and remaining blockers

Resolved here:

1. **The engine's endpoint is configuration, not environment.** The control is a
   per-execution `models.json` reached through `XDG_CONFIG_HOME`, because the
   engine's client installs its own transport and ignores proxy variables, and
   because `CODE_*` is only a projection in this engine.
2. **The transport is a bind-mounted Unix socket behind the existing sandbox
   forwarder.** No host loopback URL, no `--share-net`, no proxy environment.
3. **The sandbox change is one seccomp variant with an `AF_INET`/`AF_UNIX`
   domain filter**, keeping `--unshare-all`, `--cap-drop ALL` and the cleared
   environment. The no-bypass argument rests on the namespace having no route
   and on one reachable peer; it does not rest on an address filter, which the
   current seccomp primitive cannot express.
4. **Every child is covered by construction**, because the configuration is
   inherited and the namespace is shared. Reporting is metered on the same
   allowance, and its failure degrades the report rather than the research.
5. **Reservation is a durable SQL transaction before dispatch**, with a byte
   bound for input, `max_tokens` for output, a request counter, an in-flight cap
   and the run deadline. Ambiguous dispatches are charged, never released.
6. **Spend is not enforceable** and is not promised; tokens are.
7. **A gateway that cannot meter refuses the start.** There is no bypass mode.

Remaining blockers and prerequisites:

- A Runner-side trusted model config with an upstream credential, and its
  rotation story, before any real call.
- Real-provider evidence (§7.4) before B2 moves.
- A pricing authority on the Runner before any spend claim.
- A tracked engine revision is still required for a real start
  (`controlled-execution.md` §3.6); this design adds no engine patch.
- The start route, input delivery for datasets, and the API start action are
  untouched.

None of this authorizes a start: the five blockers and `canStart: false`
remain until each has execution-time evidence.
