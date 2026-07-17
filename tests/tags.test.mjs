// The safety properties v3 exists to guarantee, exercised against the real app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, MemDir } from './harness.mjs';

const LEGACY = '2000-01-01T00:00:00.000Z';

// A folder as it looks the moment before v3 first runs: the old shared tags.json
// plus each user's legacy states (with notes/status/units that must survive).
function legacyFolder() {
  const d = new MemDir();
  d.seed('photo_1.jpg', 'JPEGDATA');
  d.seed('photo_2.jpg', 'JPEGDATA');
  d.seed('tags.json', {
    version: 1, saved: '2026-06-01T10:00:00.000Z',
    images: { 'photo_1.jpg': [2, 5], 'photo_2.jpg': [7] },
  });
  d.seed('status_tags.json', { version: 1, tags: [{ id: 'custom_1', label: 'مراجعة', color: '#0ea5e9' }] });
  d.seed('a_states.json', {
    version: 1, user: 'a', saved: '2026-06-02T10:00:00.000Z',
    images: { 'photo_1.jpg': { status: 'done', notes: 'ملاحظة A', units: 3.5 } },
  });
  d.seed('z_states.json', {
    version: 1, user: 'b', saved: '2026-06-02T11:00:00.000Z',
    images: { 'photo_2.jpg': { status: 'partial', notes: 'ملاحظة Z', units: 2 } },
  });
  return d;
}

test('migration preserves tags, status, notes and work units', async () => {
  const dir = legacyFolder();
  const { evj } = await boot(dir, 'a');

  const mine = dir.read('a_data.json');
  assert.equal(mine.user, 'a');
  assert.equal(mine.version, 4);

  // legacy tags became add-edits stamped with the legacy timestamp
  assert.deepEqual(mine.tagOps['photo_1.jpg'], { 2: { op: 'a', at: LEGACY }, 5: { op: 'a', at: LEGACY } });

  // units and notes survived intact — this is real work that must not be lost
  assert.equal(mine.states['photo_1.jpg'].units, 3.5);
  assert.equal(mine.states['photo_1.jpg'].notes, 'ملاحظة A');
  assert.equal(mine.states['photo_1.jpg'].status, 'done');
  assert.deepEqual(mine.statusTags, [{ id: 'custom_1', label: 'مراجعة', color: '#0ea5e9' }]);

  // merged view shows the legacy tags
  assert.deepEqual(evj('surahsFor("photo_1.jpg")'), [2, 5]);

  // legacy files are never modified
  assert.deepEqual(dir.read('tags.json').images, { 'photo_1.jpg': [2, 5], 'photo_2.jpg': [7] });
});

test('a correction by one user propagates to the other', async () => {
  const dir = legacyFolder();

  // Z notices surah 5 is wrong on photo_1 and removes it
  const z = await boot(dir, 'b');
  await z.ev('setTagOp("photo_1.jpg", 5, "d")');
  const zFile = dir.read('z_data.json');
  assert.equal(zFile.tagOps['photo_1.jpg'][5].op, 'd');

  // A opens the same folder having imported Z's file: the tag is gone for A too,
  // even though A's own file still carries the legacy add.
  const a = await boot(dir, 'a');
  assert.deepEqual(a.evj('surahsFor("photo_1.jpg")'), [2]);
  assert.equal(dir.read('a_data.json').tagOps['photo_1.jpg'][5].op, 'a');
});

test('a later re-add beats an earlier delete', async () => {
  const dir = legacyFolder();
  const z = await boot(dir, 'b');
  await z.ev('setTagOp("photo_1.jpg", 5, "d")');

  const a = await boot(dir, 'a');
  assert.deepEqual(a.evj('surahsFor("photo_1.jpg")'), [2]);
  await a.ev('setTagOp("photo_1.jpg", 5, "a")');   // A disagrees, re-adds later
  assert.deepEqual(a.evj('surahsFor("photo_1.jpg")'), [2, 5]);

  // and Z sees the re-add once holding A's file
  const z2 = await boot(dir, 'b');
  assert.deepEqual(z2.evj('surahsFor("photo_1.jpg")'), [2, 5]);
});

