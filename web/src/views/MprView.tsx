import { Fragment, useEffect, useRef, useState } from 'react'
import { Enums, EVENTS, setVolumesForViewports, utilities } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import type { Types as ToolTypes } from '@cornerstonejs/tools'
import { CROSSHAIR_COLORS, create2DToolGroup, destroyToolGroup, engine, setPrimaryTool, type PrimaryTool } from '../lib/cornerstone'
import { formatMm, type Manifest, type PlaneId } from '../lib/manifest'
import { loadFusedVolume, voiFromWindow, type FusedVolume } from '../lib/volume'
import { Chips, LoadingMessage, OrientationLabels, Section, ToolButtons } from '../components/ui'

const TOOL_GROUP_ID = 'mpr-tools'
const PLANES: { id: PlaneId; label: string; orientation: Enums.OrientationAxis; axis: 0 | 1 | 2 }[] = [
  { id: 'axial', label: 'Axial', orientation: Enums.OrientationAxis.AXIAL, axis: 2 },
  { id: 'coronal', label: 'Coronal', orientation: Enums.OrientationAxis.CORONAL, axis: 1 },
  { id: 'sagital', label: 'Sagital', orientation: Enums.OrientationAxis.SAGITTAL, axis: 0 },
]
const viewportId = (p: PlaneId) => `mpr-${p}`
const AXIS_LABEL = ['x', 'y', 'z']

const TOOLS: { id: PrimaryTool; label: string; key: string }[] = [
  { id: 'cruz', label: 'Cruz', key: 'C' },
  { id: 'ventana', label: 'Ventana', key: 'W' },
  { id: 'medir', label: 'Medir', key: 'L' },
  { id: 'hu', label: 'Punto HU', key: 'H' },
]
const TOOL_KEYS: Record<string, PrimaryTool> = { c: 'cruz', w: 'ventana', l: 'medir', h: 'hu' }

