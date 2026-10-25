import { useCallback, useEffect, useRef, useState } from 'react'
import { Enums, EVENTS, imageLoader, utilities } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import type { Types as ToolTypes } from '@cornerstonejs/tools'
import { create2DToolGroup, destroyToolGroup, engine, setPrimaryTool, type PrimaryTool } from '../lib/cornerstone'
import { dataUrl, formatMm, relativeMm, type Manifest } from '../lib/manifest'
import { voiFromWindow } from '../lib/volume'
import { Chips, OrientationLabels, PlayIcon, Section, ToolButtons } from '../components/ui'

const VIEWPORT_ID = 'stack'
const TOOL_GROUP_ID = 'stack-tools'

const TOOLS: { id: PrimaryTool; label: string; key: string }[] = [
  { id: 'ventana', label: 'Ventana', key: 'W' },
  { id: 'mover', label: 'Mover', key: 'M' },
  { id: 'zoom', label: 'Zoom', key: 'Z' },
  { id: 'medir', label: 'Medir', key: 'L' },
  { id: 'hu', label: 'Punto HU', key: 'H' },
]
const TOOL_KEYS: Record<string, PrimaryTool> = { w: 'ventana', m: 'mover', z: 'zoom', l: 'medir', h: 'hu' }

export function SliceView({ manifest }: { manifest: Manifest }) {
  const [seriesId, setSeriesId] = useState(manifest.series[0].id)
  const series = manifest.series.find((s) => s.id === seriesId) ?? manifest.series[0]
  const [index, setIndex] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [fps, setFps] = useState(6)
  const [voi, setVoi] = useState({ center: 450, width: 1500 })
  const [tool, setTool] = useState<PrimaryTool>('ventana')
  const [hu, setHu] = useState<number | null>(null)
  const elRef = useRef<HTMLDivElement>(null)
  const vpRef = useRef<Types.IStackViewport | null>(null)
  const groupRef = useRef<ToolTypes.IToolGroup | null>(null)

  const presetId = manifest.windowPresets.find(
    (p) => Math.abs(p.center - voi.center) < 1 && Math.abs(p.width - voi.width) < 1,
  )?.id ?? null

  // Visor y herramientas: se crean una vez
  useEffect(() => {
    const el = elRef.current!
    const eng = engine()
    eng.enableElement({
      viewportId: VIEWPORT_ID,
      type: Enums.ViewportType.STACK,
      element: el,
      defaultOptions: { background: [0, 0, 0] },
    })
    vpRef.current = eng.getViewport(VIEWPORT_ID) as Types.IStackViewport
    groupRef.current = create2DToolGroup(TOOL_GROUP_ID, [VIEWPORT_ID], 'ventana')

    const onNewImage = () => setIndex(vpRef.current?.getCurrentImageIdIndex() ?? 0)
    const onVoi = (e: Event) => {
      const { range } = (e as CustomEvent).detail as { range: Types.VOIRange }
      const { windowCenter, windowWidth } = utilities.windowLevel.toWindowLevel(range.lower, range.upper)
      setVoi({ center: Math.round(windowCenter), width: Math.round(windowWidth) })
    }
    el.addEventListener(EVENTS.STACK_NEW_IMAGE, onNewImage)
    el.addEventListener(EVENTS.VOI_MODIFIED, onVoi)
    const ro = new ResizeObserver(() => eng.resize(true, true))
    ro.observe(el)
    return () => {
      ro.disconnect()
      el.removeEventListener(EVENTS.STACK_NEW_IMAGE, onNewImage)
      el.removeEventListener(EVENTS.VOI_MODIFIED, onVoi)
      destroyToolGroup(TOOL_GROUP_ID)
      eng.disableElement(VIEWPORT_ID)
      vpRef.current = null
    }
  }, [])

  // Cambio de serie: cortes ya ordenados por el pipeline
  useEffect(() => {
    const vp = vpRef.current
    if (!vp) return
    let cancelled = false
    setPlaying(false)
    const imageIds = series.files.map((f) => `wadouri:${new URL(dataUrl(f), location.href).href}`)
    const start = Math.floor(imageIds.length / 2)
    vp.setStack(imageIds, start).then(() => {
      if (cancelled) return
      vp.setProperties({ voiRange: voiFromWindow(voi.center, voi.width) })
      vp.render()
      setIndex(start)
    })
    // Precarga para que la reproducción sea fluida
    for (const id of imageIds) imageLoader.loadAndCacheImage(id).catch(() => {})
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [series])

  useEffect(() => {
    if (groupRef.current) setPrimaryTool(groupRef.current, tool)
  }, [tool])

  // Reproducción tipo cine
  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      const vp = vpRef.current
      if (!vp) return
      vp.setImageIdIndex((vp.getCurrentImageIdIndex() + 1) % series.count)
    }, 1000 / fps)
    return () => clearInterval(timer)
  }, [playing, fps, series])

  const goTo = useCallback((i: number) => {
    const vp = vpRef.current
    if (!vp) return
    vp.setImageIdIndex(Math.max(0, Math.min(series.count - 1, i)))
  }, [series])

  const applyWindow = (center: number, width: number) => {
    const vp = vpRef.current
    if (!vp) return
    vp.setProperties({ voiRange: voiFromWindow(center, width) })
    vp.render()
    setVoi({ center, width })
  }

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      const vp = vpRef.current
      if (!vp) return
      const cur = vp.getCurrentImageIdIndex()
      if (e.key === 'ArrowUp' || e.key === 'ArrowRight') goTo(cur + 1)
      else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') goTo(cur - 1)
      else if (e.key === ' ') setPlaying((p) => !p)
      else if (e.key === 'Home') goTo(0)
      else if (e.key === 'End') goTo(series.count - 1)
      else if (TOOL_KEYS[e.key.toLowerCase()]) setTool(TOOL_KEYS[e.key.toLowerCase()])
      else return
      e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [goTo, series])

  const onMouseMove = (e: React.MouseEvent) => {
    const vp = vpRef.current
    const el = elRef.current
    if (!vp || !el) return
    const image = vp.getCornerstoneImage()
    if (!image) return
    const rect = el.getBoundingClientRect()
    const world = vp.canvasToWorld([e.clientX - rect.left, e.clientY - rect.top])
    const coords = utilities.worldToImageCoords(vp.getCurrentImageId(), world)
    if (!coords) return setHu(null)
    const col = Math.floor(coords[0])
    const row = Math.floor(coords[1])
    if (col < 0 || row < 0 || col >= image.columns || row >= image.rows) return setHu(null)
    const raw = image.getPixelData()[row * image.columns + col]
    setHu(Math.round(image.preScale?.scaled ? raw : raw * image.slope + image.intercept))
  }

  const pos = series.positionsMm[index] ?? 0
  const rel = relativeMm(series, index)

  return (
    <div className="view">
      <aside className="sidebar">
        <Section title="Series del CD">
          <div className="series-list">
            {manifest.series.map((s) => (
              <button key={s.id} className="series-item" aria-pressed={s.id === seriesId} onClick={() => setSeriesId(s.id)}>
                <b>{s.label}</b>
                <small>{s.count} cortes · {s.thicknessMm} mm · {s.direction}</small>
              </button>
            ))}
          </div>
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
            <li><b>Rueda</b> o <b>↑ ↓</b>: corte siguiente / anterior</li>
            <li><b>Espacio</b>: reproducir como video</li>
            <li><b>Clic derecho</b> y arrastrar: zoom</li>
            <li><b>Clic central</b> y arrastrar: mover</li>
          </ul>
        </Section>
      </aside>

      <div className="stage">
        <div className="viewport-wrap" onMouseMove={onMouseMove} onMouseLeave={() => setHu(null)} onContextMenu={(e) => e.preventDefault()}>
          <div ref={elRef} className="viewport-el" />
          <OrientationLabels plane={series.plane} />
          <div className="overlay tl">
            <div className="big">{series.label}</div>
            <div>{series.description}</div>
            <div>Grosor {series.thicknessMm} mm · paso {+series.stepMm.toFixed(1)} mm</div>
          </div>
          <div className="overlay tr num">
            <div>V {voi.width} · N {voi.center}</div>
            <div>{manifest.study.date}</div>
          </div>
          <div className="overlay bl">
            <div className="big num">Corte {index + 1} / {series.count}</div>
            <div className="num">
              <span className="accent">{formatMm(rel)}</span> desde el primero · {series.axis} = {formatMm(pos)}
            </div>
          </div>
          <div className="overlay br num">{hu !== null && <div className="big">{hu} HU</div>}</div>
        </div>
        <div className="transport">
          <button className="play" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pausar' : 'Reproducir'}>
            <PlayIcon playing={playing} />
          </button>
          <input
            className="slider"
            type="range"
            min={0}
            max={series.count - 1}
            value={index}
            onChange={(e) => goTo(Number(e.target.value))}
            aria-label="Corte"
          />
          <span className="readout">{index + 1}/{series.count} · {formatMm(rel)}</span>
          <label className="fps">
            Velocidad
            <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
              {[2, 4, 6, 10, 15, 24].map((f) => <option key={f} value={f}>{f} cps</option>)}
            </select>
          </label>
        </div>
      </div>
    </div>
  )
}
