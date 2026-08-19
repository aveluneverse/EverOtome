import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { initThemes } from "../js/theme.js";
import { FurnitureManager } from "../js/furniture.js";

// 房間現值同步 —— app.js 黏合層：room_state frame handler（後端推現值冪等套三
// 軌）＋switchAppearanceById（換裝共用邏輯，供面板點卡與 frame handler 共用）
// ＋reportRoom（面板操作上報後端）＋開機回讀（後端為現值來源、localStorage 為
// 斷線 fallback）。
//
// app.js 本身自執行 main()、無 export，這個專案裡沒有 app.test.js（見
// stream-partial.test.js／sandbox.test.js／thoughts-pending.test.js 檔頭說明，
// 既有慣例，已搜過 tests/ 目錄確認）。本檔比照該慣例：組一個逐行對齊 app.js
// 實作的本地 harness，餵真正的 theme.js（initThemes）／furniture.js
// （FurnitureManager）exports（真模組、非替身）——驗證「積木組起來」的行為正
// 確，而不是重新斷言 app.js 原始碼字面一致。sprite／blush／expr 三者本檔用替
// 身（真 SpritePlayer 需要 manifest fetch＋DOM canvas，那是 sprite.test.js 的
// 範圍）；本檔只驗證「換裝」這件事在 app.js 黏合層的呼叫序與冪等／回穿／
// localStorage／reportRoom 契約。app.js 實際內容另行人工核對。
//
// fixture 現值（各測試起點，除非該測試自己覆寫 config）：主題 crystal-swan
// （預設）／造型 default／家具 side-table 擺著（defaultOn:true）。

const ROOM_URL = "/api/v4/room";
const APPEARANCE_KEY = "v4.appearance";

const THEMES = [
  { id: "crystal-swan", label: "水晶天鵝" },
  { id: "crimson-nocturne", label: "緋月夜曲", vars: { line: "rgba(255,108,161,.82)" } },
];

const APPEARANCES = [
  { id: "default", label: "預設", assetsPath: "assets/sample/" },
  { id: "second-look", label: "第二套", assetsPath: "assets/sample-second/" },
];

const FURNITURE_ITEMS = [
  {
    id: "side-table", label: "邊桌", file: "assets/furniture/side-table.webp",
    left: "1.5%", height: "92dvh", bottom: "-39dvh", defaultOn: true,
  },
];

function makeStageBg() {
  const bg = document.createElement("div");
  bg.id = "stage-bg";
  document.body.appendChild(bg);
  return bg;
}

