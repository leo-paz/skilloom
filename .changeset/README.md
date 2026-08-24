# Changesets

Every ordinary pull request must include a Changeset describing its user-visible effect. Run:

```sh
npm run changeset
```

Choose `patch`, `minor`, or `major`, then commit the generated Markdown file. The generated `changeset-release/main` pull request consumes pending Changesets and is the only pull request that does not need a new one.
