/**
 * The NOTICE and WARNING messages a pending migration raises, forwarded to the runner's output while that
 * migration's SQL runs (dry run and apply), so that the release's log records what a migration reports about the
 * database it meets (0090 names every owner it checked). node-postgres drops a notice nobody listens to.
 *
 * Each becomes one line, `<SEVERITY> <migration file>: <message>`, its own line breaks flattened, so that no
 * forwarded line can be read as the runner's own pending count or plan line, which the release matches line by line.
 * Notices outside a migration's SQL (the ledger's bootstrap, the plan) are not forwarded.
 */
export function forwardMigrationNotices(client, write) {
  let current = null;
  client.on('notice', (notice) => {
    if (current === null) return;
    const severity = /^[A-Z]{1,16}$/.test(String(notice?.severity ?? '')) ? notice.severity : 'NOTICE';
    const message = String(notice?.message ?? '').replace(/\s+/g, ' ').trim();
    write(`${severity} ${current}: ${message}\n`);
  });
  return {
    async during(version, run) {
      current = version;
      try {
        return await run();
      } finally {
        current = null;
      }
    },
  };
}
