#!/usr/bin/env python3
"""Draws Hammer Client's logo art. The logo is "Woksel": a hammer built from voxels in 3/4 view with pixel sparks.

    python3 tools/gen_logo.py [--preview out.png]

Writes (common/src/main/resources/assets/hammerclient/):
    icon.png                    the mod's icon (fabric.mod.json, mod lists), 128 px
    textures/logo.png           the logo rendered at several sizes (smooth, "blur" on) – the client draws the one closest
    logo.json                   to the real pixel size, so it is never scaled down more than 1.33× (no blurry downscale)
    textures/logo_pixel.png     the pixel-art hammer at 16, 24 and 32 px (no "blur": crisp) for small sizes and the HUD
    textures/font/badge_hammer.png, badge_plus.png
                                the badges in front of names in the player list (Tab): an 8-pixel hammer and the hammer
                                with a + for Hammer+ – glyphs of the font hammerclient:badge (font/badge.json), drawn at
                                one texture pixel per GUI pixel like the game's own font, so they stay sharp
With --preview, also a picture of the badges as the game shows them (GUI scales 2, 3, 4).

The logo itself is tools/brand/mark.svg (flat voxel faces from the logo designer); the pixel hammers are drawn on a
45° pixel lattice the same way as the logo's favicons. The capes carry the logo too: gen_capes.py and gen_cosmetics.py
take it from here, so run them after this one when the logo changes. Needs Pillow. The outputs are committed.
"""
import json
import math
import os
import re
import sys

from PIL import Image, ImageChops, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MARK_SVG = os.path.join(ROOT, 'tools', 'brand', 'mark.svg')
OUT = os.path.join(ROOT, 'common/src/main/resources/assets/hammerclient')
TEX = os.path.join(OUT, 'textures')

# ───────────────────────────── the logo (smooth) ─────────────────────────────


def _rgba(hex_colour, alpha=1.0):
    c = hex_colour.lstrip('#')
    return int(c[0:2], 16), int(c[2:4], 16), int(c[4:6], 16), round(255 * alpha)


def _shapes():
    """mark.svg as a list of (points, fill, stroke, stroke width, opacity): voxel faces (paths), then the sparks (rects)."""
    svg = open(MARK_SVG, encoding='utf-8').read()
    shapes = []
    for m in re.finditer(r'<(path|rect)\s([^>]*)/>', svg):
        a = dict(re.findall(r'([\w-]+)="([^"]*)"', m.group(2)))
        if m.group(1) == 'path':
            nums = [float(v) for v in re.findall(r'-?\d+(?:\.\d+)?', a['d'])]
            pts = list(zip(nums[0::2], nums[1::2]))
        else:
            x, y, w, h = (float(a[k]) for k in ('x', 'y', 'width', 'height'))
            pts = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
        shapes.append((pts, a['fill'], a.get('stroke'), float(a.get('stroke-width', 0)), float(a.get('opacity', 1))))
    return shapes


def _box(shapes):
    xs = [p[0] for s in shapes for p in s[0]]
    ys = [p[1] for s in shapes for p in s[0]]
    return min(xs), min(ys), max(xs), max(ys)


def mark(size, pad=1, sparks=True, height=None):
    """The logo fitted into a size × size picture (or size × height), centred, `pad` pixels from the edges.
    Drawn 8–16× bigger and scaled down, so the edges and the seams between voxels are smooth."""
    shapes = [s for s in _shapes() if sparks or s[2]]  # the sparks are the shapes without a stroke
    x0, y0, x1, y1 = _box(shapes)
    w, h = size, height or size
    ss = 16 if max(w, h) < 100 else 8
    k = min((w - 2 * pad) / (x1 - x0), (h - 2 * pad) / (y1 - y0)) * ss
    ox = (w * ss - (x1 - x0) * k) / 2 - x0 * k
    oy = (h * ss - (y1 - y0) * k) / 2 - y0 * k
    big = Image.new('RGBA', (w * ss, h * ss), (0, 0, 0, 0))
    for pts, fill, stroke, width, opacity in shapes:
        layer = big if opacity >= 1 else Image.new('RGBA', big.size, (0, 0, 0, 0))
        d = ImageDraw.Draw(layer)
        p = [(x * k + ox, y * k + oy) for x, y in pts]
        d.polygon(p, fill=_rgba(fill))
        if stroke and width:
            d.line(p + [p[0]], fill=_rgba(stroke), width=max(1, round(width * k)), joint='curve')
        if layer is not big:
            layer.putalpha(layer.getchannel('A').point(lambda v: round(v * opacity)))
            big.alpha_composite(layer)
    return big.resize((w, h), Image.LANCZOS)


def mark_cropped(width, sparks=True):
    """The logo `width` pixels wide and as tall as it needs, with no margin (for capes)."""
    x0, y0, x1, y1 = _box([s for s in _shapes() if sparks or s[2]])
    return mark(width, pad=0, sparks=sparks, height=round(width * (y1 - y0) / (x1 - x0)))


