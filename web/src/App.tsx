import { useEffect, useMemo, useState } from 'react'
import { initCornerstone } from './lib/cornerstone'
import { loadManifest, loadRegistrations, loadStudies, longDate, transformBetween, type Manifest, type Registration, type StudyEntry } from './lib/manifest'
import { configureSync, setSyncLeader } from './lib/sync'
import { LoadingMessage } from './components/ui'
import { SliceView } from './views/SliceView'
import { MprView } from './views/MprView'
import { SkullView } from './views/SkullView'
import { VideosView } from './views/VideosView'
import { Turntable360 } from './views/Turntable360'

type Tab = 'cortes' | 'mpr' | '3d' | 'videos'
const TABS: { id: Tab; label: string }[] = [
  { id: 'cortes', label: 'Cortes' },
  { id: 'mpr', label: 'Cada milímetro' },
  { id: '3d', label: 'Cráneo 3D' },
  { id: 'videos', label: 'Videos' },
]

function initialTab(): Tab {
  const h = location.hash.slice(1) as Tab
  return TABS.some((t) => t.id === h) ? h : 'cortes'
}

const params = () => new URLSearchParams(location.search)
const EXPORT_MODE = params().get('export') === '360'

export default function App() {
  return EXPORT_MODE ? <ExportApp /> : <ViewerApp />
}

/** Solo el canvas 3D, para que scripts/render-360.mjs grabe el video cuadro a cuadro. */
function ExportApp() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  useEffect(() => {
    loadStudies().then((list) => {
      const wanted = params().get('estudio')
      return loadManifest(list.find((s) => s.id === wanted) ?? list[0])
    }).then(setManifest)
  }, [])
  return manifest ? <Turntable360 manifest={manifest} /> : null
}

