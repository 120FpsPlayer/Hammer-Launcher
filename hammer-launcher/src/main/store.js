'use strict';

/** Small JSON files, written atomically (temp file + rename), so a crash never leaves half a file behind. */

const fs = require('node:fs');
const path = require('node:path');

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return typeof fallback === 'function' ? fallback() : structuredClone(fallback);
  }
}

/** Waits without giving the turn away – only for the few short pauses of replace() below. */
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Puts the finished temp file in place. On Windows an antivirus or the search indexer often holds a file for a
 * moment right after it was read or written, and the rename is refused – so it is tried again a few times.
 */
function replace(tmp, file, tries = 5) {
  for (let n = 1; ; n += 1) {
    try {
      return fs.renameSync(tmp, file);
    } catch (err) {
      if (n >= tries || !['EPERM', 'EBUSY', 'EACCES'].includes(err?.code)) throw err;
      pause(25 * n);
    }
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    replace(tmp, file);
  } catch (err) {
    // The file stays as it was – and no temp file is left next to it for every try that failed.
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // (it could not even be removed – the error below is the one that matters)
    }
    throw err;
  }
  return data;
}

module.exports = { readJson, writeJson, replaceFile: replace };
