# Release runbook

Skilloom uses Changesets for stable versions and npm's `canary` dist-tag for builds from `main`. The first stable version is `0.1.0`; canaries use that calculated version as their base.

## One-time bootstrap

The `skilloom` package name was unregistered when this workflow was added. npm cannot attach a trusted publisher until the package exists, so the first canary needs a short-lived npm write token.

1. Create a short-lived granular npm access token with package write access and **Bypass 2FA** enabled so CI can create the new public package.
2. Add it to the GitHub repository as the Actions secret `NPM_TOKEN`.
3. In GitHub, enable **Settings → Actions → General → Allow GitHub Actions to create and approve pull requests**.
4. Merge the release-automation pull request. Its Changeset makes the workflow create the first canary and open `changeset-release/main`.
5. In the new `skilloom` package settings on npm, configure a GitHub Actions trusted publisher:
   - Organization or user: `leo-paz`
   - Repository: `skilloom`
   - Workflow filename: `release.yml`
   - Allowed action: `npm publish`
6. Delete the `NPM_TOKEN` repository secret. In npm package settings, require two-factor authentication and disallow token publishing.

If the generated release pull request needs CI to run automatically, add a fine-grained repository token as `CHANGESETS_TOKEN`. It needs repository contents and pull-request write access. Without it, Changesets uses the built-in GitHub token.

## Normal development

Create a Changeset before opening or updating a pull request:

```sh
npm run changeset
```

Commit the generated `.changeset/*.md` file with the code. Choose:

- `patch` for fixes and compatible internal changes;
- `minor` for compatible features;
- `major` for breaking command, configuration, or output changes.

After merge, test the exact `main` build:

```sh
npx skilloom@canary --version
npx skilloom@canary --help
```

Merge `changeset-release/main` when its version and changelog are ready for production. Then verify:

```sh
npx skilloom@latest --version
npm view skilloom dist-tags --json
```

## Failure handling

- A failed verification job publishes nothing.
- A failed canary leaves the release pull request intact. Re-run the workflow after fixing authentication or registry availability.
- Stable publishing uses a different version from canary snapshots, so a canary cannot consume the production version.
- Release jobs are serialized through the `npm-release` concurrency group.
