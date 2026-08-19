import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ChatClient, renderFrame, renderHistory, loadHistory,
  appendThought, REVEAL_LINE_MS, REVEAL_TOTAL_CAP_MS, REVEAL_MIN_MS,
  stripMarkers, showThinkingDots, renderSceneLine, primeReplayEl, EXPR_ANY_RE,
} from "../js/chat.js";
import { TtsSpeaker } from "../js/tts.js";
import { setLocale } from "../js/i18n.js";

// ctx 最小集合（binding constraints 明定 {characterName, assetsBase}）；stickerMap 是
// renderFrame 的可選擴充點（目前沒有貼圖資產，預設空 map）。
const ctx = { characterName: "Sample", assetsBase: "assets/sample/" };
const ctxWithSticker = { ...ctx, stickerMap: { smile: "smile.png" } };

// ─────────────────────────────────────────────────────────────────────────────
// renderFrame —— 對照真實 frame 樣本。
//
// 命名說明：對方回覆用 CSS class「reply」、使用者自己送出的訊息用本地偽 role
// 「sent」／class「sent」——這兩個字串在整份測試裡都是通用命名，非角色專屬。frame
// 物件裡的 `role: "assistant"` 則不一樣：那是協定的 wire literal（後端真的會送這個
// 字面值），不是本檔取的名字，測試樣本原樣照抄協定裡的真 frame，第一次出現
// 處加註記，之後不再重複註記。
// ─────────────────────────────────────────────────────────────────────────────
describe("renderFrame — 對方完整回覆", () => {
  it("role:assistant 文字 frame（protocol literal, not branding——後端真的送這個字面值）→ .bubble.reply、原文上屏", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "在。", timestamp: "2026-08-02T00:00:00", thoughts: null }, el, ctx);
    const b = el.querySelector(".bubble.reply");
    expect(b).not.toBeNull();
    expect(b.textContent).toContain("在。");
  });

  it("frame 為 null/undefined，或省略 ctx → 不拋錯", () => {
    const el = document.createElement("div");
    expect(() => renderFrame(null, el)).not.toThrow();
    expect(() => renderFrame(undefined, el)).not.toThrow();
    expect(() => renderFrame({ role: "assistant", text: "嗨" }, el)).not.toThrow();
  });
});

describe("renderFrame — 使用者自己的訊息（本地偽 role「sent」，從未出現在真實線路上）", () => {
  it("role:sent → .bubble.sent、原文上屏", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "在嗎？" }, el, ctx);
    const b = el.querySelector(".bubble.sent");
    expect(b).not.toBeNull();
    expect(b.textContent).toBe("在嗎？");
  });

  it("空字串／純空白 → 不渲染", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "   " }, el, ctx);
    expect(el.children.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 照片 —— 私聊沒有下行「照片回顯」frame，寄件人
// 自己樂觀渲染（本地 blob URL）；app.js 上傳成功後餵一個帶 `photoUrl` 的本地
// sent frame 給 renderFrame，走的是這裡，不是等一個不存在的伺服器 frame。
// ─────────────────────────────────────────────────────────────────────────────
describe("renderFrame — 即時傳送的照片（本地樂觀渲染，photoUrl 是呼叫端自建欄位）", () => {
  it("photoUrl 有值、無文字 → .bubble-photo 內的 <a><img> 用該 URL 當 src／href，可點開新分頁", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "", photoUrl: "blob:fake-url-1" }, el, ctx);
    const link = el.querySelector("a.bubble-photo");
    const img = el.querySelector(".bubble-photo-img");
    expect(link).not.toBeNull();
    expect(link.getAttribute("href")).toBe("blob:fake-url-1");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toContain("noopener");
    expect(img).not.toBeNull();
    expect(img.getAttribute("src")).toBe("blob:fake-url-1");
    // alt 是寫死的靜態字串，不是任何使用者輸入——XSS 討論見 chat.js 內的函式註解。
    expect(img.getAttribute("alt")).toBe("照片");
    // 沒有配文字 → 不該多長出一顆空的 .bubble.sent 文字泡泡。
    expect(el.querySelectorAll(".bubble.sent").length).toBe(0);
  });

  it("photoUrl ＋ 配文字（caption）→ 同一列同時有圖片泡泡與文字泡泡", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "妳看這個", photoUrl: "blob:fake-url-2" }, el, ctx);
    const row = el.querySelector(".row.sent");
    expect(row.querySelector("a.bubble-photo")).not.toBeNull();
    const textBubble = row.querySelector(".bubble.sent:not(.bubble-photo)");
    expect(textBubble).not.toBeNull();
    expect(textBubble.textContent).toBe("妳看這個");
  });

  it("img/alt／href 絕不經過 innerHTML 拼接——即使 URL 字串本身帶特殊字元也不會被當標籤解析", () => {
    // blob URL 實務上不會長這樣，但這裡故意塞一個攻擊性字串進 photoUrl，證明走
    // 屬性賦值（img.src=...）而非字串拼接進 innerHTML，特殊字元不會被解析成標籤。
    const el = document.createElement("div");
    const evil = 'blob:fake"><img src=x onerror=alert(1)>';
    renderFrame({ role: "sent", text: "", photoUrl: evil }, el, ctx);
    expect(el.querySelectorAll("img").length).toBe(1); // 只有我們自己建的那顆 <img>，沒有被注入第二顆
    expect(el.querySelector(".bubble-photo-img").getAttribute("src")).toBe(evil);
  });

  it("三個欄位（text/photoUrl/photoNote）都沒有 → 不渲染（同舊行為，未回歸）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "" }, el, ctx);
    expect(el.children.length).toBe(0);
  });

  // ── photoUrls 多圖（一則訊息 N 張圖）───────────────────────
  it("photoUrls 三張、無文字 → 同一列 3 顆照片泡泡、順序＝陣列序、row-stack 直向堆疊", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "", photoUrls: ["blob:m1", "blob:m2", "blob:m3"] }, el, ctx);
    const row = el.querySelector(".row.sent");
    expect(row.classList.contains("row-stack")).toBe(true); // N 顆 220px 泡泡橫排會爆寬——多張必直向
    const links = row.querySelectorAll("a.bubble-photo");
    expect(links.length).toBe(3);
    expect(links[0].getAttribute("href")).toBe("blob:m1"); // 順序＝上傳序＝貼上的順序
    expect(links[1].getAttribute("href")).toBe("blob:m2");
    expect(links[2].getAttribute("href")).toBe("blob:m3");
    expect(row.querySelectorAll(".bubble.sent:not(.bubble-photo)").length).toBe(0); // 無文字＝無空文字泡泡
  });

  it("photoUrls 多張＋配文字 → 圖們在前、文字泡泡最後（圖上文下慣例延伸）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "這三張都好看", photoUrls: ["blob:p1", "blob:p2", "blob:p3"] }, el, ctx);
    const row = el.querySelector(".row.sent");
    expect(row.classList.contains("row-stack")).toBe(true);
    expect(row.querySelectorAll("a.bubble-photo").length).toBe(3);
    const last = row.lastElementChild;
    expect(last.classList.contains("bubble-photo")).toBe(false); // 文字殿後
    expect(last.textContent).toBe("這三張都好看");
  });

  it("photoUrls 單張 → 與 photoUrl 舊欄位渲染結果相同（無 row-stack、單顆照片泡泡）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "", photoUrls: ["blob:solo"] }, el, ctx);
    const row = el.querySelector(".row.sent");
    expect(row.classList.contains("row-stack")).toBe(false); // 單圖無文字＝與既有單張行為逐一相同
    expect(row.querySelectorAll("a.bubble-photo").length).toBe(1);
    expect(row.querySelector(".bubble-photo-img").getAttribute("src")).toBe("blob:solo");
  });

  it("photoUrls 濾掉非字串／空值；全 falsy 且無文字 → 不渲染", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "", photoUrls: ["blob:keep", "", null] }, el, ctx);
    expect(el.querySelectorAll("a.bubble-photo").length).toBe(1);
    const el2 = document.createElement("div");
    renderFrame({ role: "sent", text: "", photoUrls: ["", null, undefined] }, el2, ctx);
    expect(el2.children.length).toBe(0);
  });
});

describe("renderFrame — 思緒（thoughts 是回覆 frame 的附屬欄位，非獨立 frame type）", () => {
  it("thoughts 有值 → .thought 摺疊列與 .bubble.reply 同時出現", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "抱歉剛剛在忙。", timestamp: "2026-08-02T00:00:00", thoughts: "等很久了，語氣要溫柔一點。" },
      el,
      ctx,
    );
    const thought = el.querySelector(".thought");
    const bubble = el.querySelector(".bubble.reply");
    expect(thought).not.toBeNull();
    expect(thought.textContent).toContain("等很久了");
    expect(bubble.textContent).toContain("抱歉剛剛在忙。");
  });

  it("thoughts 為 null（思緒功能關閉時的現狀）→ 不渲染 .thought", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "在。", timestamp: "...", thoughts: null }, el, ctx);
    expect(el.querySelector(".thought")).toBeNull();
  });
});

describe("renderFrame — [react:X]（嵌在回覆文字裡的標記，非獨立 frame type）", () => {
  it("標記剝除、貼到最後一個 .bubble.sent 角落，正文照常上屏", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "你在嗎" }, el, ctx); // 送出當下同步畫的那顆泡泡先上屏
    renderFrame(
      { role: "assistant", text: "[react:😳]突然這樣說我會不好意思。", timestamp: "...", thoughts: null },
      el,
      ctx,
    );
    const sentBubble = el.querySelector(".bubble.sent");
    const badge = sentBubble.querySelector(".bubble-react");
    const replyBubble = el.querySelector(".bubble.reply");
    expect(badge).not.toBeNull();
    expect(badge.textContent).toBe("😳");
    expect(replyBubble.textContent).not.toContain("[react:");
    expect(replyBubble.textContent).toContain("突然這樣說我會不好意思。");
  });

  it("找不到可以貼的泡泡（開場第一句就 react）→ 靜默略過，不拋錯", () => {
    const el = document.createElement("div");
    expect(() =>
      renderFrame({ role: "assistant", text: "[react:😳]開場就react", timestamp: "...", thoughts: null }, el, ctx),
    ).not.toThrow();
    expect(el.querySelector(".bubble.reply").textContent).toContain("開場就react");
  });
});

describe("renderFrame — [sticker:Y]（貼圖功能已退役——標記照剝、永不渲染）", () => {
  it("開頭標記剝除、不渲染任何圖片（就算 ctx 還帶 stickerMap 也一樣），正文照常上屏", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "[sticker:smile]今天也要加油喔。", timestamp: "...", thoughts: null },
      el,
      ctxWithSticker,
    );
    expect(el.querySelector("img.sticker-img")).toBeNull();
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[sticker:");
    expect(bubble.textContent).toContain("今天也要加油喔。");
  });

  it("句尾容錯位置也剝除、不渲染", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "今天也要加油喔。[sticker:smile]", timestamp: "...", thoughts: null }, el, ctxWithSticker);
    const bubble = el.querySelector(".bubble.reply");
    expect(el.querySelector("img.sticker-img")).toBeNull();
    expect(bubble.textContent).not.toContain("[sticker:");
    expect(bubble.textContent).toContain("今天也要加油喔。");
  });

  // 實錄：[intimate:open] 佔住行首時，後面的 [sticker:] 錨不到行首＝兩個標記
  // 一起裸奔上屏（截圖正是 ADV 正文首行）。intimate 全文靜默剝除後 sticker 回到行首、
  // 照舊剝乾淨——這是那張截圖的回歸測試。
  it("[intimate:open][sticker:X] 連續標記串（實錄場景）→ 兩個都剝乾淨，正文照常", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "[intimate:open][sticker:按捺慾望]（喉結滾了一下。）", timestamp: "...", thoughts: null },
      el,
      ctx,
    );
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[intimate:");
    expect(bubble.textContent).not.toContain("[sticker:");
    expect(bubble.textContent).toContain("喉結滾了一下");
  });

  it("[intimate:*] 單獨出現（任意位置）→ 靜默剝除，正文照常", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "過來。[intimate:open]別躲。", timestamp: "...", thoughts: null },
      el,
      ctx,
    );
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[intimate:");
    expect(bubble.textContent).toContain("過來。");
    expect(bubble.textContent).toContain("別躲。");
  });

  it("正文中段的 [sticker:] （行首行尾都錨不到）→ 全文保底剝除，不裸奔", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "先這樣。[sticker:開心]晚點見。", timestamp: "...", thoughts: null },
      el,
      ctx,
    );
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[sticker:");
    expect(bubble.textContent).toContain("先這樣。");
    expect(bubble.textContent).toContain("晚點見。");
  });

  // 整輪只有標記時的保底佔位（防「一輪回覆整個消失」）不變，但佔位字樣不再提及
  // 貼圖——功能已取消，不留概念殘影。
  it("整句只有 [sticker:] 標記 → 佔位泡泡（不提貼圖字樣），不整列消失", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "[sticker:doesnotexist]", timestamp: "...", thoughts: null }, el, ctx);
    const bubbles = el.querySelectorAll(".bubble");
    expect(bubbles.length).toBe(1);
    expect(bubbles[0].textContent).toContain("（一則沒有文字的回覆）");
    expect(bubbles[0].textContent).not.toContain("[sticker:");
  });

  // 同一個 bug class 的第二個觸發條件（原本只點名 sticker，但根因——row 剝完標記後
  // 沒有任何子節點——react-only 回覆一樣會踩到）：純 react 標記、沒有跟隨任何正文。
  it("純 react 標記、沒有跟隨正文 → 仍渲染一顆占位泡泡，不整列消失（同一 bug class 的另一觸發條件）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "sent", text: "你還好嗎" }, el, ctx);
    renderFrame({ role: "assistant", text: "[react:😳]", timestamp: "...", thoughts: null }, el, ctx);
    const replyBubbles = el.querySelectorAll(".bubble.reply");
    expect(replyBubbles.length).toBe(1);
    expect(replyBubbles[0].textContent).toContain("表情回應");
    // react 本身仍然正常貼到使用者自己那顆泡泡的角落，不因為多了占位泡泡而失效。
    expect(el.querySelector(".bubble.sent .bubble-react").textContent).toBe("😳");
  });
});

describe("renderFrame — role:system（引擎錯誤／逾時，重用既有信封，非獨立 frame type）", () => {
  it("role:system → .sys-msg，原文上屏", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "system", text: "抱歉，暫時無法回應，請稍後再試。", timestamp: "...", thoughts: null },
      el,
      ctx,
    );
    const sys = el.querySelector(".sys-msg");
    expect(sys).not.toBeNull();
    expect(sys.textContent).toBe("抱歉，暫時無法回應，請稍後再試。");
  });

  it("逾時安慰句其實是 role:assistant，照常見回覆渲染", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "抱歉，我剛走神了一下——你再跟我說一次，我聽著。", timestamp: "...", thoughts: null },
      el,
      ctx,
    );
    expect(el.querySelector(".bubble.reply")).not.toBeNull();
    expect(el.querySelector(".sys-msg")).toBeNull();
  });
});

