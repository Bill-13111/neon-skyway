#!/usr/bin/env python3
"""Generate Neon Skyway launcher icons without external assets."""
import math
import os

import numpy as np
from PIL import Image, ImageDraw, ImageFilter

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
RES = os.path.join(ROOT, "android", "app", "src", "main", "res")
MASTER = 1024
SS = 2  # supersampling for the master artwork


def radial_background(size):
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    cx = cy = size * 0.5
    r = np.sqrt((x - cx) ** 2 + (y - cy) ** 2) / (size * 0.52)
    r = np.clip(r, 0, 1)
    inner = np.array([13, 36, 55], dtype=np.float32)
    outer = np.array([2, 6, 12], dtype=np.float32)
    rgb = inner[None, None, :] * (1 - r[:, :, None]) + outer[None, None, :] * r[:, :, None]
    return Image.fromarray(np.uint8(np.clip(rgb, 0, 255)), "RGB").convert("RGBA")


def glow_layer(size, color, boxes, blur):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    for box, alpha in boxes:
        d.ellipse(box, fill=color + (alpha,))
    return layer.filter(ImageFilter.GaussianBlur(blur))


def orb(size, center, radius):
    """Glossy neon sphere with a rim light."""
    n = int(radius * 2.3)
    y, x = np.mgrid[0:n, 0:n].astype(np.float32)
    cx = cy = n * 0.5
    d = np.sqrt((x - cx) ** 2 + (y - cy) ** 2)
    mask = np.clip((radius - d) / 1.8, 0, 1)
    # Directional gradient: bright top-left, deep cyan bottom-right.
    gx = (x - (cx - radius * 0.35)) / (radius * 2.0)
    gy = (y - (cy - radius * 0.4)) / (radius * 2.0)
    g = np.clip(0.78 - 0.55 * np.sqrt(gx * gx + gy * gy), 0, 1)
    core = np.array([232, 255, 255], dtype=np.float32)
    mid = np.array([60, 243, 255], dtype=np.float32)
    edge = np.array([0, 118, 176], dtype=np.float32)
    t = np.clip(d / radius, 0, 1)[:, :, None]
    col = core * (1 - t) ** 2.1 + mid * (1 - (1 - t) ** 2.1)
    col = col * (0.76 + 0.24 * g[:, :, None])
    # Darker lower-right edge.
    shade = np.clip((x - cx + y - cy) / (radius * 2.4), 0, 1)[:, :, None]
    col = col * (1 - 0.30 * shade)
    col = col * (1 - 0.35 * np.clip((d - radius * 0.93) / (radius * 0.07), 0, 1)[:, :, None])
    # Add a bright specular cap.
    spec = np.clip(1 - (np.sqrt((x - cx + radius * 0.32) ** 2 + (y - cy + radius * 0.4) ** 2) / (radius * 0.36)), 0, 1)
    col = col + spec[:, :, None] ** 2 * np.array([110, 150, 120], dtype=np.float32)
    rgba = np.dstack([np.clip(col, 0, 255), np.uint8(255 * mask)])
    img = Image.fromarray(np.uint8(rgba), "RGBA")
    img = img.resize((int(n / SS), int(n / SS)), Image.LANCZOS)
    pos = (int(center[0] - n / (2 * SS)), int(center[1] - n / (2 * SS)))
    return img, pos


def ellipse_ring(size, center, rx, ry, angle, color, width):
    layer = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    box = (center[0] - rx, center[1] - ry, center[0] + rx, center[1] + ry)
    d.ellipse(box, outline=color + (255,), width=width)
    layer = layer.rotate(angle, resample=Image.BICUBIC, center=center)
    return layer


def star(draw, cx, cy, r, color):
    pts = [
        (cx, cy - r), (cx + r * 0.22, cy - r * 0.22),
        (cx + r, cy), (cx + r * 0.22, cy + r * 0.22),
        (cx, cy + r), (cx - r * 0.22, cy + r * 0.22),
        (cx - r, cy), (cx - r * 0.22, cy - r * 0.22),
    ]
    draw.polygon(pts, fill=color)


