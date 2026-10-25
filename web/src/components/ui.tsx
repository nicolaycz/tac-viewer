import type { ReactNode } from 'react'

export function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="section-title">{title}</h3>
      {children}
    </section>
  )
}

export function Chips<T extends string>({ options, value, onChange }: {
  options: { id: T; label: string }[]
  value: T | null
  onChange: (id: T) => void
}) {
  return (
    <div className="chips">
      {options.map((o) => (
        <button key={o.id} className="chip" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
        </button>
      ))}
    </div>
  )
}

export function ToolButtons<T extends string>({ options, value, onChange }: {
  options: { id: T; label: string; key?: string }[]
  value: T
  onChange: (id: T) => void
}) {
  return (
    <div className="tool-grid">
      {options.map((o) => (
        <button key={o.id} className="tool" aria-pressed={o.id === value} onClick={() => onChange(o.id)}>
          {o.label}
          {o.key && <kbd>{o.key}</kbd>}
        </button>
      ))}
    </div>
  )
}

export function PlayIcon({ playing }: { playing: boolean }) {
  return playing ? (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
  ) : (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden><path d="M4 2.5v11a.8.8 0 0 0 1.2.7l9-5.5a.8.8 0 0 0 0-1.4l-9-5.5A.8.8 0 0 0 4 2.5z" /></svg>
  )
}

export function LoadingMessage({ text, progress }: { text: string; progress?: number }) {
  return (
    <div className="center-msg">
      <div>
        {text}
        {progress !== undefined && (
          <div className="progress"><div style={{ width: `${Math.round(progress * 100)}%` }} /></div>
        )}
      </div>
    </div>
  )
}

/** Rótulos de orientación anatómica en los bordes del visor. */
export const ORIENTATION: Record<string, [string, string, string, string]> = {
  axial: ['A', 'P', 'D', 'Izq'],
  coronal: ['S', 'Inf', 'D', 'Izq'],
  sagital: ['S', 'Inf', 'A', 'P'],
}

export function OrientationLabels({ plane }: { plane: string }) {
  const [t, b, l, r] = ORIENTATION[plane]
  return (
    <>
      <span className="orient t">{t}</span>
      <span className="orient b">{b}</span>
      <span className="orient l">{l}</span>
      <span className="orient r">{r}</span>
    </>
  )
}
