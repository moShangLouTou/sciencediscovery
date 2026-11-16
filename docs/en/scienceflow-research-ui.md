# Running research from the conversation

This page describes the experimental local research mode from a user's point of
view. It assumes an administrator has enabled the mode for your deployment and
has configured one supported task package. This mode runs on the ScienceDiscovery
host; it is not the formal Runner sandbox.

## Start a run

Ask for the experiment in the normal composer. State the question, the change you
want to test and any existing solution the run should start from, then send the
message as usual. The Agent writes the plan, publishes it as a Session Artifact,
starts one bounded ScienceFlow run and reports what happened. No separate start
wizard or CLI is needed.

## When ScienceFlow is used

With the mode enabled, the Agent follows these rules before task intake, evaluator
preparation, plan publication or a start:

| Request | Behavior |
| --- | --- |
| Explicitly run or continue a computational experiment | Enter the ScienceFlow workflow; naming ScienceFlow is optional. |
| Explicitly name ScienceFlow in a computational task request, regardless of case | Enter the workflow without another run command or redundant confirmation. For example: "Use scienceflow to fit the attached data and minimize RMSE." |
| Ask to analyze, fit, optimize or research without clear execution intent | Ask one concise question about whether to actually run an experiment. |
| Ask an informational question, summarize literature, explain a method, or only discuss/design a plan | Do not start. "What is ScienceFlow?" is informational. |
| Explicitly say not to run or to provide a plan only, even when naming ScienceFlow | Respect the no-run instruction. |
| Query status, inspect results or retry delivery | Handle the existing operation without starting another experiment. |

A name found only in an attachment, quotation or tool result is not a user
execution request. Naming ScienceFlow does not fill in a missing evaluable
objective, metric or required data: the Agent must clarify these before preparing
or starting anything. Once intent and scientific inputs are clear, the normal
task selection/preparation and plan publication workflow proceeds, subject to
existing permission and compatibility checks. One bounded run does not authorize
additional rounds automatically.

These are Agent instruction and tool-description rules, rather than a server-side
keyword switch or enforced intent classifier.

## Watch it

The **ScienceFlow** group in the right-hand Workspace lists this
Session's runs. Expand the Workspace if it is hidden. The group can be collapsed
without interrupting status updates or result delivery. For each run it shows:

- a short title, the run's ordinal, its operation id and engine run id;
- Preparing, Running, Stop requested, Stopped, Completed, Failed or Outcome
  unknown;
- captured stages and the latest evaluated metric, once the engine records one;
- a separate Delivery line: not delivered yet, delivered, delivery failed or no
  candidate.

The card keeps updating while a run is active. Refreshing the page or leaving and
reopening the Session restores the same run; it does not start another one.

## Stop a run

Use **Stop research** on the active run. The card first shows **Stop requested**
and then **Stopped** when the engine confirms termination. You do not need to
cancel the conversation to stop the experiment; cancelling the conversation asks
the engine to stop only the run that conversation started.

## Find and download the result

When delivery completes, the new artifacts appear in the Session's artifact
surfaces without a manual reload. The card links to:

- the selected solution — the engine-selected candidate, as an immutable Artifact
  version;
- the result note — the run's explanation and delivery provenance.

Open either one in the normal artifact viewer, check its version number, and use
the viewer's download action to save the exact bytes. Captured attempts and the
researcher's own logs are listed separately from the selected solution.

## Continue from a result

Select **Continue from this result** on a delivered run. The composer is filled
with an editable request that names the delivered solution's exact Artifact
version. Review or edit it, then send it yourself; nothing starts until you do.
The Agent publishes a revised plan and starts a second run from that version, and
the two runs keep separate identities and outputs.
