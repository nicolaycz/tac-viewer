/**
 * Sincronización entre los dos paneles de "Comparar".
 *
 * Cada estudio tiene su propio sistema de coordenadas, así que no basta con copiar
 * la cámara: se lleva de un estudio al otro con la alineación rígida que calcula
 * pipeline/register.py. Así los dos paneles muestran el mismo plano anatómico.
 *
 * Manda el panel con el que el usuario está interactuando ("líder"); el otro solo
 * sigue. Eso evita rebotes: al pasar de cortes finos a gruesos y volver, el panel
 * líder no salta al corte más cercano del otro.
 */
import { EVENTS, metaData } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import { SynchronizerManager } from '@cornerstonejs/tools'
import { engine, ENGINE_ID } from './cornerstone'

export type Pane = 'a' | 'b'
/** Viewports que se emparejan entre paneles: el mismo "tipo" en cada lado */
export type SyncKind = 'stack' | 'mpr-axial' | 'mpr-coronal' | 'mpr-sagital' | 'vr'

type Mat4 = number[][]
interface StackInfo {
  /** Coordenada de cada corte en su eje dominante, en el orden del stack */
  positions: number[]
  axis: 0 | 1 | 2
}
interface Entry {
  viewportId: string
  pane: Pane
  kind: SyncKind
  stack?: StackInfo
}

const state = {
  enabled: false,
  leader: 'a' as Pane,
  aToB: null as Mat4 | null,
  bToA: null as Mat4 | null,
}
const entries = new Map<SyncKind, Partial<Record<Pane, Entry>>>()
const byViewport = new Map<string, Entry>()
const active = new Map<SyncKind, string[]>()

export function configureSync(opts: { enabled: boolean; aToB: Mat4 | null; bToA: Mat4 | null }) {
  const changed = opts.enabled !== state.enabled || opts.aToB !== state.aToB
  Object.assign(state, opts)
  if (changed) for (const kind of entries.keys()) rebuild(kind)
}

export function setSyncLeader(pane: Pane) {
  state.leader = pane
}

/**
 * Las vistas registran sus viewports cuando ya tienen imagen. Devuelve la función
 * para darlos de baja. Volver a registrar (p. ej. al cambiar de serie) actualiza los datos.
 */
export function registerSyncViewport(kind: SyncKind, pane: Pane, viewportId: string, stack?: StackInfo): () => void {
  const entry: Entry = { viewportId, pane, kind, stack }
  const pair = entries.get(kind) ?? {}
  pair[pane] = entry
  entries.set(kind, pair)
  byViewport.set(viewportId, entry)
  rebuild(kind)
  return () => {
    const current = entries.get(kind)
    if (current?.[pane]?.viewportId !== viewportId) return
    delete current[pane]
    byViewport.delete(viewportId)
    rebuild(kind)
  }
}

function rebuild(kind: SyncKind) {
  for (const id of active.get(kind) ?? []) SynchronizerManager.destroySynchronizer(id)
  active.delete(kind)
  const pair = entries.get(kind)
  if (!state.enabled || !state.aToB || !pair?.a || !pair?.b) return

  const ids: string[] = []
  const make = (name: string, event: string, handler: Handler) => {
    const id = `sync-${name}-${kind}`
    const s = SynchronizerManager.createSynchronizer(id, event, (_s, src, tgt, evt) => {
      const from = byViewport.get(src.viewportId)
      const to = byViewport.get(tgt.viewportId)
      // Solo propaga el panel líder: el seguidor no devuelve el movimiento
      if (!from || !to || from.pane !== state.leader || from.pane === to.pane) return
      handler(from, to, evt)
    })
    s.add({ renderingEngineId: ENGINE_ID, viewportId: pair.a!.viewportId })
    s.add({ renderingEngineId: ENGINE_ID, viewportId: pair.b!.viewportId })
    ids.push(id)
  }
  make('camara', EVENTS.CAMERA_MODIFIED, kind === 'stack' ? syncStackCamera : syncVolumeCamera)
  make('ventana', EVENTS.VOI_MODIFIED, syncVoi)
  if (kind === 'stack') make('corte', EVENTS.STACK_NEW_IMAGE, syncStackSlice)
  active.set(kind, ids)

  // Al activar, el seguidor se pone de inmediato donde está el líder
  const lead = pair[state.leader]!
  const follow = pair[state.leader === 'a' ? 'b' : 'a']!
  if (kind === 'stack') syncStackSlice(lead, follow)
  else syncVolumeCamera(lead, follow)
  syncVoi(lead, follow)
}

/*
 * Mensajes entre paneles para lo que no pasa por Cornerstone: la escena Three.js
 * del cráneo y los controles de las barras laterales. Solo publica el líder.
 */
type Listener = (topic: string, from: Pane, payload: unknown) => void
const listeners = new Map<Listener, Pane>()

export function syncActive() {
  return state.enabled && !!state.aToB
}

export function publish(topic: string, from: Pane, payload: unknown) {
  if (!syncActive() || from !== state.leader) return
  for (const [fn, pane] of listeners) if (pane !== from) fn(topic, from, payload)
}

