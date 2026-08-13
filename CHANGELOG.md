# Changelog

Notable changes to RepoLens are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project intends to follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- Public-repository documentation for privacy, security reporting,
  contribution, community conduct, issue forms, and pull requests.
- Strict TypeScript source and a deterministic local build that emits the
  unpacked extension to `build/extension`.
- Korean and English UI catalogs, Chrome manifest locales, and independent AI
  output-language selection.

### Changed

- Source checkouts now require `npm ci` and `npm run build`; Chrome loads the
  generated `build/extension` directory. Release ZIPs continue to contain only
  executable JavaScript and required runtime/static files.

## [0.1.0] - 2026-08-13

Initial developer-preview release.

### Added

- Build-free Chrome Manifest V3 side-panel workflow for analyzing the public
  repository currently open on GitHub.
- Explicit fast and deep analysis paths. Fast analysis uses balanced anchor
  files; deep analysis expands anchors through locally resolvable JavaScript and
  TypeScript references plus exact package and TypeScript configuration paths.
- Upgrade path from a saved fast report to a separate deep report while
  preserving the original report and verifying that the repository commit has
  not changed.
- User-configurable deep-analysis limit of 1–32 files, with per-file and total
  source-character budgets.
- User-provided OpenAI-compatible `/chat/completions` connections with streaming
  and non-streaming response support.
- Multiple encrypted AI presets protected by a local PBKDF2/AES-GCM vault.
- Optional no-scope GitHub OAuth Device Flow and fine-grained PAT connection.
- Commit-pinned evidence links, structured report validation, follow-up
  questions, and local analysis history.
- Validated conceptual architecture graphs rendered with a bundled Mermaid
  distribution and an accessible HTML fallback.
- Bounded GitHub metadata, tree, and blob caching, authenticated-memory cache
  isolation, concurrent request coalescing, and cancellation.

### Security

- Repository text is treated as untrusted data and is never executed.
- AI output citations are limited to the exact supplied files and valid line
  ranges at the analyzed commit.
- Provider destinations, GitHub API origins, redirects, extension messages,
  cache records, graph data, and rendered SVG structures are validated.
- API keys and GitHub credentials are redacted from errors and excluded from
  public repository caches.

### Known limitations

- Public repositories and their current default branch only.
- Representative analysis rather than complete dependency traversal, runtime
  verification, or security auditing.
- Deep reference extraction primarily covers relative JavaScript and TypeScript
  imports and exact internal paths in `package.json` and `tsconfig` files.
- Korean user interface and generated reports.
- Manual unpacked-extension installation; no Chrome Web Store distribution.
- No cross-device vault sync, credential recovery, automatic time-based vault
  lock, hosted relay, or custom provider headers.
