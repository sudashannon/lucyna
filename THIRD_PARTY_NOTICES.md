# Third-party notices

## Cindy

Selected UI components were adapted from [makecindy/cindy](https://github.com/makecindy/cindy), copyright 2026 XD Inc., under Apache License 2.0.

The original [LICENSE](src/renderer/vendor/cindy/LICENSE), [NOTICE](src/renderer/vendor/cindy/NOTICE), and exact source revision and modification record in [PROVENANCE.md](src/renderer/vendor/cindy/PROVENANCE.md) are retained. Lucyna is an independent project and is not an official Cindy distribution.

## OMP and rendering libraries

[oh-my-pi](https://github.com/can1357/oh-my-pi) is an external runtime installed by the user; Lucyna invokes its native RPC protocol. Its agent runtime is not vendored here.

Electron, React, Radix UI, Tailwind CSS, Lucide, Streamdown, KaTeX, Mermaid, xterm.js and other npm dependencies retain their respective licenses. Versions are pinned in `package-lock.json`; consult each package's license when redistributing a bundled application.

## Cytoscape.js

Knowledge graph rendering uses [Cytoscape.js](https://github.com/cytoscape/cytoscape.js), copyright The Cytoscape Consortium, under the MIT license. Its license is retained in the installed package and must accompany distributions. Lucyna supplies its own interface, styling, data adapter and graph interactions.


## Artwork

The silver-haired companion, black cat, application icons and sprite artwork were generated for this project and refined into application assets. Source art and preparation metadata are in `design/`. They are not official artwork from Cindy or Cyberpunk: Edgerunners and do not imply affiliation or endorsement. Screenshots in `docs/screenshots/` are actual Lucyna renderer captures with synthetic demonstration data.
