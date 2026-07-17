// Diffing, twice-daily backups, and 30-day FIFO retention.
// Pruning is the only code in the app that deletes anything, so it gets the
// most scrutiny here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, MemDir } from './harness.mjs';

const DAY = 86400000;
const stamp = d => {
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}-${String(d.getMilliseconds()).padStart(3,'0')}`;
};
const file = (over = {}) => ({
  version: 4, app: 'pictool', user: 'a', label: 'A', saved: '2026-07-16T00:00:00.000Z',
  tagOps: {}, statusTagOps: {}, states: {}, ...over,
});
function folder() { const d = new MemDir(); d.seed('p1.jpg', 'X'); d.seed('p2.jpg', 'X'); return d; }
function backupsOf(dir) {
  if (!dir.dirs.has('backups')) dir.dirs.set('backups', new MemDir('backups'));
  return dir.dirs.get('backups');
}
// put a backup on disk with a chosen age
function seedBackup(dir, prefix, ageDays, content = file()) {
  const name = `${prefix}${stamp(new Date(Date.now() - ageDays * DAY))}.json`;
  backupsOf(dir).seed(name, content);
  return name;
}
// make every existing backup look `hours` old
function ageAll(dir, hours) {
  const b = backupsOf(dir);
  for (const n of [...b.files.keys()]) {
    const c = b.files.get(n);
    b.files.delete(n);
    b.seed(`a_${stamp(new Date(Date.now() - hours * 3600 * 1000))}.json`, c);
  }
}

// ── DIFF ──────────────────────────────────────────────────────────────
test('diff reports tags added and removed', async () => {
  const a = await boot(folder(), 'a');
  const oldD = file({ tagOps: { 'p1.jpg': { 2: { op: 'a', at: 'x' }, 5: { op: 'a', at: 'x' } } } });
  const newD = file({ tagOps: { 'p1.jpg': { 2: { op: 'a', at: 'x' }, 5: { op: 'd', at: 'y' }, 9: { op: 'a', at: 'y' } } } });
  const d = a.evj(`diffVersions(${JSON.stringify(oldD)}, ${JSON.stringify(newD)})`);
  assert.deepEqual(d.tagAdded, [{ file: 'p1.jpg', surah: 9 }]);
  assert.deepEqual(d.tagRemoved, [{ file: 'p1.jpg', surah: 5 }]);
  assert.equal(d.isEmpty, false);
});

test('diff reports status, notes and unit changes field by field', async () => {
  const a = await boot(folder(), 'a');
  const oldD = file({ states: { 'p1.jpg': { status: 'done', notes: 'تم', units: 2 } } });
  const newD = file({ states: { 'p1.jpg': { status: 'none', notes: '', units: 3 } } });
  const d = a.evj(`diffVersions(${JSON.stringify(oldD)}, ${JSON.stringify(newD)})`);
  assert.equal(d.stateChanged.length, 1);
  assert.deepEqual(d.stateChanged[0].changes.map(c => c.field).sort(), ['notes', 'status', 'units']);
  const st = d.stateChanged[0].changes.find(c => c.field === 'status');
  assert.deepEqual([st.from, st.to], ['done', 'none']);
});

test('diff reports work gained and work lost', async () => {
  const a = await boot(folder(), 'a');
  const oldD = file({ states: { 'p1.jpg': { status: 'done', notes: 'x', units: 1 } } });
  const newD = file({ states: { 'p2.jpg': { status: 'partial', notes: 'y', units: 2 } } });
  const d = a.evj(`diffVersions(${JSON.stringify(oldD)}, ${JSON.stringify(newD)})`);
  assert.deepEqual(d.stateRemoved.map(x => x.file), ['p1.jpg']);
  assert.deepEqual(d.stateAdded.map(x => x.file), ['p2.jpg']);
});

test('diff reports status-vocabulary changes', async () => {
  const a = await boot(folder(), 'a');
  const oldD = file({ statusTagOps: { c1: { op: 'a', at: 'x', label: 'قديم', color: '#000' } } });
  const newD = file({ statusTagOps: { c1: { op: 'd', at: 'y', label: 'قديم', color: '#000' },
                                      c2: { op: 'a', at: 'y', label: 'جديد', color: '#111' } } });
  const d = a.evj(`diffVersions(${JSON.stringify(oldD)}, ${JSON.stringify(newD)})`);
  assert.deepEqual(d.vocabAdded, ['جديد']);
  assert.deepEqual(d.vocabRemoved, ['قديم']);
});

test('identical versions diff to nothing', async () => {
  const a = await boot(folder(), 'a');
  const f = file({ tagOps: { 'p1.jpg': { 2: { op: 'a', at: 'x' } } }, states: { 'p1.jpg': { status: 'done', notes: 'n', units: 1 } } });
  const d = a.evj(`diffVersions(${JSON.stringify(f)}, ${JSON.stringify(f)})`);
  assert.equal(d.isEmpty, true);
});

test('diff reads each file standalone, not merged with other users', async () => {
  // Z's file must not leak into a diff of two of A's versions.
  const dir = folder();
  dir.seed('z_data.json', { ...file({ user: 'b', label: 'Z' }), tagOps: { 'p1.jpg': { 40: { op: 'a', at: 'z' } } } });
  const a = await boot(dir, 'a');
  const oldD = file({ tagOps: { 'p1.jpg': { 2: { op: 'a', at: 'x' } } } });
  const newD = file({ tagOps: { 'p1.jpg': { 2: { op: 'a', at: 'x' } } } });
  const d = a.evj(`diffVersions(${JSON.stringify(oldD)}, ${JSON.stringify(newD)})`);
  assert.equal(d.isEmpty, true, "Z's surah 40 must not appear in a diff of A's versions");
});

test('comparing one version against the current file works end to end', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev('setMyState("p1.jpg", { status: "done", notes: "أول", units: 2 }); writeMyData()');
  const snap = a.ev('JSON.parse(JSON.stringify(1))') && dir.raw('a_data.json');
  const b = dir.dirs.get('backups') || (dir.dirs.set('backups', new MemDir('backups')), dir.dirs.get('backups'));
  b.seed('a_2026-07-01_10-00-00-000.json', snap);

  await a.ev('setMyState("p1.jpg", { status: "none", notes: "", units: 5 }); writeMyData()');
  await a.ev('openVersions()');
  a.ev(`toggleVersionSel("a_2026-07-01_10-00-00-000.json")`);
  await a.ev('compareSelected()');
  const panel = a.win.document.getElementById('verDiffPanel').textContent;
  assert.match(panel, /الحالة/);
  assert.match(panel, /الوحدات/);
  assert.match(panel, /الوضع الحالي/);
});

// ── TWICE-DAILY BACKUP ────────────────────────────────────────────────
test('no extra backup within 12 hours', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');                       // migration/open snapshot
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  const before = dir.backups().length;
  assert.equal(await a.ev('maybePeriodicBackup()'), false, 'fresh backup exists, so none taken');
  assert.equal(dir.backups().length, before);
});

test('a second snapshot is taken once 12 hours have passed, then not again', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  assert.equal(dir.backups().length, 1, 'first snapshot');

  ageAll(dir, 13);
  await a.ev('setMyState("p1.jpg", { units: 2 }); writeMyData()');
  assert.equal(dir.backups().length, 2, 'a second snapshot once 12h passed');

  await a.ev('setMyState("p1.jpg", { units: 3 }); writeMyData()');
  assert.equal(dir.backups().length, 2, 'no third snapshot within 12h of the second');
});

test('an unchanged file is not snapshotted again', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  ageAll(dir, 13);
  const before = dir.backups().length;
  await a.ev('maybePeriodicBackup()');            // 12h passed, but content identical
  assert.equal(dir.backups().length, before, 'identical content is not duplicated');
});

test('read-only S never creates backups', async () => {
  const dir = folder();
  const s = await boot(dir, 'c');
  assert.equal(await s.ev('maybePeriodicBackup()'), false);
  assert.equal(dir.backups().length, 0);
});

// ── DELETION IS MANUAL ────────────────────────────────────────────────
test('NOTHING is ever deleted automatically', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  const ancient = [400, 380, 360].map(d => seedBackup(dir, 'a_', d));
  // do everything that could plausibly trigger a cleanup
  await a.ev('setMyState("p1.jpg", { units: 1 }); writeMyData()');
  await a.ev('setMyState("p1.jpg", { units: 2 }); writeMyData()');
  await a.ev('maybePeriodicBackup()');
  await a.ev('openVersions()');
  for (const n of ancient)
    assert.ok(dir.backups().includes(n), `${n} survives normal use — deletion is never automatic`);
});

test('manual delete removes only backups older than 30 days', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  const old1 = seedBackup(dir, 'a_', 45);
  const old2 = seedBackup(dir, 'a_', 31);
  const keep = seedBackup(dir, 'a_', 10);
  for (let i = 0; i < 3; i++) seedBackup(dir, 'a_', i);   // recent, satisfy the min-kept floor
  await a.ev('openVersions()');
  await a.ev('deleteOldBackups()');                        // confirm() is stubbed true
  const left = dir.backups();
  assert.ok(!left.includes(old1), '45-day-old backup deleted');
  assert.ok(!left.includes(old2), '31-day-old backup deleted');
  assert.ok(left.includes(keep), '10-day-old backup kept');
});

test('declining the confirmation deletes nothing', async () => {
  const dir = folder();
  const a = await boot(dir, 'a', { confirm: false });
  for (let i = 0; i < 5; i++) seedBackup(dir, 'a_', 100 + i);
  await a.ev('openVersions()');
  const before = dir.backups().length;
  await a.ev('deleteOldBackups()');
  assert.equal(dir.backups().length, before, 'saying no means no');
});

test('manual delete never leaves you with nothing', async () => {
  // Someone returns after a year: every backup is older than the window.
  const dir = folder();
  const a = await boot(dir, 'a');
  backupsOf(dir).files.clear();
  const ancient = [400, 380, 360, 340, 320].map(d => seedBackup(dir, 'a_', d));
  await a.ev('openVersions()');
  await a.ev('deleteOldBackups()');
  const left = dir.backups();
  assert.equal(left.length, 3, 'the newest 3 survive rather than deleting everything');
  assert.deepEqual(left.sort(), ancient.slice(-3).sort(), 'the three NEWEST are the survivors');
});

test('each backup stream is considered independently', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  backupsOf(dir).files.clear();
  for (let i = 0; i < 4; i++) seedBackup(dir, 'a_', i);              // recent mine
  const oldImport = seedBackup(dir, 'import_z_', 90, file({ user: 'b' }));
  for (let i = 0; i < 3; i++) seedBackup(dir, 'import_z_', i, file({ user: 'b' }));
  await a.ev('openVersions()');
  await a.ev('deleteOldBackups()');
  const left = dir.backups();
  assert.ok(!left.includes(oldImport), 'old import archive deleted');
  assert.equal(left.filter(n => n.startsWith('a_')).length, 4, 'my recent backups untouched');
  assert.equal(left.filter(n => n.startsWith('import_z_')).length, 3, 'recent imports kept');
});

test('files that are not ours are never deleted', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  const b = backupsOf(dir);
  b.seed('notes-from-2019.json', { mine: true });
  b.seed('readme.txt', 'hello');
  for (let i = 0; i < 4; i++) seedBackup(dir, 'a_', 100 + i);
  await a.ev('openVersions()');
  await a.ev('deleteOldBackups()');
  const left = dir.backups();
  assert.ok(left.includes('notes-from-2019.json'), 'unrecognised filename left alone');
  assert.ok(left.includes('readme.txt'), 'non-backup file left alone');
});