describe("renderFrame — 未知 frame 型別 → 靜默略過不炸（設計如此，非疏漏）", () => {
  it("未知 role → 不拋錯、不留任何 DOM", () => {
    const el = document.createElement("div");
    expect(() => renderFrame({ role: "____future" }, el, ctx)).not.toThrow();
    expect(el.children.length).toBe(0);
  });

  it("電話系 role（call/incoming_call/incoming_call_end）→ 靜默略過（後續功能範圍）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "call", text: "x", audio: null, final: true }, el, ctx);
    renderFrame({ role: "incoming_call", call_id: "abc" }, el, ctx);
    renderFrame({ role: "incoming_call_end", call_id: "abc", status: "declined" }, el, ctx);
    expect(el.children.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// role:"status"（per-turn engine 思考中
// 指示器，`{"role":"status","text":"思考中…"}`）過去刻意落入
// 未知 role 的靜默略過分支——但每一輪回覆前都會有一段引擎思考期（可能好幾秒），
// 這段期間畫面上什麼指示都沒有，等於「已讀不回」的死寂，沉默＝焦慮。這裡不是延後的
// polish 項，是這次直接補上的最小化實作：畫面上永遠只有一條 transient 指示器，取代
// （不是疊加）前一條，任何非 status 的後續 frame 一到就整條移除。
// ─────────────────────────────────────────────────────────────────────────────
describe("renderFrame — role:status（思考中指示器，最小化處理）", () => {
  it("role:status → 渲染單一 .status-line，文字為 frame.text（XSS 紀律：textContent，不例外）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    const lines = el.querySelectorAll(".status-line");
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toBe("思考中…");
  });

  it("連續兩個 status frame → 第二個取代第一個（畫面上永遠只有一條，不是疊加成兩條）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    renderFrame({ role: "status", text: "還在想…" }, el, ctx);
    const lines = el.querySelectorAll(".status-line");
    expect(lines.length).toBe(1);
    expect(lines[0].textContent).toBe("還在想…");
  });

  it("status 之後接一則完整回覆 frame → 指示器被移除（回覆到了＝想完了），回覆照常上屏", () => {
    const el = document.createElement("div");
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    renderFrame({ role: "assistant", text: "在。", timestamp: "...", thoughts: null }, el, ctx);
    expect(el.querySelectorAll(".status-line").length).toBe(0);
    expect(el.querySelector(".bubble.reply").textContent).toContain("在。");
  });

  it("status 之後接使用者自己送出的訊息（role:sent）→ 同樣先移除指示器（任何非 status frame 都算「沉默結束」）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    renderFrame({ role: "sent", text: "還在嗎？" }, el, ctx);
    expect(el.querySelectorAll(".status-line").length).toBe(0);
    expect(el.querySelector(".bubble.sent").textContent).toBe("還在嗎？");
  });

  it("frame.text 缺失／非字串 → 不拋錯、不渲染任何內容（但仍會清掉前一條，若有）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    expect(() => renderFrame({ role: "status" }, el, ctx)).not.toThrow();
    expect(el.querySelectorAll(".status-line").length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// system／status 行的 near-bottom 條件捲（行為鎖測試）：舊的無條件
// 捲底會在 intimate/CG 輪把「剛錨定在回覆開頭」的畫面直接拉到最尾巴（reply 之後必跟
// 場景行 system frame——這是「顯示完跳到最尾巴」的根因）。改 near-bottom 條件捲
// （<120px 才捲，同 _renderReplyBubble／_revealLines 既有判準）後：在底部＝照
// 捲（行為不變）、捲離 >120px＝不搶捲軸。jsdom 沒有真實幾何——scrollHeight／
// clientHeight 用 Object.defineProperty 給假值（同上方 renderHistory「渲染完
// scroll 到底」既有 stub 慣例）；scrollTop 是 jsdom 普通可寫屬性，直接賦值。
// ─────────────────────────────────────────────────────────────────────────────
describe("renderFrame — system/status 行 near-bottom 條件捲", () => {
  /** 假幾何：內容 1000px、視窗 400px。nearBottom 判準＝scrollHeight - scrollTop
   * - clientHeight < 120 → scrollTop > 480 算近底。 */
  function makeScrollEl({ scrollTop }) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    el.scrollTop = scrollTop;
    return el;
  }

  it("在底部（距底 <120px）→ system 行與 status 行照捲到底（行為不變）", () => {
    const sysEl = makeScrollEl({ scrollTop: 590 }); // 1000-590-400=10 <120
    renderFrame({ role: "system", text: "（場景・月夜床帳）" }, sysEl, ctx);
    expect(sysEl.scrollTop).toBe(1000); // 捲到 scrollHeight

    const stEl = makeScrollEl({ scrollTop: 590 });
    renderFrame({ role: "status", text: "思考中…" }, stEl, ctx);
    expect(stEl.scrollTop).toBe(1000);
  });

  it("捲離底部（距底 ≥120px）→ system 行不搶捲軸（場景行不再把開頭錨定拉到底）", () => {
    const el = makeScrollEl({ scrollTop: 100 }); // 1000-100-400=500 ≥120
    renderFrame({ role: "system", text: "（場景・月夜床帳）" }, el, ctx);
    expect(el.querySelector(".sys-msg")).not.toBeNull(); // 行照渲染，只是不捲
    expect(el.scrollTop).toBe(100);                      // 捲軸原地不動
  });

  it("捲離底部（距底 ≥120px）→ status 行不搶捲軸（reply 錨定開頭後晚到的思考點不拉底）", () => {
    const el = makeScrollEl({ scrollTop: 100 });
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    expect(el.querySelector(".status-line")).not.toBeNull();
    expect(el.scrollTop).toBe(100);
  });
});

describe("showThinkingDots —「他在打字」三點", () => {
  function makeScrollEl({ scrollTop }) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    el.scrollTop = scrollTop;
    return el;
  }

  it("渲染 .status-line.status-dots＋三顆 span；剛送出（在底部）＝照捲到底", () => {
    const el = makeScrollEl({ scrollTop: 590 });
    showThinkingDots(el);
    const dots = el.querySelector(".status-line.status-dots");
    expect(dots).not.toBeNull();
    expect(dots.querySelectorAll("span").length).toBe(3);
    expect(el.scrollTop).toBe(1000);
  });

  it("取代制：dots 取代既有 status 行、server「思考中…」status 再取代 dots——永遠只有一條", () => {
    const el = makeScrollEl({ scrollTop: 590 });
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    showThinkingDots(el);
    expect(el.querySelectorAll(".status-line").length).toBe(1);
    expect(el.querySelector(".status-dots")).not.toBeNull();
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    expect(el.querySelectorAll(".status-line").length).toBe(1);
    expect(el.querySelector(".status-dots")).toBeNull(); // server 文字版接手
  });

  it("reply frame 到達＝dots 自動清（renderFrame 既有的 status 清除機制）", () => {
    const el = makeScrollEl({ scrollTop: 590 });
    showThinkingDots(el);
    renderFrame(
      { role: "assistant", text: "來了。", timestamp: "2026-08-10T12:00:00", thoughts: null },
      el, ctx,
    );
    expect(el.querySelector(".status-dots")).toBeNull();
    expect(el.querySelector(".bubble.reply")).not.toBeNull();
  });
});

describe("renderSceneLine — CG 場景行不吃等待指示", () => {
  function makeScrollEl({ scrollTop }) {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 1000, configurable: true });
    Object.defineProperty(el, "clientHeight", { value: 400, configurable: true });
    el.scrollTop = scrollTop;
    return el;
  }

  it("等待中（dots 在）→ 場景行渲染後 dots 重掛（點卡到他開口的 10-25s 不再空白）", () => {
    const el = makeScrollEl({ scrollTop: 590 });
    showThinkingDots(el);
    renderSceneLine(el, ctx, "探花沾露");
    expect(el.querySelector(".sys-msg").textContent).toBe("（場景・探花沾露）");
    expect(el.querySelector(".status-dots")).not.toBeNull(); // 重掛
  });

  it("server「思考中…」文字版在場時同樣重掛（.status-line 家族通判）", () => {
    const el = makeScrollEl({ scrollTop: 590 });
    renderFrame({ role: "status", text: "思考中…" }, el, ctx);
    renderSceneLine(el, ctx, "俯汐起浪");
    expect(el.querySelector(".status-dots")).not.toBeNull();
  });

  it("非等待中（無指示）→ 場景行照常、不憑空掛 dots（F5 還原／換景後的場景行）", () => {
    const el = makeScrollEl({ scrollTop: 590 });
    renderSceneLine(el, ctx, "俯汐起浪");
    expect(el.querySelector(".sys-msg")).not.toBeNull();
    expect(el.querySelector(".status-dots")).toBeNull();
  });

  it("重掛的 dots 仍被 reply 自動清（語意零變化）", () => {
    const el = makeScrollEl({ scrollTop: 590 });
    showThinkingDots(el);
    renderSceneLine(el, ctx, "探花沾露");
    renderFrame(
      { role: "assistant", text: "過來。", timestamp: "2026-08-10T12:00:00", thoughts: null },
      el, ctx,
    );
    expect(el.querySelector(".status-dots")).toBeNull();
  });
});

describe("renderFrame — 帶 room 鍵的 frame → 靜默略過（私聊限定）", () => {
  it("其他房間 frame（role 本身合法，但帶 room 鍵）皆不渲染", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", room: "room", text: "群組訊息", timestamp: "...", thoughts: null }, el, ctx);
    renderFrame({ role: "guest", room: "guest", text: "另一房間訊息", timestamp: "...", thoughts: null }, el, ctx);
    renderFrame({ role: "assistant", room: "lounge", text: "特殊房間訊息", timestamp: "...", thoughts: null }, el, ctx);
    expect(el.children.length).toBe(0);
  });
});

