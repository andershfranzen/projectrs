import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { Color4 } from '@babylonjs/core/Maths/math.color'
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
import type { ISceneLoaderAsyncResult } from '@babylonjs/core/Loading/sceneLoader'
import '@babylonjs/loaders/glTF'
import {
  DEFAULT_THUMB_ALPHA,
  DEFAULT_THUMB_BETA,
  computeFitTarget,
  createThumbnailCamera,
  disposeImportResult,
  getAssetOverride,
  getItemOverride,
  invalidateOverridesCache,
  setupThumbnailLights,
  splitEncodedGlbUrl,
  type AssetThumbnailOverride,
} from './ThumbnailRenderer'
import { clearCachedThumb } from './ThumbnailCache'

const MODAL_SIZE = 320

export interface ThumbnailPoseEditorOptions {
  targetType: 'asset' | 'item'
  key: string | number
  modelPath: string
  title: string
  subtitle?: string
  bakedWarning?: string
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
  const backdrop = document.createElement('div')
  backdrop.className = 'asset-rotate-modal'
  const inner = document.createElement('div')
  inner.className = 'asset-rotate-modal-inner'
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

  const hint = document.createElement('div')
  hint.textContent = 'Drag camera · scroll zoom · adjust model yaw if the export faces the wrong way'
  hint.style.opacity = '0.5'
  inner.appendChild(hint)

  const yawRow = document.createElement('div')
  yawRow.className = 'asset-rotate-modal-control'
  const yawLabel = document.createElement('label')
  yawLabel.textContent = 'Model yaw'
  const yawSlider = document.createElement('input')
  yawSlider.type = 'range'
  yawSlider.min = String(-Math.PI)
  yawSlider.max = String(Math.PI)
  yawSlider.step = '0.01'
  const yawValue = document.createElement('span')
  yawValue.className = 'asset-rotate-modal-value'
  yawRow.appendChild(yawLabel)
  yawRow.appendChild(yawSlider)
  yawRow.appendChild(yawValue)
  inner.appendChild(yawRow)

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

  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, antialias: true })
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true
  scene.clearColor = new Color4(0.07, 0.08, 0.09, 1)
  setupThumbnailLights(scene, 'rot')
  const cam = createThumbnailCamera(scene, 'rot-cam')

  // Closed-flag is the race guard: if the user cancels DURING the async
  // ImportMeshAsync await below, close() runs and disposes the scene before
  // we get a chance to wire the render loop / camera framing. The flag lets
  // the post-await code bail out cleanly instead of touching disposed objects.
  let closed = false
  let importResult: ISceneLoaderAsyncResult | null = null
  let fitRadius = 10
  let modelRoot: any = null
  let baseRootYaw = 0
  let rotationY = 0

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKeyDown)

  const close = (): void => {
    if (closed) return
    closed = true
    document.removeEventListener('keydown', onKeyDown)
    engine.stopRenderLoop()
    if (importResult) disposeImportResult(importResult)
    try { scene.dispose() } catch { /* ignore */ }
    try { engine.dispose() } catch { /* ignore */ }
    try { document.body.removeChild(backdrop) } catch { /* ignore */ }
  }

  try {
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
      baseRootYaw = modelRoot.rotation.y || 0
    }
    const fit = computeFitTarget(importResult, cam.fov)
    if (fit) {
      cam.setTarget(fit.center)
      fitRadius = fit.fitRadius
    }
  } catch (err) {
    console.warn('[ThumbnailRotationEditor] load failed for', options.modelPath, err)
    if (closed) return
  }

  const initial = options.targetType === 'item'
    ? await getItemOverride(Number(options.key))
    : await getAssetOverride(String(options.key))
  if (closed) return
  let distMult = initial.distanceMult ?? 1
  cam.alpha = initial.alpha ?? DEFAULT_THUMB_ALPHA
  cam.beta = initial.beta ?? DEFAULT_THUMB_BETA
  rotationY = initial.rotationY ?? 0
  yawSlider.value = String(rotationY)
  cam.radius = fitRadius * distMult

  const updateYawLabel = (): void => {
    yawValue.textContent = `${Math.round(rotationY * 180 / Math.PI)}°`
  }
  const applyYaw = (): void => {
    if (!modelRoot) return
    modelRoot.rotation.y = baseRootYaw + rotationY
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
  updateYawLabel()

  engine.runRenderLoop(() => scene.render())

  let dragging = false
  let lastX = 0, lastY = 0
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true
    lastX = e.clientX
    lastY = e.clientY
    canvas.setPointerCapture(e.pointerId)
  })
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return
    const dx = e.clientX - lastX
    const dy = e.clientY - lastY
    lastX = e.clientX
    lastY = e.clientY
    cam.alpha -= dx * 0.01
    cam.beta = Math.min(Math.PI - 0.05, Math.max(0.05, cam.beta - dy * 0.01))
  })
  canvas.addEventListener('pointerup', (e) => {
    dragging = false
    try { canvas.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  })
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault()
    const factor = e.deltaY > 0 ? 1.08 : 1 / 1.08
    distMult = Math.min(5, Math.max(0.1, distMult * factor))
    cam.radius = fitRadius * distMult
  }, { passive: false })

  yawSlider.addEventListener('input', () => {
    rotationY = Number(yawSlider.value) || 0
    applyYaw()
    refitCamera()
    updateYawLabel()
  })
  resetBtn.addEventListener('click', () => {
    cam.alpha = DEFAULT_THUMB_ALPHA
    cam.beta = DEFAULT_THUMB_BETA
    distMult = 1
    rotationY = 0
    yawSlider.value = '0'
    cam.radius = fitRadius
    applyYaw()
    refitCamera()
    updateYawLabel()
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
          rotationY: entry.rotationY,
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
      await clearCachedThumb(options.modelPath)
      options.onSaved()
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
    await saveOverride({ alpha: cam.alpha, beta: cam.beta, distanceMult: distMult, rotationY })
  })
}
