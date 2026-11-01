---
version: 1
slug: "src-renderer-components-workspacefiles-tsx"
primary_target: "src/renderer/components/WorkspaceFiles.tsx"
related_targets: ["src/renderer/App.tsx","src/renderer/workspace-files.css","src/renderer/components/FileBrowser.tsx","src/renderer/components/WorkDetails.tsx"]
---

Mode: Operate. Scope: P0–P5 of docs/git-workspace-design.md, extended by the user on 2026-11-01. Preserve the confirmed Work tabs and browsing/Git review, then add validated local and capability-gated SSH Git operations, result reconciliation and bounded registered-member lifecycle management.

## Direction contract

THESIS: One Work has two persistent working surfaces, 对话工作 and 工作区文件. Reading files and reviewing Git use the main working width, rather than an additional global Git destination or a cramped conversation tool panel.

OWN-WORLD: Inherit Blue, Classic, Folio and Pixel with their independent light/dark appearances, existing font stacks, Cindy controls and Lucide icons. Existing character assets remain unchanged. Git additions/deletions have semantic colors and explicit status text.

STORY: Select a Work; browse its files; select a registered repository; review unstaged/staged/baseline changes, commit history, branches and worktrees; bring a bounded excerpt into the existing conversation draft. Reading never starts OMP or changes Git.

FIRST VIEWPORT: Work header, two content tabs, then five file views. The content holds a file/change list beside a spacious reader/diff; narrow layouts expose the list progressively. Commit, sync and lifecycle controls use progressive disclosure with explicit targets and operation results. Host identity, missing capabilities and uncertain results remain explicit. Existing conversation, draft, terminal and tools stay mounted.

FORM: User-pinned extension of the existing workbench, code-led. No concept roll is needed for the confirmed topology. docs/design/git-workspace/browse.png and changes.png are design-study critique references, not raster assets to ship or pixel-comp build gates. The accepted design document owns interaction details and phase boundaries.

QUALITY BAR: .impeccable/surfaces/git-workspace-quality-bar.md. The no-roll exception is the local-extension / precisely-specified-request rule in reference/new-work.md section 3; no unperformed roll is assigned a seed.

SIGNATURE INTERACTION: Bring a bounded file/diff excerpt into the existing Work conversation draft without sending or starting OMP, retaining the file's reading position for the return trip.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
