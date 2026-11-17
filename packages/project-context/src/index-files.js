import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { INDEX_CHECK_INTERVAL } from "./index-progress.js";

export const INDEX_READ_BYTES = 64 * 1024;
const WRITE_CHARS = 64 * 1024;
const RUN_RECORDS = 2048;
const RUN_PATH_CHARS = 512 * 1024;
const MERGE_FAN_IN = 8;
const DIRECTORY_BATCH = 256;
const collate = new Intl.Collator("en").compare;

export function comparePaths(left, right) {
  return collate(left, right) || (left < right ? -1 : left === right ? 0 : 1);
}

function compareRecords(left, right) {
  return comparePaths(left.path, right.path);
}

function runPath(directory, pass, run) {
  return path.join(directory, `run-${pass}-${run}.jsonl`);
}

class LineWriter {
  constructor(filename, final) {
    this.lines = [];
    this.chars = 0;
    this.hashed = false;
    this.hash = final ? createHash("sha256") : null;
    this.fd = fs.openSync(filename, "wx", 0o600);
  }

  append(line) {
    this.lines.push(line);
    this.chars += line.length + 1;
    if (this.chars >= WRITE_CHARS) this.flush();
  }

  flush() {
    if (!this.chars) return;
    const chunk = this.lines.join("\n");
    fs.writeFileSync(this.fd, chunk + "\n", "utf8");
    // The profile's digest has always omitted the final JSONL newline.
    if (this.hash) {
      if (this.hashed) this.hash.update("\n");
      this.hash.update(chunk);
      this.hashed = true;
    }
    this.lines.length = 0;
    this.chars = 0;
  }

  finish() {
    this.flush();
    if (!this.hash) return;
    fs.fsyncSync(this.fd);
    return this.hash.digest("hex");
  }

  close() {
    this.lines.length = 0;
    fs.closeSync(this.fd);
  }
}

class RunReader {
  constructor(filename) {
    this.filename = filename;
    this.buffer = Buffer.allocUnsafe(INDEX_READ_BYTES);
    this.decoder = new StringDecoder("utf8");
    this.text = "";
    this.offset = 0;
    this.line = undefined;
    this.path = undefined;
    this.fd = fs.openSync(filename, "r");
  }

  advance() {
    let prefix = "";
    while (true) {
      const newline = this.text.indexOf("\n", this.offset);
      if (newline !== -1) {
        this.line = prefix + this.text.slice(this.offset, newline);
        this.path = JSON.parse(this.line).path;
        this.offset = newline + 1;
        return;
      }
      prefix += this.text.slice(this.offset);
      const bytes = fs.readSync(this.fd, this.buffer);
      if (bytes === 0) {
        if (prefix || this.decoder.end()) throw new Error(`Incomplete index run: ${this.filename}`);
        this.line = this.path = undefined;
        return;
      }
      this.text = this.decoder.write(this.buffer.subarray(0, bytes));
      this.offset = 0;
    }
  }

  close() {
    fs.closeSync(this.fd);
  }
}

export class DirectoryStack {
  constructor(directory) {
    this.directory = directory;
    this.paths = [];
    this.runs = 0;
    this.peak = 0;
    this.spills = 0;
  }

  push(relative) {
    if (this.paths.length === DIRECTORY_BATCH) {
      fs.writeFileSync(path.join(this.directory, `dirs-${this.runs}.json`), JSON.stringify(this.paths), { flag: "wx", mode: 0o600 });
      this.runs++;
      this.spills++;
      this.paths.length = 0;
    }
    this.paths.push(relative);
    if (this.paths.length > this.peak) this.peak = this.paths.length;
  }

  pop() {
    if (this.paths.length === 0 && this.runs > 0) {
      const filename = path.join(this.directory, `dirs-${--this.runs}.json`);
      this.paths = JSON.parse(fs.readFileSync(filename, "utf8"));
      fs.unlinkSync(filename);
    }
    return this.paths.pop();
  }
}

export class IndexRuns {
  constructor(directory, control) {
    this.directory = directory;
    this.control = control;
    this.records = [];
    this.pathChars = 0;
    this.runs = 0;
    this.peak = 0;
    this.peakReaders = 0;
  }

  add(record) {
    if (this.records.length === RUN_RECORDS || (this.records.length && this.pathChars + record.path.length > RUN_PATH_CHARS)) this.spill();
    this.records.push(record);
    this.pathChars += record.path.length;
    if (this.records.length > this.peak) this.peak = this.records.length;
  }

  spill() {
    this.control?.check();
    this.writeRecords(runPath(this.directory, 0, this.runs++), false);
  }

  writeRecords(filename, final) {
    this.records.sort(compareRecords);
    const writer = new LineWriter(filename, final);
    try {
      for (const record of this.records) writer.append(JSON.stringify(record));
      return writer.finish();
    } finally {
      this.records.length = 0;
      this.pathChars = 0;
      writer.close();
    }
  }

  merge(filename, pass, from, to, final) {
    const writer = new LineWriter(filename, final);
    const readers = [];
    let merged = 0;
    try {
      for (let run = from; run < to; run++) {
        const reader = new RunReader(runPath(this.directory, pass, run));
        readers.push(reader);
        reader.advance();
      }
      if (readers.length > this.peakReaders) this.peakReaders = readers.length;
      while (true) {
        let next;
        for (const reader of readers) {
          if (reader.line !== undefined && (next === undefined || comparePaths(reader.path, next.path) < 0)) next = reader;
        }
        if (!next) break;
        if (merged++ % INDEX_CHECK_INTERVAL === 0) this.control?.check();
        writer.append(next.line);
        next.advance();
      }
      return writer.finish();
    } finally {
      try {
        for (const reader of readers) reader.close();
      } finally { writer.close(); }
    }
  }

  finish(filename) {
    if (this.runs === 0) return this.writeRecords(filename, true);
    if (this.records.length) this.spill();
    let count = this.runs;
    let pass = 0;
    while (count > MERGE_FAN_IN) {
      let nextRun = 0;
      for (let from = 0; from < count; from += MERGE_FAN_IN) {
        this.control?.check();
        const to = Math.min(from + MERGE_FAN_IN, count);
        this.merge(runPath(this.directory, pass + 1, nextRun++), pass, from, to, false);
        for (let run = from; run < to; run++) fs.unlinkSync(runPath(this.directory, pass, run));
      }
      count = nextRun;
      pass++;
    }
    const hash = this.merge(filename, pass, 0, count, true);
    for (let run = 0; run < count; run++) fs.unlinkSync(runPath(this.directory, pass, run));
    return hash;
  }
}
