import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { OrbitControls, useGLTF } from '@react-three/drei'
import * as THREE from 'three'
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib'
import { Enums, setVolumesForViewports } from '@cornerstonejs/core'
import type { Types } from '@cornerstonejs/core'
import { create3DToolGroup, destroyToolGroup, engine } from '../lib/cornerstone'
import { dataUrl, type Manifest } from '../lib/manifest'
import { loadFusedVolume, type FusedVolume } from '../lib/volume'
import { Chips, LoadingMessage, Section } from '../components/ui'
import { AIR_COLOR, Air, Lights, Skull, type Cut } from '../three/skullScene'

type Mode = 'superficie' | 'volumen'
type View = 'frente' | 'derecha' | 'izquierda' | 'arriba' | 'abajo' | 'tres-cuartos'

const CAMERA_DISTANCE = 400
// En la escena: X = izquierda del paciente, Y = superior, Z = anterior
const VIEW_DIRECTIONS: Record<View, [number, number, number]> = {
  frente: [0, 0, 1],
  derecha: [-1, 0, 0],
  izquierda: [1, 0, 0],
  arriba: [0, 1, 0.0001],
  abajo: [0, -1, 0.0001],
  'tres-cuartos': [-0.7, 0.25, 0.75],
}
const VIEWS: { id: View; label: string }[] = [
  { id: 'frente', label: 'Frente' },
  { id: 'tres-cuartos', label: '¾' },
  { id: 'derecha', label: 'Perfil der.' },
  { id: 'izquierda', label: 'Perfil izq.' },
  { id: 'arriba', label: 'Arriba' },
  { id: 'abajo', label: 'Base' },
]
const CUTS: { id: Cut; label: string }[] = [
  { id: 'ninguno', label: 'Sin corte' },
  { id: 'sagital', label: 'Sagital' },
  { id: 'coronal', label: 'Coronal' },
  { id: 'axial', label: 'Axial' },
]
const VOLUME_PRESETS = [
  { id: 'CT-Bone', label: 'Hueso' },
  { id: 'CT-Bones', label: 'Hueso (opaco)' },
  { id: 'CT-Soft-Tissue', label: 'Piel' },
  { id: 'CT-MIP', label: 'MIP' },
]

