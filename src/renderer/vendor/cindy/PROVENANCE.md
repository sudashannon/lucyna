# Cindy component reuse

Source: https://github.com/makecindy/cindy/tree/2c1ae8d81f803f56c1cc4a36af77ed5d0dcce511/apps/desktop/src/renderer

Revision: 2c1ae8d81f803f56c1cc4a36af77ed5d0dcce511. License: Apache-2.0; LICENSE and NOTICE retained beside these files.

Copied: components/ui/button.tsx, components/ui/button.css, components/ui/spinner.tsx, components/ui/tooltip.tsx, components/ui/segmented-control.tsx, components/ui/segmented-control.css, components/ui/input.tsx, components/sidebar/SidebarIconButton.tsx, components/sidebar/AttentionDot.tsx, components/layout/RightSidebarToggle.tsx, lib/utils.ts, styles/generated/token-mappings.ts, styles/generated/tokens.css; semantic colors extracted from themes/colors.ts.

Local changes: alias imports use @cindy; AttentionKind is an equivalent local type instead of importing the Cindy session store; segmented indicator dimensions change instantly while its position animates with transform; button face press uses transform instead of inset animation; unused font-weight variable declarations are omitted (the source values remain the same in Tailwind). The shell/composer/session integration is new OMP code, inspired by Cindy layout, and does not copy its agent harness. Readability overrides and graphite CTA ink live separately in the app tokens.css.

Run node tools/vendor-cindy.cjs only after explicitly updating and reviewing the upstream checkout.
