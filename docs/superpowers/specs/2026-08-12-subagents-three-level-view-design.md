# Subagents Three-Level View Design

## Goal

Replace the current split-pane, inline-expanded subagent event view with a
same-window navigation stack that gives the full main area to an agent's event
stream and then to one event's complete content.

## Scope

### Included

- Keep one Wails window named `subagents` and its existing status-file polling
  protocol.
- Provide three in-window levels:
  1. agent list
  2. selected agent event stream
  3. selected event detail
- Show assistant responses, tool calls, and lifecycle records together in the
  second-level stream, preserving the incoming timeline order.
- Show exactly one event in the third-level detail view.
- Provide a bottom-fixed previous/next event bar in the third-level view.
- Preserve the selected agent and the second-level stream scroll position when
  returning from event detail.
- Extend the GUI fixture data so its subagent request includes every event
  shape and long-enough content to exercise the detail layout.
- Build the Vue frontend during development, then embed it into Wails only once
  after the UI change is complete.

### Excluded

- New Wails windows, routes, request-file fields, or Go RPC methods.
- Changes to worker status generation, timeline event schemas, feedback-mode
  semantics, or dispatch lifecycle control.
- Background task controls, message search, filtering, copying, or transcript
  persistence.

## Current State

`wails-gui/frontend/src/views/SubagentsView.vue` currently keeps an agent
sidebar visible while showing the selected agent's task, timeline, terminal
output, and stderr in the remaining pane. Selecting timeline rows adds detail
cards below the virtualized list. Those cards compete for vertical space with
the list and only offer a constrained reading area.

The initial data and live updates already contain all required fields:

- worker: `id`, `task`, `model`, `status`, `startedAt`, `finishedAt`, `pid`,
  `usage`, `output`, `stderr`, and `timeline`
- assistant event: `id`, `type`, `ts`, `text`, `final`
- tool event: `id`, `type`, `ts`, `tool`, `args`, `preview`, `result`, `ok`
- lifecycle event: `id`, `type`, `ts`, `state`, `message`

Therefore the change is local to the Vue view, plus fixture coverage and an
optional physical window-size adjustment in `wails-gui/main.go`.

## Information Architecture

### Level 1: Agent List

The initial screen is a full-window batch view. Each worker row shows its task
summary, worker ID, current status, and status icon. The existing feedback-mode
control remains in this level's header. Selecting a row enters that worker's
event stream instead of splitting the window into a persistent sidebar and a
small detail pane.

When no workers are present, retain the existing empty-batch message.

### Level 2: Agent Event Stream

The selected worker receives the entire content region. The header contains a
back icon button, a compact breadcrumb (`Agent list / <worker id>`), task
summary, status, model, PID where available, timestamps, and usage.

The stream retains fixed-row virtual scrolling and bottom-follow behavior for
live updates. Every timeline event appears in original array order:

- assistant responses show an assistant icon and a whitespace-normalized text
  preview
- tool events show tool name and running/success/failure state
- lifecycle records show their normalized lifecycle label and message

Each row includes type/status color, timestamp, and a concise one-line
preview. It is an interactive row (`data-name="timeline-row"`) that enters
the event detail view. No content expands below the list.

The worker terminal output and stderr remain accessible as two terminal-style
events after the timeline list when either field is non-empty. They receive
stable synthetic event IDs that cannot collide with timeline IDs. This keeps
all worker conversation artifacts on the second-level chronological reading
surface without losing the existing output/stderr visibility.

Returning from level 3 restores this view and its recorded `scrollTop`; it
does not force bottom-follow or reset the selected worker.

### Level 3: Event Detail

The header contains an icon-only return button with a tooltip, plus a breadcrumb
(`Agent list / <worker id> / <event label>`). The main content area scrolls
independently and renders one selected event at a time:

- a tool event renders its name, timestamp, status, parameters, incremental
  output, and final result when each is present
- an assistant event renders its timestamp, final/streaming state, and full
  response text
- a lifecycle event renders its timestamp, state, and message
- a terminal output/stderr synthetic event renders its complete stored text

Long text uses pre-wrapped formatting and scrolls within the content area. It
is never hidden by a fixed navigation bar.

