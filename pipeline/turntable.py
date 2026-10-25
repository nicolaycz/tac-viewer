"""Arma el MP4 del giro 360° a partir de los cuadros que graba web/scripts/render-360.mjs.

Uso:
    .venv/bin/python pipeline/turntable.py --frames data/export/frames-360 --out web/public/data
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import date
from pathlib import Path

import imageio.v2 as imageio
import numpy as np
from PIL import Image, ImageDraw

sys.path.insert(0, str(Path(__file__).parent))

from video import _font  # noqa: E402

AIR_RGB = (111, 180, 236)
BONE_RGB = (233, 223, 202)
MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sep", "oct", "nov", "dic"]


def radial_background(size: int) -> Image.Image:
    """El mismo fondo del visor: gris azulado al centro, casi negro en los bordes."""
    y, x = np.mgrid[0:size, 0:size].astype(np.float32)
    r = np.hypot((x - size * 0.5) / size, (y - size * 0.42) / size) / 0.7
    t = np.clip(r, 0, 1)[..., None]
    inner, outer = np.array([26, 29, 35], np.float32), np.array([10, 11, 13], np.float32)
    return Image.fromarray((inner * (1 - t) + outer * t).astype(np.uint8), "RGB")


def draw_overlay(img: Image.Image, title: str, subtitle: str, show_air: bool):
    size = img.size[0]
    d = ImageDraw.Draw(img)
    pad = size // 24
    big, small = _font(size // 34), _font(size // 52)
    d.text((pad, pad), title, font=big, fill=(235, 232, 226))
    d.text((pad, pad + big.size + size // 120), subtitle, font=small, fill=(141, 146, 155))
    legend = [(BONE_RGB, "Hueso")]
    if show_air:
        legend.insert(0, (AIR_RGB, "Senos, fosas nasales, vía aérea y mastoides"))
    y = size - pad - small.size
    for color, label in reversed(legend):
        sw = small.size * 0.7
        top = y + (small.size - sw) / 2 + 1
        d.rounded_rectangle([pad, top, pad + sw, top + sw], radius=2, fill=color)
        d.text((pad + sw + size // 90, y), label, font=small, fill=(200, 202, 206))
        y -= int(small.size * 1.6)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--frames", type=Path, default=Path("data/export/frames-360"))
    ap.add_argument("--out", type=Path, default=Path("web/public/data"))
    ap.add_argument("--fps", type=int, default=30)
    ap.add_argument("--name", default="craneo-360.mp4")
    ap.add_argument("--sin-aire", action="store_true", help="el video no incluye la capa de aire")
    ap.add_argument("--titulo", default="Reconstrucción 3D del cráneo")
    args = ap.parse_args()

    files = sorted(args.frames.glob("*.png"))
    if not files:
        sys.exit(f"No hay cuadros en {args.frames}. Corre primero web/scripts/render-360.mjs")
    manifest_path = args.out / "manifest.json"
    manifest = json.loads(manifest_path.read_text())
    study = manifest["study"]
    d = date.fromisoformat(study["date"]) if study.get("date") else None
    when = f"{d.day} {MONTHS[d.month - 1]} {d.year}" if d else ""
    title = args.titulo
    subtitle = " · ".join(x for x in [study.get("description", ""), when] if x)

    size = Image.open(files[0]).size[0]
    background = radial_background(size)
    path = args.out / "video" / args.name
    path.parent.mkdir(parents=True, exist_ok=True)
    writer = imageio.get_writer(path, fps=args.fps, codec="libx264", quality=9,
                                pixelformat="yuv420p", macro_block_size=2)
    try:
        for f in files:
            frame = Image.open(f).convert("RGBA")
            img = background.copy()
            img.paste(frame, (0, 0), frame)
            draw_overlay(img, title, subtitle, show_air=not args.sin_aire)
            writer.append_data(np.asarray(img))
    finally:
        writer.close()

    manifest["turntable"] = {"video": f"video/{args.name}", "frames": len(files), "fps": args.fps,
                             "seconds": round(len(files) / args.fps, 1)}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(f"Listo → {path} ({len(files)} cuadros, {len(files) / args.fps:.0f} s)")


if __name__ == "__main__":
    main()
