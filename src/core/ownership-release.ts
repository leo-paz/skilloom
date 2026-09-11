import type { OwnershipRelease, OwnershipReleaseDelta } from "./types.js";

/** Release legacy ownership once per checkout; later explicit adoption remains removable. */
export function releaseOwnership(
  releases: OwnershipRelease[],
  current: ReadonlySet<string>,
  checkouts: Array<{ projectId: string; path: string }>,
): { managed: Set<string>; delta: OwnershipReleaseDelta } {
  const managed = new Set(current);
  const delta: OwnershipReleaseDelta = {
    releasedKeys: [],
    acknowledgedKeys: [],
  };
  for (const checkout of checkouts) {
    for (const release of releases) {
      if (release.projectId !== checkout.projectId) continue;
      const acknowledgement = `release:${release.id}:${encodeURIComponent(checkout.path)}`;
      if (managed.has(acknowledgement)) continue;
      const prefix = `project:${encodeURIComponent(checkout.path)}:${release.name}:`;
      for (const key of managed) {
        if (key.startsWith(prefix)) {
          managed.delete(key);
          delta.releasedKeys.push(key);
        }
      }
      managed.add(acknowledgement);
      delta.acknowledgedKeys.push(acknowledgement);
    }
  }
  return { managed, delta };
}

export function applyOwnershipReleaseDelta(
  managed: Set<string>,
  delta?: OwnershipReleaseDelta,
): void {
  if (!delta) return;
  for (const key of delta.releasedKeys) managed.delete(key);
  for (const key of delta.acknowledgedKeys) managed.add(key);
}