beforeEach(() => {
  document.body.innerHTML = "";
  document.body.className = "";
  localStorage.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * 逐行對齊 app.js 房間現值同步接線（見檔頭說明）。config 可覆寫
 * roomEndpoint／themeEndpoint／themes／appearances／furniture；
 * switchToImpl 可覆寫 sprite.switchTo 的行為（模擬換裝失敗用）。
 */
function buildRoomHarness(config = {}, { switchToImpl } = {}) {
  const cfg = {
    themes: THEMES,
    appearances: APPEARANCES,
    furniture: FURNITURE_ITEMS,
    roomEndpoint: ROOM_URL,
    ui: { path: "skin/ui/" },
    ...config,
  };

  const themeMgr = initThemes(cfg);
  const bg = makeStageBg();
  const furnitureMgr = new FurnitureManager(bg, cfg.furniture);

  const appearances = Array.isArray(cfg.appearances) && cfg.appearances.length
    ? cfg.appearances
    : [{ id: "default", label: "預設", assetsPath: cfg.assetsPath }];
  let savedAppearance = null;
  try { savedAppearance = localStorage.getItem(APPEARANCE_KEY); } catch (e) { /* 無痕等 */ }
  let currentAppearance = appearances.find((a) => a.id === savedAppearance) || appearances[0];

  const switchCalls = [];
  const sprite = {
    switchTo: vi.fn(async (assetsPath) => {
      switchCalls.push(assetsPath);
      if (switchToImpl) await switchToImpl(assetsPath);
    }),
    startIdle: vi.fn(),
    manifest: {},
  };
  const blush = { syncFrom: vi.fn() };
  const expr = { syncFrom: vi.fn() };

  let switching = false; // 換裝進行中不收第二單（switchTo 是 async 重載）
  const markActiveCalls = [];
  const markActive = () => { markActiveCalls.push(currentAppearance.id); };

  // ── (a) switchAppearanceById：app.js 換裝段（原點卡 click handler 內聯邏輯）
  // 抽出的共用函式，面板點卡與下方 room_state frame handler 共用同一條路。
  // 冪等 guard 比對記憶體現值 currentAppearance.id（＝這個分頁畫面上真正穿著的
  // 那套），不是跨分頁共用的 localStorage——理由見 app.js 該段註解。
  async function switchAppearanceById(id) {
    if (switching) return false;
    if (id === currentAppearance.id) return true;
    const ap = appearances.find((a) => a.id === id);
    if (!ap) return false; // 未知 id（如後端造型清單領先這台前端）＝no-op
    switching = true;
    const prev = currentAppearance;
    let ok = true;
    try {
      await sprite.switchTo(ap.assetsPath);
      sprite.startIdle();
      blush.syncFrom(sprite.manifest, ap.assetsPath);
      expr.syncFrom(sprite.manifest, ap.assetsPath);
      currentAppearance = ap;
      try { localStorage.setItem(APPEARANCE_KEY, ap.id); } catch (e) { /* 無痕等 */ }
    } catch (err) {
      ok = false;
      try {
        await sprite.switchTo(prev.assetsPath);
        sprite.startIdle();
        blush.syncFrom(sprite.manifest, prev.assetsPath);
        expr.syncFrom(sprite.manifest, prev.assetsPath);
      } catch (e2) { /* 回穿也失敗：sprite 自身降級接手，聊天不受影響 */ }
    } finally {
      switching = false;
      markActive();
    }
    return ok;
  }

  // ── (c) reportRoom：同 theme.js reportTheme 寫法（fire-and-forget）────────
  function reportRoom(partial) {
    const ep = cfg.roomEndpoint;
    if (!ep) return;
    fetch(ep, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(partial),
    }).catch(() => { /* 上報是加分項，安靜吞 */ });
  }

  // ── (b) applyRoomState：後端發起的現值套用（frame／開機回讀共用）。三軌各
  // 自獨立 try——一軌失敗不擋另外兩軌，也不擋聊天。呼叫 applyById／
  // switchAppearanceById 皆不傳報上參數＝不觸發任何 reportRoom／reportTheme
  // （防回音：後端推來的值不可以又被報回後端）。
  async function applyRoomState(f) {
    // theme 軌判準用記憶體 getter `current`（非讀 localStorage 的 currentId()）
    if (f && f.theme && themeMgr && themeMgr.current !== f.theme) {
      try { themeMgr.applyById(f.theme); } catch (e) { /* 不擋聊天 */ }
    }
    if (f && f.outfit) {
      try { await switchAppearanceById(f.outfit); } catch (e) { /* 不擋聊天 */ }
    }
    if (f && f.furniture && furnitureMgr) {
      try {
        for (const [id, on] of Object.entries(f.furniture)) furnitureMgr.setOn(id, on);
      } catch (e) { /* 不擋聊天 */ }
    }
  }

  // ── 面板點卡（outfit）：呼叫 switchAppearanceById；成功且真的換了（非冪等
  // no-op）才報。失敗（回穿）不報。
  async function clickOutfitCard(id) {
    const prevId = currentAppearance.id;
    const ok = await switchAppearanceById(id);
    if (ok && id !== prevId) reportRoom({ outfit: id });
    return ok;
  }

  // ── 面板點卡（furniture）：toggle＋報現值（多選 toggle 語意）─────────────
  function clickFurnitureCard(id) {
    furnitureMgr.toggle(id);
    reportRoom({ furniture: { [id]: furnitureMgr.isOn(id) } });
  }

  // ── 極簡 chat.onFrame 分派（只還原本案相關分支：call 家族＝輪結束對照組、
  // assistant＝輪結束對照組、room_state＝旁路不算輪結束）。武裝旗標只是測試用
  // 的最小替身，證明 room_state 分派點在 app.js 真實分派鏈裡的相對位置正確
  // （不誤觸「這輪結束」邏輯），不是重新測整條 streamArmed 狀態機（那是
  // stream-partial.test.js 的範圍）。
  let streamArmed = false;
  function onFrame(frame) {
    if (frame && frame.role === "call") { streamArmed = false; return; }
    if (frame && !frame.room && frame.role === "room_state") {
      return applyRoomState(frame); // 真實 app.js 不 await／不 return（fire-and-forget）；
      // 這裡回傳 promise 純粹是讓測試能決定性等待完成，不影響「不算輪結束」的語意本身。
    }
    if (frame && !frame.room && frame.role === "assistant") { streamArmed = false; return; }
  }

  // ── 開機回讀：後端為現值來源、localStorage 為斷線／未接後端時的天然
  // fallback（上面 initThemes／FurnitureManager／currentAppearance 三者建構時
  // 都已經先用 localStorage 現值畫過一輪）。遷移補報：後端全新
  // （v.outfit === null）時，套用完後端值後補一次性報上本機現有的 outfit／
  // furniture 現值——同 app.js 逐行對齊。
  function bootReadRoomState() {
    if (!cfg.roomEndpoint) return Promise.resolve();
    return fetch(cfg.roomEndpoint, { credentials: "same-origin" })
      .then((r) => (r.ok ? r.json() : null))
      .then(async (v) => {
        if (!v) return;
        await applyRoomState({ ...v, role: "room_state" });
        if (v.outfit === null) {
          reportRoom({ outfit: currentAppearance.id, furniture: furnitureMgr.snapshot() });
        }
      })
      .catch(() => { /* 斷網／未接後端：畫面維持 localStorage 現狀 */ });
  }

  return {
    themeMgr, furnitureMgr, sprite, blush, expr, switchCalls, markActiveCalls,
    switchAppearanceById, reportRoom, applyRoomState, onFrame, bootReadRoomState,
    clickOutfitCard, clickFurnitureCard,
    arm: () => { streamArmed = true; },
    isArmed: () => streamArmed,
    getCurrentAppearanceId: () => currentAppearance.id,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// room_state frame 冪等套三軌
// ─────────────────────────────────────────────────────────────────────────────
describe("applyRoomState — room_state frame 冪等套三軌", () => {
  it("room_state frame（經 onFrame 分派）套用 theme／outfit／furniture 三軌；同 frame 再套一次＝零動作", async () => {
    const h = buildRoomHarness();
    // fixture：初始 crystal-swan／default／side-table on
    expect(h.themeMgr.currentId()).toBe("crystal-swan");
    expect(h.furnitureMgr.isOn("side-table")).toBe(true);

    const frame = {
      role: "room_state", theme: "crimson-nocturne",
      outfit: "second-look", furniture: { "side-table": false },
    };
    await h.onFrame(frame);

    expect(h.themeMgr.currentId()).toBe("crimson-nocturne");
    expect(localStorage.getItem("v4.appearance")).toBe("second-look");
    expect(h.furnitureMgr.isOn("side-table")).toBe(false);
    expect(h.switchCalls.length).toBe(1);

    // 同 frame 再來一次＝零動作（switchTo spy 不再被呼叫）
    await h.onFrame(frame);
    expect(h.switchCalls.length).toBe(1);
  });

  it("frame.room 有值（非本房目標）＝整包略過，不套用（同 cg_state 等既有分支判準）", async () => {
    const h = buildRoomHarness();
    await h.onFrame({ role: "room_state", room: "other-target", theme: "crimson-nocturne" });
    expect(h.themeMgr.currentId()).toBe("crystal-swan");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// chat.onFrame 分派：room_state 是旁路，不算「這輪結束」（同 cg_state 慣例）
// ─────────────────────────────────────────────────────────────────────────────
describe("chat.onFrame 分派 — room_state 旁路（不算輪結束）", () => {
  it("room_state 到達不解除武裝（同 cg_state 旁路慣例）", async () => {
    const h = buildRoomHarness();
    h.arm();
    await h.onFrame({ role: "room_state", theme: "crimson-nocturne" });
    expect(h.isArmed()).toBe(true);
  });

  it("對照組：assistant／call 家族仍正常解除武裝（證明分派本身正常運作，不是誤判 pass）", () => {
    const h = buildRoomHarness();
    h.arm();
    h.onFrame({ role: "assistant", text: "在。" });
    expect(h.isArmed()).toBe(false);

    h.arm();
    h.onFrame({ role: "call" });
    expect(h.isArmed()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// switchAppearanceById — 換裝共用邏輯本身（面板點卡／frame handler 共用一份）
// ─────────────────────────────────────────────────────────────────────────────
describe("switchAppearanceById — 換裝共用邏輯", () => {
  it("換到新造型成功：switchTo／startIdle／blush.syncFrom／expr.syncFrom 依序呼叫、localStorage 寫入、markActive 呼叫、回傳 true", async () => {
    const h = buildRoomHarness();
    const ok = await h.switchAppearanceById("second-look");
    expect(ok).toBe(true);
    expect(h.switchCalls).toEqual(["assets/sample-second/"]);
    expect(h.sprite.startIdle).toHaveBeenCalled();
    expect(h.blush.syncFrom).toHaveBeenCalled();
    expect(h.expr.syncFrom).toHaveBeenCalled();
    expect(localStorage.getItem("v4.appearance")).toBe("second-look");
    expect(h.getCurrentAppearanceId()).toBe("second-look");
    expect(h.markActiveCalls.length).toBe(1);
  });

  it("換裝失敗：回穿上一套、localStorage 不寫入新 id、回傳 false", async () => {
    const h = buildRoomHarness({}, {
      switchToImpl: (path) => { if (path.includes("second")) throw new Error("network down"); },
    });
    const ok = await h.switchAppearanceById("second-look");
    expect(ok).toBe(false);
    expect(localStorage.getItem("v4.appearance")).not.toBe("second-look");
    expect(h.getCurrentAppearanceId()).toBe("default");
    expect(h.switchCalls).toEqual([
      "assets/sample-second/", // 嘗試換新（失敗）
      "assets/sample/",        // 回穿（成功）
    ]);
  });

  it("回穿也失敗：不拋錯（sprite 自身降級接手接住），回傳 false，finally 仍執行", async () => {
    const h = buildRoomHarness({}, {
      switchToImpl: () => { throw new Error("always fails"); },
    });
    await expect(h.switchAppearanceById("second-look")).resolves.toBe(false);
    expect(h.markActiveCalls.length).toBe(1);
  });

  it("switching 防重入：mid-flight 二次呼叫立即回 false，不重疊 switchTo", async () => {
    let resolveSwitch;
    const h = buildRoomHarness({}, {
      switchToImpl: () => new Promise((res) => { resolveSwitch = res; }),
    });
    const p1 = h.switchAppearanceById("second-look");
    const p2 = h.switchAppearanceById("default"); // 換裝進行中（switching 已同步設為 true），二次呼叫立即短路
    expect(await p2).toBe(false);
    expect(h.switchCalls).toEqual(["assets/sample-second/"]); // 只有第一次真的呼叫 switchTo
    resolveSwitch();
    expect(await p1).toBe(true);
  });

  it("未知 id：no-op 回 false，不動 currentAppearance／不呼叫 switchTo", async () => {
    const h = buildRoomHarness();
    const ok = await h.switchAppearanceById("future-outfit-not-yet-shipped");
    expect(ok).toBe(false);
    expect(h.switchCalls).toEqual([]);
    expect(h.getCurrentAppearanceId()).toBe("default");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 面板點卡（換裝）→ reportRoom
// ─────────────────────────────────────────────────────────────────────────────
describe("面板點卡 — 換裝成功後 reportRoom", () => {
  it("換到新造型成功 → POST roomEndpoint {outfit:id}", async () => {
    const h = buildRoomHarness();
    const calls = [];
    vi.stubGlobal("fetch", (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true });
    });
    const ok = await h.clickOutfitCard("second-look");
    expect(ok).toBe(true);
    expect(calls.length).toBe(1);
    expect(calls[0].url).toBe(ROOM_URL);
    expect(calls[0].opts.method).toBe("POST");
    expect(JSON.parse(calls[0].opts.body)).toEqual({ outfit: "second-look" });
  });

  it("點同一張已使用中的卡（冪等 no-op）→ 不呼叫 reportRoom", async () => {
    const h = buildRoomHarness();
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    const ok = await h.clickOutfitCard("default"); // 本來就是使用中的那套
    expect(ok).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("換裝失敗（回穿）→ 不呼叫 reportRoom", async () => {
    const h = buildRoomHarness({}, {
      switchToImpl: (path) => { if (path.includes("second")) throw new Error("down"); },
    });
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    const ok = await h.clickOutfitCard("second-look");
    expect(ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 面板家具 toggle — reportRoom 現值
// ─────────────────────────────────────────────────────────────────────────────
describe("面板家具 toggle — reportRoom 現值", () => {
  it("放置／收起成功 → POST roomEndpoint {furniture:{id:bool}} 帶切換後的現值", () => {
    const h = buildRoomHarness();
    const calls = [];
    vi.stubGlobal("fetch", (url, opts) => {
      calls.push({ url, opts });
      return Promise.resolve({ ok: true });
    });
    h.clickFurnitureCard("side-table"); // on(true) → off(false)
    expect(calls[0].url).toBe(ROOM_URL);
    expect(JSON.parse(calls[0].opts.body)).toEqual({ furniture: { "side-table": false } });

    h.clickFurnitureCard("side-table"); // off → on
    expect(JSON.parse(calls[1].opts.body)).toEqual({ furniture: { "side-table": true } });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// reportRoom — fire-and-forget（同 theme.js reportTheme 寫法）
// ─────────────────────────────────────────────────────────────────────────────
describe("reportRoom — fire-and-forget", () => {
  it("config 無 roomEndpoint → no-op，fetch 未被呼叫（預設殼零成本）", () => {
    const h = buildRoomHarness({ roomEndpoint: undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    h.reportRoom({ outfit: "second-look" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fetch reject（斷網／後端未接）→ 不拋錯，換裝本身已經成功、回報只是加分項", () => {
    const h = buildRoomHarness();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    expect(() => h.reportRoom({ outfit: "second-look" })).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 開機回讀 — bootReadRoomState
// ─────────────────────────────────────────────────────────────────────────────
describe("開機回讀 — bootReadRoomState", () => {
  it("roomEndpoint 有值＋GET 成功 → 三軌套用（後端值優先）", async () => {
    const h = buildRoomHarness();
    vi.stubGlobal("fetch", vi.fn(async (url) => {
      expect(url).toBe(ROOM_URL);
      return {
        ok: true,
        json: async () => ({ theme: "crimson-nocturne", outfit: "second-look", furniture: { "side-table": false } }),
      };
    }));
    await h.bootReadRoomState();
    expect(h.themeMgr.currentId()).toBe("crimson-nocturne");
    expect(localStorage.getItem("v4.appearance")).toBe("second-look");
    expect(h.furnitureMgr.isOn("side-table")).toBe(false);
  });

  it("roomEndpoint 缺席 → 零 fetch 呼叫（預設殼零成本）", async () => {
    const h = buildRoomHarness({ roomEndpoint: undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await h.bootReadRoomState();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("GET 404（後端未提供此端點）→ 安靜略過，不套用、不拋錯", async () => {
    const h = buildRoomHarness();
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404 })));
    await expect(h.bootReadRoomState()).resolves.toBeUndefined();
    expect(h.themeMgr.currentId()).toBe("crystal-swan"); // 未被改動，維持 localStorage 現狀
  });

  it("GET 網路錯誤 → 安靜略過，不拋錯", async () => {
    const h = buildRoomHarness();
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch"); }));
    await expect(h.bootReadRoomState()).resolves.toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 開機回讀 — 遷移補報：後端全新（outfit 從沒被任何裝置報過，v.outfit === null）
// ＝套用完後端值後補一次性報上本機現有的 outfit／furniture 現值；否則後端側
// 「現在穿著 X」這類敘述會一直卡空值、要等下次手動點卡才補上。POST 端
// （reportRoom）不推 frame＝不會形成回音。
// ─────────────────────────────────────────────────────────────────────────────
describe("開機回讀 — 遷移補報（v.outfit === null）", () => {
  // fetch mock 靠 opts.method 分流：GET（boot 本體，opts 只有 credentials 無
  // method）回後端 json；POST（reportRoom）記錄進 calls、回 {ok:true}。
  function stubFetchGetThenCapturePost(calls, getJson) {
    vi.stubGlobal("fetch", vi.fn(async (url, opts) => {
      if (opts && opts.method === "POST") {
        calls.push({ url, opts });
        return { ok: true };
      }
      return { ok: true, json: async () => getJson };
    }));
  }

  it("GET 回 outfit: null → 恰一發 reportRoom，body 含本機現值 outfit＋furniture snapshot", async () => {
    const h = buildRoomHarness();
    const calls = [];
    stubFetchGetThenCapturePost(calls, {
      theme: "crystal-swan", outfit: null, furniture: { "side-table": true },
    });
    await h.bootReadRoomState();

    expect(calls.length).toBe(1); // 恰一發，不多不少
    expect(calls[0].url).toBe(ROOM_URL);
    expect(calls[0].opts.method).toBe("POST");
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      outfit: "default", // fixture 起點：本機現值
      furniture: { "side-table": true }, // furnitureMgr.snapshot()
    });
  });

  it("GET 回 outfit 非 null（後端已有值）→ 零遷移報", async () => {
    const h = buildRoomHarness();
    const calls = [];
    stubFetchGetThenCapturePost(calls, {
      theme: "crystal-swan", outfit: "second-look", furniture: { "side-table": true },
    });
    await h.bootReadRoomState();
    expect(calls.length).toBe(0);
  });

  it("GET 回應 outfit 鍵缺席（undefined，非 null）→ 同樣零遷移報（嚴格 === null 判準，不誤觸未定義值）", async () => {
    const h = buildRoomHarness();
    const calls = [];
    stubFetchGetThenCapturePost(calls, { theme: "crystal-swan", furniture: { "side-table": true } });
    await h.bootReadRoomState();
    expect(calls.length).toBe(0);
  });

  it("遷移報帶的是「套用後端值之後」的現值，不是套用前", async () => {
    const h = buildRoomHarness();
    const calls = [];
    stubFetchGetThenCapturePost(calls, {
      theme: "crystal-swan", outfit: null, furniture: { "side-table": false }, // 後端家具值與本機預設（true）不同
    });
    await h.bootReadRoomState();
    expect(h.furnitureMgr.isOn("side-table")).toBe(false); // 後端值已套用
    expect(JSON.parse(calls[0].opts.body)).toEqual({
      outfit: "default",
      furniture: { "side-table": false }, // 補報帶的是套用後現值
    });
  });

  it("config 無 roomEndpoint → 整段 bootReadRoomState no-op，連遷移報也不會發生", async () => {
    const h = buildRoomHarness({ roomEndpoint: undefined });
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    await h.bootReadRoomState();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// applyRoomState — 三軌各自冪等判準、防回音、各軌獨立 try
// ─────────────────────────────────────────────────────────────────────────────
describe("applyRoomState — 冪等判準與防回音", () => {
  it("theme 現值＝目標 → 跳過 applyById（記憶體現值判準，不是每次無條件呼叫）", async () => {
    const h = buildRoomHarness();
    const spy = vi.spyOn(h.themeMgr, "applyById");
    await h.applyRoomState({ theme: "crystal-swan" }); // 本來就是 crystal-swan
    expect(spy).not.toHaveBeenCalled();
  });

  it("outfit 現值＝目標（記憶體現值判準）→ 跳過 sprite.switchTo", async () => {
    const h = buildRoomHarness();
    await h.applyRoomState({ outfit: "default" }); // 本來就是 default
    expect(h.switchCalls).toEqual([]);
  });

  it("furniture 現值＝目標 → setOn 內建冪等，不動 DOM／不留 localStorage 寫入痕跡", async () => {
    const h = buildRoomHarness();
    const toggleSpy = vi.spyOn(h.furnitureMgr, "toggle");
    await h.applyRoomState({ furniture: { "side-table": true } }); // 本來就是 true（defaultOn）
    expect(toggleSpy).not.toHaveBeenCalled();
    expect(localStorage.getItem("v4.furniture")).toBeNull();
  });

  it("防回音：三軌套用皆不觸發任何 fetch（themeEndpoint／roomEndpoint 皆零呼叫）", async () => {
    const h = buildRoomHarness({ themeEndpoint: "/api/v4/theme" });
    const fetchSpy = vi.fn(() => Promise.resolve({ ok: true }));
    vi.stubGlobal("fetch", fetchSpy);
    await h.applyRoomState({
      theme: "crimson-nocturne", outfit: "second-look", furniture: { "side-table": false },
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("theme 軌拋錯不擋 outfit／furniture 軌（各軌獨立 try，換裝失敗不擋聊天）", async () => {
    const h = buildRoomHarness();
    vi.spyOn(h.themeMgr, "applyById").mockImplementation(() => { throw new Error("boom"); });
    await expect(h.applyRoomState({
      theme: "crimson-nocturne", outfit: "second-look", furniture: { "side-table": false },
    })).resolves.toBeUndefined();
    expect(localStorage.getItem("v4.appearance")).toBe("second-look"); // outfit 軌沒被擋
    expect(h.furnitureMgr.isOn("side-table")).toBe(false);             // furniture 軌沒被擋
  });

  it("furniture 軌拋錯不擋整體 resolve；theme／outfit 已套用的不受影響", async () => {
    const h = buildRoomHarness();
    vi.spyOn(h.furnitureMgr, "setOn").mockImplementation(() => { throw new Error("boom"); });
    await expect(h.applyRoomState({
      theme: "crimson-nocturne", outfit: "second-look", furniture: { "side-table": false },
    })).resolves.toBeUndefined();
    expect(h.themeMgr.currentId()).toBe("crimson-nocturne");
    expect(localStorage.getItem("v4.appearance")).toBe("second-look");
  });

  it("outfit 為未知 id（後端造型清單領先前端）＝該軌安全 no-op，不擋其他軌", async () => {
    const h = buildRoomHarness();
    await h.applyRoomState({
      theme: "crimson-nocturne", outfit: "future-outfit-not-yet-shipped", furniture: { "side-table": false },
    });
    expect(h.themeMgr.currentId()).toBe("crimson-nocturne");
    expect(h.furnitureMgr.isOn("side-table")).toBe(false);
    expect(h.getCurrentAppearanceId()).toBe("default"); // 未知 id 不動現狀
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 跨分頁回歸：冪等 guard 必須比「這個分頁記憶體裡的現值」，不是 localStorage
// ─────────────────────────────────────────────────────────────────────────────
// localStorage 是同一瀏覽器所有分頁共用的一格。A 分頁換了主題／造型會把新 id
// 寫進去；此時後端廣播 room_state，B 分頁若拿 localStorage 當自己的現值判準，
// 會讀到 A 剛寫好的新值、判成「已經是目標值」而提早 return，畫面停在舊的樣子
// 直到重整。以下兩則就是把「B 分頁」那一刻的狀態擺出來：記憶體現值＝舊、
// localStorage＝新，套用必須照樣發生。
describe("跨分頁冪等 guard（localStorage 已被另一分頁寫成目標值）", () => {
  it("theme：記憶體現值仍是舊主題、v4.theme 已被寫成目標 → room_state 照樣套用", async () => {
    const h = buildRoomHarness(); // 首開無 saved＝記憶體現值 crystal-swan
    expect(h.themeMgr.current).toBe("crystal-swan");
    localStorage.setItem("v4.theme", "crimson-nocturne"); // 另一分頁換色留下的痕跡
    await h.applyRoomState({ theme: "crimson-nocturne" });
    expect(h.themeMgr.current).toBe("crimson-nocturne");
    expect(document.body.dataset.theme).toBe("crimson-nocturne"); // 畫面真的換了
  });

  it("outfit：記憶體現值仍是舊造型、v4.appearance 已被寫成目標 → room_state 照樣換裝", async () => {
    const h = buildRoomHarness(); // 首開無 saved＝記憶體現值 default
    expect(h.getCurrentAppearanceId()).toBe("default");
    localStorage.setItem("v4.appearance", "second-look"); // 另一分頁換裝留下的痕跡
    await h.applyRoomState({ outfit: "second-look" });
    expect(h.switchCalls).toEqual(["assets/sample-second/"]); // 立繪真的重載了
    expect(h.getCurrentAppearanceId()).toBe("second-look");
  });
});
