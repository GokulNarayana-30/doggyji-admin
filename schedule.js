/* Shared by the Notifications page and the offline regression test. */
(function (root) {
  const DAY = 864e5;
  const parts = (value) => {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || ''));
    return m ? Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : NaN;
  };
  /**
   * How many sends a schedule makes from its first send to an end date, both
   * as India calendar dates ('YYYY-MM-DD…'). The last send is on the end date
   * itself (daily), or on the last matching weekday on or before it (weekly).
   * Returns { runs, lastDate } or { error }.
   */
  root.scheduleRuns = function (start, repeat, endDate) {
    const from = parts(start);
    const to = parts(endDate);
    if (!Number.isFinite(from)) return { error: 'Choose the first send first.' };
    if (repeat === 'once') return { runs: 1, lastDate: new Date(from).toISOString().slice(0, 10) };
    if (!Number.isFinite(to)) return { error: 'Choose an end date.' };
    if (to < from) return { error: 'The end date is before the first send.' };
    const step = repeat === 'weekly' ? 7 : 1;
    const runs = Math.floor((to - from) / DAY / step) + 1;
    if (runs > 365) return { error: 'That is more than 365 sends. Choose an earlier end date.' };
    return { runs, lastDate: new Date(from + (runs - 1) * step * DAY).toISOString().slice(0, 10) };
  };
})(globalThis);
