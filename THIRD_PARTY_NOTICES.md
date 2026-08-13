# Third-party notices

## PocketRisu

RepoLens contains narrowly adapted AI transport code from:

- **PocketRisu** — <https://github.com/PocketRisu/PocketRisu>
- Upstream version: `v1.9.0`
- Upstream commit: `85a65f3137b45c8de4a8d21a9887be213b1ac3fc`
- Copyright: Copyright (C) 2024 Kwaroran
- Upstream licensing evidence: the `LICENSE` file at the commit above contains
  the GNU General Public License, Version 3, dated 29 June 2007, with a 2024
  Kwaroran copyright line. This notice records that upstream file without
  attempting to add an “or later” permission or make a broader legal
  classification.

The derived files are:

- `src/lib/sse.js`, adapted from `src/ts/preset/adapter/sse.ts`
- `src/lib/ai-client.js`, adapted in part from
  `src/ts/preset/adapter/openaiCompatible.ts`

The code was changed on 2026-08-13 to remove PocketRisu application state,
provider registries, durable credential and API-key-pool persistence, proxy
fallback, request logging, tool calling, and provider-specific extensions. It
was converted to a small browser-extension JavaScript interface and augmented
with destination validation, redirect rejection, output-size limits, and API
key redaction for structured provider error messages.

RepoLens's encrypted provider vault (`src/lib/provider-vault.js` and
`src/lib/provider-vault-authority.js`) is an independent implementation using
the browser-standard Web Crypto API; it is not derived from PocketRisu. When the
vault is unlocked, the user-open trusted extension side panel performs the
provider request using the active session connection.

PocketRisu's `rpack` directory and its separately licensed code are not used.

## Mermaid

RepoLens includes the upstream Mermaid browser distribution to render the
validated project structure map locally:

- **Mermaid** — <https://github.com/mermaid-js/mermaid>
- Version: `11.16.1`
- Package: <https://www.npmjs.com/package/mermaid/v/11.16.1>
- Distribution source: `dist/mermaid.min.js` in the official package tarball
  <https://registry.npmjs.org/mermaid/-/mermaid-11.16.1.tgz>
- Registry integrity: `sha512-TQsq6u22fAn3rek5VOubrhKPo1g5hwC3FXUN9hiyupTckcYiGuuKGkNQrKYwGJkXUxZdojwRG46gsSCFZMDp4g==`
- Copyright: Copyright (c) 2014-2022 Knut Sveidqvist
- Package metadata license field: `MIT`

Included files:

- `src/vendor/mermaid-11.16.1.min.js` — unmodified upstream distribution
  bundle, 3,566,058 bytes, SHA-256
  `18327BEF70D96FB505FE7287D9F6A7362EBF07FF6576DDFAFFB1A06F3E1A2954`
- `src/vendor/MERMAID_LICENSE.txt` — the MIT license text shipped in the
  Mermaid 11.16.1 package
- `LICENSES/mermaid-11.16.1-bundle-components.md` — component/version inventory
  reconstructed from the official source map and checked against the npm
  package metadata and license files
- `LICENSES/mermaid-11.16.1-bundle-licenses.txt` — license and attribution text
  for components embedded in this exact browser bundle, collected from their
  published npm packages, plus notices carried inside included sources

Mermaid is packaged with the extension and is not fetched from the listed
package or any CDN at runtime. The full license text is available at
[src/vendor/MERMAID_LICENSE.txt](src/vendor/MERMAID_LICENSE.txt).

### Bundle verification and embedded components

The npm registry metadata for `mermaid@11.16.1` reports version `11.16.1`, the
repository `mermaid-js/mermaid`, and the license field `MIT`. The downloaded
tarball's SHA-512 digest is
`4D0B2AEAEDB67C09F7ADE93954EB9BAE128FA358398700B715750DF618B2BA94DC91C6221AEB8A1A4350ACA63018991753165DA23C111B8EA0B1208564C0E9E2`,
which is the hexadecimal form of the registry integrity value above. Its
`package/dist/mermaid.min.js` has the same byte length and SHA-256 as the file
included by RepoLens. The local browser bundle is therefore byte-for-byte the
published `mermaid@11.16.1` distribution file; RepoLens did not rebuild or edit
it.

Mermaid's browser distribution is a compiled bundle, not Mermaid source alone.
The official `dist/mermaid.min.js.map` identifies the embedded package source
versions. Most carry MIT, ISC, or BSD-3-Clause terms. Notable additional notices
include DOMPurify 3.4.0's `(MPL-2.0 OR Apache-2.0)` package declaration;
ColorBrewer material in `d3-scale-chromatic`; Markdown material in `marked`;
KaTeX SVG-derived font material under the SIL Open Font License 1.1 and a small
React-derived utility notice; and JamaJS-derived SVD code carried by
`layout-base` with an Apache License 2.0 block.

The minified file itself retains an esbuild “Bundled license information” block
for DOMPurify 3.4.0, js-yaml 4.1.1, lodash-es 4.18.1, and MIT-licensed helper
code included by Cytoscape. The separate inventory and collected license file
preserve a broader, readable record of the components visible in the official
source map. They are supplied as attribution and provenance information, not as
legal advice or a representation that automated component discovery is
infallible. Future Mermaid upgrades require regenerating and reviewing both
files against the new published artifact.

RepoLens uses only `mermaid.render()` for a small application-generated
flowchart subset. Tree-shaking was not performed locally, so the distribution
still contains code for components and diagram types that RepoLens does not
invoke.
