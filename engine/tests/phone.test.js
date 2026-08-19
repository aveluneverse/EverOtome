import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PhoneController } from "../js/phone.js";
import { TtsSpeaker } from "../js/tts.js";
import { setLocale } from "../js/i18n.js";

/**
 * phone.js 測試邊界：fetch／Audio／MediaRecorder 全部在測試邊界
 * mock 掉——不在 jsdom 裡驗真的收音／VAD 訊號（jsdom 沒有真 Web Audio、也沒有真
 * getUserMedia 裝置），那段邏輯的正確性靠讀碼對照參考實作逐行引註＋真機驗收。
 * 這裡測的是：狀態機轉移、frame 分發、來電/留言
 * UI 的 DOM 效果、單一聲源壓制——全部是可以在 jsdom 用假物件驗證的「邏輯與接線」。
 */

class FakeAudio {
  constructor(src) {
    this.src = src || "";
    this.loop = false;
    this.currentTime = 0;
    this.onended = null;
    this.onerror = null;
    this._playCount = 0;
    FakeAudio.instances.push(this);
  }
  play() {
    this._playCount += 1;
    return Promise.resolve();
  }
  pause() {}
}
FakeAudio.instances = [];

function makeDriver() {
  return { attach: vi.fn(), detach: vi.fn(), unlock: vi.fn() };
}

function makeChatClient() {
  return { send: vi.fn(() => true) };
}

function makeContainer() {
  const el = document.createElement("div");
  document.body.appendChild(el);
  return el;
}

function makePhone(overrides = {}) {
  return new PhoneController({
    driver: overrides.driver || makeDriver(),
    chatClient: overrides.chatClient || makeChatClient(),
    container: overrides.container || makeContainer(),
    config: overrides.config || { ringtonePath: "assets/sample/ring.mp3" },
    // 選用注入，預設 null——既有呼叫端（本檔絕大多數測試）
    // 不傳這個欄位，dialOut()／acceptIncomingCall() 對 null 必須安全 no-op。
    tts: overrides.tts || null,
    // 通話內容出口（character/user/sys/thinking 事件），未接線必須安全 no-op。
    onCallContent: overrides.onCallContent || null,
    // 通話狀態出口（左側欄鈕雙態＋計時 pill 資料源）。
    onCallState: overrides.onCallState || null,
    // 打字判準注入（VAD 不開錄）。
    getTypingActive: overrides.getTypingActive || null,
  });
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  };
}

function mockMic() {
  navigator.mediaDevices = {
    getUserMedia: vi.fn().mockResolvedValue({
      getTracks: () => [{ stop: vi.fn() }],
    }),
  };
}

/** 排空「fetch → .then 鏈 → getUserMedia().then」這種多層 microtask/macrotask 混合鏈。 */
async function flush(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 0));
  }
}

beforeEach(() => {
  FakeAudio.instances = [];
  global.Audio = FakeAudio;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  // 一律在 afterEach 收（不是個別測試 body 結尾）——同 tts.test.js 既有教訓（先前 review 抓到的問題）：
  // 若寫在 body 結尾、上面的 expect() 先炸了，這行永遠不會跑，殘留的 fake timers 會拖累下一個測試。
  vi.useRealTimers();
  delete global.Audio;
  delete navigator.mediaDevices;
  delete global.fetch;
  document.body.innerHTML = "";
});

describe("i18n — locale=en 時面板文字走英文字典", () => {
  it("撥號鈕 aria-label 走英文字典", () => {
    setLocale("en", { persist: false });
    const phone = makePhone();
    expect(phone.container.querySelector(".phone-dial-btn").getAttribute("aria-label")).toBe("Call");
  });
});

describe("_micSession token（上一通遲到的 getUserMedia 回呼不跨通話）", () => {
  it("遲到的 mic 成功回呼：舊 stream 被停掉、不掛上新通話", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    const oldTrack = { stop: vi.fn() };
    let resolveOld;
    navigator.mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockReturnValueOnce(new Promise((r) => { resolveOld = r; })) // 通話 A：慢
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }), // 通話 B：快
    };
    const phone = makePhone();

    phone._enterCallScreen(); // 通話 A（token A 鑄造、mic A 起飛未落地）
    phone._enterCallScreen(); // 通話 B（token B 重鑄——state 仍 in-call，只有 token 能分辨）
    await flush(); // B 的 mic 先落地

    const streamB = phone._stream;
    expect(streamB).toBeTruthy();
    resolveOld({ getTracks: () => [oldTrack] }); // A 的 mic 遲到抵達
    await flush();

    expect(oldTrack.stop).toHaveBeenCalled(); // A 的 stream 當場收掉
    expect(phone._stream).toBe(streamB); // B 的 stream 原封不動
  });

  it("遲到的 mic 失敗回呼：不把新通話掛斷", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, {})));
    let rejectOld;
    navigator.mediaDevices = {
      getUserMedia: vi
        .fn()
        .mockReturnValueOnce(new Promise((resolve, reject) => { rejectOld = reject; }))
        .mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }),
    };
    const phone = makePhone();

    phone._enterCallScreen(); // 通話 A（mic 起飛未落地）
    phone._enterCallScreen(); // 通話 B
    await flush();

    rejectOld(Object.assign(new Error("denied"), { name: "NotAllowedError" })); // A 的權限失敗遲到
    await flush();

    expect(phone.state).toBe("in-call"); // 新通話還活著——舊失敗無權掛斷它
  });
});

