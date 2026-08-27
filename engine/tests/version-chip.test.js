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
    <span class="ver-chip-sep ver-chip-sep-report" aria-hidden="true">·</span>
    <a class="ver-chip-report feedback-link" href="#stale-placeholder" target="_blank" rel="noopener" data-i18n="feedback.report">回報問題</a>
  </div>
  <a class="report-icon-btn feedback-link" href="#stale-placeholder-icon" target="_blank" rel="noopener" aria-label="回報問題" data-i18n-attr="aria-label:feedback.report">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
      <line x1="12" y1="7" x2="12" y2="11"></line>
      <line x1="12" y1="15" x2="12.01" y2="15"></line>
    </svg>
  </a>
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
    expect(a.classList.contains("feedback-link")).toBe(false); // 非回饋連結，不套用回饋連結配色
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

  it("failed 顯示失敗字串，鈕不隱藏、可以馬上再按；結果行不再自己接回報問題連結（Mira 2026-08-27 22:1x 拍板：永久連結已經在同一行，見下方 describe）", async () => {
    global.fetch = vi.fn(async () => { throw new TypeError("network down"); });
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    const result = container.querySelector(".ver-chip-result");
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(result.hidden).toBe(false);
    expect(result.textContent).toBe(t("settings.updateFailed"));
    expect(result.querySelector("a")).toBe(null); // 不再自己 append 第二顆連結
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

describe("永久「回報問題」連結（Mira 2026-08-27 22:1x 拍板：跟「檢查更新」同一行，狀態列那份拿掉）", () => {
  it("開面板就存在，不必查詢或失敗才出現；href／target／rel／class 齊全，init 時從 FEEDBACK_URL 覆寫（不是沿用 HTML 上寫死的字面值）", () => {
    const container = buildChip();
    initVersionChip(container);
    const link = container.querySelector(".ver-chip-report");
    expect(link).not.toBe(null);
    expect(link.getAttribute("href")).toBe(FEEDBACK_URL); // fixture 原本寫 "#stale-placeholder"，init 時被覆寫
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener");
    expect(link.classList.contains("feedback-link")).toBe(true);
    expect(link.textContent).toBe(t("feedback.report"));
  });

  it("零 fetch：光是 initVersionChip 就看得到這顆連結，不必按過「檢查更新」", () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const container = buildChip();
    initVersionChip(container);
    expect(container.querySelector(".ver-chip-report")).not.toBe(null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("換語系：文字跟著換（走既有 data-i18n／applyDom 機制，version-chip.js 不必另外接程式碼）", () => {
    const container = buildChip();
    initVersionChip(container);
    const link = container.querySelector(".ver-chip-report");
    expect(link.textContent).toBe("回報問題");
    setLocale("en", { persist: false });
    expect(link.textContent).toBe(t("feedback.report"));
    expect(link.textContent).not.toBe("回報問題");
    setLocale("zh-Hant", { persist: false }); // 還原語系，不影響後面的測試
    expect(link.textContent).toBe("回報問題");
  });

  it("found／latest 兩態一樣在同一行：永久連結不會被 render() 動到（不受鈕隱藏、結果行改寫影響）", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v9.9.9-beta",
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    }]));
    const container = buildChip();
    initVersionChip(container);
    const link = container.querySelector(".ver-chip-report");
    container.querySelector(".ver-chip-check").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".ver-chip-report")).toBe(link); // 同一個節點，沒被重建或移除
    expect(link.getAttribute("href")).toBe(FEEDBACK_URL);
  });
});

