// cg-panel.test.js — CG 相冊彈窗（視圖態）。
// 實作裁量落點：面板建構函式 `buildCgPanel` 放 `cg.js`（非 app.js）——
// app.js 內建的舊格局（appearance 面板）不易單測，新面板抽成獨立可測函式，
// app.js 只接線。
import { describe, it, expect, beforeEach, vi } from "vitest";
import { buildCgPanel } from "../js/cg.js";
import { setLocale } from "../js/i18n.js";

describe("CG 相冊彈窗（視圖態）", () => {
  let presenter, sent;

  beforeEach(() => {
    document.body.innerHTML = '<div id="cg-root"></div><div id="msgs"></div>';
    sent = [];
    // 雙軌制 fixture：items 每張帶 target（backend /album 契約）。jsdom 無
    // matchMedia＝renderView 走桌機分支＝列 desktop 組——本檔既有測試全部以
    // 桌機視圖為前提；手機視圖的 filter 專測在檔尾（stub matchMedia）。
    presenter = {
      items: [
        { id: "cg-1", name: "月夜床帳", file: "a.png", opening: true, target: "desktop" },
        { id: "cg-2", name: "窗邊", file: "b.png", opening: false, target: "desktop" },
      ],
      fileUrl: (id) => `/api/v4/cg/file/${id}`,
      isActive: () => false,
      _currentId: null,
    };
  });

  // send() 回傳值明白模擬 ChatClient.send() 的既有布林契約（早期版本
  // 這裡用 `sent.push(t)` 當 send 實作——array push 剛好回傳新長度（恆
  // 真值），會讓「點卡關面板」的斷言不小心矇對，掩蓋了 buildCgPanel 當初沒
  // 檢查回傳值就關面板的漏洞。改成明講 `sendResult`，成功／失敗兩條路徑都
  // 是有意為之，不再依賴 Array.prototype.push 的巧合回傳值。
  function build(sendResult = true) {
    return buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: (t) => { sent.push(t); return sendResult; },
    });
  }

  it("卡片＝縮圖＋場景名；點卡送 /cg <id>＋關面板；DOM 全程無 desc", () => {
    const panel = build();
    panel.open();
    const cards = document.querySelectorAll(".cg-card");
    expect(cards.length).toBe(2);
    expect(cards[0].textContent).toContain("月夜床帳");
    // 縮圖＝presenter.fileUrl(id)，不是面板自己兜網址（單一真相在 presenter）。
    expect(cards[0].querySelector(".cg-thumb").style.backgroundImage)
      .toContain("/api/v4/cg/file/cg-1");
    expect(document.getElementById("cg-root").textContent).not.toContain("desc");
    cards[1].click();
    expect(sent).toEqual(["/cg cg-2"]);
    expect(panel.el.hidden).toBe(true);        // 點卡即關（他要開演了）
    panel.open();
    panel.el.click();                           // 點暗幕即關（面板不設關閉叉叉）
    expect(panel.el.hidden).toBe(true);
  });

  it("locale=en 時面板標題走英文字典（i18n）", () => {
    setLocale("en", { persist: false });
    const panel = build();
    panel.open();
    expect(document.querySelector(".settings-heading").textContent).toBe("CG album");
  });

  it("卡名可為多語物件：.cg-card-name 依當前介面語系顯示（zh-Hant／en）；字串卡名原樣", () => {
    // backend 契約：name 是字串，或每語系一個的物件（同 config 主題／造型／家具
    // label 的既有做法）；殼用 pickLabel 依當前語系挑，換語系後重開面板即重繪。
    presenter.items = [
      { id: "cg-1", name: { "zh-Hant": "月夜床帳", en: "Moonlit Canopy" }, file: "a.png", opening: true, target: "desktop" },
      { id: "cg-2", name: "窗邊", file: "b.png", opening: false, target: "desktop" },
    ];
    const panel = build();
    panel.open();
    const namesOf = () => Array.from(document.querySelectorAll(".cg-card-name")).map((n) => n.textContent);
    expect(namesOf()).toEqual(["月夜床帳", "窗邊"]);
    setLocale("en", { persist: false });
    panel.open(); // open() 每次以當下語系重繪
    expect(namesOf()).toEqual(["Moonlit Canopy", "窗邊"]);
  });

  // ── 換語系即時重繪（onLocaleChange）：只在面板可見且處於視圖態時 renderView ──
  it("視圖態面板開著時切語系＝卡名即時換（不必重新 open）；來回切都跟", () => {
    presenter.items = [
      { id: "cg-1", name: { "zh-Hant": "月夜床帳", en: "Moonlit Canopy" }, file: "a.png", opening: true, target: "desktop" },
      { id: "cg-2", name: "窗邊", file: "b.png", opening: false, target: "desktop" },
    ];
    const panel = build();
    panel.open();
    const namesOf = () => Array.from(document.querySelectorAll(".cg-card-name")).map((n) => n.textContent);
    expect(namesOf()).toEqual(["月夜床帳", "窗邊"]);
    setLocale("en", { persist: false });
    expect(namesOf()).toEqual(["Moonlit Canopy", "窗邊"]);
    setLocale("zh-Hant", { persist: false });
    expect(namesOf()).toEqual(["月夜床帳", "窗邊"]);
  });

  it("面板關著時切語系不重繪（節點不動）；下次 open() 才以當下語系重繪", () => {
    presenter.items = [
      { id: "cg-1", name: { "zh-Hant": "月夜床帳", en: "Moonlit Canopy" }, file: "a.png", opening: true, target: "desktop" },
    ];
    const panel = build();
    panel.open();
    const cardBefore = document.querySelector(".cg-card");
    panel.el.click(); // 點暗幕關
    setLocale("en", { persist: false });
    expect(document.querySelector(".cg-card")).toBe(cardBefore); // 隱藏中沒重繪＝同一顆節點
    expect(cardBefore.querySelector(".cg-card-name").textContent).toBe("月夜床帳");
    panel.open();
    expect(document.querySelector(".cg-card-name").textContent).toBe("Moonlit Canopy");
  });

  it("管理態下切語系＝不重繪、輸入框值不變（不丟使用者打到一半的字）", async () => {
    global.fetch = vi.fn(async (url, opts = {}) => {
      if ((opts.method || "GET").toUpperCase() === "GET" && String(url).endsWith("/manage")) {
        return { ok: true, status: 200, json: async () => ({ items: [
          { id: "cg-1", name: { "zh-Hant": "月夜床帳", en: "Moonlit Canopy" }, desc: { "zh-Hant": "害羞鑰匙", en: "A shy key" }, file: "a.png", opening: true, target: "desktop", order: 0 },
        ] }) };
      }
      return { ok: false, status: 404 };
    });
    presenter.init = vi.fn(async () => true);
    const panel = buildCgPanel(document.getElementById("cg-root"), presenter, {
      send: () => true, endpointBase: "/api/v4/cg",
    });
    panel.open();
    await panel.enterManage();
    const nameInput = document.querySelector(".cg-manage-name");
    expect(nameInput.value).toBe("月夜床帳");
    nameInput.value = "打到一半";
    setLocale("en", { persist: false });
    expect(document.querySelector(".cg-manage-name")).toBe(nameInput); // 同一顆節點＝沒重繪
    expect(nameInput.value).toBe("打到一半");
  });

  it("點暗幕以外任何 sheet 內元素不誤關（只認 e.target === el）", () => {
    const panel = build();
    panel.open();
    document.querySelector(".cg-sheet").click();
    expect(panel.el.hidden).toBe(false);
  });

  it("當前景 is-active 標記跟著 presenter._currentId 走，每次 open() 重新計算", () => {
    presenter._currentId = "cg-2";
    const panel = build();
    panel.open();
    let cards = document.querySelectorAll(".cg-card");
    expect(cards[0].classList.contains("is-active")).toBe(false);
    expect(cards[1].classList.contains("is-active")).toBe(true);

    // 面板閉著時場景換了（server 推新 cg_state）——下次 open() 必須看到新的
    // active，不是建構當下那份舊快照。
    presenter._currentId = "cg-1";
    panel.open();
    cards = document.querySelectorAll(".cg-card");
    expect(cards[0].classList.contains("is-active")).toBe(true);
    expect(cards[1].classList.contains("is-active")).toBe(false);
  });

  it("open() 每次重讀 presenter.items——面板閉著時項目變動，下次開能反映", () => {
    const panel = build();
    panel.open();
    expect(document.querySelectorAll(".cg-card").length).toBe(2);
    panel.el.click(); // 點暗幕關

    presenter.items = presenter.items.concat([
      { id: "cg-3", name: "新場景", file: "c.png", opening: false, target: "desktop" },
    ]);
    panel.open();
    const cards = document.querySelectorAll(".cg-card");
    expect(cards.length).toBe(3);
    expect(cards[2].textContent).toContain("新場景");
  });

  // ── 誠實關面板（send() 回傳值不可忽略）────────────────
  // ChatClient.send() 在 WS 未開時同步回 false（chat.js ~99-106）；點卡當下
  // 若剛好在斷線／重連中，面板不能裝作已經送出去而關掉——同 app.js 文字
  // 送出（~1241）／傳照片送出（~1315）既有的 `if (!sent)` 誠實模式。

  it("send() 回 true——面板真的送出去了才關，不留提示", () => {
    const panel = build(true);
    panel.open();
    const cards = document.querySelectorAll(".cg-card");
    cards[0].click();
    expect(sent).toEqual(["/cg cg-1"]);
    expect(panel.el.hidden).toBe(true);
    const hint = document.querySelector(".cg-send-hint");
    expect(hint.textContent).toBe("");
  });

  it("send() 回 false（WS 斷線／重連中）——面板不關、顯示誠實提示", () => {
    const panel = build(false);
    panel.open();
    const cards = document.querySelectorAll(".cg-card");
    cards[0].click();
    // 真的呼叫了 send（不是靜默吞掉點擊）——只是它誠實回報沒送出去。
    expect(sent).toEqual(["/cg cg-1"]);
    expect(panel.el.hidden).toBe(false); // 沒送出＝場景沒換，面板不能騙人已經開演
    const hint = document.querySelector(".cg-send-hint");
    expect(hint.textContent).toContain("連線中");
  });

  it("提示在下一次點卡時立即清掉（不論那次點擊成功或失敗），不疊字", () => {
    const panel = build(false);
    panel.open();
    const cards = document.querySelectorAll(".cg-card");
    cards[0].click();
    const hint = document.querySelector(".cg-send-hint");
    expect(hint.textContent).toContain("連線中");

    cards[1].click(); // 第二次點擊（仍然失敗）——不該疊出兩句提示
    expect(hint.textContent).toContain("連線中");
    expect(hint.textContent.match(/連線中/g).length).toBe(1);
  });

  it("提示約 2.5 秒後自動清除（無需再點擊）", () => {
    vi.useFakeTimers();
    try {
      const panel = build(false);
      panel.open();
      document.querySelectorAll(".cg-card")[0].click();
      const hint = document.querySelector(".cg-send-hint");
      expect(hint.textContent).toContain("連線中");
      vi.advanceTimersByTime(2500);
      expect(hint.textContent).toBe("");
    } finally {
      vi.useRealTimers();
    }
  });

  it("重新 open() 會清掉上次殘留的提示（關面板時沒等到自動清）", () => {
    const panel = build(false);
    panel.open();
    document.querySelectorAll(".cg-card")[0].click();
    expect(document.querySelector(".cg-send-hint").textContent).toContain("連線中");

    panel.el.click(); // 點暗幕關——提示還留在 DOM 裡（面板只是 hidden，沒被清掉）
    panel.open();
    expect(document.querySelector(".cg-send-hint").textContent).toBe("");
  });

  // ── 視圖態 per-device filter（雙軌制）─────────────────────────────────────────
  // 跨裝置點對方組的卡＝scene 指向對方組＝本機畫面 fallback 開場景（點了沒反應
  // 的怪行為）——視圖態只列當前裝置組天然正確；跨組瀏覽走管理態 TAB。
  it("桌機視圖只列 desktop 組——mobile 組的卡不出現（jsdom 無 matchMedia＝桌機分支）", () => {
    presenter.items = presenter.items.concat([
      { id: "cg-m1", name: "枕畔", file: "m1.png", opening: true, target: "mobile" },
    ]);
    const panel = build();
    panel.open();
    const cards = document.querySelectorAll(".cg-card");
    expect(cards.length).toBe(2); // 只有兩張 desktop
    expect(document.getElementById("cg-root").textContent).not.toContain("枕畔");
  });

  it("手機視圖只列 mobile 組（stub matchMedia matches:true，同 cg.test.js 慣例）", () => {
    const orig = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true }));
    try {
      presenter.items = presenter.items.concat([
        { id: "cg-m1", name: "枕畔", file: "m1.png", opening: true, target: "mobile" },
      ]);
      const panel = build();
      panel.open();
      const cards = document.querySelectorAll(".cg-card");
      expect(cards.length).toBe(1);
      expect(cards[0].textContent).toContain("枕畔");
      expect(document.getElementById("cg-root").textContent).not.toContain("月夜床帳");
    } finally {
      if (orig === undefined) delete window.matchMedia; else window.matchMedia = orig;
    }
  });
});
