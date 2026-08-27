import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { TtsSpeaker, TtsSynthCache } from "../js/tts.js";
import { CONSOLE_FEEDBACK_SUFFIX } from "../js/feedback.js";

// jsdom（截至本專案安裝的 25.0.1）未實作 URL.createObjectURL/revokeObjectURL——實測直接呼叫
// 會丟 TypeError。tts.js 的 200 成功路徑會呼叫到它；沒這個 stub，"佇列" 測試會在 _play()
// 之前就先被自己的 catch 吃掉例外（意外造成 _busy 卡 true「看似正確」但 _play 根本沒被呼叫
// 到，且會把佇列裡的訊息背景遞迴排空、噴 console.warn 汙染輸出——實測過）。
// 補最小 stub 讓成功路徑真的走到 _play()，比照 sprite.test.js 對 global.Image 的做法。
beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => {});
  URL.createObjectURL = vi.fn(() => "blob:mock-url");
  URL.revokeObjectURL = vi.fn();
});

afterEach(() => {
  vi.restoreAllMocks();
  delete URL.createObjectURL;
  delete URL.revokeObjectURL;
  // 集中在這裡復原真實 timer（而非留在個別測試本體最後一行）：若該測試在復原前就斷言失敗，
  // 留在 it() 尾端的 vi.useRealTimers() 永遠不會被執行，fake timers 會漏到下一個 describe——
  // 剛好「排空 FIFO」那組測試全靠真 setTimeout(0) flush microtask，會被卡死到逾時（先前修過的問題）。
  vi.useRealTimers();
});

function makeSpeaker(fetchImpl, enabled = true) {
  global.fetch = vi.fn(fetchImpl);
  const driver = { attach: vi.fn(), detach: vi.fn() };
  const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => enabled });
  s._play = vi.fn(async () => {});   // 測試中不真播（jsdom 無 Audio playback）
  return s;
}

// 共用的假播放元件——同 phone.test.js 既有的 FakeAudio 手法
// （這裡不 import 那邊的版本：兩個測試檔各自獨立、避免跨檔耦合，形狀刻意保持一致）。
// 用來讓 `_play()`／`prime()`／`stop()` 走真正的內部邏輯（不像 makeSpeaker 那樣整個
// mock 掉 `_play`），才驗得到「持久元件重用」與「stop() 讓 pending 的 _play() 乾淨
// 收尾」這兩件事本身。
// 成功回應的最小 mock（TtsSpeaker onNoVoice 測試與 TtsSynthCache 測試共用）
const okMp3 = async () => ({
  ok: true, status: 200,
  blob: async () => new Blob(["x"], { type: "audio/mpeg" }),
});

