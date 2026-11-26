# Integrate a research engine with the shared task service

Use this guide when connecting an external research product to ScienceDiscovery
(SD). The shared task service accepts an authorized request, persists one
operation, starts an engine, observes it, stops it, enforces a research-line
budget and publishes its result into a Session. Your engine may use HTTP MCP,
another service API, or a local process; the adapter implements that
communication.

The shared service is an internal TypeScript integration point in the SD API.
Implementing an adapter does not install your product, register an Agent tool or
expose an HTTP route; those remain your product's entry points, which delegate
to this service.

## What is shared and what stays product-specific

| Component | Responsibilities |
| --- | --- |
| Shared task service (`research/task-service.ts`) | Request admission (Project/Session ownership and write access), deduplication, one live operation per conversation run, the cancelled-conversation check, budget reservation and refusal, persistence, background execution, bounded observation, stop request versus confirmed termination, conversation cancellation, delivery retry, latest/list reads |
| Shared operation repository (`research/task-repository.ts`) | SQLite table, identity columns, insert-if-absent deduplication, corruption checks, Session/Project deletion |
| Shared operation lifecycle (`research/operation-lifecycle.ts`) | Preparation-window cancellation, launch/observe sequencing, the unknown-without-a-record rule, stop confirmation, one automatic publication, retry without relaunch |
| Shared budget ledger (`research/budget.ts`) | Research-line deadline, child-run limit, wall-clock reservation and settlement, single active child, stop per conversation run, durable decision history |
| Shared input binding (`research/input-binding.ts`) | Exact Session artifact versions, CAS byte verification, configured-input comparison |
| Shared artifact publisher (`research/artifact-publisher.ts`) | CAS write, content-addressed version reuse, digest verification, linked-version resolution |
| Product hooks (`ResearchTaskProduct`) | Permission/configuration gate, request validation and record construction, model or task resolution, frozen grant, engine capabilities and adapter, public view, line identity |
| Execution transport (`ResearchExecutionTransport`) | Launch/contact the engine, map its status and progress, request and confirm cancellation |
| Shared engine service (`research/engine-service.ts`) | Order preparation steps, recheck cancellation after asynchronous work, persist preparation failures, compose launch policy and delivery with the transport |
| Product domain code | Metric direction, comparability, best/selected candidate, proof validity, task packages and evaluators, file layout and result prose |

The shared modules under `services/api/src/research/` never import a product's
code, configuration, model profile or data layout. A product that has no
ScienceFlow code can use them directly; the repository keeps that boundary
under test (`research/architecture.test.ts`).

## Shared Runner execution path

Runner is part of the shared execution platform. A product using a local
sandboxed program does not implement its own execution manager, input store,
process supervisor, recovery ledger, phase scheduler or result transport.

`createRunnerServer({ ...config, researchWorkloads: [...] })` registers trusted
`ResearchRunWiring` definitions. A fixed program uses `workloadId` and `program`;
a program needing engine preparation supplies a `ResearchWorkloadAdapter`.
The registry rejects duplicate workload IDs and refuses unregistered IDs before
creating an execution. Registrations are trusted host configuration: an API
request cannot supply a program, arbitrary mount or executable configuration.

The signed Runner protocol is:

| Endpoint | Purpose |
| --- | --- |
| `POST /research/input-bundles` | Validate and atomically store immutable input bytes |
| `GET /research/input-bundles/:digest` | Read verified input manifest identity |
| `POST /research-executions` | Submit a registered workload using a durable execution ID |
| `GET /research-executions/:id` | Observe the managed execution |
| `POST /research-executions/:id/cancel` | Request termination through the execution manager |
| `GET /research-executions/:id/files?path=...` | Read verified bytes from the committed result snapshot |

Requests use the existing Runner MAC and owner checks. The existing
`shell-executions` observation/cancel aliases access the same managed ledger;
the SDK can use those aliases for research executions. Files are read from
`execution.result.workspaceSnapshot`, never from the mutable live workspace.

