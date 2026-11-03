# Stele backend snapshot for Lucyna

`UPSTREAM.json` identifies the selected backend revision and the original bytes of each captured source file. The effective snapshot includes the existing local knowledge-adoption extensions. User knowledge, configurations, credentials, journals, caches, and the original web UI are excluded. The embedded web page is a minimal Lucyna ownership notice.

Lucyna-specific changes add a private authenticated listener, bounded Node/WASM embedding transport, a native stdio MCP client, and a managed-write callback for captured/adopted Markdown. Explicitly imported document trees are indexed without the engineering repository heuristics that normally omit nested READMEs and hidden documentation directories. Destructive native routes that have not joined the library revision transaction are refused by the managed host.

The catalog and document revision writer run in Lucyna's background host, using the SQLite support already shipped with Electron. Stele retains its graph, retrieval, evidence and native business stores. Build with `tools/build-knowledge-engine.py`; the generated binary and runtime integrity manifest belong to `resources/knowledge-engine/` and are included in desktop release resources. They are ignored as local build artifacts in source checkouts.

The `ternlight-base` package is separately retained beside this snapshot with its original MIT license. The engine's selected source provenance and Lucyna modifications are recorded here; application licensing does not replace upstream component licensing.