export function MprView({ manifest }: { manifest: Manifest }) {
  const [volume, setVolume] = useState<FusedVolume | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [positions, setPositions] = useState<Record<PlaneId, number>>({ axial: 0, coronal: 0, sagital: 0 })
  const [voi, setVoi] = useState({ center: 450, width: 1500 })
  const [tool, setTool] = useState<PrimaryTool>('cruz')
  const [hover, setHover] = useState<{ hu: number; world: Types.Point3 } | null>(null)
  const elRefs = useRef<Record<PlaneId, HTMLDivElement | null>>({ axial: null, coronal: null, sagital: null })
  const groupRef = useRef<ToolTypes.IToolGroup | null>(null)

  const { origin, spacing, dimensions } = manifest.volume
  const presetId = manifest.windowPresets.find(
    (p) => Math.abs(p.center - voi.center) < 1 && Math.abs(p.width - voi.width) < 1,
  )?.id ?? null

  useEffect(() => {
    loadFusedVolume(manifest.volume, setProgress).then(setVolume, (e) => setError(String(e)))
  }, [manifest])

  useEffect(() => {
    if (!volume) return
    const eng = engine()
    const ids = PLANES.map((p) => viewportId(p.id))
    eng.setViewports(PLANES.map((p) => ({
      viewportId: viewportId(p.id),
      type: Enums.ViewportType.ORTHOGRAPHIC,
      element: elRefs.current[p.id]!,
      defaultOptions: { orientation: p.orientation, background: [0, 0, 0] as Types.Point3 },
    })))

    const readPosition = () => {
      const next = {} as Record<PlaneId, number>
      for (const p of PLANES) {
        const vp = eng.getViewport(viewportId(p.id)) as Types.IVolumeViewport | undefined
        next[p.id] = vp ? vp.getCamera().focalPoint![p.axis] : 0
      }
      setPositions(next)
    }
    const onVoi = (e: Event) => {
      const { range } = (e as CustomEvent).detail as { range: Types.VOIRange }
      const { windowCenter, windowWidth } = utilities.windowLevel.toWindowLevel(range.lower, range.upper)
      setVoi({ center: Math.round(windowCenter), width: Math.round(windowWidth) })
    }
    const elements = PLANES.map((p) => elRefs.current[p.id]!)
    for (const el of elements) {
      el.addEventListener(EVENTS.CAMERA_MODIFIED, readPosition)
      el.addEventListener(EVENTS.VOI_MODIFIED, onVoi)
    }

    // Orden de Cornerstone: herramientas y viewports primero, después el volumen
    groupRef.current = create2DToolGroup(TOOL_GROUP_ID, ids, tool, true)

    let cancelled = false
    const { lower, upper } = voiFromWindow(voi.center, voi.width)
    setVolumesForViewports(eng, [{
      volumeId: volume.id,
      // Corre después de la ventana por defecto de Cornerstone, así que la nuestra prevalece
      callback: ({ volumeActor }) => {
        volumeActor.getProperty().getRGBTransferFunction(0).setMappingRange(lower, upper)
      },
    }], ids).then(() => {
      if (cancelled) return
      applyWindow(voi.center, voi.width)
      eng.renderViewports(ids)
      readPosition()
    })

    const ro = new ResizeObserver(() => eng.resize(true, true))
    elements.forEach((el) => ro.observe(el))
    return () => {
      cancelled = true
      ro.disconnect()
      for (const el of elements) {
        el.removeEventListener(EVENTS.CAMERA_MODIFIED, readPosition)
        el.removeEventListener(EVENTS.VOI_MODIFIED, onVoi)
      }
      destroyToolGroup(TOOL_GROUP_ID)
      groupRef.current = null
      for (const id of ids) eng.disableElement(id)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume])

  useEffect(() => {
    if (groupRef.current) setPrimaryTool(groupRef.current, tool)
  }, [tool])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = TOOL_KEYS[e.key.toLowerCase()]
      if (t) setTool(t)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  function applyWindow(center: number, width: number) {
    const eng = engine()
    for (const p of PLANES) {
      const vp = eng.getViewport(viewportId(p.id)) as Types.IVolumeViewport | undefined
      vp?.setProperties({ voiRange: voiFromWindow(center, width) })
      vp?.render()
    }
    setVoi({ center, width })
  }

  const onMouseMove = (plane: PlaneId) => (e: React.MouseEvent) => {
    const el = elRefs.current[plane]
    const vp = engine().getViewport(viewportId(plane)) as Types.IVolumeViewport | undefined
    if (!volume || !el || !vp) return
    const rect = el.getBoundingClientRect()
    const world = vp.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top])
    const hu = volume.huAt(world)
    setHover(hu === null ? null : { hu, world })
  }

  const sliceInfo = (axis: 0 | 1 | 2, pos: number) => {
    const rel = pos - origin[axis]
    const total = (dimensions[axis] - 1) * spacing[axis]
    return { rel, total }
  }

  return (
    <div className="view">
      <aside className="sidebar">
        <Section title="Volumen reconstruido">
          <p className="note">
            Cubo de <b>{spacing[0]} mm</b> calculado combinando las tres series de 3 mm (axial, coronal y sagital).
            Puedes recorrerlo milímetro a milímetro en cualquier plano.
          </p>
        </Section>
        <Section title="Ventana">
          <Chips
            options={manifest.windowPresets}
            value={presetId}
            onChange={(id) => {
              const p = manifest.windowPresets.find((w) => w.id === id)!
              applyWindow(p.center, p.width)
            }}
          />
        </Section>
        <Section title="Botón izquierdo">
          <ToolButtons options={TOOLS} value={tool} onChange={setTool} />
        </Section>
        <Section title="Controles">
          <ul className="help">
            <li><b>Rueda</b>: avanzar {spacing[0]} mm en ese plano</li>
            <li><b>Cruz</b>: arrastra las líneas para moverte en los otros planos</li>
            <li><b>Clic derecho</b>: zoom · <b>central</b>: mover</li>
          </ul>
        </Section>
      </aside>

      <div className="stage" style={{ gridTemplateRows: '1fr' }}>
        {!volume ? (
          error ? <LoadingMessage text={error} /> : <LoadingMessage text="Cargando volumen reconstruido…" progress={progress} />
        ) : (
          <div className="mpr-grid">
            {PLANES.map((p) => {
              const { rel, total } = sliceInfo(p.axis, positions[p.id])
              return (
                <div
                  key={p.id}
                  className="viewport-wrap"
                  onMouseMove={onMouseMove(p.id)}
                  onMouseLeave={() => setHover(null)}
                  onContextMenu={(e) => e.preventDefault()}
                >
                  <div ref={(el) => { elRefs.current[p.id] = el }} className="viewport-el" />
                  <OrientationLabels plane={p.id} />
                  <div className="overlay tl">
                    <div className="big"><span className="swatch" style={{ background: CROSSHAIR_COLORS[viewportId(p.id)] }} />{p.label}</div>
                  </div>
                  <div className="overlay bl num">
                    <div><span className="accent">{formatMm(rel)}</span> / {formatMm(total, 0)}</div>
                    <div>{AXIS_LABEL[p.axis]} = {formatMm(positions[p.id])}</div>
                  </div>
                </div>
              )
            })}
            <div className="mpr-info">
              <Section title="Posición de la cruz">
                <dl className="coords">
                  {PLANES.map((p) => (
                    <Fragment key={p.id}>
                      <dt>{p.label}</dt>
                      <dd>{formatMm(sliceInfo(p.axis, positions[p.id]).rel)}</dd>
                    </Fragment>
                  ))}
                </dl>
              </Section>
              <Section title="Bajo el cursor">
                {hover ? (
                  <dl className="coords">
                    <dt>Densidad</dt><dd className="big">{hover.hu} HU</dd>
                    <dt>x · y · z</dt><dd>{hover.world.map((v) => v.toFixed(1)).join(' · ')}</dd>
                  </dl>
                ) : <p className="note">Pasa el mouse sobre un corte.</p>}
              </Section>
              <Section title="Referencia rápida de HU">
                <dl className="coords">
                  <dt>Aire</dt><dd>−1000</dd>
                  <dt>Grasa</dt><dd>−100 a −50</dd>
                  <dt>Agua / moco</dt><dd>0 a 30</dd>
                  <dt>Tejido blando</dt><dd>30 a 80</dd>
                  <dt>Hueso</dt><dd>300 a 2000</dd>
                </dl>
              </Section>
              <p className="note">VOI {voi.width} / {voi.center} · vóxel {spacing.join(' × ')} mm · {dimensions.join(' × ')}</p>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
