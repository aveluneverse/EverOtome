// @vitest-environment node
// engine/tests/i18n-node.test.js —— 守門：i18n.js 在完全沒有 DOM／localStorage／navigator
// 的環境下（純 Node，用 @vitest-environment node 覆蓋本檔的測試環境）匯入與呼叫都不能炸。
// 這支模組未來可能被建置工具、SSR 預渲染或純 Node 腳本 import（例如只想吃字典查一個
// key），不該因為咬到 window/document/localStorage 而在 import 或呼叫階段就死掉。
// engine/tests/setup-i18n.js 對「每一個測試檔」都會跑（vitest.config.js 的全域
// setupFiles），本檔也不例外——它的 beforeEach 只呼叫 setLocale(...,{persist:false})，
// 而 setLocale 本身對 DOM／storage 一律 try/guard，所以在 node 環境下同樣不會拋錯
// （下面每個 it 都間接驗證了這件事：真的炸的話，beforeEach 自己就會先讓全部測試變紅）。
import { describe, it, expect } from "vitest";
import { t, getLocale, initI18n, applyDom, setLocale, getStoredChoice, SUPPORTED_LOCALES } from "../js/i18n.js";
import zhHant from "../js/locales/zh-Hant.js";

describe("i18n.js survives a DOM-less / storage-less / navigator-less environment", () => {
  it("t() reads the zh-Hant dictionary without any browser globals", () => {
    expect(t("menu.clear")).toBe(zhHant["menu.clear"]);
  });

  it("getLocale() starts at the source locale", () => {
    expect(getLocale()).toBe("zh-Hant");
  });

  it("initI18n() resolves to a valid locale without throwing, with no url/stored/config to anchor to", () => {
    // 不釘死特定語系字串：Node 22 的內建 navigator.language 會反映執行機器的系統
    // 語系（實測：在 zh-TW 系統上會拿到 "zh-TW"，不是 finding 原本假設的
    // 「沒 navigator 可讀、因此落到 fallback 的 en」）——與其釘死 "en" 讓測試看機器
    // 臉色（別台 CI 或 en 系統的機器會得到不同結果），真正要守的是這裡的重點：
    // 沒有 URL／stored／config 可依附時也不會炸、並能算出一個合法語系（在 SUPPORTED_LOCALES
    // 內）——不管最後落在 browser 還是 fallback 那一支。
    let result;
    expect(() => { result = initI18n(); }).not.toThrow();
    expect(SUPPORTED_LOCALES).toContain(result);
  });

  it("applyDom() and setLocale(..., { persist: true }) do not throw with nothing to touch", () => {
    expect(() => applyDom()).not.toThrow();
    expect(() => setLocale("en", { persist: true })).not.toThrow();
    expect(getLocale()).toBe("en");
  });

  it("getStoredChoice() is 'auto' — there is no localStorage to have stored anything into", () => {
    expect(getStoredChoice()).toBe("auto");
  });
});
