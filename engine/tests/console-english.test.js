import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Developers wiring a backend read the browser console; every message the engine
// prints there is English (comments may stay Chinese). Scans every console.* call
// (and every logError/logWarn call, which route through feedback.js and append an
// English suffix on top of whatever message they are given) whose first argument
// is a string literal.
const JS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "js");
const CJK = /[一-鿿]/;
const CALL = /(?:console\.(?:warn|error|log|info|debug)|logError|logWarn)\(\s*(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;

function jsFiles(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) return d.name === "locales" ? [] : jsFiles(p);
    return d.name.endsWith(".js") ? [p] : [];
  });
}

// 抽成獨立函式（而非留在 it() 內），好讓下面兩個 fixture 測試也能直接餵假原始碼
// 進來，證明這份規則真的會抓到 CJK、也真的放行純英文——不是只在真檔案上跑過
// 從沒被驗證過有效。CALL 是模組層級的 /g regex，多次 exec() 呼叫共用同一個
// lastIndex；每次掃描前歸零，不依賴上一輪掃描剛好把 lastIndex 用完重置。
function findOffenders(src, label) {
  const offenders = [];
  CALL.lastIndex = 0;
  let m;
  while ((m = CALL.exec(src)) !== null) {
    if (CJK.test(m[2])) {
      const line = src.slice(0, m.index).split("\n").length;
      offenders.push(`${label}:${line}: ${m[2].slice(0, 60)}`);
    }
  }
  return offenders;
}

describe("engine console messages are English", () => {
  it("no console.*/logError/logWarn call starts with a Chinese string", () => {
    const offenders = [];
    for (const file of jsFiles(JS_DIR)) {
      const src = fs.readFileSync(file, "utf8");
      offenders.push(...findOffenders(src, path.relative(JS_DIR, file)));
    }
    expect(offenders, "Chinese console message(s):\n" + offenders.join("\n")).toEqual([]);
  });

  it("fixture: a Chinese first argument to logWarn is caught (the guard really inspects the routed calls, not just raw console.*)", () => {
    const fixture = 'function f() {\n  logWarn("哎呀 something failed:", e);\n}\n';
    expect(findOffenders(fixture, "fixture.js")).toEqual(["fixture.js:2: 哎呀 something failed:"]);
  });

  it("fixture: an English logError/logWarn call is not flagged", () => {
    const fixture = 'logError("totally fine:", e);\nlogWarn("also fine:", e);\n';
    expect(findOffenders(fixture, "fixture.js")).toEqual([]);
  });
});