/** Etiqueta corta de un estudio para menús: "9 nov 2026". */
function shortLabel(s: StudyEntry) {
  return s.date
    ? new Date(`${s.date}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'short', year: 'numeric' })
    : s.id
}

function ViewerApp() {
  const [studies, setStudies] = useState<StudyEntry[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [primary, setPrimary] = useState<string | null>(params().get('estudio'))
  const [compare, setCompare] = useState<string | null>(params().get('comparar'))
  const [activePane, setActivePane] = useState<'a' | 'b'>('a')
  const [registrations, setRegistrations] = useState<Registration[]>([])
  const [linked, setLinked] = useState(params().get('sync') !== '0')

  useEffect(() => {
    Promise.all([loadStudies(), initCornerstone(), loadRegistrations()])
      .then(([list, , regs]) => {
        setRegistrations(regs)
        const ids = new Set(list.map((s) => s.id))
        setPrimary((p) => (p && ids.has(p) ? p : list[0].id))
        setCompare((c) => (c && ids.has(c) ? c : null))
        setStudies(list)
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  // Estudio, comparación y pestaña quedan en la URL: recargar o compartir el enlace conserva la vista
  useEffect(() => {
    if (!studies || !primary) return
    const q = new URLSearchParams()
    q.set('estudio', primary)
    if (compare) q.set('comparar', compare)
    if (compare && !linked) q.set('sync', '0')
    const url = `${location.pathname}?${q}#${tab}`
    if (`${location.pathname}${location.search}${location.hash}` === url) return
    if (location.hash !== `#${tab}`) history.pushState(null, '', url)
    else history.replaceState(null, '', url)
  }, [studies, primary, compare, tab, linked])

  useEffect(() => {
    const onNav = () => {
      setTab(initialTab())
      const q = params()
      if (q.get('estudio')) setPrimary(q.get('estudio'))
      setCompare(q.get('comparar'))
    }
    window.addEventListener('hashchange', onNav)
    window.addEventListener('popstate', onNav)
    return () => {
      window.removeEventListener('hashchange', onNav)
      window.removeEventListener('popstate', onNav)
    }
  }, [])

  const byId = (id: string | null) => studies?.find((s) => s.id === id) ?? null
  const a = byId(primary)
  const b = byId(compare)
  const comparing = !!(a && b)

  // Alineación entre los dos estudios del par (de pipeline/register.py)
  const aToB = useMemo(() => (a && b ? transformBetween(registrations, a.id, b.id) : null), [registrations, a, b])
  const bToA = useMemo(() => (a && b ? transformBetween(registrations, b.id, a.id) : null), [registrations, a, b])
  const registration = a && b && a.id !== b.id
    ? registrations.find((r) => (r.a === a.id && r.b === b.id) || (r.a === b.id && r.b === a.id)) ?? null
    : null
  const canLink = comparing && !!aToB
  const syncOn = canLink && linked

  useEffect(() => {
    configureSync({ enabled: syncOn, aToB, bToA })
  }, [syncOn, aToB, bToA])

  useEffect(() => {
    setSyncLeader(activePane)
  }, [activePane])

  const toggleCompare = () => {
    if (!studies) return
    if (comparing) {
      setCompare(null)
      setActivePane('a')
    } else {
      setCompare((studies.find((s) => s.id !== primary) ?? studies[0]).id)
    }
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>Visor TAC</strong>
          <span>
            {comparing
              ? `Comparando ${shortLabel(a!)} con ${shortLabel(b!)}`
              : a ? [a.description, longDate(a.date), a.manufacturer].filter(Boolean).join(' · ') : 'Cargando…'}
          </span>
        </div>
        {studies && a && !comparing && (
          <StudySelect studies={studies} value={a.id} onChange={setPrimary} label="Estudio" />
        )}
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        {studies && studies.length > 1 && (
          <button className="compare-toggle" aria-pressed={comparing} onClick={toggleCompare}>
            <CompareIcon />
            {comparing ? 'Salir de comparar' : 'Comparar'}
          </button>
        )}
        {comparing && (
          <button
            className="compare-toggle link-toggle"
            aria-pressed={syncOn}
            disabled={!canLink}
            onClick={() => setLinked((l) => !l)}
            title={canLink
              ? 'Mueve los dos paneles a la vez: corte, zoom, desplazamiento, ventana y cruz'
              : 'Estos estudios no están alineados. Corre pipeline/register.py'}
          >
            <LinkIcon />
            {syncOn ? 'Sincronizados' : 'Sincronizar'}
            {syncOn && registration && <small>± {registration.medianMm} mm</small>}
          </button>
        )}
        <div className="spacer" />
        <span className="disclaimer">Uso personal y educativo · no reemplaza el informe radiológico</span>
      </header>

      {error ? (
        <LoadingMessage text={error} />
      ) : !studies || !a ? (
        <LoadingMessage text="Preparando visor…" />
      ) : !comparing ? (
        <StudyView entry={a} tab={tab} pane="a" keyboard />
      ) : (
        <div className="compare">
          {([['a', a, setPrimary], ['b', b!, setCompare]] as const).map(([pane, entry, setEntry]) => (
            <section
              key={pane}
              className="pane"
              data-active={activePane === pane}
              onPointerEnter={() => setActivePane(pane)}
              onPointerDown={() => setActivePane(pane)}
            >
              <div className="pane-head">
                <StudySelect studies={studies} value={entry.id} onChange={setEntry} label={pane === 'a' ? 'Izquierda' : 'Derecha'} />
                <span className="pane-meta">{[entry.description, entry.manufacturer].filter(Boolean).join(' · ')}</span>
                <span className="pane-keys" title={syncOn ? 'El panel donde está el mouse manda; el otro lo sigue' : 'Las teclas actúan sobre el panel activo'}>
                  {activePane === pane ? (syncOn ? 'Manda este panel' : 'Teclado activo') : syncOn ? 'Sigue al otro' : ''}
                </span>
              </div>
              <StudyView entry={entry} tab={tab} pane={pane} keyboard={activePane === pane} />
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

function StudySelect({ studies, value, onChange, label }: {
  studies: StudyEntry[]
  value: string
  onChange: (id: string) => void
  label: string
}) {
  return (
    <label className="study-select">
      <span>{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {studies.map((s) => (
          <option key={s.id} value={s.id}>{shortLabel(s)}</option>
        ))}
      </select>
    </label>
  )
}

/** Carga el manifiesto del estudio y muestra la pestaña elegida. */
function StudyView({ entry, tab, pane, keyboard }: { entry: StudyEntry; tab: Tab; pane: string; keyboard: boolean }) {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setManifest(null)
    setError(null)
    loadManifest(entry).then(
      (m) => alive && setManifest(m),
      (e) => alive && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      alive = false
    }
  }, [entry])

  if (error) return <LoadingMessage text={error} />
  if (!manifest || manifest.studyId !== entry.id) return <LoadingMessage text="Cargando estudio…" />
  // La key fuerza a montar de nuevo la vista al cambiar de estudio: series y volumen son otros
  const k = `${pane}-${manifest.studyId}`
  const props = { manifest, pane, keyboard }
  return tab === 'cortes' ? <SliceView key={k} {...props} />
    : tab === 'mpr' ? <MprView key={k} {...props} />
    : tab === '3d' ? <SkullView key={k} {...props} />
    : <VideosView key={k} {...props} />
}

function LinkIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden>
      <path d="M6.5 9.5l3-3" />
      <path d="M7.2 4.6l1.1-1.1a2.6 2.6 0 0 1 3.7 3.7l-1.1 1.1" />
      <path d="M8.8 11.4l-1.1 1.1a2.6 2.6 0 0 1-3.7-3.7l1.1-1.1" />
    </svg>
  )
}

function CompareIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden>
      <rect x="1.5" y="2.5" width="5.5" height="11" rx="1.2" />
      <rect x="9" y="2.5" width="5.5" height="11" rx="1.2" />
    </svg>
  )
}