`RunnerClient.prepareResearchInputBundle`, `submitResearchExecution` and
`readResearchExecutionFile` implement this protocol. API products can use
`research/runner-engine-adapter.ts:createRunnerTaskEngine` rather than writing
the transport themselves. Its `RunnerTaskRecord` freezes the request, exact
Session input artifact versions and intended outputs. The adapter verifies CAS
bytes before upload, persists the execution handle before submission, maps the
remaining budget into Runner's phase schedule, observes termination, and
publishes committed outputs using the shared artifact publisher. A lost launch
response leaves an observable handle; delivery retry reuses that execution.
The joint `runner-task-service.test.ts` exercises this path with an ordinary
fact file and a fixed proof program, without an external research product.

`research-input-bundle.ts` defines product-neutral file roles and integrity
limits. Products may impose stricter role policies through an injected
`ResearchInputBundleProtocol`. Shared Runner code owns descriptor-safe storage,
private copy, sandbox mounts, phase/stop supervision, termination evidence,
resource fences, recovery and CAS snapshot publication. An engine adapter owns
engine checkout verification, engine-specific arguments and evidence parsing.
Engine evidence can use an `engineId` and `engineRunId` without fabricating
another product's revision metadata. Legacy evidence records remain readable.

## Compose a transport with platform services

Implement `ResearchExecutionTransport` for engine communication and format
conversion. Pass it to `createResearchEngineService` with preparation steps,
record transitions, an engine grant mapper and a delivery callback. The service
checks persisted stop intent, terminal state and conversation cancellation
between asynchronous steps and after the owner lookup; a failed step cannot
revive a stopped operation. The existing `ResearchEngineAdapter` remains the
composed contract consumed by the task lifecycle.

Use `withResearchPreparationWorkspace` for disposable probe state,
`observeResearchPreparation` for durable attempt observations, and
`overhead-ledger.ts` for preparation time, probe counts and model usage
summaries. Products choose scientific attribution; the platform preserves
unknown time/usage separately from measured zero. `ResearchVersionRepository`
stores immutable evidence bound to exact artifact versions, verifies mirrored
row identities and refuses conflicting re-records. Its configurable table and
column names support existing product records without migration.

Product-specific artifact descriptions and result selection belong in product
services; those services call `publishArtifactVersion` and `publishResearchPlan`
for CAS/catalog/version behavior. A transport does not publish artifacts or
register SD result records as a side effect of launch.

## Shared persistence and preparation

`ResearchBudgetRepository` provides a concrete validated SQLite budget store.
`ResearchScopeRepository` and `ResearchEventRepository` supply durable scoped
records and append-only preparation/usage events with product codecs. Their
table and legacy column configuration lets existing integrations retain their
stored JSON and identities. `observeResearchPreparation` records timing and
failure with unknown duration kept distinct from measured zero. Plan version
publication is in `research/plan-publication.ts`, separate from output-content
reuse because publishing against a stale plan head must fail.

`research/execution-instance-backend.ts` and `execution-instance-store.ts`
provide the explicit host-process boundary and its durable records. This is a
separate execution choice with host-level isolation; selecting the sandboxed
Runner never silently falls back to it. Moving this implementation into the
shared directory does not change an existing product's runtime selection.

The task service checks and reserves deadlines before launch; Runner's phase
clock begins when the sandbox process starts. This is not an absolute deadline
watchdog across distributed preparation and transport. Token hard caps require
engine support; a reservation alone does not enforce token consumption. Budget
reservation remains serialized within one task-service process, not a distributed
multi-writer transaction.

## Request admission and deduplication

The shared service performs these steps in order, and a product cannot skip
them by re-implementing `start`:

1. Reject blank Project, Session or run ids.
2. Prove the Project exists, the Session belongs to it, and the Session is
   writable.
3. Run the product's `authorize` hook (configuration/model or additional
   permission policy).
4. Look up the product's idempotency key. An existing operation is returned as
   `attached: "same-request"` and nothing is launched.
5. Attach to the conversation run's live operation when one exists
   (`attached: "active-operation"`).
6. Refuse a start whose owning conversation run was already cancelled.
7. Ask the product to validate and freeze the request (`planStart`). A product
   may resolve a late deduplication key here (for example after following an
   automatic selection) by returning `attachTo`.