test('THE 2026-07-17 INCIDENT: a stale file cannot clobber newer work', async () => {
  const dir = legacyFolder();

  // A does real work: corrects a tag, sets status and logs units
  const a = await boot(dir, 'a');
  await a.ev('setTagOp("photo_1.jpg", 5, "d")');
  await a.ev('setMyState("photo_1.jpg", { status: "done", notes: "A النهائية", units: 9 }); writeMyData()');
  const aAfterWork = dir.raw('a_data.json');

  // Z's machine was offline for weeks; its file still holds the pre-correction world
  const staleZ = {
    version: 4, app: 'pictool', user: 'b', label: 'Z',
    saved: '2026-06-05T09:00:00.000Z',
    tagOps: { 'photo_1.jpg': { 2: { op: 'a', at: LEGACY }, 5: { op: 'a', at: LEGACY } } },
    statusTags: [], states: { 'photo_1.jpg': { status: 'none', notes: '', units: 0 } },
  };
  dir.seed('z_data.json', staleZ);

  // A reopens with the stale file present — v2 lost A's work here.
  const a2 = await boot(dir, 'a');
  assert.deepEqual(a2.evj('surahsFor("photo_1.jpg")'), [2], 'stale add must not resurrect the deleted tag');
  assert.equal(a2.ev('myState("photo_1.jpg").units'), 9, 'A units untouched by stale import');
  assert.equal(a2.ev('myState("photo_1.jpg").status'), 'done');
  assert.equal(dir.raw('a_data.json'), aAfterWork, "A's file is byte-identical — nothing wrote to it");
});

test('importing another user only ever writes that user\'s file', async () => {
  const dir = legacyFolder();
  const a = await boot(dir, 'a');
  await a.ev('setMyState("photo_1.jpg", { units: 4 }); writeMyData()');
  const before = dir.raw('a_data.json');

  const incoming = {
    version: 4, app: 'pictool', user: 'b', label: 'Z', saved: '2026-07-20T00:00:00.000Z',
    tagOps: { 'photo_1.jpg': { 9: { op: 'a', at: '2026-07-20T00:00:00.000Z' } } },
    statusTags: [], states: { 'photo_1.jpg': { status: 'partial', notes: 'من Z', units: 5 } },
  };
  await a.ev(`writeRawUserFile('b', ${JSON.stringify(incoming)})`);

  assert.equal(dir.raw('a_data.json'), before, "import must not touch the importer's own file");
  assert.deepEqual(dir.read('z_data.json').tagOps['photo_1.jpg'][9].op, 'a');
});

test('merge is order-independent (same files in, same tags out)', async () => {
  const opsA = { 'p.jpg': { 5: { op: 'a', at: '2026-07-01T00:00:00.000Z' } } };
  const opsB = { 'p.jpg': { 5: { op: 'd', at: '2026-07-02T00:00:00.000Z' } } };
  const mk = (first, second) => {
    const d = new MemDir();
    d.seed('p.jpg', 'X');
    d.seed('a_data.json', { version: 4, app: 'pictool', user: 'a', saved: 'x', tagOps: first, states: {}, statusTags: [] });
    d.seed('z_data.json', { version: 4, app: 'pictool', user: 'b', saved: 'x', tagOps: second, states: {}, statusTags: [] });
    return d;
  };
  const one = await boot(mk(opsA, opsB), 'c');   // read-only S, so nothing is rewritten
  const two = await boot(mk(opsB, opsA), 'c');
  assert.deepEqual(one.evj('surahsFor("p.jpg")'), []);
  assert.deepEqual(two.evj('surahsFor("p.jpg")'), []);
});

test('read-only user S never writes any data file', async () => {
  const dir = legacyFolder();
  const s = await boot(dir, 'c');
  await s.ev('setTagOp("photo_1.jpg", 3, "a")');
  await s.ev('setMyState("photo_1.jpg", { units: 99 }); writeMyData()');
  await s.ev('applyTagSet("photo_1.jpg", [1,2,3])');
  assert.equal(dir.has('s_data.json'), false, 'S must not create a data file');
  assert.deepEqual(s.evj('surahsFor("photo_1.jpg")'), [2, 5], "S's attempted edits changed nothing");
});