describe("撥出狀態機：idle → dialing → in-call → ended", () => {
  it("撥出成功＋取得麥克風 → 依序經過 dialing 再落在 in-call", async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/start")) {
        return Promise.resolve(jsonResponse(200, { call_id: "c1" }));
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone();

    expect(phone.state).toBe("idle");
    phone.dialOut();
    expect(phone.state).toBe("dialing"); // fetch 尚未 resolve，同步就看得到這個中繼態

    await flush();

    expect(phone.state).toBe("in-call");
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
  });

  it("掛斷 → ended，並打 /api/call/end", async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/start")) return Promise.resolve(jsonResponse(200, { call_id: "c1" }));
      if (String(url).includes("/api/call/end")) return Promise.resolve(jsonResponse(200, { duration_sec: 12 }));
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone();
    phone.dialOut();
    await flush();
    expect(phone.state).toBe("in-call");

    phone.hangUp();

    expect(phone.state).toBe("ended");
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/call/end",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ call_id: "c1" }),
      })
    );
  });

  it("掛斷後（ended）再次撥出照常從 dialing 起算（不被卡住）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone();
    phone.dialOut();
    await flush();
    phone.hangUp();
    expect(phone.state).toBe("ended");

    phone.dialOut();
    expect(phone.state).toBe("dialing");
  });

  it("409 忙線 → 誠實顯示後端原文「他在忙」、狀態退回 idle（detail 原文顯示，非前端自編字串）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(409, { detail: "他在忙" })));
    const phone = makePhone();

    phone.dialOut();
    expect(phone.state).toBe("dialing");
    await flush();

    expect(phone.state).toBe("idle");
    expect(phone.container.textContent).toContain("他在忙");
  });

  it("409 但 detail 是自訂原因（如「現在不方便」）→ 同樣照原文顯示，不是寫死的「他在忙」", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(409, { detail: "現在不方便" })));
    const phone = makePhone();
    phone.dialOut();
    await flush();
    expect(phone.container.textContent).toContain("現在不方便");
    expect(phone.container.textContent).not.toContain("他在忙");
  });

  it("404（功能未開）→ 顯示「電話功能還沒開」", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(404, {})));
    const phone = makePhone();
    phone.dialOut();
    await flush();
    expect(phone.state).toBe("idle");
    expect(phone.container.textContent).toContain("電話功能還沒開");
  });

  it("撥號中或通話中重複呼叫 dialOut() 是安全的 no-op（不會重打 /api/call/start）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone();
    phone.dialOut();
    phone.dialOut(); // 撥號中再點一次
    await flush();
    const startCalls = global.fetch.mock.calls.filter((c) => String(c[0]).includes("/api/call/start"));
    expect(startCalls.length).toBe(1);
  });

  // /api/call/start 沒有逾時保護時，一個卡住不 resolve 的請求會讓
  // isActive() 恆真、聊天 TTS 靜默一整個 session（跟 tts.js 已經修過的 15s AbortController
  // 是同一種病）。以下兩個測試對應修法的兩層：(a) 逾時本身要能自己脫困；(b) 就算逾時還沒到，
  // 使用者也要能主動逃生。
  it("/api/call/start 卡住超過 15 秒（真實 fetch 遇 abort 會 reject 的行為，非人為假設）→ 逾時中止、" +
    "回 idle、isActive() 為假、顯示誠實提示（非「他在忙」那套 4xx 文案）", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(
      (url, opts) =>
        new Promise((resolve, reject) => {
          if (opts && opts.signal) {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
          // 故意永遠不 resolve——唯一能讓它落地的只有 abort，忠實模擬「請求卡住」。
        })
    );
    const phone = makePhone();

    phone.dialOut();
    expect(phone.state).toBe("dialing");
    expect(phone.isActive()).toBe(true);

    await vi.advanceTimersByTimeAsync(15000);

    expect(phone.state).toBe("idle");
    expect(phone.isActive()).toBe(false);
    expect(phone.container.textContent).toContain("撥不通，再試一次？");
    expect(phone.container.textContent).not.toContain("電話功能還沒開");
  });

  it("撥號中呼叫 hangUp()（逃生用）→ 立即回 idle、中止請求、不誤打 /api/call/end（從未確認過 call_id）", async () => {
    const abortSpy = vi.spyOn(AbortController.prototype, "abort");
    global.fetch = vi.fn(
      (url, opts) =>
        new Promise((resolve, reject) => {
          if (opts && opts.signal) {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        })
    );
    const phone = makePhone();

    phone.dialOut();
    expect(phone.state).toBe("dialing");

    phone.hangUp();

    expect(abortSpy).toHaveBeenCalledTimes(1);
    expect(phone.state).toBe("idle");
    expect(phone.isActive()).toBe(false);

    // 讓 abort 觸發的 rejection 走完 catch/finally——不該覆蓋已經設好的 idle、也不該拋出
    // 未處理例外（_runDialStart 的 `this._connectAttempt !== ctrl` 身分比對該擋下這個晚到的例外
    // ——`hangUp()` 已經把 `_connectAttempt` 設回 null，跟這顆已中止的 ctrl 絕不可能相等）。
    await flush();
    expect(phone.state).toBe("idle");

    const endCalls = global.fetch.mock.calls.filter((c) => String(c[0]).includes("/api/call/end"));
    expect(endCalls.length).toBe(0);
  });

  // 舊版守衛是 `this.state !== "dialing"`——單一共用欄位分辨不出
  // 「這次回呼是不是我」，連續兩次撥出（掛斷後立刻重撥）會讓上一次遲到的失敗回呼誤判自己
  // 還算數，錯誤地把「新嘗試已經成功」蓋回失敗訊息，甚至讓新嘗試自己的成功回呼被自己的
  // 守衛（此時 state 已經被舊回呼扳回 idle）誤判為過期而丟棄——畫面上看到失敗，後端卻真的
  // 接通了。改用 `_connectAttempt` 身分比對後，這整條鏈不可能發生，不管兩邊回呼誰先落地。
  it("撥號中掛斷後立刻重新撥出，舊嘗試遲到的失敗回呼不得覆蓋新嘗試（state-based guard 換成身分比對）", async () => {
    let callCount = 0;
    global.fetch = vi.fn((url, opts) => {
      callCount += 1;
      if (callCount === 1) {
        // 第一次撥出：卡住，只有真的被 hangUp() 呼叫 abort() 才會 reject——忠實模擬真實情境，
        // 不是憑空假設的 reject 時機。
        return new Promise((resolve, reject) => {
          if (opts && opts.signal) {
            opts.signal.addEventListener("abort", () => {
              const err = new Error("The operation was aborted");
              err.name = "AbortError";
              reject(err);
            });
          }
        });
      }
      // 第二次撥出：正常成功。
      return Promise.resolve(jsonResponse(200, { call_id: "attempt-2" }));
    });
    mockMic();
    const phone = makePhone();

    phone.dialOut(); // 嘗試 #1
    expect(phone.state).toBe("dialing");

    phone.hangUp(); // 中止嘗試 #1（真的呼叫 abort()，但 rejection 此刻尚未真正處理完）
    expect(phone.state).toBe("idle");

    phone.dialOut(); // 立刻重新撥出＝嘗試 #2，早於嘗試 #1 的 rejection 被完整處理
    // dialOut 另發 /api/call/log（silence_sec 同步）——只數 start 請求。
    const startCalls = global.fetch.mock.calls.filter((c) => String(c[0]).includes("/api/call/start"));
    expect(startCalls.length).toBe(2);

    await flush(); // 讓兩邊的非同步回呼都有機會落地（不論實際落地順序，最終結果都該一樣）

    // 嘗試 #2 的成功必須被接受，嘗試 #1 遲到的失敗絕不能覆蓋它。
    expect(phone.state).toBe("in-call");
    expect(phone.isActive()).toBe(true);
    expect(phone.container.textContent).not.toContain("撥不通，再試一次？");
    expect(phone.container.textContent).not.toContain("撥不出去，等一下再試");
  });

  it("撥號中點擊關閉（×）→ 視同放棄這次撥號、面板收起、回 idle", () => {
    global.fetch = vi.fn(() => new Promise(() => {}));
    const phone = makePhone();
    phone.open();
    phone.dialOut();
    expect(phone.state).toBe("dialing");

    phone.close();

    expect(phone.state).toBe("idle");
    expect(phone.container.querySelector(".phone-panel").hidden).toBe(true);
  });

  it("通話進行中呼叫 close() 仍被擋下——不會假裝掛了電話（回歸測試；面板通話中本就不現身）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone();
    phone.open();
    phone.dialOut();
    await flush();
    expect(phone.state).toBe("in-call");

    phone.close();

    expect(phone.state).toBe("in-call"); // 通話不因 close() 中斷——掛斷唯一入口＝hangUp()
    expect(phone.container.querySelector(".phone-panel").hidden).toBe(true); // 頂條退場＝面板不現身
  });
});

