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
  invalidateOverridesCache,
  setupThumbnailLights,
  splitEncodedGlbUrl,
} from './ThumbnailRenderer'
import { clearCachedThumb } from './ThumbnailCache'

const MODAL_SIZE = 320

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
  const backdrop = document.createElement('div')
  backdrop.className = 'asset-rotate-modal'
  const inner = document.createElement('div')
  inner.className = 'asset-rotate-modal-inner'
  backdrop.appendChild(inner)

  const title = document.createElement('div')
  title.textContent = path
  title.style.opacity = '0.7'
  title.style.fontSize = '11px'
  title.style.wordBreak = 'break-all'
  inner.appendChild(title)

  const canvas = document.createElement('canvas')
  canvas.className = 'asset-rotate-modal-canvas'
  canvas.width = MODAL_SIZE
  canvas.height = MODAL_SIZE
  inner.appendChild(canvas)

  const hint = document.createElement('div')
  hint.textContent = 'Drag to rotate · scroll to zoom · Esc to cancel'
  hint.style.opacity = '0.5'
  inner.appendChild(hint)

  const buttons = document.createElement('div')
  buttons.className = 'asset-rotate-modal-row'
  const resetBtn = document.createElement('button')
  resetBtn.className = 'asset-rotate-modal-btn secondary'
  resetBtn.textContent = 'Reset'
  const cancelBtn = document.createElement('button')
  cancelBtn.className = 'asset-rotate-modal-btn secondary'
  cancelBtn.textContent = 'Cancel'
  const saveBtn = document.createElement('button')
  saveBtn.className = 'asset-rotate-modal-btn'
  saveBtn.textContent = 'Save'
  buttons.appendChild(resetBtn)
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
    const { dir, file } = splitEncodedGlbUrl(path)
    importResult = await SceneLoader.ImportMeshAsync('', dir, file, scene)
    if (closed) {
      disposeImportResult(importResult)
      return
    }
    for (const ag of importResult.animationGroups || []) ag.stop()
    const fit = computeFitTarget(importResult, cam.fov)
    if (fit) {
      cam.setTarget(fit.center)
      fitRadius = fit.fitRadius
    }
  } catch (err) {
    console.warn('[ThumbnailRotationEditor] load failed for', path, err)
    if (closed) return
  }

  const initial = await getAssetOverride(path)
  if (closed) return
  let distMult = initial.distanceMult ?? 1
  cam.alpha = initial.alpha ?? DEFAULT_THUMB_ALPHA
  cam.beta = initial.beta ?? DEFAULT_THUMB_BETA
  cam.radius = fitRadius * distMult

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

  resetBtn.addEventListener('click', () => {
    cam.alpha = DEFAULT_THUMB_ALPHA
    cam.beta = DEFAULT_THUMB_BETA
    distMult = 1
    cam.radius = fitRadius
  })
  cancelBtn.addEventListener('click', close)
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close() })

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true
    saveBtn.textContent = 'Saving…'
    try {
      const res = await fetch('/api/dev/thumbnail-asset-rotation', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path, alpha: cam.alpha, beta: cam.beta, distanceMult: distMult }),
      })
      if (!res.ok) {
        const text = await res.text().catch(() => '<unreadable>')
        console.warn('[ThumbnailRotationEditor] save failed', res.status, text)
        saveBtn.textContent = 'Save failed'
        saveBtn.disabled = false
        return
      }
      invalidateOverridesCache()
      await clearCachedThumb(path)
      onSaved()
      close()
    } catch (err) {
      console.warn('[ThumbnailRotationEditor] save error', err)
      saveBtn.textContent = 'Save failed'
      saveBtn.disabled = false
    }
  })
}
