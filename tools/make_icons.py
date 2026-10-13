# -*- coding: utf-8 -*-
"""生成扩展图标：蓝底白色二维码图案（4x 超采样抗锯齿）"""
import random
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "icons"
OUT.mkdir(exist_ok=True)

BG = (26, 115, 232, 255)   # 蓝底
FG = (255, 255, 255, 255)  # 白色模块
N = 21                     # 模块数


def draw_pattern(size):
    ss = size * 4  # 超采样
    img = Image.new("RGBA", (ss, ss), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 圆角蓝底
    radius = int(ss * 0.22)
    d.rounded_rectangle([0, 0, ss - 1, ss - 1], radius=radius, fill=BG)

    margin = int(ss * 0.16)
    cell = (ss - 2 * margin) / (N - 1)
    rng = random.Random(42)

    def mod(x, y, color, scale=0.8):
        cx = margin + x * cell
        cy = margin + y * cell
        cs = cell * scale
        d.rectangle([cx, cy, cx + cs, cy + cs], fill=color)

    # 随机模块
    for x in range(N):
        for y in range(N):
            if rng.random() < 0.45:
                mod(x, y, FG)

    def finder(ox, oy):
        s = 5
        for x in range(s):
            for y in range(s):
                if ox + x < N and oy + y < N:
                    mod(ox + x, oy + y, FG, 1.0)
        for x in range(s - 2):
            for y in range(s - 2):
                if ox + x + 1 < N and oy + y + 1 < N:
                    mod(ox + x + 1, oy + y + 1, BG, 1.0)
        mod(ox + 2, oy + 2, FG, 1.0)

    finder(0, 0)
    finder(N - 5, 0)
    finder(0, N - 5)

    return img.resize((size, size), Image.LANCZOS)


def main():
    for size in (16, 48, 128):
        img = draw_pattern(size)
        out = OUT / f"icon{size}.png"
        img.save(out)
        print("saved", out, img.size)


if __name__ == "__main__":
    sys.exit(main())