describe("通話輪 frame → 字幕＋音檔佇列＋驅動嘴型（招牌場景）", () => {
  async function dialAndConnect(driver, onCallContent) {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/start")) return Promise.resolve(jsonResponse(200, { call_id: "c1" }));
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone({ driver, onCallContent });
    phone.dialOut();
    await flush();
    return phone;
  }

  it("role:call 帶 audio → 播放時呼叫 driver.attach；final 播完**不再 detach**（段間不拆、掛斷才拆）", async () => {
    const driver = makeDriver();
    const phone = await dialAndConnect(driver);

    phone.handleFrame({
      role: "call",
      seq: 0,
      text: "我在聽妳說話。",
      audio: "/api/call/audio/aaaa.mp3",
      final: true,
    });

    expect(driver.attach).toHaveBeenCalledTimes(1);
    expect(driver.attach).toHaveBeenCalledWith(FakeAudio.instances[FakeAudio.instances.length - 1]);
    expect(FakeAudio.instances[FakeAudio.instances.length - 1].src).toBe("/api/call/audio/aaaa.mp3");

    // 觸發這句播完 → 收這輪——驅動器留掛（嘴由「在播才動」的門自然閉合），
    // 下一輪零重建；真正的拆點＝掛斷（_teardownMedia）。
    const el = FakeAudio.instances[FakeAudio.instances.length - 1];
    el.onended();

    expect(driver.detach).not.toHaveBeenCalled();
    phone.hangUp();
    expect(driver.detach).toHaveBeenCalled(); // 收線才拆
  });

  it("樂譜制：播放每句把該句嘴型譜（promise）送進 driver.setEnvelope；舊版 driver 沒這方法不炸", async () => {
    const driver = { ...makeDriver(), setEnvelope: vi.fn() };
    const phone = await dialAndConnect(driver);

    phone.handleFrame({
      role: "call", seq: 0, text: "第一句。", audio: "/api/call/audio/a.mp3", final: false,
    });
    expect(driver.setEnvelope).toHaveBeenCalledTimes(1);
    // 譜是 promise（envelopeForUrl 的快取單位）——driver 內部自管 resolve／stale
    expect(typeof driver.setEnvelope.mock.calls[0][0].then).toBe("function");

    const el = FakeAudio.instances[FakeAudio.instances.length - 1];
    el.onended();
    phone.handleFrame({
      role: "call", seq: 1, text: "第二句。", audio: "/api/call/audio/b.mp3", final: true,
    });
    expect(driver.setEnvelope).toHaveBeenCalledTimes(2); // 譜跟句走：每句一送

    // guard 防禦：無 setEnvelope 的舊版 driver → 播放照走不炸
    const bare = makeDriver();
    const phone2 = await dialAndConnect(bare);
    expect(() => phone2.handleFrame({
      role: "call", seq: 0, text: "喂？", audio: "/api/call/audio/c.mp3", final: true,
    })).not.toThrow();
    expect(bare.attach).toHaveBeenCalled();
  });

  it("role:call 的 audio 為 null（純字幕句）→ 不建立新的播放元件，台詞仍交 Chat Log（onCallContent）", async () => {
    const driver = makeDriver();
    const content = vi.fn();
    const phone = await dialAndConnect(driver, content);
    const before = FakeAudio.instances.length;

    phone.handleFrame({ role: "call", seq: 0, text: "……", audio: null, final: true });

    expect(FakeAudio.instances.length).toBe(before); // 沒有因為這句多建立播放元件
    expect(driver.attach).not.toHaveBeenCalled();
    // 台詞不再渲進面板（面板零字幕流），改經 onCallContent 交 Chat Log。
    expect(phone.container.textContent).not.toContain("……");
    expect(content).toHaveBeenCalledWith({ type: "character", text: "……", audio: null, final: true });
  });

  it("role:call 逐句 character 事件帶 audio URL 與 final（句尾 play 鍵的即時原料）", async () => {
    const content = vi.fn();
    const phone = await dialAndConnect(makeDriver(), content);

    phone.handleFrame({ role: "call", seq: 0, text: "第一句。", audio: "/api/call/audio/a.mp3", final: false });
    phone.handleFrame({ role: "call", seq: 1, text: "第二句。", audio: "/api/call/audio/b.mp3", final: true });

    expect(content).toHaveBeenNthCalledWith(1, { type: "character", text: "第一句。", audio: "/api/call/audio/a.mp3", final: false });
    expect(content).toHaveBeenNthCalledWith(2, { type: "character", text: "第二句。", audio: "/api/call/audio/b.mp3", final: true });
  });

  it("不在通話中收到殘留 role:call frame → 靜默忽略（不 throw、不外送）", () => {
    const content = vi.fn();
    const phone = makePhone({ onCallContent: content });
    expect(() =>
      phone.handleFrame({ role: "call", seq: 0, text: "殘留幀", audio: null, final: true })
    ).not.toThrow();
    expect(phone.container.textContent).not.toContain("殘留幀");
    expect(content).not.toHaveBeenCalled();
  });

  it("role:system 不再由 phone 處理（通話內容住 Chat Log，system 行走 app.js 主路徑）", async () => {
    const phone = await dialAndConnect(makeDriver());
    expect(() =>
      phone.handleFrame({ role: "system", text: "（今天嗓子的保險絲跳了，先用字幕陪妳）" })
    ).not.toThrow();
    expect(phone.container.textContent).not.toContain("保險絲跳了");
  });
});

