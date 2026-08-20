import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { SUPPORTED_LOCALES } from "../js/i18n.js";

const read = (rel) => fs.readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

describe("sample manifest expression labels", () => {
  const manifest = JSON.parse(read("../assets/sample/manifest.json"));

  it("every declared expression carries a label in every supported locale", () => {
    const entries = Object.entries(manifest.expressions || {});
    expect(entries.length).toBeGreaterThan(0);
    for (const [id, def] of entries) {
      expect(def.label, `${id}.label must not be null`).not.toBeNull();
      expect(def.label, `${id}.label should be a per-language object`).toBeTypeOf("object");
      for (const loc of SUPPORTED_LOCALES) {
        expect(def.label[loc], `${id}.label.${loc}`).toBeTypeOf("string");
        expect(def.label[loc].length, `${id}.label.${loc} empty`).toBeGreaterThan(0);
      }
    }
  });

  it("the Character Lab resolves expression labels through pickLabel", () => {
    const html = read("../demo/expression-lab.html");
    expect(html).toMatch(/import \{[^}]*\bpickLabel\b[^}]*\} from "\.\.\/js\/i18n\.js"/);
    expect(html).toMatch(/pickLabel\(def && def\.label\)/);
    expect(html).toMatch(/pickLabel\(def\.label\)/);
  });
});
