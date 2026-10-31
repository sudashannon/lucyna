---
name: "Lucyna"
description: "The Blue workbench for local OMP work, with the original Classic scheme retained."
colors:
  blue-nav: "#112341"
  blue-nav-hover: "#20395e"
  blue-nav-ink: "#edf3ff"
  blue-nav-muted: "#bed0eb"
  blue-directory: "#edf3fd"
  blue-directory-hover: "#e2ecfc"
  blue-selected: "#dce8fc"
  blue-user: "#e7effd"
  blue-reading: "#ffffff"
  blue-canvas: "#f6f8fd"
  blue-panel: "#f4f7fd"
  blue-choice-selected: "#eef3fd"
  blue-text: "#17263f"
  blue-text-emphasis: "#10213d"
  blue-text-strong: "#344967"
  blue-secondary: "#536581"
  blue-placeholder: "#627593"
  blue-border: "#cedaee"
  blue-border-soft: "#dce5f4"
  blue-input-border: "#7b8faf"
  blue-action: "#2463df"
  blue-action-emphasis: "#245fce"
  blue-action-hover: "#194eb8"
  blue-focus: "#295fcf"
  blue-dark-nav: "#0b192f"
  blue-dark-nav-hover: "#1c3353"
  blue-dark-directory: "#172940"
  blue-dark-selected: "#2a436c"
  blue-dark-user: "#233d62"
  blue-dark-reading: "#13223a"
  blue-dark-canvas: "#101e33"
  blue-dark-panel: "#13243d"
  blue-dark-surface: "#182a44"
  blue-dark-choice-selected: "#203451"
  blue-dark-text: "#e5edfa"
  blue-dark-text-emphasis: "#f1f5ff"
  blue-dark-text-strong: "#cbd9ee"
  blue-dark-secondary: "#aebed6"
  blue-dark-placeholder: "#a1b4d1"
  blue-dark-border: "#3a5275"
  blue-dark-border-soft: "#2c4261"
  blue-dark-input-border: "#7f95b6"
  blue-dark-action: "#8cb5ff"
  blue-dark-action-ink: "#10213d"
  blue-dark-action-emphasis: "#a5c5ff"
  blue-dark-action-hover: "#a6c6ff"
  blue-dark-focus: "#8cb5ff"
  classic-paper: "#f8f8f6"
  classic-raised: "#ffffff"
  classic-sidebar: "#f0f0ee"
  classic-selected: "#e3e3df"
  classic-ink: "#262626"
  classic-secondary: "#60605c"
  classic-border: "#d7d7d4"
  classic-divider: "#e6e6e2"
  classic-action: "#262626"
  classic-dark-paper: "#1f1f1e"
  classic-dark-raised: "#2c2c2a"
  classic-dark-chip: "#3c3c3a"
  classic-dark-ink: "#d4d4d4"
  classic-dark-secondary: "#a3a3a3"
  classic-dark-action: "#ffffff"
typography:
  display:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "28px"
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: "-0.02em"
  brand:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.025em"
  current-work-title:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "21px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  knowledge-title:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 650
    lineHeight: 1.05
  headline:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.5
    letterSpacing: "-0.02em"
  directory-title:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 650
    lineHeight: 1.5
    letterSpacing: "-0.01em"
  app-navigation:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.5
  body:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.85
  compact-body:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 550
    lineHeight: 1.55
  label:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.7
  rail-label:
    fontFamily: "Source Han Sans SC, Microsoft YaHei, system-ui, sans-serif"
    fontSize: "10px"
    fontWeight: 400
rounded:
  card: "4px"
  control: "8px"
  navigation-item: "9px"
  work-row: "10px"
  choice-card: "12px"
  message: "12px"
  composer: "13px"
  dialog: "16px"
  pill: "999px"
  cindy-pill: "9999px"
spacing:
  space-3xs: "2px"
  space-2xs: "4px"
  space-xs: "8px"
  space-sm: "12px"
  space-md: "16px"
  space-lg: "24px"
  space-xl: "40px"
  space-2xl: "64px"
  space-3xl: "96px"
  space-4xl: "144px"
  ui-72: "72px"