describe("來電浮層：incoming_call / incoming_call_end / 接聽 / 拒接", () => {
  it("incoming_call frame → 顯示浮層＋填理由句＋建立 loop 鈴聲 Audio", () => {
    const phone = makePhone({ config: { ringtonePath: "assets/sample/ring.mp3" } });

    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "想聽聽妳的聲音" });

    const overlay = phone.container.querySelector(".phone-incoming-overlay");
    expect(overlay.hidden).toBe(false);
    expect(overlay.textContent).toContain("想聽聽妳的聲音");
    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0].loop).toBe(true);
    expect(FakeAudio.instances[0].src).toBe("assets/sample/ring.mp3");
  });

  it("incoming_call 缺 call_id（壞幀）→ 安全略過，不顯示浮層", () => {
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", reason: "x" });
    expect(phone.container.querySelector(".phone-incoming-overlay").hidden).toBe(true);
  });

  it("incoming_call_end：只有 call_id 相符才收浮層＋停鈴（任何 status 皆收）", () => {
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });

    phone.handleFrame({ role: "incoming_call_end", call_id: "other-call", status: "missed" });
    expect(phone.container.querySelector(".phone-incoming-overlay").hidden).toBe(false); // 不相符，浮層還在

    phone.handleFrame({ role: "incoming_call_end", call_id: "abc", status: "accepted" });
    expect(phone.container.querySelector(".phone-incoming-overlay").hidden).toBe(true);
  });

  it("接聽：先進 in-call（樂觀）再送 POST accept；成功後浮層已收", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "abc" })));
    mockMic();
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });

    phone.acceptIncomingCall();

    // 樂觀轉場：不等 fetch resolve 就已經是這個狀態。
    expect(phone.state).toBe("in-call");
    expect(phone.container.querySelector(".phone-incoming-overlay").hidden).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/call/accept",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ call_id: "abc" }) })
    );

    await flush();
    expect(phone.state).toBe("in-call");
  });

  // 撥出流程有手勢優先播放解鎖（_callUnlockAudioForIOS），接聽流程也需要同一步——
  // 「對方主動打來、使用者從沒撥過號」正是主要情境之一，接聽這個點擊本身就是
  // 絕佳的手勢窗口。
  it("接聽來電（未曾撥過號）→ 同步解鎖持久播放元件並嘗試播放一次（從沒撥過號，這是唯一的手勢窗口）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "abc" })));
    mockMic();
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "想聽聽妳的聲音" });
    const before = FakeAudio.instances.length;

    phone.acceptIncomingCall();

    // 解鎖同步發生（acceptIncomingCall() 呼叫堆疊內、任何 await 之前）：接聽當下就該看到
    // 一顆新建的播放元件且已經 play() 過一次。
    expect(FakeAudio.instances.length).toBe(before + 1);
    expect(FakeAudio.instances[FakeAudio.instances.length - 1]._playCount).toBe(1);
    await flush();
  });

  it("接聽後通話回覆播放沿用同一顆已解鎖的元件（不再多建一顆）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "abc" })));
    mockMic();
    const driver = makeDriver();
    const phone = makePhone({ driver });
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });
    phone.acceptIncomingCall();
    await flush();
    const countAfterAccept = FakeAudio.instances.length;

    phone.handleFrame({ role: "call", seq: 0, text: "終於等到妳接了。", audio: "/api/call/audio/z.mp3", final: true });

    expect(FakeAudio.instances.length).toBe(countAfterAccept); // 沒有再多建一顆
    expect(driver.attach).toHaveBeenCalledWith(FakeAudio.instances[FakeAudio.instances.length - 1]);
  });

  // acceptIncomingCall() 原本的 .then()/.catch() 完全沒有守衛——
  // 一個普通的慢回應在已經掛斷之後才落地，會直接覆蓋現在的狀態（跟 dialOut 那邊是同一種
  // 病，同一帖藥：`_connectAttempt` 身分比對）。以下兩個測試各驗一種回應類型（成功／失敗）。
  it("接聽中途掛斷，遲到的接聽成功回應不得覆蓋——狀態不被拉回、_callId 不被重新設回", async () => {
    let resolveAccept;
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/accept")) {
        return new Promise((resolve) => {
          resolveAccept = resolve;
        });
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });

    phone.acceptIncomingCall(); // 進 in-call（樂觀），accept 請求卡著未落地
    expect(phone.state).toBe("in-call");

    phone.hangUp(); // 決定不接了——這通從沒被伺服器確認過，但畫面上已經進了通話態、現在收線
    expect(phone.state).toBe("ended");
    expect(phone._callId).toBeNull();

    // 現在遲到的接聽成功回應才真正落地。
    resolveAccept(jsonResponse(200, { call_id: "abc" }));
    await flush();

    expect(phone.state).toBe("ended"); // 沒有被拉回 in-call 或任何其他狀態
    expect(phone._callId).toBeNull(); // 沒有被遲到的回應重新設回 "abc"
  });

  it("接聽中途掛斷，遲到的接聽失敗回應不得誤判成『現在』失敗而重跑收線（同一個 bug class 的另一種觸發）", async () => {
    let rejectAccept;
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/accept")) {
        return new Promise((_resolve, reject) => {
          rejectAccept = reject;
        });
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });
    phone.acceptIncomingCall();
    phone.hangUp();
    expect(phone.state).toBe("ended");

    const teardownSpy = vi.spyOn(phone, "_teardownMedia");
    rejectAccept(new Error("network error"));
    await flush();

    expect(phone.state).toBe("ended"); // 沒有被硬拉回 idle
    expect(teardownSpy).not.toHaveBeenCalled(); // 沒有為了一個早就不算數的嘗試重跑收線
    expect(phone.container.textContent).not.toContain("接不通，晚一點再試"); // 沒有顯示不相干的錯誤訊息
  });

  it("接聽失敗（409/404）→ 本地回退到 idle，且絕不呼叫 /api/call/end（server 端未曾設下 active_call_id）", async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/accept")) return Promise.resolve(jsonResponse(404, { detail: "這通已經不在響鈴狀態" }));
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });
    phone.acceptIncomingCall();
    await flush();

    expect(phone.state).toBe("idle");
    const endCalls = global.fetch.mock.calls.filter((c) => String(c[0]).includes("/api/call/end"));
    expect(endCalls.length).toBe(0);
    expect(phone.container.textContent).toContain("這通已經不在響鈴狀態");
  });

  it("拒接：立即收浮層停鈴（不等回應）＋送 POST decline", () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { ok: true })));
    const phone = makePhone();
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });

    phone.declineIncomingCall();

    expect(phone.container.querySelector(".phone-incoming-overlay").hidden).toBe(true);
    expect(global.fetch).toHaveBeenCalledWith(
      "/api/call/decline",
      expect.objectContaining({ method: "POST", body: JSON.stringify({ call_id: "abc" }) })
    );
  });
});

