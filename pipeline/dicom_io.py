"""Lectura y ordenamiento de las series DICOM del CD."""
from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import pydicom
from pydicom.uid import CTImageStorage

# Eje dominante de la normal al corte (LPS: x=izquierda, y=posterior, z=superior)
PLANE_BY_AXIS = {0: "sagital", 1: "coronal", 2: "axial"}
PLANE_ORDER = ["axial", "coronal", "sagital"]
DIRECTION_LABEL = {
    "axial": "de inferior a superior",
    "coronal": "de anterior a posterior",
    "sagital": "de derecha a izquierda",
}

# Identificadores que no deben viajar a la copia web
PHI_TAGS = [
    "PatientName", "PatientID", "PatientBirthDate", "PatientBirthTime", "OtherPatientIDs",
    "OtherPatientIDsSequence", "OtherPatientNames", "PatientAddress", "PatientTelephoneNumbers",
    "PatientMotherBirthName", "MedicalRecordLocator", "IssuerOfPatientID",
    "InstitutionName", "InstitutionAddress", "InstitutionalDepartmentName",
    "ReferringPhysicianName", "ReferringPhysicianAddress", "ReferringPhysicianTelephoneNumbers",
    "PerformingPhysicianName", "NameOfPhysiciansReadingStudy", "PhysiciansOfRecord",
    "OperatorsName", "RequestingPhysician", "StationName", "DeviceSerialNumber",
    "AccessionNumber", "StudyID", "RequestAttributesSequence",
]


@dataclass
class Series:
    uid: str
    plane: str
    description: str
    paths: list[Path]
    headers: list[pydicom.Dataset]
    row_dir: np.ndarray
    col_dir: np.ndarray
    normal: np.ndarray
    pixel_spacing: tuple[float, float]  # (entre filas, entre columnas) en mm
    thickness: float
    positions: np.ndarray  # ImagePositionPatient por corte, (n, 3)
    windows: list[dict] = field(default_factory=list)

    @property
    def axis(self) -> int:
        return int(np.argmax(np.abs(self.normal)))

    @property
    def rows(self) -> int:
        return int(self.headers[0].Rows)

    @property
    def cols(self) -> int:
        return int(self.headers[0].Columns)

    def load_hu(self) -> np.ndarray:
        """Volumen (cortes, filas, columnas) en unidades Hounsfield."""
        out = np.empty((len(self.paths), self.rows, self.cols), np.float32)
        for i, p in enumerate(self.paths):
            ds = pydicom.dcmread(p)
            out[i] = ds.pixel_array * float(ds.RescaleSlope) + float(ds.RescaleIntercept)
        return out


def _windows(ds: pydicom.Dataset) -> list[dict]:
    centers = ds.get("WindowCenter")
    widths = ds.get("WindowWidth")
    if centers is None or widths is None:
        return []
    centers = list(centers) if isinstance(centers, pydicom.multival.MultiValue) else [centers]
    widths = list(widths) if isinstance(widths, pydicom.multival.MultiValue) else [widths]
    return [{"center": float(c), "width": float(w)} for c, w in zip(centers, widths)]


def discover_series(raw_dir: Path) -> list[Series]:
    """Agrupa los cortes CT por serie, descarta localizadores y ordena por posición."""
    groups: dict[str, list[tuple[Path, pydicom.Dataset]]] = {}
    for path in sorted(raw_dir.rglob("*")):
        if not path.is_file() or path.name.upper() == "DICOMDIR":
            continue
        try:
            ds = pydicom.dcmread(path, stop_before_pixels=True)
        except Exception:
            continue
        if ds.get("SOPClassUID") != CTImageStorage:
            continue
        if "LOCALIZER" in [str(t).upper() for t in ds.get("ImageType", [])]:
            continue
        groups.setdefault(ds.SeriesInstanceUID, []).append((path, ds))

    series: list[Series] = []
    for uid, items in groups.items():
        if len(items) < 3:
            continue
        first = items[0][1]
        iop = np.array(first.ImageOrientationPatient, float)
        row_dir, col_dir = iop[:3], iop[3:]
        normal = np.cross(row_dir, col_dir)
        axis = int(np.argmax(np.abs(normal)))
        # Orden anatómico: coordenada creciente en el eje dominante
        items.sort(key=lambda it: float(it[1].ImagePositionPatient[axis]))
        series.append(Series(
            uid=uid,
            plane=PLANE_BY_AXIS[axis],
            description=str(first.get("SeriesDescription", "")).strip(),
            paths=[p for p, _ in items],
            headers=[d for _, d in items],
            row_dir=row_dir,
            col_dir=col_dir,
            normal=normal,
            pixel_spacing=(float(first.PixelSpacing[0]), float(first.PixelSpacing[1])),
            thickness=float(first.get("SliceThickness", 0) or 0),
            positions=np.array([[float(v) for v in d.ImagePositionPatient] for _, d in items]),
            windows=_windows(first),
        ))
    series.sort(key=lambda s: PLANE_ORDER.index(s.plane))
    return series


def write_anonymized_copy(series: Series, out_dir: Path) -> list[str]:
    """Copia los cortes ya ordenados (0001.dcm, 0002.dcm…) sin datos identificables."""
    out_dir.mkdir(parents=True, exist_ok=True)
    names = []
    for i, path in enumerate(series.paths, start=1):
        ds = pydicom.dcmread(path)
        for tag in PHI_TAGS:
            if tag in ds:
                delattr(ds, tag)
        ds.PatientName = "ANONIMO"
        ds.PatientID = "ANONIMO"
        ds.remove_private_tags()
        name = f"{i:04d}.dcm"
        ds.save_as(out_dir / name, enforce_file_format=True)
        names.append(name)
    return names
