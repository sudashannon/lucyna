# Contributing

Lucyna is an early Windows + WSL desktop client for native OMP. Issues and pull requests are welcome. Keep OMP responsible for model execution, tools, skills, queueing and sessions; the client owns presentation and process routing.

1. Follow [Getting started](docs/getting-started.md) and use your own ignored `runtime.local.json`.
2. Run `npm test`, `npm run typecheck`, `npm run build` and `npm run test:renderer`.
3. For UI changes, check both themes, a narrow window, scrolling, keyboard navigation and preserved drafts. Run `npm run screenshots` when updating the public gallery.
4. Use synthetic fixtures for screenshots and tests. Never commit native session journals, work documents, access tokens, personal paths or machine logs.
5. Describe the trigger, resulting behavior and verification in your PR. Preserve existing sessions and unrelated configurations.

Default tests do not invoke a paid model, connect to a real Stele instance or change real work roots. Live OMP testing is a separate, explicit step; do not claim fixture results as model integration evidence.

See [Development](docs/development.md) for the source layout and test commands. Contributions must retain upstream attribution in `src/renderer/vendor/cindy`.
