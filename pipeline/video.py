"""Videos MP4 (H.264) de los cortes en orden, con rótulo de posición."""
from __future__ import annotations

from pathlib import Path

import imageio.v2 as imageio
import numpy as np
from PIL import Image, ImageDraw, ImageFont

FONT_PATHS = ["/System/Library/Fonts/Supplemental/Arial.ttf", "/System/Library/Fonts/SFNS.ttf"]


def _font(size: int):
    for p in FONT_PATHS:
        if Path(p).exists():
            return ImageFont.truetype(p, size)
    return ImageFont.load_default(size=size)


def window(hu: np.ndarray, center: float, width: float) -> np.ndarray:
    lo = center - width / 2
    return np.clip((hu - lo) / width * 255, 0, 255).astype(np.uint8)


def write_cine(frames_hu: list[np.ndarray], labels: list[str], path: Path, fps: int,
               center: float = 450, width: float = 1500, min_side: int = 640, title: str = ""):
    path.parent.mkdir(parents=True, exist_ok=True)
    h, w = frames_hu[0].shape
    scale = max(1.0, min_side / min(h, w))
    size = (int(round(w * scale / 2)) * 2, int(round(h * scale / 2)) * 2)
    font = _font(max(14, size[0] // 40))
    writer = imageio.get_writer(path, fps=fps, codec="libx264", quality=8,
                                pixelformat="yuv420p", macro_block_size=2)
    try:
        for hu, label in zip(frames_hu, labels):
            img = Image.fromarray(window(hu, center, width)).resize(size, Image.LANCZOS).convert("RGB")
            draw = ImageDraw.Draw(img)
            pad = size[0] // 60
            if title:
                draw.text((pad, pad), title, font=font, fill=(255, 255, 255))
            draw.text((pad, size[1] - pad - font.size), label, font=font, fill=(255, 214, 120))
            writer.append_data(np.asarray(img))
    finally:
        writer.close()
