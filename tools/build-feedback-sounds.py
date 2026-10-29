"""Original Lucyna cues: deterministic PCM synthesis, no external recordings."""
import math
import pathlib
import struct
import wave

RATE = 48000
ROOT = pathlib.Path(__file__).resolve().parents[1] / 'src/feedback/assets'
CUES = {
    'completed': [(523.25, 0, .24, 1), (659.25, .115, .24, .87), (783.99, .23, .30, .78)],
    'attention': [(440, 0, .19, .85), (659.25, .245, .28, 1)],
    'error': [(329.63, 0, .24, 1), (246.94, .17, .30, .9)],
}


def render(style, notes):
    duration = max(start + length for _, start, length, _ in notes) + .03
    output = []
    for i in range(round(duration * RATE)):
        seconds, value = i / RATE, 0
        for frequency, start, length, level in notes:
            t = seconds - start
            if not 0 <= t < length:
                continue
            # Raised-cosine attack/release avoid clicks, including at cue edges.
            attack = .012 if style == 'soft' else .008
            envelope = min(1, t / attack) * min(1, (length - t) / .055)
            envelope = (.5 - .5 * math.cos(math.pi * envelope)) * math.exp(-3 * t / length)
            phase = math.tau * frequency * t
            if style == 'soft':
                tone = math.sin(phase) + .13 * math.sin(phase * 2) * math.exp(-18 * t)
            else:
                # Band-limited triangle colour, not a harsh square-wave alarm.
                tone = sum((-1) ** ((n - 1) // 2) * math.sin(n * phase) / n ** 2 for n in (1, 3, 5, 7))
            value += tone * envelope * level
        output.append(value)
    peak = max(map(abs, output))
    return [round(value / peak * .58 * 32767) for value in output]


if __name__ == '__main__':
    ROOT.mkdir(parents=True, exist_ok=True)
    for style in ('soft', 'pixel'):
        for kind, notes in CUES.items():
            samples = render(style, notes)
            target = ROOT / f'{style}-{kind}.wav'
            with wave.open(str(target), 'wb') as audio:
                audio.setparams((1, 2, RATE, 0, 'NONE', 'not compressed'))
                audio.writeframes(struct.pack('<' + 'h' * len(samples), *samples))
            print(f'{target.name}: {len(samples)/RATE:.2f}s')
