export type PlaneId = 'axial' | 'coronal' | 'sagital'

export interface WindowPreset {
  id: string
  label: string
  center: number
  width: number
}

export interface SeriesEntry {
  /** Único por serie: "axial", "axial-2"… */
  id: string
  plane: PlaneId
  label: string
  description: string
  direction: string
  count: number
  thicknessMm: number
  stepMm: number
  pixelSpacingMm: [number, number]
  rows: number
  cols: number
  axis: 'x' | 'y' | 'z'
  positionsMm: number[]
  files: string[]
  video?: string
}

export interface VolumeEntry {
  url: string
  dtype: 'int16'
  dimensions: [number, number, number]
  spacing: [number, number, number]
  origin: [number, number, number]
  direction: number[]
  method: string
  videos: Partial<Record<PlaneId, string>>
}

export interface SurfaceEntry {
  glb: string
  stl: string
  thresholdHU: number
  faces: number
  vertices: number
  sizeMm: [number, number, number]
  volumeMl?: number
}

export interface MeshEntry extends SurfaceEntry {
  /** Aire interno: senos paranasales, fosas nasales, vía aérea y mastoides */
  air?: SurfaceEntry
}

export interface Manifest {
  study: { description: string; date: string; manufacturer: string; kernel: string }
  series: SeriesEntry[]
  volume: VolumeEntry
  mesh: MeshEntry
  windowPresets: WindowPreset[]
  /** Giro de 360° del cráneo, generado con web/scripts/render-360.mjs + pipeline/turntable.py */
  turntable?: { video: string; frames: number; fps: number; seconds: number }
}

export const DATA_BASE = `${import.meta.env.BASE_URL}data/`

export function dataUrl(path: string): string {
  return DATA_BASE + path
}

export async function loadManifest(): Promise<Manifest> {
  const res = await fetch(dataUrl('manifest.json'))
  if (!res.ok) throw new Error('No encontré data/manifest.json. Corre primero el pipeline de Python.')
  return res.json()
}

/** Posición relativa al primer corte, en mm, con signo según el orden anatómico. */
export function relativeMm(series: SeriesEntry, index: number): number {
  return series.positionsMm[index] - series.positionsMm[0]
}

export function formatMm(v: number, digits = 1): string {
  return `${v.toFixed(digits).replace('-', '−')} mm`
}
