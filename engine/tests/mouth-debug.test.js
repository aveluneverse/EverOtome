import { describe, it, expect, vi, afterEach } from "vitest";
import { initMouthDebug } from "../js/mouth-debug.js";
import { MouthDriver } from "../js/audio-mouth.js";

// ?mouthdebug=1 浮層（1.25 偵查②）：jsdom 用 history.replaceState 切換 URL 參數。

function setSearch(search) {
  window.history.replaceState(null, "", "/" + search);
}

function baseCtx(extra = {}) {
  return {
    driver: new MouthDriver({ setMouth() {} }),
    sprite: { _static: false, _degraded: false, _talkTimer: null, _mouth: 0 },
    phone: { isActive: () => false },
    isTtsEnabled: () => true,
    ...extra,
  };
}

afterEach(() => {
  setSearch("");
  const box = document.getElementById("mouth-debug");
  if (box) box.remove();
});

describe("initMouthDebug 開關", () => {
  it("不帶參數＝null、不建任何 DOM（正式使用零成本）", () => {
    setSearch("");
    expect(initMouthDebug(baseCtx())).toBe(null);
    expect(document.getElementById("mouth-debug")).toBe(null);
  });

  it("?mouthdebug=1＝建浮層、內容含驅動鏈各層狀態行", () => {
    setSearch("?mouthdebug=1");
    const h = initMouthDebug(baseCtx());
    expect(h).not.toBe(null);
    const box = document.getElementById("mouth-debug");
    expect(box).not.toBe(null);
    const text = box.textContent;
    expect(text).toContain("driver: attached=false");
    expect(text).toContain("mode=event-flap"); // 樂譜制：無譜＝event-flap、查表中＝score-drive
    expect(text).toContain("sprite: static=false");
    expect(text).toContain("phone: active=false");
    expect(text).toContain("tts: enabled=true");
    h.stop();
  });

  it("mouthdebug 非 1（=0 或別的值）＝不開", () => {
    setSearch("?mouthdebug=0");
    expect(initMouthDebug(baseCtx())).toBe(null);
  });
});

describe("浮層更新與收工", () => {
  it("每 500ms 重讀一次狀態（driver 狀態變了浮層跟著變）", () => {
    vi.useFakeTimers();
    try {
      setSearch("?mouthdebug=1");
      const ctx = baseCtx();
      const h = initMouthDebug(ctx);
      const box = document.getElementById("mouth-debug");
      expect(box.textContent).toContain("attached=false");
      const el = document.createElement("audio");
      ctx.driver.attach(el);
      vi.advanceTimersByTime(500);
      expect(box.textContent).toContain("attached=true");
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stop()＝清 timer＋移除浮層", () => {
    setSearch("?mouthdebug=1");
    const h = initMouthDebug(baseCtx());
    h.stop();
    expect(document.getElementById("mouth-debug")).toBe(null);
  });

  it("ctx 取值炸掉不炸 app（唯讀浮層的安全保證）", () => {
    vi.useFakeTimers();
    try {
      setSearch("?mouthdebug=1");
      const ctx = baseCtx({
        phone: { isActive: () => { throw new Error("boom"); } },
        isTtsEnabled: () => { throw new Error("boom"); },
      });
      let h;
      expect(() => { h = initMouthDebug(ctx); }).not.toThrow();
      expect(() => vi.advanceTimersByTime(1500)).not.toThrow();
      const box = document.getElementById("mouth-debug");
      expect(box.textContent).toContain("phone: active=false");
      h.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("sprite static=true 一眼可見（靜態外觀＝嘴本來就不動的設計，浮層要能點破）", () => {
    setSearch("?mouthdebug=1");
    const h = initMouthDebug(baseCtx({
      sprite: { _static: true, _degraded: false, _talkTimer: null, _mouth: 0 },
    }));
    expect(document.getElementById("mouth-debug").textContent).toContain("static=true");
    h.stop();
  });
});