export function SkullView({ manifest }: { manifest: Manifest }) {
  const [mode, setMode] = useState<Mode>('superficie')
  const [view, setView] = useState<{ id: View; nonce: number }>({ id: 'frente', nonce: 0 })
  const [cut, setCut] = useState<Cut>('ninguno')
  const [cutPos, setCutPos] = useState(0)
  const [autoRotate, setAutoRotate] = useState(false)
  const [recording, setRecording] = useState(false)
  const [preset, setPreset] = useState('CT-Bone')
  const [showAir, setShowAir] = useState(false)
  const [boneOpacity, setBoneOpacity] = useState(1)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)

  const { mesh } = manifest
  // Precarga la capa de aire para que activarla sea instantáneo
  useEffect(() => {
    if (mesh.air) useGLTF.preload(dataUrl(mesh.air.glb))
  }, [mesh])
  const halfExtent = useMemo(() => {
    const [sx, sy, sz] = mesh.sizeMm // LPS: x, y (antero-posterior), z
    return { sagital: sx / 2, coronal: sy / 2, axial: sz / 2 }
  }, [mesh])

  const setCutMode = (c: Cut) => {
    setCut(c)
    setCutPos(0)
  }

  const screenshot = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob((blob) => blob && download(blob, 'craneo.png'))
  }

  return (
    <div className="view">
      <aside className="sidebar">
        <Section title="Modo">
          <Chips
            options={[{ id: 'superficie', label: 'Superficie' }, { id: 'volumen', label: 'Volumen' }]}
            value={mode}
            onChange={(m) => setMode(m as Mode)}
          />
        </Section>

        {mode === 'superficie' ? (
          <>
            <Section title="Vista">
              <Chips options={VIEWS} value={view.id} onChange={(id) => setView({ id, nonce: Date.now() })} />
            </Section>
            {mesh.air && (
              <Section title="Capas">
                <div className="range-row">
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={showAir}
                      onChange={(e) => {
                        setShowAir(e.target.checked)
                        setBoneOpacity(e.target.checked ? 0.3 : 1)
                      }}
                    />
                    <span><span className="swatch" style={{ background: AIR_COLOR }} />Senos y vía aérea</span>
                  </label>
                  <label>
                    <span>Opacidad del hueso</span>
                    <span className="num">{Math.round(boneOpacity * 100)}%</span>
                  </label>
                  <input
                    className="slider"
                    type="range"
                    min={0.05}
                    max={1}
                    step={0.01}
                    value={boneOpacity}
                    onChange={(e) => setBoneOpacity(Number(e.target.value))}
                  />
                </div>
              </Section>
            )}
            <Section title="Plano de corte">
              <div className="range-row">
                <Chips options={CUTS} value={cut} onChange={setCutMode} />
                {cut !== 'ninguno' && (
                  <>
                    <label>
                      <span>Posición</span>
                      <span className="num">{cutPos.toFixed(0)} mm</span>
                    </label>
                    <input
                      className="slider"
                      type="range"
                      min={-halfExtent[cut]}
                      max={halfExtent[cut]}
                      step={0.5}
                      value={cutPos}
                      onChange={(e) => setCutPos(Number(e.target.value))}
                    />
                  </>
                )}
              </div>
            </Section>
            <Section title="Exportar">
              <div className="btn-col">
                <button className="btn" onClick={() => setAutoRotate((a) => !a)}>
                  {autoRotate ? 'Detener giro' : 'Girar automáticamente'}
                </button>
                <button className="btn primary" disabled={recording} onClick={() => setRecording(true)}>
                  {recording ? 'Grabando…' : 'Grabar video 360°'}
                </button>
                <button className="btn" onClick={screenshot}>Captura PNG</button>
                <a className="btn" href={dataUrl(mesh.stl)} download="craneo.stl">Descargar STL (impresión 3D)</a>
              </div>
            </Section>
            <Section title="Malla">
              <p className="note">
                Isosuperficie a <b>{mesh.thresholdHU} HU</b> sobre el volumen de 0.5 mm ·{' '}
                {(mesh.faces / 1000).toFixed(0)} mil triángulos · {mesh.sizeMm.map((v) => v.toFixed(0)).join(' × ')} mm.
                Donde el estudio deja de tener cortes, el cráneo termina en un borde plano.
                {mesh.air?.volumeMl && <> El aire interno suma {Math.round(mesh.air.volumeMl)} ml (senos, fosas nasales, vía aérea y mastoides).</>}
              </p>
            </Section>
          </>
        ) : (
          <>
            <Section title="Preset de render">
              <Chips options={VOLUME_PRESETS} value={preset} onChange={setPreset} />
            </Section>
            <Section title="Controles">
              <ul className="help">
                <li><b>Arrastrar</b>: rotar</li>
                <li><b>Rueda</b> o <b>clic derecho</b>: zoom</li>
                <li><b>Clic central</b>: mover</li>
              </ul>
            </Section>
            <p className="note">
              Render directo de los vóxeles, sin malla. <b>Piel</b> muestra la superficie del rostro;
              <b> MIP</b> proyecta la densidad máxima, como una radiografía.
            </p>
          </>
        )}
      </aside>

      {mode === 'superficie' ? (
        <div className="three-stage">
          {recording && <div className="rec-badge">● Grabando giro de 360°</div>}
          <Canvas
            camera={{ position: [0, 0, CAMERA_DISTANCE], fov: 35, near: 1, far: 4000 }}
            gl={{ preserveDrawingBuffer: true, antialias: true, localClippingEnabled: true }}
            dpr={[1, 2]}
            onCreated={({ gl }) => { canvasRef.current = gl.domElement }}
          >
            <Lights />
            <Suspense fallback={null}>
              <Turntable recording={recording} onDone={() => setRecording(false)}>
                <Skull url={dataUrl(mesh.glb)} cut={cut} cutPos={cutPos} opacity={boneOpacity} />
                {mesh.air && showAir && (
                  <Suspense fallback={null}>
                    <Air url={dataUrl(mesh.air.glb)} cut={cut} cutPos={cutPos} />
                  </Suspense>
                )}
              </Turntable>
            </Suspense>
            <CameraRig view={view} />
            <OrbitControls makeDefault enableDamping autoRotate={autoRotate && !recording} autoRotateSpeed={1.5} />
          </Canvas>
        </div>
      ) : (
        <VolumeRender manifest={manifest} preset={preset} />
      )}
    </div>
  )
}

