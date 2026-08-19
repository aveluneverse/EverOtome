import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdvPresenter } from "../js/adv.js";
import { setLocale } from "../js/i18n.js";

// AdvPresenter —— 乙女遊戲式 ADV 對話框呈現層。
// 測試面：DOM 骨架／打字機節奏（fake timers）／中斷定格完稿／thinking 態切換／
// instant 與 reduced-motion 直出／code point 安全。命名通用（characterName 由呼叫端
// 傳入，這裡用 "Sample"），零角色專屬字樣。

const TYPE_MS = 30; // 與 adv.js TYPE_INTERVAL_MS 對齊（打字機每字間隔）

function build(name = "Sample", extra = {}) {
  const container = document.createElement("div");
  const adv = new AdvPresenter({ container, characterName: name, ...extra });
  return { container, adv };
}

describe("AdvPresenter — 顯示層空行壓縮＋打字通知", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("present()：連續空行摺成單一換行（顯示層；資料層不歸它管）", () => {
    const { adv } = build();
    adv.present("第一句。\n\n\n第二句。\n\n第三句。", { instant: true });
    expect(adv.textEl.textContent).toBe("第一句。\n第二句。\n第三句。");
  });

  it("打字機起跑 fire onTypingChange(true)、打完 fire(false)；instant 不 fire", () => {
    const calls = [];
    const { adv } = build("Sample", { onTypingChange: (t) => calls.push(t) });

    adv.present("你好", { instant: true });
    expect(calls).toEqual([]); // instant 沒有打字過程

    adv.present("你好呀");
    expect(calls).toEqual([true]); // 起跑
    vi.advanceTimersByTime(TYPE_MS * 4);
    expect(calls).toEqual([true, false]); // 打完收筆
  });

  it("打字中途被 thinking() 打斷：仍收到 false（不留孤兒口型）", () => {
    const calls = [];
    const { adv } = build("Sample", { onTypingChange: (t) => calls.push(t) });
    adv.present("很長的一句話會打一陣子");
    expect(calls).toEqual([true]);
    adv.thinking("……");
    expect(calls).toEqual([true, false]);
  });

  it("onTypingChange 回呼拋錯不拖累戲台（防禦）", () => {
    const { adv } = build("Sample", { onTypingChange: () => { throw new Error("boom"); } });
    expect(() => {
      adv.present("你好");
      vi.advanceTimersByTime(TYPE_MS * 3);
    }).not.toThrow();
    expect(adv.textEl.textContent).toBe("你好");
  });
});

describe("AdvPresenter — Thinking 切換鈕", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("這輪帶思緒＝鈕亮態（has-thoughts）；點一下切思緒（斜體態）、再點切回正文", () => {
    const { adv } = build();
    adv.present("說出口的話", { instant: true, thoughts: "心裡想的事" });
    expect(adv.thinkingBtn.hidden).toBe(false);
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);

    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("心裡想的事");
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(true);
    expect(adv.thinkingBtn.getAttribute("aria-pressed")).toBe("true");

    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("說出口的話");
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(false);
  });

  it("無思緒＝鈕常駐退階態；點了切到一句淡說明、再點回正文", () => {
    const { adv } = build();
    adv.present("這輪沒有思緒", { instant: true });
    expect(adv.thinkingBtn.hidden).toBe(false); // 常駐——讓人知道有思考鏈功能
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("（這一輪他沒有留下思緒）");
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(true);
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("這輪沒有思緒");
  });

  it("locale=en 時無思緒佔位句走英文字典（i18n）", () => {
    setLocale("en", { persist: false });
    const { adv } = build();
    adv.present("Nothing on his mind this turn", { instant: true });
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("(No thoughts this turn)");
  });

  it("停在思緒頁時新句抵達：翻回正文態、鈕轉退階（新輪無思緒）", () => {
    const { adv } = build();
    adv.present("第一句", { instant: true, thoughts: "第一輪思緒" });
    adv.thinkingBtn.click(); // 停在思緒頁
    adv.present("第二句", { instant: true }); // 新輪無思緒
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(false);
    expect(adv.textEl.textContent).toBe("第二句");
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
  });

  it("打字中點鈕＝先定格完稿再切；切回時是整句", () => {
    const { adv } = build();
    adv.present("這句話還在打", { thoughts: "打字時的思緒" });
    vi.advanceTimersByTime(TYPE_MS * 2); // 打到一半
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("打字時的思緒");
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("這句話還在打"); // 定格完稿的整句
  });

  it("thinking()（新輪醞釀）把上一輪的鈕轉退階（常駐不藏）", () => {
    const { adv } = build();
    adv.present("上一句", { instant: true, thoughts: "上一輪思緒" });
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    adv.thinking("……");
    expect(adv.thinkingBtn.hidden).toBe(false);
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);
  });
});

describe("AdvPresenter — DOM 骨架", () => {
  it("建構後：.adv-box > 名牌（帶名字）＋正文（aria-live polite）＋指示點（hidden、3 顆）", () => {
    const { container, adv } = build("Sample");
    const box = container.querySelector(".adv-box");
    expect(box).toBeTruthy();
    expect(box.querySelector(".adv-nameplate").textContent).toBe("Sample");
    const text = box.querySelector(".adv-text");
    expect(text.getAttribute("aria-live")).toBe("polite");
    expect(text.getAttribute("aria-atomic")).toBe("true");
    const ind = box.querySelector(".adv-indicator");
    expect(ind.hidden).toBe(true);
    expect(ind.querySelectorAll("i").length).toBe(3);
    expect(adv.textEl.textContent).toBe("");
  });
});

