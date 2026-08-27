import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Developers wiring a backend read the browser console; every message the engine
// prints there is English (comments may stay Chinese). Scans every console.* call
// whose first argument is a string literal.
const JS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "js");
const CJK = /[一-鿿]/;
const CALL = /console\.(?:warn|error|log|info|debug)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "locales" ? [] : jsFiles(p);
    return d.name.endsWith(".js") ? [p] : [];
  });
}

describe("engine console messages are English", () => {
  it("no console.* call starts with a Chinese string", () => {
    const offenders = [];
    for (const file of jsFiles(JS_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      let m;
      while ((m = CALL.exec(src)) !== null) {
        if (CJK.test(m[2])) {
          const line = src.slice(0, m.index).split("\n").length;
          offenders.push(`${path.relative(JS_DIR, file)}:${line}: ${m[2].slice(0, 60)}`);
        }
      }
    }
    expect(offenders, "Chinese console message(s):\n" + offenders.join("\n")).toEqual([]);
  });
});
