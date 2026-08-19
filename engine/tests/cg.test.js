import { describe, it, expect, vi, beforeEach } from "vitest";
import { CgPresenter } from "../js/cg.js";
import { stripMarkers } from "../js/chat.js";
import { setLocale } from "../js/i18n.js";

function albumFetch(items) {
  return vi.fn(async (url) => ({
    ok: true, status: 200, json: async () => ({ items }),
  }));
}

describe("stripMarkers [cg:*]", () => {
  it("全文剝除、位置無關、絕不裸奔", () => {
    const r = stripMarkers("嗯。[cg:月夜床帳]過來。[intimate:open]");
    // 實際 join：INTIMATE_RE 先剝掉尾端 [intimate:open]（留一個空格）、CG_ANY_RE
    // 再剝掉 [cg:月夜床帳]（也留一個空格），trim 收掉尾端那個——結果句中僅一個
    // 空格分隔、無頭尾空白。
    expect(r.text).toBe("嗯。 過來。");
    expect(r.text).not.toContain("[cg:");
    expect(r.text).not.toContain("[intimate:");
    expect(r.text).toContain("過來");
  });
});

describe("CgPresenter", () => {
  let listEl, lines, p;
  beforeEach(async () => {
    document.body.innerHTML =
      '<div id="stage-root"><div id="stage-bg"></div><div id="cg-layer" hidden>' +
      '<div class="cg-img cg-img-a"></div><div class="cg-img cg-img-b"></div></div></div>';
    // body 的 class（cg-active）不隨 innerHTML 重設——上一測留下的 cg-active 會讓
    // 下一測的新 presenter 在 _hide() 早退（層已 hidden＋_currentId null）時擦不掉，
    // 斷言「門關＝無 cg-active」就依測試順序而定。這裡一併歸零，測試互不依賴順序。
    document.body.className = "";
    listEl = document.createElement("div");
    lines = [];
    p = new CgPresenter({
      endpointBase: "/api/v4/cg", listEl,
      renderLine: (name) => lines.push(name),
    });
    // 雙軌制 fixture：items 每張帶 target "desktop"|"mobile"（backend 契約，
    // 舊單張 mobile bool 鍵不再存在）。cg-1／cg-2＝desktop 組、cg-m1＝mobile 組。
    // name 兩種形狀並存（backend 契約：字串，或每語系一個的物件）——cg-1 走多語
    // 物件、cg-2／cg-m1 走字串；setup-i18n 每測前釘回 zh-Hant，既有斷言的
    // 「月夜床帳」都是 pickLabel 在 zh-Hant 下挑出來的值。
    global.fetch = albumFetch([
      { id: "cg-1", name: { "zh-Hant": "月夜床帳", en: "Moonlit Canopy" }, file: "cg-1.png", opening: true, target: "desktop" },
      { id: "cg-2", name: "窗邊", file: "cg-2.png", opening: false, target: "desktop" },
      { id: "cg-m1", name: "枕畔", file: "cg-m1.png", opening: true, target: "mobile" },
    ]);
    await p.init();
  });

  it("name 可為多語物件：場景行依當前介面語系挑（zh-Hant→月夜床帳、en→Moonlit Canopy）；字串 name 原樣", () => {
    p.applyState({ intimate: true, scene: "cg-1" });
    expect(lines).toEqual(["月夜床帳"]);
    setLocale("en", { persist: false });
    p.applyState({ intimate: true, scene: "cg-2" }); // 字串 name：語系無關、原樣輸出
    p.applyState({ intimate: true, scene: "cg-1" }); // 換張再回來＝去重放行、依 en 重挑
    expect(lines).toEqual(["月夜床帳", "窗邊", "Moonlit Canopy"]);
  });

  it("門關＝層隱藏；門開無景＝desktop 組開場景；門開有景（desktop 組內）＝該張", () => {
    p.applyState({ intimate: false, scene: null });
    expect(document.getElementById("cg-layer").hidden).toBe(true);
    expect(document.body.classList.contains("cg-active")).toBe(false);
    p.applyState({ intimate: true, scene: null });
    expect(document.getElementById("cg-layer").hidden).toBe(false);
    expect(p._currentId).toBe("cg-1");                       // desktop 組 opening
    p.applyState({ intimate: true, scene: "cg-2" });
    expect(p._currentId).toBe("cg-2");
  });

  // ── 雙軌渲染核心：scene 是雙組共用的單一狀態，屬本機組才用它 ──────────────
  it("桌機＋scene 指向 mobile 組的張＝不用它、fallback desktop 組開場景（在手機點了手機卡，桌機畫面不跟）", () => {
    p.applyState({ intimate: true, scene: "cg-m1" });
    expect(p._currentId).toBe("cg-1");                       // 不是 cg-m1
    expect(document.getElementById("cg-layer").hidden).toBe(false);
  });

  it("場景變更出場景行、重複同景不重複出", () => {
    p.applyState({ intimate: true, scene: "cg-1" });
    p.applyState({ intimate: true, scene: "cg-1" });
    p.applyState({ intimate: true, scene: "cg-2" });
    expect(lines).toEqual(["月夜床帳", "窗邊"]);
  });

  it("景被刪＝回開場景；相冊全空＝維持房間", async () => {
    p.applyState({ intimate: true, scene: "cg-nope" });
    expect(p._currentId).toBe("cg-1");                       // 渲染規則：查無＝fallback 本組開場景
    global.fetch = albumFetch([]);
    const q = new CgPresenter({ endpointBase: "/api/v4/cg", listEl, renderLine: () => {} });
    await q.init();
    q.applyState({ intimate: true, scene: null });
    // graceful 退場（走淡出）：視覺信號即時歸位（is-shown／cg-active
    // 移除、不再有顯示中的張），hidden 的最終收層由下方淡出專測覆蓋。
    expect(q._currentId).toBe(null);
    expect(document.body.classList.contains("cg-active")).toBe(false);
    document.querySelectorAll("#cg-layer .cg-img").forEach((el) => {
      expect(el.classList.contains("is-shown")).toBe(false);
    });
  });

  // ── 退場淡出（結束 intimate 狀態要淡出，取代 hard cut）────────────
  it("退場＝淡出：is-shown／cg-active 即時移除、層等 transition 播完才 hidden；淡出中重新開門＝取消收層", () => {
    vi.useFakeTimers();
    try {
      const layer = document.getElementById("cg-layer");
      p.applyState({ intimate: true, scene: "cg-1" });
      expect(layer.hidden).toBe(false);

      p.applyState({ intimate: false, scene: null });
      // 淡出中：層還留著（transition 要看得見），但視覺信號已全部歸位。
      expect(layer.hidden).toBe(false);
      expect(document.body.classList.contains("cg-active")).toBe(false);
      layer.querySelectorAll(".cg-img").forEach((el) => {
        expect(el.classList.contains("is-shown")).toBe(false);
      });
      vi.advanceTimersByTime(1200); // > CG_HIDE_FADE_MS（1100）
      expect(layer.hidden).toBe(true);

      // 淡出中重新開門＝_show() 取消收層 timer，新圖不被誤收。
      p.applyState({ intimate: true, scene: "cg-1" });
      p.applyState({ intimate: false, scene: null });
      p.applyState({ intimate: true, scene: "cg-1" });   // 淡出進行中重新進場
      vi.advanceTimersByTime(1200);
      expect(layer.hidden).toBe(false);                  // 舊 timer 已取消
      expect(p._currentId).toBe("cg-1");
    } finally {
      vi.useRealTimers();
    }
  });

  it("album 404＝init 回 false＝功能休眠", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    const q = new CgPresenter({ endpointBase: "/api/v4/cg", listEl, renderLine: () => {} });
    expect(await q.init()).toBe(false);
  });

  // ── 手機分支（雙軌制：mobile 組同一條「scene 屬本組才用」規則）───────────────
  // jsdom 原生沒有 window.matchMedia（同 adv.test.js 既有的 stub 慣例：save／
  // try-finally 還原，不留污染給下一個測試）——沒 stub 的測試全部只走得到
  // `isMobile === false` 的桌機分支，手機分支要 stub 才有覆蓋。
  it("手機＋scene 指向 mobile 組的張＝用它（在手機點手機卡的情境）", () => {
    const orig = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true }));
    try {
      p.applyState({ intimate: true, scene: "cg-m1" });
      expect(p._currentId).toBe("cg-m1");
      expect(document.getElementById("cg-layer").hidden).toBe(false);
    } finally {
      if (orig === undefined) delete window.matchMedia; else window.matchMedia = orig;
    }
  });

  it("手機＋scene 指向 desktop 組的張＝不用它、fallback mobile 組開場景", () => {
    const orig = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true }));
    try {
      // scene 明確指向 cg-1（desktop 組）——手機畫面必須落回 mobile 組開場景
      // cg-m1，不跨組硬顯示 cg-1。
      p.applyState({ intimate: true, scene: "cg-1" });
      expect(p._currentId).toBe("cg-m1");
      expect(document.getElementById("cg-layer").hidden).toBe(false);
    } finally {
      if (orig === undefined) delete window.matchMedia; else window.matchMedia = orig;
    }
  });

  it("手機＋mobile 組空＝層維持隱藏（手機維持房間），即使 desktop 組有開場景", async () => {
    const orig = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: true }));
    try {
      global.fetch = albumFetch([
        { id: "cg-3", name: "只有桌機組", file: "cg-3.png", opening: true, target: "desktop" },
      ]);
      const q = new CgPresenter({ endpointBase: "/api/v4/cg", listEl, renderLine: () => {} });
      await q.init();
      q.applyState({ intimate: true, scene: null }); // 桌機規則本來會落 opening（cg-3）
      expect(document.getElementById("cg-layer").hidden).toBe(true);
      expect(q._currentId).toBe(null);
    } finally {
      if (orig === undefined) delete window.matchMedia; else window.matchMedia = orig;
    }
  });

  it("手機判定明確為 false（非僅 matchMedia 缺席）＝桌機規則照常：scene 命中的桌機張如常顯示", () => {
    // stub 一個「會被呼叫、答案是 false」的真函式——確認 isMobile 的判準是讀
    // .matches 的值，不是只靠 typeof 有沒有這支函式；若誤判成手機分支，會落
    // mobile 組開場景（cg-m1）而非 scene 指定的 cg-1。
    const orig = window.matchMedia;
    window.matchMedia = vi.fn(() => ({ matches: false }));
    try {
      p.applyState({ intimate: true, scene: "cg-1" });
      expect(p._currentId).toBe("cg-1");
      expect(document.getElementById("cg-layer").hidden).toBe(false);
    } finally {
      if (orig === undefined) delete window.matchMedia; else window.matchMedia = orig;
    }
  });

  it("桌機組內 opening 缺席＝組內第一張頂上（_openingOf 次序：opening → 第一張）", async () => {
    global.fetch = albumFetch([
      { id: "cg-a", name: "無旗一號", file: "a.png", opening: false, target: "desktop" },
      { id: "cg-b", name: "無旗二號", file: "b.png", opening: false, target: "desktop" },
    ]);
    const q = new CgPresenter({ endpointBase: "/api/v4/cg", listEl, renderLine: () => {} });
    await q.init();
    q.applyState({ intimate: true, scene: null });
    expect(q._currentId).toBe("cg-a");
  });

  // ── reapplyLast()（race hardening）─────────────────────────────
  // app.js initCg() 沒 await：album fetch 進行中，WS 若搶先推 cg_state，
  // applyState() 當時 this.items 還是建構時的空陣列——這裡直接建一顆全新
  // presenter、不呼叫 init()，模擬「fetch 還沒回來」那個時間點。
  it("album fetch 未完成時 WS 先推 cg_state（items 仍空）→ 層維持隱藏；album 補到後 reapplyLast() 補顯示", () => {
    const q = new CgPresenter({ endpointBase: "/api/v4/cg", listEl, renderLine: () => {} });
    expect(q.items).toEqual([]); // 尚未 init()，即「fetch 還沒 resolve」那一刻

    // race：WS push 搶先抵達。
    q.applyState({ intimate: true, scene: "cg-1" });
    expect(document.getElementById("cg-layer").hidden).toBe(true);
    expect(q._currentId).toBe(null);

    // album fetch 隨後補到——直接餵 items 模擬 init() 完成後的狀態（等效於
    // 呼叫 q.init() 但不必再繞一趟假 fetch）。
    q.items = [
      { id: "cg-1", name: "月夜床帳", file: "cg-1.png", opening: true, target: "desktop" },
    ];
    q.reapplyLast();
    expect(document.getElementById("cg-layer").hidden).toBe(false);
    expect(q._currentId).toBe("cg-1");
  });

  it("reapplyLast() 在任何 applyState 之前呼叫＝安靜 no-op，不拋錯、層不受影響", () => {
    const q = new CgPresenter({ endpointBase: "/api/v4/cg", listEl, renderLine: () => {} });
    expect(() => q.reapplyLast()).not.toThrow();
    expect(document.getElementById("cg-layer").hidden).toBe(true); // 初始 markup 就是 hidden，未被動過
    expect(q._currentId).toBe(null);
  });
});