function CameraRig({ view }: { view: { id: View; nonce: number } }) {
  const { camera, controls } = useThree()
  useEffect(() => {
    const dir = new THREE.Vector3(...VIEW_DIRECTIONS[view.id]).normalize()
    camera.position.copy(dir.multiplyScalar(CAMERA_DISTANCE))
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0, 0)
    const c = controls as OrbitControlsImpl | null
    if (c) {
      c.target.set(0, 0, 0)
      c.update()
    }
  }, [view, camera, controls])
  return null
}

/** Gira el modelo 360° mientras graba el canvas a video. */
function Turntable({ recording, onDone, children }: { recording: boolean; onDone: () => void; children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null)
  const gl = useThree((s) => s.gl)
  const state = useRef<{ start: number; recorder: MediaRecorder } | null>(null)
  const onDoneRef = useRef(onDone)
  onDoneRef.current = onDone
  const DURATION = 9

  useEffect(() => {
    if (!recording) return
    const stream = gl.domElement.captureStream(30)
    const type = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t))
    const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8_000_000 })
    const chunks: Blob[] = []
    recorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data)
    }
    recorder.onstop = () => {
      const ext = type?.startsWith('video/mp4') ? 'mp4' : 'webm'
      download(new Blob(chunks, { type: recorder.mimeType }), `craneo-360.${ext}`)
      onDoneRef.current()
    }
    recorder.start()
    state.current = { start: performance.now(), recorder }
    return () => {
      if (recorder.state !== 'inactive') recorder.stop()
    }
  }, [recording, gl])

  useFrame(() => {
    const g = group.current
    const s = state.current
    if (!g) return
    if (!recording || !s) {
      g.rotation.y = 0
      return
    }
    const t = (performance.now() - s.start) / 1000 / DURATION
    if (t >= 1) {
      g.rotation.y = 0
      state.current = null
      s.recorder.stop()
      return
    }
    g.rotation.y = t * Math.PI * 2
  })

  return <group ref={group}>{children}</group>
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 2000)
}

const VR_VIEWPORT_ID = 'vr'
const VR_TOOL_GROUP_ID = 'vr-tools'

function VolumeRender({ manifest, preset }: { manifest: Manifest; preset: string }) {
  const [volume, setVolume] = useState<FusedVolume | null>(null)
  const [progress, setProgress] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const elRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    loadFusedVolume(manifest.volume, setProgress).then(setVolume, (e) => setError(String(e)))
  }, [manifest])

  useEffect(() => {
    if (!volume || !elRef.current) return
    const eng = engine()
    eng.enableElement({
      viewportId: VR_VIEWPORT_ID,
      type: Enums.ViewportType.VOLUME_3D,
      element: elRef.current,
      defaultOptions: { orientation: Enums.OrientationAxis.CORONAL, background: [0.04, 0.045, 0.05] as Types.Point3 },
    })
    create3DToolGroup(VR_TOOL_GROUP_ID, [VR_VIEWPORT_ID])
    let cancelled = false
    setVolumesForViewports(eng, [{ volumeId: volume.id }], [VR_VIEWPORT_ID]).then(() => {
      if (cancelled) return
      const vp = eng.getViewport(VR_VIEWPORT_ID) as Types.IVolumeViewport
      vp.setProperties({ preset })
      vp.resetCamera()
      vp.render()
      setReady(true)
    })
    const ro = new ResizeObserver(() => eng.resize(true, true))
    ro.observe(elRef.current)
    return () => {
      cancelled = true
      ro.disconnect()
      destroyToolGroup(VR_TOOL_GROUP_ID)
      eng.disableElement(VR_VIEWPORT_ID)
      setReady(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [volume])

  useEffect(() => {
    if (!ready) return
    const vp = engine().getViewport(VR_VIEWPORT_ID) as Types.IVolumeViewport | undefined
    vp?.setProperties({ preset })
    vp?.render()
  }, [preset, ready])

  if (error) return <LoadingMessage text={error} />
  return (
    <div className="viewport-wrap" onContextMenu={(e) => e.preventDefault()}>
      {!volume && <LoadingMessage text="Cargando volumen reconstruido…" progress={progress} />}
      <div ref={elRef} className="viewport-el" style={{ visibility: volume ? 'visible' : 'hidden' }} />
    </div>
  )
}