class FakeAudio {
  constructor() {
    this.src = "";
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

describe("開關", () => {
  it("關閉時零 fetch", async () => {
    const s = makeSpeaker(async () => ({ ok: true }), false);
    await s.speak("你好");
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

describe("失敗回落", () => {
  it("500 → 靜默不 throw", async () => {
    const s = makeSpeaker(async () => ({ ok: false, status: 500 }));
    await expect(s.speak("你好")).resolves.toBeUndefined();
    expect(s._play).not.toHaveBeenCalled();
  });
  it("204（純符號句）→ 靜默跳過", async () => {
    const s = makeSpeaker(async () => ({ ok: true, status: 204 }));
    await s.speak("⋯⋯");
    expect(s._play).not.toHaveBeenCalled();
  });
});

describe("佇列", () => {
  it("同時只一則、超上限丟最舊", async () => {
    let resolveFirst;
    const s = makeSpeaker(async () => ({
      ok: true, status: 200,
      blob: async () => new Blob(["x"], { type: "audio/mpeg" }),
    }));
    s._play = vi.fn(() => new Promise((r) => { resolveFirst = r; }));
    s.speak("一"); await Promise.resolve();
    s.speak("二"); s.speak("三"); s.speak("四"); s.speak("五");
    expect(s._queue.length).toBe(3);         // 二被丟、三四五在列
    expect(s._queue[0].text).toBe("三");
    // 補測：等 pending microtask 跑完（fetch()→res.blob() 兩層 await 各要一輪；用 macrotask
    // 邊界 flush，不寫死確切 tick 數），鎖住上面的 URL stub 修復——"一" 真的播到 _play()
    // （busy=true 是因為真的在播，不是意外被吞掉的例外），且過程零 console.warn（證明沒有
    // 背景排空鏈悄悄跑掉）。_play 的 promise 本身仍不 resolve，_busy 不會被這個 flush 動到。
    await new Promise((r) => setTimeout(r, 0));
    expect(s._play).toHaveBeenCalledWith("blob:mock-url", expect.anything()); // 樂譜制：第二參數＝envelope promise
    expect(console.warn).not.toHaveBeenCalled();
  });
});

describe("逾時涵蓋 body 下載（先前修過的問題）", () => {
  it("headers 到手後 body 卡住超過 15s → abort、靜默回落、_busy 恢復 false", async () => {
    vi.useFakeTimers();
    // fetch 立刻 resolve（headers 到手），但 res.blob() 掛住不動，只聽 abort 訊號——
    // 模擬「body 下載卡住」。這裡故意不用 makeSpeaker（它預設走 async fetchImpl，跟
    // fake timers 混用時的 microtask 排程比較難掌握），直接手動接。
    global.fetch = vi.fn((_endpoint, opts) => Promise.resolve({
      ok: true,
      status: 200,
      blob: () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    }));
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });
    s._play = vi.fn(async () => {});

    const done = s.speak("哈囉");
    await vi.advanceTimersByTimeAsync(15000);   // 真正推進到 15s，讓 setTimeout(abort) 觸發
    await done;

    expect(s._busy).toBe(false);
    expect(s._play).not.toHaveBeenCalled();       // 從沒真的播到——卡在下載階段就被 abort 了
    expect(console.warn).toHaveBeenCalledWith("tts fallback:" + CONSOLE_FEEDBACK_SUFFIX, "AbortError");
    // useRealTimers() 復原交給檔案層級的 afterEach（見上）——這裡不再手動呼叫，斷言失敗時
    // 也不會漏掉復原。
  });
});

describe("排空 FIFO（先前修過的問題）", () => {
  it("目前這則播完後，佇列依 FIFO 依序真的播放，最終 _busy 恢復 false 且佇列清空", async () => {
    const s = makeSpeaker(async () => ({
      ok: true, status: 200,
      blob: async () => new Blob(["x"], { type: "audio/mpeg" }),
    }));
    const resolvers = [];
    s._play = vi.fn(() => new Promise((r) => resolvers.push(r)));

    s.speak("A"); await Promise.resolve();
    s.speak("B"); s.speak("C");
    expect(s._queue.map((q) => q.text)).toEqual(["B", "C"]);

    await new Promise((r) => setTimeout(r, 0));   // 讓 A 走到呼叫 _play() 那一步
    expect(s._play).toHaveBeenCalledTimes(1);
    expect(s._busy).toBe(true);

    resolvers[0]();                                // A 播完
    await new Promise((r) => setTimeout(r, 0));     // finally 排空→speak("B")→走到它的 _play()
    expect(s._play).toHaveBeenCalledTimes(2);       // B 接著播了，不是原地卡住
    expect(s._queue.map((q) => q.text)).toEqual(["C"]);

    resolvers[1]();                                 // B 播完
    await new Promise((r) => setTimeout(r, 0));
    expect(s._play).toHaveBeenCalledTimes(3);       // C 接著播
    expect(s._queue.length).toBe(0);
    expect(s._busy).toBe(true);                     // C 還在播，busy 不該提早歸位

    resolvers[2]();                                  // C 播完——佇列空了，沒有下一則
    await new Promise((r) => setTimeout(r, 0));
    expect(s._busy).toBe(false);
    expect(s._queue.length).toBe(0);
    expect(console.warn).not.toHaveBeenCalled();      // 全程沒有任何一次靜默回落
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 早就規劃過每日語音上限命中
// 時要有一句能被看見的提示（「今天的嗓子休息了」），但這條線從沒真的接上——429
// 之前只是落進既有的靜默回落（跟 500 之類的一般錯誤沒有區別，只會覺得「他今天
// 突然不出聲了」，不知道是額度問題）。這裡驗證 TtsSpeaker 這一半：建構子接受
// `onDailyCap` callback，429 時觸發一次（同 session 不重複提醒），其餘狀態碼不觸發。
// app.js 端把它接到聊天區的提示文字（見 app.js 的 onDailyCap 接線），不在本檔測試
// 範圍——app.js 本來就沒有既有的單元測試邊界（純黏合層，見 app.js 檔頭說明）。
// ─────────────────────────────────────────────────────────────────────────────
describe("429 每日語音上限提示（onDailyCap 回呼）", () => {
  it("429 → onDailyCap 被呼叫一次；同一 session 再次 429（第二次 speak）不重複呼叫", async () => {
    const onDailyCap = vi.fn();
    const s = makeSpeaker(async () => ({ ok: false, status: 429 }));
    s.onDailyCap = onDailyCap;

    await s.speak("一");
    expect(onDailyCap).toHaveBeenCalledTimes(1);
    expect(s._play).not.toHaveBeenCalled(); // 仍照舊靜默回落，不會真的播放

    await s.speak("二");
    expect(onDailyCap).toHaveBeenCalledTimes(1); // 沒有再叫第二次——同 session 只提醒一次
  });

  it("建構子直接傳 onDailyCap（正式接線方式）→ 429 時同樣觸發", async () => {
    const onDailyCap = vi.fn();
    global.fetch = vi.fn(async () => ({ ok: false, status: 429 }));
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true, onDailyCap });
    s._play = vi.fn(async () => {});

    await s.speak("你好");

    expect(onDailyCap).toHaveBeenCalledTimes(1);
  });

  it("500（非每日上限，一般引擎錯誤）→ onDailyCap 不被呼叫", async () => {
    const onDailyCap = vi.fn();
    const s = makeSpeaker(async () => ({ ok: false, status: 500 }));
    s.onDailyCap = onDailyCap;

    await s.speak("你好");

    expect(onDailyCap).not.toHaveBeenCalled();
  });

  it("未提供 onDailyCap（呼叫端未接線）→ 429 時不拋錯，行為與今天相同（靜默回落）", async () => {
    const s = makeSpeaker(async () => ({ ok: false, status: 429 }));
    await expect(s.speak("你好")).resolves.toBeUndefined();
    expect(s._play).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// `_play()` 原本每句話 `new Audio(url)`
// 逐句新建——iOS 的手勢優先播放規則只認「同一個元件」，per-utterance 新建的元素
// 每次都是「沒被摸過的新元素」，不會繼承第一次使用者手勢時的解鎖狀態，導致 iOS 上
// 聊天 TTS 很可能整個 session 靜音（跟 phone.js 已經驗證過的 SILENT_WAV 手勢優先
// 播放解法是同一個問題、同一帖藥）。這裡改成跟 phone.js 一樣的持久元件設計：
// `_ensureAudioEl()` lazy 建立、全程重用同一顆；新增 `prime()` 給 app.js 首次
// pointerdown 呼叫，同步播放一段靜音片段解鎖它。
//
// MouthDriver.attach 對同一個 audioEl 重複呼叫是安全的——現行 driver 零 WebAudio
// 節點，attach 只掛播放事件監聽，同元素進來直接短路（見 audio-mouth.js attach 的同
// 元素短路段），換元素才真的重掛——電話／重播鍵／聊天 TTS 共用同一顆 driver 走的就是
// 這條，這裡驗證同一份基礎設施同樣讓 tts.js 的持久元件安全（讀碼確認）。
// ─────────────────────────────────────────────────────────────────────────────
describe("isPending＋onNoVoice（空窗期閉嘴：語音開著＝打字口型等聲音，等的依據與補位信號）", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    global.Audio = FakeAudio;
  });
  afterEach(() => {
    delete global.Audio;
  });

  it("isPending：閒置 false；speak 飛行中 true；佇列有貨 true；全部收尾後 false", async () => {
    let release;
    global.fetch = vi.fn(() => new Promise((r) => { release = r; }));
    const driver = { attach: vi.fn(), detach: vi.fn(), setEnvelope: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });
    s._play = vi.fn(async () => {});
    expect(s.isPending()).toBe(false);

    const p1 = s.speak("第一句");          // 合成飛行中
    expect(s.isPending()).toBe(true);
    s.speak("第二句");                     // 進佇列
    expect(s._queue.length).toBe(1);
    expect(s.isPending()).toBe(true);

    release({ ok: false, status: 500 });   // 第一句失敗收尾 → 佇列第二句接著飛
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    await p1;
    await new Promise((r) => setTimeout(r, 0)); // 佇列遞迴排空
    expect(s.isPending()).toBe(false);
  });

  it("onNoVoice：500／204／429／fetch 炸 → 各發一次（這句不會出聲＝打字口型補位的信號）", async () => {
    const cases = [
      async () => ({ ok: false, status: 500 }),
      async () => ({ ok: true, status: 204 }),
      async () => ({ ok: false, status: 429 }),
      async () => { throw new Error("net"); },
    ];
    for (const impl of cases) {
      global.fetch = vi.fn(impl);
      const onNoVoice = vi.fn();
      const driver = { attach: vi.fn(), detach: vi.fn(), setEnvelope: vi.fn() };
      const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true, onNoVoice });
      s._play = vi.fn(async () => {});
      await s.speak("哈囉");
      expect(onNoVoice).toHaveBeenCalledTimes(1);
      expect(s._play).not.toHaveBeenCalled();
    }
  });

  it("onNoVoice：成功路不發；開關關（getEnabled false）早退不發", async () => {
    global.fetch = vi.fn(okMp3);
    const onNoVoice = vi.fn();
    const driver = { attach: vi.fn(), detach: vi.fn(), setEnvelope: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true, onNoVoice });
    s._play = vi.fn(async () => {});
    await s.speak("正常出聲");
    expect(onNoVoice).not.toHaveBeenCalled();

    const s2 = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => false, onNoVoice });
    await s2.speak("開關關著");
    expect(onNoVoice).not.toHaveBeenCalled(); // 關著＝本來就不出聲，非「失敗」
  });

  it("onNoVoice：播放層失敗（audio.onerror／play() reject）也發——合成成功但沒真出聲", async () => {
    global.fetch = vi.fn(okMp3);
    const onNoVoice = vi.fn();
    const driver = { attach: vi.fn(), detach: vi.fn(), setEnvelope: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true, onNoVoice });
    const done = s.speak("這句會炸在播放層");
    await new Promise((r) => setTimeout(r, 0)); // 等 fetch/blob 兩輪 microtask、_play 掛上
    const el = FakeAudio.instances[FakeAudio.instances.length - 1];
    el.onerror();                              // 播放元件報錯
    await done;
    expect(onNoVoice).toHaveBeenCalledTimes(1);
  });
});