describe("renderFrame — XSS：文字內容一律走 textContent/createTextNode，絕不 innerHTML", () => {
  it("回覆含 <img onerror> 字面字串 → 原樣顯示成文字，不被解析成真的 img 標籤", () => {
    const el = document.createElement("div");
    const payload = '<img src=x onerror="window.__v4_xss_fired = true">';
    renderFrame({ role: "assistant", text: payload, timestamp: "...", thoughts: null }, el, ctx);
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe(payload);
    expect(bubble.querySelector("img")).toBeNull();
    expect(bubble.children.length).toBe(0); // 只有文字節點，零元素節點
    expect(window.__v4_xss_fired).toBeUndefined();
  });

  it("使用者自己送出的訊息（role:sent）同樣走 textContent，不被解析成標籤", () => {
    const el = document.createElement("div");
    const payload = "<script>window.__v4_xss_fired_2 = true</script>";
    renderFrame({ role: "sent", text: payload }, el, ctx);
    const bubble = el.querySelector(".bubble.sent");
    expect(bubble.textContent).toBe(payload);
    expect(bubble.querySelector("script")).toBeNull();
    expect(window.__v4_xss_fired_2).toBeUndefined();
  });

  it("system 錯誤訊息同樣走 textContent", () => {
    const el = document.createElement("div");
    const payload = '<img src=x onerror="window.__v4_xss_fired_3 = true">';
    renderFrame({ role: "system", text: payload, timestamp: "...", thoughts: null }, el, ctx);
    const sys = el.querySelector(".sys-msg");
    expect(sys.textContent).toBe(payload);
    expect(sys.querySelector("img")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// ChatClient —— 3s 固定退避重連＋世代計數（比常見前端的重連機制
// 更嚴格，是刻意的設計決策，不是協定探查發現）。
// jsdom 沒有真的 WebSocket 網路層——這裡用最小 mock 驗證「資源生命週期／世代計數邏輯」
// 本身（哪個 socket 的事件被接受、哪個被丟棄、何時排重連），不模擬真的網路資料流
// （那不是 chat.js 該負責驗證的範圍，本機端到端手驗才驗真的 WS 往返）。
// ─────────────────────────────────────────────────────────────────────────────
class MockWebSocket {
  constructor(url) {
    this.url = url;
    this.readyState = MockWebSocket.OPEN;
    this.sent = [];
    this.closeCalls = 0;
    MockWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = MockWebSocket.CLOSED;
    this.closeCalls += 1;
  }
}
MockWebSocket.CONNECTING = 0;
MockWebSocket.OPEN = 1;
MockWebSocket.CLOSING = 2;
MockWebSocket.CLOSED = 3;
MockWebSocket.instances = [];

function stubWebSocketGlobal() {
  MockWebSocket.instances = [];
  global.WebSocket = MockWebSocket;
}
function unstubWebSocketGlobal() {
  delete global.WebSocket;
}

describe("ChatClient — connect/send 基本行為", () => {
  beforeEach(stubWebSocketGlobal);
  afterEach(unstubWebSocketGlobal);

  it("connect() 建立一顆 socket；send() 在 OPEN 時送出裸字串（純文字非 JSON）", () => {
    const client = new ChatClient();
    client.connect("ws://localhost/ws");
    expect(MockWebSocket.instances.length).toBe(1);
    const ok = client.send("在嗎");
    expect(ok).toBe(true);
    expect(MockWebSocket.instances[0].sent).toEqual(["在嗎"]);
  });

  it("尚未連上（CONNECTING）時 send() 回 false、不拋錯", () => {
    const client = new ChatClient();
    client.connect("ws://localhost/ws");
    MockWebSocket.instances[0].readyState = MockWebSocket.CONNECTING;
    expect(() => client.send("哈囉")).not.toThrow();
    expect(client.send("哈囉")).toBe(false);
  });

  it("收到非 JSON 訊息 → 忽略，不呼叫 onFrame、不拋錯", () => {
    const client = new ChatClient();
    const received = [];
    client.onFrame = (f) => received.push(f);
    client.connect("ws://localhost/ws");
    const ws1 = MockWebSocket.instances[0];
    expect(() => ws1.onmessage({ data: "not json {{{" })).not.toThrow();
    expect(received.length).toBe(0);
  });
});

describe("ChatClient — onStatusChange", () => {
  beforeEach(stubWebSocketGlobal);
  afterEach(unstubWebSocketGlobal);

  it("connect() 立即回報 connecting；socket onopen 後回報 open", () => {
    const client = new ChatClient();
    const statuses = [];
    client.onStatusChange = (s) => statuses.push(s);
    client.connect("ws://localhost/ws");
    expect(statuses).toEqual(["connecting"]);
    MockWebSocket.instances[0].onopen();
    expect(statuses).toEqual(["connecting", "open"]);
  });
});

describe("ChatClient — 世代計數（斷線重連後，舊連線的殘留 frame 必須被丟棄）", () => {
  beforeEach(() => {
    stubWebSocketGlobal();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    unstubWebSocketGlobal();
  });

  it("非預期斷線 3s 後重連；舊 socket 遲來的 onmessage 被丟棄，新 socket 正常送達", () => {
    const client = new ChatClient();
    const received = [];
    client.onFrame = (f) => received.push(f);
    client.connect("ws://localhost/ws");

    expect(MockWebSocket.instances.length).toBe(1);
    const ws1 = MockWebSocket.instances[0];

    // 非預期斷線（非 client.close() 主動觸發）→ 排 3s 後重連（固定退避，非指數）
    ws1.onclose();
    expect(MockWebSocket.instances.length).toBe(1); // 3s 到之前還沒重連
    vi.advanceTimersByTime(3000);
    expect(MockWebSocket.instances.length).toBe(2); // 3s 到了，新 socket 建立

    const ws2 = MockWebSocket.instances[1];

    // 世代已經進位——舊 socket（ws1）遲來的 onmessage 必須被丟棄
    ws1.onmessage({ data: JSON.stringify({ role: "assistant", text: "舊世代殘留", timestamp: "...", thoughts: null }) });
    expect(received.length).toBe(0);

    // 新 socket（ws2）的 onmessage 正常送達
    ws2.onmessage({ data: JSON.stringify({ role: "assistant", text: "新世代", timestamp: "...", thoughts: null }) });
    expect(received.length).toBe(1);
    expect(received[0].text).toBe("新世代");
  });

  it("client.close() 之後：不排程重連、世代同時作廢，舊 socket 之後的事件全部無效", () => {
    const client = new ChatClient();
    const received = [];
    client.onFrame = (f) => received.push(f);
    client.connect("ws://localhost/ws");
    const ws1 = MockWebSocket.instances[0];

    client.close();
    expect(ws1.closeCalls).toBe(1); // close() 有真的呼叫 socket.close()

    ws1.onclose(); // 模擬瀏覽器真的把它關掉後才觸發的事件（intentional close 路徑）
    vi.advanceTimersByTime(10000);
    expect(MockWebSocket.instances.length).toBe(1); // 沒有第二顆 socket 被建立，不重連

    ws1.onmessage({ data: JSON.stringify({ role: "assistant", text: "不該送達", timestamp: "...", thoughts: null }) });
    expect(received.length).toBe(0);
  });

  it("重連可以連環發生：每一輪都只有最新世代的 socket 有效", () => {
    const client = new ChatClient();
    const received = [];
    client.onFrame = (f) => received.push(f);
    client.connect("ws://localhost/ws");

    // 連續兩次非預期斷線 → 兩輪重連
    MockWebSocket.instances[0].onclose();
    vi.advanceTimersByTime(3000);
    MockWebSocket.instances[1].onclose();
    vi.advanceTimersByTime(3000);

    expect(MockWebSocket.instances.length).toBe(3);
    const [ws1, ws2, ws3] = MockWebSocket.instances;

    ws1.onmessage({ data: JSON.stringify({ role: "assistant", text: "世代1", timestamp: "...", thoughts: null }) });
    ws2.onmessage({ data: JSON.stringify({ role: "assistant", text: "世代2", timestamp: "...", thoughts: null }) });
    expect(received.length).toBe(0); // 兩個舊世代都被丟棄

    ws3.onmessage({ data: JSON.stringify({ role: "assistant", text: "世代3", timestamp: "...", thoughts: null }) });
    expect(received.length).toBe(1);
    expect(received[0].text).toBe("世代3");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// renderHistory／loadHistory —— /api/history 歷史回填。
//
// 設計要求逐項對照：① 重用 renderFrame 管線（marker 剝除／XSS 紀律不重寫第二套）——
// 下面直接斷言剝除結果，不只信任呼叫關係；② 歷史渲染路徑在架構上摸不到
// TtsSpeaker——chat.js 整份檔案從頭到尾不 import tts.js，這裡刻意額外把 TtsSpeaker
// 一起載進測試、spy 它的 speak，證明「就算它就在旁邊，這條路徑也真的一次都沒呼叫
// 過它」，不是自我循環論證；③ fetch 失敗一律靜默降級（console.warn＋空清單），且
// 不擋同一個容器接下來的即時渲染。
//
// speaker 欄位是帳本的 wire literal（"User"／"Assistant"／"System"）——
// protocol literal, not branding，測試樣本原樣照抄後端真實格式。
// ─────────────────────────────────────────────────────────────────────────────
describe("renderHistory — entries 陣列渲染（純函式，不 fetch）", () => {
  it("依 speaker 轉譯＋重用 renderFrame：User→.row.sent、Assistant→.row.reply，雙側依序渲染", () => {
    const el = document.createElement("div");
    const entries = [
      { ts: "2026-08-01T10:00:00", speaker: "User", text: "早安" },
      { ts: "2026-08-01T10:00:05", speaker: "Assistant", text: "早，睡得好嗎？" },
      { ts: "2026-08-01T10:01:00", speaker: "User", text: "還不錯" },
      { ts: "2026-08-01T10:01:10", speaker: "Assistant", text: "那就好。" },
    ];
    renderHistory(entries, el, ctx);
    const rows = el.querySelectorAll(".row");
    expect(rows.length).toBe(4);
    // 順序斷言：/api/history 本身已是時間正序，renderHistory 不重排、
    // 不裁切，只依序 append——這裡逐一核對每一列的側別與文字，證明沒有偷換順序。
    expect(rows[0].classList.contains("sent")).toBe(true);
    expect(rows[0].textContent).toContain("早安");
    expect(rows[1].classList.contains("reply")).toBe(true);
    expect(rows[1].textContent).toContain("早，睡得好嗎？");
    expect(rows[2].classList.contains("sent")).toBe(true);
    expect(rows[2].textContent).toContain("還不錯");
    expect(rows[3].classList.contains("reply")).toBe(true);
    expect(rows[3].textContent).toContain("那就好。");
  });

  it("Assistant 一側的歷史文字仍帶 [react:]／[sticker:] 標記時，照樣走既有剝除管線（不裸奔）", () => {
    const el = document.createElement("div");
    renderHistory([{ ts: "...", speaker: "Assistant", text: "[react:😳]這是舊訊息。" }], el, ctx);
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[react:");
    expect(bubble.textContent).toContain("這是舊訊息。");
  });

  it("thoughts 一律視為 null（帳本沒有這個欄位）——不會意外冒出思緒摺疊列", () => {
    const el = document.createElement("div");
    renderHistory([{ ts: "...", speaker: "Assistant", text: "在。" }], el, ctx);
    expect(el.querySelector(".thought")).toBeNull();
  });

  // 曾經誤信「私聊帳本從不寫 System」的錯誤結論
  // （grep `append_turn\(\s*"System"` 只抓得到直接呼叫語法，抓不到這個 codebase
  // 電話系功能實際使用的 `asyncio.to_thread(conversation_log.append_turn,
  // "System", ...)` 呼叫參照寫法）。已上線的電話功能真的會把「（電話接通）」等
  // 旁白寫進帳本——這個分支不能歸進下面的靜默略過，否則歷史回填
  // 會讓這些真實存在的事件無聲消失（這類 bug 在類似實作中並不少見）。
  it("speaker:System（電話事件旁白，真實會出現，不是理論值）→ 渲染成 .sys-msg，不是靜默略過", () => {
    const el = document.createElement("div");
    renderHistory([{ ts: "...", speaker: "System", text: "（電話接通）" }], el, ctx);
    const rows = el.querySelectorAll(".row");
    const sys = el.querySelectorAll(".sys-msg");
    expect(rows.length).toBe(0); // 不是聊天泡泡外觀
    expect(sys.length).toBe(1);
    expect(sys[0].textContent).toBe("（電話接通）");
  });

  it("System 與 User／Assistant 混合時，仍依原始順序依序渲染（三種角色互不干擾）", () => {
    const el = document.createElement("div");
    renderHistory(
      [
        { ts: "...", speaker: "User", text: "喂？" },
        { ts: "...", speaker: "System", text: "（電話接通）" },
        { ts: "...", speaker: "System", text: "（通話結束，講了 3 分鐘）" },
        { ts: "...", speaker: "Assistant", text: "剛剛講電話講得開心嗎？" },
      ],
      el,
      ctx,
    );
    // .row（sent/reply）與 .sys-msg 是不同節點類型，都直接是 listEl 的子節點，
    // 依 append 順序混在一起——逐一核對 el.children 的側別／class／文字。
    const children = Array.from(el.children);
    expect(children.length).toBe(4);
    expect(children[0].classList.contains("row")).toBe(true);
    expect(children[0].textContent).toContain("喂？");
    expect(children[1].classList.contains("sys-msg")).toBe(true);
    expect(children[1].textContent).toBe("（電話接通）");
    expect(children[2].classList.contains("sys-msg")).toBe(true);
    expect(children[2].textContent).toBe("（通話結束，講了 3 分鐘）");
    expect(children[3].classList.contains("row")).toBe(true);
    expect(children[3].textContent).toContain("剛剛講電話講得開心嗎？");
  });

  it("未知／缺漏 speaker（真的不會出現的只剩第三方名字——私聊沒有第三方參與者）→ 靜默略過，不拋錯", () => {
    const el = document.createElement("div");
    expect(() =>
      renderHistory(
        [
          { ts: "...", speaker: "Guest", text: "串門子" },
          { ts: "...", text: "沒有 speaker 欄位" },
        ],
        el,
        ctx,
      ),
    ).not.toThrow();
    expect(el.children.length).toBe(0);
  });

  it("非陣列／null／undefined entries，或缺 listEl → 不拋錯、不渲染", () => {
    const el = document.createElement("div");
    expect(() => renderHistory(null, el, ctx)).not.toThrow();
    expect(() => renderHistory(undefined, el, ctx)).not.toThrow();
    expect(() => renderHistory("not an array", el, ctx)).not.toThrow();
    expect(() => renderHistory([{ speaker: "User", text: "x" }], null, ctx)).not.toThrow();
    expect(el.children.length).toBe(0);
  });

  it("渲染完 scroll 到底", () => {
    const el = document.createElement("div");
    Object.defineProperty(el, "scrollHeight", { value: 999, configurable: true });
    renderHistory([{ ts: "...", speaker: "User", text: "嗨" }], el, ctx);
    expect(el.scrollTop).toBe(999);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [照片×N] 歷史標記 —— 帳本寫入格式
// `f"[照片×{n}] {text}".rstrip()`（後端格式）。原圖已被
// `burn_photos` 銷毀，歷史回填只剩下「這裡曾經有 N 張照片」這個數字可以顯示，
// 不能重新畫出圖片本身——渲染成淡化的「（照片 ×N）」占位，不讓方括號原始標記
// 文字裸奔上屏。這條剝除只在 renderHistory 這裡做，即時 WS 訊息不會有這個標記
// （見 chat.js 內 PHOTO_MARKER_RE 上方註解）。
// ─────────────────────────────────────────────────────────────────────────────
describe("renderHistory — [照片×N] 標記剝除（先前漏掉的一項，這裡補上）", () => {
  it("純標記、無配文字 → 渲染成「（照片 ×N）」占位，不見方括號原文", () => {
    const el = document.createElement("div");
    renderHistory([{ ts: "...", speaker: "User", text: "[照片×2]" }], el, ctx);
    const bubble = el.querySelector(".bubble.sent");
    expect(bubble).not.toBeNull();
    expect(bubble.textContent).toBe("（照片 ×2）");
    expect(bubble.textContent).not.toContain("[照片");
  });

  it("標記＋配文字（caption）→ 占位泡泡與文字泡泡並存，文字部分保留原 caption", () => {
    const el = document.createElement("div");
    renderHistory([{ ts: "...", speaker: "User", text: "[照片×1] 妳看這張" }], el, ctx);
    const bubbles = el.querySelectorAll(".bubble.sent");
    expect(bubbles.length).toBe(2);
    expect(bubbles[0].textContent).toBe("（照片 ×1）");
    expect(bubbles[1].textContent).toBe("妳看這張");
  });

  it("沒有標記的一般歷史文字 → 不受影響，照舊渲染（沒有回歸）", () => {
    const el = document.createElement("div");
    renderHistory([{ ts: "...", speaker: "User", text: "今天天氣不錯" }], el, ctx);
    const bubble = el.querySelector(".bubble.sent");
    expect(bubble.textContent).toBe("今天天氣不錯");
  });

  it("Assistant／System 側的文字即使剛好長得像標記格式也不受影響——剝除只套用在 User 分支", () => {
    const el = document.createElement("div");
    renderHistory([{ ts: "...", speaker: "Assistant", text: "[照片×3] 這只是他碰巧打的字" }], el, ctx);
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).toBe("[照片×3] 這只是他碰巧打的字");
  });
});

describe("loadHistory — fetch /api/history → renderHistory", () => {
  afterEach(() => {
    delete global.fetch;
  });

  it("fetch 成功、N 則雙側歷史 → 依序渲染；fetch 帶 credentials same-origin（cookie 門）", async () => {
    const entries = [
      { ts: "...", speaker: "User", text: "在嗎" },
      { ts: "...", speaker: "Assistant", text: "在。" },
    ];
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries }) }));
    const el = document.createElement("div");
    await loadHistory("/api/history", el, ctx);
    // objectContaining：新增的 15s AbortController 會多帶一個
    // `signal` 鍵，原本的逐鍵完整相等斷言會被這個新增鍵打破——這裡改成只驗證我們關心的
    // 那一鍵（credentials same-origin，cookie 門），不因為新增的逾時保護
    // 而變成偽陽性失敗。
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/history",
      expect.objectContaining({ credentials: "same-origin" })
    );
    const rows = el.querySelectorAll(".row");
    expect(rows.length).toBe(2);
    expect(rows[0].textContent).toContain("在嗎");
    expect(rows[1].textContent).toContain("在。");
  });

  it("fetch 失敗（network error／逾時）→ console.warn、0 氣泡，容器接下來照常可用", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const el = document.createElement("div");
    await loadHistory("/api/history", el, ctx);
    expect(el.children.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    // 後續照常可用：同一個容器接著渲染一則即時「已送出」訊息，證明失敗沒有留下任何
    // 會擋住後面渲染的殘留狀態。
    renderFrame({ role: "sent", text: "還是可以打字" }, el, ctx);
    expect(el.querySelector(".bubble.sent").textContent).toBe("還是可以打字");
    warnSpy.mockRestore();
  });

  it("fetch resolve 但非 ok（4xx/5xx）→ 視為失敗，console.warn、0 氣泡", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    const el = document.createElement("div");
    await loadHistory("/api/history", el, ctx);
    expect(el.children.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("resolve ok 但 body 形狀不對（entries 缺失／非陣列）→ 視為空陣列，不拋錯、0 氣泡", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    const el = document.createElement("div");
    // loadHistory 回傳 entries 陣列（app.js 拿最後一句放 ADV
    // 開場）——形狀不對＝正規化成空陣列回傳，渲染行為不變。
    await expect(loadHistory("/api/history", el, ctx)).resolves.toEqual([]);
    expect(el.children.length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 清畫面清除線（清畫面後 F5／iOS 重載＝歷史全量回填「又回來」的修法）。
// 設計：clearChatView 時記下「當下帳本尾巴的 ts」（server 時鐘、零偏差）進
// localStorage；loadHistory 回填時只渲染清除線之後的 entries。帳本（記憶）零觸碰
// ——清的是「持久顯示層」，不是資料。L1＝刪 localStorage key＝歷史顯示全回來。
describe("loadHistory 清除線（opts.clearedAt）—— 清畫面後 reload 不回填舊訊息", () => {
  const ENTRIES = [
    { ts: "2026-08-04T10:00:00", speaker: "User", text: "第一句" },
    { ts: "2026-08-04T11:00:00", speaker: "Assistant", text: "第二句" },
    { ts: "2026-08-04T12:00:00", speaker: "User", text: "第三句" },
  ];
  afterEach(() => {
    delete global.fetch;
  });

  it("無 clearedAt（null／undefined）→ 全量渲染（現行行為零改變）", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries: ENTRIES }) }));
    const el = document.createElement("div");
    const out = await loadHistory("/api/history", el, ctx, { clearedAt: null });
    expect(out.length).toBe(3);
    expect(el.querySelectorAll(".row").length).toBe(3);
  });

  it("clearedAt＝中段 ts → 只渲染其後的 entries；回傳值同步（ADV 開場吃濾後清單）", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries: ENTRIES }) }));
    const el = document.createElement("div");
    const out = await loadHistory("/api/history", el, ctx, { clearedAt: "2026-08-04T11:00:00" });
    expect(out.length).toBe(1);
    expect(out[0].text).toBe("第三句");
    const rows = el.querySelectorAll(".row");
    expect(rows.length).toBe(1);
    expect(rows[0].textContent).toContain("第三句");
  });

  it("clearedAt＝最後一筆 ts → 全濾光（0 氣泡、回傳空陣列）＝按清畫面後 F5 的主場景", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries: ENTRIES }) }));
    const el = document.createElement("div");
    const out = await loadHistory("/api/history", el, ctx, { clearedAt: "2026-08-04T12:00:00" });
    expect(out).toEqual([]);
    expect(el.querySelectorAll(".row").length).toBe(0);
  });

  it("清除線後夾雜無 ts 的 entry → 位置語意（第一筆超線者起全收，含其後無 ts 的）", async () => {
    const mixed = [
      { ts: "2026-08-04T10:00:00", speaker: "User", text: "舊句" },
      { ts: "2026-08-04T12:00:00", speaker: "Assistant", text: "新句" },
      { speaker: "System", text: "（無 ts 的系統行）" },
    ];
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries: mixed }) }));
    const el = document.createElement("div");
    const out = await loadHistory("/api/history", el, ctx, { clearedAt: "2026-08-04T11:00:00" });
    expect(out.length).toBe(2);
    // 渲染側：對方句＝.row 泡泡、System 句＝.sys-msg 灰字行（各自既有路徑）
    expect(el.querySelectorAll(".row").length).toBe(1);
    expect(el.querySelectorAll(".sys-msg").length).toBe(1);
  });
});

