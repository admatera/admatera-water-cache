# AdMatera MAPS C7 GitHub Refresh Candidate

Last modified: 2026-09-08 00:15 CDT (UTC-05:00)

This additive folder stages the exact GitHub Actions orchestration and private-R2 upload layer for MAP-DATA-012A. It does not modify `admatera/admatera-water-cache`, Cloudflare, Hostinger, or production.

Repository overlay at promotion time:

- `.github/workflows/c7-usgs-water.yml` from this candidate as an additive workflow. The repository's existing `.github/workflows/usgs-water.yml` and public cache files remain byte-untouched until C7 release and retirement are separately approved.
- `package.json` and the generated `package-lock.json` from this candidate.
- `data/state-paths.json` from this candidate as the governed 52-identity state/FIPS inventory; the refresh publishes the locked states-plus-DC profile of 51 and excludes PR.
- `scripts/upload-c7-r2.mjs` from this candidate.
- `scripts/fetch-usgs-ogc.mjs` and `scripts/lib/usgs-ogc-v0.mjs` from the canonical C7 atom.

The public repository remains the scheduler and compute surface. Private Cloudflare R2 remains the evidence and promotion store. The browser never calls USGS and receives no credential.

The initial promoted workflow is deliberately **manual-only** (`workflow_dispatch`). The approved future cadence is `17 */6 * * *`, but that schedule must not enter the repository until one manual refresh passes private-R2 object, health, pointer, and Worker-readback inspection.

Required GitHub Actions secrets:

- `USGS_API_KEY`
- `C7_R2_ACCESS_KEY_ID`
- `C7_R2_SECRET_ACCESS_KEY`

Required non-secret GitHub Actions variables:

- `C7_R2_ACCOUNT_ID`
- `C7_R2_BUCKET`, fixed to `admatera-maps-c7-private-preview-v1` for the staging gate

No secret value belongs in this folder, a Git commit, a workflow artifact, or chat.

## Pinned build dependency

- Package: `@aws-sdk/client-s3` version `3.1127.0`, locked by `package-lock.json`.
- Purpose: upload validated objects through Cloudflare R2's S3-compatible endpoint.
- Data leaving GitHub: only C7 refresh evidence, summary, audit, health, checksums, and the final current pointer.
- Credential boundary: R2 Object Read & Write restricted to the single staging bucket.
- Browser/runtime boundary: absent from the public C7 package and never executed by a visitor.
- Failure behavior: immutable uploads may fail, but the promoted pointer is written last and therefore retains the previous validated snapshot.
- Removal path: replace `scripts/upload-c7-r2.mjs` with another governed uploader; no data or presentation schema depends on the SDK.