8. Reserve the research-line budget; a refusal is thrown before any row exists.
9. Persist the accepted operation and its reservation, then run the engine in
   the background and return the SD operation id promptly.

Execution permission remains a product entry concern: the production tool
passes SD's governed privilege check before it calls the service, and the
service still proves ownership and write access on every request.

The shared service never treats a tool's execution authorization as a user's
acceptance of a formal proposition or a scientific claim. A product that needs
an explicit confirmation keeps it as its own version-bound domain fact and
checks it in `authorize` (before admission) or in `deliver` (before publishing a
proof). This release provides the extension point, not a proof-signing system.

## Define an operation record

Extend `ResearchTaskRecord<Delivery>` with the durable engine handle, frozen
input references, launch configuration and other metadata your adapter needs.
The shared service reads only the neutral fields:

- `operationId`: SD's identity for the accepted operation.
- `identity.projectId` and `identity.sessionId`: the owning Project and Session.
- `ownerRunId`: the conversation run whose cancellation owns the work.
- `engineId`: the registered engine identity.
- `engineRunId`: the engine's durable task handle. Never rely only on an
  in-memory process object.
- `state`, `stop`, `delivery` and `engine.status`.
- `idempotencyKey`, `createdAt`, `updatedAt` and an optional `error`.

The lifecycle state is `accepted`, `running`, `stopping`, `completed`, `failed`,
`stopped`, or `unknown`. Map engine facts explicitly; `completed` says nothing
about scientific validity. Keep result validation and any user confirmation as
separate domain facts.

Persist the product record through `ResearchTaskRepository` with a codec. The
codec validates the product's stored JSON and throws
`ResearchOperationCorruptError` for a corrupt or unknown-version row; a row is
never skipped or repaired silently. Reusing an existing table name keeps one
ledger per task, so an older data directory upgrades in place and no second
source of truth can disagree with the first. Deletion of a Session or Project
removes its rows through the same repository.

## Implement the engine adapter and declare its capabilities

Implement `ResearchEngineAdapter<Record, Delivery>`:

| Method | Contract |
| --- | --- |
| `prepare(record, signal, writer)` | Stage frozen inputs or perform engine preparation. Honor the abort signal. Return `proceed: false` after recording a terminal outcome |
| `beforeLaunch(record, writer, budget)` | Apply the shared allowance/deadline cap and engine-specific minimums; return `appliedAllowanceSec` when applying a cap. Return a refusal with a stable step and safe message |
| `launch(record, writer)` | Launch once and persist the engine handle and running state. Return the engine run id. Do not assume an engine status you have not read |
| `inspect(record)` | Read engine status without persisting; report whether a run exists and is terminal |
| `observe(record, writer)` | Read and persist current facts, then return the record, terminal flag and mapped state |
| `requestStop(record)` | Ask the engine to stop this specific task; return safe error information |
| `confirmStop(record)` | Wait a bounded time for authoritative termination evidence |
| `deliver(record, { force })` | Publish existing results into the Session. Never launch or rerun research |

Supply `transitions` for the record edits the lifecycle needs: stopped,
conversation-cancelled, stopping, stop-requested, stop-result, failed, unknown
and delivery-failed.

Declare `capabilities` on the product: whether `launch` can return while the
engine still runs, whether the engine confirms termination, whether it reports
elapsed wall clock or token usage, and what `deliver` publishes. A declaration
never creates a capability the adapter does not implement, and the shared
service never claims a token hard cap it cannot enforce.

## Research-line budget

Pass the frozen product identity key (`lineKey`) that groups child runs. For a
ScienceFlow-style experiment this is one scientific contract; for another
product it can be any stable business key. The shared ledger enforces:

- one active child per line;
- a stop recorded for one conversation run, so a later start in that
  conversation cannot quietly reserve another child;
- a deadline (`createdAt + totalAllowanceSec`) that a new child's whole
  allowance must fit before it is reserved;
- a configurable child-run limit;
- reservations for active children and settlements for terminal ones.

After asynchronous planning, the service rereads idempotency, the owner's
active operation and `lineFactsFor(record)` before reserving without an await.
`lineFactsFor` must return fresh stored children even for a planned record that
has not yet been inserted; do not return the planning snapshot.

