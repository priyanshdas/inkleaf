# SPDX-License-Identifier: GPL-3.0-or-later
"""Draws build/icon.png (1024px), the source electron-builder turns into
.ico and .icns. Same leaf-and-nib mark as the welcome screen."""
import math
from pathlib import Path
from PIL import Image, ImageDraw

S = 4096          # draw big, then downsample for smooth edges
U = S / 64        # the mark is designed on a 64-unit grid
GREEN = (47, 122, 91, 255)
PAPER = (251, 252, 253, 255)


def bezier(p0, p1, p2, p3, n=80):
    for i in range(n + 1):
        t = i / n
        a, b, c, d = (1 - t) ** 3, 3 * (1 - t) ** 2 * t, 3 * (1 - t) * t * t, t ** 3
        yield (a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1])


def leaf():
    pts = list(bezier((32, 4), (18, 16), (12, 28), (12, 38)))
    for i in range(1, 81):  # bottom half-circle from (12,38) round to (52,38)
        a = math.pi - math.pi * i / 80
        pts.append((32 + 20 * math.cos(a), 38 + 20 * math.sin(a)))
    pts += list(bezier((52, 38), (52, 28), (46, 16), (32, 4)))
    return pts


def grid(points, scale, dx, dy):
    return [(dx + x * scale, dy + y * scale) for x, y in points]


img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([S * 0.06, S * 0.06, S * 0.94, S * 0.94], radius=S * 0.2, fill=GREEN)

# leaf in paper white, slightly smaller than the tile and optically centred
scale = U * 0.62
dx = S / 2 - 32 * scale
dy = S / 2 - 32 * scale - S * 0.015
d.polygon(grid(leaf(), scale, dx, dy), fill=PAPER)

w = int(3 * scale)
for a, b in [((32, 18), (32, 48)), ((32, 48), (27, 54)), ((32, 48), (37, 54))]:
    (x0, y0), (x1, y1) = grid([a, b], scale, dx, dy)
    d.line([x0, y0, x1, y1], fill=GREEN, width=w)
    for x, y in ((x0, y0), (x1, y1)):
        d.ellipse([x - w / 2, y - w / 2, x + w / 2, y + w / 2], fill=GREEN)
(cx, cy), = grid([(32, 30)], scale, dx, dy)
r = 3.2 * scale
d.ellipse([cx - r, cy - r, cx + r, cy + r], fill=GREEN)

out = Path(__file__).resolve().parent.parent / 'build' / 'icon.png'
img.resize((1024, 1024), Image.LANCZOS).save(out)
print('wrote', out)
