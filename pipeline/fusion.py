"""Reconstrucción isotrópica a partir de las tres series ortogonales de 3 mm.

Cada serie es nítida en su plano (~0.3 mm) pero promedia 3 mm a lo largo de su
normal. Se modela cada corte como el promedio del volumen real en un bloque de
3 mm, muestreado en su posición, y se resuelve por mínimos cuadrados (gradiente
conjugado) con una penalización suave de gradiente:

    min_V  Σ_k ||A_k V − S_k||² + λ ||∇V||²

El resultado combina la resolución fina de cada plano en un volumen de vóxel
cúbico, apto para reformatear cada milímetro y para extraer la superficie ósea.
"""
from __future__ import annotations

import time
from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from dicom_io import Series

AIR = -1024.0


@dataclass
class Grid:
    origin: np.ndarray  # posición LPS del vóxel [0,0,0] (x, y, z)
    spacing: float
    shape: tuple[int, int, int]  # (nz, ny, nx)

    @property
    def size(self) -> int:
        return int(np.prod(self.shape))


class TrilinearSampler:
    """Interpolación trilineal en puntos fijos y su operador adjunto exacto."""

    def __init__(self, coords_zyx: np.ndarray, shape: tuple[int, int, int]):
        self.shape = shape
        self.nvox = int(np.prod(shape))
        hi = np.array(shape, np.float32)[:, None] - 1
        self.valid = np.all((coords_zyx >= 0) & (coords_zyx <= hi), axis=0)
        c = coords_zyx[:, self.valid].astype(np.float32)
        i0 = np.minimum(np.floor(c).astype(np.int64), (hi - 1).astype(np.int64))
        self.frac = (c - i0).astype(np.float32)
        nz, ny, nx = shape
        self.base = i0[0] * (ny * nx) + i0[1] * nx + i0[2]
        self.offsets = [(dz, dy, dx, dz * ny * nx + dy * nx + dx)
                        for dz in (0, 1) for dy in (0, 1) for dx in (0, 1)]

    def _weight(self, dz: int, dy: int, dx: int) -> np.ndarray:
        fz, fy, fx = self.frac
        return ((fz if dz else 1 - fz) * (fy if dy else 1 - fy) * (fx if dx else 1 - fx))

    def gather(self, flat: np.ndarray) -> np.ndarray:
        out = np.zeros(self.base.shape[0], np.float32)
        for dz, dy, dx, off in self.offsets:
            out += self._weight(dz, dy, dx) * flat[self.base + off]
        return out

    def scatter(self, values: np.ndarray) -> np.ndarray:
        acc = np.zeros(self.nvox, np.float32)
        for dz, dy, dx, off in self.offsets:
            acc += np.bincount(self.base + off, weights=self._weight(dz, dy, dx) * values,
                               minlength=self.nvox).astype(np.float32)
        return acc.reshape(self.shape)


@dataclass
class Stack:
    name: str
    axis: int  # eje del arreglo (z=0, y=1, x=2) más cercano a la normal
    kernel: np.ndarray  # perfil de corte de 3 mm muestreado en la grilla
    sampler: TrilinearSampler
    data: np.ndarray  # muestras válidas, HU + 1024

    def forward(self, u: np.ndarray) -> np.ndarray:
        blurred = ndimage.correlate1d(u, self.kernel, axis=self.axis, mode="constant")
        return self.sampler.gather(blurred.ravel())

    def adjoint(self, r: np.ndarray) -> np.ndarray:
        acc = self.sampler.scatter(r)
        return ndimage.correlate1d(acc, self.kernel, axis=self.axis, mode="constant")


def box_kernel(width_vox: float) -> np.ndarray:
    """Promedio sobre `width_vox` vóxeles, centrado (pesos por solapamiento)."""
    half = width_vox / 2
    k = int(np.ceil(half - 0.5))
    taps = np.arange(-k, k + 1)
    w = np.clip(np.minimum(taps + 0.5, half) - np.maximum(taps - 0.5, -half), 0, None)
    return (w / w.sum()).astype(np.float32)


def series_bounds(s: Series) -> tuple[np.ndarray, np.ndarray]:
    ext_r = (s.cols - 1) * s.pixel_spacing[1] * s.row_dir
    ext_c = (s.rows - 1) * s.pixel_spacing[0] * s.col_dir
    half_n = s.thickness / 2 * s.normal / np.linalg.norm(s.normal)
    pts = []
    for p in (s.positions[0], s.positions[-1]):
        for a in (0, 1):
            for b in (0, 1):
                for sgn in (-1, 1):
                    pts.append(p + a * ext_r + b * ext_c + sgn * half_n)
    pts = np.array(pts)
    return pts.min(0), pts.max(0)


