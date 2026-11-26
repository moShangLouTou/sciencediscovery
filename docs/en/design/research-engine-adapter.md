# Integrate a research engine with the task lifecycle

Use this guide when connecting an external research product to ScienceDiscovery
(SD) and you need to track long-running work, stop it, and publish its results
into a Session. The shared task lifecycle is an internal TypeScript integration
point in the SD API service. Your engine may use HTTP MCP, another service API,
or a local process; the adapter implements that communication.

The integration has three parts: a product entry point accepts a request and
persists an operation, the shared lifecycle coordinates that operation, and an
engine adapter performs the product-specific work. Implementing the adapter
does not automatically register an Agent tool, expose an HTTP route, or install
your product.

## Responsibilities

| Component | Responsibilities |
| --- | --- |
| Product entry point | Validate Project/Session access, execution permission, required inputs and user confirmations; freeze input versions and configuration; reserve any budget; persist and deduplicate accepted requests; expose tools or routes |
| Shared lifecycle | Recheck conversation cancellation around preparation, coordinate launch and observation, distinguish stop requests from confirmed termination, reconcile existing runs, and coordinate result delivery and retry |
| Engine adapter | Prepare inputs, launch or contact the engine, map its status, request and confirm cancellation, and publish its result with provenance |
| Operation store | Persist operation identity, engine task handles, state and delivery records; provide current records to concurrent callbacks and after service restart |

The shared implementation lives in
[`engine-adapter.ts`](../../../services/api/src/research/engine-adapter.ts) and
[`operation-lifecycle.ts`](../../../services/api/src/research/operation-lifecycle.ts).
Those modules have no dependency on a particular research product. Scientific
decisions, such as how to interpret a proof or compare experimental scores,
belong to your integration.

## Define an operation record

Extend `ResearchOperationRecord<Delivery>` with the durable engine handle,
frozen input references and other metadata your adapter needs. Keep these
identities separate:

- `operationId`: SD's identity for this accepted operation.
- `identity.projectId` and `identity.sessionId`: the Project and Session that own it.
- `ownerRunId`: the conversation run whose cancellation owns the work.
- Engine task handle: the engine's identity, stored in your record for later
  observation and cancellation. Never rely only on an in-memory process object.

The operation's lifecycle state is `accepted`, `running`, `stopping`,
`completed`, `failed`, `stopped`, or `unknown`. Map engine facts explicitly;
`completed` alone says nothing about the scientific validity of the result.
Keep result validation and any user confirmation as separate domain facts.

Define your delivery payload by extending `ResearchDeliveryProgress`. The
lifecycle uses `pending` to recognize results awaiting automatic publication
and `delivered` to skip an ordinary repeat. Include artifact/version references
and domain-specific outcomes in the payload; publication failure must remain
distinct from execution failure.

Implement `ResearchOperationWriter.get` and `mutate` over your store. `mutate`
must apply changes to the latest stored record and persist them, including any
update timestamp. Persist an engine handle before returning from launch so a
rebuilt service can find the same task.

## Implement the engine adapter

Implement `ResearchEngineAdapter<Record, Delivery>` with the following methods.
Methods receiving a writer must persist changes that subsequent lifecycle calls
need, rather than only returning a modified in-memory record.

| Method | Contract |
| --- | --- |
| `prepare(record, signal, writer)` | Stage the frozen inputs or perform engine preparation. Honor the abort signal. Return `proceed: false` after recording a preparation failure or other terminal outcome |
| `beforeLaunch(record, writer)` | Perform the final synchronous checks. Return a refusal with a stable step and safe message if execution must not start |
| `launch(record, writer)` | Launch once and persist the engine handle and state. Return the engine run ID, or `null` for a confirmed non-start with its outcome recorded |
| `inspect(record)` | Read the engine status without persisting it; report whether a run was observed and whether it is terminal |
| `observe(record, writer)` | Read and persist current facts, then return the updated record, terminal flag and mapped lifecycle state |
| `requestStop(record)` | Ask the engine to stop this specific task; return any safe error information. This does not confirm termination |
| `confirmStop(record)` | Wait for a bounded time for authoritative termination evidence; return `false` when it cannot be confirmed |
| `deliver(record, { force })` | Publish existing results into the owning Session and return delivery progress. Never launch or rerun research |

