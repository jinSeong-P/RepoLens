# Privacy policy

RepoLens is a local, build-free Chrome extension for explaining public GitHub
repositories with an AI provider selected by the user. RepoLens has no project-
operated backend, advertising, analytics, or telemetry in the current MVP.

This document describes the application's data flows. The policies of GitHub,
Chrome, and the selected AI provider also apply independently.

## Data RepoLens accesses

When opened on a public GitHub repository, RepoLens may access:

- the repository owner and name, description, language, star count, license,
  default branch, current commit and Git tree;
- a bounded selection of public text files and their Git object metadata;
- the user's GitHub login when an optional GitHub connection is verified;
- AI connection settings entered by the user, including preset name, base URL,
  model ID, streaming preference, and API key; and
- locally generated reports, citations, diagrams, follow-up questions, answers,
  timestamps, and analysis settings.

RepoLens intentionally supports public repositories and the current default
branch only. It does not request access to private repository contents.

## When data leaves the browser

### GitHub

RepoLens sends repository metadata, branch, tree, blob, and optional account-
verification requests to fixed GitHub origins. Anonymous access is available.
The optional GitHub OAuth Device Flow requests no scopes; a fine-grained
personal access token can be used as an advanced alternative. The OAuth Client
ID is public and no client secret is embedded in the extension.

GitHub receives the network information ordinarily associated with API and web
requests. GitHub's own privacy terms govern that processing.

### The user's AI provider

Discovery, Explore, Trending, and search browsing do not trigger an AI request.
After the user explicitly starts an analysis, RepoLens sends the selected public
source excerpts, public repository metadata, analysis scope, and prompt to the
active OpenAI-compatible endpoint. A follow-up question sends the question,
stored report context, and selected source excerpts to that same provider.

A connection test sends a small generated prompt and no GitHub source code, but
it may still consume provider quota. The AI provider receives the API key in an
Authorization header and applies its own retention, training, billing, logging,
and privacy policies. RepoLens does not proxy these requests through a project-
operated server.

## Local storage and encryption

RepoLens stores data in the current Chrome profile.

The encrypted preset vault contains AI preset names, endpoint URLs, model IDs,
API keys, streaming settings, GitHub OAuth or PAT credentials, and provider
identity migration data. The vault uses PBKDF2-HMAC-SHA-256 with a random salt
and at least 600,000 iterations, followed by AES-256-GCM with a fresh random IV
for each write. The master password is not stored or transmitted by RepoLens and
cannot be recovered.

While unlocked, derived key material and the active connection are held in
memory and `chrome.storage.session`, restricted to trusted extension contexts.
Locking the vault clears those session records; Chrome also clears them when the
extension session ends. The MVP does not provide time-based automatic locking.

The following local data is **not encrypted by the preset vault**:

- public vault envelope metadata such as salt, IV, KDF parameters, vault IDs,
  ciphertext length, and version fields;
- Chrome's record of provider-origin permissions granted by the user;
- public repository snapshots, selected and decoded source excerpts, analysis
  reports, diagrams, citations, questions, answers, and timestamps in IndexedDB;
  and
- bounded caches of anonymously fetched public GitHub metadata, trees, branch
  heads, and blobs.

Authenticated GitHub responses are cached only in memory for a short period and
are isolated by credential-session revision. Credentials and response headers
are not stored in the public GitHub cache.

## Retention and deletion

Analysis records remain in the Chrome profile until the user deletes an item,
clears all history, resets the preset vault, clears the extension's site data,
or removes the extension. Cached public GitHub responses expire or are evicted
under bounded cache policies. Session-only credentials and authenticated cache
entries disappear when the extension session ends or the relevant connection is
cleared.

Users can:

- delete an individual analysis from **Analysis history**;
- delete all reports and questions from **Connection and analysis settings**;
- disconnect GitHub and remove the stored GitHub credential;
- lock or reset the encrypted preset vault; and
- remove the extension or clear its storage through Chrome.

Resetting the vault removes the encrypted presets, stored AI and GitHub
credentials, and analysis history because opaque provider references can no
longer be associated with a replacement vault. Revoking a GitHub OAuth grant or
provider key at the service itself may require using that service's account
settings separately.

## Chrome permissions

RepoLens requests `activeTab`, `sidePanel`, and `storage`, plus access to
`github.com` and `api.github.com`. Access to an external HTTPS AI-provider origin
or a loopback HTTP origin is optional and requested only after a user action.
RepoLens does not inject a content script into GitHub pages and does not expose
an externally connectable extension API.

## Sharing and sale

RepoLens does not sell personal data. The project does not receive the locally
stored information described above. Data is disclosed only through the user-
initiated requests to GitHub and the chosen AI provider, or as required by the
browser and operating environment.

## Children and sensitive data

RepoLens is a developer tool and is not directed to children. Do not enter
personal, confidential, regulated, or private-repository data into prompts or
provider settings. API keys and tokens should be limited in scope and rotated if
exposure is suspected.

## Changes and questions

Material privacy changes will be documented in the repository and release
notes. Non-sensitive questions can be opened through the repository's public
issue forms. Do not post credentials or sensitive security details in an issue;
use the private process in [SECURITY.md](SECURITY.md) instead.
