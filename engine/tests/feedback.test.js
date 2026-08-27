// feedback.js —— 回饋管道單一真相（Mira 2026-08-27 規則：每一條使用者會看到的
// 錯誤路徑都要附上這個回饋盒）。console 小工具（logError／logWarn）把這個回饋
// 附言黏到既有訊息尾巴，呼叫端不必自己記得串接。
import { describe, it, expect, vi, afterEach } from "vitest";
import { FEEDBACK_URL, feedbackSuffix, logError, logWarn } from "../js/feedback.js";
import { setLocale, t } from "../js/i18n.js";

afterEach(() => {
  vi.restoreAllMocks();
  setLocale("zh-Hant", { persist: false }); // 還原語系，不影響後面的測試（同 setup-i18n.js 慣例）
});

describe("feedbackSuffix()：跟目前語系走的回饋附言", () => {
  it("zh-Hant：空格＋「卡住了？告訴我們：」＋網址，網址前無多餘空格", () => {
    expect(feedbackSuffix()).toBe(" " + t("feedback.stuck") + FEEDBACK_URL);
    expect(feedbackSuffix()).toBe(" 卡住了？告訴我們：" + FEEDBACK_URL);
  });

  it("en：空格＋「Stuck? Tell us: 」＋網址（字典值本身帶尾隨空格，見 locales/en.js）", () => {
    setLocale("en", { persist: false });
    expect(feedbackSuffix()).toBe(" " + t("feedback.stuck") + FEEDBACK_URL);
    expect(feedbackSuffix()).toBe(" Stuck? Tell us: " + FEEDBACK_URL);
  });
});

describe("logError／logWarn：既有訊息尾巴黏上回饋附言，其餘參數原樣轉呼叫", () => {
  it("logError 呼叫 console.error 剛好一次，第一個參數＝原訊息＋附言，其餘參數照傳", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const err = new Error("boom");
    logError("something failed:", err);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("something failed:" + feedbackSuffix(), err);
  });

  it("logWarn 呼叫 console.warn 剛好一次，第一個參數＝原訊息＋附言，其餘參數照傳", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("heads up:", 1, 2, 3);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("heads up:" + feedbackSuffix(), 1, 2, 3);
  });

  it("不帶額外參數也能呼叫（單一字串訊息的既有呼叫型態）", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
    logWarn("just a message");
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith("just a message" + feedbackSuffix());
  });
});