components:
  button-primary:
    backgroundColor: "{colors.blue-action}"
    textColor: "{colors.blue-reading}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "38px"
  button-primary-dark:
    backgroundColor: "{colors.blue-dark-action}"
    textColor: "{colors.blue-dark-action-ink}"
    rounded: "{rounded.control}"
    padding: "8px 12px"
    height: "38px"
  navigation-selected:
    backgroundColor: "{colors.blue-action}"
    textColor: "{colors.blue-reading}"
    typography: "{typography.app-navigation}"
    rounded: "{rounded.navigation-item}"
    padding: "10px 13px"
    height: "46px"
  work-row-selected:
    backgroundColor: "{colors.blue-selected}"
    textColor: "{colors.blue-action-emphasis}"
    typography: "{typography.compact-body}"
    rounded: "{rounded.work-row}"
    padding: "12px"
    height: "48px"
  work-row-selected-dark:
    backgroundColor: "{colors.blue-dark-selected}"
    textColor: "{colors.blue-dark-action-emphasis}"
    typography: "{typography.compact-body}"
    rounded: "{rounded.work-row}"
    padding: "12px"
    height: "48px"
  settings-select:
    backgroundColor: "{colors.blue-canvas}"
    textColor: "{colors.blue-text}"
    typography: "{typography.label}"
    rounded: "{rounded.control}"
    padding: "6px 10px"
    height: "36px"
  composer:
    backgroundColor: "{colors.blue-reading}"
    textColor: "{colors.blue-text}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "16px 18px 8px"
    height: "72px"
  composer-dark:
    backgroundColor: "{colors.blue-dark-surface}"
    textColor: "{colors.blue-dark-text}"
    typography: "{typography.body}"
    rounded: "{rounded.composer}"
    padding: "16px 18px 8px"
    height: "72px"
  theme-choice-selected:
    backgroundColor: "{colors.blue-choice-selected}"
    textColor: "{colors.blue-text}"
    rounded: "{rounded.choice-card}"
    padding: "14px"
  theme-choice-selected-dark:
    backgroundColor: "{colors.blue-dark-choice-selected}"
    textColor: "{colors.blue-dark-text}"
    rounded: "{rounded.choice-card}"
    padding: "14px"
  inspector-tab-selected:
    backgroundColor: "{colors.blue-reading}"
    textColor: "{colors.blue-action-emphasis}"
    rounded: "{rounded.control}"
    padding: "6px 8px"
---

# Design System: Lucyna

## Overview

**Creative North Star: "The Blue Local Workbench"**

Lucyna's Blue scheme makes the local work loop legible as four adjacent regions: application navigation, the Work directory, conversation, and contextual tools. Deep navy anchors navigation, pale blue separates the directory, and bright reading planes keep the conversation and knowledge content easy to scan. Existing Cindy controls carry familiar input and button behavior; the silver-haired character and black cat remain the established brand artwork.

This specification records the renderer as built. The appearance selector currently offers two distinct visual schemes, Blue and Classic. Each scheme has its own Light and Dark appearance. Classic retains the incumbent neutral Cindy palette and compact horizontal navigation; Blue is the new four-region scheme. Light and Dark are appearance variants, not extra visual schemes, and other requested schemes remain deferred.

**Key Characteristics:**
- Four clear work areas with the conversation as the primary reading plane.
- Navy application navigation, a cool-blue Work directory, cobalt active states, and bright reading surfaces in Blue.
- The original neutral Classic scheme remains available and keeps its compact layout.
- Existing silver-haired character and black cat artwork stays intact.

## Colors

The Blue scheme assigns separate color roles to navigation, the directory, reading surfaces, user messages, selection, and action. Frontmatter keys are the source of truth for both Blue appearances and the retained Classic palette.

### Primary