Below that area, a fixed-height bottom navigation bar remains in the same
screen position while detail content scrolls. It has `data-name` anchors for
the previous-event button, event-position text, and next-event button. Previous
and next move by the selected event's index in the current worker's complete
event list. The first previous and final next buttons are disabled. Switching
events resets the detail content scroll position to the top.

## State And Navigation

The component owns a `viewLevel` ref with values `agents`, `timeline`, and
`event`, plus these state values:

- `selectedId`: selected worker ID
- `selectedEventId`: selected event ID, or `null`
- `timelineScrollTopByWorker`: per-worker stream scroll offsets
- `detailViewport`: ref used to reset detail scroll on previous/next

Transitions are explicit:

| Action | State transition |
| --- | --- |
| Select worker | set `selectedId`, clear `selectedEventId`, enter `timeline`, scroll to the live bottom only for the new worker |
| Select event | capture selected worker stream offset, set `selectedEventId`, enter `event` |
| Previous/next | select adjacent event; retain level and reset detail scroll to top |
| Back from event | clear `selectedEventId`, enter `timeline`, restore stored stream offset |
| Back from timeline | enter `agents`; retain `selectedId` for a visually stable re-entry |
| Live status refresh | keep the current level and selection if IDs still exist; only auto-follow at level 2 when the reader was already at its bottom |

If an event or worker disappears in a refreshed snapshot, clear only the
invalid selection and return to the nearest valid parent level. Invalid data is
handled as the current view's empty state rather than throwing.

## Visual And Interaction Rules

- Keep the existing dark operational palette and restrained status colors.
- Use compact rows, clear hierarchy, and one primary reading surface; do not
  introduce nested cards or decorative panels.
- Give level 3 sufficient empty margin around the text and reserve its bottom
  bar height in the scrolling content with padding.
- Use familiar left/right chevron icons in navigation buttons; every icon-only
  button has a native `title` tooltip and a semantic `data-name`.
- Do not use emoji as the new primary navigation affordance.
- Existing feedback toggle keeps its `data-name`; add stable names for agent
  list, agent item, back buttons, event list, event row, event detail, and the
  three bottom-navigation elements.

## Files

| File | Change |
| --- | --- |
| `wails-gui/frontend/src/views/SubagentsView.vue` | Replace split-pane/inline-event-detail template and associated state/styles with the three-level page stack; retain polling and virtual-scroll logic where applicable |
| `wails-gui/main.go` | Increase only the `subagents` initial window dimensions if the full-width agent list or reading surface needs it |
| `scripts/gui-fasttest.ts` | Add representative assistant, tool, lifecycle, output, and stderr fixture data to the `subagents` request |

`wails-gui/app.go` and `wails-gui/frontend/src/main.js` do not change because
the window name and request protocol remain unchanged.

## Verification Strategy

1. Add a focused frontend test harness or extract pure navigation helpers if
   needed to prove boundary navigation, stale-refresh fallback, and return
   scroll-state behavior. The test must fail before the behavior is added.
2. Run the narrow frontend test after each behavior change.
3. Run `pnpm --dir wails-gui/frontend build` during implementation. This checks
   Vue compilation without embedding assets in the Wails executable.
4. After all frontend work is accepted, run one final:

   ```bash
   cd wails-gui && wails build -tags webkit2_41
   ```

5. Run `pnpm test:gui` against the fresh embedded executable. It verifies the
   real subagents window mounts with the extended fixture request and that the
   remaining GUI windows still mount.

The fast test checks rendering readiness, not click-level navigation. Manual
inspection should cover agent selection, all event kinds, scroll restoration,
previous/next disabling at both boundaries, and live refresh while viewing
levels 2 and 3.

## Acceptance Criteria

- The subagents window opens at an agent-list level.
- Selecting one agent opens a full-width, chronological stream containing
  assistant, tool, lifecycle, output, and stderr records that exist for it.
- Selecting a stream row opens a full-width detail page for exactly that one
  event.
- The previous/next controls stay fixed in the detail page bottom bar, navigate
  adjacent records correctly, and disable at the timeline boundaries.
- Returning from event detail restores the selected agent's stream position.
- Live polling does not unexpectedly force a reader out of levels 2 or 3.
- The frontend build passes before the final Wails build, and the final embedded
  binary passes `pnpm test:gui`.
