// engine/tests/config-example.test.js — 契約測試：config.example.json 頂層帶
// locale 鍵、五套主題與留聲機的 label 皆為雙語物件（zh-Hant／en）；pickLabel
// 依目前語系挑對的名字。鎖住 Task 6「config 多語 label」的資料形狀——appearances[0]
// 的 label（"Rye"）是人名，刻意不比照改成雙語物件，這裡也不驗它。
import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { setLocale, pickLabel } from "../js/i18n.js";

describe("config.example.json 多語 label 契約", () => {
  it("config.example.json carries locale + bilingual labels", () => {
    const cfg = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../config.example.json"), "utf8"));
    expect(cfg.locale).toBe("auto");
    for (const th of cfg.themes) {
      expect(th.label["zh-Hant"]).toBeTypeOf("string");
      expect(th.label.en).toBeTypeOf("string");
    }
    const gram = cfg.furniture.find((f) => f.id === "gramophone");
    setLocale("en", { persist: false });
    expect(pickLabel(gram.label)).toBe("Gramophone");
    setLocale("zh-Hant", { persist: false });
    expect(pickLabel(gram.label)).toBe("留聲機");
  });
});