test('S sees work units of both A and Z in statistics', async () => {
  const dir = legacyFolder();
  await (await boot(dir, 'a')).ev('setMyState("photo_1.jpg", { units: 3.5 }); writeMyData()');
  await (await boot(dir, 'b')).ev('setMyState("photo_2.jpg", { units: 2 }); writeMyData()');

  const s = await boot(dir, 'c');
  s.ev('viewOthers = new Set(); openStats()');       // even with others toggled OFF
  const body = s.win.document.getElementById('statsBody').textContent;
  assert.match(body, /3\.5/, "A's units must be visible to S");
  assert.match(body, /\b2\b/, "Z's units must be visible to S");
  assert.match(body, /5\.5/, 'total units');
});

test('backup on open, and restore is non-destructive', async () => {
  const dir = legacyFolder();
  const a1 = await boot(dir, 'a');                       // migrates, creates a_data.json
  await a1.ev('setMyState("photo_1.jpg", { units: 1 }); writeMyData()');

  const a2 = await boot(dir, 'a');                       // opening again snapshots the file
  const mine = dir.backups().filter(n => n.startsWith('a_'));
  assert.ok(mine.length >= 1, 'a backup of my file exists');

  await a2.ev('setMyState("photo_1.jpg", { units: 42 }); writeMyData()');
  assert.equal(dir.read('a_data.json').states['photo_1.jpg'].units, 42);

  // the snapshot taken when a2 opened still holds units=1
  const bdir = dir.dirs.get('backups');
  const snap = mine.find(n => JSON.parse(bdir.files.get(n)).states['photo_1.jpg'].units === 1);
  assert.ok(snap, 'the pre-session snapshot is on disk');

  const countBefore = dir.backups().length;
  await a2.ev(`restoreVersion(${JSON.stringify(snap)})`);
  assert.equal(dir.read('a_data.json').states['photo_1.jpg'].units, 1, 'restored older state');
  assert.ok(dir.backups().length > countBefore, 'restore first backed up the current state');
  // and the state we just replaced (units=42) is itself recoverable
  assert.ok(dir.backups().some(n => {
    try { return JSON.parse(bdir.files.get(n)).states['photo_1.jpg'].units === 42; } catch { return false; }
  }), 'the overwritten state was snapshotted, so restore is undoable');
});

test('both users filter on the same merged tags, whatever the display toggle', async () => {
  const dir = legacyFolder();
  // Z adds surah 9 to photo_2; A removes surah 7 from it
  await (await boot(dir, 'b')).ev('setTagOp("photo_2.jpg", 9, "a")');
  const a = await boot(dir, 'a');
  await a.ev('setTagOp("photo_2.jpg", 7, "d")');

  const filterBySurah = (t, n) => t.evj(`(fSurahs.length = 0, fSurahs.push(${n}), applyFilters(), filtered)`);

  // A filters by a surah only Z ever tagged, and still finds the picture
  assert.deepEqual(filterBySurah(a, 9), ['photo_2.jpg']);
  // the tag A deleted no longer matches for anyone
  assert.deepEqual(filterBySurah(a, 7), []);

  // Z, holding the same files, filters to exactly the same results
  const z = await boot(dir, 'b');
  assert.deepEqual(filterBySurah(z, 9), ['photo_2.jpg']);
  assert.deepEqual(filterBySurah(z, 7), []);

  // and toggling the other user's data off does not change tag filtering,
  // because tags are shared truth rather than per-user opinion
  a.ev('viewOthers = new Set()');
  assert.deepEqual(filterBySurah(a, 9), ['photo_2.jpg']);
});

test('junk and foreign files are rejected on import', async () => {
  const dir = legacyFolder();
  const a = await boot(dir, 'a');
  const before = dir.raw('a_data.json');
  await a.ev(`onImportFile({ target: { files: [{ text: async () => 'not json' }], value: '' } })`);
  await a.ev(`onImportFile({ target: { files: [{ text: async () => JSON.stringify({ app:'other', user:'a' }) }], value: '' } })`);
  assert.equal(dir.raw('a_data.json'), before);
  assert.ok(a.alerts.length >= 2, 'user was told why the import was refused');
});