describe("fetchLastEntryTs —— 清畫面時抓帳本尾 ts 當清除線（server 時鐘、零時區偏差）", () => {
  afterEach(() => {
    delete global.fetch;
  });

  it("正常帳本 → 回最後一筆帶 ts entry 的 ts", async () => {
    const { fetchLastEntryTs } = await import("../js/chat.js");
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ entries: [
        { ts: "2026-08-04T10:00:00", speaker: "User", text: "a" },
        { ts: "2026-08-04T12:00:00", speaker: "Assistant", text: "b" },
      ] }),
    }));
    await expect(fetchLastEntryTs("/api/history")).resolves.toBe("2026-08-04T12:00:00");
  });

  it("尾端 entry 無 ts → 往前找最後一筆帶 ts 的", async () => {
    const { fetchLastEntryTs } = await import("../js/chat.js");
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ entries: [
        { ts: "2026-08-04T10:00:00", speaker: "User", text: "a" },
        { speaker: "System", text: "（無 ts）" },
      ] }),
    }));
    await expect(fetchLastEntryTs("/api/history")).resolves.toBe("2026-08-04T10:00:00");
  });

  it("空帳本／全無 ts → null（呼叫端＝不寫線，清畫面退化為單次清，誠實降級）", async () => {
    const { fetchLastEntryTs } = await import("../js/chat.js");
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries: [] }) }));
    await expect(fetchLastEntryTs("/api/history")).resolves.toBe(null);
  });

  it("fetch 失敗（網路錯／非 ok）→ null，不拋錯", async () => {
    const { fetchLastEntryTs } = await import("../js/chat.js");
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(fetchLastEntryTs("/api/history")).resolves.toBe(null);
    global.fetch = vi.fn(async () => ({ ok: false, status: 503 }));
    await expect(fetchLastEntryTs("/api/history")).resolves.toBe(null);
  });
});

describe("server 清除線（跨裝置「一邊清、兩邊都清」）—— POST/GET /api/v4/chat-clear", () => {
  afterEach(() => {
    delete global.fetch;
  });

  it("postServerClearLine：POST 成功 → 回 server 落的 cleared_at（帳本尾 ts）", async () => {
    const { postServerClearLine } = await import("../js/chat.js");
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ cleared_at: "2026-08-04T12:34:56" }) }));
    await expect(postServerClearLine("/api/v4/chat-clear")).resolves.toBe("2026-08-04T12:34:56");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/v4/chat-clear",
      expect.objectContaining({ method: "POST", credentials: "same-origin" })
    );
  });

  it("postServerClearLine：404（flag 未開）／網路錯 → null（呼叫端退單機線，永遠有得清）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { postServerClearLine } = await import("../js/chat.js");
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    await expect(postServerClearLine("/api/v4/chat-clear")).resolves.toBe(null);
    global.fetch = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    await expect(postServerClearLine("/api/v4/chat-clear")).resolves.toBe(null);
    warnSpy.mockRestore();
  });

  it("fetchServerClearLine：GET 有線回 ts、null 線回 null、404／失敗回 null（安靜，不 warn 洗版）", async () => {
    const { fetchServerClearLine } = await import("../js/chat.js");
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ cleared_at: "2026-08-04T09:00:00" }) }));
    await expect(fetchServerClearLine("/api/v4/chat-clear")).resolves.toBe("2026-08-04T09:00:00");
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ cleared_at: null }) }));
    await expect(fetchServerClearLine("/api/v4/chat-clear")).resolves.toBe(null);
    global.fetch = vi.fn(async () => ({ ok: false, status: 404 }));
    await expect(fetchServerClearLine("/api/v4/chat-clear")).resolves.toBe(null);
  });

  it("resolve ok 但 json() 本身丟例外（壞掉的 body）→ 一樣走失敗降級，不會讓呼叫端接住例外", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => {
        throw new SyntaxError("bad json");
      },
    }));
    const el = document.createElement("div");
    // 失敗降級同樣回傳空陣列（回傳值契約，見上）。
    await expect(loadHistory("/api/history", el, ctx)).resolves.toEqual([]);
    expect(el.children.length).toBe(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// loadHistory 原本沒有任何逾時保護——
// `main()` 是 `await loadHistory(...)` 完才接 `chat.connect()`（見 app.js 檔頭說明），
// 一個卡住不 resolve 的 fetch 會讓整個開機流程卡死在「連線中⋯⋯」之前，連聊天輸入框
// 都進不去。這是同一個 bug class 第三次現身（tts.js 的 `speak()`、phone.js 的
// `/api/call/start` 都已經修過），這裡鏡照 tts.js 既有的 AbortController 模式：
// timer 蓋住 fetch() 到 res.json() 兩步（不是只到 headers 到手就 clearTimeout），
// 逾時／中止都走既有的外層 catch（console.warn＋空清單，行為不變）。
// ─────────────────────────────────────────────────────────────────────────────
describe("loadHistory — 15s 逾時保護（鏡照 tts.js 既有 AbortController 模式）", () => {
  afterEach(() => {
    // 集中在 afterEach（而非個別測試本體結尾）復原真實 timer——同 tts.test.js／
    // phone.test.js 的既有教訓：若斷言先炸了，留在 it() 尾端的復原永遠不會跑。
    vi.useRealTimers();
    delete global.fetch;
  });

  it("fetch 卡住超過 15s（never-settling，唯一能讓它落地的只有 abort）→ 逾時中止、console.warn、resolve（不掛住開機流程）", async () => {
    vi.useFakeTimers();
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    global.fetch = vi.fn(
      (_url, opts) =>
        new Promise((_resolve, reject) => {
          if (opts && opts.signal) {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
          // 故意永遠不 resolve——忠實模擬「請求卡住」，不是憑空假設的中止時機。
        })
    );
    const el = document.createElement("div");

    const done = loadHistory("/api/history", el, ctx);
    await vi.advanceTimersByTimeAsync(15000); // 真正推進到 15s，讓 setTimeout(abort) 觸發
    await expect(done).resolves.toEqual([]); // 逾時降級也回傳空陣列（回傳值契約見上）

    expect(el.children.length).toBe(0); // 失敗＝空清單，這個約定不變
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });
});

describe("歷史回填絕不觸發 TTS（binding constraint：路徑結構分離，不是旗標擋）", () => {
  afterEach(() => {
    delete global.fetch;
  });

  it("renderHistory 渲染多則 Assistant 側回覆 → TtsSpeaker.speak 全程 0 次呼叫", () => {
    const speakSpy = vi.spyOn(TtsSpeaker.prototype, "speak").mockImplementation(() => {});
    const el = document.createElement("div");
    renderHistory(
      [
        { ts: "...", speaker: "User", text: "嗨" },
        { ts: "...", speaker: "Assistant", text: "在。" },
        { ts: "...", speaker: "Assistant", text: "今天想聊點什麼？" },
      ],
      el,
      ctx,
    );
    expect(speakSpy).not.toHaveBeenCalled();
    speakSpy.mockRestore();
  });

  it("loadHistory 走完整 fetch→渲染流程 → TtsSpeaker.speak 全程 0 次呼叫", async () => {
    const speakSpy = vi.spyOn(TtsSpeaker.prototype, "speak").mockImplementation(() => {});
    global.fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({ entries: [{ ts: "...", speaker: "Assistant", text: "在。" }] }),
    }));
    const el = document.createElement("div");
    await loadHistory("/api/history", el, ctx);
    expect(speakSpy).not.toHaveBeenCalled();
    speakSpy.mockRestore();
  });
});