# ───────────────────────────── the pixel-art hammer ─────────────────────────────

PIXEL = {'L': '#FFE596', 'O': '#FFA23A', 'o': '#F08A2C', 'D': '#D9561A', 'h': '#C88A55', 'H': '#86502C', 'g': '#6E4025',
         'G': '#4A2A16', 'W': '#FFF1C2', 'w': '#FFD27A'}
# On a 45° lattice: s = x + y runs along the head, u = x − y along the handle. The head is the band |s − s0| ≤ half,
# t0 ≤ u ≤ t1 (wider by `flare` at its ends); the handle is the diagonals `hs` from u = hend up to the head.
LATTICE = {16: dict(c=(10, 5), half=4, t0=3, t1=7, flare=0, hs=(15, 16), hend=-11, grip=-7),
           24: dict(c=(15, 8), half=7, t0=4, t1=10, flare=1, hs=(23, 24), hend=-16, grip=-10),
           32: dict(c=(20, 11), half=9, t0=5, t1=13, flare=1, hs=(30, 31, 32), hend=-21, grip=-13)}
SPARKS = {16: [(14, 2, 'W'), (12, 0, 'w')],
          24: [(21, 3, 'W'), (22, 3, 'W'), (21, 4, 'W'), (22, 4, 'W'), (19, 1, 'w'), (23, 7, 'w')],
          32: [(28, 4, 'W'), (29, 4, 'W'), (28, 5, 'W'), (29, 5, 'W'), (25, 1, 'w'), (31, 9, 'w')]}
CLEAR = {32: [(17, 13), (18, 14)]}  # the designer's touch-up: a gap between the handle and the head


def _lattice(n, c, half, t0, t1, flare, hs, hend, grip):
    g = [['.'] * n for _ in range(n)]
    s0 = c[0] + c[1]
    big, mid = n >= 32, n >= 24
    for y in range(n):
        for x in range(n):
            s, u = x + y, x - y
            if s in hs and hend <= u < t0:  # handle: light and dark side, the grip darker
                g[y][x] = ('G' if s == hs[-1] else 'g') if u < grip else ('H' if s == hs[-1] else 'h')
            end = abs(s - s0) >= half - (2 if big else (1 if mid else 0))
            a, b = (t0 - flare, t1 + flare) if end else (t0, t1)
            if abs(s - s0) <= half and a <= u <= b:  # head: top light, the far end in shadow, the near end warm
                if s >= s0 + half - (1 if big else 0):
                    ch = 'D'
                elif u >= b - (1 if big else 0):
                    ch = 'L'
                elif u == a:
                    ch = 'o'
                else:
                    ch = 'O'
                if s <= s0 - half + (1 if big else 0) and ch != 'L':
                    ch = 'w'
                g[y][x] = ch
    return g


def picture(rows):
    """Rows of palette letters ('.' = transparent) → an RGBA picture."""
    im = Image.new('RGBA', (max(len(r) for r in rows), len(rows)), (0, 0, 0, 0))
    for y, row in enumerate(rows):
        for x, ch in enumerate(row):
            if ch in PIXEL:
                im.putpixel((x, y), _rgba(PIXEL[ch]))
    return im


def sprite(n, sparks=True):
    """The pixel-art hammer on an n × n grid (16, 24 or 32), with or without its sparks."""
    g = _lattice(n, **LATTICE[n])
    for x, y in CLEAR.get(n, ()):
        g[y][x] = '.'
    if sparks:
        for x, y, ch in SPARKS[n]:
            g[y][x] = ch
    return picture(g)


# The Tab badges: 8 GUI pixels tall like the player's head and the letters next to them. The hammer is the logo's
# shape at its smallest – head across the handle, top face light, far end in shadow; the + of Hammer+ has the height
# and place of the game font's own "+" (rows 1–5), in the sparks' gold.
BADGE = [
    '...wLL..',
    '...wOLL.',
    '....oOOL',
    '...hHoOD',
    '..hH..DD',
    '.hH.....',
    'gG......',
    'G.......',
]
PLUS = ['..w..', '..w..', 'wwWww', '..w..', '..w..']


def badges():
    hammer = picture(BADGE)
    rows = [r + '.' + (PLUS[y - 1] if 1 <= y <= 5 else '') for y, r in enumerate(BADGE)]
    return hammer, picture(rows)


# ───────────────────────────── output ─────────────────────────────

LEVELS = [354, 266, 200, 150, 113, 85, 64, 48, 36]  # ≈ 1.33× apart; below 36 real pixels the client takes the pixel art
GAP = 2


def write_mcmeta(png, blur):
    path = png + '.mcmeta'
    if blur:
        with open(path, 'w') as f:
            json.dump({'texture': {'blur': True, 'clamp': True}}, f, separators=(',', ':'))
            f.write('\n')
    elif os.path.exists(path):
        os.remove(path)


