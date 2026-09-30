<div align="center">

# Nexo

### Local-first web interface for Codex

**A private localhost workspace for conversations, model controls, approvals, attachments and developer workflows powered by the locally authenticated Codex CLI.**

![Python](https://img.shields.io/badge/Python-20232A?style=for-the-badge&logo=python&logoColor=3776AB)
![JavaScript](https://img.shields.io/badge/JavaScript-20232A?style=for-the-badge&logo=javascript&logoColor=F7DF1E)
![HTML5](https://img.shields.io/badge/HTML5-20232A?style=for-the-badge&logo=html5&logoColor=E34F26)
![Local First](https://img.shields.io/badge/Local--First-20232A?style=for-the-badge&logo=windowsterminal&logoColor=9BE4C5)

</div>

---

## What is Nexo?

Nexo is a local web interface built around the Codex App Server protocol.

Instead of exposing API credentials to the browser, the Python bridge starts the locally installed `codex app-server --stdio` process and communicates with it over JSON messages. Authentication remains owned by the local Codex installation.

The application is intentionally bound to `127.0.0.1`.

## Highlights

- conversation history with pagination;
- title/content search for loaded conversations;
- favorites and local archive;
- thread resume and rename;
- Markdown export;
- progressive assistant responses;
- readable activity / command states;
- approval requests rendered in the UI;
- optional approval automation while the page is open;
- interrupt current execution;
- file attachments with upload progress and previews;
- image forwarding;
- inline forwarding of small text files;
- Work and Conversation modes;
- dynamic model catalog from the installed Codex service;
- dynamic reasoning-effort options;
- local automatic routing heuristic;
- account / usage / rate-limit panel when available;
- light and dark themes;
- desktop and mobile layouts;
- localhost Host / Origin checks;
- per-process unpredictable local request token;
- strict attachment allow/block handling.

## Architecture

```text
Browser UI
   │
   │ HTTP on 127.0.0.1
   ▼
Python local bridge
   │
   ├── Host / Origin validation
   ├── local anti-request token
   ├── attachment validation
   ├── workspace path scoping
   └── JSON-RPC/event bridge
   │
   ▼
codex app-server --stdio
   │
   ▼
Locally authenticated Codex installation
```

Nexo does not copy credentials into browser storage and does not require a second API key when the local Codex installation is already authenticated.

## Conversation vs Work

**Conversation** uses read-only access for prompts that do not need to modify workspace files.

**Work** enables workspace-write behavior inside approved personal folders and keeps the normal approval flow for actions requiring permission.

Nexo does not treat the browser as a security boundary. The Codex sandbox and approval policy remain the authoritative execution controls.

## Local security model

The public implementation includes several local hardening decisions:

- binds only to `127.0.0.1`;
- validates the `Host` header;
- validates `Origin` for state-changing requests;
- requires a random process-local token on API operations;
- limits JSON and upload sizes;
- blocks executable/script attachment extensions;
- scopes writable workspaces to selected personal directories;
- applies a restrictive Content Security Policy;
- does not send CLI credentials to the browser.

The optional **autonomy** switch can approve certain Codex approval requests automatically while the page remains open. It starts disabled and should only be used when the user understands the requested actions.

## Requirements

- Python 3.11+
- Codex CLI installed
- Codex authenticated locally

Verify the CLI first:

```powershell
codex --version
codex login
```

## Run

```powershell
python server.py
```

Then open:

```text
http://127.0.0.1:8765
```

To use a different port:

```powershell
python server.py --port 8766
```

## Portfolio sanitization

This public edition excludes local conversation/history data, logs, authentication material, generated App Server protocol dumps, personal Windows paths, screenshots containing local usernames, local caches and attachments.

See [`PORTFOLIO_EDITION.md`](PORTFOLIO_EDITION.md).

---

<div align="center">

Built by **Eduardo Lima** · [GitHub](https://github.com/EduSchorr)

</div>
