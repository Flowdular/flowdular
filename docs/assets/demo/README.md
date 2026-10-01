# README product demo

The root README uses actual screenshots of the running Flowdular platform,
captured on 2026-10-01. The hero illustration was generated separately; its
[prompt and provenance](../flowdular-readme-hero-prompt.md) are recorded beside it.

## What the demo shows

| Asset                           | Contents                                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------------------ |
| `flowdular-workspace.webp`      | Dashboard in Operations Demo after one agent run, with two demo members.                   |
| `flowdular-workspace-full.webp` | Full dashboard, including activity and module charts.                                      |
| `flowdular-agents.webp`         | Agent playground with synthetic input and a completed local simulation.                    |
| `flowdular-workflows.webp`      | Unpublished Weekly operations review draft: input, pinned agent revision and output.       |
| `flowdular-product-tour.gif`    | Nine screenshot frames, held for 2 to 3.5 seconds, in a 24.5-second loop.                  |
| `flowdular-product-tour.mp4`    | The same screenshot walkthrough at the original 1280 × 720 resolution, encoded with H.264. |

The walkthrough visits the dashboard and charts, agent definitions and editor,
playground result, persisted run history, workflow canvas, step palette and node
inspector. It is a sequence of captured interface states.

The Operations brief agent has no tool grants and uses `local-simulation` with
`deterministic-v1`. Its completed run records five execution events. The provider
echoes the supplied example rather than generating a real business analysis.
No external model or network service was called for that run.

The workflow is an editor demonstration. It was not published or run. Its design
check reported `WORKFLOW_SCHEMA_MISSING`: the agent's failure port refers to
`workflow.error`, which the newly created draft does not include. This runtime
issue is outside the README change; these assets make no claim of a successful
workflow execution.

## Capture environment

The platform ran on `http://127.0.0.1:4311`, with a fresh disposable PGlite
database and local object store under the git-ignored `.flowdular/readme-demo/`.
The existing application and databases were left in place. Vault keys were
generated in memory and passed to the seed command and development process.
Neither keys nor session cookies are included in the media.

Use the [getting-started guide](../../getting-started.md) to prepare a separate
local demo. Never reset an existing workspace to refresh README screenshots.
Create an agent called Operations brief using the local simulation provider and
no tools. Run it with this synthetic input:

```text
Demo update: reviewed 12 purchase requests, prepared the weekly delivery plan,
and flagged 2 missing supplier confirmations for human review.
Next step: confirm the delivery dates with the team.
```

Create an unpublished workflow draft with Input, Agent and Output steps. Pin the
agent revision, connect the data and success ports, and use Fit to view. Show the
actual draft status when capturing it.

Capture after loading indicators finish. Use the browser's normal 1280 × 720
viewport for the tour and full-page capture for the expanded dashboard. Save
source JPEG frames under a git-ignored capture directory. Convert stills to WebP
at quality 90 with Pillow; retain the original dimensions. The banner uses
quality 90 and is 2000 × 672.

## Animation encoding

The GIF uses 1000 × 562 frames, a 192-color palette, variable frame durations
and an infinite loop. GIF is used for the inline animation; it is included in
GitHub's [documented media formats](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files).
The MP4 has no audio. Static assets use WebP, matching the repository's existing
README artwork format.

To regenerate the MP4 from source captures, write an FFmpeg concat manifest
with this order and timing, then repeat the last file entry without a duration:

| Frame                    | Duration (seconds) |
| ------------------------ | -----------------: |
| `workspace-viewport.jpg` |                2.5 |
| `workspace-charts.jpg`   |                  2 |
| `agents.jpg`             |                2.5 |
| `agent-inspector.jpg`    |                  3 |
| `playground.jpg`         |                3.5 |
| `runs.jpg`               |                2.5 |
| `workflow.jpg`           |                3.5 |
| `workflow-palette.jpg`   |                  2 |
| `workflow-inspector.jpg` |                  3 |

Each manifest entry consists of `file '/absolute/path/to/frame.jpg'` followed
by `duration 2.5` or the corresponding duration above. Then run:

```bash
ffmpeg -f concat -safe 0 -i tour.txt -vf fps=20 -t 24.5 \
  -c:v libx264 -crf 24 -preset medium -pix_fmt yuv420p \
  -movflags +faststart flowdular-product-tour.mp4
```

The existing SVG demos in this directory are separate explanatory illustrations.
The current root README uses the raster captures listed above.
