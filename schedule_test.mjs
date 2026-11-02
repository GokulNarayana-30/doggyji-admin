import assert from 'node:assert/strict';
import './schedule.js';
const r = (s, rep, e) => globalThis.scheduleRuns(s, rep, e);
// Daily from 20 Nov to 30 Nov, both days counted.
assert.deepEqual(r('2026-11-20T10:00', 'daily', '2026-11-30'), { runs: 11, lastDate: '2026-11-30' });
// The same day: one send.
assert.deepEqual(r('2026-11-20T10:00', 'daily', '2026-11-20'), { runs: 1, lastDate: '2026-11-20' });
// Across a month and a year end.
assert.deepEqual(r('2026-12-30T09:00', 'daily', '2027-01-02'), { runs: 4, lastDate: '2027-01-02' });
// Leap day.
assert.equal(r('2028-02-27T09:00', 'daily', '2028-03-01').runs, 4);
// Weekly: 20 Nov to 30 Nov holds two (20 Nov, 27 Nov); the last is the 27th.
assert.deepEqual(r('2026-11-20T10:00', 'weekly', '2026-11-30'), { runs: 2, lastDate: '2026-11-27' });
assert.deepEqual(r('2026-11-20T10:00', 'weekly', '2026-11-26'), { runs: 1, lastDate: '2026-11-20' });
// Once ignores the end date.
assert.equal(r('2026-11-20T10:00', 'once', '').runs, 1);
// Mistakes are refused with a reason.
assert.match(r('2026-11-20T10:00', 'daily', '2026-11-19').error, /before/);
assert.match(r('2026-11-20T10:00', 'daily', '').error, /end date/);
assert.match(r('', 'daily', '2026-11-30').error, /first send/);
assert.match(r('2026-01-01T10:00', 'daily', '2027-12-31').error, /365/);
assert.equal(r('2026-01-01T10:00', 'daily', '2026-12-31').runs, 365);
console.log('Schedule end date: 12 cases passed');
