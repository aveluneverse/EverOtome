import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// __dirname 走 fileURLToPath（跟 sandbox.test.js／expression.test.js 同一套）——jsdom
// 環境下 `new URL("../x", import.meta.url)` 會被 jsdom 的 URL 蓋掉、解析成
// http://localhost:3000/... 而非 file:，直接餵 fs.readFileSync 會炸「must be of
// scheme file」；這個寫法是全專案唯一已驗證能跑的路徑，不要換回去。
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

describe("file:// hint", () => {
  it("ships a hidden note and a classic script that reveals it only under file:", () => {
    expect(html).toMatch(/<p id="file-protocol-note" hidden>/);
    expect(html).toMatch(/python serve\.py/);
    expect(html).toMatch(/<script>\s*if \(location\.protocol === "file:"\)/);
    expect(html.indexOf('id="file-protocol-note"')).toBeLessThan(html.indexOf('<script type="module" src="js/app.js">'));
  });

  it("carries the feedback box as a link (Mira 2026-08-27 rule: every user-facing error path)", () => {
    const note = html.match(/<p id="file-protocol-note" hidden>([\s\S]*?)<\/p>/)[1];
    expect(note).toMatch(/Stuck\? Tell us: /);
    expect(note).toMatch(/<a class="feedback-link" href="https:\/\/marshmallow-qa\.com\/a4u0myommjpyzup" target="_blank" rel="noopener">https:\/\/marshmallow-qa\.com\/a4u0myommjpyzup<\/a>/);
  });
});
