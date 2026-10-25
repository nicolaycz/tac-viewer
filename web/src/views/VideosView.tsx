import { dataUrl, type Manifest, type PlaneId } from '../lib/manifest'

const FUSED_PLANES: { id: PlaneId; label: string; direction: string }[] = [
  { id: 'axial', label: 'Axial', direction: 'de inferior a superior' },
  { id: 'coronal', label: 'Coronal', direction: 'de anterior a posterior' },
  { id: 'sagital', label: 'Sagital', direction: 'de derecha a izquierda' },
]

interface Clip {
  title: string
  detail: string
  url: string
}

export function VideosView({ manifest }: { manifest: Manifest }) {
  const original: Clip[] = manifest.series
    .filter((s) => s.video)
    .map((s) => ({
      title: s.label,
      detail: `${s.count} cortes de ${s.thicknessMm} mm · ${s.direction}`,
      url: s.video!,
    }))
  const fused: Clip[] = FUSED_PLANES
    .filter((p) => manifest.volume.videos[p.id])
    .map((p) => ({
      title: p.label,
      detail: `cada 1 mm · ${p.direction}`,
      url: manifest.volume.videos[p.id]!,
    }))

  const { turntable } = manifest
  return (
    <div className="videos">
      {turntable && (
        <section>
          <h2>Cráneo 3D · giro de 360°</h2>
          <p className="lead">Hueso translúcido con los senos paranasales, las fosas nasales, la vía aérea y las mastoides en azul.</p>
          <ClipGrid clips={[{ title: 'Giro de 360°', detail: `${turntable.seconds} s · ${turntable.fps} cps`, url: turntable.video }]} />
        </section>
      )}
      <section>
        <h2>Cortes originales del CD</h2>
        <p className="lead">Tal como los entregó el tomógrafo, ordenados por posición. Ventana ósea.</p>
        <ClipGrid clips={original} />
      </section>
      <section>
        <h2>Cada milímetro (reconstrucción)</h2>
        <p className="lead">Recorrido de 1 mm por cuadro sobre el volumen reconstruido de 0.5 mm.</p>
        <ClipGrid clips={fused} />
      </section>
    </div>
  )
}

function ClipGrid({ clips }: { clips: Clip[] }) {
  if (!clips.length) return <p className="note">No hay videos. Corre el pipeline sin --skip-videos.</p>
  return (
    <div className="video-grid">
      {clips.map((c) => (
        <article key={c.url} className="video-card">
          <video src={dataUrl(c.url)} controls loop muted playsInline preload="metadata" />
          <footer>
            <div>
              <div>{c.title}</div>
              <small>{c.detail}</small>
            </div>
            <a className="btn" href={dataUrl(c.url)} download>MP4</a>
          </footer>
        </article>
      ))}
    </div>
  )
}
