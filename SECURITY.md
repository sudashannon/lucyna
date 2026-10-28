# Security and local data

Lucyna runs native OMP with the privileges of your Windows or WSL account. It is a desktop client, not a sandbox. OMP tools can execute commands and modify files according to your native agent configuration.

- Credentials stay in the native OMP profile. Do not put tokens in `runtime.local.json`, screenshots or bug reports.
- Machine configuration, session journals, personal work documents, generated builds and local acceptance logs are excluded from Git.
- Renderer windows use context isolation and restricted preload interfaces. File preview is limited to the selected work root; Markdown does not enable arbitrary raw HTML execution. Web previews are a separate surface.
- The Work/Stele stdio bridge has explicit read/write tool allowlists and reads write credentials inside WSL. It does not grant approval for arbitrary repository operations.
- The desktop companion has separate, restricted IPC and exposes status/navigation rather than an agent execution interface. Quiet/privacy controls are available in settings.

Before posting an issue, redact absolute personal paths, conversation contents, provider URLs and credentials. For a suspected vulnerability, use GitHub's private vulnerability reporting if it is enabled for this repository; otherwise contact the maintainer privately before sharing exploit details. No external security audit is claimed.