- **Studio Cobalt** ({colors.blue-action}): Primary actions and the selected application destination.
- **Cobalt Emphasis** ({colors.blue-action-emphasis}): Selected Work text, active context tabs, and links.
- **Hover Cobalt** ({colors.blue-action-hover}): Hover treatment for the primary action.

### Secondary

- **Work Selection** ({colors.blue-selected}): The selected Work row in the Blue directory.
- **User Message Blue** ({colors.blue-user}): The user's message surface, distinct from the reading plane.
- **Navigation Blue** ({colors.blue-nav}): Persistent application navigation; it stays visually separate from the directory.

### Neutral

- **Reading White** ({colors.blue-reading}): Conversation, knowledge article, and focused contextual reading surfaces.
- **Blue Mist** ({colors.blue-canvas}): General Blue canvas around reading surfaces.
- **Inspector Mist** ({colors.blue-panel}): Contextual panel background.
- **Primary Ink** ({colors.blue-text}): Main Blue text.
- **Readable Secondary Ink** ({colors.blue-secondary}): Supporting labels, dates, source details, and secondary navigation.
- **Classic Warm Paper** ({colors.classic-paper}) and **Classic Graphite** ({colors.classic-ink}): The original Classic light palette.
- **Classic Night** ({colors.classic-dark-paper}) and **Classic Light Ink** ({colors.classic-dark-ink}): The retained Classic dark appearance.

**The Four-Surface Rule.** Keep navigation, the Work directory, reading, and contextual tools visually distinct. Reserve saturated cobalt for actions and selection; do not turn the reading plane into another navigation surface.

**The Two-Scheme Rule.** The shipped selector exposes Blue and Classic as the two visual schemes. Light and Dark are independent appearance variants. Do not describe them as four distinct visual schemes or invent unseen palette variants.

## Typography

**Display Font:** Source Han Sans SC, with Microsoft YaHei, system-ui, and sans-serif fallbacks.
**Body Font:** The same Source Han Sans SC stack.
**Label/Mono Font:** The interface uses the body stack for labels and Cascadia Mono, Consolas, Source Han Sans SC, ui-monospace, monospace for code.

**Character:** Chinese reading text stays open and steady, while compact labels and contextual headings keep the desktop tool easy to scan. Blue overrides the shared type scale by surface.

### Hierarchy

- **Display** ({typography.display}): Workbench welcome heading.
- **Brand** ({typography.brand}): Lucyna wordmark in the full Blue navigation.
- **Current Work** ({typography.current-work-title}): Current Work heading above the conversation.
- **Knowledge title** ({typography.knowledge-title}): Knowledge page title.
- **Headline** ({typography.headline}): Assistant Markdown section heading.
- **Directory title** ({typography.directory-title}): Work directory and settings section headings.
- **Application navigation** ({typography.app-navigation}): Main destination tabs.
- **Body** ({typography.body}): Blue conversation messages.
- **Compact body** ({typography.compact-body}): Work directory rows and compact body copy.
- **Label** ({typography.label}): Settings and contextual labels.
- **Rail label** ({typography.rail-label}): Icon-rail labels at intermediate widths.

The shared root scale remains available for Cindy-default surfaces: display 1.728rem, section 1.2rem, title 1rem, and lead 1rem. The renderer body uses its compact app text token; Blue's workbench hierarchy above uses the direct sizes recorded in frontmatter. Code uses the separate monospace stack.

## Layout

Blue uses a resizable Work directory next to a dedicated application-navigation column. The default directory width is 248px and the user-resizable range is 200–420px. Application navigation is 184px when the viewport is wider than 1100px, 72px from 761–1100px, and a 64px rail at 760px or narrower. At 1100px and below, the character artwork is hidden to protect navigation space; at short window heights it is reduced.

The conversation keeps a 640px minimum when the inspector sits beside it. The inspector defaults to 370px and can be resized from 320–520px. At 1280px and below the inspector becomes a right-side overlay drawer, sized to the lesser of its configured width or the viewport width minus 64px. At 760px and below, the Work directory contracts away, the 64px navigation rail remains, and conversation content stays in view. At 470px and below, message text and section headings step down for the narrow reading column.

