# Work summary reader

Mode: Read inside the Work inspector.

Target: `src/renderer/components/WorkSummaryReader.tsx`, `src/renderer/components/WorkAssistant.tsx`, and `src/renderer/work-assistant.css`.

Users scan a Work's current state across several conversations. Preserve source text, ordering, evidence navigation, summary error states, and draft-only continuation. Use the established Source Han Sans roles and all four themes in both appearances.

Keep the overview visible, followed by five count-bearing tabs. Start with next steps when available; otherwise use the first populated section. Show four entries initially with an explicit control for the remainder. Separate entries with quiet rules and spacing, not individual cards or invented priorities. Long entries show three lines with an explicit expand control; the overview allows four lines. Preserve the full text for reading and drafts.

Each entry offers a direct original-message link with role and time. Put the full session title in the accessible name and hover title. Additional sources open inline as links, with no excerpt expansion and no inaccessible source-count truncation. Keep keyboard tab selection, focus indicators, line wrapping, and narrow inspector layouts usable.

Validate using the production renderer and isolated `test/work-assistant-desktop.cjs` fixture. Synthetic records are for layout and interaction checks only. Do not restart the live client or send draft content to a model.