export function subscribe(pane: Pane, fn: Listener): () => void {
  listeners.set(fn, pane)
  return () => {
    listeners.delete(fn)
  }
}

/** Lleva un punto (mm, coordenadas del estudio del panel `from`) al estudio del otro panel. */
export function mapPoint(from: Pane, p: Types.Point3): Types.Point3 {
  return point(from === 'a' ? state.aToB! : state.bToA!, p)
}

type Handler = (from: Entry, to: Entry, evt?: Event) => void

function matrixFor(from: Entry): Mat4 {
  return from.pane === 'a' ? state.aToB! : state.bToA!
}

const point = (m: Mat4, p: Types.Point3): Types.Point3 => [0, 1, 2].map(
  (i) => m[i][0] * p[0] + m[i][1] * p[1] + m[i][2] * p[2] + m[i][3],
) as Types.Point3
const vector = (m: Mat4, v: Types.Point3): Types.Point3 => [0, 1, 2].map(
  (i) => m[i][0] * v[0] + m[i][1] * v[1] + m[i][2] * v[2],
) as Types.Point3
const sub = (a: Types.Point3, b: Types.Point3): Types.Point3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Types.Point3, b: Types.Point3): Types.Point3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Types.Point3, k: number): Types.Point3 => [a[0] * k, a[1] * k, a[2] * k]
const dot = (a: Types.Point3, b: Types.Point3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

/** Volumen (MPR y 3D): la cámara completa llevada al otro estudio, incluida la rotación. */
function syncVolumeCamera(from: Entry, to: Entry) {
  const src = engine().getViewport(from.viewportId)
  const tgt = engine().getViewport(to.viewportId)
  if (!src || !tgt) return
  const c = src.getCamera()
  if (!c.focalPoint || !c.position || !c.viewUp || !c.viewPlaneNormal) return
  const m = matrixFor(from)
  tgt.setCamera({
    focalPoint: point(m, c.focalPoint),
    position: point(m, c.position),
    viewUp: vector(m, c.viewUp),
    viewPlaneNormal: vector(m, c.viewPlaneNormal),
    parallelScale: c.parallelScale,
  })
  tgt.render()
}

/** Punto que el usuario mira en un stack: el centro de la vista, sobre el corte actual. */
function stackFocus(vp: Types.IStackViewport): Types.Point3 | null {
  const c = vp.getCamera()
  const plane = metaData.get('imagePlaneModule', vp.getCurrentImageId())
  if (!c.focalPoint || !plane?.imagePositionPatient || !c.viewPlaneNormal) return c.focalPoint ?? null
  const n = c.viewPlaneNormal
  return sub(c.focalPoint, scale(n, dot(sub(c.focalPoint, plane.imagePositionPatient as Types.Point3), n)))
}

/** Stack: el corte del otro estudio más cercano al punto que se está mirando. */
function syncStackSlice(from: Entry, to: Entry) {
  const src = engine().getViewport(from.viewportId) as Types.IStackViewport | undefined
  const tgt = engine().getViewport(to.viewportId) as Types.IStackViewport | undefined
  if (!src || !tgt || !to.stack) return
  const focus = stackFocus(src)
  if (!focus) return
  const target = point(matrixFor(from), focus)[to.stack.axis]
  const { positions } = to.stack
  let best = 0
  for (let i = 1; i < positions.length; i++) {
    if (Math.abs(positions[i] - target) < Math.abs(positions[best] - target)) best = i
  }
  if (best !== tgt.getCurrentImageIdIndex()) tgt.setImageIdIndex(best).then(() => syncStackCamera(from, to))
  else syncStackCamera(from, to)
}

/** Stack: mismo zoom y el mismo punto anatómico en el centro de la vista. */
function syncStackCamera(from: Entry, to: Entry) {
  const src = engine().getViewport(from.viewportId) as Types.IStackViewport | undefined
  const tgt = engine().getViewport(to.viewportId) as Types.IStackViewport | undefined
  if (!src || !tgt) return
  const focus = stackFocus(src)
  const t = tgt.getCamera()
  if (!focus || !t.focalPoint || !t.position || !t.viewPlaneNormal) return
  // Solo se mueve dentro del plano: la profundidad la decide el corte elegido
  const delta = sub(point(matrixFor(from), focus), t.focalPoint)
  const inPlane = sub(delta, scale(t.viewPlaneNormal, dot(delta, t.viewPlaneNormal)))
  tgt.setCamera({
    focalPoint: add(t.focalPoint, inPlane),
    position: add(t.position, inPlane),
    parallelScale: src.getCamera().parallelScale,
  })
  tgt.render()
}

/** Ventana (brillo y contraste): los mismos HU en ambos lados. */
function syncVoi(from: Entry, to: Entry, evt?: Event) {
  const tgt = engine().getViewport(to.viewportId) as Types.IStackViewport | Types.IVolumeViewport | undefined
  const src = engine().getViewport(from.viewportId) as Types.IStackViewport | Types.IVolumeViewport | undefined
  const range = (evt as CustomEvent | undefined)?.detail?.range ?? src?.getProperties()?.voiRange
  if (!tgt || !range) return
  tgt.setProperties({ voiRange: range })
  tgt.render()
}
