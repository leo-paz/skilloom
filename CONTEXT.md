# Skilloom domain language

## Machine

A named computer on which Skilloom can observe and reconcile Agent Skills. A machine has one global profile. Its local paths are not shared configuration.

## Workspace root

A local directory that Skilloom is allowed to scan for Git repositories. A workspace root belongs to one machine and has a bounded scan depth.

## Project

A Git repository identified by its normalized remote when available. A project may have checkouts on several machines. A repository without a remote is a local-only project.

## Checkout

A local copy or worktree of a project on one machine. Several checkouts can refer to the same project.

## Profile

A named desired set of globally installed skills. Machines assigned to the same profile share that desired state.

## Project policy

The desired project-scoped skills for a project. Shared policy is committed in `.skilloom.yaml`. Personal policy stays in the user's Skilloom configuration.

## Observation

A timestamped inventory of skills and projects that Skilloom found on one machine. An observation describes installed state and never changes it.

## Managed skill

An installed skill that Skilloom is allowed to remove when it is no longer desired. Existing installations remain unmanaged until onboarding or an explicit adoption records ownership.

## Adoption

Adding an existing installation with a known source and agent target to desired policy, then recording it as managed without reinstalling it.

## Drift

The difference between desired policy and the latest local observation. Remote observations may be stale or absent.
