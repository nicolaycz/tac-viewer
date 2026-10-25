import { init as coreInit, RenderingEngine, getRenderingEngine } from '@cornerstonejs/core'
import { init as dicomImageLoaderInit } from '@cornerstonejs/dicom-image-loader'
import {
  init as toolsInit,
  addTool,
  ToolGroupManager,
  WindowLevelTool,
  PanTool,
  ZoomTool,
  StackScrollTool,
  LengthTool,
  ProbeTool,
  CrosshairsTool,
  TrackballRotateTool,
  Enums as ToolEnums,
} from '@cornerstonejs/tools'
import type { Types as ToolTypes } from '@cornerstonejs/tools'

const ENGINE_ID = 'tac-engine'
let ready: Promise<void> | null = null

export function initCornerstone(): Promise<void> {
  ready ??= (async () => {
    await coreInit()
    // El proveedor "naturalizado" de v5 no encuentra los píxeles de estos archivos
    // (Explicit VR Little Endian sin comprimir); el de dicom-parser sí los lee bien.
    dicomImageLoaderInit({
      maxWebWorkers: Math.max(1, Math.min(4, navigator.hardwareConcurrency / 2)),
      useLegacyMetadataProvider: true,
    })
    toolsInit()
    for (const tool of [WindowLevelTool, PanTool, ZoomTool, StackScrollTool, LengthTool, ProbeTool, CrosshairsTool, TrackballRotateTool]) {
      addTool(tool)
    }
    new RenderingEngine(ENGINE_ID)
  })()
  return ready
}

export function engine(): RenderingEngine {
  const e = getRenderingEngine(ENGINE_ID)
  if (!e) throw new Error('Cornerstone no está inicializado')
  return e as RenderingEngine
}

export const { MouseBindings } = ToolEnums

/**
 * destroyToolGroup de Cornerstone solo saca el grupo de la lista; si no se
 * deshabilitan antes sus herramientas, la cruz deja listeners globales vivos.
 */
export function destroyToolGroup(id: string) {
  const group = ToolGroupManager.getToolGroup(id)
  if (!group) return
  for (const name of Object.keys(group.toolOptions)) group.setToolDisabled(name)
  ToolGroupManager.destroyToolGroup(id)
}

/** Herramienta asignada al botón izquierdo del mouse. */
export type PrimaryTool = 'ventana' | 'mover' | 'zoom' | 'medir' | 'hu' | 'cruz'

export const PRIMARY_TOOL_NAME: Record<PrimaryTool, string> = {
  ventana: WindowLevelTool.toolName,
  mover: PanTool.toolName,
  zoom: ZoomTool.toolName,
  medir: LengthTool.toolName,
  hu: ProbeTool.toolName,
  cruz: CrosshairsTool.toolName,
}

/**
 * Grupo de herramientas 2D: rueda = cambiar de corte, derecho = zoom,
 * central = mover, izquierdo = herramienta elegida en la barra.
 */
export function create2DToolGroup(id: string, viewportIds: string[], primary: PrimaryTool, withCrosshairs = false): ToolTypes.IToolGroup {
  destroyToolGroup(id)
  const group = ToolGroupManager.createToolGroup(id)!
  // Los viewports van antes de activar herramientas: la cruz necesita conocerlos
  for (const viewportId of viewportIds) group.addViewport(viewportId, ENGINE_ID)
  group.addTool(WindowLevelTool.toolName)
  group.addTool(PanTool.toolName)
  group.addTool(ZoomTool.toolName)
  group.addTool(StackScrollTool.toolName)
  group.addTool(LengthTool.toolName)
  group.addTool(ProbeTool.toolName)
  if (withCrosshairs) {
    group.addTool(CrosshairsTool.toolName, {
      getReferenceLineColor: (viewportId: string) => CROSSHAIR_COLORS[viewportId] ?? '#f5b942',
      getReferenceLineControllable: () => true,
      getReferenceLineDraggableRotatable: () => false,
      getReferenceLineSlabThicknessControlsOn: () => false,
    })
  }
  group.setToolActive(StackScrollTool.toolName, { bindings: [{ mouseButton: MouseBindings.Wheel }] })
  group.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }] })
  group.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
  setPrimaryTool(group, primary)
  return group
}

export const CROSSHAIR_COLORS: Record<string, string> = {
  'mpr-axial': '#ef6b5b',
  'mpr-coronal': '#5fbf7f',
  'mpr-sagital': '#5b9cef',
}

export function setPrimaryTool(group: ToolTypes.IToolGroup, primary: PrimaryTool) {
  const target = PRIMARY_TOOL_NAME[primary]
  // Pasivo quita solo el botón izquierdo: zoom y mover siguen en sus botones,
  // y las mediciones y la cruz siguen visibles.
  for (const name of Object.values(PRIMARY_TOOL_NAME)) {
    if (name !== target && group.hasTool(name)) group.setToolPassive(name)
  }
  group.setToolActive(target, { bindings: [{ mouseButton: MouseBindings.Primary }] })
}

export function create3DToolGroup(id: string, viewportIds: string[]): ToolTypes.IToolGroup {
  destroyToolGroup(id)
  const group = ToolGroupManager.createToolGroup(id)!
  for (const viewportId of viewportIds) group.addViewport(viewportId, ENGINE_ID)
  group.addTool(TrackballRotateTool.toolName)
  group.addTool(ZoomTool.toolName)
  group.addTool(PanTool.toolName)
  group.setToolActive(TrackballRotateTool.toolName, { bindings: [{ mouseButton: MouseBindings.Primary }] })
  group.setToolActive(ZoomTool.toolName, { bindings: [{ mouseButton: MouseBindings.Secondary }, { mouseButton: MouseBindings.Wheel }] })
  group.setToolActive(PanTool.toolName, { bindings: [{ mouseButton: MouseBindings.Auxiliary }] })
  return group
}
