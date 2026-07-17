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

test('the reminder offers exactly two choices: share now, or remind me in 3 hours', async () => {
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 6);
  assert.equal(visible(a), true);
  const buttons = a.evj(`[...document.querySelectorAll('#shareReminder button')].map(b => b.textContent.trim())`);
  assert.equal(buttons.length, 2);
  assert.match(buttons[0], /إرسال الآن/, 'share now');
  assert.match(buttons[1], /٣ ساعات/, 'remind me in 3 hours');
});

test('snoozing hides it for exactly 3 hours, then it returns', async () => {
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 7);
  assert.equal(visible(a), true);

  await a.ev('snoozeShareReminder()');
  assert.equal(visible(a), false, 'snoozed');

  // the snooze really is ~3 hours, not a day
  const hrs = a.ev(`(new Date(localStorage.getItem(reminderKey('snooze-until'))).getTime() - Date.now()) / 3600000`);
  assert.ok(hrs > 2.9 && hrs <= 3.01, `snooze is 3h (got ${hrs.toFixed(2)}h)`);

  // still hidden just before the 3h mark
  await a.ev(`localStorage.setItem(reminderKey('snooze-until'), new Date(Date.now() + 60000).toISOString())`);
  await a.ev('renderShareReminder()');
  assert.equal(visible(a), false, 'still snoozed a minute before it expires');

  // and it comes back once the 3 hours are up — snoozing is not dismissing
  await a.ev(`localStorage.setItem(reminderKey('snooze-until'), new Date(Date.now() - 1000).toISOString())`);
  await a.ev('renderShareReminder()');
  assert.equal(visible(a), true, 'reminder returns after the snooze expires');
});

test('a snooze that expires while the app is CLOSED fires on return', async () => {
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 7);
  await a.ev('snoozeShareReminder()');
  assert.equal(visible(a), false, 'snoozed');

  // The snooze is an absolute time on disk, not an in-memory timer, so it keeps
  // expiring while the browser is shut. Simulate 3h passing with the app closed:
  await a.ev(`localStorage.setItem(reminderKey('snooze-until'), new Date(Date.now() - 1000).toISOString())`);
  a.ev(`document.getElementById('shareReminder').classList.add('hidden')`);   // as if freshly loaded

  await a.ev('loadApp()');                       // user comes back and opens the app
  assert.equal(visible(a), true, 'reminder fires as soon as the user returns');
});

test('reminder state lives on disk, not in memory', async () => {
  // Nothing about the reminder depends on the page having stayed open.
  const a = await boot(folder(), 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  assert.ok(a.ev(`localStorage.getItem(reminderKey('unshared-since'))`), 'unshared work recorded on disk');
  await a.ev('snoozeShareReminder()');
  assert.ok(a.ev(`localStorage.getItem(reminderKey('snooze-until'))`), 'snooze recorded on disk');
  // and both are keyed to this identity, so A and Z never share a snooze
  assert.match(a.ev(`reminderKey('snooze-until')`), /-a$/);
});

test('sharing from the reminder itself clears it', async () => {
  const a = await boot(folder(), 'a');
  Object.defineProperty(a.win.navigator, 'canShare', { value: () => true, configurable: true });
  Object.defineProperty(a.win.navigator, 'share', { value: async () => {}, configurable: true });
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  age(a, 6);
  assert.equal(visible(a), true);
  await a.ev(`document.querySelector('#shareReminder button').click()`);
  await new Promise(r => setTimeout(r, 50));
  assert.equal(visible(a), false, 'the "إرسال الآن" button shares and dismisses');
  assert.equal(a.ev('unsharedDays()'), null);
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
