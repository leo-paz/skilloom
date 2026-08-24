# npm release automation research

Date: 2026-08-24

## Findings

- Changesets Action v2 supports Changesets v3 and can create a release pull request or run a publish script. It exposes whether a publish happened and whether unreleased Changesets exist. Source: [Changesets Action](https://github.com/changesets/action).
- Changesets snapshot releases use an ephemeral version plus a non-`latest` npm tag. Snapshot changes should not be committed back to the release branch. Source: [Changesets snapshot releases](https://changesets.dev/guide/snapshot-releases).
- npm trusted publishing requires npm CLI 11.5.1 or newer, Node 22.14 or newer, a GitHub-hosted runner, and `id-token: write`. The npm package settings must name the repository and exact workflow filename. Source: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
- npm requires either interactive 2FA or a granular access token with bypass-2FA enabled when creating a package. Legacy tokens were removed in November 2025. Source: [npm CI/CD authentication](https://docs.npmjs.com/using-private-packages-in-a-ci-cd-workflow/).
- Trusted publishing automatically generates provenance. Token-based bootstrap publishing can generate provenance with `--provenance` or `publishConfig.provenance`. Source: [npm provenance statements](https://docs.npmjs.com/generating-provenance-statements/).
- The local Outlit SDK publishes snapshots only when stable publishing did not happen. This prevents a canary from consuming a stable version before the release job can publish it.
- `npm view skilloom` returned `E404` on 2026-08-24. The unscoped package name was not registered at the time of research.

## Decision

Use one `release.yml` workflow for verification, release pull requests, stable publishing, and canary publishing. Every ordinary pull request carries a Changeset. Merges to `main` with pending Changesets publish a canary and update the release pull request. Merging the release pull request publishes `latest`, creates the Git tag and GitHub release, and skips canary publishing.

Use an npm token only to bootstrap the first canary, which creates the package. Then configure `release.yml` as the package's trusted publisher and remove the write token.
