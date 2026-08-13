# Contributing to RepoLens

Thanks for helping make unfamiliar open-source repositories easier to
understand. RepoLens welcomes focused bug fixes, tests, documentation,
accessibility improvements, provider-compatibility improvements, and changes
that strengthen its privacy and security boundaries.

## Before starting

Search the repository's existing issues before opening a new one. Use the issue
forms for reproducible bugs and feature proposals. For a larger behavior or
architecture change, open a feature request first so scope and security
implications can be discussed before implementation.

Never put API keys, GitHub tokens, vault data, private repository contents,
personal data, or undisclosed vulnerabilities in a public issue or pull request.
Follow [SECURITY.md](SECURITY.md) for sensitive reports.

## Development setup

RepoLens is a TypeScript Chrome Manifest V3 extension. Node.js 22 or newer is
required for its local build and checks.

1. Clone or fork the repository.
2. Install the pinned development dependencies with `npm ci`.
3. Compile the extension with `npm run build`.
4. Open `chrome://extensions` in Chrome and enable **Developer mode**.
5. Choose **Load unpacked** and select `build/extension`.
6. After editing extension files, rebuild, reload RepoLens, and
   reopen the side panel.

The primary development commands are:

```powershell
npm run build
npm test
npm run check
```

`npm run check` performs strict type checking, runs the Node tests, builds the
extension, and validates the generated manifest surface. Run it before
submitting a pull request. Test behavior in Chrome when a change affects the
service worker, permissions, OAuth flow, storage, streaming, Mermaid rendering,
or side-panel interaction.

## Project principles

Contributions should preserve these product and trust boundaries unless a
maintainer-approved proposal explicitly changes them:

- Browsing and discovery never invoke the AI provider automatically.
- Analysis starts only after an explicit user action.
- Only public repositories and the resolved default-branch commit are read.
- Repository text is untrusted data and is never executed.
- AI and GitHub credentials are never exposed to GitHub page contexts.
- Provider requests go directly from the trusted extension side panel; there is
  no silent proxy fallback or automatic retry that can duplicate paid requests.
- Citations refer only to supplied files and line ranges at the pinned commit.
- AI graph output is inert, bounded data; Mermaid source is generated and
  validated by RepoLens.
- The encrypted vault protects connection presets at rest, while reports and
  public repository caches have the limitations documented in
  [PRIVACY.md](PRIVACY.md).
- Deep analysis is representative local-reference expansion, not a complete
  dependency graph, runtime proof, or security audit.

Changes involving origins, permissions, redirects, credentials, vault formats,
cache persistence, IndexedDB migration, GitHub authorization revisions, AI
prompt boundaries, citations, or SVG rendering require negative tests for the
relevant trust boundary.

## Coding and review guidelines

- Keep modules cohesive and keep privileged GitHub and credential operations in
  their existing trusted contexts.
- Prefer browser and platform APIs over adding runtime dependencies.
- Keep the TypeScript build small, deterministic, locally reproducible, and free
  of runtime CDN dependencies.
- Treat network responses, repository contents, AI output, cached records, and
  extension messages as untrusted input. Validate bounded schemas and fail
  closed at security boundaries.
- Keep all network destinations explicit. Never log or include credentials in
  errors, fixtures, screenshots, or test output.
- Add or update tests for observable behavior and failure paths. Avoid tests
  that depend on real credentials, paid AI calls, or mutable third-party data.
- Maintain keyboard navigation, visible focus, live-region status messages,
  reduced-motion behavior, high-contrast behavior, and text fallbacks for
  visual output.
- Update the README, privacy policy, security policy, third-party notices, or
  changelog when a change affects users or project provenance.

## Pull requests

Keep each pull request focused. In its description, explain the user problem,
the chosen approach, risks, and how the change was verified. Include screenshots
or a short recording for visible UI changes, with secrets and personal data
removed.

Pull requests should:

- pass `npm run check`;
- include tests appropriate to the risk;
- avoid unrelated formatting or generated-file churn;
- document new permissions, network destinations, persistent data, or data
  disclosures;
- preserve license headers and attribution; and
- link the relevant issue when one exists.

Use of AI tools does not change contributor responsibility. Review and
understand every submitted line, verify licenses and provenance, disclose
material generated or adapted content when relevant, and ensure no confidential
data entered the contribution workflow.

## Licensing and provenance

RepoLens is licensed under `GPL-3.0-only`. By submitting a contribution, you
agree that it may be distributed under that license and confirm that you have
the right to contribute it.

Do not copy code, assets, prompts, or documentation with incompatible or unknown
terms. When adapting third-party material, preserve required notices and update
`THIRD_PARTY_NOTICES.md` with the upstream project, version or commit, license,
affected files, and a concise description of modifications.

## Community conduct

Participation is governed by [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
