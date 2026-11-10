"""Alinea los estudios entre sí para compararlos corte a corte.

Cada TAC tiene su propio sistema de coordenadas (la mesa y la cabeza nunca quedan
igual), así que el mismo punto del cráneo tiene coordenadas distintas en cada
estudio. Este script calcula, para cada par de estudios, la transformación rígida
(rotación + traslación) que lleva las coordenadas de uno a las del otro:

  1. Extrae la superficie del hueso de cada volumen reconstruido (a 1 mm).
  2. Parte alineando los centros de las dos superficies.
  3. ICP recortado: empareja cada punto con el más cercano del otro cráneo,
     descarta los pares más lejanos (mandíbula que se movió, bordes del campo
     de visión) y resuelve la rotación óptima; primero punto a punto y luego
     punto a plano para afinar.

El hueso del cráneo no cambia entre estudios, por eso sirve de referencia.

Uso:
    .venv/bin/python pipeline/register.py            # todos los pares de studies.json
    .venv/bin/python pipeline/register.py --force    # recalcula aunque ya existan
"""
from __future__ import annotations

import argparse
import gzip
import itertools
import json
import sys
import time
from pathlib import Path

import numpy as np
from scipy.spatial import cKDTree
from skimage import measure

DATA = Path("web/public/data")
BONE_HU = 300


def log(msg: str):
    print(msg, flush=True)


def bone_points(study_dir: Path, rng: np.random.Generator, n: int = 60_000):
    """Puntos y normales de la superficie ósea, en mm del sistema del estudio."""
    manifest = json.loads((study_dir / "manifest.json").read_text())
    vol = manifest["volume"]
    nx, ny, nz = vol["dimensions"]
    raw = gzip.decompress((study_dir / vol["url"]).read_bytes())
    hu = np.frombuffer(raw, "<i2").reshape(nz, ny, nx)
    step = max(1, int(round(1.0 / vol["spacing"][0])))  # ~1 mm basta para alinear
    sub = hu[::step, ::step, ::step].astype(np.float32)
    verts, faces, normals, _ = measure.marching_cubes(sub, BONE_HU)
    # marching_cubes devuelve (z, y, x) en índices del submuestreo
    sp = np.array(vol["spacing"], float) * step
    pts = np.array(vol["origin"], float) + verts[:, ::-1] * sp
    nrm = normals[:, ::-1]
    nrm /= np.linalg.norm(nrm, axis=1, keepdims=True) + 1e-9
    if len(pts) > n:
        keep = rng.choice(len(pts), n, replace=False)
        pts, nrm = pts[keep], nrm[keep]
    return pts, nrm


def kabsch(p: np.ndarray, q: np.ndarray):
    """Rotación y traslación que llevan p sobre q por mínimos cuadrados."""
    cp, cq = p.mean(0), q.mean(0)
    h = (p - cp).T @ (q - cq)
    u, _, vt = np.linalg.svd(h)
    d = np.sign(np.linalg.det(vt.T @ u.T))
    r = vt.T @ np.diag([1, 1, d]) @ u.T
    return r, cq - r @ cp


def point_to_plane(p: np.ndarray, q: np.ndarray, n: np.ndarray):
    """Paso linealizado punto a plano (ángulos pequeños)."""
    a = np.hstack([np.cross(p, n), n])
    b = np.einsum("ij,ij->i", q - p, n)
    x, *_ = np.linalg.lstsq(a, b, rcond=None)
    ax, ay, az, tx, ty, tz = x
    rx = np.array([[1, 0, 0], [0, np.cos(ax), -np.sin(ax)], [0, np.sin(ax), np.cos(ax)]])
    ry = np.array([[np.cos(ay), 0, np.sin(ay)], [0, 1, 0], [-np.sin(ay), 0, np.cos(ay)]])
    rz = np.array([[np.cos(az), -np.sin(az), 0], [np.sin(az), np.cos(az), 0], [0, 0, 1]])
    return rz @ ry @ rx, np.array([tx, ty, tz])


def to_matrix(r: np.ndarray, t: np.ndarray) -> np.ndarray:
    m = np.eye(4)
    m[:3, :3], m[:3, 3] = r, t
    return m


def apply(m: np.ndarray, pts: np.ndarray) -> np.ndarray:
    return pts @ m[:3, :3].T + m[:3, 3]


