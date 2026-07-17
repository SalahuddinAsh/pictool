// Status ASSIGNMENTS are per-user opinions (A done / Z partial, both true).
// The status VOCABULARY (which custom tags exist) is shared, like surah tags.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, MemDir } from './harness.mjs';

function folder() {
  const d = new MemDir();
  d.seed('p1.jpg', 'X');
  d.seed('p2.jpg', 'X');
  return d;
}

const statusOptions = t => t.evj('[...document.getElementById("fStatus").options].map(o => o.value + "|" + o.text)');
const filterByStatus = (t, s, users = []) => t.evj(
  `(document.getElementById("fStatus").value = ${JSON.stringify(s)},
    fUsers = new Set(${JSON.stringify(users)}), applyFilters(), filtered)`);

test('built-in status filtering works per user, and for both together', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev('setMyState("p1.jpg", { status: "done" }); writeMyData()');
  const z = await boot(dir, 'b');
  await z.ev('setMyState("p2.jpg", { status: "done" }); writeMyData()');

  const a2 = await boot(dir, 'a');
  assert.deepEqual(filterByStatus(a2, 'done', ['a']), ['p1.jpg'], "only A's done");
  assert.deepEqual(filterByStatus(a2, 'done', ['b']), ['p2.jpg'], "only Z's done");
  assert.deepEqual(filterByStatus(a2, 'done', ['a', 'b']), ['p1.jpg', 'p2.jpg'], 'either user');
  assert.deepEqual(filterByStatus(a2, 'done', []), ['p1.jpg', 'p2.jpg'], 'aggregate across users');
});

test('a custom status tag made by one user is usable and filterable by the other', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev('document.getElementById("manageTagsBtn").click()');
  await a.ev(`(document.getElementById("newTagLabel").value = "يحتاج تدقيق",
               document.getElementById("newTagColor").value = "#ff0000",
               addCustomStatusTag())`);
  const newId = a.evj('customStatusTags.map(t => t.id)')[0];
  await a.ev(`setMyState("p1.jpg", { status: ${JSON.stringify(newId)} }); writeMyData()`);

  // Z, holding A's file, sees the tag in the vocabulary and can filter by it
  const z = await boot(dir, 'b');
  assert.ok(z.evj('customStatusTags.map(t => t.label)').includes('يحتاج تدقيق'),
    "Z's vocabulary must include the tag A created");
  assert.ok(statusOptions(z).some(o => o.endsWith('|يحتاج تدقيق')),
    "Z must be able to filter by A's custom status");
  assert.deepEqual(filterByStatus(z, newId, []), ['p1.jpg']);

  // and Z can apply that same tag to their own pictures
  await z.ev(`setMyState("p2.jpg", { status: ${JSON.stringify(newId)} }); writeMyData()`);
  const a2 = await boot(dir, 'a');
  assert.deepEqual(filterByStatus(a2, newId, ['b']), ['p2.jpg'], "A can filter Z's use of the tag");
  assert.deepEqual(filterByStatus(a2, newId, []), ['p1.jpg', 'p2.jpg']);
});

test('custom status tags created independently never collide', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev(`(document.getElementById("manageTagsBtn").click(),
               document.getElementById("newTagLabel").value = "وسم A",
               addCustomStatusTag())`);
  const z = await boot(dir, 'b');
  await z.ev(`(document.getElementById("manageTagsBtn").click(),
               document.getElementById("newTagLabel").value = "وسم Z",
               addCustomStatusTag())`);

  const both = await boot(dir, 'a');
  const tags = both.evj('customStatusTags');
  const ids = tags.map(t => t.id);
  assert.equal(new Set(ids).size, ids.length, 'ids must be unique across users');
  const labels = tags.map(t => t.label).sort();
  assert.deepEqual(labels, ['وسم A', 'وسم Z'], 'both tags coexist');
});

test('deleting a shared status tag propagates, and a later re-add wins', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev(`(document.getElementById("manageTagsBtn").click(),
               document.getElementById("newTagLabel").value = "مؤقت",
               addCustomStatusTag())`);
  const id = a.evj('customStatusTags.map(t => t.id)')[0];

  // Z removes it; A must see it gone
  const z = await boot(dir, 'b');
  await z.ev(`removeCustomStatusTag(${JSON.stringify(id)})`);
  const a2 = await boot(dir, 'a');
  assert.deepEqual(a2.evj('customStatusTags'), [], "Z's removal reached A");

  // pictures still carrying the removed status keep a readable label
  await a2.ev(`setMyState("p1.jpg", { status: ${JSON.stringify(id)} })`);
  assert.equal(a2.evj(`statusMeta(${JSON.stringify(id)}).label`), 'مؤقت',
    'a removed tag still renders its label where it is still assigned');
});

test('a stale import cannot resurrect a removed status tag', async () => {
  const dir = folder();
  const a = await boot(dir, 'a');
  await a.ev(`(document.getElementById("manageTagsBtn").click(),
               document.getElementById("newTagLabel").value = "خطأ",
               addCustomStatusTag())`);
  const id = a.evj('customStatusTags.map(t => t.id)')[0];
  await a.ev(`removeCustomStatusTag(${JSON.stringify(id)})`);
  assert.deepEqual(a.evj('customStatusTags'), []);

  // Z's weeks-old file still lists the tag as present
  dir.seed('z_data.json', {
    version: 4, app: 'pictool', user: 'b', label: 'Z', saved: '2026-06-01T00:00:00.000Z',
    tagOps: {}, states: {},
    statusTagOps: { [id]: { op: 'a', at: '2026-06-01T00:00:00.000Z', label: 'خطأ', color: '#000' } },
  });
  const a2 = await boot(dir, 'a');
  assert.deepEqual(a2.evj('customStatusTags'), [], 'stale add must not resurrect the removed tag');
});