describe("留言卡退場（留言改 Chat Log 內嵌 play，面板不再浮卡）", () => {
  it("開啟面板 fetch /api/call/log：即使有未接留言也**不渲染**任何卡片，vmSlot 恆空", async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/log")) {
        return Promise.resolve(
          jsonResponse(200, {
            calls: [
              { id: "new", direction: "incoming", status: "missed", voicemail: { text: "最新留言", audio: "new.mp3" } },
            ],
            usage: { ntd: 0 },
            config: { silence_sec: 4 },
          })
        );
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    const phone = makePhone();

    phone.open();
    await flush();

    expect(phone.container.textContent).not.toContain("最新留言");
    expect(phone._dom.vmSlot.childElementCount).toBe(0);
    // 舊制入口已移除（歷史契約：這兩個方法退場，留言重播走 chat.js replay）
    expect(phone._buildVoicemailCard).toBeUndefined();
    expect(phone._playVoicemail).toBeUndefined();
  });

  it("_refreshLog 仍同步 silence_sec（VAD 斷句秒數來源——卡退場、配置不退場）", async () => {
    global.fetch = vi.fn(() =>
      Promise.resolve(jsonResponse(200, { calls: [], usage: { ntd: 0 }, config: { silence_sec: 7 } }))
    );
    const phone = makePhone();

    phone.open();
    await flush();

    expect(phone._silenceMs).toBe(7000);
  });
});

describe("通話中打字（乙女式不開麥）——noteTypedUtterance", () => {
  it("in-call 時：發 thinking 事件（Chat Log 思考點）；打的字不發 user 事件（app.js 的 sent 泡泡已上屏，再畫＝重影）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const content = vi.fn();
    const phone = makePhone({ onCallContent: content });
    phone.dialOut();
    await flush();
    content.mockClear();

    phone.noteTypedUtterance("今天晚餐想吃什麼");

    expect(content).toHaveBeenCalledWith({ type: "thinking" });
    expect(content).toHaveBeenCalledTimes(1); // 不含 user——打的字由 app.js sent 泡泡上屏
  });

  it("非通話中（idle）＝安全 no-op", () => {
    const content = vi.fn();
    const phone = makePhone({ onCallContent: content });
    phone.noteTypedUtterance("這句不該出現");
    expect(content).not.toHaveBeenCalled();
    expect(phone.container.textContent).not.toContain("這句不該出現");
  });
});

describe("STT 轉寫 → onCallContent（使用者的話／旁白進 Chat Log）", () => {
  async function inCallPhone(content) {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/start")) return Promise.resolve(jsonResponse(200, { call_id: "c1" }));
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone({ onCallContent: content });
    phone.dialOut();
    await flush();
    return phone;
  }

  it("轉寫成功：user 事件（使用者的話進 Chat Log 當 sent 泡泡）＋thinking 事件＋送出通話輪 WS", async () => {
    const content = vi.fn();
    const phone = await inCallPhone(content);
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "我今天有點累" })));

    phone._upload(new Blob(["x"]), "audio/webm");
    await flush();

    expect(content).toHaveBeenCalledWith({ type: "user", text: "我今天有點累" });
    expect(content).toHaveBeenCalledWith({ type: "thinking" });
    expect(phone.chatClient.send).toHaveBeenCalledWith(JSON.stringify({ call: true, text: "我今天有點累" }));
  });

  it("轉寫失敗／空文字：sys 事件（沒聽清楚）——不送 WS", async () => {
    const content = vi.fn();
    const phone = await inCallPhone(content);
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "" })));

    phone._upload(new Blob(["x"]), "audio/webm");
    await flush();

    expect(content).toHaveBeenCalledWith({ type: "sys", text: "（沒聽清楚）" });
    expect(phone.chatClient.send).not.toHaveBeenCalled();
  });
});