Supply `transitions` for the record edits used by the lifecycle: stopped,
conversation-cancelled, stopping, stop-requested, stop-result, failed, unknown,
and delivery-failed. These edits preserve your record's additional fields.
Keep adapter error messages safe for storage and display; exclude credentials
and private connection details.

For asynchronous engines, `launch` can return while the task is still running.
Leave delivery `pending`. The lifecycle checks the latest persisted state and
does not automatically deliver a running launch. A subsequent terminal
observation can publish the result. The host must arrange those observations;
there is no automatic background polling scheduler.

## Connect the lifecycle to your entry point

Create one lifecycle instance per task-service instance, after constructing
your adapter and operation store. The example below shows the dependencies to
provide; `adapter`, `operations` and `ownerStopped` are your implementations.

```ts
const lifecycle = createResearchOperationLifecycle({
  engine: adapter,
  operations,
  ownerStopped,
  now: () => new Date().toISOString(),
  sleep: (ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  observeMaxWaitMs: 30_000,
  errorMessage: () => "The research engine operation failed",
});
```

Import the constructor from
`services/api/src/research/operation-lifecycle.ts` using the relative module
path for your integration. `ownerStopped(sessionId, ownerRunId)` must read the
owning conversation's cancellation/interruption status. Optional callbacks
`onTerminal`, `onStopRequested` and `onStopConfirmed` let your service update
budget or research-line bookkeeping; they do not enforce budgets themselves.

Wire the entry points as follows:

1. On an authorized start, validate and freeze the request, deduplicate it,
   persist the accepted operation, then dispatch `execute(operationId)` with
   your host's background-task handling. Return the SD operation ID promptly.
2. On a status request, authorize access to the stored operation and call
   `observe(record, { waitMs, signal })`. Waiting is bounded by
   `observeMaxWaitMs`; aborting this wait does not itself cancel engine work.
3. On an explicit stop, call `stop(record)` and return its `requested` and
   `confirmed` values separately.
4. On conversation cancellation, select the operations owned by that
   `ownerRunId` and call `stopConversationRun(records)`.
5. After restart or before allocating more work, use `reconcile(records)` to
   read and settle existing tasks. Do not resubmit them as new launches.
6. For an authorized delivery retry, call `retryDelivery(record)`. Enforce any
   readiness policy at your entry point; the explicit retry path invokes
   publication directly and does not wait for the engine to finish.

## Preserve results and handle failures

`deliver` should bind output bytes to the engine task and frozen input
versions, validate any provided digests, and publish immutable Session artifact
versions. Use stable task/result identities or content-based reuse so repeating
publication does not create duplicate versions. The lifecycle coordinates
in-flight delivery in one process; artifact idempotency is your publisher's
responsibility.

Observation does not restart an engine. If an accepted/running operation has
neither a live local worker nor an observed engine record/status, the lifecycle
can mark it `unknown`. Treat a timeout or missing record as uncertainty, not as
scientific failure or permission to resubmit a paid task. The adapter must
persist current facts and consistently map unknown outcomes.

Cancellation during preparation aborts its signal and is checked again before
launch. Once engine work exists, cancellation depends on `requestStop` and
`confirmStop`; an accepted stop request is insufficient evidence that processes
or remote jobs have ended.

## Integration limits and verification

The lifecycle provides no installation, credential distribution, model
selection, sandbox, remote authentication, user-confirmation UI, or general
budget enforcement. Implement the requirements your product needs at its entry
point and execution boundary. The worker, preparation-abort and delivery locks
are process-local; a deployment with multiple API processes needs additional
coordination in its operation store or scheduler.

Exercise your adapter through its real task-service wiring with a fake engine.
Cover cancellation before and during preparation, launch failures, asynchronous
completion, missing records after restart, unconfirmed stops, repeated status
requests, and delivery failure/retry without another launch. The shared
[`lifecycle tests`](../../../services/api/src/research/operation-lifecycle.test.ts)
provide examples that do not require an engine installation.
