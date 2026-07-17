// Exporting must reach the other person the easy way when the OS allows it,
// and must never silently fail when it doesn't.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, MemDir } from './harness.mjs';

function folder() {
  const d = new MemDir();
  d.seed('p1.jpg', 'X');
  return d;
}

// Records what the page tried to do with the file.
function instrument(win, { canShare = false, shareFails = null } = {}) {
  const log = { shared: [], downloaded: [] };
  Object.defineProperty(win.navigator, 'canShare', { value: () => canShare, configurable: true });
  Object.defineProperty(win.navigator, 'share', {
    configurable: true,
    value: async data => {
      if (shareFails) { const e = new Error('x'); e.name = shareFails; throw e; }
      log.shared.push(data);
    },
  });
  const realCreate = win.document.createElement.bind(win.document);
  win.document.createElement = tag => {
    const el = realCreate(tag);
    if (tag === 'a') el.click = () => log.downloaded.push(el.download);
    return el;
  };
  return log;
}

test('export uses the OS share sheet when the browser can share files', async () => {
  const a = await boot(folder(), 'a');
  const log = instrument(a.win, { canShare: true });
  await a.ev('setMyState("p1.jpg", { units: 2 }); writeMyData()');
  await a.ev('exportMyData()');

  assert.equal(log.shared.length, 1, 'share sheet was opened');
  assert.equal(log.downloaded.length, 0, 'no download fallback needed');
  const [payload] = log.shared;
  assert.equal(payload.files.length, 1);
  assert.match(payload.files[0].name, /^a_data_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}-\d{3}\.json$/,
    'shared filename carries who and when');
  // the shared bytes are the real file, not a stale copy
  const shared = JSON.parse(await payload.files[0].text());
  assert.equal(shared.user, 'a');
  assert.equal(shared.states['p1.jpg'].units, 2);
});

test('export falls back to a download when file sharing is unavailable', async () => {
  const a = await boot(folder(), 'a');
  const log = instrument(a.win, { canShare: false });
  await a.ev('exportMyData()');
  assert.equal(log.shared.length, 0);
  assert.equal(log.downloaded.length, 1, 'the file still reaches the user');
  assert.match(log.downloaded[0], /^a_data_.*\.json$/);
});

test('cancelling the share sheet does not also download', async () => {
  const a = await boot(folder(), 'a');
  const log = instrument(a.win, { canShare: true, shareFails: 'AbortError' });
  await a.ev('exportMyData()');
  assert.equal(log.downloaded.length, 0, 'cancelling means cancelling');
});

test('a failing share sheet still gets the file to the user', async () => {
  const a = await boot(folder(), 'a');
  const log = instrument(a.win, { canShare: true, shareFails: 'NotAllowedError' });
  await a.ev('exportMyData()');
  assert.equal(log.downloaded.length, 1, 'falls back rather than losing the export');
});

test('read-only S has nothing to export', async () => {
  const a = await boot(folder(), 'c');
  const log = instrument(a.win, { canShare: true });
  await a.ev('exportMyData()');
  assert.equal(log.shared.length, 0);
  assert.equal(log.downloaded.length, 0);
});