describe("手機版回報問題 icon（.report-icon-btn，Mira 2026-08-27 22:5x 拍板：跟 .chatlog-full-btn 同排，取代版本列裡的文字連結）", () => {
  it("開面板就存在，不必查詢或失敗才出現；href 在 init 時從 FEEDBACK_URL 覆寫（不是沿用 HTML 上寫死的字面值）；target／rel／class／svg 齊全", () => {
    const container = buildChip();
    initVersionChip(container);
    const icon = container.querySelector(".report-icon-btn");
    expect(icon).not.toBe(null);
    expect(icon.getAttribute("href")).toBe(FEEDBACK_URL); // fixture 原本寫 "#stale-placeholder-icon"，init 時被覆寫
    expect(icon.getAttribute("target")).toBe("_blank");
    expect(icon.getAttribute("rel")).toBe("noopener");
    expect(icon.classList.contains("feedback-link")).toBe(true);
    expect(icon.querySelectorAll("svg").length).toBe(1);
    expect(icon.querySelector("svg").getAttribute("aria-hidden")).toBe("true");
  });

  it("零 fetch：光是 initVersionChip 就看得到這顆 icon，不必按過「檢查更新」", () => {
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy;
    const container = buildChip();
    initVersionChip(container);
    expect(container.querySelector(".report-icon-btn")).not.toBe(null);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("換語系：aria-label 跟著換（走既有 data-i18n-attr／applyDom 機制，version-chip.js 不必另外接程式碼）", () => {
    const container = buildChip();
    initVersionChip(container);
    const icon = container.querySelector(".report-icon-btn");
    expect(icon.getAttribute("aria-label")).toBe("回報問題");
    setLocale("en", { persist: false });
    expect(icon.getAttribute("aria-label")).toBe(t("feedback.report"));
    expect(icon.getAttribute("aria-label")).not.toBe("回報問題");
    setLocale("zh-Hant", { persist: false }); // 還原語系，不影響後面的測試
    expect(icon.getAttribute("aria-label")).toBe("回報問題");
  });

  it("found／latest／failed 狀態切換不影響這顆 icon：同一個節點、href 不變（render() 只碰 .ver-chip-result／.ver-chip-check，不碰它）", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v9.9.9-beta",
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    }]));
    const container = buildChip();
    initVersionChip(container);
    const icon = container.querySelector(".report-icon-btn");
    container.querySelector(".ver-chip-check").click();
    await new Promise((r) => setTimeout(r, 0));
    expect(container.querySelector(".report-icon-btn")).toBe(icon);
    expect(icon.getAttribute("href")).toBe(FEEDBACK_URL);
  });

  it("找不到 .report-icon-btn（局部容器只搭 #ver-chip，沒有這段 markup）＝安靜略過，不影響版本號／檢查更新照常運作", () => {
    const container = document.createElement("div");
    container.innerHTML = `
      <div id="ver-chip" class="ver-chip">
        <span class="ver-chip-v" id="ver-chip-version"></span><span class="ver-chip-sep" aria-hidden="true">·</span>
        <button type="button" class="ver-chip-check" data-i18n="settings.checkUpdate">檢查更新</button>
        <span class="ver-chip-result" role="status" aria-live="polite" hidden></span>
      </div>
    `;
    document.body.appendChild(container);
    expect(() => initVersionChip(container)).not.toThrow();
    expect(container.querySelector("#ver-chip-version").textContent).toBe("v" + VERSION);
  });
});

describe("焦點管理（Mira 2026-08-27 規則：鈕被 hidden 甩掉的鍵盤焦點要接住，不要掉到 body）", () => {
  it("found：點擊前鈕有鍵盤焦點 → 鈕藏起來後焦點接到新出現的連結", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v9.9.9-beta",
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    btn.focus();
    expect(document.activeElement).toBe(btn);
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    const link = container.querySelector(".ver-chip-result a");
    expect(document.activeElement).toBe(link);
  });

  it("found：滑鼠點擊（鈕從沒被 focus 過）→ 焦點不會被強制搬到連結上", async () => {
    global.fetch = vi.fn(async () => okResponse([{
      tag_name: "v9.9.9-beta",
      html_url: "https://github.com/aveluneverse/EverOtome/releases/tag/v9.9.9-beta",
    }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    btn.click(); // 沒有先 focus()：模擬滑鼠使用者
    await new Promise((r) => setTimeout(r, 0));
    const link = container.querySelector(".ver-chip-result a");
    expect(document.activeElement).not.toBe(link);
  });

  it("latest：點擊前鈕有鍵盤焦點 → 鈕藏起來後焦點接到結果行（tabindex=-1）；6.3 秒後鈕淡回，焦點仍在 chip 內就還給鈕", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    const result = container.querySelector(".ver-chip-result");
    btn.focus();
    btn.click();
    await vi.advanceTimersByTimeAsync(0); // 讓 fetch/json 兩個 microtask 跑完
    expect(result.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(result);

    await vi.advanceTimersByTimeAsync(6300); // 6000 停留 ＋ 300 淡出，鈕淡回
    expect(btn.hidden).toBe(false);
    expect(document.activeElement).toBe(btn);
  });

  it("latest：焦點在鈕淡回前已經離開 chip（使用者自己 tab 走了）→ 鈕淡回不搶焦點", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    btn.focus();
    btn.click();
    await vi.advanceTimersByTimeAsync(0);

    const elsewhere = document.createElement("input");
    document.body.appendChild(elsewhere);
    elsewhere.focus();
    expect(document.activeElement).toBe(elsewhere);

    await vi.advanceTimersByTimeAsync(6300);
    expect(btn.hidden).toBe(false);
    expect(document.activeElement).toBe(elsewhere); // 沒被搶走
  });

  it("latest：滑鼠點擊（鈕從沒被 focus 過）→ 焦點不會被強制搬到結果行", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(async () => okResponse([{ tag_name: "v" + VERSION }]));
    const container = buildChip();
    initVersionChip(container);
    const btn = container.querySelector(".ver-chip-check");
    const result = container.querySelector(".ver-chip-result");
    btn.click(); // 沒有先 focus()：模擬滑鼠使用者
    await vi.advanceTimersByTimeAsync(0);
    expect(document.activeElement).not.toBe(result);
  });
});