def make_grid(series: list[Series], spacing: float) -> Grid:
    lo = np.min([series_bounds(s)[0] for s in series], axis=0)
    hi = np.max([series_bounds(s)[1] for s in series], axis=0)
    origin = np.floor(lo / spacing) * spacing
    n = np.ceil((hi - origin) / spacing).astype(int) + 1
    return Grid(origin=origin, spacing=spacing, shape=(int(n[2]), int(n[1]), int(n[0])))


def build_stack(s: Series, hu: np.ndarray, grid: Grid) -> Stack:
    t = grid.spacing
    ps_r, ps_c = s.pixel_spacing
    # Remuestreo en el plano a la resolución de la grilla (con antialiasing)
    fr, fc = t / ps_r, t / ps_c
    smooth = ndimage.gaussian_filter(hu, sigma=(0, 0.4 * fr, 0.4 * fc))
    nr = int((s.rows - 1) / fr) + 1
    nc = int((s.cols - 1) / fc) + 1
    data = ndimage.affine_transform(smooth, [1.0, fr, fc], output_shape=(len(hu), nr, nc), order=1)

    rr = np.arange(nr) * t
    cc = np.arange(nc) * t
    world = (s.positions[:, None, None, :]
             + cc[None, None, :, None] * s.row_dir
             + rr[None, :, None, None] * s.col_dir)
    idx = (world - grid.origin) / t  # (n, nr, nc, 3) en orden x, y, z
    coords = np.stack([idx[..., 2].ravel(), idx[..., 1].ravel(), idx[..., 0].ravel()]).astype(np.float32)
    sampler = TrilinearSampler(coords, grid.shape)
    axis = {0: 2, 1: 1, 2: 0}[s.axis]
    return Stack(
        name=s.plane,
        axis=axis,
        kernel=box_kernel(s.thickness / t),
        sampler=sampler,
        data=(data.ravel()[sampler.valid] - AIR).astype(np.float32),
    )


def reconstruct(series: list[Series], volumes: list[np.ndarray], spacing: float = 0.5,
                lam: float = 0.02, iterations: int = 20, log=print) -> tuple[np.ndarray, Grid]:
    grid = make_grid(series, spacing)
    log(f"  grilla {grid.shape[::-1]} (x,y,z) a {spacing} mm, {grid.size / 1e6:.1f} M vóxeles")
    stacks = [build_stack(s, v, grid) for s, v in zip(series, volumes)]
    for st in stacks:
        log(f"  {st.name}: {st.data.size / 1e6:.1f} M muestras, perfil {len(st.kernel)} vóxeles")

    def normal_op(u: np.ndarray) -> np.ndarray:
        out = sum(st.adjoint(st.forward(u)) for st in stacks)
        return out - lam * ndimage.laplace(u)

    # Inicio: retroproyección normalizada (promedio de las tres series)
    num = sum(st.adjoint(st.data) for st in stacks)
    den = sum(st.adjoint(np.ones_like(st.data)) for st in stacks)
    coverage = den > 1e-3
    u = np.where(coverage, num / np.maximum(den, 1e-6), 0).astype(np.float32)

    b = num
    r = b - normal_op(u)
    p = r.copy()
    rs = float(np.vdot(r, r))
    rs0 = rs
    for it in range(iterations):
        t0 = time.time()
        ap = normal_op(p)
        alpha = rs / float(np.vdot(p, ap))
        u += alpha * p
        r -= alpha * ap
        rs_new = float(np.vdot(r, r))
        log(f"  iter {it + 1:2d}/{iterations}  residuo rel {np.sqrt(rs_new / rs0):.4f}  ({time.time() - t0:.1f}s)")
        p = r + (rs_new / rs) * p
        rs = rs_new

    hu = np.where(coverage, u + AIR, AIR)
    return np.clip(hu, -1024, 3071).astype(np.int16), grid


def single_series_volume(s: Series, hu: np.ndarray, grid: Grid) -> np.ndarray:
    """Interpolación simple de una sola serie (para comparar con la reconstrucción)."""
    st = build_stack(s, hu, grid)
    num = st.adjoint(st.data)
    den = st.adjoint(np.ones_like(st.data))
    return np.where(den > 1e-3, num / np.maximum(den, 1e-6) + AIR, AIR).astype(np.int16)
