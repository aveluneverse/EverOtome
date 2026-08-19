import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { AdvPresenter } from "../js/adv.js";
import { renderFrame, upsertPartialBubble, clearPartialBubble, stripMarkers } from "../js/chat.js";

// 邊寫邊送 —— 前端消化後端送出的
// `{"role":"partial","text":"<累積全文>"}` WS frame（旗標開時，回覆生成過程中先送
// 到目前為止的累積全文，不是逐字 delta；final frame 到達時整輪結束）。
//
// 本檔涵蓋三層：
//   ① AdvPresenter.present 的 opts.resume（adv.js）——從斷點續打，不重頭、不閃跳。
//   ② upsertPartialBubble／clearPartialBubble（chat.js）——Chat Log 半成品泡泡。
//   ③ app.js chat.onFrame 的分派線——partial→ADV resume＋泡泡 upsert；任何一輪
//     結束 frame（assistant/system/call 家族）→ 清泡泡＋解除武裝；「武裝／解除武裝」
//     guard 防漏網的遲到 partial（race window）誤創建泡泡／誤動 ADV。
//   ④ app.js chat.onStatusChange 離開 "open" 那半
//     邏輯——WS 斷線／重連中／錯誤中途，比照 assistant final frame 分支同款收尾：
//     清半成品泡泡＋解除武裝，不讓斷線期間半寫一半的話孤兒留在畫面上。
//
// app.js 本身自執行 main()、無 export，這個專案裡沒有 app.test.js（既有
// 慣例——搜過 tests/ 目錄確認）。第③④層測試因此不 import app.js，
// 改用跟 app.js 完全相同的分派邏輯（照本檔實作時的 app.js chat.onFrame／
// chat.onStatusChange 逐行對齊）組一個本地 harness，餵真正的 adv.js／chat.js
// exports——驗證「積木組起來」的行為正確，而不是重新斷言 app.js 原始碼字面
// 一致。app.js 實際內容已另行人工核對過。

const TYPE_MS = 30; // 與 adv.js TYPE_INTERVAL_MS 對齊（打字機每字間隔）
const ctx = { characterName: "Sample", assetsBase: "assets/sample/" };

function buildAdv(extra = {}) {
  const container = document.createElement("div");
  const adv = new AdvPresenter({ container, characterName: "Sample", ...extra });
  return { container, adv };
}