The knowledge destination keeps a directory/list plus a reading pane. Settings use a 680px maximum modal width; the visual-style cards become a single column at 470px, and runtime choices stack at 600px. On Classic, the original single-sidebar compact layout and horizontal navigation remain. The Blue-specific palette and shell rules are scoped under the blue visual-theme root selector; shared theme controls remain usable in either scheme.

## Elevation & Depth

Blue relies on tonal layering and fine borders for ordinary separation. The composer has a quiet ambient shadow and a slightly stronger focus shadow; modal elevation uses a deeper cool shadow behind a translucent scrim. The Classic scheme keeps its incumbent neutral shadow tokens. Exact shadow declarations, easing, and durations live in the sidecar so they are not duplicated here.

## Shapes

Blue uses softly rounded controls, work rows, message bubbles, and the settings dialog. The frontmatter radius keys are the shared size vocabulary; the actual components retain their role-specific silhouettes. Most separation uses 1px strokes or a filled selection surface rather than a raised card. The composer has a wider, more substantial shape than a compact form field. Focus outlines sit outside controls unless a dense navigation control deliberately insets its ring.

## Components

### Buttons

Primary actions use the cobalt fill and readable foreground. The New Chat action has a compact control height; the active application destination is taller and uses a wider hit area. Hover changes the action color. Cindy's pressed button face scales to 96% while its hitbox and label remain stationary; disabled controls use muted surfaces and readable secondary text.

### Work directory rows

Directory rows are quiet at rest and fill with the selected surface when current. The selected text and folder icon take the action-emphasis color; labels truncate rather than push into adjacent controls. Keep the selected Work visually connected to the current Work heading and inspector.

### Inputs and composer

Single-line fields use an outlined edge, a raised surface, and the shared visible focus ring. The conversation composer has a transparent textarea inside a bordered surface; its textarea starts at 72px, can grow to 200px, and uses 16px 18px 8px internal padding in Blue. The send control is a cobalt square with softly rounded corners. The surrounding focus-within treatment makes the entire composer easy to locate.

### Navigation

Blue application navigation is a vertical tablist with labels on the wide rail and icon-plus-label controls as the rail contracts. Tabs expose aria-selected state and support Arrow keys, Home, and End. Selected tabs fill with cobalt; hover uses the darker navigation surface. When custom window chrome is active, the native caption follows the selected scheme: Blue uses the same navigation surface and ink as the app rail, while Classic keeps its neutral palette. Active menubar items use the Blue navigation hover surface and ink. Classic retains the horizontal compact navigation. At 960px the tools remain an accessible overlay drawer; closing returns keyboard focus to the invoking control.

### Appearance settings

The appearance section presents Blue and Classic as labeled radio-card choices, then a separate Light/Dark selector. Settings keep the scheme choice in a draft until Save; Cancel keeps the active scheme. The header selector applies the scheme immediately. The visual choice is stored under lucyna.visual-theme; Light/Dark is stored separately under omp.theme. Changing schemes keeps the mounted conversation, composer, draft, and active session.

### Knowledge reading

The knowledge surface keeps a document list and a source reader. Use selected-row color to locate the current document, and keep article content on the reading plane. Do not turn source metadata into decorative dashboard cards.

## Do's and Don'ts

### Do:

- **Do** keep the Blue navigation, Work directory, conversation, and inspector recognizable as separate regions.
- **Do** use the frontmatter palette and type roles as the normative Blue and Classic values.
- **Do** keep Light/Dark independent from the Blue/Classic visual-scheme choice.
- **Do** preserve the existing silver-haired character and black cat artwork.
- **Do** keep actual Work, session, and knowledge states legible as application content.

### Don't:

- **Don't** claim that four distinct visual schemes are implemented; only Blue and Classic are present.
- **Don't** collapse Classic into Blue's four-region shell.
- **Don't** turn the conversation or knowledge reader into another saturated navigation surface.
- **Don't** invent runtime statuses, document counts, or illustration assets.
