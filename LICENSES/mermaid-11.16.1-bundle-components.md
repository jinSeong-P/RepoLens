# Mermaid 11.16.1 browser-bundle component inventory

This inventory applies to `src/vendor/mermaid-11.16.1.min.js` in RepoLens. It
records provenance and licensing evidence; it is not legal advice.

## Artifact identity

- npm package: `mermaid@11.16.1`
- Registry tarball:
  <https://registry.npmjs.org/mermaid/-/mermaid-11.16.1.tgz>
- Registry integrity:
  `sha512-TQsq6u22fAn3rek5VOubrhKPo1g5hwC3FXUN9hiyupTckcYiGuuKGkNQrKYwGJkXUxZdojwRG46gsSCFZMDp4g==`
- Tarball SHA-512:
  `4D0B2AEAEDB67C09F7ADE93954EB9BAE128FA358398700B715750DF618B2BA94DC91C6221AEB8A1A4350ACA63018991753165DA23C111B8EA0B1208564C0E9E2`
- Published and included file: `package/dist/mermaid.min.js`
- Included size: `3,566,058` bytes
- Included SHA-256:
  `18327BEF70D96FB505FE7287D9F6A7362EBF07FF6576DDFAFFB1A06F3E1A2954`
- Mermaid package metadata: repository `mermaid-js/mermaid`, license `MIT`
- Mermaid package license copy: `src/vendor/MERMAID_LICENSE.txt`

The published file and RepoLens file have identical byte length and SHA-256.
The component versions below were reconstructed from pnpm paths in the official
`dist/mermaid.min.js.map` shipped in the same tarball. Direct npm dependencies
listed in `mermaid@11.16.1` metadata are not automatically equivalent to code
present in this particular bundle; the source map is used for the latter.

## Components represented in the source map

| Package | Version(s) present | Published/package evidence |
| --- | --- | --- |
| `@braintree/sanitize-url` | `7.1.2` | MIT |
| `@iconify/utils` | `3.0.2` | MIT |
| `@mermaid-js/parser` | `1.2.0` | MIT |
| `@upsetjs/venn.js` | `2.0.0` | MIT |
| `cose-base` | `1.0.3`, `2.2.0` | MIT |
| `cytoscape` | `3.33.3` | MIT; retained bundle notices also identify several MIT helpers |
| `cytoscape-cose-bilkent` | `4.1.0` | MIT |
| `cytoscape-fcose` | `2.2.0` | MIT |
| `d3` | `7.9.0` | ISC |
| `d3-array` | `2.12.1`, `3.2.4` | BSD-3-Clause for 2.12.1; ISC for 3.2.4 |
| `d3-axis` | `3.0.0` | ISC |
| `d3-brush` | `3.0.0` | ISC |
| `d3-chord` | `3.0.1` | ISC |
| `d3-color` | `3.1.0` | ISC |
| `d3-contour` | `4.0.2` | ISC |
| `d3-delaunay` | `6.0.4` | ISC |
| `d3-dispatch` | `3.0.1` | ISC |
| `d3-drag` | `3.0.0` | ISC |
| `d3-dsv` | `3.0.1` | ISC |
| `d3-ease` | `3.0.1` | BSD-3-Clause |
| `d3-fetch` | `3.0.1` | ISC |
| `d3-force` | `3.0.0` | ISC |
| `d3-format` | `3.1.0` | ISC |
| `d3-geo` | `3.1.1` | ISC; package license also carries a GeographicLib MIT notice |
| `d3-hierarchy` | `3.1.2` | ISC |
| `d3-interpolate` | `3.0.1` | ISC |
| `d3-path` | `1.0.9`, `3.1.0` | BSD-3-Clause for 1.0.9; ISC for 3.1.0 |
| `d3-polygon` | `3.0.1` | ISC |
| `d3-quadtree` | `3.0.1` | ISC |
| `d3-random` | `3.0.1` | ISC |
| `d3-sankey` | `0.12.3` | BSD-3-Clause |
| `d3-scale` | `4.0.2` | ISC |
| `d3-scale-chromatic` | `3.1.0` | ISC; package license also carries a ColorBrewer Apache-2.0 notice |
| `d3-selection` | `3.0.0` | ISC |
| `d3-shape` | `1.3.7`, `3.2.0` | BSD-3-Clause for 1.3.7; ISC for 3.2.0 |
| `d3-time` | `3.1.0` | ISC |
| `d3-time-format` | `4.1.0` | ISC |
| `d3-timer` | `3.0.1` | ISC |
| `d3-transition` | `3.0.1` | ISC |
| `d3-zoom` | `3.0.0` | ISC |
| `dagre-d3-es` | `7.0.14` | MIT |
| `dayjs` | `1.11.20` | MIT |
| `dompurify` | `3.4.0` | Package metadata and license: `(MPL-2.0 OR Apache-2.0)`; the minified bundle retains the dual-license notice |
| `es-toolkit` | `1.45.1` | MIT |
| `internmap` | `2.0.3` | ISC |
| `js-yaml` | `4.1.1` | MIT; the minified bundle retains its notice |
| `katex` | `0.16.45` | MIT; included source carries React/Apache-2.0 and SVG-derived OFL-1.1 notices |
| `khroma` | `2.1.0` | MIT in the package `license` file; npm metadata omits a `license` value |
| `layout-base` | `1.0.2`, `2.0.1` | MIT; included 2.0.1 SVD source carries the Apache-2.0 text for JamaJS-derived code |
| `lodash-es` | `4.18.1` | MIT; the minified bundle retains its notice and Underscore attribution |
| `marked` | `16.3.0` | MIT; package license also carries the Markdown BSD-style notice |
| `roughjs` | `4.6.6` | MIT |
| `stylis` | `4.3.6` | MIT |
| `ts-dedent` | `2.2.0` | MIT |
| `uuid` | `14.0.0` | MIT |

Package license texts and embedded subcomponent notices are collected in
`LICENSES/mermaid-11.16.1-bundle-licenses.txt`. The package-level Mermaid MIT
license remains in `src/vendor/MERMAID_LICENSE.txt`.

## Retained minified-bundle notice block

The published `mermaid.min.js` itself contains an esbuild “Bundled license
information” block naming:

- DOMPurify 3.4.0 — Apache-2.0 or MPL-2.0;
- js-yaml 4.1.1 — MIT;
- lodash-es 4.18.1 plus Underscore attribution — MIT; and
- Cytoscape-included thenable, jQuery-event-derived, Bezier, and Runge-Kutta
  helper notices — MIT.

That block was not stripped or changed. The source-map inventory above is
broader because license comments need not survive minification to identify code
represented by the published source map.

## Audit method and limits

Audit performed 2026-08-13:

1. Download the registry tarball and compare its SRI/SHA-512 to npm metadata.
2. Compare `dist/mermaid.min.js` byte length and SHA-256 to the RepoLens file.
3. Read `mermaid@11.16.1/package.json` and package `LICENSE`.
4. Enumerate exact pnpm package/version paths from the official source map.
5. Retrieve the matching npm package metadata and top-level license files.
6. Inspect the minified bundle and source-map contents for retained or nested
   license/attribution blocks.

This is a best-effort artifact inventory, not a legal conclusion. Source maps,
metadata, and package license files can contain errors or omit code provenance.
RepoLens did not independently determine copyright ownership. Upgrading or
replacing the bundle requires a new audit.