// ─────────────────────────────────────────────────────────────────────────────
// ① AdvPresenter.present — opts.resume
// ─────────────────────────────────────────────────────────────────────────────
describe("AdvPresenter.present — opts.resume（邊寫邊送：partial 累積續打）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("已顯完的前綴 ＋ resume:true → 不清空、從尾續打（不重頭）", () => {
    const { adv } = buildAdv();
    adv.present("你好", {});
    vi.advanceTimersByTime(TYPE_MS * 5); // 打完「你好」（2 字）
    expect(adv.textEl.textContent).toBe("你好");

    adv.present("你好，今天", { resume: true });
    expect(adv.textEl.textContent).toBe("你好"); // 續打前不清空、不跳字
    vi.advanceTimersByTime(TYPE_MS);
    expect(adv.textEl.textContent).toBe("你好，");
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("你好，今天");
  });

  it("resume:true 但新文字不是現況的延伸（完全不同）→ 重頭打", () => {
    const { adv } = buildAdv();
    adv.present("你好，今天", {});
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("你好，今天");

    adv.present("完全不同", { resume: true });
    expect(adv.textEl.textContent).toBe(""); // 重頭＝先清空
    vi.advanceTimersByTime(TYPE_MS);
    expect(adv.textEl.textContent).toBe("完");
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("完全不同");
  });

  it("打字中途再 resume（target 擴展）：settle 點＝現況非舊全文，不閃跳；續打銜接不重複不跳字", () => {
    const { adv } = buildAdv();
    adv.present("你好，今天", {}); // 5 字：你好，今天
    vi.advanceTimersByTime(TYPE_MS * 3);
    expect(adv.textEl.textContent).toBe("你好，"); // 打到第 3 字

    adv.present("你好，今天真好", { resume: true }); // target 擴展（+真好，共 7 字）
    // 關鍵斷言：沒有先跳成舊全文「你好，今天」再改口——停表定格點必須是「現況」
    expect(adv.textEl.textContent).toBe("你好，");

    vi.advanceTimersByTime(TYPE_MS); // 續打一字，銜接不斷
    expect(adv.textEl.textContent).toBe("你好，今");
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("你好，今天真好");
  });

  it("resume 且新文字＝現況已顯完（零成長）→ 直接定格，不重啟打字機／不重發 typing 通知", () => {
    const calls = [];
    const { adv } = buildAdv({ onTypingChange: (t) => calls.push(t) });
    adv.present("你好", { instant: true });
    expect(calls).toEqual([]); // instant 沒有 typing 事件

    adv.present("你好", { resume: true });
    expect(adv.textEl.textContent).toBe("你好");
    expect(calls).toEqual([]); // 沒有多打出一次 true（沒有重新啟動打字機）
  });

  it("resume:true 但目前顯示為空（這輪第一個 partial）→ 視同一般 present，從頭打", () => {
    const { adv } = buildAdv();
    adv.present("第一段", { resume: true }); // 從沒 present 過，shown=""
    expect(adv.textEl.textContent).toBe("");
    vi.advanceTimersByTime(TYPE_MS);
    expect(adv.textEl.textContent).toBe("第");
    vi.advanceTimersByTime(TYPE_MS * 5);
    expect(adv.textEl.textContent).toBe("第一段");
  });

  it("既有非 resume 呼叫行為守恆：不傳 opts.resume 時，即使現況非空也一律重頭（舊行為零影響）", () => {
    const { adv } = buildAdv();
    adv.present("第一句", { instant: true });
    adv.present("第二句"); // 沒有 resume:true
    expect(adv.textEl.textContent).toBe(""); // 舊行為：先清空
    vi.advanceTimersByTime(TYPE_MS);
    expect(adv.textEl.textContent).toBe("第");
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Thinking 鈕串流中常駐可點（layout.css
  // `.adv-thinking-btn { pointer-events: auto; }`，從不 disable）。若在
  // partial 串流打字中途點開它，textEl.textContent 會被 _toggleThoughts 改寫成
  // 思緒文字／佔位句；下一顆 partial／final frame 若直接讀 textEl.textContent
  // 當 resume 基準，會被這段文字污染、canResume 誤判 false，整段已累積的回覆
  // 被迫重頭打一次——正是「不閃跳」想避免的事。
  // ───────────────────────────────────────────────────────────────────────────
  it("Thinking 鈕在打字中途被點開：resume 基準不能被思緒／佔位文字污染，續打銜接不重頭", () => {
    const { adv } = buildAdv();
    adv.present("你好，今天", {}); // 5 字，打字中
    vi.advanceTimersByTime(TYPE_MS * 3); // 「你好，」三字
    expect(adv.textEl.textContent).toBe("你好，");

    adv.thinkingBtn.click(); // 點開 Thinking——沒有思緒，顯示佔位句
    expect(adv.textEl.textContent).toBe("（這一輪他沒有留下思緒）");
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(true);

    adv.present("你好，今天真好", { resume: true }); // 下一顆 partial 抵達（還停在思緒頁）

    // 退出思緒頁（present 既有的 _setThoughts 副作用）
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(false);
    expect(adv.thinkingBtn.getAttribute("aria-pressed")).toBe("false");
    // resume 基準＝點開思緒那一刻 _stopTimer 定格的完整正文「你好，今天」
    // （同既有「中斷＝補到完整終值」慣例，settle()/thinking() 皆如此）——不是
    // 思緒佔位文字、也不是重頭清空。這一刻還沒 tick，直接證明沒有整段被清掉。
    expect(adv.textEl.textContent).toBe("你好，今天");
    vi.advanceTimersByTime(TYPE_MS); // 續打一字，銜接不斷
    expect(adv.textEl.textContent).toBe("你好，今天真");
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("你好，今天真好");
  });

  it("final frame（帶新 thoughts）在思緒頁開著時抵達：Thinking 鈕反映新思緒、正文續打正確", () => {
    const { adv } = buildAdv();
    adv.present("你好，今天", {}); // 5 字，打字中
    vi.advanceTimersByTime(TYPE_MS * 3); // 「你好，」三字
    adv.thinkingBtn.click(); // 這輪目前還沒有思緒，顯示佔位句
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(false);

    // final frame：resume 續打收尾＋這次帶了新思緒
    adv.present("你好，今天真好", { resume: true, thoughts: "其實有點想妳" });

    // Thinking 鈕反映的是「新」思緒，不是切換當下看到的舊佔位句
    expect(adv.thinkingBtn.classList.contains("has-thoughts")).toBe(true);
    expect(adv.box.classList.contains("adv-showing-thoughts")).toBe(false); // 退出思緒頁，回正文
    // 正文續打基準正確（同上一案的證明），不因為帶了 thoughts 而改變
    expect(adv.textEl.textContent).toBe("你好，今天");
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(adv.textEl.textContent).toBe("你好，今天真好");

    // 再點開 Thinking：看到的是新思緒本身，不是殘留的舊佔位句
    adv.thinkingBtn.click();
    expect(adv.textEl.textContent).toBe("其實有點想妳");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ② upsertPartialBubble ／ clearPartialBubble（chat.js，Chat Log 半成品泡泡）
// ─────────────────────────────────────────────────────────────────────────────
describe("upsertPartialBubble／clearPartialBubble — Chat Log 半成品泡泡（邊寫邊送）", () => {
  it("首呼建立 .row.reply.partial-row 單例 ＋ .bubble.reply 文字", () => {
    const el = document.createElement("div");
    upsertPartialBubble(el, "他正在說");
    const rows = el.querySelectorAll(".partial-row");
    expect(rows.length).toBe(1);
    expect(rows[0].classList.contains("row")).toBe(true);
    expect(rows[0].classList.contains("reply")).toBe(true);
    const bubble = rows[0].querySelector(".bubble.reply");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe("他正在說");
  });

  it("再呼更新文字：不疊 row，同一顆泡泡文字被取代", () => {
    const el = document.createElement("div");
    upsertPartialBubble(el, "他正在");
    upsertPartialBubble(el, "他正在說話");
    expect(el.querySelectorAll(".partial-row").length).toBe(1);
    expect(el.querySelector(".partial-row .bubble").textContent).toBe("他正在說話");
  });

  it("顯示層空行壓縮同既有規則（連續空行摺成單一換行）", () => {
    const el = document.createElement("div");
    upsertPartialBubble(el, "第一句。\n\n\n第二句");
    expect(el.querySelector(".partial-row .bubble").textContent).toBe("第一句。\n第二句");
  });

  it("首呼會先清掉既有的思考中指示器（.status-line）——半成品開始＝思考中結束", () => {
    const el = document.createElement("div");
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    expect(el.querySelectorAll(".status-line").length).toBe(1);
    upsertPartialBubble(el, "他開口了");
    expect(el.querySelectorAll(".status-line").length).toBe(0);
  });

  it("再呼（非首次）也會清掉期間新冒出的思考中指示器——雙送時排隊訊息的 pre-lock status frame 不殘留，且不多疊 partial row", () => {
    const el = document.createElement("div");
    upsertPartialBubble(el, "他正在說");
    // 模擬雙送：第二句的 pre-lock status frame 在第一句的 partial 已經在跑
    // 之後才抵達（真實發生過的時序，見 upsertPartialBubble 函式說明）。
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    expect(el.querySelectorAll(".status-line").length).toBe(1);
    expect(el.querySelectorAll(".partial-row").length).toBe(1);

    upsertPartialBubble(el, "他正在說話");

    expect(el.querySelectorAll(".status-line").length).toBe(0);
    expect(el.querySelectorAll(".partial-row").length).toBe(1); // 沒有疊出第二顆
    expect(el.querySelector(".partial-row .bubble").textContent).toBe("他正在說話");
  });

  it("near-bottom（距底 <120px）→ 跟捲：scrollTop 更新為 scrollHeight", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 500, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 450, configurable: true }); // 距底 500-0-450=50，<120
    upsertPartialBubble(el, "文字");
    expect(el.scrollTop).toBe(500);
  });

  it("離底（距底 >=120px）→ 不跟捲，維持原本往上捲看到的位置", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    el.scrollTop = 100; // 距底 1000-100-400=500，>=120
    upsertPartialBubble(el, "文字");
    expect(el.scrollTop).toBe(100); // 不變
  });

  it("XSS 紀律：.textContent 賦值不解析 HTML（同 renderFrame 既有規範）", () => {
    const el = document.createElement("div");
    const payload = '<img src=x onerror="window.__v4_xss_fired = true">';
    upsertPartialBubble(el, payload);
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector(".partial-row .bubble").textContent).toBe(payload);
  });

  it("listEl 缺席 → no-op 不拋錯", () => {
    expect(() => upsertPartialBubble(null, "x")).not.toThrow();
  });

  it("非字串 text → 視同空字串，不拋錯", () => {
    const el = document.createElement("div");
    expect(() => upsertPartialBubble(el, undefined)).not.toThrow();
    expect(el.querySelector(".partial-row .bubble").textContent).toBe("");
  });

  it("clearPartialBubble：移除該 row；冪等（重複呼叫／本來就沒有／listEl 缺席）皆不拋錯", () => {
    const el = document.createElement("div");
    upsertPartialBubble(el, "文字");
    clearPartialBubble(el);
    expect(el.querySelectorAll(".partial-row").length).toBe(0);
    expect(() => clearPartialBubble(el)).not.toThrow();
    expect(() => clearPartialBubble(null)).not.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderFrame 舊行為守恆：partial 由 app.js 分流攔截，chat.js 的 renderFrame 語意
// 不動——"partial" 對它來說仍是未知 role，靜默略過（同其他未知 role）。
// ─────────────────────────────────────────────────────────────────────────────
describe('renderFrame — role:"partial" 不是它認得的型別（分流責任在 app.js，不在 chat.js）', () => {
  it("直接餵 renderFrame 一個 partial frame → 靜默略過，不拋錯、不留 DOM", () => {
    const el = document.createElement("div");
    expect(() => renderFrame({ role: "partial", text: "半句話" }, el, ctx)).not.toThrow();
    expect(el.children.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ③ app.js 接線（integration 級）—— chat.onFrame 分派 ＋ streamArmed/streamActive
//
// 見檔頭說明：這裡的 harness 逐行對齊 app.js 實作時的 chat.onFrame，讓真正的
// AdvPresenter／upsertPartialBubble／clearPartialBubble／renderFrame／stripMarkers
// 接上真實分派順序，驗證整條線路而非各積木的孤立行為。
//
// streamArmed／streamActive 兩顆旗標職責分開：
//   streamArmed（武裝）：submitSent（對齊 app.js 送出「sent」本地 frame 那一刻）
//     設 true；assistant/system/call 家族任一「這輪結束」frame 處理完解除武裝＝false。
//     partial frame 只在武裝時才處理——這是防呆閘門：final frame 剛處理完那瞬間，
//     網路上可能還有上一輪的遲到 partial 在飛（毫秒級 race window），未武裝時
//     直接忽略，不建泡泡、不動 ADV。
//   streamActive（真的有串流）：只在 partial frame 被實際處理時才設 true，assistant
//     收尾時用它決定 Chat Log 要不要 instant（已經看過逐字浮現、不用再重播）＋
//     ADV 要不要用 resume 收尾。跟 streamArmed 刻意分開——否則「武裝但這輪其實
//     沒收到任何 partial」（如後端旗標關閉）也會被誤判成「有串流」。
// ─────────────────────────────────────────────────────────────────────────────
function buildHarness() {
  const msgsEl = document.createElement("div");
  const { adv } = buildAdv();
  let streamArmed = false;
  let streamActive = false;
  const phoneFrames = [];

  function onFrame(frame) {
    if (frame && (frame.role === "call" || frame.role === "incoming_call" || frame.role === "incoming_call_end")) {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      streamActive = false;
      phoneFrames.push(frame); // 對齊 app.js 的 phone.handleFrame(frame)（本測試不需要真 PhoneController）
      return;
    }
    if (frame && !frame.room && frame.role === "status") {
      adv.thinking(typeof frame.text === "string" ? frame.text : "");
      renderFrame(frame, msgsEl, ctx);
      return;
    }
    if (frame && !frame.room && frame.role === "partial" && typeof frame.text === "string") {
      if (!streamArmed) return; // 漏網的遲到 partial——不建泡泡、ADV 不動
      streamActive = true;
      const clean = stripMarkers(frame.text).text;
      adv.present(clean, { resume: true });
      upsertPartialBubble(msgsEl, clean);
      return;
    }
    if (frame && !frame.room && frame.role === "system") {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      streamActive = false;
      renderFrame(frame, msgsEl, ctx);
      return;
    }
    if (frame && !frame.room && frame.role === "assistant" && typeof frame.text === "string") {
      clearPartialBubble(msgsEl);
      streamArmed = false;
      if (streamActive) frame.instant = true;
      const finalOpts = streamActive
        ? { thoughts: frame.thoughts, resume: true }
        : { thoughts: frame.thoughts };
      streamActive = false;
      renderFrame(frame, msgsEl, ctx);
      adv.present(stripMarkers(frame.text).text, finalOpts);
      return;
    }
    renderFrame(frame, msgsEl, ctx);
  }

  function submitSent(text) {
    streamArmed = true; // 對齊 app.js：submit／傳照片送出成功那一刻重新武裝
    renderFrame({ role: "sent", text }, msgsEl, ctx);
  }

  // 逐行對齊 app.js chat.onStatusChange 裡跟半成品泡泡／
  // guard 有關的那一半邏輯（idle-note 那半跟本測試無關，harness 不重現）——
  // status==="open" 純粹 no-op（連線中／剛連上都不動半成品狀態）；離開 open
  // （重連中／已關閉／錯誤，含開機第一次 connect 前的初始 "connecting"）＝
  // 這一輪被迫中斷，清半成品泡泡＋解除武裝，同 assistant final frame 分支收尾。
  function onStatusChange(status) {
    if (status === "open") return;
    clearPartialBubble(msgsEl);
    streamArmed = false;
    streamActive = false;
  }

  return {
    msgsEl, adv, onFrame, submitSent, onStatusChange, phoneFrames,
    isArmed: () => streamArmed,
    isActive: () => streamActive,
  };
}

describe("app.js 接線 — chat.onFrame 分派（partial→ADV resume+泡泡；final→instant+resume 收尾；guard）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("partial frame → ADV resume 續打 ＋ Chat Log 半成品泡泡 upsert", () => {
    const h = buildHarness();
    h.submitSent("在嗎？");
    h.onFrame({ role: "partial", text: "我在" });
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(1);
    expect(h.msgsEl.querySelector(".partial-row .bubble").textContent).toBe("我在");
    vi.advanceTimersByTime(TYPE_MS);
    expect(h.adv.textEl.textContent).toBe("我");
    vi.advanceTimersByTime(TYPE_MS);
    expect(h.adv.textEl.textContent).toBe("我在");
  });

  it("partial frame 文字先剝除 [react:]/[sticker:] 標記再上屏（同 final frame 剝除邏輯）", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "[react:❤] 我在" });
    expect(h.msgsEl.querySelector(".partial-row .bubble").textContent).toBe("我在");
  });

  it("連續 partial：ADV 續打不重頭、泡泡文字持續更新為最新累積全文", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我" });
    vi.advanceTimersByTime(TYPE_MS * 5);
    expect(h.adv.textEl.textContent).toBe("我");

    h.onFrame({ role: "partial", text: "我在想你" });
    expect(h.adv.textEl.textContent).toBe("我"); // 續打前不清空
    vi.advanceTimersByTime(TYPE_MS * 10);
    expect(h.adv.textEl.textContent).toBe("我在想你");
    expect(h.msgsEl.querySelector(".partial-row .bubble").textContent).toBe("我在想你");
  });

  it("final assistant frame 收尾：半成品泡泡消失、正式泡泡整段直貼（frame.instant=true，不逐行重播）、ADV 續打收尾", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我在想你" });
    vi.advanceTimersByTime(TYPE_MS * 10); // 讓 ADV 打完目前累積（4 字）

    const frame = { role: "assistant", text: "我在想你。\n今天過得好嗎？", thoughts: null };
    h.onFrame(frame);

    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0); // 半成品消失
    expect(frame.instant).toBe(true);
    // Chat Log：instant=true → 兩行整段直貼，不需要任何 tick 就已經是完整內容
    expect(h.msgsEl.querySelector(".bubble.reply").textContent).toBe("我在想你。\n今天過得好嗎？");
    // ADV：resume 收尾——這一刻還沒 tick，文字停在剛才 partial 打完的地方（不閃跳）
    expect(h.adv.textEl.textContent).toBe("我在想你");
    vi.advanceTimersByTime(TYPE_MS * 20);
    expect(h.adv.textEl.textContent).toBe("我在想你。\n今天過得好嗎？");
  });

  it("無 partial、直接 final → frame.instant 不標（現狀維持，falsy）", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    const frame = { role: "assistant", text: "在。", thoughts: null };
    h.onFrame(frame);
    expect(frame.instant).toBeUndefined();
  });

  it("stray partial：final 之後才抵達的遲到 partial → 不建泡泡、ADV 不動（guard 已解除武裝）", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我在" });
    h.onFrame({ role: "assistant", text: "我在想你。", thoughts: null });
    vi.advanceTimersByTime(TYPE_MS * 20); // 讓 final 的 ADV resume 完全定格
    const advTextAfterFinal = h.adv.textEl.textContent;
    expect(advTextAfterFinal).toBe("我在想你。");
    expect(h.isArmed()).toBe(false);

    h.onFrame({ role: "partial", text: "我在想你。多打了一點" }); // 漏網的舊輪殘留

    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0); // 沒有新泡泡
    expect(h.adv.textEl.textContent).toBe(advTextAfterFinal); // ADV 文字沒被碰過
    expect(h.msgsEl.querySelector(".bubble.reply").textContent).toBe("我在想你。"); // 已定案的泡泡也沒被動過
  });

  it("送出下一則訊息後 guard 重新武裝：新一輪 partial 正常被接受", () => {
    const h = buildHarness();
    h.submitSent("第一句");
    h.onFrame({ role: "partial", text: "回覆一" });
    h.onFrame({ role: "assistant", text: "回覆一。", thoughts: null });
    expect(h.isArmed()).toBe(false);

    h.submitSent("第二句"); // 重新武裝
    expect(h.isArmed()).toBe(true);
    h.onFrame({ role: "partial", text: "回覆二" });
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(1);
    expect(h.msgsEl.querySelector(".partial-row .bubble").textContent).toBe("回覆二");
  });

  it("system frame 也算「這輪結束」：清半成品泡泡＋解除武裝（graceful/錯誤輪不殘留半成品）", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "正在講" });
    h.onFrame({ role: "system", text: "今天的嗓子休息了，明天再開口。" });

    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0);
    expect(h.isArmed()).toBe(false);

    h.onFrame({ role: "partial", text: "遲到的" }); // 應被忽略
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0);
  });

  it("call 家族 frame 也算「這輪結束」：清半成品泡泡＋解除武裝", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "正在講" });
    h.onFrame({ role: "incoming_call", call_id: "c1" });

    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0);
    expect(h.isArmed()).toBe(false);
    expect(h.phoneFrames.length).toBe(1);
  });

  it("status frame 不算「這輪結束」：不解除武裝、partial 仍正常被接受", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "status", text: "思考中…" });
    expect(h.isArmed()).toBe(true); // status 不動 guard

    h.onFrame({ role: "partial", text: "我在" });
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(1);
  });

  // ───────────────────────────────────────────────────────────────────────
  // chat.onStatusChange 離開 "open"（斷線／重連中／
  // 錯誤）＝這一輪被迫中斷，比照 assistant final frame 分支同款收尾——清半成品
  // 泡泡＋解除武裝，避免斷線期間半寫一半的話孤兒留在畫面上直到下一輪蓋掉它。
  // ───────────────────────────────────────────────────────────────────────
  it("WS 斷線中途（status 離開 open）：清掉半成品泡泡＋解除武裝＋清 streamActive", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我正在" });
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(1);
    expect(h.isArmed()).toBe(true);
    expect(h.isActive()).toBe(true);

    h.onStatusChange("reconnecting"); // 斷線，重連中

    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0);
    expect(h.isArmed()).toBe(false);
    expect(h.isActive()).toBe(false);
  });

  it("斷線後才抵達的遲到 partial：guard 已解除武裝，不會復活半成品泡泡", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我正在" });
    h.onStatusChange("closed");

    h.onFrame({ role: "partial", text: "我正在想你" }); // 斷線前最後一幀延遲抵達

    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0);
    expect(h.isArmed()).toBe(false);
  });

  it("status 為 open（含重連成功）不清泡泡、不動 guard——只有離開 open 才清", () => {
    const h = buildHarness();
    h.submitSent("嗨");
    h.onFrame({ role: "partial", text: "我正在" });

    h.onStatusChange("open");

    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(1);
    expect(h.isArmed()).toBe(true);
    expect(h.isActive()).toBe(true);
  });

  it("開機第一次 connect 前的初始 connecting 狀態：沒有殘留可清，呼叫是安全的 no-op", () => {
    const h = buildHarness();
    expect(() => h.onStatusChange("connecting")).not.toThrow();
    expect(h.msgsEl.querySelectorAll(".partial-row").length).toBe(0);
    expect(h.isArmed()).toBe(false);
    expect(h.isActive()).toBe(false);
  });
});