def pack(sizes, width):
    """Shelf packing, biggest first: {size: (x, y)} and the height used."""
    x = y = row = 0
    pos = {}
    for (w, h), key in sorted(((s[1], s[0]) for s in sizes.items()), key=lambda t: -t[0][1]):
        if x + w > width:
            x, y, row = 0, y + row + GAP, 0
        pos[key] = (x, y)
        x += w + GAP
        row = max(row, h)
    return pos, y + row


def main():
    os.makedirs(os.path.join(TEX, 'font'), exist_ok=True)

    icon = mark(128, pad=4)
    icon.save(os.path.join(OUT, 'icon.png'), optimize=True)

    # the smooth logo at every size of LEVELS
    pos, used = pack({s: (s, s) for s in LEVELS}, 1024)
    height = 1 << math.ceil(math.log2(used))
    atlas = Image.new('RGBA', (1024, height), (0, 0, 0, 0))
    for s in LEVELS:
        atlas.paste(mark(s), pos[s])
    atlas.save(os.path.join(TEX, 'logo.png'), optimize=True)
    write_mcmeta(os.path.join(TEX, 'logo.png'), True)

    # the pixel hammers, each cut to its outline
    sprites = {n: sprite(n) for n in (16, 24, 32)}
    sprites = {n: im.crop(im.getbbox()) for n, im in sprites.items()}
    ppos, pused = pack({n: im.size for n, im in sprites.items()}, 128)
    pix = Image.new('RGBA', (128, 1 << math.ceil(math.log2(pused))), (0, 0, 0, 0))
    for n, im in sprites.items():
        pix.paste(im, ppos[n])
    pix.save(os.path.join(TEX, 'logo_pixel.png'), optimize=True)
    write_mcmeta(os.path.join(TEX, 'logo_pixel.png'), False)

    with open(os.path.join(OUT, 'logo.json'), 'w', encoding='utf-8') as f:
        json.dump({
            'smooth': {'width': atlas.width, 'height': atlas.height, 'levels': [[s, *pos[s]] for s in sorted(LEVELS)]},
            'pixel': {'width': pix.width, 'height': pix.height, 'sprites': [[n, *ppos[n], *sprites[n].size] for n in sorted(sprites)]},
        }, f, separators=(',', ':'))
        f.write('\n')

    hammer, plus = badges()
    for name, im in (('badge_hammer.png', hammer), ('badge_plus.png', plus)):
        im.save(os.path.join(TEX, 'font', name), optimize=True)
    old = os.path.join(TEX, 'font', 'badge_h.png')
    if os.path.exists(old):
        os.remove(old)
    print(f'icon.png, logo.png {atlas.width}x{atlas.height} ({len(LEVELS)} sizes), logo_pixel.png, badges {hammer.size} / {plus.size}')

    if '--preview' in sys.argv:
        preview(sys.argv[sys.argv.index('--preview') + 1], hammer, plus)


def preview(path, hammer, plus):
    """The badges as the game shows them – point-sampled at GUI scales 2, 3 and 4 with the drop shadow text gets –
    in front of a name (a light bar), and the pixel hammers at 1× next to the smooth logo at the same size."""
    rows = []
    for gui in (2, 3, 4):
        row = Image.new('RGBA', (150 * gui, 12 * gui), (30, 30, 34, 255))
        x = 4 * gui
        for img in (hammer, plus):
            size = (img.width * gui, img.height * gui)
            shown = img.resize(size, Image.NEAREST)
            dark = ImageChops.multiply(shown, Image.new('RGBA', size, (64, 64, 64, 255)))
            row.alpha_composite(dark, (x + gui, 3 * gui))
            row.alpha_composite(shown, (x, 2 * gui))
            bar = x + size[0] + 3 * gui
            ImageDraw.Draw(row).rectangle([bar, 3 * gui, bar + 30 * gui - 1, 8 * gui], fill=(235, 235, 235, 255))
            x = bar + 40 * gui
        rows.append(row)
    logos = Image.new('RGBA', (rows[-1].width, 40), (30, 30, 34, 255))
    x = 4
    for n in (16, 24, 32):
        im = sprite(n)
        logos.alpha_composite(im, (x, 4))
        logos.alpha_composite(mark(n), (x + n + 2, 4))
        x += 2 * n + 12
    rows.append(logos)
    sheet = Image.new('RGBA', (max(r.width for r in rows), sum(r.height + 8 for r in rows) + 8), (18, 18, 20, 255))
    y = 8
    for r in rows:
        sheet.alpha_composite(r, (0, y))
        y += r.height + 8
    sheet.resize((sheet.width * 2, sheet.height * 2), Image.NEAREST).save(path)
    print('preview', path)


if __name__ == '__main__':
    main()
