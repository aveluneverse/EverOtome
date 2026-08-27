import { describe, it, expect } from "vitest";
import { ConnNoteTracker } from "../js/conn-note.js";
import zhHant from "../js/locales/zh-Hant.js";
import en from "../js/locales/en.js";

const last = (seq) => {
  const tr = new ConnNoteTracker();
  let key = null;
  for (const s of seq) key = tr.keyFor(s);
  return key;
};

describe("ConnNoteTracker — which idle note the dialogue box shows", () => {
  it("first attempt still in flight: connecting", () => {
    expect(last(["connecting"])).toBe("conn.idleConnecting");
  });
  it("never opened and the first attempt failed: offline note (zero-backend preview)", () => {
    expect(last(["connecting", "reconnecting"])).toBe("conn.idleOffline");
    expect(last(["connecting", "reconnecting", "connecting"])).toBe("conn.idleOffline");
    expect(last(["connecting", "reconnecting", "connecting", "reconnecting"])).toBe("conn.idleOffline");
  });
  it("open clears the note", () => {
    expect(last(["connecting", "open"])).toBe("");
  });
  it("a backend that was reachable and dropped keeps the connecting note while retrying", () => {
    expect(last(["connecting", "open", "reconnecting"])).toBe("conn.idleConnecting");
    expect(last(["connecting", "open", "reconnecting", "connecting"])).toBe("conn.idleConnecting");
  });
  it("open resets the failure count", () => {
    expect(last(["connecting", "reconnecting", "connecting", "open", "reconnecting"])).toBe("conn.idleConnecting");
  });
  it("closed and error always show the offline note", () => {
    expect(last(["connecting", "open", "closed"])).toBe("conn.idleOffline");
    expect(last(["connecting", "error"])).toBe("conn.idleOffline");
  });
  it("both idle-note keys exist in every dictionary (the tracker names them as bare strings)", () => {
    for (const dict of [zhHant, en]) {
      expect(typeof dict["conn.idleOffline"]).toBe("string");
      expect(typeof dict["conn.idleConnecting"]).toBe("string");
    }
  });
});