def make_master(transparent=False, mask_circle=False):
    size = MASTER
    if transparent:
        base = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    else:
        base = radial_background(size)

    # Faint perspective grid, anchored low in the frame.
    grid = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grid)
    for i in range(-8, 9):
        x = 512 + i * 92
        gd.line([(x, 640), (x * 0.58 + 240, 1024)], fill=(60, 238, 255, 16), width=2)
    for j in range(6):
        y = 650 + j * 76
        gd.line([(0, y), (1024, y)], fill=(60, 238, 255, 12), width=2)
    base.alpha_composite(grid)

    # Cyan atmospheric glow behind the orb.
    base.alpha_composite(glow_layer(size, (26, 222, 255), [
        ((512 - 340, 512 - 340, 512 + 340, 512 + 340), 80),
        ((512 - 240, 512 - 240, 512 + 240, 512 + 240), 95),
    ], 95))

    # Orbit rings behind and in front of the sphere.
    back = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    back.alpha_composite(ellipse_ring(size, (512, 512), 400, 150, 24, (54, 244, 255), 7))
    back.alpha_composite(ellipse_ring(size, (512, 512), 360, 128, -27, (107, 130, 255), 5))
    glowed = back.filter(ImageFilter.GaussianBlur(14))
    base.alpha_composite(glowed)
    base.alpha_composite(back)

    # Sphere.
    ball, pos = orb(size, (512, 512), 252)
    base.alpha_composite(ball, pos)

    # Latitude / longitude arcs, clipped subtly by drawing over the sphere.
    arcs = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    ad = ImageDraw.Draw(arcs)
    ad.arc((512 - 252, 512 - 252, 512 + 252, 512 + 252), 110, 250, fill=(225, 255, 255, 155), width=3)
    ad.arc((512 - 185, 512 - 252, 512 + 185, 512 + 252), 200, 340, fill=(130, 250, 255, 125), width=3)
    ad.arc((512 - 252, 512 - 160, 512 + 252, 512 + 160), 20, 155, fill=(130, 250, 255, 105), width=2)
    base.alpha_composite(arcs)

    # Front orbit ring over the ball.
    front = ellipse_ring(size, (512, 512), 330, 116, -18, (170, 255, 255), 5)
    base.alpha_composite(front.filter(ImageFilter.GaussianBlur(7)))
    base.alpha_composite(front)

    # Gold wayfinder star.
    spark = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    sd = ImageDraw.Draw(spark)
    star(sd, 756, 300, 46, (255, 217, 128, 255))
    star(sd, 756, 300, 26, (255, 255, 240, 255))
    base.alpha_composite(spark.filter(ImageFilter.GaussianBlur(18)))
    base.alpha_composite(spark)

    # Airborne crystal specks.
    dots = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    dd = ImageDraw.Draw(dots)
    for x, y, r, a in [(300, 270, 4, 200), (792, 620, 3, 150), (250, 740, 5, 110),
                       (720, 790, 3, 130), (840, 460, 2, 120)]:
        dd.ellipse((x - r, y - r, x + r, y + r), fill=(180, 250, 255, a))
    base.alpha_composite(dots)

    if mask_circle:
        mask = Image.new("L", (size, size), 0)
        ImageDraw.Draw(mask).ellipse((22, 22, size - 22, size - 22), fill=255)
        base.putalpha(mask)

    return base


def main():
    master = make_master()
    master.resize((512, 512), Image.LANCZOS).save(os.path.join(ROOT, "design", "icon-512.png"))

    for density, px in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)]:
        out = os.path.join(RES, f"mipmap-{density}")
        master.resize((px, px), Image.LANCZOS).save(os.path.join(out, "ic_launcher.png"))
        make_master(mask_circle=True).resize((px, px), Image.LANCZOS).save(
            os.path.join(out, "ic_launcher_round.png"))

    fg = make_master(transparent=True)
    # Adaptive foreground: artwork must stay inside the central safe zone.
    canvas = Image.new("RGBA", (432, 432), (0, 0, 0, 0))
    art = fg.resize((360, 360), Image.LANCZOS)
    canvas.alpha_composite(art, (36, 36))
    canvas.save(os.path.join(RES, "mipmap-xxxhdpi", "ic_launcher_foreground.png"))
    print("icons written")


if __name__ == "__main__":
    main()
