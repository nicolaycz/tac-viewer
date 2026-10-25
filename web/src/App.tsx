import { useEffect, useState } from 'react'
import { initCornerstone } from './lib/cornerstone'
import { loadManifest, type Manifest } from './lib/manifest'
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

const EXPORT_MODE = new URLSearchParams(location.search).get('export') === '360'

export default function App() {
  return EXPORT_MODE ? <ExportApp /> : <ViewerApp />
}

/** Solo el canvas 3D, para que scripts/render-360.mjs grabe el video cuadro a cuadro. */
function ExportApp() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  useEffect(() => {
    loadManifest().then(setManifest)
  }, [])
  return manifest ? <Turntable360 manifest={manifest} /> : null
}

function ViewerApp() {
  const [manifest, setManifest] = useState<Manifest | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>(initialTab)

  useEffect(() => {
    Promise.all([loadManifest(), initCornerstone()])
      .then(([m]) => setManifest(m))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    if (location.hash !== `#${tab}`) history.pushState(null, '', `#${tab}`)
  }, [tab])

  useEffect(() => {
    const onHash = () => setTab(initialTab())
    window.addEventListener('hashchange', onHash)
    window.addEventListener('popstate', onHash)
    return () => {
      window.removeEventListener('hashchange', onHash)
      window.removeEventListener('popstate', onHash)
    }
  }, [])

  const study = manifest?.study
  const date = study?.date
    ? new Date(`${study.date}T12:00:00`).toLocaleDateString('es', { day: 'numeric', month: 'long', year: 'numeric' })
    : ''

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <strong>Visor TAC</strong>
          <span>{study ? [study.description, date, study.manufacturer].filter(Boolean).join(' · ') : 'Cargando…'}</span>
        </div>
        <nav className="tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" className="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
              {t.label}
            </button>
          ))}
        </nav>
        <div className="spacer" />
        <span className="disclaimer">Uso personal y educativo · no reemplaza el informe radiológico</span>
      </header>

      {error ? (
        <LoadingMessage text={error} />
      ) : !manifest ? (
        <LoadingMessage text="Preparando visor…" />
      ) : tab === 'cortes' ? (
        <SliceView manifest={manifest} />
      ) : tab === 'mpr' ? (
        <MprView manifest={manifest} />
      ) : tab === '3d' ? (
        <SkullView manifest={manifest} />
      ) : (
        <VideosView manifest={manifest} />
      )}
    </div>
  )
}
