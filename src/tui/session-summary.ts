import { harnessLabel, type LibraryEntry, librarySessions } from "./catalog.js";

const agents = ["codex", "claude", "pi"] as const;
export function sessionUsageSummary(entry: LibraryEntry) {
  const sessions = librarySessions(entry);
  const notes = new Map<string, Set<string>>();
  const note = (message: string, context: string) => {
    const contexts = notes.get(message) ?? new Set<string>();
    contexts.add(context);
    notes.set(message, contexts);
  };
  const rows = entry.usageMachines.map((machine) => {
    const records = entry.occurrences.filter(
      (r) => r.machine.id === machine.id,
    );
    const collected = records.some((r) => r.usageSessions !== undefined);
    const cells = agents.map((agent) => {
      const found = sessions.filter(
        (s) => s.machineId === machine.id && s.harness === agent,
      );
      const known = found.filter((s) => s.pathMatched).length;
      const named = found.filter((s) => !s.pathMatched).length;
      const context = `${machine.name} · ${harnessLabel(agent)}`;
      const missing = records.some((record) => {
        const total = (record.usedBy ?? [])
          .filter((u) => u.harness === agent)
          .reduce((sum, u) => sum + u.count, 0);
        const attributed = (record.usageSessions ?? [])
          .filter((s) => s.harness === agent && s.pathId)
          .reduce((sum, s) => sum + s.eventCount, 0);
        return total > attributed;
      });
      const nameEvidence = records.some((record) =>
        record.nameEvidence?.some((u) => u.harness === agent),
      );
      if (collected && missing)
        note(
          "Matching activity has no verified session identity and is excluded from the count.",
          context,
        );
      if (named)
        note(
          `${named} additional ${named === 1 ? "session invoked" : "sessions invoked"} this skill by name; the installation is unknown.`,
          context,
        );
      else if (collected && nameEvidence && !found.length)
        note(
          "Name-only activity has no verified session identity or installation.",
          context,
        );
      if (!collected && records.length)
        note(
          "Session data has not been collected. Refresh this machine.",
          machine.name,
        );
      return {
        agent,
        count: known,
        label: !records.length
          ? machine.status === "unscanned"
            ? "Not checked"
            : "No install"
          : !collected
            ? "Not checked"
            : known
              ? `${known} ${known === 1 ? "session" : "sessions"}`
              : missing || (nameEvidence && !named)
                ? "Unknown"
                : named
                  ? `${named} by name`
                  : "0 recorded",
      };
    });
    if (machine.status === "unscanned")
      note(
        "Session history has not been collected. Refresh this machine.",
        machine.name,
      );
    if (machine.backfill && !machine.backfill.complete)
      note(
        machine.backfill.paused
          ? "The two-minute limit paused older history. Refresh this machine to continue."
          : "Older history is still being checked.",
        machine.name,
      );
    for (const harness of machine.harnesses ?? []) {
      const context = `${machine.name} · ${harnessLabel(harness.harness)}`;
      for (const reason of new Set(harness.limitations)) {
        const explanation: Record<string, string> = {
          history_window:
            "Earlier history is incomplete, so counts may miss some sessions.",
          partial_record: "An unfinished log entry could not be checked yet.",
          pending_results: "Some tool calls have no recorded result yet.",
          unreadable: "Some session logs could not be read.",
          missing_or_unreadable:
            "Some session logs were missing or unreadable.",
          journal_window:
            "Older retained evidence was omitted from this summary.",
          cache_write_failed:
            "Progress could not be saved. Refresh this machine to retry.",
        };
        if (reason === "backfill_pending") continue;
        note(
          explanation[reason] ?? "Some session history could not be checked.",
          context,
        );
      }
      if (harness.status === "absent")
        note("No session logs were found for this agent.", context);
    }
    return { machine: machine.name, cells };
  });
  return {
    rows,
    notes: [...notes].map(([message, contexts]) => ({
      message,
      contexts: [...contexts],
    })),
  };
}
