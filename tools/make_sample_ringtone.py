"""生成範例來電鈴聲（開源乾淨素材，非任何角色私有資產）。

電話功能用途：`engine/config.example.json` 的 `ringtonePath` 指向這個
2 秒合成嗶聲迴圈佔位檔——單純兩段方波風格提示音＋靜音間隔，loop=true 播放時
聽起來像通用「鈴聲」節奏。精神是：開源使用者拿到的是乾淨、非角色
專屬的佔位資產，真正的角色鈴聲是獨立的私有素材，永不進 engine/、
永不進公開 repo。

需要 ffmpeg 在 PATH 上（pydub 匯出 mp3 靠它轉檔）。
"""
import argparse
import json
from pathlib import Path

from _overwrite_guard import add_force_argument, refuse_unless_force

OUT = Path(__file__).resolve().parents[1] / "engine" / "assets" / "sample" / "ring.mp3"

TONE_HZ = 480          # 通用提示音頻率，非任何電信系統標準音的精確重製
TONE_MS = 400
GAP_MS = 100
TAIL_SILENCE_MS = 1100  # 400+100+400+1100 = 2000ms 整


def build():
    from pydub import AudioSegment
    from pydub.generators import Sine
    tone = Sine(TONE_HZ).to_audio_segment(duration=TONE_MS).apply_gain(-6)
    gap = AudioSegment.silent(duration=GAP_MS)
    tail = AudioSegment.silent(duration=TAIL_SILENCE_MS)
    ring = tone + gap + tone + tail
    assert len(ring) == 2000, f"total length should be 2000ms, got {len(ring)}ms"
    return ring


def main() -> int:
    ap = argparse.ArgumentParser(
        description="Regenerate the 2-second synthetic placeholder ringtone at "
                    "engine/assets/sample/ring.mp3 (needs pydub and ffmpeg). "
                    "This REPLACES the shipped file.")
    add_force_argument(ap)
    args = ap.parse_args()
    if refuse_unless_force([OUT], args.force, "engine/assets/sample") != 0:
        return 1
    OUT.parent.mkdir(parents=True, exist_ok=True)
    build().export(OUT, format="mp3", bitrate="64k")
    print(f"OK: 2-second synthetic placeholder ringtone -> {OUT}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
