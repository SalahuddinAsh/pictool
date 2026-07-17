// Builds the v4 base files (a_data.json / z_data.json) that seed the new tool
// from the legacy v2 files, without running the app.
//
// This is the same transformation migrateLegacyToMine() performs in-app, done
// once centrally so every user starts from one agreed, verified state instead of
// each machine migrating its own (possibly damaged) copy.
//
//   node tools/make-base-files.mjs <src-dir> <out-dir>
//
// Expects in <src-dir>:  tags.json, status_tags.json, a_states.json, z_states.json
// Writes to <out-dir>:   a_data.json, z_data.json
//
// Reads only; never modifies the source files.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const LEGACY_TAG_TS = '2000-01-01T00:00:00.000Z';
const TAG_ADD = 'a';
const USERS = { a: 'A', b: 'Z' };                       // key → label
const STATE_FILE = { a: 'a_states.json', b: 'z_states.json' };

const [, , SRC = 'data', OUT = 'data'] = process.argv;

// Tolerates the trailing-junk corruption seen in the real tags.json, the same
// way the app does — a shorter write that failed to truncate leaves the tail of
// the longer version behind.
function readJSONSalvaging(path) {
  const text = readFileSync(path, 'utf8');
  try { return JSON.parse(text); } catch (e) {
    let depth = 0, end = -1, inStr = false, esc = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inStr) { if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false; continue; }
      if (c === '"') { inStr = true; continue; }
      if (c === '{' || c === '[') depth++;
      else if (c === '}' || c === ']') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    if (end < 0) throw e;
    const out = JSON.parse(text.slice(0, end));
    console.warn(`  ! salvaged ${path}: dropped ${text.length - end} trailing bytes`);
    return out;
  }
}

const read = f => existsSync(join(SRC, f)) ? readJSONSalvaging(join(SRC, f)) : null;

const tags       = read('tags.json')        || { images: {} };
const statusTags = read('status_tags.json') || { tags: [] };

// Shared legacy tags become add-edits at a fixed old timestamp, identical in
// every user's file: any real edit by anyone later outranks them, and whoever
// corrects a tag wins regardless of whose file it came from.
const tagOps = {};
for (const [name, surahs] of Object.entries(tags.images || {})) {
  if (!Array.isArray(surahs) || !surahs.length) continue;
  tagOps[name] = {};
  for (const s of [...surahs].sort((x, y) => x - y)) tagOps[name][s] = { op: TAG_ADD, at: LEGACY_TAG_TS };
}

// The status vocabulary is shared truth too, so both files carry it identically.
const statusTagOps = {};
for (const t of statusTags.tags || []) {
  if (!t || !t.id) continue;
  statusTagOps[t.id] = { op: TAG_ADD, at: LEGACY_TAG_TS, label: t.label || t.id, color: t.color || '#6b7280' };
}

for (const [key, label] of Object.entries(USERS)) {
  const legacy = read(STATE_FILE[key]);
  if (!legacy) { console.error(`missing ${STATE_FILE[key]} — skipping ${label}`); continue; }

  const states = {};
  for (const [name, s] of Object.entries(legacy.images || {})) {
    const status = s.status || 'none';
    const notes  = s.notes || '';
    const units  = +s.units || 0;
    if (status !== 'none' || notes || units) states[name] = { status, notes, units };
  }

  const payload = {
    version: 4, app: 'pictool',
    user: key, label,
    saved: legacy.saved || new Date().toISOString(),   // honest: when the work was really last touched
    tagOps, statusTagOps, states,
  };
  const path = join(OUT, `${label.toLowerCase()}_data.json`);
  writeFileSync(path, JSON.stringify(payload, null, 2) + '\n');

  const withStatus = Object.values(states).filter(s => s.status !== 'none').length;
  const withNotes  = Object.values(states).filter(s => s.notes).length;
  const units      = Object.values(states).reduce((a, s) => a + s.units, 0);
  console.log(`${path}
  tagged pictures : ${Object.keys(tagOps).length}   (${Object.values(tagOps).reduce((a, o) => a + Object.keys(o).length, 0)} tags)
  status tags     : ${Object.keys(statusTagOps).length}
  states          : ${Object.keys(states).length}  (${withStatus} status, ${withNotes} notes, ${units} units)
  saved           : ${payload.saved}`);
}