describe("AdvPresenter — present 打字機", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("逐字上屏：中途是前綴、跑完是全文、計時器停（不再變動）", () => {
    const { adv } = build();
    adv.present("你回來了");
    expect(adv.textEl.textContent).toBe(""); // 第一個 tick 前是空
    vi.advanceTimersByTime(TYPE_MS * 2);
    expect(adv.textEl.textContent).toBe("你回");
    vi.advanceTimersByTime(TYPE_MS * 2);
    expect(adv.textEl.textContent).toBe("你回來了");
    vi.advanceTimersByTime(TYPE_MS * 10); // 跑完後再推進：不變、不炸
    expect(adv.textEl.textContent).toBe("你回來了");
  });

  it("打字機中途來新句：舊句不留殘影，新句從頭打", () => {
    const { adv } = build();
    adv.present("第一句話");
    vi.advanceTimersByTime(TYPE_MS * 2); // 「第一」
    adv.present("第二句");
    expect(adv.textEl.textContent).toBe(""); // 新句 tick 前清空
    vi.advanceTimersByTime(TYPE_MS * 3);
    expect(adv.textEl.textContent).toBe("第二句");
  });

  it("settle()：打字機中途定格＝直接顯示整句", () => {
    const { adv } = build();
    adv.present("完整的一句話");
    vi.advanceTimersByTime(TYPE_MS * 2);
    adv.settle();
    expect(adv.textEl.textContent).toBe("完整的一句話");
    vi.advanceTimersByTime(TYPE_MS * 10); // timer 已清：不會重播
    expect(adv.textEl.textContent).toBe("完整的一句話");
  });

  it("instant:true：跳過打字機直接全文", () => {
    const { adv } = build();
    adv.present("開場白", { instant: true });
    expect(adv.textEl.textContent).toBe("開場白");
  });

  it("present('')：清空正文、不啟動計時器", () => {
    const { adv } = build();
    adv.present("舊句", { instant: true });
    adv.present("");
    expect(adv.textEl.textContent).toBe("");
    vi.advanceTimersByTime(TYPE_MS * 5);
    expect(adv.textEl.textContent).toBe("");
  });

  it("code point 切分：emoji（surrogate pair）不被劈成半個亂碼", () => {
    const { adv } = build();
    adv.present("嗨🌹");
    vi.advanceTimersByTime(TYPE_MS); // 第 1 字
    expect(adv.textEl.textContent).toBe("嗨");
    vi.advanceTimersByTime(TYPE_MS); // 第 2 字＝完整 emoji（不是半個 surrogate）
    expect(adv.textEl.textContent).toBe("嗨🌹");
  });
});

describe("AdvPresenter — thinking 態", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("thinking()：正文清空、指示點現身、box 帶 adv-thinking、aria-label 吃協定文字", () => {
    const { adv } = build();
    adv.present("上一句", { instant: true });
    adv.thinking("思考中⋯⋯");
    expect(adv.textEl.textContent).toBe("");
    expect(adv.indicator.hidden).toBe(false);
    expect(adv.box.classList.contains("adv-thinking")).toBe(true);
    expect(adv.indicator.getAttribute("aria-label")).toBe("思考中⋯⋯");
  });

  it("thinking() 空字串：aria-label 落預設刪節號", () => {
    const { adv } = build();
    adv.thinking("");
    expect(adv.indicator.getAttribute("aria-label")).toBe("……");
  });

  it("thinking 中打字機被清：不把舊句補回來（_fullText 已重設）", () => {
    const { adv } = build();
    adv.present("打到一半的句子");
    vi.advanceTimersByTime(TYPE_MS * 2);
    adv.thinking("");
    expect(adv.textEl.textContent).toBe(""); // 舊句不因定格完稿邏輯復活
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("");
  });

  it("thinking → present：指示點收、正文開打", () => {
    const { adv } = build();
    adv.thinking("");
    adv.present("回覆來了", { instant: true });
    expect(adv.indicator.hidden).toBe(true);
    expect(adv.box.classList.contains("adv-thinking")).toBe(false);
    expect(adv.textEl.textContent).toBe("回覆來了");
  });
});

describe("AdvPresenter — setIdleNote 待機提示", () => {
  it("設定＝data-idle 上；清空＝屬性移除（CSS :empty::before 的資料來源）", () => {
    const { adv } = build();
    adv.setIdleNote("（連線中⋯⋯）");
    expect(adv.textEl.dataset.idle).toBe("（連線中⋯⋯）");
    adv.setIdleNote("");
    expect(adv.textEl.dataset.idle).toBeUndefined();
  });

  it("正文有內容時設 idle 不影響正文（:empty 不成立，purely data attr）", () => {
    const { adv } = build();
    adv.present("有話在說", { instant: true });
    adv.setIdleNote("（連線中⋯⋯）");
    expect(adv.textEl.textContent).toBe("有話在說");
  });
});

describe("AdvPresenter — reduced motion", () => {
  it("prefers-reduced-motion: reduce → present 一律直出（不啟動打字機）", () => {
    vi.useFakeTimers();
    const orig = globalThis.matchMedia;
    globalThis.matchMedia = vi.fn(() => ({ matches: true }));
    try {
      const { adv } = build();
      adv.present("整句直接出現");
      expect(adv.textEl.textContent).toBe("整句直接出現");
      vi.advanceTimersByTime(TYPE_MS * 10);
      expect(adv.textEl.textContent).toBe("整句直接出現");
    } finally {
      if (orig === undefined) delete globalThis.matchMedia;
      else globalThis.matchMedia = orig;
      vi.useRealTimers();
    }
  });
});
