import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import type { ISceneLoaderAsyncResult } from '@babylonjs/core/Loading/sceneLoader'
import '@babylonjs/loaders/glTF'
import {
  DEFAULT_THUMB_ALPHA,
  DEFAULT_THUMB_BETA,
  DEFAULT_THUMB_DISTANCE_MULT,
  computeFitTarget,
  createThumbnailCamera,
  disposeImportResult,
  getAssetOverride,
  getItemFamilyOverride,
  getItemOverride,
  invalidateOverridesCache,
  setupThumbnailLights,
  splitEncodedGlbUrl,
  type AssetThumbnailOverride,
} from './ThumbnailRenderer'
import { clearCachedThumb } from './ThumbnailCache'

const MODAL_SIZE = 320
const RAD_TO_DEG = 180 / Math.PI
const DEG_TO_RAD = Math.PI / 180
const MIN_TILT_DEG = 1
const MAX_TILT_DEG = 179
const MIN_ICON_SCALE = 0.1
const MAX_ICON_SCALE = 1.5
const MIN_DISTANCE_MULT = 0.1
const MAX_DISTANCE_MULT = 12

export interface ThumbnailPoseEditorOptions {
  targetType: 'asset' | 'item' | 'item-family'
  key: string | number
  modelPath: string
  title: string
  subtitle?: string
  bakedWarning?: string
  initialOverride?: AssetThumbnailOverride
  renderOutputPreview?: (entry: AssetThumbnailOverride) => Promise<string | null>
  onSaved: () => void
}

/** Open the per-asset rotation editor for `path`. Modal lets the user drag
 *  to set yaw/pitch and scroll to zoom; saving POSTs the override and
 *  invalidates the cached thumb so the asset grid re-renders.
 *
 *  `onSaved` fires after a successful save, before the modal closes —
 *  callers use it to refresh the asset card image. */
export async function openThumbnailRotationEditor(
  path: string,
  onSaved: () => void,
): Promise<void> {
  return openThumbnailPoseEditor({
    targetType: 'asset',
    key: path,
    modelPath: path,
    title: path,
    onSaved,
  })
}

