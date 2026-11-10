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
  /** Origen de la escena 3D en coordenadas del estudio (mm, LPS) */
  centerLps?: [number, number, number]
  /** Aire interno: senos paranasales, fosas nasales, vía aérea y mastoides */
  air?: SurfaceEntry
}

export interface Manifest {
  /** Id del estudio en studies.json; lo agrega loadManifest */
  studyId: string
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

/** Props comunes de las vistas. Al comparar hay dos instancias de cada una. */
export interface ViewProps {
  manifest: Manifest
  /** Sufijo de los ids de Cornerstone: dos paneles no pueden compartir viewport ni herramientas */
  pane?: string
  /** Si este panel responde al teclado (al comparar, solo el panel activo) */
  keyboard?: boolean
}

/** Un estudio del menú: una carpeta generada por pipeline/build.py. */
export interface StudyEntry {
  id: string
  date: string
  description: string
  manufacturer?: string
  /** Carpeta del estudio relativa a data/, terminada en "/" ("" = formato antiguo de un solo estudio) */
  path: string
}

/** Estudios disponibles, del más reciente al más antiguo. */
export async function loadStudies(): Promise<StudyEntry[]> {
  const res = await fetch(dataUrl('studies.json'))
  if (res.ok) {
    const list = (await res.json()) as StudyEntry[]
    if (list.length) return list
  }
  // Formato anterior: un solo estudio directamente en data/
  const legacy = await fetch(dataUrl('manifest.json'))
  if (!legacy.ok) throw new Error('No encontré data/studies.json. Corre primero el pipeline de Python.')
  const m = (await legacy.json()) as Manifest
  return [{ id: m.study.date || 'estudio', date: m.study.date, description: m.study.description, path: '' }]
}

const manifests = new Map<string, Promise<Manifest>>()

/** Manifiesto de un estudio, con sus rutas ya relativas a data/ para usarlas con dataUrl. */
export function loadManifest(entry: StudyEntry): Promise<Manifest> {
  let p = manifests.get(entry.id)
  if (!p) {
    p = fetch(dataUrl(`${entry.path}manifest.json`)).then(async (res) => {
      if (!res.ok) throw new Error(`No encontré el manifiesto del estudio ${entry.id}.`)
      return withPrefix((await res.json()) as Manifest, entry)
    })
    p.catch(() => manifests.delete(entry.id))
    manifests.set(entry.id, p)
  }
  return p
}

function withPrefix(m: Manifest, entry: StudyEntry): Manifest {
  const pre = (path: string) => entry.path + path
  const prefixSurface = <T extends SurfaceEntry>(s: T): T => ({ ...s, glb: pre(s.glb), stl: pre(s.stl) })
  return {
    ...m,
    studyId: entry.id,
    series: m.series.map((s) => ({ ...s, files: s.files.map(pre), video: s.video && pre(s.video) })),
    volume: {
      ...m.volume,
      url: pre(m.volume.url),
      videos: Object.fromEntries(Object.entries(m.volume.videos).map(([k, v]) => [k, v && pre(v)])),
    },
    mesh: { ...prefixSurface(m.mesh), air: m.mesh.air && prefixSurface(m.mesh.air) },
    turntable: m.turntable && { ...m.turntable, video: pre(m.turntable.video) },
  }
}

/** Alineación rígida entre dos estudios, calculada por pipeline/register.py. */
export interface Registration {
  a: string
  b: string
  /** 4x4 por filas: lleva coordenadas (mm) del estudio a a las del estudio b */
  matrix: number[][]
  medianMm: number
  inlierFraction: number
  rotationDeg: number
}

export async function loadRegistrations(): Promise<Registration[]> {
  const res = await fetch(dataUrl('registrations.json'))
  return res.ok ? res.json() : []
}

/** Matriz que lleva coordenadas de `from` a las de `to`, o null si no están alineados. */
export function transformBetween(regs: Registration[], from: string, to: string): number[][] | null {
  if (from === to) return [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]]
  const direct = regs.find((r) => r.a === from && r.b === to)
  if (direct) return direct.matrix
  const reverse = regs.find((r) => r.a === to && r.b === from)
  return reverse ? invertRigid(reverse.matrix) : null
}

/** Inversa de una transformación rígida: R^T y -R^T t. */
function invertRigid(m: number[][]): number[][] {
  const r = [0, 1, 2].map((i) => [0, 1, 2].map((j) => m[j][i]))
  const t = [0, 1, 2].map((i) => -(r[i][0] * m[0][3] + r[i][1] * m[1][3] + r[i][2] * m[2][3]))
  return [[...r[0], t[0]], [...r[1], t[1]], [...r[2], t[2]], [0, 0, 0, 1]]
}

/** Fecha del estudio en formato largo, p. ej. "13 de septiembre de 2024". */
export function longDate(date: string): string {
  return date ? new Date(`${date}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' }) : ''
}

/** Posición relativa al primer corte, en mm, con signo según el orden anatómico. */
export function relativeMm(series: SeriesEntry, index: number): number {
  return series.positionsMm[index] - series.positionsMm[0]
}

export function formatMm(v: number, digits = 1): string {
  return `${v.toFixed(digits).replace('-', '−')} mm`
}
