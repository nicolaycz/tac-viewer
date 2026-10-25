"""Genera todo lo que consume el visor web a partir del CD del TAC.

Uso:
    .venv/bin/python pipeline/build.py --raw data/raw --out web/public/data
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import sys
import time
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))

from dicom_io import DIRECTION_LABEL, discover_series, write_anonymized_copy  # noqa: E402
from fusion import Grid, reconstruct, single_series_volume  # noqa: E402
from mesh import bone_surface, export_meshes, internal_air_surface, mesh_center  # noqa: E402
from video import window, write_cine  # noqa: E402

PLANE_LABEL = {"axial": "Axial", "coronal": "Coronal", "sagital": "Sagital"}
AXIS_NAME = {0: "x", 1: "y", 2: "z"}
WINDOW_PRESETS = [
    {"id": "hueso", "label": "Hueso", "center": 450, "width": 1500},
    {"id": "senos", "label": "Senos", "center": -200, "width": 2000},
    {"id": "blando", "label": "Tejido blando", "center": 40, "width": 350},
    {"id": "cerebro", "label": "Cerebro", "center": 40, "width": 80},
]


def log(msg: str):
    print(msg, flush=True)


def fused_slices(hu: np.ndarray, grid: Grid, plane: str, step_mm: float = 1.0):
    """Cortes del volumen reconstruido cada `step_mm`, orientados como en radiología."""
    step = max(1, int(round(step_mm / grid.spacing)))
    nz, ny, nx = hu.shape
    o, s = grid.origin, grid.spacing
    if plane == "axial":
        idx = range(0, nz, step)
        return [hu[i] for i in idx], [o[2] + i * s for i in idx], "z"
    if plane == "coronal":
        idx = range(0, ny, step)
        return [hu[::-1, i, :] for i in idx], [o[1] + i * s for i in idx], "y"
    idx = range(0, nx, step)
    return [hu[::-1, :, i] for i in idx], [o[0] + i * s for i in idx], "x"


def comparison_image(fused: np.ndarray, naive: np.ndarray, path: Path):
    """Sagital y coronal centrales: solo serie axial (izq.) vs reconstrucción (der.)."""
    nz, ny, nx = fused.shape
    rows = []
    for a, b in [(naive[::-1, :, nx // 2], fused[::-1, :, nx // 2]),
                 (naive[::-1, ny // 3, :], fused[::-1, ny // 3, :])]:
        rows.append(np.hstack([window(a, 450, 1500), np.full((a.shape[0], 6), 255, np.uint8),
                               window(b, 450, 1500)]))
    width = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 6), (0, width - r.shape[1]))) for r in rows]
    Image.fromarray(np.vstack(rows)).save(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", type=Path, default=Path("data/raw"))
    ap.add_argument("--out", type=Path, default=Path("web/public/data"))
    ap.add_argument("--cache", type=Path, default=Path("data/cache"))
    ap.add_argument("--spacing", type=float, default=0.5, help="vóxel isotrópico en mm")
    ap.add_argument("--iterations", type=int, default=20)
    ap.add_argument("--lam", type=float, default=0.02)
    ap.add_argument("--threshold", type=float, default=250, help="umbral óseo en HU para la malla")
    ap.add_argument("--refuse", action="store_true", help="recalcular la reconstrucción aunque exista caché")
    ap.add_argument("--skip-videos", action="store_true", help="reusar los videos ya generados")
    args = ap.parse_args()

    out, cache = args.out, args.cache
    out.mkdir(parents=True, exist_ok=True)
    cache.mkdir(parents=True, exist_ok=True)

    log("1/5  Leyendo y ordenando series…")
    series = discover_series(args.raw)
    if not series:
        sys.exit(f"No encontré series CT en {args.raw}")
    first = series[0].headers[0]
    study = {
        "description": str(first.get("StudyDescription", "")).replace("^", " ").strip(),
        "date": f"{first.StudyDate[:4]}-{first.StudyDate[4:6]}-{first.StudyDate[6:]}" if first.get("StudyDate") else "",
        "manufacturer": " ".join(str(first.get(k, "")) for k in ("Manufacturer", "ManufacturerModelName")).strip(),
        "kernel": str(first.get("ConvolutionKernel", [""])[0]) if first.get("ConvolutionKernel") else "",
    }
    manifest_series = []
    volumes = []
    per_plane: dict[str, int] = {}
    for s in series:
        hu = s.load_hu()
        volumes.append(hu)
        coords = s.positions[:, s.axis]
        step = float(np.median(np.diff(coords)))
        # Un CD puede traer varias series del mismo plano (p. ej. kernel óseo y blando)
        per_plane[s.plane] = per_plane.get(s.plane, 0) + 1
        n = per_plane[s.plane]
        sid = s.plane if n == 1 else f"{s.plane}-{n}"
        label = PLANE_LABEL[s.plane] if n == 1 else f"{PLANE_LABEL[s.plane]} {n}"
        files = write_anonymized_copy(s, out / "series" / sid)
        log(f"  {label:9s} {len(files):3d} cortes · {s.thickness:g} mm · paso {step:g} mm · {s.description}")
        manifest_series.append({
            "id": sid,
            "plane": s.plane,
            "label": label,
            "description": s.description,
            "direction": DIRECTION_LABEL[s.plane],
            "count": len(files),
            "thicknessMm": s.thickness,
            "stepMm": round(step, 3),
            "pixelSpacingMm": list(s.pixel_spacing),
            "rows": s.rows,
            "cols": s.cols,
            "axis": AXIS_NAME[s.axis],
            "positionsMm": [round(float(c), 2) for c in coords],
            "files": [f"series/{sid}/{f}" for f in files],
        })

    log("2/5  Reconstrucción isotrópica…")
    # Por plano se fusiona la serie más fina (y, a igual grosor, la de más cortes)
    best: dict[str, int] = {}
    for i, s in enumerate(series):
        j = best.get(s.plane)
        if j is None or (s.thickness, -len(s.paths)) < (series[j].thickness, -len(series[j].paths)):
            best[s.plane] = i
    chosen = sorted(best.values())
    fusion_series = [series[i] for i in chosen]
    fusion_volumes = [volumes[i] for i in chosen]
    log("  series: " + ", ".join(f"{manifest_series[i]['label']} ({series[i].thickness:g} mm)" for i in chosen))
    # La caché depende de las series usadas: otro CD no reutiliza la reconstrucción anterior
    key = hashlib.sha1("|".join(s.uid for s in fusion_series).encode()).hexdigest()[:10]
    cache_file = cache / f"fused_{args.spacing}_{key}.npz"
    if cache_file.exists() and not args.refuse:
        z = np.load(cache_file)
        fused = z["hu"]
        grid = Grid(origin=z["origin"], spacing=float(z["spacing"]), shape=tuple(fused.shape))
        log(f"  desde caché {cache_file}")
    else:
        t0 = time.time()
        fused, grid = reconstruct(fusion_series, fusion_volumes, spacing=args.spacing, lam=args.lam,
                                  iterations=args.iterations, log=log)
        np.savez(cache_file, hu=fused, origin=grid.origin, spacing=grid.spacing)
        log(f"  listo en {time.time() - t0:.0f}s")
        if "axial" in best and len(fusion_series) > 1:
            axial = best["axial"]
            naive = single_series_volume(series[axial], volumes[axial], grid)
            comparison_image(fused, naive, cache / "comparacion.png")

    vol_dir = out / "volume"
    vol_dir.mkdir(exist_ok=True)
    raw = np.ascontiguousarray(fused).astype("<i2").tobytes()
    (vol_dir / "fused-int16.bin.gz").write_bytes(gzip.compress(raw, compresslevel=6))
    nz, ny, nx = fused.shape
    volume = {
        "url": "volume/fused-int16.bin.gz",
        "dtype": "int16",
        "dimensions": [nx, ny, nz],
        "spacing": [grid.spacing] * 3,
        "origin": [round(float(v), 4) for v in grid.origin],
        "direction": [1, 0, 0, 0, 1, 0, 0, 0, 1],
        "method": "Superresolución por mínimos cuadrados a partir de: " + ", ".join(
            f"{PLANE_LABEL[s.plane].lower()} de {s.thickness:g} mm" for s in fusion_series),
        "videos": {},
    }

    log("3/5  Superficies 3D…")
    mesh_dir = out / "mesh"
    mesh_dir.mkdir(exist_ok=True)
    verts, faces = bone_surface(fused, grid, threshold=args.threshold, log=log)
    center = mesh_center(verts)
    mesh_info = export_meshes(verts, faces, center, mesh_dir / "craneo.glb", mesh_dir / "craneo.stl")
    log(f"  hueso: {mesh_info['faces']:,} caras · {mesh_info['sizeMm']} mm")
    air_verts, air_faces = internal_air_surface(fused, grid, log=log)
    air_info = export_meshes(air_verts, air_faces, center, mesh_dir / "aire.glb", mesh_dir / "aire.stl",
                             color=[110, 180, 235, 255])
    log(f"  aire: {air_info['faces']:,} caras")
    mesh = {"glb": "mesh/craneo.glb", "stl": "mesh/craneo.stl", "thresholdHU": args.threshold, **mesh_info,
            "air": {"glb": "mesh/aire.glb", "stl": "mesh/aire.stl", "thresholdHU": -400, **air_info}}

    log("4/5  Videos…")
    video_dir = out / "video"
    for s, hu, entry in zip(series, volumes, manifest_series):
        path = video_dir / f"{entry['id']}-original.mp4"
        if not args.skip_videos:
            labels = [f"{entry['label']} · corte {i + 1}/{entry['count']} · {entry['axis']} = {p:.1f} mm"
                      for i, p in enumerate(entry["positionsMm"])]
            write_cine(list(hu), labels, path, fps=6, title=f"{entry['description']} · {s.thickness:g} mm")
            log(f"  {path.name}")
        if path.exists():
            entry["video"] = f"video/{path.name}"
    for plane in ("axial", "coronal", "sagital"):
        path = video_dir / f"{plane}-1mm.mp4"
        if not args.skip_videos:
            frames, pos, axis = fused_slices(fused, grid, plane, step_mm=1.0)
            labels = [f"{PLANE_LABEL[plane]} · {i + 1}/{len(frames)} · {axis} = {p:.1f} mm" for i, p in enumerate(pos)]
            write_cine(frames, labels, path, fps=15, title="Reconstrucción isotrópica · cada 1 mm")
            log(f"  {path.name} ({len(frames)} cuadros)")
        if path.exists():
            volume["videos"][plane] = f"video/{path.name}"

    log("5/5  Manifiesto…")
    # El video 360° lo arma pipeline/turntable.py; se conserva si ya existe
    previous = out / "manifest.json"
    turntable = json.loads(previous.read_text()).get("turntable") if previous.exists() else None
    if turntable and not (out / turntable["video"]).exists():
        turntable = None
    manifest = {
        "study": study,
        "series": manifest_series,
        "volume": volume,
        "mesh": mesh,
        "windowPresets": WINDOW_PRESETS,
        **({"turntable": turntable} if turntable else {}),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    log(f"Listo → {out}")


if __name__ == "__main__":
    main()
