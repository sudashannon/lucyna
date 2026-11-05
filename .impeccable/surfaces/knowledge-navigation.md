# Knowledge directory navigation

Mode: Operate.

Targets: `src/renderer/components/KnowledgeWorkspace.tsx`, `src/renderer/context-sidebar.css`, and the Knowledge-specific overrides in `src/renderer/studio-themes.css`.

Users move between reading, exploration, maintenance, and follow-up while retaining their document, draft, and source context. Preserve all six entry points and Lucyna's four visual themes.

Use a single column with child pages immediately below the active parent. Only the current page gets a filled selection background; parent weight and a chevron communicate the open group. Keep pointer hover visibly quieter than selection. Separate the labelled source scope from page navigation. Sources requires one selected source, while applicable search and maintenance views can include all sources.

Keep source capture and refresh in a compact action row. Short windows scroll the navigation; the document library keeps its own list and reading state. Collapsed and narrow layouts retain six accessible icon destinations and the existing inline page navigation. The directory header must not expose a Work search control while the user is in Knowledge.

Render with `test/knowledge-sidebar-desktop.cjs` after building the renderer. The fixture uses isolated data and covers navigation, source scope, retained state, themes, and window sizes.