describe("持久播放元件＋prime()（iOS 手勢解鎖，鏡照 phone.js 既有設計）", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    global.Audio = FakeAudio;
  });
  afterEach(() => {
    delete global.Audio;
  });

  it("連續兩次呼叫 _play() 成功播放 → 只建立一顆 Audio 元件、重複使用（不是逐句 new Audio(url)）", async () => {
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    const p1 = s._play("blob:one");
    FakeAudio.instances[0].onended(); // 模擬瀏覽器播放結束事件
    await p1;

    const p2 = s._play("blob:two");
    FakeAudio.instances[0].onended();
    await p2;

    expect(FakeAudio.instances.length).toBe(1); // 全程只建了一顆，第二次呼叫重用同一顆
    expect(driver.attach).toHaveBeenCalledTimes(2);
    expect(driver.attach).toHaveBeenNthCalledWith(1, FakeAudio.instances[0]);
    expect(driver.attach).toHaveBeenNthCalledWith(2, FakeAudio.instances[0]);
    expect(FakeAudio.instances[0].src).toBe("blob:two"); // 同一顆元件，src 換過去了
  });

  it("樂譜制：_play 把 envelope promise 送進 driver.setEnvelope（譜跟句走）；沒帶譜＝送 null", async () => {
    const driver = { attach: vi.fn(), detach: vi.fn(), setEnvelope: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    const envP = Promise.resolve({ frameMs: 50, levels: Uint8Array.from([2, 0, 1]) });
    const p1 = s._play("blob:one", envP);
    FakeAudio.instances[0].onended();
    await p1;
    expect(driver.setEnvelope).toHaveBeenCalledTimes(1);
    expect(driver.setEnvelope).toHaveBeenCalledWith(envP);

    const p2 = s._play("blob:two"); // 沒帶譜（防禦路徑）→ 明示 null＝driver 走拍嘴
    FakeAudio.instances[0].onended();
    await p2;
    expect(driver.setEnvelope).toHaveBeenLastCalledWith(null);
  });

  it("樂譜制 guard：driver 沒有 setEnvelope（舊版／第三方注入）→ 不炸、播放照走", async () => {
    const driver = { attach: vi.fn(), detach: vi.fn() }; // 無 setEnvelope
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    const p = s._play("blob:one", Promise.resolve(null));
    FakeAudio.instances[0].onended();
    await expect(p).resolves.toBeUndefined();
    expect(driver.attach).toHaveBeenCalledTimes(1);
  });

  it("prime() 同步播放靜音片段解鎖持久元件，不動 _busy／_queue、不掛 driver（跟真的講話無關）", () => {
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    s.prime();

    expect(FakeAudio.instances.length).toBe(1);
    expect(FakeAudio.instances[0]._playCount).toBe(1);
    expect(FakeAudio.instances[0].src).toMatch(/^data:audio\/wav;base64,/);
    expect(s._busy).toBe(false);
    expect(s._queue.length).toBe(0);
    expect(driver.attach).not.toHaveBeenCalled(); // prime 不是「他在說話」，不掛嘴型驅動
  });

  it("prime() 播放中直接讓路——不把飛行中那句從喇叭擠掉（busy guard）", async () => {
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    const p = s._play("blob:mid-utterance"); // 這句正在喇叭上飛
    s._busy = true; // speak() 佇列流程中的忙碌態（_play 由它包著跑，這裡直接標）

    s.prime(); // 使用者此刻的手勢（回訪自動播放場景）——必須讓路

    expect(FakeAudio.instances[0].src).toBe("blob:mid-utterance"); // 沒被靜音片段蓋掉
    expect(FakeAudio.instances[0]._playCount).toBe(1); // 沒有第二次 play() 搶佔

    FakeAudio.instances[0].onended();
    await p;
  });

  it("prime() 之後呼叫 _play() 重用同一顆已解鎖的元件（不再多建一顆）", async () => {
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    s.prime();
    expect(FakeAudio.instances.length).toBe(1);

    const p = s._play("blob:real");
    FakeAudio.instances[0].onended();
    await p;

    expect(FakeAudio.instances.length).toBe(1); // 沒有再多建一顆
    expect(driver.attach).toHaveBeenCalledWith(FakeAudio.instances[0]);
  });

  it("Audio 建構失敗（環境不支援）→ _play() 安全收尾，不拋錯", async () => {
    global.Audio = class {
      constructor() { throw new Error("no Audio in this env"); }
    };
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    await expect(s._play("blob:x")).resolves.toBeUndefined();
    expect(driver.attach).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 撥號／接聽開始時必須收掉正在飛的聊天 TTS——`isActive()` 只擋「之後」新的
// `speak()` 呼叫（見 app.js 的 `getEnabled`），擋不住「已經在飛」的那一句，
// 不然會同時聽到聊天回覆的語音跟電話鈴聲／通話搶話。這裡驗證 `stop()` 本身的
// 機制；phone.js 呼叫它的接線驗證見 phone.test.js。
// ─────────────────────────────────────────────────────────────────────────────
describe("stop()（電話開始必須收掉正在飛的聊天 TTS）", () => {
  beforeEach(() => {
    FakeAudio.instances = [];
    global.Audio = FakeAudio;
  });
  afterEach(() => {
    delete global.Audio;
  });

  it("speak 播放中呼叫 stop() → 立刻收嘴、清空佇列、_busy 復位，且原本卡住的那句乾淨收尾（不留 pending promise）", async () => {
    global.fetch = vi.fn(async () => ({
      ok: true, status: 200,
      blob: async () => new Blob(["x"], { type: "audio/mpeg" }),
    }));
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    const p1 = s.speak("正在說的這句");
    await new Promise((r) => setTimeout(r, 0)); // fetch→blob 兩層 await 各一輪，flush 到 _play() 真的被呼叫
    expect(FakeAudio.instances.length).toBe(1); // 播放元件已建立、正在「播放中」（onended 還沒被觸發）
    expect(driver.attach).toHaveBeenCalledTimes(1);

    s.speak("排隊中的下一句"); // 第一句還沒播完（_busy 仍 true），這句進佇列
    expect(s._queue.length).toBe(1);

    s.stop();

    expect(s._queue.length).toBe(0); // 排隊的那句也不用了
    expect(driver.detach).toHaveBeenCalledTimes(1); // 嘴巴立刻合起來
    expect(s._busy).toBe(false);
    await p1; // 原本卡住的那句必須乾淨收尾，不會永遠 pending

    // 中斷之後，聊天 TTS 要能恢復正常運作（下一句 speak 照常 fetch＋播放，重用同一顆元件）。
    const p2 = s.speak("之後正常運作");
    await new Promise((r) => setTimeout(r, 0));
    expect(FakeAudio.instances.length).toBe(1); // 仍是同一顆持久元件
    expect(driver.attach).toHaveBeenCalledTimes(2);
    FakeAudio.instances[0].onended();
    await p2;
    expect(s._busy).toBe(false);
  });

  it("沒有正在播放時呼叫 stop() → 安全 no-op（不拋錯，_busy／_queue 維持原狀）", () => {
    const driver = { attach: vi.fn(), detach: vi.fn() };
    const s = new TtsSpeaker({ endpoint: "/api/v4/tts", driver, getEnabled: () => true });

    expect(() => s.stop()).not.toThrow();
    expect(s._busy).toBe(false);
    expect(s._queue.length).toBe(0);
    expect(driver.detach).toHaveBeenCalledTimes(1); // 保底收嘴，即使本來就沒在播也無害
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TtsSynthCache（句尾播放鍵的現場合成＋快取）：核心承諾——同一句同頁面只合成
// 一次（快取命中零 fetch）、失敗不快取（可重試）、429 觸發 onDailyCap、逐出
// 最舊時 revoke objectURL。
// ─────────────────────────────────────────────────────────────────────────────
describe("TtsSynthCache — 句尾播放鍵的合成快取", () => {

  it("首次 get → POST 端點、resolve objectURL；同句第二次 get → 快取直出、零新 fetch", async () => {
    global.fetch = vi.fn(okMp3);
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts" });

    const url1 = await c.get("我在。");
    expect(url1).toBe("blob:mock-url");
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch).toHaveBeenCalledWith("/api/v4/tts", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ text: "我在。" }),
    }));

    const url2 = await c.get("我在。");
    expect(url2).toBe("blob:mock-url");
    expect(global.fetch).toHaveBeenCalledTimes(1); // 命中快取＝重聽不再花錢
  });

  it("同句併發 get（合成還在飛就點第二次）→ 共用同一個 promise、fetch 只打一次", async () => {
    global.fetch = vi.fn(okMp3);
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts" });

    const [a, b] = await Promise.all([c.get("同一句"), c.get("同一句")]);
    expect(a).toBe("blob:mock-url");
    expect(b).toBe("blob:mock-url");
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it("空字串／純空白／非字串 → resolve null、零 fetch", async () => {
    global.fetch = vi.fn(okMp3);
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts" });
    expect(await c.get("")).toBeNull();
    expect(await c.get("   ")).toBeNull();
    expect(await c.get(null)).toBeNull();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it("500 → resolve null 且**不快取**（下次點擊可重試＝會再 fetch）", async () => {
    global.fetch = vi.fn(async () => ({ ok: false, status: 500 }));
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts" });

    expect(await c.get("你好")).toBeNull();
    expect(await c.get("你好")).toBeNull();
    expect(global.fetch).toHaveBeenCalledTimes(2); // 失敗不被釘死，第二次真的重試了
  });

  it("204（純符號句，後端淨化後為空）→ null，不視為錯誤", async () => {
    global.fetch = vi.fn(async () => ({ ok: true, status: 204 }));
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts" });
    expect(await c.get("⋯⋯")).toBeNull();
    expect(console.warn).not.toHaveBeenCalled(); // 204 是正常分支，不 warn
  });

  it("429（每日語音上限）→ onDailyCap 被呼叫、resolve null", async () => {
    const onDailyCap = vi.fn();
    global.fetch = vi.fn(async () => ({ ok: false, status: 429 }));
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts", onDailyCap });

    expect(await c.get("再說一次")).toBeNull();
    expect(onDailyCap).toHaveBeenCalledTimes(1);
  });

  it("網路錯（fetch reject）→ resolve null 不拋錯（呼叫端按鈕靜默還原）", async () => {
    global.fetch = vi.fn(async () => { throw new Error("network down"); });
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts" });
    await expect(c.get("你好")).resolves.toBeNull();
  });

  it("超過 maxEntries → 逐出最舊並 revoke 其 objectURL；最近點過的（LRU touch）不被逐出", async () => {
    let n = 0;
    URL.createObjectURL = vi.fn(() => "blob:mock-" + (++n));
    global.fetch = vi.fn(okMp3);
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts", maxEntries: 2 });

    await c.get("Ａ句"); // blob:mock-1
    await c.get("Ｂ句"); // blob:mock-2
    await c.get("Ａ句"); // 快取命中＝touch，Ａ變最新（fetch 仍 2 次）
    expect(global.fetch).toHaveBeenCalledTimes(2);

    await c.get("Ｃ句"); // blob:mock-3——超上限，該逐出的是最舊的Ｂ、不是剛 touch 的Ａ
    await new Promise((r) => setTimeout(r, 0)); // 逐出的 revoke 掛在 promise then，flush 它
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:mock-2");
    expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:mock-1");

    expect(await c.get("Ａ句")).toBe("blob:mock-1"); // Ａ仍在快取（零新 fetch）
    expect(global.fetch).toHaveBeenCalledTimes(3); // Ａ、Ｂ、Ｃ各合成一次；touch 與命中不再打
  });

  it("15s 逾時涵蓋 body 下載（同 TtsSpeaker 先前修過的問題）→ abort、resolve null", async () => {
    vi.useFakeTimers();
    global.fetch = vi.fn((_endpoint, opts) => Promise.resolve({
      ok: true,
      status: 200,
      blob: () => new Promise((_resolve, reject) => {
        opts.signal.addEventListener("abort", () => {
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        });
      }),
    }));
    const c = new TtsSynthCache({ endpoint: "/api/v4/tts" });

    const pending = c.get("很長的下載");
    await vi.advanceTimersByTimeAsync(15000);
    await expect(pending).resolves.toBeNull();
  });
});
