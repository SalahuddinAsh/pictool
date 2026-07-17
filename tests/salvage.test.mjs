// Reproduces the real corruption found in pictures/tags.json on 2026-07-17:
// a shorter write left the tail of the longer version it replaced, so the file
// held valid JSON followed by "    60\n    ]\n  }\n}". JSON.parse rejected the whole
// document, every caller swallowed the error, and 695 tagged pictures silently
// displayed as zero. Silent total loss is the worst possible failure here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { boot, MemDir } from './harness.mjs';

const CORRUPT = readFileSync(new URL('./fixtures-corrupt-tags.json', import.meta.url), 'utf8');
const REAL_JUNK = '    60\n    ]\n  }\n}';

test('the fixture really is corrupt in the way the live file was', () => {
  assert.throws(() => JSON.parse(CORRUPT), /JSON/);
  assert.ok(CORRUPT.endsWith(REAL_JUNK));
});

test('a corrupt tags.json still migrates every tag instead of silently losing them', async () => {
  const dir = new MemDir();
  dir.seed('p1.jpg', 'X');
  dir.seed('p2.jpg', 'X');
  dir.seed('tags.json', CORRUPT);

  const a = await boot(dir, 'a');
  assert.deepEqual(a.evj('surahsFor("p1.jpg")'), [2, 5], 'tags recovered, not dropped');
  assert.deepEqual(a.evj('surahsFor("p2.jpg")'), [7]);

  // and they are durably migrated into the new file
  const mine = dir.read('a_data.json');
  assert.deepEqual(Object.keys(mine.tagOps).sort(), ['p1.jpg', 'p2.jpg']);
});

test('the user is told a file was salvaged rather than it happening invisibly', async () => {
  const dir = new MemDir();
  dir.seed('p1.jpg', 'X');
  dir.seed('tags.json', CORRUPT);
  const a = await boot(dir, 'a');
  assert.deepEqual(a.evj('salvagedFiles'), ['tags.json']);
  assert.match(a.win.document.getElementById('toast').textContent, /tags\.json/);
});

test('a corrupt per-user data file is salvaged too', async () => {
  const dir = new MemDir();
  dir.seed('p1.jpg', 'X');
  const good = {
    version: 4, app: 'pictool', user: 'b', label: 'Z', saved: '2026-07-16T00:00:00.000Z',
    tagOps: { 'p1.jpg': { 9: { op: 'a', at: '2026-07-16T00:00:00.000Z' } } },
    statusTagOps: {}, states: { 'p1.jpg': { status: 'done', notes: '', units: 4 } },
  };
  dir.seed('z_data.json', JSON.stringify(good, null, 2) + REAL_JUNK);

  const a = await boot(dir, 'a');
  assert.deepEqual(a.evj('surahsFor("p1.jpg")'), [9], "Z's tags survived the corruption");
  assert.equal(a.ev('getState("b","p1.jpg").units'), 4, "Z's units survived");
});

test('genuinely unusable content is still rejected, not half-read', async () => {
  const dir = new MemDir();
  dir.seed('p1.jpg', 'X');
  dir.seed('tags.json', 'this is not json at all');
  const a = await boot(dir, 'a');            // must not throw
  assert.deepEqual(a.evj('surahsFor("p1.jpg")'), []);
  assert.deepEqual(a.evj('salvagedFiles'), [], 'nothing was pretended to be salvaged');
});

test('salvaging never rewrites the damaged source file', async () => {
  const dir = new MemDir();
  dir.seed('p1.jpg', 'X');
  dir.seed('tags.json', CORRUPT);
  await boot(dir, 'a');
  assert.equal(dir.raw('tags.json'), CORRUPT, 'the legacy file is left exactly as found');
});
