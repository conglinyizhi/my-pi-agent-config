# Subagent Live Timeline Design

## Goal

Extend `/gui:subagents` so an operator can follow each worker's execution while the batch is running. The view must show tool activity and streamed assistant output in real time without exposing model reasoning or changing subagent execution semantics.

## Scope

- Capture JSON-mode worker events already emitted by pi.
- Persist a bounded, per-worker execution timeline in the existing `~/.pi/subagent-status.json` state file.
- Render the selected worker's timeline in the existing Wails `SubagentsView`.
- Keep the current worker list, final output, stderr, usage, feedback-mode toggle, and file-JSON window protocol.

Out of scope:

- Displaying hidden reasoning or chain of thought.
- Adding a websocket, HTTP server, database, or a new Wails window.
- Merging concurrent workers into one default global timeline.
- Changing worker tool permissions, scheduling, cancellation, or final result handling.

## Architecture

```text
worker pi --mode json stdout
  -> lib/subagent-run.ts parses JSON lines
  -> normalized TimelineEvent updates in onUpdate
  -> extensions/trident-subagent/batch.ts patches WorkerRun
  -> status.ts atomically writes ~/.pi/subagent-status.json
  -> Wails App.GetSubagentStatus()
  -> SubagentsView polls and virtual-renders the selected worker timeline
```

The worker already emits `message_update`, `message_end`, `tool_execution_start`, `tool_execution_update`, and `tool_execution_end` in JSON mode. The parent process remains the sole telemetry writer, avoiding an extra worker extension and keeping all GUI state ownership in the existing batch runtime.

## Timeline Data Model

Add a `timeline` array to `WorkerRun`. Every event has a generated stable id, ISO timestamp, event type, and display state.

Event categories:

- `assistant`: one active event per streamed assistant reply. Incoming text deltas append to that event; `message_end` marks it final. Only assistant-visible text is retained.
- `tool`: created at `tool_execution_start` with tool name and serialized arguments. Updates append a bounded preview. `tool_execution_end` records final result preview and success/error state.
- `lifecycle`: worker start, terminal success/failed/aborted/timeout events.

The normalizer must tolerate malformed JSON, unknown event shapes, non-text assistant content, and non-serializable tool payloads. Such input must not terminate a worker. UI data is converted to bounded text with a safe serializer.

Retention limits are part of the protocol:

- keep the most recent 500 timeline entries per worker;
- cap each serialized argument, streamed assistant text, update preview, and final result preview at a documented size;
- replace the oldest removed event with one `truncated` lifecycle marker so the operator knows history was dropped.

The existing final `output`, `stderr`, and usage fields retain their current independent caps and semantics.

## Frontend Interaction

The left column remains a worker list. Selecting a worker opens only that worker's timeline; this prevents concurrent workers' event streams from interleaving.

The right column changes from stacked final-output sections to:

1. worker summary: status, model, timestamps, PID, usage;
2. live timeline: newest activity follows automatically only while the user is already at the bottom; scrolling upward freezes auto-follow;
3. collapsible event details: tool arguments, incremental output, final result/error, and complete streamed assistant text;
4. a compact terminal-result section below the timeline for final output and stderr once available.

The timeline uses a fixed row-height viewport and manual range calculation with top and bottom spacers. No frontend virtual-list package is added. Expanded event content is rendered outside the fixed-row virtualization path or in a controlled detail pane so expansion cannot corrupt scroll positioning.

Polling remains file-based and runs at one-second cadence. The frontend preserves selected worker and expanded event ids across refreshes. A failed or partially written status read leaves the last valid display intact.

## Failure Handling

- A malformed worker stdout line is ignored.
- A telemetry normalization error is isolated from process result collection.
- Status file write failures remain non-fatal to batch execution, matching current behavior.
- Wails read/JSON parse failures do not clear the prior view.
- Terminal status is written even when no live events were captured.

## Tests And Verification

Add focused Node tests for JSON event normalization and bounded timeline behavior:

- tool start/update/end produces one coherent tool event;
- assistant deltas merge into a single reply and finalize on `message_end`;
- unknown or malformed input is ignored safely;
- retention applies a truncation marker and keeps newest events;
- result collection remains compatible with current final-output extraction.

Update GUI fast-test fixture data to include timeline events and ensure the subagents window reaches `.ready`. Run:

```bash
node --experimental-strip-types lib/subagent-run.test.ts
pnpm test:gui
```

Rebuild the embedded Wails frontend before GUI verification:

```bash
cd wails-gui
wails build -tags webkit2_41
```

Manual acceptance: launch `/gui:subagents` during a multi-step worker run, select each worker, observe a tool start and completion plus assistant output arrive without reopening the window, scroll upward without forced jumps, and confirm final output/stderr remain available after terminal status.
