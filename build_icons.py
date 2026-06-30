"""Trim transparent padding from image.png and generate icon sizes."""
from __future__ import annotations

from pathlib import Path

from PIL import Image
import numpy as np

ROOT = Path(__file__).resolve().parent
SRC = ROOT / "image.png"


def trim_transparency(img: Image.Image, pad: int = 0) -> Image.Image:
    """Crop to the visible content bounding box."""
    rgba = img.convert("RGBA")
    arr = np.array(rgba)
    alpha = arr[:, :, 3]
    visible = alpha > 8
    if not visible.any():
        return rgba

    ys, xs = np.where(visible)
    left = max(0, int(xs.min()) - pad)
    top = max(0, int(ys.min()) - pad)
    right = min(arr.shape[1], int(xs.max()) + 1 + pad)
    bottom = min(arr.shape[0], int(ys.max()) + 1 + pad)
    return rgba.crop((left, top, right, bottom))


def save_png(img: Image.Image, path: Path, size: int) -> None:
    img.resize((size, size), Image.LANCZOS).save(path, "PNG", optimize=True)


def main() -> None:
    src = trim_transparency(Image.open(SRC), pad=2)
    src.save(SRC, "PNG", optimize=True)

    for size in (256, 192, 512):
        out = ROOT / ("logo.png" if size == 256 else f"icon-{size}.png")
        save_png(src, out, size)

    for size in (16, 32):
        save_png(src, ROOT / f"favicon-{size}.png", size)

    fav48 = src.resize((48, 48), Image.LANCZOS)
    fav48.save(ROOT / "favicon.ico", format="ICO", sizes=[(16, 16), (32, 32), (48, 48)])

    print(f"trimmed to {src.size[0]}x{src.size[1]}, icons regenerated")


if __name__ == "__main__":
    main()
