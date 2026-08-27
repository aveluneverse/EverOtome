// version-chip.js —— 首頁標題角版本列＋「檢查更新」。同 conn-note.test.js／
// settings.test.js 慣例：真 jsdom 容器，不 mock DOM。跟 update-check.js 共用模組
// 層級狀態，每個測試後清乾淨，不讓上一個測試查到的結果漏進下一個測試。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initVersionChip } from "../js/version-chip.js";
import { setUpdateState } from "../js/update-check.js";
import { VERSION } from "../js/version.js";
import { setLocale, t } from "../js/i18n.js";
import { FEEDBACK_URL } from "../js/feedback.js";
import { SettingsPanel } from "../js/settings.js";

const CHIP_HTML = `
  <div id="ver-chip" class="ver-chip">
    <span class="ver-chip-v" id="ver-chip-version"></span><span class="ver-chip-sep" aria-hidden="true">·</span>
    <button type="button" class="ver-chip-check" data-i18n="settings.checkUpdate">檢查更新</button>
    <span class="ver-chip-result" role="status" aria-live="polite" hidden></span>
  </div>
`;

function buildChip() {
  const container = document.createElement("div");
  container.innerHTML = CHIP_HTML;
  document.body.appendChild(container);
  return container;
}

function okResponse(items) {
  return { ok: true, status: 200, json: async () => items };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

afterEach(() => {
  setUpdateState(null);
  vi.useRealTimers();
});

describe("initVersionChip：版本文字＋檢查更新按鈕", () => {
  it("填入 v<VERSION>；開面板零 fetch", () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const container = buildChip();
    initVersionChip(container);
    expect(container.querySelector("#ver-chip-version").textContent).toBe("v" + VERSION);
    expect(container.querySelector(".ver-chip-result").hidden).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("找不到 #ver-chip（局部容器沒有這段 markup）＝安靜 no-op，回傳 null", () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    expect(initVersionChip(container)).toBe(null);
  });

  it("click → fetch 剛好一次 → found 態顯示 tag＋連到 GitHub 頁的連結，鈕隱藏", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v9.9.9-beta",
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    const result = container.querySelector(".ver-chip-result");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(btn.hidden).toBe(true);
    expect(result.hidden).toBe(false);
    expect(result.textContent).toContain("v9.9.9-beta");
    const a = result.querySelector("a");
    expect(a).not.toBe(null);
    expect(a.getAttribute("href")).toBe("https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta");
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener");
  });

  it("latest 態顯示已最新字串、鈕先隱藏，6 秒停留＋0.3 秒淡出後鈕淡回（fake timers）", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    const result = container.querySelector(".ver-chip-result");

    btn.click();
    await vi.advanceTimersByTimeAsync(0); // 讓 fetch/json 兩個 microtask 跑完
    expect(btn.hidden).toBe(true);
    expect(result.hidden).toBe(false);
    expect(result.textContent).toBe(t("settings.updateLatest"));

    await vi.advanceTimersByTimeAsync(5999);
    expect(result.hidden).toBe(false); // 還沒到 6 秒，結果還在
    expect(btn.hidden).toBe(true);

    await vi.advanceTimersByTimeAsync(1); // 滿 6000ms：開始淡出（opacity=0，還沒 hidden）
    expect(result.hidden).toBe(false);
    expect(result.style.opacity).toBe("0");

    await vi.advanceTimersByTimeAsync(300); // 淡出動畫跑完：結果收起、鈕回來
    expect(result.hidden).toBe(true);
    expect(result.textContent).toBe("");
    expect(btn.hidden).toBe(false);
  });

  it("failed 顯示失敗字串＋回報問題連結（FEEDBACK_URL），鈕不隱藏、可以馬上再按", async () => {
    global.fetch = vi.fn(async () => { throw new TypeError("network down"); });
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    const result = container.querySelector(".ver-chip-result");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(result.hidden).toBe(false);
    expect(result.textContent).toContain(t("settings.updateFailed"));
    const a = result.querySelector("a");
    expect(a).not.toBe(null);
    expect(a.getAttribute("href")).toBe(FEEDBACK_URL);
    expect(btn.hidden).toBe(false);
    expect(btn.disabled).toBe(false);
  });

  it("查詢中忽略第二次點擊：兩次點擊只打一次 fetch", async () => {
    let resolveJson;
    global.fetch = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: () => new Promise((r) => { resolveJson = r; }),
    }));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    btn.click();
    await Promise.resolve(); // 讓第一次點擊跑進 fetch()、把鈕鎖上
    await Promise.resolve();
    expect(btn.disabled).toBe(true);
    expect(btn.getAttribute("aria-busy")).toBe("true");
    btn.click(); // 查詢中，這次點擊應該被忽略
    resolveJson([{ tag_name: "v" + VERSION }]);
    await new Promise((r) => setTimeout(r, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("換語系：latest 結果文字立刻跟著新語系重組，不必重新查一次", async () => {
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    const result = container.querySelector(".ver-chip-result");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(result.textContent).toBe(t("settings.updateLatest")); // 查詢當下（zh-Hant）
    setLocale("en", { persist: false });
    expect(result.textContent).toBe(t("settings.updateLatest")); // 換語系後立刻跟上
    expect(global.fetch).toHaveBeenCalledTimes(1); // 沒有再打一次 API
    setLocale("zh-Hant", { persist: false }); // 還原語系，不影響後面的測試
  });

  it("設定頁與首頁版本列共用同一份查詢：任一邊查完，另一邊立刻顯示同一個結果", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v9.9.9-beta",
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    }]));
    const chipContainer = buildChip();
    initVersionChip(chipContainer);
    const settingsContainer = document.createElement("div");
    document.body.appendChild(settingsContainer);
    const panel = new SettingsPanel({ container: settingsContainer });
    panel.open();

    // 從首頁版本列查一次……
    chipContainer.querySelector(".ver-chip-check").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(global.fetch).toHaveBeenCalledTimes(1);
    // ……設定頁沒有另外查，結果卻已經同步顯示。
    const settingsResult = settingsContainer.querySelector(".settings-update-result");
    expect(settingsResult.textContent).toContain("v9.9.9-beta");
    expect(settingsResult.querySelector("a").getAttribute("href")).toBe(
      "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    );
  });
});
