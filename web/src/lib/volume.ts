import { cache, metaData, volumeLoader, utilities } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import { dataUrl, type VolumeEntry } from './manifest'

/**
 * Un volumen por estudio. Sin ":" a propósito: así Cornerstone no intenta cargar
 * sus cortes con un loader por esquema. El marco de referencia también es propio
 * de cada estudio, para que las mediciones de uno no aparezcan en el otro.
 */
function volumeIds(entry: VolumeEntry) {
  const key = entry.url.replace(/[^a-zA-Z0-9]+/g, '-')
  return { id: `tac-fused-${key}`, frame: `tac-frame-${key}` }
}

/** Volúmenes descargados en memoria; con dos alcanza para comparar sin acumular estudios. */
const MAX_CACHED = 2

export interface FusedVolume {
  id: string
  entry: VolumeEntry
  data: Int16Array
  /** HU en una posición LPS (mm), o null fuera del volumen. */
  huAt(world: Types.Point3): number | null
}

const downloads = new Map<string, Promise<FusedVolume>>()

async function fetchBytes(url: string, onProgress: (f: number) => void): Promise<Uint8Array> {
  const res = await fetch(url)
  if (!res.ok || !res.body) throw new Error(`No pude descargar ${url}`)
  const total = Number(res.headers.get('content-length')) || 0
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let received = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.length
    if (total) onProgress(Math.min(1, received / total))
  }
  const bytes = new Uint8Array(received)
  let offset = 0
  for (const c of chunks) {
    bytes.set(c, offset)
    offset += c.length
  }
  return bytes
}

async function gunzipIfNeeded(bytes: Uint8Array): Promise<ArrayBuffer> {
  // Si el servidor ya lo entregó descomprimido, no tiene la firma gzip
  if (bytes[0] !== 0x1f || bytes[1] !== 0x8b) return bytes.slice().buffer
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  return new Response(stream).arrayBuffer()
}

/**
 * Descarga el volumen una sola vez y se asegura de que exista en el caché de
 * Cornerstone cada vez que una vista lo pide (el caché se puede vaciar).
 */
export async function loadFusedVolume(entry: VolumeEntry, onProgress: (f: number) => void = () => {}): Promise<FusedVolume> {
  const { id } = volumeIds(entry)
  let downloading = downloads.get(id)
  if (downloading) {
    // Al final de la lista = usado más recientemente
    downloads.delete(id)
    downloads.set(id, downloading)
  } else {
    downloading = downloadVolume(entry, id, onProgress)
    downloads.set(id, downloading)
    downloading.catch(() => downloads.delete(id))
    while (downloads.size > MAX_CACHED) {
      const oldest = downloads.keys().next().value!
      downloads.delete(oldest)
      cache.removeVolumeLoadObject(oldest)
    }
  }
  const fused = await downloading
  ensureCornerstoneVolume(fused)
  return fused
}

function downloadVolume(entry: VolumeEntry, id: string, onProgress: (f: number) => void): Promise<FusedVolume> {
  return (async () => {
    const bytes = await fetchBytes(dataUrl(entry.url), onProgress)
    const data = new Int16Array(await gunzipIfNeeded(bytes))
    const [nx, ny, nz] = entry.dimensions
    if (data.length !== nx * ny * nz) throw new Error('El volumen no coincide con sus dimensiones')
    const [ox, oy, oz] = entry.origin
    const [sx, sy, sz] = entry.spacing
    return {
      id,
      entry,
      data,
      huAt([x, y, z]) {
        const i = Math.round((x - ox) / sx)
        const j = Math.round((y - oy) / sy)
        const k = Math.round((z - oz) / sz)
        if (i < 0 || j < 0 || k < 0 || i >= nx || j >= ny || k >= nz) return null
        return data[i + nx * (j + ny * k)]
      },
    }
  })()
}

function ensureCornerstoneVolume({ id, entry, data }: FusedVolume) {
  if (cache.getVolume(id)) return
  const { frame } = volumeIds(entry)
  const [nx, ny] = entry.dimensions
  volumeLoader.createLocalVolume(id, {
    scalarData: data,
    dimensions: entry.dimensions as Types.Point3,
    spacing: entry.spacing as Types.Point3,
    origin: entry.origin as Types.Point3,
    direction: entry.direction as Types.Mat3,
    metadata: {
      BitsAllocated: 16,
      BitsStored: 16,
      SamplesPerPixel: 1,
      HighBit: 15,
      PhotometricInterpretation: 'MONOCHROME2',
      PixelRepresentation: 1,
      Modality: 'CT',
      SeriesInstanceUID: id,
      FrameOfReferenceUID: frame,
      ImageOrientationPatient: [1, 0, 0, 0, 1, 0],
      PixelSpacing: [entry.spacing[1], entry.spacing[0]],
      Columns: nx,
      Rows: ny,
      voiLut: [{ windowCenter: 450, windowWidth: 1500 }],
      VOILUTFunction: 'LINEAR',
    },
  })

  // createLocalVolume les da a todos los cortes el origen del volumen; se corrige
  // la posición de cada uno para que las herramientas encuentren el corte correcto.
  const [ox, oy, oz] = entry.origin
  const sz = entry.spacing[2]
  cache.getVolume(id)!.imageIds.forEach((imageId, k) => {
    const plane = metaData.get('imagePlaneModule', imageId) ?? {}
    utilities.genericMetadataProvider.add(imageId, {
      type: 'imagePlaneModule',
      metadata: {
        ...plane,
        frameOfReferenceUID: frame,
        imagePositionPatient: [ox, oy, oz + k * sz],
        sliceLocation: oz + k * sz,
        sliceThickness: sz,
      },
    })
  })
}

export function voiFromWindow(center: number, width: number) {
  return utilities.windowLevel.toLowHighRange(width, center)
}
