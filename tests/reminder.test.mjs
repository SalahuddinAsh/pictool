// The reminder must fire when unshared work goes stale — and stay silent
// otherwise, or people learn to click past it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, MemDir } from './harness.mjs';

const DAY = 86400000;

function folder() {
  const d = new MemDir();
  d.seed('p1.jpg', 'X');
  return d;
}

const visible = t => !t.win.document.getElementById('shareReminder').classList.contains('hidden');
const text    = t => t.win.document.getElementById('shareReminderText').textContent;
// Pretend the unshared work has been sitting for `days`.
const age = (t, days) => t.ev(
  `(localStorage.setItem(reminderKey('unshared-since'), new Date(Date.now() - ${days} * ${DAY}).toISOString()),
    renderShareReminder())`);

test('stays silent when there is nothing unshared', async () => {
  const a = await boot(folder(), 'a');
  assert.equal(a.ev('unsharedDays()'), null, 'no unshared work is recorded yet');
  assert.equal(visible(a), false);
});

test('stays silent while unshared work is still fresh', async () => {
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  assert.ok(a.ev(`localStorage.getItem(reminderKey('unshared-since'))`), 'the change was recorded');
  assert.equal(visible(a), false, 'not due on day 0');
  age(a, 4.9);
  assert.equal(visible(a), false, 'still not due just before day 5');
});

test('reminds once unshared work is 5 days old', async () => {
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 5);
  assert.equal(visible(a), true);
  assert.match(text(a), /5/);
  assert.match(text(a), /Z/, 'names who is waiting on the file');
});

test('sharing clears the reminder until new work happens', async () => {
  const a = await boot(folder(), 'a');
  Object.defineProperty(a.win.navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(a.win.navigator, 'share', { value: async () => {}, configurable: true });

  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 6);
  assert.equal(visible(a), true);

  await a.ev('exportMyData()');
  assert.equal(visible(a), false, 'reminder gone after sharing');
  assert.equal(a.ev('unsharedDays()'), null);

  // and it comes back only once there is genuinely new unshared work
  await a.ev('setMyState("p1.jpg", { units: 2 }); writeMyData()');
  assert.equal(visible(a), false, 'fresh work is not nagged about immediately');
  age(a, 5);
  assert.equal(visible(a), true);
});

test('snoozing hides it for a day, then it returns', async () => {
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 7);
  assert.equal(visible(a), true);

  await a.ev('snoozeShareReminder()');
  assert.equal(visible(a), false, 'snoozed');

  // once the snooze expires the reminder returns — snoozing is not dismissing
  await a.ev(`localStorage.setItem(reminderKey('snooze-until'), new Date(Date.now() - 1000).toISOString())`);
  await a.ev('renderShareReminder()');
  assert.equal(visible(a), true);
});

test('long-overdue work is escalated visually', async () => {
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 6);
  assert.equal(a.ev(`document.getElementById('shareReminder').classList.contains('overdue')`), false);
  age(a, 11);
  assert.equal(a.ev(`document.getElementById('shareReminder').classList.contains('overdue')`), true);
});

test('read-only S is never reminded — there is nothing to send', async () => {
  const dir = folder();
  const s = await boot(dir, 'c');
  await s.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  assert.equal(s.ev('unsharedDays()'), null, 'S accrues no unshared work');
  age(s, 30);
  assert.equal(visible(s), false);
});

test('each identity tracks its own reminder', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 9);
  assert.equal(visible(a), true);

  // a different identity on a fresh machine has its own state
  const z = await boot(folder(), 'b');
  assert.equal(z.ev('unsharedDays()'), null);
  assert.equal(visible(z), false);
});
