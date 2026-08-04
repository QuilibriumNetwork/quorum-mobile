// Concurrency limiter for fs.promises to prevent EMFILE on Windows.
//
// Background: Node.js v22 on Windows has a hard 8192 CRT file-descriptor
// ceiling (MSVC 2022 limit). Metro's metro-cache FileStore uses fs.promises
// for reads/writes, and its DeltaBundler/buildSubgraph.js fans out with
// unbounded Promise.all over thousands of modules — easily blowing past the
// limit on a 16k-module project.
//
// graceful-fs does NOT patch fs.promises (only callback APIs), so this is a
// separate semaphore queue that wraps the promise-based open/readFile/writeFile.
//
// Activation: NODE_OPTIONS=--require=<this-file> when launching Metro.

const fs = require('fs');

const MAX_CONCURRENT = 200; // leaves ~7800 FDs for everything else
let active = 0;
const queue = [];

function drain() {
  while (queue.length > 0 && active < MAX_CONCURRENT) {
    const { fn, resolve, reject } = queue.shift();
    active++;
    fn().then(
      (val) => {
        active--;
        resolve(val);
        drain();
      },
      (err) => {
        if (err && (err.code === 'EMFILE' || err.code === 'ENFILE')) {
          // Transient FD exhaustion: requeue and retry later
          active--;
          queue.unshift({ fn, resolve, reject });
          setImmediate(drain);
        } else {
          active--;
          reject(err);
          drain();
        }
      }
    );
  }
}

function enqueue(fn) {
  return new Promise((resolve, reject) => {
    queue.push({ fn, resolve, reject });
    drain();
  });
}

const originalPromises = fs.promises;
const patchedReadFile = (...args) => enqueue(() => originalPromises.readFile(...args));
const patchedWriteFile = (...args) => enqueue(() => originalPromises.writeFile(...args));
const patchedOpen = (...args) => enqueue(() => originalPromises.open(...args));
const patchedReaddir = (...args) => enqueue(() => originalPromises.readdir(...args));
const patchedStat = (...args) => enqueue(() => originalPromises.stat(...args));
const patchedLstat = (...args) => enqueue(() => originalPromises.lstat(...args));

const patchedNamespace = Object.assign(Object.create(originalPromises), {
  readFile: patchedReadFile,
  writeFile: patchedWriteFile,
  open: patchedOpen,
  readdir: patchedReaddir,
  stat: patchedStat,
  lstat: patchedLstat,
});

Object.defineProperty(fs, 'promises', {
  get() {
    return patchedNamespace;
  },
  configurable: true,
});

if (process.env.PATCH_FS_PROMISES_VERBOSE) {
  console.log(`[patch-fs-promises] active concurrency limit: ${MAX_CONCURRENT}`);
}