def icp(src: np.ndarray, dst: np.ndarray, dst_n: np.ndarray, init: np.ndarray):
    tree = cKDTree(dst)
    m = init.copy()
    schedule = [(0.75, "punto")] * 30 + [(0.7, "plano")] * 30
    for keep_frac, mode in schedule:
        p = apply(m, src)
        d, idx = tree.query(p, workers=-1)
        keep = d <= np.quantile(d, keep_frac)
        if mode == "punto":
            r, t = kabsch(p[keep], dst[idx[keep]])
        else:
            r, t = point_to_plane(p[keep], dst[idx[keep]], dst_n[idx[keep]])
        m = to_matrix(r, t) @ m
        if np.linalg.norm(t) < 1e-4 and abs(np.trace(r) - 3) < 1e-8:
            break
    d, _ = tree.query(apply(m, src), workers=-1)
    return m, d


def register_pair(dir_a: Path, dir_b: Path, rng: np.random.Generator):
    """Matriz 4x4 que lleva coordenadas del estudio a a las del estudio b."""
    pa, _ = bone_points(dir_a, rng)
    pb, nb = bone_points(dir_b, rng)
    init = to_matrix(np.eye(3), pb.mean(0) - pa.mean(0))
    # Varias rotaciones iniciales (flexión y giro de la cabeza): se queda con la que mejor encaja
    best = None
    for rx, rz in itertools.product((-10, 0, 10), (-8, 0, 8)):
        a, c = np.radians(rx), np.radians(rz)
        rot = np.array([[1, 0, 0], [0, np.cos(a), -np.sin(a)], [0, np.sin(a), np.cos(a)]]) @ \
            np.array([[np.cos(c), -np.sin(c), 0], [np.sin(c), np.cos(c), 0], [0, 0, 1]])
        ca = pa.mean(0)
        start = init @ to_matrix(rot, ca - rot @ ca)
        m, d = icp(pa, pb, nb, start)
        score = np.median(d)
        if best is None or score < best[0]:
            best = (score, m, d)
    _, m, d = best
    inliers = d < 2.0
    angle = np.degrees(np.arccos(np.clip((np.trace(m[:3, :3]) - 1) / 2, -1, 1)))
    return m, {
        "medianMm": round(float(np.median(d)), 2),
        "inlierRmsMm": round(float(np.sqrt(np.mean(d[inliers] ** 2))), 2),
        "inlierFraction": round(float(inliers.mean()), 3),
        "rotationDeg": round(float(angle), 2),
        "translationMm": round(float(np.linalg.norm(m[:3, 3])), 1),
    }


def register_all(data_dir: Path = DATA, force: bool = False):
    index = data_dir / "studies.json"
    if not index.exists():
        return
    studies = json.loads(index.read_text())
    out_path = data_dir / "registrations.json"
    existing = json.loads(out_path.read_text()) if out_path.exists() else []
    ids = {s["id"] for s in studies}
    done = {(r["a"], r["b"]) for r in existing}
    results = [r for r in existing if r["a"] in ids and r["b"] in ids]
    rng = np.random.default_rng(0)
    # Un par por combinación; el visor invierte la matriz para el sentido contrario
    for sa, sb in itertools.combinations(sorted(studies, key=lambda s: s["date"] or s["id"]), 2):
        if not force and ((sa["id"], sb["id"]) in done or (sb["id"], sa["id"]) in done):
            continue
        t0 = time.time()
        log(f"  alineando {sa['id']} → {sb['id']}…")
        m, q = register_pair(data_dir / sa["path"], data_dir / sb["path"], rng)
        results = [r for r in results if {r["a"], r["b"]} != {sa["id"], sb["id"]}]
        results.append({"a": sa["id"], "b": sb["id"], "matrix": np.round(m, 6).tolist(), **q,
                        "method": "ICP rígido sobre la superficie ósea (≥ 300 HU)"})
        log(f"    mediana {q['medianMm']} mm · RMS de inliers {q['inlierRmsMm']} mm · "
            f"{q['inlierFraction'] * 100:.0f}% a menos de 2 mm · giro {q['rotationDeg']}° ({time.time() - t0:.0f}s)")
    out_path.write_text(json.dumps(results, ensure_ascii=False, indent=1))
    return results


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--data", type=Path, default=DATA)
    ap.add_argument("--force", action="store_true", help="recalcular pares ya alineados")
    args = ap.parse_args()
    if not (args.data / "studies.json").exists():
        sys.exit(f"No encontré {args.data / 'studies.json'}. Procesa primero los estudios con build.py.")
    log("Alineando estudios…")
    register_all(args.data, args.force)
    log(f"Listo → {args.data / 'registrations.json'}")


if __name__ == "__main__":
    main()