After preparation, the service recomputes the allowed wall clock from the
reservation, remaining quota, attributable overhead and deadline. An exhausted
line cannot launch. `beforeLaunch` receives this cap; the adapter applies its
engine's minimums and research/report split and returns `appliedAllowanceSec`.
If a reduced cap is not acknowledged, the service refuses launch. Applied caps
are persisted in the reservation. Actual termination at the cap depends on the
engine enforcing its applied limit; the service is not an execution watchdog.

A launched child whose elapsed time is unknown is charged its reservation,
never zero; a preparation that never launched is charged its observed operation
wall clock. A rebuilt service reconstructs the same answer from stored children,
so a restart does not reset used budget. The ledger records a token status and
never promises a total token cap. Charge product-attributable preparation time
through `extraChargedSeconds`; it is counted in the same remaining allowance.

## Inputs and result publication

`resolveSessionArtifactVersion` proves that a named version is a live version of
the authorized Session. `bindExactVersionInput` reads the CAS bytes, verifies
the recorded digest and size, and optionally proves equality with the configured
input the product will stage. Freeze the verified digest in your record so a
later version, profile edit or rebuild cannot change what runs.

`publishArtifactVersion` writes bytes to the existing CAS and creates or reuses
a Session artifact version. Calls for the same Session/name on one store are
serialized through lookup and publication, including failed attempts. Identical
bytes return the existing version, so a
repeat or retry does not create a duplicate. An optional digest is verified
before publication. `resolveLinkedArtifactVersion` links a fixed version (a
plan, an incumbent, a proof input) without authoring or rewriting it. Bind
outputs to the operation, frozen input versions and engine result identity with
your own `originMeta` fields.

A non-metric result — a proof, a report, a note — is published as its own
artifact; it does not have to masquerade as a metric-bearing experimental
candidate. Publication failure is distinct from execution failure, and a retry
publishes only an existing result.

## Wire the entry points

The shape of a product object is small; the shared service supplies the rest.

```ts
const product: ResearchTaskProduct<MyRequest, MyDelivery, MyRecord, MyView> = {
  engineId: "my-engine",
  capabilities: {
    asynchronousLaunch: true,
    confirmsStop: true,
    delivers: "one verified result file",
    reportsElapsedSec: true,
    reportsTokenUsage: false,
  },
  engine: adapter,
  requestIdentity: (request) => ({
    ownerRunId: request.ownerRunId,
    projectId: request.projectId,
    sessionId: request.sessionId,
  }),
  authorize: async (request) => { /* product permission/configuration gate */ },
  idempotencyKey: (request) => stableHash(request),
  planStart: async (request, context) => {
    const key = stableHash(request);
    const existing = context.operations.findByIdempotency(
      request.projectId, request.sessionId, key,
    );
    if (existing) return { attachTo: existing };
    const createdAt = context.now();
    const operationId = context.newOperationId();
    const record: MyRecord = {
      schemaVersion: MY_VERSION, operationId, idempotencyKey: key,
      identity: { projectId: request.projectId, sessionId: request.sessionId },
      ownerRunId: request.ownerRunId, engineId: "my-engine", engineRunId: null,
      state: "accepted", createdAt, updatedAt: createdAt,
      delivery: { state: "pending", attempts: 0, updatedAt: createdAt },
      stop: {}, engine: {},
    };
    return {
      dedupeKey: key,
      line: {
        allowanceSec: request.allowanceSec,
        children: context.operations
          .listForSession(request.projectId, request.sessionId)
          .map(childBudgetFacts),
        lineId: "my-line", lineKey: "my-line-key",
      },
      record,
    };
  },
  refuse: (reason, message) => new MyRefusal(reason, message),
  present: (record) => viewFor(record),
  lineFactsFor: (record) => ({
    children: operations.listForSession(record.identity.projectId, record.identity.sessionId)
      .map(childBudgetFacts),
    lineId: "my-line", lineKey: "my-line-key",
  }),
};

const service = createResearchTaskService({
  store, operations, lines, product,
  observeMaxWaitMs: 30_000,
});
```

