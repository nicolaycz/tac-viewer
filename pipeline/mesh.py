"""Superficie ósea (marching cubes) exportada a GLB para la web y STL para imprimir."""
from __future__ import annotations

from pathlib import Path

import fast_simplification
import numpy as np
import trimesh
from scipy import ndimage
from skimage.measure import marching_cubes

from fusion import Grid

BONE_COLOR = [232, 222, 200, 255]


def bone_surface(hu: np.ndarray, grid: Grid, threshold: float, smooth_mm: float = 0.65,
                 min_component_ml: float = 0.3, target_faces: int = 450_000, log=print):
    """Devuelve vértices en LPS (mm) y caras de la isosuperficie ósea."""
    s = grid.spacing
    vol = ndimage.gaussian_filter(hu.astype(np.float32), smooth_mm / s)
    mask = vol > threshold
    labels, n = ndimage.label(mask)
    sizes = np.bincount(labels.ravel())[1:]
    min_vox = min_component_ml * 1000 / s**3
    keep_ids = np.flatnonzero(sizes >= min_vox) + 1
    log(f"  {n} componentes sobre {threshold} HU; se conservan {len(keep_ids)} (≥ {min_component_ml} ml)")
    keep = np.isin(labels, keep_ids)
    keep = ndimage.binary_dilation(keep, iterations=2)
    vol[~keep] = min(threshold - 200, -500)

    verts, faces = _closed_marching_cubes(vol, threshold, grid)
    log(f"  marching cubes: {len(verts):,} vértices, {len(faces):,} caras")

    return _simplify(verts, faces, target_faces, log)


def internal_air_surface(hu: np.ndarray, grid: Grid, air_hu: float = -400, closing_mm: float = 6,
                         margin_mm: float = 4, min_component_ml: float = 0.2, min_bone_contact: float = 0.05,
                         target_faces: int = 200_000, log=print):
    """Aire dentro de la cabeza: senos paranasales, fosas nasales, vía aérea y mastoides.

    Se arma una máscara de la cabeza (cierre morfológico que tapa las narinas y
    relleno de huecos por corte axial) y se queda solo el aire que cae dentro.
    Las operaciones de máscara se hacen a 1 mm para que sean rápidas.
    """
    s = grid.spacing
    f = max(1, int(round(1.0 / s)))
    coarse = ndimage.gaussian_filter(hu.astype(np.float32), 0.5 / s)[::f, ::f, ::f]
    body = coarse > -500
    # Cierre con una esfera de `closing_mm` vía transformada de distancia (mucho más rápido)
    r = closing_mm / (s * f)
    p = int(np.ceil(r)) + 1
    padded = np.pad(body, p)
    dilated = ndimage.distance_transform_edt(~padded) <= r
    head = (ndimage.distance_transform_edt(dilated) > r)[p:-p, p:-p, p:-p]
    for k in range(head.shape[0]):
        head[k] = ndimage.binary_fill_holes(head[k])
    # Margen bajo la piel: deja fuera el aire atrapado en los pliegues de las orejas
    head = ndimage.distance_transform_edt(head) > margin_mm / (s * f)
    air = (coarse < air_hu) & head
    labels, n = ndimage.label(air)
    sizes = np.bincount(labels.ravel())
    min_vox = min_component_ml * 1000 / (s * f) ** 3
    bone = coarse > 250
    keep_ids = []
    for i, box in enumerate(ndimage.find_objects(labels), start=1):
        if box is None or sizes[i] < min_vox:
            continue
        # Los senos y las mastoides están rodeados de hueso; el aire de las orejas no
        box = tuple(slice(max(b.start - 3, 0), b.stop + 3) for b in box)
        comp = labels[box] == i
        shell = ndimage.binary_dilation(comp, iterations=2) & ~comp
        if bone[box][shell].mean() >= min_bone_contact:
            keep_ids.append(i)
    keep = np.isin(labels, keep_ids)
    log(f"  aire interno: {n} regiones, se conservan {len(keep_ids)} "
        f"({keep.sum() * (s * f) ** 3 / 1000:.1f} ml)")

    # Superficie suave a resolución completa, limitada a la máscara de aire interno
    keep_full = np.repeat(np.repeat(np.repeat(keep, f, 0), f, 1), f, 2)[:hu.shape[0], :hu.shape[1], :hu.shape[2]]
    keep_full = ndimage.binary_dilation(keep_full, iterations=2)
    vol = ndimage.gaussian_filter(hu.astype(np.float32), 0.6 / s)
    vol = np.where(keep_full, -vol, -air_hu - 400)  # aire = valores altos
    verts, faces = _closed_marching_cubes(vol, -air_hu, grid)
    return _simplify(verts, faces, target_faces, log)


def _closed_marching_cubes(vol: np.ndarray, level: float, grid: Grid):
    """Marching cubes con un borde de 1 vóxel por debajo del nivel: la malla queda cerrada."""
    s = grid.spacing
    padded = np.pad(vol, 1, constant_values=min(float(vol.min()), level - 1))
    verts, faces, _, _ = marching_cubes(padded, level=level, spacing=(s, s, s), step_size=1)
    # (z, y, x) → LPS (x, y, z); el cambio de ejes invierte la orientación de las caras
    verts = verts[:, ::-1] - s + grid.origin
    return verts, faces[:, ::-1]


def _simplify(verts, faces, target_faces, log):
    if len(faces) > target_faces:
        reduction = 1 - target_faces / len(faces)
        verts, faces = fast_simplification.simplify(verts.astype(np.float32), faces.astype(np.int32),
                                                    target_reduction=reduction)
        log(f"  simplificada a {len(faces):,} caras")
    return verts.astype(np.float64), faces.astype(np.int64)


def mesh_center(verts_lps: np.ndarray) -> np.ndarray:
    return (verts_lps.min(0) + verts_lps.max(0)) / 2


def export_meshes(verts_lps: np.ndarray, faces: np.ndarray, center: np.ndarray, glb_path: Path,
                  stl_path: Path | None = None, color=BONE_COLOR) -> dict:
    """Exporta centrado en `center` (el mismo para todas las mallas, para que encajen)."""
    # Web (three.js, Y arriba, la cara mira hacia +Z): (x, y, z)_LPS → (x, z, −y)
    v = verts_lps - center
    web = trimesh.Trimesh(np.column_stack([v[:, 0], v[:, 2], -v[:, 1]]), faces, process=True)
    # Las normales deben apuntar fuera del material (hueso o aire)
    inverted = web.volume < 0
    if inverted:
        web.invert()
    web.visual = trimesh.visual.ColorVisuals(web, vertex_colors=np.tile(color, (len(web.vertices), 1)))
    glb_path.write_bytes(web.export(file_type="glb"))

    if stl_path is not None:
        # Impresión 3D: coordenadas RAS (Z arriba, la cara mira hacia +Y), en mm
        stl = trimesh.Trimesh(np.column_stack([-v[:, 0], -v[:, 1], v[:, 2]]), faces, process=True)
        if inverted:
            stl.invert()
        stl.export(stl_path)

    size = verts_lps.max(0) - verts_lps.min(0)
    return {
        "faces": int(len(web.faces)),
        "vertices": int(len(web.vertices)),
        "sizeMm": [round(float(x), 1) for x in size],
        "volumeMl": round(abs(float(web.volume)) / 1000, 1),
    }
