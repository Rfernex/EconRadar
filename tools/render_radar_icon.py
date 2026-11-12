"""Draw the EconRadar icon: radar rings and a sweep over a small network.

Run from the repository root: python3 tools/render_radar_icon.py
Writes radar/icon.svg (the editable source) and the 180/192/512 PNGs. Needs Pillow.
"""
import math
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'radar'
S = 512
BG, RING, SWEEP, EDGE = '#1f4f57', '#9cc7c4', '#2f6e74', '#e9efe9'
CENTER = (236, 276)
NODES = [((236, 276), 30, '#f4f2ec'), ((150, 186), 22, '#3987e5'), ((356, 160), 26, '#eb6834'),
         ((372, 330), 20, '#1baf7a'), ((176, 382), 18, '#e87ba4'), ((300, 236), 14, '#eda100')]
LINKS = [(0, 1), (0, 2), (0, 3), (0, 4), (0, 5), (2, 5), (2, 3), (1, 4)]


def svg():
    cx, cy = CENTER
    parts = [f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {S} {S}" role="img" aria-label="EconRadar">',
             f'<rect width="{S}" height="{S}" rx="112" fill="{BG}"/>']
    a0, a1, r = math.radians(-100), math.radians(-25), 230
    x0, y0 = cx + r * math.cos(a0), cy + r * math.sin(a0)
    x1, y1 = cx + r * math.cos(a1), cy + r * math.sin(a1)
    parts.append(f'<path d="M{cx} {cy}L{x0:.1f} {y0:.1f}A{r} {r} 0 0 1 {x1:.1f} {y1:.1f}Z" fill="{SWEEP}"/>')
    for rr in (80, 150, 220):
        parts.append(f'<circle cx="{cx}" cy="{cy}" r="{rr}" fill="none" stroke="{RING}" stroke-opacity=".45" stroke-width="6"/>')
    for a, b in LINKS:
        (ax, ay), (bx, by) = NODES[a][0], NODES[b][0]
        parts.append(f'<line x1="{ax}" y1="{ay}" x2="{bx}" y2="{by}" stroke="{EDGE}" stroke-width="9" stroke-linecap="round"/>')
    for (x, y), rad, fill in NODES:
        parts.append(f'<circle cx="{x}" cy="{y}" r="{rad + 6}" fill="{BG}"/><circle cx="{x}" cy="{y}" r="{rad}" fill="{fill}"/>')
    parts.append('</svg>')
    return '\n'.join(parts) + '\n'


def png(size):
    k = 4 * size / S
    img = Image.new('RGBA', (round(S * k), round(S * k)), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    sc = lambda v: v * k
    d.rounded_rectangle([0, 0, sc(S) - 1, sc(S) - 1], radius=sc(112), fill=BG)
    cx, cy = CENTER
    d.pieslice([sc(cx - 230), sc(cy - 230), sc(cx + 230), sc(cy + 230)], -100, -25, fill=SWEEP)
    ring = Image.new('RGBA', img.size, (0, 0, 0, 0))
    rd = ImageDraw.Draw(ring)
    for rr in (80, 150, 220):
        rd.ellipse([sc(cx - rr), sc(cy - rr), sc(cx + rr), sc(cy + rr)], outline=RING + '73', width=round(sc(6)))
    img.alpha_composite(ring)
    for a, b in LINKS:
        (ax, ay), (bx, by) = NODES[a][0], NODES[b][0]
        d.line([sc(ax), sc(ay), sc(bx), sc(by)], fill=EDGE, width=round(sc(9)))
        for x, y in ((ax, ay), (bx, by)):
            d.ellipse([sc(x - 4.5), sc(y - 4.5), sc(x + 4.5), sc(y + 4.5)], fill=EDGE)
    for (x, y), rad, fill in NODES:
        d.ellipse([sc(x - rad - 6), sc(y - rad - 6), sc(x + rad + 6), sc(y + rad + 6)], fill=BG)
        d.ellipse([sc(x - rad), sc(y - rad), sc(x + rad), sc(y + rad)], fill=fill)
    out = img.resize((size, size), Image.LANCZOS)
    if size == 180:  # iOS draws its own rounded mask on an opaque square
        flat = Image.new('RGB', out.size, BG)
        flat.paste(out, mask=out.split()[3])
        out = flat
    return out


if __name__ == '__main__':
    (OUT / 'icon.svg').write_text(svg())
    for size in (180, 192, 512):
        png(size).save(OUT / f'icon-{size}.png', optimize=True)
    print('Wrote radar/icon.svg and icon-180/192/512.png')