`operations` is a `ResearchTaskRepository` over your table and codec; `lines` is
your durable research-line store. The service exposes `start`, `get`, `stop`,
`retryDelivery`, `cancelOwnerRun`, `latest` and `list` (list may instead be
projected by the product's own read path).

Wire them as follows:

1. The product entry point performs its own governed execution-permission check,
   then calls `start`. Do not rebuild request validation, deduplication or
   cancellation in the entry point.
2. `get` observes the engine. Waiting is bounded by `observeMaxWaitMs`; aborting
   a wait does not cancel engine work.
3. `stop` returns `requested` and `confirmed` separately. A recorded request is
   not evidence that processes or remote jobs have ended.
4. `cancelOwnerRun` stops the operations owned by one conversation run and
   records the line's stop.
5. After a restart, `get` or `latest` reads the same rows and observes the
   existing engine task. It never resubmits a paid task.
6. `retryDelivery` publishes only terminal tasks. Active tasks stay pending and never call the publisher. It never launches.

## Latest observations and runtime probes

`ResearchGenerationRepository<T>` stores the latest observation for an owned
key. Call `allocate(projectId, sessionId, key)` before external work, then `save`
with the issued generation. Only a strictly newer generation replaces the row;
a slower writer receives the persisted winner. Allocation, conditional writes
and owner deletion use SQLite write transactions, so a late response cannot
recreate a deleted row after its allocation was removed. Products supply
`encode`/`decode`, a corruption error, and optional legacy table/column names.
The codec reduces private data before persistence and validates reduced records
on writes and reads. This differs from `ResearchVersionRepository`, which owns
immutable evidence rather than replaceable observations.

The Runner's `createRuntimeProbeService` leases an environment through
`withEnvironment({ scopeKey, environmentId }, operation)`. The scope and
environment are exclusive within that service instance; after acquiring the
lease the service rechecks durable termination reservations. The operation
receives the leased environment and a `run` method for a trusted Python program,
interpreter flags, read-only inputs, timeout and output limit. This is an
internal adapter port, never a route for user-supplied programs or host paths.
Programs run through the ordinary bubblewrap sandbox with the selected prefix.
The service captures termination evidence, retains unproven boundaries behind
the environment mutation gate, and removes temporary workspaces only after
termination is proven (or no process started). Product modules own protocol
parsing, source identity rules, and the order of probe phases. A workload that
already owns its environment lease can call `runRuntimeProbe` directly; it
must retain any returned unverified boundary behind its existing mutation gate.
Missing durable
reservation ports provide only an in-process fence, suitable for test doubles.

## Integration limits

The shared service does not provide engine installation, credential
distribution, model selection, a sandbox, remote authentication, a proof-signing
system, or a general model proxy. Those stay with the product or its execution
boundary. The worker, preparation-abort, delivery locks and the budget
reservation are process-local: reservations are checked and written without an
intervening await, which is atomic within one API process, but a deployment with
several API processes must serialize starts for a line in its store or
scheduler. Publication serialization is scoped to one SessionStore instance;
multiple store owners require a shared catalog transaction/coordination layer. The session cancel path must call `cancelOwnerRun`; the service does
not observe conversation state by itself unless the product supplies an
`ownerStopped` reader.

## Verify an integration

Exercise the product through the real task service, real repository and real
publication path with a fake engine. The fake engine needs no product
configuration, model profile, Python checkout, seed or evaluator, and its result
can be an ordinary file with a verified digest. Cover: submit, replay
deduplication, one active child, running delivery stays pending, terminal
delivery happens once, restart observes without relaunch, a missing engine
record becomes `unknown`, cancellation, reservation and run-limit refusals, and
delivery failure/retry reusing one version.

The shared
[`task-service tests`](../../../services/api/src/research/task-service.test.ts)
and
[`lifecycle tests`](../../../services/api/src/research/operation-lifecycle.test.ts)
are runnable examples that require no engine installation. A product's own
domain rules (task packages, evaluators, metric comparison, best candidate,
proof semantics, file layout) belong in the product; see the ScienceFlow README
for one product's retained rules and limits.