// ─────────────────────────────────────────────────────────────────────────────
// 句尾語音重播（.msg-play-btn）
// ─────────────────────────────────────────────────────────────────────────────
describe("句尾語音重播鈕", () => {
  it("reply frame 帶 audio 清單 → play 鈕在泡泡**外**右側（.bubble-line 橫排）", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "……我在。", audio: ["/api/call/audio/aa.mp3", "/api/call/audio/bb.mp3"] },
      el, ctx,
    );
    const line = el.querySelector(".row.reply .bubble-line");
    expect(line).not.toBeNull();
    const btn = line.querySelector(".msg-play-btn");
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("播放語音");
    expect(el.querySelector(".bubble.reply .msg-play-btn")).toBeNull(); // 不在泡泡內
    expect(line.lastElementChild).toBe(btn); // 泡泡在前、鈕在右
  });

  it("locale=en 時 play 鈕 aria-label 走英文字典（i18n）", () => {
    setLocale("en", { persist: false });
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "……我在。", audio: ["/api/call/audio/aa.mp3"] },
      el, ctx,
    );
    const btn = el.querySelector(".msg-play-btn");
    expect(btn.getAttribute("aria-label")).toBe("Play voice");
  });

  it("reply frame 無 audio ／空清單 → 不掛 play 鈕（普通訊息 byte-identical）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "純文字" }, el, ctx);
    renderFrame({ role: "assistant", text: "空清單", audio: [] }, el, ctx);
    expect(el.querySelector(".msg-play-btn")).toBeNull();
  });

  it("system frame（語音留言行）帶 audio → 行尾出現 play 鈕", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "system", text: "（他的語音留言）：回電給我。", audio: ["/api/call/voicemail/audio/x.mp3?cid=c9"] },
      el, ctx,
    );
    expect(el.querySelector(".sys-msg .msg-play-btn")).not.toBeNull();
  });

  it("renderHistory 透傳 entry.audio：Assistant／System entry 的 play 鈕都到位", () => {
    const el = document.createElement("div");
    renderHistory(
      [
        { ts: "t1", speaker: "Assistant", text: "通話裡說的話", audio: ["/api/call/audio/aa.mp3"] },
        { ts: "t2", speaker: "System", text: "（他的語音留言）：……", audio: ["/api/call/voicemail/audio/x.mp3?cid=c1"] },
        { ts: "t3", speaker: "Assistant", text: "普通訊息沒語音" },
      ],
      el, ctx,
    );
    expect(el.querySelectorAll(".msg-play-btn").length).toBe(2);
  });

  it("點 play：hooks.before 回 false（如通話中）＝禁播、不變 stop 態", () => {
    const el = document.createElement("div");
    const before = vi.fn(() => false);
    renderFrame(
      { role: "assistant", text: "……", audio: ["/api/call/audio/aa.mp3"] },
      el, { ...ctx, replayHooks: { before } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click();
    expect(before).toHaveBeenCalledTimes(1);
    expect(btn.classList.contains("playing")).toBe(false);
  });

  it("點 play：attach 收到播放元件（動嘴）、onUrl 逐句回呼（played 回報掛點）；再點＝停＋detach", async () => {
    // jsdom 沒有真 Audio 播放——換上可控假貨（同 phone.test.js FakeAudio 精神的極簡版）
    const created = [];
    const RealAudio = global.Audio;
    global.Audio = class {
      constructor() { this.src = ""; this._plays = 0; created.push(this); }
      play() { this._plays += 1; return Promise.resolve(); }
      pause() {}
    };
    try {
      const el = document.createElement("div");
      const attach = vi.fn();
      const detach = vi.fn();
      const onUrl = vi.fn();
      const envelope = vi.fn(); // 樂譜制：每句譜跟句走的掛點
      renderFrame(
        { role: "assistant", text: "……", audio: ["/api/call/audio/aa.mp3"] },
        el, { ...ctx, replayHooks: { before: () => true, attach, detach, onUrl, envelope } },
      );
      const btn = el.querySelector(".msg-play-btn");
      btn.click(); // 開播
      await Promise.resolve(); // 播放核心改 async 供應器（與合成重播共用），存檔批等一輪 microtask
      await Promise.resolve();
      expect(attach).toHaveBeenCalledTimes(1);
      expect(onUrl).toHaveBeenCalledWith("/api/call/audio/aa.mp3");
      expect(envelope).toHaveBeenCalledWith("/api/call/audio/aa.mp3"); // 譜掛點逐句觸發
      expect(btn.classList.contains("playing")).toBe(true);
      btn.click(); // 再點＝停
      expect(detach).toHaveBeenCalledTimes(1);
      expect(btn.classList.contains("playing")).toBe(false);
    } finally {
      global.Audio = RealAudio;
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 合成重播鍵：沒有存檔的普通聊天句也要有播放鍵——點了由 hooks.synth（app.js 注入
// TtsSynthCache）現場合成。hooks.synth 未注入＝整族不渲染（probe 契約，同玫瑰
// 鈕）；與存檔重播共用同一套單例紀律（同時一顆、再點停、before 禁播、attach
// 動嘴）。
// ─────────────────────────────────────────────────────────────────────────────
describe("合成重播鍵", () => {
  const flush = () => new Promise((r) => setTimeout(r, 0));
  // 同上組測試的 FakeAudio 手法：_replayEl 是模組級持久單例（可能已被前面的存檔
  // 重播測試建立），元素本體一律透過 hooks.attach 捕捉、不依賴 global.Audio 的
  // created 陣列——不管單例是哪一輪建的都驗得到真相。
  let RealAudio;
  beforeEach(() => {
    RealAudio = global.Audio;
    global.Audio = class {
      constructor() { this.src = ""; this._plays = 0; }
      play() { this._plays += 1; return Promise.resolve(); }
      pause() {}
    };
  });
  afterEach(() => { global.Audio = RealAudio; });

  it("無 audio 的 reply ＋ hooks.synth 注入 → 播放鍵出現在泡泡外右側（.bubble-line）", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, { ...ctx, replayHooks: { synth: async () => "blob:x" } },
    );
    const line = el.querySelector(".row.reply .bubble-line");
    expect(line).not.toBeNull();
    const btn = line.querySelector(".msg-play-btn");
    expect(btn).not.toBeNull();
    expect(btn.getAttribute("aria-label")).toBe("播放語音");
    expect(el.querySelector(".bubble.reply .msg-play-btn")).toBeNull(); // 不在泡泡內
  });

  it("replayHooks 存在但沒有 synth → 不掛鍵也不建 wrapper（probe 未過＝舊 DOM byte-identical）", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, { ...ctx, replayHooks: { before: () => true } },
    );
    expect(el.querySelector(".msg-play-btn")).toBeNull();
    expect(el.querySelector(".bubble-line")).toBeNull();
  });

  it("sent（使用者自己的訊息）不掛合成鍵——TTS 是角色的嗓子", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "sent", text: "我的訊息" },
      el, { ...ctx, replayHooks: { synth: async () => "blob:x" } },
    );
    expect(el.querySelector(".msg-play-btn")).toBeNull();
  });

  it("system 行（無 audio）不掛合成鍵——旁白不是角色的台詞", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "system", text: "（場外說明）" },
      el, { ...ctx, replayHooks: { synth: async () => "blob:x" } },
    );
    expect(el.querySelector(".msg-play-btn")).toBeNull();
  });

  it("點擊 → synth 收到剝除標記後的正文；合成中 loading、到手後播 synth 回的 URL＋動嘴；播完自動還原", async () => {
    const el = document.createElement("div");
    let audioEl = null;
    const synth = vi.fn(async () => "blob:synth-1");
    const attach = vi.fn((a) => { audioEl = a; });
    const detach = vi.fn();
    renderFrame(
      { role: "assistant", text: "[react:❤] 想妳了。" },
      el, { ...ctx, replayHooks: { synth, attach, detach, before: () => true } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click();
    expect(btn.classList.contains("playing")).toBe(true);
    expect(btn.classList.contains("loading")).toBe(true); // 合成飛行中的脈動態
    expect(btn.getAttribute("aria-busy")).toBe("true"); // a11y：合成飛行中標忙碌，螢幕閱讀器不誤唸成「已在播放」
    await flush();
    // 唸的是 stripMarkers 剝過標記的正文（與泡泡顯示、玫瑰存文同一來源），
    // 不是帶 [react:...] 的協定原文（react 標記＝句首錨定，同協定筆記）——
    // 精確空白政策跟著 stripMarkers 走，測試用它算期望值、不自己二次發明。
    const expected = stripMarkers("[react:❤] 想妳了。").text;
    expect(expected).not.toContain("[react:");
    expect(expected).toContain("想妳了。");
    expect(synth).toHaveBeenCalledWith(expected);
    expect(btn.classList.contains("loading")).toBe(false);
    expect(btn.hasAttribute("aria-busy")).toBe(false); // URL 到手＝不再忙碌
    expect(audioEl).not.toBeNull(); // attach＝動嘴掛上
    expect(audioEl.src).toBe("blob:synth-1");
    audioEl.onended(); // 播完
    expect(btn.classList.contains("playing")).toBe(false);
    expect(btn.hasAttribute("aria-busy")).toBe(false); // _stopReplay 還原也摘掉（見上，這裡已摘過，驗冪等不殘留）
    expect(detach).toHaveBeenCalled();
  });

  it("合成失敗（synth resolve null）→ 按鈕靜默還原、不拋錯、不動嘴", async () => {
    const el = document.createElement("div");
    const attach = vi.fn();
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, { ...ctx, replayHooks: { synth: async () => null, attach, before: () => true } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click();
    await flush();
    expect(btn.classList.contains("playing")).toBe(false);
    expect(btn.classList.contains("loading")).toBe(false);
    expect(attach).not.toHaveBeenCalled();
  });

  it("synth reject（呼叫端寫壞／極端錯誤）→ 一樣還原按鈕、例外不裸奔", async () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, { ...ctx, replayHooks: { synth: async () => { throw new Error("boom"); }, before: () => true } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click();
    await flush();
    expect(btn.classList.contains("playing")).toBe(false);
  });

  it("點了立刻反悔（供應器起跑前取消）→ 連合成請求都不打（重合成要錢，能省就省）", async () => {
    const el = document.createElement("div");
    const synth = vi.fn(async () => "blob:x");
    const attach = vi.fn();
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, { ...ctx, replayHooks: { synth, attach, before: () => true } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click(); // 開始（供應器排在 microtask，還沒真的跑）
    btn.click(); // 同一 tick 反悔
    expect(btn.classList.contains("playing")).toBe(false);
    await flush();
    expect(synth).not.toHaveBeenCalled(); // 世代前置檢查擋下＝零合成請求
    expect(attach).not.toHaveBeenCalled();
  });

  it("合成飛行中再點同鈕＝取消：遲到的 URL 作廢、絕不突然出聲", async () => {
    const el = document.createElement("div");
    let resolveSynth;
    const synth = vi.fn(() => new Promise((r) => { resolveSynth = r; }));
    const attach = vi.fn();
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, { ...ctx, replayHooks: { synth, attach, before: () => true } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click(); // 開始合成
    await flush(); // 供應器真的起跑＝synth 已在飛（resolveSynth 已捕捉）
    expect(synth).toHaveBeenCalledTimes(1);
    expect(btn.classList.contains("playing")).toBe(true);
    btn.click(); // 等太久不想聽了＝取消
    expect(btn.classList.contains("playing")).toBe(false);
    resolveSynth("blob:late");
    await flush();
    expect(attach).not.toHaveBeenCalled(); // 遲到結果作廢＝從未進入播放
    expect(btn.classList.contains("playing")).toBe(false);
  });

  it("hooks.before 回 false（通話中）→ 合成不觸發", () => {
    const el = document.createElement("div");
    const synth = vi.fn();
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, { ...ctx, replayHooks: { synth, before: () => false } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click();
    expect(synth).not.toHaveBeenCalled();
    expect(btn.classList.contains("playing")).toBe(false);
  });

  it("frame 帶 audio（通話台詞）→ 照走存檔重播，synth 不被呼叫", async () => {
    const el = document.createElement("div");
    let audioEl = null;
    const synth = vi.fn(async () => "blob:should-not-happen");
    const attach = vi.fn((a) => { audioEl = a; });
    renderFrame(
      { role: "assistant", text: "通話裡說的。", audio: ["/api/call/audio/aa.mp3"] },
      el, { ...ctx, replayHooks: { synth, attach, before: () => true } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click();
    await flush();
    expect(synth).not.toHaveBeenCalled();
    expect(audioEl.src).toBe("/api/call/audio/aa.mp3"); // 播的是存檔原音
  });

  it("與玫瑰鈕共存：children 順序＝泡泡→播放鍵→玫瑰（愛心維持最外）", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "普通句子。" },
      el, {
        ...ctx,
        replayHooks: { synth: async () => "blob:x" },
        roseHooks: { add: async () => ({ saved: true, id: 1 }), remove: async () => true },
      },
    );
    const line = el.querySelector(".bubble-line");
    expect(line.children.length).toBe(3);
    expect(line.children[0].classList.contains("bubble")).toBe(true);
    expect(line.children[1].classList.contains("msg-play-btn")).toBe(true);
    expect(line.children[2].classList.contains("msg-rose-btn")).toBe(true);
  });

  it("renderHistory：歷史普通句（無 audio）＋synth hook → 一樣有播放鍵（昨天的話也能點來聽）；System 無 audio 行沒有", () => {
    const el = document.createElement("div");
    renderHistory(
      [
        { ts: "t1", speaker: "Assistant", text: "昨天說的話" },
        { ts: "t2", speaker: "System", text: "（未接來電）" },
      ],
      el, { ...ctx, replayHooks: { synth: async () => "blob:x" } },
    );
    expect(el.querySelectorAll(".row.reply .msg-play-btn").length).toBe(1);
    expect(el.querySelectorAll(".sys-msg .msg-play-btn").length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// primeReplayEl()：iOS 手勢窗口內解鎖句尾播放鍵共用的 _replayEl（app.js 首次
// pointerdown 處理器呼叫，跟 driver.unlock()／tts.prime() 並列，見兩處各自的
// 函式說明）。驗法鏡照本檔上方既有慣例：_replayEl 是模組級持久單例，元件本體
// 一律透過 hooks.attach 捕捉、不依賴 global.Audio 的建構時機（同「合成重播鍵」
// describe 檔頭同款說明）；自備 global.Audio stub 是防禦性寫法，不依賴「前面
// 的測試一定已經先建好單例」這個跨測試順序假設。
// ─────────────────────────────────────────────────────────────────────────────
describe("primeReplayEl()（iOS 手勢解鎖共用播放元件）", () => {
  let RealAudio;
  beforeEach(() => {
    RealAudio = global.Audio;
    global.Audio = class {
      constructor() { this.src = ""; this._plays = 0; }
      play() { this._plays += 1; return Promise.resolve(); }
      pause() {}
    };
  });
  afterEach(() => { global.Audio = RealAudio; });

  it("非播放中呼叫 → 對共用播放元件播一次靜音片段（手勢解鎖）", async () => {
    const el = document.createElement("div");
    let audioEl = null;
    const attach = vi.fn((a) => { audioEl = a; });
    renderFrame(
      { role: "assistant", text: "……", audio: ["/api/call/audio/aa.mp3"] },
      el, { ...ctx, replayHooks: { before: () => true, attach, detach: vi.fn() } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click(); // 開播，順便讓 attach 交出 _replayEl 真身
    await Promise.resolve();
    await Promise.resolve();
    expect(audioEl).not.toBeNull();
    audioEl.onended(); // 播完＝_stopReplay()，isReplaying() 回 false
    const playsBefore = audioEl._plays;

    primeReplayEl();

    expect(audioEl.src).toMatch(/^data:audio\/wav;base64,/);
    expect(audioEl._plays).toBe(playsBefore + 1);
  });

  it("播放中呼叫 → 讓路，不把飛行中那句從喇叭擠掉（isReplaying() busy guard，鏡照 tts.js prime() 同款理由）", async () => {
    const el = document.createElement("div");
    let audioEl = null;
    const attach = vi.fn((a) => { audioEl = a; });
    renderFrame(
      { role: "assistant", text: "……", audio: ["/api/call/audio/aa.mp3"] },
      el, { ...ctx, replayHooks: { before: () => true, attach, detach: vi.fn() } },
    );
    const btn = el.querySelector(".msg-play-btn");
    btn.click(); // 開播，這句正在喇叭上飛，不收播
    await Promise.resolve();
    await Promise.resolve();
    expect(audioEl).not.toBeNull();
    expect(audioEl.src).toBe("/api/call/audio/aa.mp3");
    const playsBefore = audioEl._plays;

    primeReplayEl(); // 使用者此刻另一個手勢——必須讓路

    expect(audioEl.src).toBe("/api/call/audio/aa.mp3"); // 沒被靜音片段蓋掉
    expect(audioEl._plays).toBe(playsBefore); // 沒有多一次 play() 搶佔
  });

  // 註：Audio 建構失敗（環境不支援）的靜默收場路徑不在此重複驗證——_replayEl
  // 是模組級持久單例，本檔跑到這裡時早已被前面的測試建成非 null，_ensureReplayEl()
  // 短路直接回傳既有元件、根本不會再走到 `new Audio()`，硬測只會是一條假綠燈。
  // 建構失敗的 try/catch 本身是從 _startReplay 原地搬進 _ensureReplayEl()、邏輯
  // 未變（見 chat.js 該函式），對等的建構失敗場景已由 tts.test.js「Audio 建構
  // 失敗（環境不支援）」那組測試驗過同一種手法（TtsSpeaker._ensureAudioEl 是
  // instance-level、不受跨測試單例殘留影響，能真正在乾淨狀態下踩到那個分支）。
});

// ─────────────────────────────────────────────────────────────────────────────
// CallLogRenderer——通話內容渲進真正的 Chat Log。
// 設計：「語音的文字直接顯示在 CHAT LOG、自然接下去」＋「講完當下就有播放
// 鍵」。phone.js 的面板字幕流已退場，這裡是唯一渲染路徑。
// ─────────────────────────────────────────────────────────────────────────────
describe("CallLogRenderer — 通話內容進 Chat Log", () => {
  let CallLogRenderer;
  beforeEach(async () => {
    ({ CallLogRenderer } = await import("../js/chat.js"));
  });

  it("同一輪的多句台詞長在同一顆 reply 泡泡（換行接續），final 收輪、下一輪開新泡泡", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx);

    r.characterSentence("第一句。", null, false);
    r.characterSentence("第二句。", null, true);   // final＝這輪結束
    r.characterSentence("新一輪。", null, false);

    const bubbles = el.querySelectorAll(".bubble.reply");
    expect(bubbles.length).toBe(2);
    expect(bubbles[0].textContent).toContain("第一句。\n第二句。");
    expect(bubbles[1].textContent).toContain("新一輪。");
  });

  it("句 audio URL 逐句累積：play 鈕在泡泡外右側（即時掛＋統一位置）", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx);

    r.characterSentence("第一句。", "/api/call/audio/a.mp3", false);
    let btns = el.querySelectorAll(".msg-play-btn");
    expect(btns.length).toBe(1);

    r.characterSentence("第二句。", "/api/call/audio/b.mp3", true);
    btns = el.querySelectorAll(".msg-play-btn");
    expect(btns.length).toBe(1); // 重建、不疊加——同一顆鈕、清單累積
    const line = el.querySelector(".bubble-line");
    expect(line.lastElementChild.className).toContain("msg-play-btn"); // 鈕恆為 line 末子＝泡泡外右側
    expect(el.querySelector(".bubble.reply .msg-play-btn")).toBeNull(); // 不在泡泡內
  });

  it("audio 為 null 的純字幕句不掛鈕；文字仍上屏", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx);
    r.characterSentence("（純字幕句）", null, true);
    expect(el.querySelectorAll(".msg-play-btn").length).toBe(0);
    expect(el.textContent).toContain("（純字幕句）");
  });

  it("userLine → sent 泡泡；sysLine → .sys-msg 灰字置中；sys 不打斷進行中的他的泡泡", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx);

    r.userLine("我今天有點累");
    expect(el.querySelector(".bubble.sent").textContent).toContain("我今天有點累");

    r.characterSentence("第一句。", null, false);
    r.sysLine("（今天嗓子的保險絲跳了，先用字幕陪妳）");
    r.characterSentence("第二句。", null, true);

    expect(el.querySelector(".sys-msg").textContent).toContain("保險絲跳了");
    const bubbles = el.querySelectorAll(".bubble.reply");
    expect(bubbles.length).toBe(1); // sys 行不收輪——他的兩句仍在同一顆泡泡
    expect(bubbles[0].textContent).toContain("第一句。\n第二句。");
  });

  it("characterSentence 進場先收思考中指示器（status-line）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "status", text: "他在想……" }, el, ctx);
    expect(el.querySelector(".status-line")).not.toBeNull();

    const r = new CallLogRenderer(el, ctx);
    r.characterSentence("來了。", null, true);
    expect(el.querySelector(".status-line")).toBeNull();
  });

  it("listEl 為 null／text 非字串＝安全 no-op 不拋錯", () => {
    const r = new CallLogRenderer(null, ctx);
    expect(() => r.characterSentence("x", null, true)).not.toThrow();
    const el = document.createElement("div");
    const r2 = new CallLogRenderer(el, ctx);
    expect(() => r2.characterSentence(null, null, false)).not.toThrow();
    expect(el.querySelectorAll(".bubble").length).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// [blush] 臉紅暗號：stripMarkers 剝除＋級別抽取——與 [cg:] 同族全文剝、永不上屏；
// blushLevel 只由 final reply 呼叫端拿去觸發暈層（app.js），這裡釘 regex 與解析的
// 單一真相。
// ─────────────────────────────────────────────────────────────────────────────
describe("stripMarkers — [blush] 臉紅暗號（剝除＋級別）", () => {
  it("[blush]＝mid、[blush:deep]＝deep；正文剝乾淨、前後文原樣", () => {
    const r1 = stripMarkers("突然這樣說[blush]我會不好意思。");
    expect(r1.blushLevel).toBe("mid");
    expect(r1.text).toBe("突然這樣說 我會不好意思。");
    const r2 = stripMarkers("[blush:deep]先進來坐吧。");
    expect(r2.blushLevel).toBe("deep");
    expect(r2.text).toBe("先進來坐吧。");
  });

  it("多顆取最深（先 [blush] 後 [blush:deep]＝deep；反序也是 deep）；大小寫容錯", () => {
    expect(stripMarkers("嗯[blush]……好[blush:deep]。").blushLevel).toBe("deep");
    expect(stripMarkers("嗯[blush:deep]……好[blush]。").blushLevel).toBe("deep");
    expect(stripMarkers("好[BLUSH:DEEP]。").blushLevel).toBe("deep");
    expect(stripMarkers("好[Blush]。").blushLevel).toBe("mid");
  });

  it("未知級別字（[blush:soft]）容錯當 mid、照樣剝乾淨；無標記＝null", () => {
    const r = stripMarkers("這樣啊[blush:soft]，嗯。");
    expect(r.blushLevel).toBe("mid");
    expect(r.text).not.toContain("[blush");
    expect(stripMarkers("平常的一句話。").blushLevel).toBeNull();
  });

  it("假標記不誤剝：[blushx]／[ blush ] 這種不合形狀的原樣保留、級別 null", () => {
    const r1 = stripMarkers("字面上的[blushx]保留。");
    expect(r1.text).toContain("[blushx]");
    expect(r1.blushLevel).toBeNull();
    const r2 = stripMarkers("這個[ blush ]也不是暗號。");
    expect(r2.text).toContain("[ blush ]");
    expect(r2.blushLevel).toBeNull();
  });

  it("與其他標記同句共存：[cg:]／[sticker:]／[react:] 各剝各的、blushLevel 照抽", () => {
    const r = stripMarkers("[react:😳][blush:deep]嗯，[cg:月夜床帳]那就這樣吧。");
    expect(r.blushLevel).toBe("deep");
    expect(r.reactEmoji).toBe("😳");
    expect(r.text).not.toContain("[blush");
    expect(r.text).not.toContain("[cg:");
    expect(r.text).toContain("那就這樣吧。");
  });

  it("連續兩次呼叫結果一致（全域 RE lastIndex 歸零＝重入安全）", () => {
    expect(stripMarkers("а[blush:deep]б").blushLevel).toBe("deep");
    expect(stripMarkers("а[blush:deep]б").blushLevel).toBe("deep");
  });

  // 同型補洞：剝除必須寬鬆——非法級別字（中文等）也不可裸奔上屏；BLUSH_LEVEL_RE
  // （級別解析）刻意維持嚴格，抽不到級別＝null，但正文一定要乾淨。
  it("非法級別字（[blush:很紅]）照樣剝乾淨、blushLevel=null；[blush ] 空白容錯不退化", () => {
    const r = stripMarkers("嗯[blush:很紅]。");
    expect(r.text.includes("[blush")).toBe(false);
    expect(r.blushLevel).toBeNull();
    // 回歸釘：[blush ]（] 前有空白）嚴格版本來就剝得掉，放寬時不可反而漏剝
    const r2 = stripMarkers("嗯[blush ]。");
    expect(r2.text.includes("[blush")).toBe(false);
    expect(r2.blushLevel).toBe("mid");
  });
});

describe("stripMarkers — 房間暗號（三族剝除）", () => {
  it("三族暗號一次剝乾淨（theme／outfit／furniture）", () => {
    const { text } = stripMarkers("好 [theme:crystal-swan] 換上 [outfit:evening-gown]，[furniture:tea-set:hide] 了");
    expect(text).not.toMatch(/\[(theme|outfit|furniture):/);
    expect(text).toContain("好");
  });

  it("[theme:]、[outfit:]、[furniture:] 各獨立剝除、前後文原樣", () => {
    const r1 = stripMarkers("換上 [theme:rose-vow] 了");
    expect(r1.text).not.toContain("[theme:");
    expect(r1.text).toContain("換上");
    expect(r1.text).toContain("了");

    const r2 = stripMarkers("換衣服 [outfit:evening-gown]");
    expect(r2.text).not.toContain("[outfit:");
    expect(r2.text).toContain("換衣服");

    const r3 = stripMarkers("放下 [furniture:tea-set] 吧");
    expect(r3.text).not.toContain("[furniture:");
    expect(r3.text).toContain("放下");
    expect(r3.text).toContain("吧");
  });

  it("三族混合同句，各剝各的，不相互影響", () => {
    const r = stripMarkers("[theme:crystal-swan] [outfit:evening-gown] [furniture:tea-set:hide]");
    expect(r.text).not.toMatch(/\[(theme|outfit|furniture):/);
  });

  it("與其他標記（[cg:]／[intimate:*]）並存時，各剝各的", () => {
    const r = stripMarkers("嗯[intimate:open]，[theme:rose-vow]我過來。[cg:月夜床帳]");
    expect(r.text).not.toContain("[intimate:");
    expect(r.text).not.toContain("[cg:");
    expect(r.text).not.toContain("[theme:");
    expect(r.text).toContain("我過來。");
  });

  it("連續兩次呼叫結果一致（全域 RE lastIndex 歸零＝重入安全）", () => {
    const r1 = stripMarkers("換 [theme:crystal-swan] 了");
    const r2 = stripMarkers("換 [theme:crystal-swan] 了");
    expect(r1.text).toBe(r2.text);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 通話字幕標記淨化（review 抓到的 gap）——
// characterSentence 過去直接把 raw text 塞進泡泡／ADV buffer，[cg:]／[intimate:*] 這類
// 引擎狀態標記會裸奔上屏；玫瑰鍵那邊其實早就在用 stripMarkers 算 canonical，只是
// 顯示層那份副本沒有一起剝。修法：chat.js characterSentence 內新增 `displayT =
// stripMarkers(t).text` 只管「這顆泡泡顯示什麼」，`keyText` 累積鏈維持吃原始
// `t`（見該函式內完整文件——玫瑰鍵語意刻意不變）。本區塊釘住「顯示不裸奔」
// 這一半，含首句／續句兩條分支，以及 app.js ADV buffer 那條姊妹路徑。
// ─────────────────────────────────────────────────────────────────────────────
describe("CallLogRenderer 通話字幕標記淨化", () => {
  let CallLogRenderer;
  beforeEach(async () => {
    ({ CallLogRenderer } = await import("../js/chat.js"));
  });

  it("首句夾標記＝泡泡顯示不含 [cg:X]，前後文字原樣保留", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx);
    r.characterSentence("嗯。[cg:月夜床帳]過來。", null, true);
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[cg:");
    expect(bubble.textContent).toContain("嗯。");
    expect(bubble.textContent).toContain("過來。");
  });

  it("續句（非首句）夾標記也一樣剝除，不只開頭那句吃得到（覆蓋 characterSentence 的續行分支）", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx);
    r.characterSentence("第一句沒有標記。", null, false);
    r.characterSentence("第二句夾了[cg:窗邊]標記。", null, true);
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[cg:");
    expect(bubble.textContent).toContain("第一句沒有標記。");
    expect(bubble.textContent).toContain("第二句夾了");
    expect(bubble.textContent).toContain("標記。");
  });

  it("[intimate:*] 同族標記在通話字幕也一樣不可裸奔（跟 [cg:] 同一顆 stripMarkers，非只修 cg 一種）", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx);
    r.characterSentence("好，[intimate:open]我在。", null, true);
    const bubble = el.querySelector(".bubble.reply");
    expect(bubble.textContent).not.toContain("[intimate:");
    expect(bubble.textContent).toContain("好，");
    expect(bubble.textContent).toContain("我在。");
  });

  // app.js 沒有對應 test 檔（同 sandbox.test.js 檔頭已記錄的既有慣例：main() 自
  // 執行、無 export）——這裡比照該檔的「本地 harness」手法：逐行對齊 app.js
  // onCallContent 的 ADV buffer 累積邏輯（見 engine/js/app.js 對應
  // 註解那三行原始碼），餵真正的 stripMarkers export（不是替身），驗證「積木
  // 組起來」的行為是否正確，不是重新斷言 app.js 原始碼字面一致。
  it("ADV 字幕 buffer（app.js onCallContent 邏輯鏡射）：累積結果不含標記", () => {
    let callAdvBuf = "";
    let callAdvTurnDone = true;
    function feed(text, final) {
      if (typeof text === "string" && text) {
        const advText = stripMarkers(text).text;
        callAdvBuf = callAdvTurnDone ? advText : (callAdvBuf ? callAdvBuf + "\n" + advText : advText);
        callAdvTurnDone = false;
      }
      if (final) callAdvTurnDone = true;
    }
    feed("第一句沒有標記。", false);
    feed("第二句夾了[cg:窗邊]標記。", true);
    expect(callAdvBuf).not.toContain("[cg:");
    // CG_ANY_RE 兩側無既有空白可吃、單純替換成一個空格（同 tests/cg.test.js
    // 「stripMarkers [cg:*]」那組測試已驗證過的行為）——「了」與「標」之間
    // 夾一個空格，不是原文字元被吃掉。
    expect(callAdvBuf).toBe("第一句沒有標記。\n第二句夾了 標記。");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 玫瑰愛心鈕 —— 讀到喜歡的一句、按下泡泡旁的愛心
// ＝那則話存進玫瑰相簿；F5 重載後亮過的還亮（markRoseFlags 文字匹配回填）。
// ctx.roseHooks 未注入＝這顆鈕整族不渲染（app.js 開機先 probe /api/v4/rose-flags
// 才決定要不要注入，見 app.js 該處註解——探不到＝視同後端 flag 關／開源殼）。
//
// DOM 結構決策（先鎖結論）：reply 泡泡原本只
// 在「有語音」時才多包一層 .bubble-line（play 鈕的家）；沒語音時泡泡直接是
// .row.reply 的子節點。玫瑰鈕跟 play 鈕共用同一個 .bubble-line 家，但只在真的
// 有東西要掛時才建這層 wrapper（hasAudio || roseHooks 任一為真）——兩者都沒有
// 的最基本情況維持不建 .bubble-line 的舊行為，普通訊息 DOM 與玫瑰層上線前
// 一字不差（989 行那則「byte-identical」的既有測試同一種零成本承諾，這裡是
// 它在玫瑰層的延伸）。
// ─────────────────────────────────────────────────────────────────────────────
describe("玫瑰愛心鈕", () => {
  let markRoseFlags;
  beforeEach(async () => {
    ({ markRoseFlags } = await import("../js/chat.js"));
  });

  // markRoseFlags 用 document.querySelectorAll 掃全域文件樹（見 chat.js 該函式
  // 說明——它刻意不吃 listEl 參數，production 只有一個 Chat Log 容器）。凡呼叫
  // 到 markRoseFlags 的案例都要把容器接進真正的 document.body 才掃得到，跑完
  // 務必移除，避免殘留節點污染同檔案後面的測試。
  let mountedEls = [];
  function mount(el) {
    document.body.appendChild(el);
    mountedEls.push(el);
    return el;
  }
  afterEach(() => {
    mountedEls.forEach((el) => el.remove());
    mountedEls = [];
  });

  const roseCtx = (hooks) => ({ ...ctx, roseHooks: hooks || { add: vi.fn(), remove: vi.fn() } });
  const flush = () => new Promise((r) => setTimeout(r, 0)); // 同 tts.test.js／phone.test.js 既有慣例

  it("ctx.roseHooks 在：reply 泡泡有 .msg-rose-btn；sent／system 行沒有", () => {
    const el = document.createElement("div");
    const rc = roseCtx();
    renderFrame({ role: "assistant", text: "在。", thoughts: null }, el, rc);
    renderFrame({ role: "sent", text: "在嗎" }, el, rc);
    renderFrame({ role: "system", text: "抱歉，暫時無法回應。" }, el, rc);
    expect(el.querySelectorAll(".row.reply .msg-rose-btn").length).toBe(1);
    expect(el.querySelector(".row.sent .msg-rose-btn")).toBeNull();
    expect(el.querySelector(".sys-msg .msg-rose-btn")).toBeNull();
  });

  it("ctx.roseHooks 不在：整族不渲染（含帶 audio 的回覆一起試）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "純文字", thoughts: null }, el, ctx);
    renderFrame({ role: "assistant", text: "帶語音", audio: ["/api/call/audio/a.mp3"] }, el, ctx);
    expect(el.querySelector(".msg-rose-btn")).toBeNull();
  });

  it("普通訊息（無 audio、無 roseHooks）→ 不建 .bubble-line，DOM 與玫瑰層上線前一字不差（零成本設計驗證）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "純文字", thoughts: null }, el, ctx);
    const row = el.querySelector(".row.reply");
    expect(row.querySelector(".bubble-line")).toBeNull();
    expect(row.firstElementChild.className).toBe("bubble reply");
  });

  it("有 roseHooks、無 audio → 仍建 .bubble-line 當玫瑰鈕的家（跟有 audio 時同一個家，不是另開一套定位）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "純文字", thoughts: null }, el, roseCtx());
    const line = el.querySelector(".row.reply .bubble-line");
    expect(line).not.toBeNull();
    expect(line.querySelector(".bubble.reply")).not.toBeNull();
    expect(line.querySelector(".msg-rose-btn")).not.toBeNull();
  });

  it("有 roseHooks 又有 audio → 同一顆 .bubble-line 內 play 鈕與玫瑰鈕並存（泡泡→play→玫瑰）", () => {
    const el = document.createElement("div");
    renderFrame(
      { role: "assistant", text: "……我在。", audio: ["/api/call/audio/aa.mp3"] },
      el, roseCtx(),
    );
    const line = el.querySelector(".row.reply .bubble-line");
    expect(line.children.length).toBe(3);
    expect(line.children[0].className).toBe("bubble reply");
    expect(line.children[1].classList.contains("msg-play-btn")).toBe(true);
    expect(line.children[2].classList.contains("msg-rose-btn")).toBe(true);
  });

  it("sticker／react-only 占位泡泡（無正文）→ 不掛玫瑰鈕（沒有可存的 canonical 正文）", () => {
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "[sticker:doesnotexist]", thoughts: null }, el, roseCtx());
    expect(el.querySelector(".bubble-placeholder")).not.toBeNull();
    expect(el.querySelector(".msg-rose-btn")).toBeNull();
  });

  it("點擊：optimistic 加 .is-rosed → hooks.add resolve {saved:true,id:99} → dataset.roseId 存 \"99\"", async () => {
    const el = document.createElement("div");
    const add = vi.fn().mockResolvedValue({ saved: true, id: 99 });
    renderFrame({ role: "assistant", text: "記得嗎", thoughts: null }, el, roseCtx({ add, remove: vi.fn() }));
    const btn = el.querySelector(".msg-rose-btn");
    btn.click();
    expect(btn.classList.contains("is-rosed")).toBe(true); // 樂觀先亮，resolve 之前就點亮
    expect(btn.dataset.roseId).toBeUndefined(); // id 還沒回來
    expect(add).toHaveBeenCalledWith("記得嗎"); // 送給後端的是 canonical 正文
    await flush();
    expect(btn.classList.contains("is-rosed")).toBe(true);
    expect(btn.dataset.roseId).toBe("99");
    expect(btn.getAttribute("aria-label")).toBe("移出玫瑰相簿");
  });

  it("hooks.add resolve {saved:false}（親密模式攔截）→ 回滾不點亮，且不 console.warn（業務性拒絕非技術錯誤）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    const add = vi.fn().mockResolvedValue({ saved: false });
    renderFrame({ role: "assistant", text: "今晚聊點別的", thoughts: null }, el, roseCtx({ add, remove: vi.fn() }));
    const btn = el.querySelector(".msg-rose-btn");
    btn.click();
    expect(btn.classList.contains("is-rosed")).toBe(true); // 樂觀先亮
    await flush();
    expect(btn.classList.contains("is-rosed")).toBe(false); // 回滾
    expect(btn.dataset.roseId).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("hooks.add reject → 回滾＋console.warn（技術性失敗，跟業務性拒絕分開處理）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    const add = vi.fn().mockRejectedValue(new TypeError("network down"));
    renderFrame({ role: "assistant", text: "斷線也想記得", thoughts: null }, el, roseCtx({ add, remove: vi.fn() }));
    const btn = el.querySelector(".msg-rose-btn");
    btn.click();
    await flush();
    expect(btn.classList.contains("is-rosed")).toBe(false);
    expect(btn.dataset.roseId).toBeUndefined();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("已亮再點 → hooks.remove(99) → 熄滅", async () => {
    const el = document.createElement("div");
    const add = vi.fn().mockResolvedValue({ saved: true, id: 99 });
    const remove = vi.fn().mockResolvedValue(true);
    renderFrame({ role: "assistant", text: "先點亮再熄滅", thoughts: null }, el, roseCtx({ add, remove }));
    const btn = el.querySelector(".msg-rose-btn");
    btn.click(); // 第一次點：加入
    await flush();
    expect(btn.classList.contains("is-rosed")).toBe(true);
    expect(btn.dataset.roseId).toBe("99");

    btn.click(); // 第二次點：已亮，這次是移除
    expect(btn.classList.contains("is-rosed")).toBe(false); // 樂觀先熄
    expect(remove).toHaveBeenCalledWith(99); // Number 化送出，不是字串 "99"
    await flush();
    expect(btn.classList.contains("is-rosed")).toBe(false);
    expect(btn.dataset.roseId).toBeUndefined();
    expect(btn.getAttribute("aria-label")).toBe("加入玫瑰相簿");
  });

  it("hooks.remove resolve false → 回滾點亮（比照 add 的 saved:false，業務性未成功不 warn）", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    const add = vi.fn().mockResolvedValue({ saved: true, id: 5 });
    const remove = vi.fn().mockResolvedValue(false);
    renderFrame({ role: "assistant", text: "移除會失敗的那句", thoughts: null }, el, roseCtx({ add, remove }));
    const btn = el.querySelector(".msg-rose-btn");
    btn.click();
    await flush();
    btn.click(); // 嘗試熄滅
    await flush();
    expect(btn.classList.contains("is-rosed")).toBe(true); // 回滾點亮
    expect(btn.dataset.roseId).toBe("5");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("hooks.remove reject → 回滾點亮＋console.warn", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const el = document.createElement("div");
    const add = vi.fn().mockResolvedValue({ saved: true, id: 5 });
    const remove = vi.fn().mockRejectedValue(new TypeError("network down"));
    renderFrame({ role: "assistant", text: "移除也會斷線", thoughts: null }, el, roseCtx({ add, remove }));
    const btn = el.querySelector(".msg-rose-btn");
    btn.click();
    await flush();
    btn.click();
    await flush();
    expect(btn.classList.contains("is-rosed")).toBe(true);
    expect(btn.dataset.roseId).toBe("5");
    expect(warnSpy).toHaveBeenCalledTimes(1);
    warnSpy.mockRestore();
  });

  it("連點防呆：add 尚未 resolve 前再點一次＝忽略（disabled 期間不重送），resolve 後才恢復可點", async () => {
    let resolveAdd;
    const add = vi.fn(() => new Promise((r) => { resolveAdd = r; }));
    const el = document.createElement("div");
    renderFrame({ role: "assistant", text: "連點測試", thoughts: null }, el, roseCtx({ add, remove: vi.fn() }));
    const btn = el.querySelector(".msg-rose-btn");
    btn.click();
    btn.click(); // 連點：add 還沒 resolve，dataset.roseId 還是 undefined，第二下應被 disabled 擋掉
    expect(add).toHaveBeenCalledTimes(1);
    expect(btn.disabled).toBe(true);
    resolveAdd({ saved: true, id: 5 });
    await flush();
    expect(btn.disabled).toBe(false);
    expect(btn.dataset.roseId).toBe("5");
  });

  it("markRoseFlags([{id:7,text:\"你好\"}])：canonical 相同的 reply 泡泡點亮＋roseId=7；不同文不亮", () => {
    const el = mount(document.createElement("div"));
    renderFrame({ role: "assistant", text: "你好", thoughts: null }, el, roseCtx());
    renderFrame({ role: "assistant", text: "不同的話", thoughts: null }, el, roseCtx());
    markRoseFlags([{ id: 7, text: "你好" }]);
    const btns = el.querySelectorAll(".msg-rose-btn");
    expect(btns.length).toBe(2);
    expect(btns[0].classList.contains("is-rosed")).toBe(true);
    expect(btns[0].dataset.roseId).toBe("7");
    expect(btns[1].classList.contains("is-rosed")).toBe(false);
    expect(btns[1].dataset.roseId).toBeUndefined();
  });

  it("markRoseFlags 用剝除後的 canonical 匹配：raw 帶 [react:❤️] 前綴的回覆一樣點得亮（剝除一致性）", () => {
    const el = mount(document.createElement("div"));
    renderFrame({ role: "assistant", text: "[react:❤️]你好", thoughts: null }, el, roseCtx());
    const btn = el.querySelector(".msg-rose-btn");
    // canonical 是 stripMarkers 剝除後的正文（"你好"，不含 [react:] 標記）——
    // markRoseFlags 用同一份 canonical 比對，證明「剝除」與「回填比對」用的是
    // 同一個真相來源，不會因為原始 frame.text 帶標記而配不上。
    markRoseFlags([{ id: 42, text: "你好" }]);
    expect(btn.classList.contains("is-rosed")).toBe(true);
    expect(btn.dataset.roseId).toBe("42");
  });

  it("markRoseFlags 可重入：同一批 flags 呼叫兩次，class 不重複疊、狀態不壞", () => {
    const el = mount(document.createElement("div"));
    renderFrame({ role: "assistant", text: "重入測試", thoughts: null }, el, roseCtx());
    markRoseFlags([{ id: 1, text: "重入測試" }]);
    markRoseFlags([{ id: 1, text: "重入測試" }]); // 再呼叫一次，同一批 flags
    const btn = el.querySelector(".msg-rose-btn");
    expect(btn.classList.contains("is-rosed")).toBe(true);
    // classList 是集合語意，重複 add 不會產生兩個 is-rosed——直接量 class 字串佐證。
    expect(btn.className.split(/\s+/).filter((c) => c === "is-rosed").length).toBe(1);
    expect(btn.dataset.roseId).toBe("1");
  });

  it("markRoseFlags 非法輸入（非陣列／undefined／空陣列）→ 不拋錯、不誤動任何鈕", () => {
    const el = mount(document.createElement("div"));
    renderFrame({ role: "assistant", text: "防禦測試", thoughts: null }, el, roseCtx());
    expect(() => markRoseFlags(null)).not.toThrow();
    expect(() => markRoseFlags(undefined)).not.toThrow();
    expect(() => markRoseFlags("not an array")).not.toThrow();
    expect(() => markRoseFlags([])).not.toThrow();
    const btn = el.querySelector(".msg-rose-btn");
    expect(btn.classList.contains("is-rosed")).toBe(false);
  });

  // ── markRoseFlags 正規化匹配 ─────────────────────────────────
  // 後端逐句分段時對每段 .strip()——句界緊鄰分隔符的空白（半形／全形皆算 \s）
  // 在切句當下就從沒送回前端的 WS frame，資訊在 server 端已遺失，前端單側
  // 修不掉。修法＝比對時正規化（去空白後比對），存文／POST 的 text 不動。
  it("markRoseFlags 正規化匹配：帳本原文帶全形空白　差異，泡泡 canonical 沒有這個空白，正規化後仍點亮", () => {
    const el = mount(document.createElement("div"));
    renderFrame({ role: "assistant", text: "工作辛苦了，早點休息吧不要太累。", thoughts: null }, el, roseCtx());
    const btn = el.querySelector(".msg-rose-btn");
    // 帳本存文比泡泡正文多一個開頭全形空白（如前一句尾巴黏過來的空白殘留）——
    // 正規化前兩者不是全字串相等，正規化後（去空白）才相等。
    markRoseFlags([{ id: 88, text: "　工作辛苦了，早點休息吧不要太累。" }]);
    expect(btn.classList.contains("is-rosed")).toBe(true);
    expect(btn.dataset.roseId).toBe("88");
  });

  it("markRoseFlags 防正規化過寬：正文實質不同（非僅空白差）→ 仍不匹配", () => {
    const el = mount(document.createElement("div"));
    renderFrame({ role: "assistant", text: "你好嗎", thoughts: null }, el, roseCtx());
    const btn = el.querySelector(".msg-rose-btn");
    markRoseFlags([{ id: 99, text: "你好" }]); // 少一個字，是內容差異不是空白差異
    expect(btn.classList.contains("is-rosed")).toBe(false);
    expect(btn.dataset.roseId).toBeUndefined();
  });

  it("點擊 optimistic add：送給後端的 text 保留原始空白逐字元——正規化只用在 markRoseFlags 匹配，不動存文", () => {
    const el = document.createElement("div");
    const add = vi.fn().mockResolvedValue({ saved: true, id: 1 });
    renderFrame(
      { role: "assistant", text: "你好 嗎  最近過得如何", thoughts: null },
      el, roseCtx({ add, remove: vi.fn() }),
    );
    const btn = el.querySelector(".msg-rose-btn");
    btn.click();
    // 逐字元原樣送出（含內部單一與連續空白），沒有被 _roseMatchKey 動過——
    // 相簿存文要進他日記引用，必須是可讀原文，不能存壓扁版。
    expect(add).toHaveBeenCalledWith("你好 嗎  最近過得如何");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 玫瑰愛心鈕——範圍涵蓋 Chat Log 的
// reply 泡泡（含通話台詞泡泡——同一顆 reply 泡泡元件）；初版漏接
// CallLogRenderer（拆解漏帶，非刻意排除）。本輪只補這一項。
//
// 核心風險：CallLogRenderer 用 "\n" 累積逐句文字做「畫面顯示」，但玫瑰鍵要
// 跟 F5 歷史回填（帳本存的是後端切句前的完整原文）逐字元比對——兩者若用同一
// 套 "\n" 累積，F5 後極可能配不上（亮態假掉）。已用真實輸出實測（見下方
// 「純串接驗證證據」），改用**純串接（無分隔符）**累積玫瑰鍵，跟顯示用的
// "\n" 累積分成兩條路徑，不互相污染。
// ─────────────────────────────────────────────────────────────────────────────
describe("CallLogRenderer 玫瑰愛心鈕（通話台詞泡泡補接）", () => {
  let CallLogRenderer, markRoseFlags;
  beforeEach(async () => {
    ({ CallLogRenderer, markRoseFlags } = await import("../js/chat.js"));
  });

  let mountedEls = [];
  function mount(el) {
    document.body.appendChild(el);
    mountedEls.push(el);
    return el;
  }
  afterEach(() => {
    mountedEls.forEach((el) => el.remove());
    mountedEls = [];
  });

  const roseCtx = (hooks) => ({ ...ctx, roseHooks: hooks || { add: vi.fn(), remove: vi.fn() } });

  it("(a) characterSentence 累積中（final 尚未到）→ 不掛玫瑰鈕", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, roseCtx());
    r.characterSentence("第一句台詞。", null, false);
    expect(el.querySelector(".msg-rose-btn")).toBeNull();
    r.characterSentence("第二句台詞。", null, false);
    expect(el.querySelector(".msg-rose-btn")).toBeNull(); // 還沒 final，仍不掛
  });

  it("(b) final 後有鈕；即時累積 key 與歷史回填同一 ledger 條目的 canonical 逐字元相同（雙路徑一致性核心驗收）", () => {
    const el = mount(document.createElement("div"));
    const add = vi.fn().mockResolvedValue({ saved: true, id: 501 });
    const rc = roseCtx({ add, remove: vi.fn() });
    const r = new CallLogRenderer(el, rc);

    // 三句皆通話模式系統提示要求的「口語短句」風格（無內嵌 \n、每句 >=10
    // 字不觸發後端分句合併）——真實輸出對這類文字純串接
    // 還原＝原文逐字元相同，見下方「純串接驗證證據」區塊的實測輸出。
    r.characterSentence("嗯，我剛剛一直在想妳今天過得怎麼樣。", null, false);
    r.characterSentence("工作是不是又忙到很晚才吃飯。", null, false);
    r.characterSentence("有沒有好好照顧自己啊笨蛋。", null, true); // final

    const liveBtn = el.querySelector(".msg-rose-btn");
    expect(liveBtn).not.toBeNull();
    liveBtn.click();
    expect(add).toHaveBeenCalledTimes(1);
    const capturedKey = add.mock.calls[0][0]; // 按當下真的送給後端的正文

    // 模擬掛斷＋F5：同一輪的 ledger 文字（conversation_log 存的未切句原文，
    // 已驗證＝三句純串接）走歷史回填路徑重新渲染成一顆全新泡泡。
    const ledgerText =
      "嗯，我剛剛一直在想妳今天過得怎麼樣。工作是不是又忙到很晚才吃飯。有沒有好好照顧自己啊笨蛋。";
    expect(capturedKey).toBe(ledgerText); // 即時累積 key 與模擬的帳本原文逐字元相同
    const el2 = mount(document.createElement("div"));
    renderFrame({ role: "assistant", text: ledgerText, thoughts: null }, el2, rc);
    const historyBtn = el2.querySelector(".msg-rose-btn");
    expect(historyBtn).not.toBeNull();

    // 核心斷言：拿「按當下真的送出去的正文」當 GET /api/v4/rose-flags 回傳
    // 的 text，餵給 markRoseFlags——能點亮歷史回填那顆泡泡，證明兩條路徑
    // （即時累積 vs F5 回填）對同一輪通話台詞算出來的 canonical 完全一致。
    markRoseFlags([{ id: 501, text: capturedKey }]);
    expect(historyBtn.classList.contains("is-rosed")).toBe(true);
    expect(historyBtn.dataset.roseId).toBe("501");
  });

  it("(c) ctx.roseHooks 未注入 → 通話泡泡（final 後）也零鈕", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, ctx); // ctx 無 roseHooks
    r.characterSentence("第一句。", null, false);
    r.characterSentence("第二句。", null, true);
    expect(el.querySelector(".msg-rose-btn")).toBeNull();
  });

  it("(d) final 那句同時帶 audio → play 鈕與玫瑰鈕共存，順序仍是「泡泡→play→玫瑰」", () => {
    const el = document.createElement("div");
    const r = new CallLogRenderer(el, roseCtx());
    r.characterSentence("第一句。", "/api/call/audio/a.mp3", false);
    r.characterSentence("第二句。", "/api/call/audio/b.mp3", true); // final 且帶 audio
    const line = el.querySelector(".bubble-line");
    expect(line.children.length).toBe(3);
    expect(line.children[0].className).toBe("bubble reply");
    expect(line.children[1].classList.contains("msg-play-btn")).toBe(true);
    expect(line.children[2].classList.contains("msg-rose-btn")).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 純串接驗證證據（對照後端 Python 實測，這裡用
  // 相同樣本句在 JS 側鎖住「純串接＝canonical」這個設計假設不會被日後改動
  // 悄悄破壞——不是重測後端分句邏輯本身，是鎖 chat.js 這一側
  // 的累積邏輯繼續符合已驗證的假設）。
  // ─────────────────────────────────────────────────────────────────────────
  it("純串接證據：多組真實後端分句樣本（含刪節號／驚嘆號問號）純串接後與原文逐字元相同", () => {
    // 下列三組「原文→切句結果」已用真實後端分句邏輯
    // 實跑驗證；這裡直接餵切句結果
    // 給 characterSentence（模擬 WS 逐句 frame），驗證 chat.js 純串接後能還原原文。
    const samples = [
      {
        original: "嗯，我剛剛一直在想妳今天過得怎麼樣。工作是不是又忙到很晚才吃飯。有沒有好好照顧自己啊笨蛋。",
        pieces: ["嗯，我剛剛一直在想妳今天過得怎麼樣。", "工作是不是又忙到很晚才吃飯。", "有沒有好好照顧自己啊笨蛋。"],
      },
      {
        original: "⋯⋯我還在想剛剛那件事情到底該怎麼跟妳解釋。妳說得對，是我太著急了才會這樣。",
        pieces: ["⋯⋯我還在想剛剛那件事情到底該怎麼跟妳解釋。", "妳說得對，是我太著急了才會這樣。"],
      },
      {
        original: "真的假的～我聽到的時候超級開心的啦！妳今天怎麼會突然想到要打給我呢？",
        pieces: ["真的假的～我聽到的時候超級開心的啦！", "妳今天怎麼會突然想到要打給我呢？"],
      },
    ];
    for (const { original, pieces } of samples) {
      const el = document.createElement("div");
      const add = vi.fn().mockResolvedValue({ saved: true, id: 1 });
      const r = new CallLogRenderer(el, roseCtx({ add, remove: vi.fn() }));
      pieces.forEach((p, i) => r.characterSentence(p, null, i === pieces.length - 1));
      el.querySelector(".msg-rose-btn").click();
      expect(add).toHaveBeenCalledWith(original);
    }
  });

  // ─────────────────────────────────────────────────────────────────────────
  // 另一個真觸發條件：後端逐句分段時對每段 `.strip()`——句界
  // 緊鄰分隔符的空白（半形／全形皆算）在切句當下就從沒送回 WS frame，前端純
  // 串接也還原不出這個空白。三組樣本皆用真實分句邏輯實測過：
  // pieces＝WS 逐句 frame 實際會送達的
  // 文字（已遺失緊鄰分隔符的空白）；ledgerOriginal＝帳本存的
  // 未切句原文（帶空白，F5 回填用這份）。修法前 markRoseFlags 全字串比對＝
  // 配不上；修法後 _roseMatchKey 去空白比對＝配得上。
  // ─────────────────────────────────────────────────────────────────────────
  it("驗收：三組失配樣本（句界緊鄰分隔符的空白被後端分句吃掉）正規化匹配後仍點亮", () => {
    const samples = [
      {
        pieces: ["嗯，我剛剛一直在想妳今天過得怎麼樣。", "工作是不是又忙到很晚才吃飯。"],
        ledgerOriginal: "嗯，我剛剛一直在想妳今天過得怎麼樣。 工作是不是又忙到很晚才吃飯。", // 半形空白
      },
      {
        pieces: ["真的假的！我聽到的時候超級開心的啦，妳今天怎麼會突然想到要打給我呢。"], // <10 字短句已合併進下一句
        ledgerOriginal: "真的假的！ 我聽到的時候超級開心的啦，妳今天怎麼會突然想到要打給我呢。", // 半形空白
      },
      {
        pieces: ["好久沒這樣聊天了，感覺過了好久了。", "工作辛苦了，早點休息吧不要太累。"],
        ledgerOriginal: "好久沒這樣聊天了，感覺過了好久了。　工作辛苦了，早點休息吧不要太累。", // 全形空白
      },
    ];
    samples.forEach(({ pieces, ledgerOriginal }, idx) => {
      const id = 700 + idx;
      const el = mount(document.createElement("div"));
      const r = new CallLogRenderer(el, roseCtx());
      pieces.forEach((p, i) => r.characterSentence(p, null, i === pieces.length - 1));
      const liveBtn = el.querySelector(".msg-rose-btn");
      expect(liveBtn).not.toBeNull();
      expect(liveBtn.classList.contains("is-rosed")).toBe(false); // 開機時尚未回填，先確認起點未點亮

      // F5 側：ledgerOriginal（帶句界空白）走歷史回填，產生獨立的第二顆泡泡。
      const el2 = mount(document.createElement("div"));
      renderFrame({ role: "assistant", text: ledgerOriginal, thoughts: null }, el2, roseCtx());
      const historyBtn = el2.querySelector(".msg-rose-btn");

      markRoseFlags([{ id, text: ledgerOriginal }]);
      expect(historyBtn.classList.contains("is-rosed")).toBe(true); // F5 側自己當然點得亮（同一份原文）
      // 核心斷言：即時累積那顆（缺句界空白）正規化後也要點亮——這就是這裡
      // 要修的症狀本身，若 markRoseFlags 退回全字串比對，這一行會先紅。
      expect(liveBtn.classList.contains("is-rosed")).toBe(true);
      expect(liveBtn.dataset.roseId).toBe(String(id));
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 逐行顯現：即時 WS 的多行回覆一行一行浮出——從第一行讀起、
// 不再整包跳底。歷史回填（frame.instant）／單行一律整包直貼（舊行為）。
// ─────────────────────────────────────────────────────────────────────────────
describe("renderFrame — 逐行顯現（即時多行回覆）", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("三行回覆：先只有第一行，節拍推進逐行補齊全文", () => {
    const el = document.createElement("div");
    document.body.appendChild(el); // isConnected 檢查需要真的掛在 document 上
    renderFrame({ role: "assistant", text: "一\n二\n三", thoughts: null }, el, ctx);
    const b = el.querySelector(".bubble.reply");
    expect(b.textContent).toBe("一");
    vi.advanceTimersByTime(REVEAL_LINE_MS);
    expect(b.textContent).toBe("一\n二");
    vi.advanceTimersByTime(REVEAL_LINE_MS);
    expect(b.textContent).toBe("一\n二\n三");
    el.remove();
  });

  it("連續空行先壓縮再逐行（顯示層既有語意不變）", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    renderFrame({ role: "assistant", text: "一\n\n\n二", thoughts: null }, el, ctx);
    const b = el.querySelector(".bubble.reply");
    expect(b.textContent).toBe("一");
    vi.advanceTimersByTime(REVEAL_LINE_MS);
    expect(b.textContent).toBe("一\n二");
    el.remove();
  });

  it("單行回覆整包直貼（沒有『逐行』可言，零節拍）", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    renderFrame({ role: "assistant", text: "只有一行。", thoughts: null }, el, ctx);
    expect(el.querySelector(".bubble.reply").textContent).toBe("只有一行。");
    el.remove();
  });

  it("frame.instant（歷史回填標記）→ 多行整包直貼", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    renderFrame({ role: "assistant", text: "一\n二\n三", thoughts: null, instant: true }, el, ctx);
    expect(el.querySelector(".bubble.reply").textContent).toBe("一\n二\n三");
    el.remove();
  });

  it("renderHistory 走 instant：多行歷史條目立即全文（F5 五十則不逐行）", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    renderHistory([{ speaker: "Assistant", text: "一\n二\n三", ts: "t1" }], el, ctx);
    expect(el.querySelector(".bubble.reply").textContent).toBe("一\n二\n三");
    el.remove();
  });

  it("清畫面把泡泡拆離 DOM → 節拍停、不對 detached 節點空轉", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    renderFrame({ role: "assistant", text: "一\n二\n三\n四", thoughts: null }, el, ctx);
    const b = el.querySelector(".bubble.reply");
    el.replaceChildren(); // 清畫面語意（clearChatView 同款）
    vi.advanceTimersByTime(REVEAL_LINE_MS * 6);
    expect(b.textContent).toBe("一"); // 拆離後不再長行
    el.remove();
  });

  it("長信自動加速：行間隔以總展開時間封頂、不低於下限", () => {
    // 60 行 → cap/60=100ms（< 預設 450）；1000 行 → floor 到 REVEAL_MIN_MS。
    const el = document.createElement("div");
    document.body.appendChild(el);
    const lines60 = Array.from({ length: 60 }, (_, i) => "行" + i).join("\n");
    renderFrame({ role: "assistant", text: lines60, thoughts: null }, el, ctx);
    const b = el.querySelector(".bubble.reply");
    const step = Math.max(REVEAL_MIN_MS, Math.min(REVEAL_LINE_MS, Math.floor(REVEAL_TOTAL_CAP_MS / 60)));
    vi.advanceTimersByTime(step * 59 + 5);
    expect(b.textContent.split("\n").length).toBe(60); // cap 內全展完
    el.remove();
  });

  it("逐行進行中 [react:]/[sticker:] 剝除與玫瑰鈕掛載不受影響（鈕拿完整原文）", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const hooks = { flags: [], add: vi.fn(async () => ({ ok: true })), remove: vi.fn(async () => ({ ok: true })) };
    renderFrame(
      { role: "assistant", text: "[react:❤] 一\n二", thoughts: null },
      el,
      { ...ctx, roseHooks: hooks },
    );
    expect(el.querySelector(".msg-rose-btn")).not.toBeNull(); // 鈕即刻在（不等行展完）
    const b = el.querySelector(".bubble.reply");
    expect(b.textContent).toBe("一"); // 標記已剝、第一行上屏
    vi.advanceTimersByTime(REVEAL_LINE_MS);
    expect(b.textContent).toBe("一\n二");
    el.remove();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// THINKING 頁思緒條目（手機雙頁籤）——appendThought 純函式。
// ─────────────────────────────────────────────────────────────────────────────
describe("appendThought — THINKING 頁思緒條目", () => {
  it("思緒文字 → .thought-entry 逐輪 append（textNode 上屏、原文保留）", () => {
    const pane = document.createElement("div");
    appendThought(pane, "今天的語氣聽起來有點累。");
    appendThought(pane, "第二輪的思緒。");
    const entries = pane.querySelectorAll(".thought-entry");
    expect(entries.length).toBe(2);
    expect(entries[0].textContent).toBe("今天的語氣聽起來有點累。");
    expect(entries[1].textContent).toBe("第二輪的思緒。");
  });

  it("XSS 紀律：HTML 樣式文字原樣當文字、不長出元素", () => {
    const pane = document.createElement("div");
    appendThought(pane, '<img src=x onerror="window.__pwned=1">');
    expect(pane.querySelector("img")).toBeNull();
    expect(pane.textContent).toContain("<img");
  });

  it("空白／非字串／pane 缺席 → no-op 不拋錯", () => {
    const pane = document.createElement("div");
    expect(() => appendThought(pane, "   ")).not.toThrow();
    expect(() => appendThought(pane, null)).not.toThrow();
    expect(() => appendThought(null, "字")).not.toThrow();
    expect(pane.children.length).toBe(0);
  });
});

// [expr:ID] 表情暗號：[blush] 同族全文剝、永不上屏；exprId 只由 final reply 呼叫端
// 拿去 show/release。
describe("stripMarkers — [expr:ID] 表情暗號（剝除＋抽 id）", () => {
  it("[expr:laugh] 剝乾淨、exprId='laugh'；前後文原樣；沒有暗號＝null", () => {
    const r = stripMarkers("今天很順利[expr:laugh]明天再繼續。");
    expect(r.exprId).toBe("laugh");
    expect(r.text).toBe("今天很順利 明天再繼續。"); // 剝除位以單一空白代之
    expect(r.text.includes("[expr")).toBe(false);
    expect(stripMarkers("今天天氣真好。").exprId).toBeNull();
  });

  it("多顆取最後一顆＝這句最終的臉；大小寫容錯、id 小寫化；允許 - _ 數字", () => {
    expect(stripMarkers("嗯[expr:laugh]……好[expr:worried]。").exprId).toBe("worried");
    expect(stripMarkers("好[EXPR:Laugh]。").exprId).toBe("laugh");
    expect(stripMarkers("好[expr: sad-2_x ]。").exprId).toBe("sad-2_x");
  });

  it("與 [blush]／[cg:]／[sticker:] 同句共存：各自抽對、正文全乾淨", () => {
    const r = stripMarkers("[sticker:得意][blush:deep]先坐下[expr:laugh]，我去倒杯茶。[cg:月夜床帳]");
    expect(r.exprId).toBe("laugh");
    expect(r.blushLevel).toBe("deep");
    expect(r.stickerLabel).toBe("得意");
    expect(r.text).toBe("先坐下 ，我去倒杯茶。");
    expect(/\[(expr|blush|cg|sticker)/i.test(r.text)).toBe(false);
  });

  it("EXPR_ANY_RE 是全域 gi、剝含前後空白；歷史回填同一顆 regex（單一真相）", () => {
    expect(EXPR_ANY_RE.flags).toContain("g");
    expect("a [expr:laugh] b".replace(EXPR_ANY_RE, " ")).toBe("a b");
    expect("[expr:x][expr:y]".replace(EXPR_ANY_RE, " ").trim()).toBe("");
  });

  // 剝除必須寬鬆、抽取才嚴格——後端輸出非法 id（中文／驚嘆號／空白／超長）時，
  // 暗號一樣不可裸奔上屏；抽不到 id＝exprId null＝表情淡回平靜。
  it("非法 id 照樣剝乾淨、exprId=null：中文／驚嘆號／含空白／超長 id 都不上屏", () => {
    for (const raw of [
      "先這樣[expr:笑]。",
      "哈[expr:laugh!]好啊",
      "嗯[expr:laugh 2]呢",
      "好[expr:really_happy_and_laughing_out_loud]喔",
    ]) {
      const r = stripMarkers(raw);
      expect(r.text.includes("[expr")).toBe(false);
      expect(r.exprId).toBeNull();
    }
    // 合法 id 不受影響：照樣抽得到
    expect(stripMarkers("哈[expr:laugh]好啊").exprId).toBe("laugh");
  });
});
