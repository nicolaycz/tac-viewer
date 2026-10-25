import { Suspense, useEffect, useRef } from 'react'
import { Canvas, useThree } from '@react-three/fiber'
import * as THREE from 'three'
import { dataUrl, type Manifest } from '../lib/manifest'
import { Air, Lights, Skull } from '../three/skullScene'

/**
 * Modo de exportación (`?export=360`): un canvas cuadrado sin interfaz que
 * dibuja cuadro por cuadro a pedido, sin depender del requestAnimationFrame.
 * Lo usa `scripts/render-360.mjs` con Chrome headless para armar el MP4.
 *
 * Parámetros: size (px), hueso (opacidad 0–1), aire (0/1), elevacion (grados).
 */
export interface Turntable360Api {
  ready: boolean
  /** Dibuja el cuadro `index` de `total` y lo devuelve como PNG con transparencia. */
  render(index: number, total: number): string
}

declare global {
  interface Window {
    __tac360?: Turntable360Api
  }
}

export function Turntable360({ manifest }: { manifest: Manifest }) {
  const params = new URLSearchParams(location.search)
  const size = Number(params.get('size') ?? 1080)
  const boneOpacity = Number(params.get('hueso') ?? 0.3)
  const showAir = params.get('aire') !== '0' && !!manifest.mesh.air
  const elevation = (Number(params.get('elevacion') ?? 12) * Math.PI) / 180
  const distance = 365

  return (
    <div style={{ width: size, height: size }}>
      <Canvas
        frameloop="never"
        dpr={1}
        camera={{
          position: [0, distance * Math.sin(elevation), distance * Math.cos(elevation)],
          fov: 35,
          near: 1,
          far: 4000,
        }}
        gl={{ preserveDrawingBuffer: true, antialias: true, alpha: true }}
        style={{ width: size, height: size }}
      >
        <Lights />
        <Suspense fallback={null}>
          <Rig>
            <Skull url={dataUrl(manifest.mesh.glb)} opacity={showAir ? boneOpacity : 1} />
            {showAir && <Air url={dataUrl(manifest.mesh.air!.glb)} />}
          </Rig>
        </Suspense>
      </Canvas>
    </div>
  )
}

/** Se monta cuando las mallas ya cargaron: expone la API de render en window. */
function Rig({ children }: { children: React.ReactNode }) {
  const group = useRef<THREE.Group>(null)
  const { gl, scene, camera } = useThree()

  useEffect(() => {
    const cam = camera as THREE.PerspectiveCamera
    cam.aspect = 1
    cam.updateProjectionMatrix()
    cam.lookAt(0, 0, 0)
    window.__tac360 = {
      ready: true,
      render(index, total) {
        group.current!.rotation.y = (index / total) * Math.PI * 2
        gl.render(scene, camera)
        return gl.domElement.toDataURL('image/png')
      },
    }
    gl.render(scene, camera)
    return () => {
      delete window.__tac360
    }
  }, [gl, scene, camera])

  return <group ref={group}>{children}</group>
}