describe("打字模式吸收（沒聽清楚）（打字互動的通話不被環境音洗版）", () => {
  async function inCallPhone(content) {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/start")) return Promise.resolve(jsonResponse(200, { call_id: "c1" }));
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone({ onCallContent: content });
    phone.dialOut();
    await flush();
    return phone;
  }

  it("打過字之後：空轉寫靜默丟棄——零（沒聽清楚）、不送 WS", async () => {
    const content = vi.fn();
    const phone = await inCallPhone(content);
    phone.noteTypedUtterance("我用打字跟你講");
    content.mockClear();
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "" })));

    phone._upload(new Blob(["x"]), "audio/webm");
    await flush();

    expect(content).not.toHaveBeenCalledWith({ type: "sys", text: "（沒聽清楚）" });
    expect(phone.chatClient.send).not.toHaveBeenCalled();
  });

  it("打過字之後：上傳失敗同樣靜默（console 留證、不上 sys 行）", async () => {
    const content = vi.fn();
    const phone = await inCallPhone(content);
    phone.noteTypedUtterance("打字中");
    content.mockClear();
    global.fetch = vi.fn(() => Promise.reject(new Error("network down")));

    phone._upload(new Blob(["x"]), "audio/webm");
    await flush();

    expect(content).not.toHaveBeenCalledWith({ type: "sys", text: "（沒聽清楚）" });
  });

  it("打字模式中真的開口且轉寫成功：正常上屏＋模式翻回語音——之後空轉寫提示恢復", async () => {
    const content = vi.fn();
    const phone = await inCallPhone(content);
    phone.noteTypedUtterance("先打字");
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "現在用講的" })));
    phone._upload(new Blob(["x"]), "audio/webm");
    await flush();
    expect(content).toHaveBeenCalledWith({ type: "user", text: "現在用講的" });

    content.mockClear();
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "" })));
    phone._upload(new Blob(["x"]), "audio/webm");
    await flush();
    expect(content).toHaveBeenCalledWith({ type: "sys", text: "（沒聽清楚）" });
  });

  it("新通話重新開場＝回語音假設（前一通打過字不遺留到下一通）", async () => {
    const content = vi.fn();
    const phone = await inCallPhone(content);
    phone.noteTypedUtterance("上一通在打字");
    phone._enterCallScreen(); // 撥出／接聽共用的進場點——下一通從這裡重新開始
    content.mockClear();
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "" })));

    phone._upload(new Blob(["x"]), "audio/webm");
    await flush();

    expect(content).toHaveBeenCalledWith({ type: "sys", text: "（沒聽清楚）" });
  });
});

describe("通話狀態出口 onCallState（左側欄鈕雙態＋計時 pill 的資料源）", () => {
  it("撥出→dialing；接通→in-call 每秒 seconds 遞增；掛斷→idle（面板全程不現身）", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const states = [];
    const phone = makePhone({ onCallState: (s) => states.push(s) });

    phone.dialOut();
    expect(states[0]).toEqual({ phase: "dialing", seconds: 0 });

    await vi.runOnlyPendingTimersAsync(); // flush fetch/mic microtask 鏈
    expect(states.some((s) => s.phase === "in-call")).toBe(true);
    expect(phone.container.querySelector(".phone-panel").hidden).toBe(true); // 頂條退場＝面板不現身

    states.length = 0;
    vi.advanceTimersByTime(3000); // 計時三秒（起算秒數不定——runOnlyPendingTimersAsync
    // 可能已消化首拍；驗「每秒＋1 的連續遞增」而非絕對值）
    expect(states.length).toBe(3);
    expect(states[1].seconds).toBe(states[0].seconds + 1);
    expect(states[2].seconds).toBe(states[0].seconds + 2);
    expect(states.every((s) => s.phase === "in-call")).toBe(true);

    states.length = 0;
    phone.hangUp();
    expect(states[states.length - 1].phase).toBe("idle");
  });

  it("撥號失敗（後端 4xx）→ 通知 idle（鈕與 pill 復位）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(503, { detail: "busy" })));
    const states = [];
    const phone = makePhone({ onCallState: (s) => states.push(s) });
    phone.dialOut();
    await flush();
    expect(states[0].phase).toBe("dialing");
    expect(states[states.length - 1].phase).toBe("idle");
  });
});

