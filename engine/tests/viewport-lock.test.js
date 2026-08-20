import { describe, it, expect, vi } from "vitest";
import { shouldInstallGestureGuard, installViewportLock } from "../js/viewport-lock.js";

// iOS 頁面級捏合鎖：只在有 GestureEvent 的環境（iOS Safari/WKWebView）掛
// gesture 三事件 preventDefault；其他環境零 listener、回 false。
// passive:false 是成立要件——preventDefault 在 passive listener 內是 no-op。

function fakeWin({ withGesture = true, withDocument = true } = {}) {
  const listeners = [];
  const win = {};
  if (withDocument) {
    win.document = {
      addEventListener: (type, fn, opts) => listeners.push({ type, fn, opts }),
    };
  }
  if (withGesture) win.GestureEvent = function GestureEvent() {};
  return { win, listeners };
}

describe("shouldInstallGestureGuard：環境判定純函式", () => {
  it("有 GestureEvent（iOS）＝要掛", () => {
    const { win } = fakeWin({ withGesture: true });
    expect(shouldInstallGestureGuard(win)).toBe(true);
  });

  it("無 GestureEvent（Android/桌機）＝不掛", () => {
    const { win } = fakeWin({ withGesture: false });
    expect(shouldInstallGestureGuard(win)).toBe(false);
  });

  it("缺 window／缺 document＝保守 false，不炸", () => {
    expect(shouldInstallGestureGuard(undefined)).toBe(false);
    expect(shouldInstallGestureGuard(null)).toBe(false);
    const { win } = fakeWin({ withGesture: true, withDocument: false });
    expect(shouldInstallGestureGuard(win)).toBe(false);
  });
});

describe("installViewportLock：iOS 捏合鎖安裝", () => {
  it("iOS 環境＝三個 gesture 事件都掛上 document、明給 passive:false、handler 會 preventDefault", () => {
    const { win, listeners } = fakeWin({ withGesture: true });
    expect(installViewportLock(win)).toBe(true);
    const types = listeners.map((l) => l.type).sort();
    expect(types).toEqual(["gesturechange", "gestureend", "gesturestart"]);
    for (const l of listeners) {
      expect(l.opts).toEqual({ passive: false });
      const e = { preventDefault: vi.fn() };
      l.fn(e);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
    }
  });

  it("非 iOS 環境＝零 listener、回 false", () => {
    const { win, listeners } = fakeWin({ withGesture: false });
    expect(installViewportLock(win)).toBe(false);
    expect(listeners.length).toBe(0);
  });
});
