// feedback.js —— 回饋管道單一真相（Mira 2026-08-27 規則：每一條使用者會看到的
// 錯誤路徑都要附上這個回饋盒）。console 小工具（logError／logWarn）恆接英文附言
// （Mira 2026-08-27 早上追加規則：console 是給開發者看的，不跟介面語系走）；
// buildFeedbackLink() 是三處回饋連結（Chat Log 表頭／設定頁／版本列）共用的
// 錨點建構式，可見文字與 aria-label 才跟介面語系走。
import { describe, it, expect, vi, afterEach } from "vitest";
import { FEEDBACK_URL, CONSOLE_FEEDBACK_SUFFIX, logError, logWarn, buildFeedbackLink } from "../js/feedback.js";
import { setLocale, t } from "../js/i18n.js";

afterEach(() => {
  vi.restoreAllMocks();
  setLocale("zh-Hant", { persist: false }); // 還原語系，不影響後面的測試（同 setup-i18n.js 慣例）
});

describe("CONSOLE_FEEDBACK_SUFFIX：恆英文，不跟介面語系走", () => {
  it("值＝空格＋「Stuck? Tell us: 」＋網址", () => {
    expect(CONSOLE_FEEDBACK_SUFFIX).toBe(" Stuck? Tell us: " + FEEDBACK_URL);
  });
});

describe("logError／logWarn：既有訊息尾巴黏上恆英文附言，其餘參數原樣轉呼叫", () => {
  it("logError 呼叫 console.error 剛好一次，第一個參數＝原訊息＋英文附言，其餘參數照傳", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("boom");
    logError("something failed:", err);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("something failed:" + CONSOLE_FEEDBACK_SUFFIX, err);
  });

  it("logWarn 呼叫 console.warn 剛好一次，第一個參數＝原訊息＋英文附言，其餘參數照傳", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("heads up:", 1, 2, 3);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("heads up:" + CONSOLE_FEEDBACK_SUFFIX, 1, 2, 3);
  });

  it("不帶額外參數也能呼叫（單一字串訊息的既有呼叫型態）", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("just a message");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("just a message" + CONSOLE_FEEDBACK_SUFFIX);
  });

  it("zh-Hant 語系下附言仍是英文（Mira 2026-08-27 早上規則：console 恆英文，不因語系改變）", () => {
    setLocale("zh-Hant", { persist: false });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("zh-Hant check:");
    expect(spy).toHaveBeenCalledWith("zh-Hant check:" + CONSOLE_FEEDBACK_SUFFIX);
  });

  it("en 語系下附言是同一個英文常數（不會因語系再翻一次）", () => {
    setLocale("en", { persist: false });
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("en check:");
    expect(spy).toHaveBeenCalledWith("en check:" + CONSOLE_FEEDBACK_SUFFIX);
  });
});

describe("buildFeedbackLink()：三處回饋連結共用的錨點建構式", () => {
  it("href／target／rel／class 固定；可見文字與 aria-label 用目前語系的 feedback.report", () => {
    const a = buildFeedbackLink();
    expect(a.tagName).toBe("A");
    expect(a.getAttribute("href")).toBe(FEEDBACK_URL);
    expect(a.getAttribute("target")).toBe("_blank");
    expect(a.getAttribute("rel")).toBe("noopener");
    expect(a.className).toBe("feedback-link");
    expect(a.textContent).toBe(t("feedback.report"));
    expect(a.getAttribute("aria-label")).toBe(t("feedback.report"));
  });

  it("換語系：已掛在文件上的連結，文字與 aria-label 都跟著重譯（tEl／tAttr 掛的 data-i18n 系列屬性，i18n.js 的 applyDom() 即時重掃）", () => {
    const a = buildFeedbackLink();
    document.body.appendChild(a);
    const zhText = a.textContent;
    const zhLabel = a.getAttribute("aria-label");
    setLocale("en", { persist: false });
    expect(a.textContent).not.toBe(zhText);
    expect(a.textContent).toBe(t("feedback.report"));
    expect(a.getAttribute("aria-label")).not.toBe(zhLabel);
    expect(a.getAttribute("aria-label")).toBe(t("feedback.report"));
    document.body.removeChild(a);
  });
});
