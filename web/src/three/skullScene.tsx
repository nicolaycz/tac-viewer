import { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import * as THREE from 'three'

/** Piezas de la escena 3D compartidas por el visor y la exportación del video 360°. */

export type Cut = 'ninguno' | 'sagital' | 'coronal' | 'axial'

// En la escena: X = izquierda del paciente, Y = superior, Z = anterior
const CUT_NORMAL: Record<Exclude<Cut, 'ninguno'>, THREE.Vector3> = {
  sagital: new THREE.Vector3(1, 0, 0),
  coronal: new THREE.Vector3(0, 0, -1),
  axial: new THREE.Vector3(0, -1, 0),
}
export const AIR_COLOR = '#6fb4ec'

export function Lights() {
  return (
    <>
      <hemisphereLight args={['#fff6e8', '#20242b', 0.6]} />
      <directionalLight position={[180, 260, 320]} intensity={2.4} />
      <directionalLight position={[-260, 80, -120]} intensity={0.7} color="#cfe0ff" />
      <directionalLight position={[0, -200, 200]} intensity={0.35} />
    </>
  )
}

function useFirstGeometry(url: string) {
  const gltf = useGLTF(url)
  return useMemo(() => {
    let g: THREE.BufferGeometry | null = null
    gltf.scene.traverse((o) => {
      if ((o as THREE.Mesh).isMesh && !g) g = (o as THREE.Mesh).geometry
    })
    const geom = g! as THREE.BufferGeometry
    if (!geom.getAttribute('normal')) geom.computeVertexNormals()
    return geom
  }, [gltf])
}

function useCutPlanes(cut: Cut, cutPos: number) {
  const plane = useMemo(() => new THREE.Plane(), [])
  if (cut === 'ninguno') return []
  plane.set(CUT_NORMAL[cut], -cutPos * (cut === 'sagital' ? 1 : -1))
  return [plane]
}

export function Skull({ url, cut = 'ninguno', cutPos = 0, opacity }: { url: string; cut?: Cut; cutPos?: number; opacity: number }) {
  const geometry = useFirstGeometry(url)
  const planes = useCutPlanes(cut, cutPos)
  if (opacity < 0.999) {
    // Translúcido: un pre-pase de profundidad deja dibujar solo la capa de hueso más
    // cercana; si no, las decenas de capas superpuestas tapan los senos.
    return (
      <group key="translucido">
        <mesh geometry={geometry} renderOrder={1}>
          <meshBasicMaterial colorWrite={false} clippingPlanes={planes} />
        </mesh>
        <mesh geometry={geometry} renderOrder={2}>
          <meshStandardMaterial
            color="#e9dfca" roughness={0.62} metalness={0} clippingPlanes={planes}
            transparent opacity={opacity} depthWrite={false} depthFunc={THREE.LessEqualDepth}
          />
        </mesh>
      </group>
    )
  }
  return (
    <group key="opaco">
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#e9dfca" roughness={0.62} metalness={0} side={THREE.FrontSide} clippingPlanes={planes} />
      </mesh>
      {/* Cara interna: se ve al cortar */}
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#8c5444" roughness={0.85} metalness={0} side={THREE.BackSide} clippingPlanes={planes} />
      </mesh>
    </group>
  )
}

export function Air({ url, cut = 'ninguno', cutPos = 0 }: { url: string; cut?: Cut; cutPos?: number }) {
  const geometry = useFirstGeometry(url)
  const planes = useCutPlanes(cut, cutPos)
  return (
    <group>
      <mesh geometry={geometry}>
        <meshStandardMaterial color={AIR_COLOR} roughness={0.35} metalness={0} side={THREE.FrontSide} clippingPlanes={planes} />
      </mesh>
      <mesh geometry={geometry}>
        <meshStandardMaterial color="#2c5675" roughness={0.6} metalness={0} side={THREE.BackSide} clippingPlanes={planes} />
      </mesh>
    </group>
  )
}