describe("打字防錄（打字期間 VAD 不開錄、誤錄段作廢）", () => {
  it("getTypingActive 為真：誤錄中的段落 _abortSegment 丟棄——onstop 不上傳、零（沒聽清楚）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const content = vi.fn();
    let typing = false;
    const phone = makePhone({ onCallContent: content, getTypingActive: () => typing });
    phone.dialOut();
    await flush();

    // 假 MediaRecorder：start/stop 觸發 onstop（jsdom 無真錄音器）
    let recStopped = false;
    global.MediaRecorder = class {
      constructor() { this.state = "recording"; this.mimeType = "audio/webm"; }
      start() {}
      stop() { this.state = "inactive"; recStopped = true; if (this.onstop) this.onstop(); }
    };
    phone._stream = phone._stream || {}; // _beginSegment 的 stream 前置
    phone._beginSegment();
    expect(phone._recorder).toBeTruthy();

    typing = true;
    phone._abortSegment(); // VAD 迴圈打字分支的動作
    expect(recStopped).toBe(true);
    global.fetch.mockClear();
    await flush();

    expect(global.fetch).not.toHaveBeenCalled(); // 作廢＝不上傳 /api/call/utterance
    expect(content).not.toHaveBeenCalledWith({ type: "sys", text: "（沒聽清楚）" });
    delete global.MediaRecorder;
  });

  it("_discardNext 只作廢一次：下一段正常錄音照常上傳", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone({});
    phone.dialOut();
    await flush();

    global.MediaRecorder = class {
      constructor() { this.state = "recording"; this.mimeType = "audio/webm"; }
      start() {}
      stop() {
        this.state = "inactive";
        if (this.ondataavailable) this.ondataavailable({ data: { size: 3 } });
        if (this.onstop) this.onstop();
      }
    };
    phone._stream = phone._stream || {};

    phone._beginSegment();
    phone._abortSegment(); // 第一段作廢
    expect(phone._discardNext).toBe(false); // 旗標一次性消費

    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { text: "喂" })));
    phone._beginSegment();
    phone._endSegment(); // 第二段正常收尾
    await flush();
    expect(global.fetch).toHaveBeenCalled(); // 正常上傳恢復
    delete global.MediaRecorder;
  });
});

describe("單一聲源：通話進行中／留言播放中，聊天 TTS 一律靜默壓制", () => {
  it("dialing／in-call 期間 isActive() 為真；ended／idle 為假", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone();

    expect(phone.isActive()).toBe(false);
    phone.dialOut();
    expect(phone.isActive()).toBe(true);
    await flush();
    expect(phone.isActive()).toBe(true);

    phone.hangUp();
    expect(phone.isActive()).toBe(false);
  });

  it("通話進行中呼叫 tts.speak() → getEnabled 回 false，零 fetch（app.js 實際接線的等價驗證）", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone();
    const tts = new TtsSpeaker({
      endpoint: "/api/v4/tts",
      driver: makeDriver(),
      getEnabled: () => !phone.isActive(),
    });

    phone.dialOut();
    await flush();
    expect(phone.state).toBe("in-call");

    global.fetch.mockClear();
    await tts.speak("嗨，在嗎？");

    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("掛斷後（ended，非 active）→ tts.speak() 恢復正常運作、照樣 fetch", async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/v4/tts")) return Promise.resolve(jsonResponse(204, {}));
      return Promise.resolve(jsonResponse(200, { call_id: "c1" }));
    });
    mockMic();
    const phone = makePhone();
    const tts = new TtsSpeaker({
      endpoint: "/api/v4/tts",
      driver: makeDriver(),
      getEnabled: () => !phone.isActive(),
    });
    phone.dialOut();
    await flush();
    phone.hangUp();
    expect(phone.isActive()).toBe(false);

    global.fetch.mockClear();
    await tts.speak("我們講完了。");

    expect(global.fetch).toHaveBeenCalledWith("/api/v4/tts", expect.anything());
  });

  it("_voicemailPlaying 旗標仍被 isActive() 尊重（歷史防禦：留言播放已移交 chat.js replay，旗標恆 false；若未來復用，isActive 契約仍在）", () => {
    const phone = makePhone();
    expect(phone.isActive()).toBe(false);
    phone._voicemailPlaying = true;
    expect(phone.isActive()).toBe(true);
    phone._voicemailPlaying = false;
    expect(phone.isActive()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `isActive()` 只擋「之後」新的 `TtsSpeaker.speak()` 呼叫（見 app.js 的
// `getEnabled`），擋不住「已經在飛」的那一句聊天 TTS——撥號／接聽這兩個「電話開始」
// 的動作本身必須主動收掉它，不然會同時聽到聊天回覆的語音跟電話搶話。`tts` 是
// `PhoneController` 建構子的選用注入（見 `makePhone` 的預設 `tts: null`）：沒接線
// 的呼叫端（本檔其餘全部測試）必須維持安全 no-op，不能因為這個新增欄位而集體炸掉。
// ─────────────────────────────────────────────────────────────────────────────
describe("撥出／接聽時收掉正在飛的聊天 TTS（單一聲源鐵則的另一半）", () => {
  // jsdom（截至本專案安裝的 25.0.1）未實作 URL.createObjectURL/revokeObjectURL——下面
  // 的整合測試會走真正的 TtsSpeaker.speak()（不像其餘測試整個 mock 掉），會真的呼叫
  // 到它。同 tts.test.js 既有的 stub 手法（本檔的頂層 beforeEach 沒有這個 stub，因為
  // 其餘測試都用假 tts 物件，不需要）。
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  it("dialOut() → 呼叫注入的 tts.stop()", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const tts = { stop: vi.fn() };
    const phone = makePhone({ tts });

    phone.dialOut();

    expect(tts.stop).toHaveBeenCalledTimes(1);
  });

  it("acceptIncomingCall() → 同樣呼叫注入的 tts.stop()", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "abc" })));
    mockMic();
    const tts = { stop: vi.fn() };
    const phone = makePhone({ tts });
    phone.handleFrame({ role: "incoming_call", call_id: "abc", reason: "x" });

    phone.acceptIncomingCall();

    expect(tts.stop).toHaveBeenCalledTimes(1);
  });

  it("未注入 tts（既有呼叫端，本檔絕大多數測試的情境）→ dialOut()／acceptIncomingCall() 安全 no-op，不拋錯", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone(); // 不傳 tts，走預設 null

    expect(() => phone.dialOut()).not.toThrow();
    await flush();
    expect(phone.state).toBe("in-call");
  });

  it("整合：聊天 TTS 真的在播放中時 dialOut() → 呼叫真正的 tts.stop()，佇列清空、busy 復位、原本卡住的那句乾淨收尾（涵蓋 tts.js＋phone.js 兩邊接線）", async () => {
    const ttsDriver = makeDriver();
    const tts = new TtsSpeaker({ endpoint: "/api/v4/tts", driver: ttsDriver, getEnabled: () => true });
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/start")) return new Promise(() => {}); // 這個測試不關心撥號後續，卡著就好
      if (String(url).includes("/api/v4/tts")) {
        return Promise.resolve({ ok: true, status: 200, blob: async () => new Blob(["x"], { type: "audio/mpeg" }) });
      }
      return Promise.resolve(jsonResponse(200, {}));
    });
    const phone = makePhone({ tts });

    const speaking = tts.speak("正在說的這句");
    await flush(2); // fetch→blob→_play() 兩層 await 各要一輪，flush 到真的 attach 過
    expect(ttsDriver.attach).toHaveBeenCalledTimes(1); // 真的播放中（onended 還沒被觸發）

    phone.dialOut();

    expect(tts._queue.length).toBe(0);
    expect(tts._busy).toBe(false);
    expect(ttsDriver.detach).toHaveBeenCalledTimes(1); // 嘴巴立刻合起來
    await speaking; // 不會永遠 pending
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 回歸測試：`_teardownMedia()` 沒有重置 `_voicemailPlaying`——留言播放與通話回覆
// 共用同一顆 `_audioEl`（見 `_ensureAudioEl` 的函式說明），若留言播放中途被
// `_teardownMedia()` 強制打斷（`pause()` 掉共用元件），`onended`／`onerror` 不會
// 自然觸發，這個旗標會卡 true 到天長地久，讓 `isActive()` 永遠回真，聊天 TTS
// 從此被永久壓制，即使電話早就掛斷回到 idle。
// ─────────────────────────────────────────────────────────────────────────────
describe("_teardownMedia 重置 _voicemailPlaying（回歸測試）", () => {
  // 同上一個 describe 區塊：這裡也走真正的 TtsSpeaker.speak()，需要同一個 URL stub。
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:mock-url");
    URL.revokeObjectURL = vi.fn();
  });
  afterEach(() => {
    delete URL.createObjectURL;
    delete URL.revokeObjectURL;
  });

  it("旗標卡 true 時撥出再掛斷 → _teardownMedia 仍復位 _voicemailPlaying、isActive() 恢復 false，聊天 TTS 恢復可用（留言播放已移交 chat.js replay——旗標常態恆 false，此測保「防卡 true」的 teardown 契約不因退場而被砍）", async () => {
    global.fetch = vi.fn((url) => {
      if (String(url).includes("/api/call/start")) return Promise.resolve(jsonResponse(200, { call_id: "c1" }));
      if (String(url).includes("/api/v4/tts")) return Promise.resolve(jsonResponse(204, {}));
      return Promise.resolve(jsonResponse(200, {}));
    });
    mockMic();
    const phone = makePhone();
    const ttsDriver = makeDriver();
    const tts = new TtsSpeaker({ endpoint: "/api/v4/tts", driver: ttsDriver, getEnabled: () => !phone.isActive() });

    phone._voicemailPlaying = true; // 模擬旗標被卡住（歷史 bug 形態）
    expect(phone.isActive()).toBe(true);

    phone.dialOut();
    await flush();
    expect(phone.state).toBe("in-call");

    phone.hangUp(); // 觸發 _teardownMedia()：必須一併復位旗標

    expect(phone.isActive()).toBe(false); // 回歸核心斷言：_voicemailPlaying 沒被落下卡 true

    global.fetch.mockClear();
    await tts.speak("之後正常運作");
    const ttsCalls = global.fetch.mock.calls.filter((c) => String(c[0]).includes("/api/v4/tts"));
    expect(ttsCalls.length).toBe(1); // 聊天 TTS 真的恢復可用，不是繼續被永久壓制
  });
});

