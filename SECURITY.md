# Security policy

RepoLens is a local Chrome Manifest V3 extension that reads public GitHub
repositories and sends a bounded selection of public source text to an AI
provider chosen by the user. It does not execute repository code and it does
not operate a hosted relay.

## Supported versions

RepoLens is currently a developer preview. Security fixes are provided for the
latest release on the default branch. Older releases may be asked to upgrade
before a report can be investigated.

| Version | Supported |
| --- | --- |
| 0.1.x | Yes |
| Earlier versions | No |

## Report a vulnerability privately

Do not open a public issue for a suspected vulnerability, exploit, API key,
GitHub token, vault envelope, or other sensitive material.

Use the repository's **Security** tab and choose **Report a vulnerability** to
start a private GitHub security advisory. Direct repository-relative links are
intentionally omitted because this checkout is not yet associated with a public
GitHub owner and repository name.

Include, when available:

- the affected RepoLens version and Chrome version;
- a concise description of the impact and affected trust boundary;
- reproducible steps or a minimal proof of concept using non-secret test data;
- whether the issue exposed an AI credential, GitHub credential, source excerpt,
  report, or browser-extension capability; and
- any suggested remediation or temporary mitigation.

Remove real credentials and unnecessary personal data. If a real credential
was exposed, revoke or rotate it before sending the report. Acknowledgement and
fix timing depend on severity, reproducibility, and maintainer availability;
the project does not currently promise a response SLA or bug bounty.

If GitHub private vulnerability reporting is unavailable, do not disclose the
details publicly. Open a minimal issue through the repository's **Issues** tab
that says private reporting is unavailable, without including vulnerability
details, and wait for a maintainer-provided private channel.

## Security boundaries

The following behavior is intentional and should be considered when assessing
impact:

- RepoLens accepts only public repositories and their current default branch.
  It pins evidence and links to the resolved commit SHA.
- Repository contents are untrusted data. RepoLens does not execute them, and
  the analysis prompt instructs the model not to follow repository-provided
  instructions.
- Only selected source excerpts and analysis prompts are sent to the active AI
  provider after an explicit user action. The provider is outside RepoLens's
  trust boundary and applies its own retention, training, billing, and privacy
  policies.
- AI and GitHub credentials are encrypted at rest in the local preset vault.
  They are necessarily available to trusted extension contexts while the vault
  is unlocked. The master password cannot be recovered.
- Public repository snapshots, decoded source excerpts, generated reports,
  diagrams, citations, and follow-up questions stored in IndexedDB are not
  encrypted by the preset vault.
- RepoLens does not defend against a compromised browser profile, malicious
  extensions with sufficient access, malware, DevTools access, observation
  while the vault is unlocked, or offline password guessing against a stolen
  vault envelope.
- Mermaid is bundled locally. The AI returns bounded graph data rather than
  executable Mermaid source, and RepoLens validates generated graph and SVG
  structures before display.

Issues that cross these boundaries unexpectedly are in scope, including token
exposure, authorization confusion, unsafe redirects, origin-validation bypass,
vault cryptography or migration failures, cache isolation failures, prompt-data
boundary bypasses, unsafe citation links, and executable diagram injection.

## Generally out of scope

The following are normally not security vulnerabilities by themselves:

- inaccurate, incomplete, or low-quality AI output that does not bypass a
  security boundary;
- costs, rate limits, retention, or outages imposed by GitHub or the selected AI
  provider;
- analysis incompleteness caused by the representative-file and character
  limits documented in the README;
- access to data already public in the analyzed GitHub repository;
- attacks that require an already compromised browser or operating system and
  do not introduce an additional RepoLens-specific impact; and
- denial-of-service reports without a concrete security consequence.

Non-sensitive defects can be filed through the repository's public issue forms.

## Coordinated disclosure

Please allow maintainers a reasonable opportunity to validate and address a
report before publishing details. Avoid accessing accounts or data you do not
own, degrading third-party services, or retaining exposed data. Maintainers will
credit reporters when requested and practical, unless disclosure would create
additional risk.
