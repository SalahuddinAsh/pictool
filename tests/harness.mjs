// Boots the real pictool.html inside jsdom against an in-memory folder that
// implements the File System Access API surface the app actually uses.
// Nothing in pictool.html is modified or re-implemented for tests.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';
import FDBFactory from 'fake-indexeddb/lib/FDBFactory';

const HTML = join(dirname(fileURLToPath(import.meta.url)), '..', 'pictool.html');

class MemFileHandle {
  kind = 'file';
  constructor(dir, name) { this.dir = dir; this.name = name; }
  async getFile() {
    const c = this.dir.files.get(this.name);
    if (c === undefined) { const e = new Error('NotFound'); e.name = 'NotFoundError'; throw e; }
    return { text: async () => c, lastModified: this.dir.mtimes.get(this.name) ?? Date.now(), size: c.length };
  }
  async createWritable() {
    let buf = '';
    return {
      write: async d => { buf += typeof d === 'string' ? d : String(d); },
      close: async () => { this.dir.files.set(this.name, buf); this.dir.mtimes.set(this.name, Date.now()); },
    };
  }
}

export class MemDir {
  kind = 'directory';
  constructor(name = 'root') { this.name = name; this.files = new Map(); this.mtimes = new Map(); this.dirs = new Map(); }
  async getFileHandle(name, opts = {}) {
    if (!this.files.has(name)) {
      if (!opts.create) { const e = new Error('NotFound: ' + name); e.name = 'NotFoundError'; throw e; }
      this.files.set(name, '');
    }
    return new MemFileHandle(this, name);
  }
  async getDirectoryHandle(name, opts = {}) {
    if (!this.dirs.has(name)) {
      if (!opts.create) { const e = new Error('NotFound: ' + name); e.name = 'NotFoundError'; throw e; }
      this.dirs.set(name, new MemDir(name));
    }
    return this.dirs.get(name);
  }
  async removeEntry(name) { this.files.delete(name); }
  async *entries() {
    for (const [n] of this.files) yield [n, new MemFileHandle(this, n)];
    for (const [n, d] of this.dirs) yield [n, d];
  }
  // test helpers
  seed(name, obj) { this.files.set(name, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2)); this.mtimes.set(name, Date.now()); }
  read(name) { const c = this.files.get(name); return c === undefined ? undefined : JSON.parse(c); }
  raw(name) { return this.files.get(name); }
  has(name) { return this.files.has(name); }
  backups() { const b = this.dirs.get('backups'); return b ? [...b.files.keys()] : []; }
}

// Boot the app as `identity`, with `dir` as the chosen folder.
export async function boot(dir, identity, opts = {}) {
  const html = readFileSync(HTML, 'utf8');
  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    url: 'https://salahuddinash.github.io/pictool/',
    beforeParse(win) {
      win.indexedDB = new FDBFactory();
      win.showDirectoryPicker = async () => dir;
      // jsdom has no IntersectionObserver; thumbnails are irrelevant to these tests.
      win.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} };
      win.URL.createObjectURL = () => 'blob:stub';
      win.URL.revokeObjectURL = () => {};
      win.confirm = () => (opts.confirm ?? true);
      win.alert = m => { (dom.__alerts ||= []).push(String(m)); };
      win.scrollTo = () => {};
      if (identity) win.localStorage.setItem('pictool-identity', identity);
    },
  });
  const win = dom.window;
  dom.__alerts = [];
  win.__alerts = dom.__alerts;
  await new Promise(r => win.addEventListener('load', r));
  // Top-level `let` bindings live in the script's lexical scope, not on window —
  // global eval reaches them, which is how we inject the folder handle.
  win.eval('dirHandle = window.__dir;');
  win.__dir = dir;
  win.eval('dirHandle = window.__dir;');
  await win.eval('loadApp()');
  return {
    win, dom, dir, alerts: dom.__alerts,
    ev: code => win.eval(code),
    // Values built inside jsdom have that realm's prototypes, so deepStrictEqual
    // rejects them; round-trip through JSON to compare plain data.
    evj: code => JSON.parse(win.eval(`JSON.stringify(${code})`)),
  };
}

export const ISO = s => new Date(s).toISOString();