export async function openThumbnailPoseEditor(
  options: ThumbnailPoseEditorOptions,
): Promise<void> {
  const runtimePreviewMode = !!options.renderOutputPreview
  const backdrop = document.createElement('div')
  backdrop.className = 'asset-rotate-modal'
  const inner = document.createElement('div')
  inner.className = 'asset-rotate-modal-inner'
  if (runtimePreviewMode) inner.classList.add('runtime-preview-mode')
  backdrop.appendChild(inner)

  const title = document.createElement('div')
  title.textContent = options.title
  title.style.opacity = '0.7'
  title.style.fontSize = '11px'
  title.style.wordBreak = 'break-all'
  inner.appendChild(title)

  if (options.subtitle || options.bakedWarning) {
    const sub = document.createElement('div')
    sub.textContent = options.bakedWarning || options.subtitle || ''
    sub.className = options.bakedWarning ? 'asset-rotate-modal-warning' : ''
    sub.style.opacity = options.bakedWarning ? '1' : '0.5'
    sub.style.fontSize = '11px'
    inner.appendChild(sub)
  }

  const canvas = document.createElement('canvas')
  canvas.className = 'asset-rotate-modal-canvas'
  canvas.width = MODAL_SIZE
  canvas.height = MODAL_SIZE
  inner.appendChild(canvas)

  let outputImg: HTMLImageElement | null = null
  if (runtimePreviewMode) {
    const outputWrap = document.createElement('div')
    outputWrap.className = 'asset-rotate-output-wrap'
    const outputLabel = document.createElement('div')
    outputLabel.className = 'asset-rotate-output-label'
    outputLabel.textContent = 'Runtime thumbnail preview'
    outputImg = document.createElement('img')
    outputImg.className = 'asset-rotate-output-img'
    outputWrap.appendChild(outputLabel)
    outputWrap.appendChild(outputImg)
    inner.appendChild(outputWrap)
  }

  const hint = document.createElement('div')
  hint.textContent = runtimePreviewMode
    ? 'This preview is the saved/copied thumbnail · drag angle/tilt · lower Item size makes it smaller'
    : 'Drag view angle · scroll zoom · use model yaw only for bad exports'
  hint.style.opacity = '0.5'
  inner.appendChild(hint)

  const sideRow = document.createElement('div')
  sideRow.className = 'asset-rotate-side-row'
  const sidePresets = [
    { label: 'Front', alpha: -Math.PI / 2, beta: DEFAULT_THUMB_BETA },
    { label: 'Right', alpha: 0, beta: DEFAULT_THUMB_BETA },
    { label: 'Back', alpha: Math.PI / 2, beta: DEFAULT_THUMB_BETA },
    { label: 'Left', alpha: Math.PI, beta: DEFAULT_THUMB_BETA },
    { label: '3/4', alpha: DEFAULT_THUMB_ALPHA, beta: DEFAULT_THUMB_BETA },
    { label: 'Top', alpha: DEFAULT_THUMB_ALPHA, beta: 12 * DEG_TO_RAD },
    { label: 'High', alpha: DEFAULT_THUMB_ALPHA, beta: 35 * DEG_TO_RAD },
    { label: 'Low', alpha: DEFAULT_THUMB_ALPHA, beta: 120 * DEG_TO_RAD },
    { label: 'Front High', alpha: -Math.PI / 2, beta: 35 * DEG_TO_RAD },
    { label: 'Right High', alpha: 0, beta: 35 * DEG_TO_RAD },
  ]
  for (const preset of sidePresets) {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'asset-rotate-side-btn'
    btn.textContent = preset.label
    btn.addEventListener('click', () => {
      cam.alpha = preset.alpha
      cam.beta = preset.beta
      syncControls()
      scheduleOutputPreview()
    })
    sideRow.appendChild(btn)
  }
  inner.appendChild(sideRow)

  const yawRow = document.createElement('div')
  yawRow.className = 'asset-rotate-modal-control'
  const yawLabel = document.createElement('label')
  yawLabel.textContent = 'View angle'
  const yawSlider = document.createElement('input')
  yawSlider.type = 'range'
  yawSlider.min = '-180'
  yawSlider.max = '180'
  yawSlider.step = '0.5'
  const yawValue = document.createElement('input')
  yawValue.type = 'number'
  yawValue.min = '-180'
  yawValue.max = '180'
  yawValue.step = '0.5'
  yawValue.className = 'asset-rotate-modal-number'
  yawRow.appendChild(yawLabel)
  yawRow.appendChild(yawSlider)
  yawRow.appendChild(yawValue)
  inner.appendChild(yawRow)

  const tiltRow = document.createElement('div')
  tiltRow.className = 'asset-rotate-modal-control'
  const tiltLabel = document.createElement('label')
  tiltLabel.textContent = 'Tilt'
  const tiltSlider = document.createElement('input')
  tiltSlider.type = 'range'
  tiltSlider.min = String(MIN_TILT_DEG)
  tiltSlider.max = String(MAX_TILT_DEG)
  tiltSlider.step = '0.5'
  const tiltValue = document.createElement('input')
  tiltValue.type = 'number'
  tiltValue.min = String(MIN_TILT_DEG)
  tiltValue.max = String(MAX_TILT_DEG)
  tiltValue.step = '0.5'
  tiltValue.className = 'asset-rotate-modal-number'
  tiltRow.appendChild(tiltLabel)
  tiltRow.appendChild(tiltSlider)
  tiltRow.appendChild(tiltValue)
  inner.appendChild(tiltRow)

  const zoomRow = document.createElement('div')
  zoomRow.className = 'asset-rotate-modal-control'
  const zoomLabel = document.createElement('label')
  zoomLabel.textContent = runtimePreviewMode ? 'Item size' : 'Zoom'
  const zoomSlider = document.createElement('input')
  zoomSlider.type = 'range'
  zoomSlider.min = String(runtimePreviewMode ? MIN_ICON_SCALE : MIN_DISTANCE_MULT)
  zoomSlider.max = String(runtimePreviewMode ? MAX_ICON_SCALE : MAX_DISTANCE_MULT)
  zoomSlider.step = '0.05'
  const zoomValue = document.createElement('input')
  zoomValue.type = 'number'
  zoomValue.min = String(runtimePreviewMode ? MIN_ICON_SCALE : MIN_DISTANCE_MULT)
  zoomValue.max = String(runtimePreviewMode ? MAX_ICON_SCALE : MAX_DISTANCE_MULT)
  zoomValue.step = '0.05'
  zoomValue.className = 'asset-rotate-modal-number'
  zoomValue.title = runtimePreviewMode
    ? 'Lower values make the item appear smaller without reducing render quality.'
    : 'Higher values zoom the camera out.'
  zoomRow.appendChild(zoomLabel)
  zoomRow.appendChild(zoomSlider)
  zoomRow.appendChild(zoomValue)
  inner.appendChild(zoomRow)

  const modelYawRow = document.createElement('div')
  modelYawRow.className = 'asset-rotate-modal-control'
  const modelYawLabel = document.createElement('label')
  modelYawLabel.textContent = 'Model yaw'
  const modelYawSlider = document.createElement('input')
  modelYawSlider.type = 'range'
  modelYawSlider.min = '-180'
  modelYawSlider.max = '180'
  modelYawSlider.step = '0.5'
  const modelYawValue = document.createElement('input')
  modelYawValue.type = 'number'
  modelYawValue.min = '-180'
  modelYawValue.max = '180'
  modelYawValue.step = '0.5'
  modelYawValue.className = 'asset-rotate-modal-number'
  modelYawRow.appendChild(modelYawLabel)
  modelYawRow.appendChild(modelYawSlider)
  modelYawRow.appendChild(modelYawValue)
  inner.appendChild(modelYawRow)

  const modelPitchRow = document.createElement('div')
  modelPitchRow.className = 'asset-rotate-modal-control'
  const modelPitchLabel = document.createElement('label')
  modelPitchLabel.textContent = 'Model pitch'
  const modelPitchSlider = document.createElement('input')
  modelPitchSlider.type = 'range'
  modelPitchSlider.min = '-180'
  modelPitchSlider.max = '180'
  modelPitchSlider.step = '0.5'
  const modelPitchValue = document.createElement('input')
  modelPitchValue.type = 'number'
  modelPitchValue.min = '-180'
  modelPitchValue.max = '180'
  modelPitchValue.step = '0.5'
  modelPitchValue.className = 'asset-rotate-modal-number'
  modelPitchRow.appendChild(modelPitchLabel)
  modelPitchRow.appendChild(modelPitchSlider)
  modelPitchRow.appendChild(modelPitchValue)
  inner.appendChild(modelPitchRow)

  const modelRollRow = document.createElement('div')
  modelRollRow.className = 'asset-rotate-modal-control'
  const modelRollLabel = document.createElement('label')
  modelRollLabel.textContent = 'Model roll'
  const modelRollSlider = document.createElement('input')
  modelRollSlider.type = 'range'
  modelRollSlider.min = '-180'
  modelRollSlider.max = '180'
  modelRollSlider.step = '0.5'
  const modelRollValue = document.createElement('input')
  modelRollValue.type = 'number'
  modelRollValue.min = '-180'
  modelRollValue.max = '180'
  modelRollValue.step = '0.5'
  modelRollValue.className = 'asset-rotate-modal-number'
  modelRollRow.appendChild(modelRollLabel)
  modelRollRow.appendChild(modelRollSlider)
  modelRollRow.appendChild(modelRollValue)
  inner.appendChild(modelRollRow)

  const buttons = document.createElement('div')
  buttons.className = 'asset-rotate-modal-row'
  const resetBtn = document.createElement('button')
  resetBtn.className = 'asset-rotate-modal-btn secondary'
  resetBtn.textContent = 'Reset'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'asset-rotate-modal-btn secondary'
  cancelBtn.textContent = 'Cancel'
  const deleteBtn = document.createElement('button')
  deleteBtn.className = 'asset-rotate-modal-btn danger'
  deleteBtn.textContent = 'Delete Override'
  const saveBtn = document.createElement('button')
  saveBtn.className = 'asset-rotate-modal-btn'
  saveBtn.textContent = 'Save'
  buttons.appendChild(resetBtn)
  buttons.appendChild(deleteBtn)
  buttons.appendChild(cancelBtn)
  buttons.appendChild(saveBtn)
  inner.appendChild(buttons)

  document.body.appendChild(backdrop)

  let engine: Engine | null = null
  let scene: Scene | null = null
  let cam: {
    alpha: number
    beta: number
    radius: number
    fov: number
    setTarget: (target: any) => void
  } = {
    alpha: DEFAULT_THUMB_ALPHA,
    beta: DEFAULT_THUMB_BETA,
    radius: 10,
    fov: 0.8,
    setTarget: () => {},
  }
  if (!runtimePreviewMode) {
    engine = new Engine(canvas, true, { preserveDrawingBuffer: true, antialias: true })
    scene = new Scene(engine)
    scene.clearColor = new Color4(0.07, 0.08, 0.09, 1)
    setupThumbnailLights(scene, 'rot')
    cam = createThumbnailCamera(scene, 'rot-cam')
  }

  // Closed-flag is the race guard: if the user cancels DURING the async
  // ImportMeshAsync await below, close() runs and disposes the scene before
  // we get a chance to wire the render loop / camera framing. The flag lets
  // the post-await code bail out cleanly instead of touching disposed objects.
  let closed = false
  let importResult: ISceneLoaderAsyncResult | null = null
  let fitRadius = 10
  let modelRoot: any = null
  let baseRootRotation = { x: 0, y: 0, z: 0 }
  let rotationX = 0
  let rotationY = 0
  let rotationZ = 0
  let iconScale = 1
  let outputPreviewTimer: number | null = null
  let outputPreviewSeq = 0
  let outputPreviewRunning = false
  let outputPreviewQueued = false
  let outputPreviewPainted = false

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKeyDown)

  const close = (): void => {
    if (closed) return
    closed = true
    if (outputPreviewTimer !== null) window.clearTimeout(outputPreviewTimer)
    document.removeEventListener('keydown', onKeyDown)
    if (engine) engine.stopRenderLoop()
    if (importResult) disposeImportResult(importResult)
    try { scene?.dispose() } catch { /* ignore */ }
    try { engine?.dispose() } catch { /* ignore */ }
    try { document.body.removeChild(backdrop) } catch { /* ignore */ }
  }

  try {
    if (!runtimePreviewMode && scene) {
      const { dir, file } = splitEncodedGlbUrl(options.modelPath)
      importResult = await SceneLoader.ImportMeshAsync('', dir, file, scene)
      if (closed) {
        disposeImportResult(importResult)
        return
      }
      for (const ag of importResult.animationGroups || []) ag.stop()
      modelRoot = importResult.meshes.find((m) => m.name === '__root__') ?? importResult.meshes.find((m) => !m.parent)
      if (modelRoot) {
        if (modelRoot.rotationQuaternion) modelRoot.rotationQuaternion = null
        baseRootRotation = {
          x: modelRoot.rotation.x || 0,
          y: modelRoot.rotation.y || 0,
          z: modelRoot.rotation.z || 0,
        }
      }
      const fit = computeFitTarget(importResult, cam.fov)
      if (fit) {
        cam.setTarget(fit.center)
        fitRadius = fit.fitRadius
      }
    }
  } catch (err) {
    console.warn('[ThumbnailRotationEditor] load failed for', options.modelPath, err)
    if (closed) return
  }

  const initial = options.targetType === 'asset'
    ? await getAssetOverride(String(options.key))
    : options.initialOverride ?? (
      options.targetType === 'item-family'
        ? await getItemFamilyOverride(String(options.key))
        : await getItemOverride(Number(options.key))
    )
  if (closed) return
  let distMult = initial.distanceMult ?? DEFAULT_THUMB_DISTANCE_MULT
  iconScale = initial.iconScale ?? 1
  cam.alpha = initial.alpha ?? DEFAULT_THUMB_ALPHA
  cam.beta = initial.beta ?? DEFAULT_THUMB_BETA
  rotationX = initial.rotationX ?? 0
  rotationY = initial.rotationY ?? 0
  rotationZ = initial.rotationZ ?? 0
  yawSlider.value = String(roundControl(cam.alpha * RAD_TO_DEG))
  tiltSlider.value = String(roundControl(cam.beta * RAD_TO_DEG))
  zoomSlider.value = String(roundControl(runtimePreviewMode ? iconScale : distMult, 2))
  modelYawSlider.value = String(roundControl(rotationY * RAD_TO_DEG))
  modelPitchSlider.value = String(roundControl(rotationX * RAD_TO_DEG))
  modelRollSlider.value = String(roundControl(rotationZ * RAD_TO_DEG))
  cam.radius = fitRadius * distMult

  const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value))
  function roundControl(value: number, decimals = 1): number {
    const mult = 10 ** decimals
    return Math.round(value * mult) / mult
  }
  const syncControls = (): void => {
    yawSlider.value = String(roundControl(cam.alpha * RAD_TO_DEG))
    yawValue.value = yawSlider.value
    tiltSlider.value = String(roundControl(cam.beta * RAD_TO_DEG))
    tiltValue.value = tiltSlider.value
    zoomSlider.value = String(roundControl(runtimePreviewMode ? iconScale : distMult, 2))
    zoomValue.value = zoomSlider.value
    modelYawSlider.value = String(roundControl(rotationY * RAD_TO_DEG))
    modelYawValue.value = modelYawSlider.value
    modelPitchSlider.value = String(roundControl(rotationX * RAD_TO_DEG))
    modelPitchValue.value = modelPitchSlider.value
    modelRollSlider.value = String(roundControl(rotationZ * RAD_TO_DEG))
    modelRollValue.value = modelRollSlider.value
  }
  const clampTilt = (value: number): number => {
    return clamp(value, MIN_TILT_DEG * DEG_TO_RAD, MAX_TILT_DEG * DEG_TO_RAD)
  }
  const buildCurrentEntry = (): AssetThumbnailOverride => ({
    alpha: cam.alpha,
    beta: cam.beta,
    distanceMult: distMult,
    rotationX,
    rotationY,
    rotationZ,
    iconScale,
  })
  const scheduleOutputPreview = (): void => {
    if (!options.renderOutputPreview || !outputImg) return
    if (outputPreviewTimer !== null) window.clearTimeout(outputPreviewTimer)
    const delayMs = outputPreviewRunning ? 0 : 100
    outputPreviewTimer = window.setTimeout(() => {
      outputPreviewTimer = null
      void renderLatestOutputPreview()
    }, delayMs)
  }
  const renderLatestOutputPreview = async (): Promise<void> => {
    if (!options.renderOutputPreview || !outputImg || closed) return
    if (outputPreviewRunning) {
      outputPreviewQueued = true
      outputPreviewSeq++
      return
    }
    outputPreviewRunning = true
    outputPreviewQueued = false
    const seq = ++outputPreviewSeq
    const entry = buildCurrentEntry()
    outputImg.style.opacity = '0.72'
    try {
      let url = await options.renderOutputPreview(entry).catch(() => null)
      if (!outputPreviewPainted && !closed && seq === outputPreviewSeq) {
        url = await options.renderOutputPreview(entry).catch(() => url)
      }
      if (!closed && seq === outputPreviewSeq && url) outputImg.src = url
      if (!closed && seq === outputPreviewSeq && url) outputPreviewPainted = true
    } finally {
      outputPreviewRunning = false
      if (!closed && outputImg && seq === outputPreviewSeq) outputImg.style.opacity = '1'
      if (outputPreviewQueued && !closed) {
        outputPreviewQueued = false
        void renderLatestOutputPreview()
      }
    }
  }
  const flushOutputPreview = async (): Promise<void> => {
    if (!options.renderOutputPreview) return
    if (outputPreviewTimer !== null) {
      window.clearTimeout(outputPreviewTimer)
      outputPreviewTimer = null
    }
    while (outputPreviewRunning) {
      await new Promise((resolve) => window.setTimeout(resolve, 25))
    }
    await renderLatestOutputPreview()
  }
  const applyYaw = (): void => {
    if (!modelRoot) return
    modelRoot.rotation.x = baseRootRotation.x + rotationX
    modelRoot.rotation.y = baseRootRotation.y + rotationY
    modelRoot.rotation.z = baseRootRotation.z + rotationZ
    modelRoot.computeWorldMatrix(true)
    if (importResult) {
      for (const mesh of importResult.meshes) mesh.computeWorldMatrix(true)
    }
  }
  const refitCamera = (): void => {
    if (!importResult) return
    const fit = computeFitTarget(importResult, cam.fov)
    if (!fit) return
    fitRadius = fit.fitRadius
    cam.setTarget(fit.center)
    cam.radius = fitRadius * distMult
  }
  applyYaw()
  refitCamera()
  syncControls()
  void renderLatestOutputPreview()

  if (engine && scene) engine.runRenderLoop(() => scene!.render())

  const wrapRadians = (value: number): number => {
    let out = value
    while (out > Math.PI) out -= Math.PI * 2
    while (out < -Math.PI) out += Math.PI * 2
    return out
  }

  let dragging = false
  let lastX = 0, lastY = 0
  const dragTarget = (outputImg ?? canvas) as HTMLElement
  dragTarget.addEventListener('pointerdown', (e: PointerEvent) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    dragTarget.setPointerCapture(e.pointerId)
  })
  dragTarget.addEventListener('pointermove', (e: PointerEvent) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    cam.alpha = wrapRadians(cam.alpha - dx * 0.015)
    cam.beta = clampTilt(cam.beta - dy * 0.01)
    syncControls()
    scheduleOutputPreview()
  })
  dragTarget.addEventListener('pointerup', (e: PointerEvent) => {
    dragging = false
    try { dragTarget.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  })
  dragTarget.addEventListener('wheel', (e: WheelEvent) => {
    e.preventDefault()
    if (runtimePreviewMode) {
      const factor = e.deltaY > 0 ? 1 / 1.08 : 1.08
      iconScale = clamp(iconScale * factor, MIN_ICON_SCALE, MAX_ICON_SCALE)
    } else {
      const factor = e.deltaY > 0 ? 1.08 : 1 / 1.08
      distMult = clamp(distMult * factor, MIN_DISTANCE_MULT, MAX_DISTANCE_MULT)
      cam.radius = fitRadius * distMult
    }
    syncControls()
    scheduleOutputPreview()
  }, { passive: false })

  yawSlider.addEventListener('input', () => {
    cam.alpha = wrapRadians((Number(yawSlider.value) || 0) * DEG_TO_RAD)
    syncControls()
    scheduleOutputPreview()
  })
  yawValue.addEventListener('change', () => {
    cam.alpha = wrapRadians((Number(yawValue.value) || 0) * DEG_TO_RAD)
    syncControls()
    scheduleOutputPreview()
  })
  tiltSlider.addEventListener('input', () => {
    cam.beta = clampTilt((Number(tiltSlider.value) || 0) * DEG_TO_RAD)
    syncControls()
    scheduleOutputPreview()
  })
  tiltValue.addEventListener('change', () => {
    cam.beta = clampTilt((Number(tiltValue.value) || MIN_TILT_DEG) * DEG_TO_RAD)
    syncControls()
    scheduleOutputPreview()
  })
  zoomSlider.addEventListener('input', () => {
    if (runtimePreviewMode) {
      iconScale = clamp(Number(zoomSlider.value) || 1, MIN_ICON_SCALE, MAX_ICON_SCALE)
    } else {
      distMult = clamp(Number(zoomSlider.value) || DEFAULT_THUMB_DISTANCE_MULT, MIN_DISTANCE_MULT, MAX_DISTANCE_MULT)
      cam.radius = fitRadius * distMult
    }
    syncControls()
    scheduleOutputPreview()
  })
  zoomValue.addEventListener('change', () => {
    if (runtimePreviewMode) {
      iconScale = clamp(Number(zoomValue.value) || 1, MIN_ICON_SCALE, MAX_ICON_SCALE)
    } else {
      distMult = clamp(Number(zoomValue.value) || DEFAULT_THUMB_DISTANCE_MULT, MIN_DISTANCE_MULT, MAX_DISTANCE_MULT)
      cam.radius = fitRadius * distMult
    }
    syncControls()
    scheduleOutputPreview()
  })
  modelYawSlider.addEventListener('input', () => {
    rotationY = wrapRadians((Number(modelYawSlider.value) || 0) * DEG_TO_RAD)
    applyYaw()
    refitCamera()
    syncControls()
    scheduleOutputPreview()
  })
  modelYawValue.addEventListener('change', () => {
    rotationY = wrapRadians((Number(modelYawValue.value) || 0) * DEG_TO_RAD)
    applyYaw()
    refitCamera()
    syncControls()
    scheduleOutputPreview()
  })
  modelPitchSlider.addEventListener('input', () => {
    rotationX = wrapRadians((Number(modelPitchSlider.value) || 0) * DEG_TO_RAD)
    applyYaw()
    refitCamera()
    syncControls()
    scheduleOutputPreview()
  })
  modelPitchValue.addEventListener('change', () => {
    rotationX = wrapRadians((Number(modelPitchValue.value) || 0) * DEG_TO_RAD)
    applyYaw()
    refitCamera()
    syncControls()
    scheduleOutputPreview()
  })
  modelRollSlider.addEventListener('input', () => {
    rotationZ = wrapRadians((Number(modelRollSlider.value) || 0) * DEG_TO_RAD)
    applyYaw()
    refitCamera()
    syncControls()
    scheduleOutputPreview()
  })
  modelRollValue.addEventListener('change', () => {
    rotationZ = wrapRadians((Number(modelRollValue.value) || 0) * DEG_TO_RAD)
    applyYaw()
    refitCamera()
    syncControls()
    scheduleOutputPreview()
  })
  resetBtn.addEventListener('click', () => {
    cam.alpha = DEFAULT_THUMB_ALPHA
    cam.beta = DEFAULT_THUMB_BETA
    distMult = DEFAULT_THUMB_DISTANCE_MULT
    iconScale = 1
    rotationX = 0
    rotationY = 0
    rotationZ = 0
    cam.radius = fitRadius
    applyYaw()
    refitCamera()
    syncControls()
    scheduleOutputPreview()
  })
  cancelBtn.addEventListener('click', close)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })

  const saveOverride = async (entry: AssetThumbnailOverride, isDelete = false): Promise<void> => {
    const activeBtn = isDelete ? deleteBtn : saveBtn
    activeBtn.disabled = true
    activeBtn.textContent = isDelete ? 'Deleting…' : 'Saving…'
    try {
      const res = await fetch('/api/dev/thumbnail-override', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: options.targetType,
          key: options.key,
          alpha: entry.alpha,
          beta: entry.beta,
          distanceMult: entry.distanceMult,
          rotationX: entry.rotationX,
          rotationY: entry.rotationY,
          rotationZ: entry.rotationZ,
          iconScale: entry.iconScale,
        }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>')
        console.warn('[ThumbnailRotationEditor] save failed', res.status, text)
        activeBtn.textContent = isDelete ? 'Delete failed' : 'Save failed'
        activeBtn.disabled = false
        return
      }
      invalidateOverridesCache()
      if (options.targetType === 'asset') await clearCachedThumb(options.modelPath)
      await options.onSaved()
      close()
    } catch (err) {
      console.warn('[ThumbnailRotationEditor] save error', err)
      activeBtn.textContent = isDelete ? 'Delete failed' : 'Save failed'
      activeBtn.disabled = false
    }
  }

  deleteBtn.addEventListener('click', () => {
    saveOverride({}, true)
  })

  saveBtn.addEventListener('click', async () => {
    if (runtimePreviewMode) {
      saveBtn.disabled = true
      saveBtn.textContent = 'Rendering…'
      await flushOutputPreview()
    }
    const entry = buildCurrentEntry()
    if (options.targetType === 'asset') delete entry.iconScale
    await saveOverride(entry)
  })
}