describe("iOS 手勢解鎖：純 HTMLMediaElement 手勢優先播放，不新增第二顆 AudioContext", () => {
  it("dialOut() 同步（await 之前）建立／複用持久播放元件並嘗試播放靜音片段", async () => {
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const phone = makePhone();
    const before = FakeAudio.instances.length;

    phone.dialOut();

    // 解鎖動作是同步發生（呼叫堆疊內、任何 await 之前）：撥號當下就該看到一顆新建的播放元件
    // 且立刻被 play() 過一次（不必等 fetch resolve）。
    expect(FakeAudio.instances.length).toBe(before + 1);
    expect(FakeAudio.instances[FakeAudio.instances.length - 1]._playCount).toBe(1);
    await flush();
  });

  it("通話回覆播放（driver.attach 路徑）不另建 AudioContext——那本該完全是 MouthDriver 的職責；" +
    "VAD 為分析麥克風輸入而建的那顆是另一個獨立、合理存在的用途（沿用既有實作），" +
    "兩者不可混為一談", async () => {
    const AudioContextSpy = vi.fn(); // 不需要實作任何方法：_setupVad 的 try/catch 會吞掉後續呼叫失敗，
    // 這裡只關心「建構式本身有沒有被呼叫」。
    window.AudioContext = AudioContextSpy;
    window.webkitAudioContext = AudioContextSpy;
    global.fetch = vi.fn(() => Promise.resolve(jsonResponse(200, { call_id: "c1" })));
    mockMic();
    const driver = makeDriver(); // 假 driver：真正的 AudioContext 建構邏輯只活在 audio-mouth.js，不在這裡重現
    const phone = makePhone({ driver });

    phone.dialOut();
    await flush();
    // 接通、VAD 起跑：這裡合理建了一顆給麥克風用的 AudioContext，不是本測試要抓的問題。
    expect(AudioContextSpy).toHaveBeenCalledTimes(1);

    AudioContextSpy.mockClear();
    phone.handleFrame({ role: "call", seq: 0, text: "……", audio: "/api/call/audio/x.mp3", final: true });
    FakeAudio.instances[FakeAudio.instances.length - 1].onended();
    phone.hangUp();

    // 通話回覆播放全程（attach→播放→收線）不該再多建一顆——那本該完全交給共用的 driver。
    expect(AudioContextSpy).not.toHaveBeenCalled();

    delete window.AudioContext;
    delete window.webkitAudioContext;
  });
});
