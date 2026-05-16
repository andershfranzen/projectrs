import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { Mesh } from '@babylonjs/core/Meshes/mesh'
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData'
import { MeshBuilder } from '@babylonjs/core/Meshes/meshBuilder'
import { TransformNode } from '@babylonjs/core/Meshes/transformNode'
import { Vector3, Matrix, Quaternion } from '@babylonjs/core/Maths/math.vector'
import { Color3, Color4 } from '@babylonjs/core/Maths/math.color'
import { Texture } from '@babylonjs/core/Materials/Textures/texture'
import { ImageProcessingConfiguration } from '@babylonjs/core/Materials/imageProcessingConfiguration'
import '@babylonjs/core/Culling/ray'
import '@babylonjs/core/Shaders/color.vertex'
import '@babylonjs/core/Shaders/color.fragment'
import '@babylonjs/core/Shaders/rgbdDecode.fragment'
import '@babylonjs/core/Shaders/postprocess.vertex'
import '@babylonjs/core/Shaders/default.vertex'
import '@babylonjs/core/Shaders/default.fragment'
import '@babylonjs/core/Shaders/pbr.vertex'
import '@babylonjs/core/Shaders/pbr.fragment'
import '@babylonjs/loaders/glTF'

import { MapData } from './map/MapData'
import { ToolMode, toolLabel } from './editor/Tools'
import {
  DEFAULT_APPEARANCE,
  HAIR_STYLE_COUNT,
  SHIRT_COLORS,
  PANTS_COLORS,
  SHOES_COLORS,
  BELT_COLORS,
  SKIN_COLORS,
  HAIR_COLORS,
  CHARACTER_MODEL_PATH,
  CHARACTER_TARGET_HEIGHT,
  CHARACTER_IDLE_ANIM,
  computeCutPolygons,
  fanTriangulate,
  bilerpCorners,
  normalizeCutAngle,
  cutSideOf,
  transformOverlayUV,
  fullTileRingForSplit,
  CUT_SNAP_ANGLES,
  CUT_SNAP_TOLERANCE_RAD,
  getObjectInteractionTiles,
  localSidesToWorldSides,
  localAdjacentTilesOrdered,
  ASSET_TO_OBJECT_DEF,
} from '@projectrs/shared'
// Reused from the client package via vite alias (editor/vite.config.js).
// CharacterEntity loads the rigged character GLB and exposes applyAppearance —
// exactly what we need for the editor's per-spawn preview. The GLB + idle anim
// are served from editor/public/Character models (symlinked to client's copy).
import { CharacterEntity } from '@client/rendering/CharacterEntity'
import { loadAssetRegistry } from './assets-system/AssetRegistry'
import { loadAssetModel, cloneAssetModelSync, warmAssetCache, makeGhostMaterial, initAssetLoader } from './assets-system/AssetLoader'
import { getThumbnail } from './assets-system/ThumbnailRenderer'
import { openThumbnailRotationEditor } from './assets-system/ThumbnailRotationEditor'
import { loadTextureRegistry } from './assets-system/TextureRegistry'
import {
  buildTerrainMeshes,
  buildCliffMeshes,
  buildWaterMeshes,
  buildTextureOverlays,
  buildTexturePlanes,
  buildSingleTexturePlane,
  updateTerrainLandHeights,
  getOrCreateOverlayMaterial,
} from './map/TerrainMesh.ts'

export function createEditorScene(container) {
  // --- Babylon.js engine & scene setup ---
  const canvas = document.createElement('canvas')
  canvas.style.position = 'absolute'
  canvas.style.inset = '0'
  canvas.style.width = '100%'
  canvas.style.height = '100%'
  canvas.style.zIndex = '0'
  container.appendChild(canvas)

  const engine = new Engine(canvas, true, { antialias: true })
  const scene = new Scene(engine)
  scene.useRightHandedSystem = true

  // Prevent Babylon from consuming pointer events — we handle input manually
  scene.preventDefaultOnPointerDown = false
  scene.preventDefaultOnPointerUp = false

  scene.clearColor = new Color4(0.4, 0.6, 0.9, 1.0) // sky blue (matches game overworld)
  scene.fogMode = Scene.FOGMODE_LINEAR
  scene.fogColor = new Color3(0.4, 0.6, 0.9)
  scene.fogStart = 80
  scene.fogEnd = 200

  // Lighting — identical to GameManager.ts so the editor matches the game
  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene)
  ambient.intensity = 0.9
  ambient.diffuse = new Color3(0.54, 0.54, 0.54)
  ambient.groundColor = new Color3(0.35, 0.33, 0.30)
  ambient.specular = new Color3(0, 0, 0)

  const sun = new DirectionalLight('sun', new Vector3(-0.5, -1, -0.3), scene)
  sun.intensity = 1.1
  sun.diffuse = new Color3(1.0, 0.84, 0.54)

  const fill = new DirectionalLight('fill', new Vector3(0.3, -0.6, 0.5), scene)
  fill.intensity = 0.65
  fill.diffuse = new Color3(0.67, 0.73, 0.80)

  // Initialize asset loader with scene reference
  initAssetLoader(scene)

function tuneModelLighting(model) {
  // Match the game client: keep PBR materials as-is, just fix backface culling
  // and transparency mode. PBR works fine with hemispheric + directional lights.
  const meshes = model.getChildMeshes ? model.getChildMeshes() : []
  for (const child of meshes) {
    const mat = child.material
    if (!mat) continue
    mat.backFaceCulling = false
    if (mat.transparencyMode !== undefined) mat.transparencyMode = 1 // ALPHATEST
    mat.alpha = 1
  }
}

  // Camera — manual orbit (we clear built-in inputs and detach from canvas)
  const camera = new ArcRotateCamera('editorCam', 0.78, 1.02, 31, new Vector3(12, 2, 12), scene)
  camera.fov = 55 * Math.PI / 180
  camera.minZ = 0.1
  camera.maxZ = 1000
  camera.inputs.clear() // We handle camera manually
  camera.detachControl() // Don't let Babylon.js attach any pointer handlers

  // Water texture
  const waterTexture = new Texture('/assets/textures/1.png', scene, false, true, Texture.NEAREST_LINEAR_MIPLINEAR)
  waterTexture.anisotropicFilteringLevel = 1
  waterTexture.wrapU = Texture.WRAP_ADDRESSMODE
  waterTexture.wrapV = Texture.WRAP_ADDRESSMODE

  // Babylon.js animations auto-update — no mixer management needed
  // We keep a simple set of animation groups for cleanup
  const _animGroups = new Map() // model -> AnimationGroup[]

  function setupModelAnimations(model, path) {
    // Babylon.js GLB animations auto-play from loadAssetModel
    // Nothing to do here — animations are already running
  }

  function disposeMixer(model) {
    const groups = _animGroups.get(model)
    if (groups) {
      for (const ag of groups) { ag.stop(); ag.dispose() }
      _animGroups.delete(model)
    }
  }

  // Ensure Babylon.js nodes have .scale alias for .scaling and .userData
  function ensureNodeCompat(node) {
    if (!node.userData) node.userData = {}
    if (!node.scale && node.scaling) {
      Object.defineProperty(node, 'scale', { get() { return this.scaling }, set(v) { this.scaling.copyFrom(v) } })
    }
  }

  function addPlacedModel(model) {
    ensureNodeCompat(model)
    model.parent = placedGroup
    _spatialRegister(model)
    invalidateShadowCache()
    const asset = assetRegistry.find((a) => a.id === model.userData.assetId)
    if (asset) setupModelAnimations(model, asset.path)
  }

  function removePlacedModel(model) {
    _spatialUnregister(model)
    invalidateShadowCache()
    disposeMixer(model)
    model.dispose()
  }

  function clearPlacedModels() {
    for (const model of placedGroup.getChildren()) disposeMixer(model)
    _spatialGrid.clear()
    invalidateShadowCache()
    for (const child of [...placedGroup.getChildren()]) child.dispose()
  }

  let map = new MapData(64, 64)
  const placedGroup = new TransformNode('placedGroup', scene)

  // Placements whose assetId didn't resolve in the registry. Preserved verbatim
  // so save/load round-trips and a later re-added asset brings them back.
  let _orphanPlacements = []

  function reportMissingAssets(missing, context) {
    if (missing.size === 0) return
    const ids = [...missing.keys()]
    const total = [...missing.values()].reduce((a, b) => a + b, 0)
    const sample = ids.slice(0, 5).join(', ') + (ids.length > 5 ? `, +${ids.length - 5} more` : '')
    console.warn(`[${context}] ${total} placed object(s) preserved as orphans — unknown assetIds: ${sample}`)
    try { statusText.textContent = `⚠ ${total} placement(s) preserved as orphans (unknown assets: ${sample})` } catch {}
  }

  let assetRegistry = []
  let filteredAssets = []
  let selectedAssetId = ''
  let previewObject = null
  let previewRotation = { x: 0, y: 0, z: 0 }
  let previewScale = 1.0
  let hoverEdgeHelper = null

  let assetSectionFilter = 'all'
  let assetGroupFilter = 'all'
  let assetGroupsForCurrentSection = []

  let textureRegistry = []
  let filteredTextures = []
  const textureCache = new Map()
  const textureMeta = new Map()
  let selectedTextureId = null
  let paintTabTextureId = null   // texture selected in the paint tab (null = none, '__erase__' = erase)
  let paintTabTextureIdB = null  // secondary texture for slot B (half paint second triangle)
  let paintTextureSlot = 'A'     // which slot is active for palette selection
  let textureRotation = 0
  let textureScale = 1
  let textureWorldUV = false
  let paintTextureScale = 1

  let layers = [{ id: 'layer_0', name: 'Layer 1', visible: true }]
  let activeLayerId = 'layer_0'
  let _layerCount = 1
  let shiftPanMode = localStorage.getItem('editor_shiftPanMode') === 'true'

  let selectedPlacedObject = null
  let selectedPlacedObjects = []
  let selectedTexturePlane = null
  let selectedTexturePlanes = []
  let selectionHelper = null
  let saveFileHandle = null

  let isDragSelecting = false
  let dragSelectStart = null

  let transformMode = null
  let transformAxis = 'all'
  let lastRotateAxis = 'all'
  let transformStart = null
  let transformLift = 0
  let movePlaneStart = null

  let terrainGroup = null
  let cliffs = null
  let splitLines = null
  let tileGrid = null
  let textureOverlayGroup = null
  let texturePlaneGroup = null

  let texturePlaneVertical = true

  // --- NPC Spawn system ---
  let npcDefs = []           // loaded from /data/npcs.json
  let npcSpawns = []         // { id, npcId, x, z, wanderRange }
  let _npcSpawnNextId = 1
  let selectedNpcSpawn = null
  const npcSpawnGroup = new TransformNode('npcSpawnGroup', scene)

  // Per-spawn override fields and the predicates that decide whether they get
  // emitted on save. Single source of truth for both addNpcSpawn and
  // serializeNpcSpawns — adding a new override here is the ONLY change needed
  // for it to round-trip through load → in-memory → save. Matches the
  // SpawnEntry shape in shared/types.ts.
  const NPC_SPAWN_OVERRIDE_FIELDS = {
    aggressive: v => v === true || v === false,
    appearance: v => !!v,
    equipment:  v => Array.isArray(v) && v.length === 10,
    shop:       v => !!v,
    dialogue:   v => !!v,
    name:       v => !!v,
  }

  function addNpcSpawn(input) {
    const { npcId, x, z, wanderRange, id } = input
    // `aggressive` is always present on the in-memory spawn (possibly null)
    // because some UI code reads it without a `in spawn` guard.
    const spawn = { id: id || _npcSpawnNextId++, npcId, x, z, wanderRange, aggressive: input.aggressive ?? null }
    // Other override fields: only set if truthy so a fresh spawn doesn't carry
    // empty values that would falsely flag the override toggles.
    for (const field of Object.keys(NPC_SPAWN_OVERRIDE_FIELDS)) {
      if (field === 'aggressive') continue
      if (input[field]) spawn[field] = input[field]
    }
    if (id && id >= _npcSpawnNextId) _npcSpawnNextId = id + 1
    npcSpawns.push(spawn)
    return spawn
  }

  function removeNpcSpawn(spawn) {
    const idx = npcSpawns.indexOf(spawn)
    if (idx >= 0) npcSpawns.splice(idx, 1)
    if (selectedNpcSpawn === spawn) selectedNpcSpawn = null
    disposeNpcPreview(spawn)
  }

  // --- Per-spawn 3D character preview ---
  // Keyed by spawn.id so previews survive the cylinder rebuilds in
  // rebuildNpcSpawnMeshes (loading the rigged GLB is ~3s; we don't want to
  // recreate on every selection change). Only spawns with an explicit
  // appearance override get a preview; everything else stays as a cylinder.
  // hiddenNodes tracks placed objects we toggled off so the preview is
  // visually unobstructed — restored when the preview is disposed.
  const npcPreviews = new Map()  // spawn.id → { entity, hiddenNodes: Set<TransformNode> }

  /** Tiles within this XZ-distance of the spawn get their placed objects
   *  hidden so the preview character isn't covered by the previously-placed
   *  NPC GLB. 0.7 catches anything centered on the same tile without
   *  hiding adjacent scenery. */
  const PLACED_OBJECT_HIDE_RADIUS = 0.7

  function maskPlacedObjectsForPreview(spawn, entry) {
    // Re-enable previously hidden objects first so a moved spawn doesn't
    // leave the old set hidden forever.
    restorePlacedObjectsFromPreview(entry)
    for (const node of placedGroup.getChildren()) {
      const dx = node.position.x - spawn.x
      const dz = node.position.z - spawn.z
      if (Math.abs(dx) <= PLACED_OBJECT_HIDE_RADIUS && Math.abs(dz) <= PLACED_OBJECT_HIDE_RADIUS) {
        if (node.isEnabled()) {
          entry.hiddenNodes.add(node)
          node.setEnabled(false)
        }
      }
    }
  }

  function restorePlacedObjectsFromPreview(entry) {
    for (const node of entry.hiddenNodes) {
      // Node may have been disposed (e.g. rebuildPlacedObjectsFromData). Babylon
      // sets isDisposed() on disposed nodes; skip those.
      if (!node.isDisposed || !node.isDisposed()) {
        try { node.setEnabled(true) } catch { /* node gone */ }
      }
    }
    entry.hiddenNodes.clear()
  }

  // Dev-only console hooks. Tree-shaken Babylon imports remove the global
  // BABYLON namespace, so without these the only way to inspect the scene
  // from devtools is to hack imports. Stripped from production builds.
  if (import.meta.env.DEV) {
    window._editorScene = scene
    window._editorCamera = camera
    window._editorNpcPreviews = npcPreviews
  }

  function ensureNpcPreview(spawn) {
    if (!spawn || !spawn.appearance) {
      disposeNpcPreview(spawn)
      return
    }
    let entry = npcPreviews.get(spawn.id)
    if (!entry) {
      const entity = new CharacterEntity(scene, {
        name: `npcPreview_${spawn.id}`,
        modelPath: CHARACTER_MODEL_PATH,
        targetHeight: CHARACTER_TARGET_HEIGHT,
        additionalAnimations: [
          { name: 'idle', path: CHARACTER_IDLE_ANIM },
        ],
      })
      entry = { entity, hiddenNodes: new Set() }
      npcPreviews.set(spawn.id, entry)
    }
    const y = map.getAverageTileHeight(Math.floor(spawn.x), Math.floor(spawn.z))
    entry.entity.setPositionXYZ(spawn.x, y, spawn.z)
    maskPlacedObjectsForPreview(spawn, entry)
    // applyAppearance idempotently re-derives material colors + hair mesh
    // visibility from the appearance struct; safe to call on every edit.
    entry.entity.whenReady().then(() => {
      if (npcPreviews.get(spawn.id) === entry) {
        entry.entity.applyAppearance(spawn.appearance)
      }
    })
  }

  function disposeNpcPreview(spawn) {
    const entry = npcPreviews.get(spawn.id)
    if (entry) {
      restorePlacedObjectsFromPreview(entry)
      entry.entity.dispose()
      npcPreviews.delete(spawn.id)
    }
  }

  function disposeAllNpcPreviews() {
    for (const [, entry] of npcPreviews) {
      restorePlacedObjectsFromPreview(entry)
      entry.entity.dispose()
    }
    npcPreviews.clear()
  }

  /** Re-hide overlapping placed objects after the placedGroup has been
   *  rebuilt. The previous TransformNode refs in hiddenNodes are now stale
   *  (disposed); maskPlacedObjectsForPreview discards them and re-scans. */
  function refreshNpcPreviewMasks() {
    for (const [id, entry] of npcPreviews) {
      const spawn = npcSpawns.find(s => s.id === id)
      if (spawn) maskPlacedObjectsForPreview(spawn, entry)
    }
  }

  function serializeNpcSpawns() {
    return npcSpawns.map(s => {
      const out = { id: s.id, npcId: s.npcId, x: s.x, z: s.z, wanderRange: s.wanderRange }
      for (const [field, accept] of Object.entries(NPC_SPAWN_OVERRIDE_FIELDS)) {
        if (accept(s[field])) out[field] = s[field]
      }
      return out
    })
  }

  function loadNpcSpawns(data) {
    // Previews from the previous map are tied to its spawn ids — wipe them
    // before importing new spawns so we don't leak GLB instances when the
    // editor switches maps.
    disposeAllNpcPreviews()
    npcSpawns = []
    _npcSpawnNextId = 1
    selectedNpcSpawn = null
    for (const s of data || []) {
      // Spread is intentional — any new field in SpawnEntry / on disk flows
      // straight through to the in-memory spawn without code changes here.
      // addNpcSpawn applies the override-field whitelist.
      addNpcSpawn({ ...s, wanderRange: s.wanderRange ?? 3 })
    }
    rebuildNpcSpawnMeshes()
    refreshNpcSpawnList()
  }

  function rebuildNpcSpawnMeshes() {
    // Dispose all children
    for (const child of [...npcSpawnGroup.getChildren()]) child.dispose()

    // Sync previews against the current spawns: drop entries whose spawn no
    // longer exists; keep + reposition entries whose spawn does. Skipping the
    // full dispose preserves the already-loaded GLB instances.
    const liveIds = new Set(npcSpawns.map(s => s.id))
    for (const id of [...npcPreviews.keys()]) {
      if (!liveIds.has(id)) {
        npcPreviews.get(id).dispose()
        npcPreviews.delete(id)
      }
    }
    for (const spawn of npcSpawns) {
      if (spawn.appearance) ensureNpcPreview(spawn)
    }

    for (const spawn of npcSpawns) {
      const def = npcDefs.find(d => d.id === spawn.npcId)
      const isSelected = spawn === selectedNpcSpawn
      const aggressive = def?.aggressive
      const y = map.getAverageTileHeight(Math.floor(spawn.x), Math.floor(spawn.z))
      const color = isSelected ? new Color3(1, 1, 0.2) : (aggressive ? new Color3(0.9, 0.2, 0.15) : new Color3(0.15, 0.7, 0.9))

      // Spawns with an appearance override render a full character preview
      // (ensureNpcPreview above) — the cylinder + top sphere would clip
      // through it and hide the body the user is trying to design. For those
      // we drop a thin ground disc as the selection affordance instead.
      // Spawns without appearance still get the full marker so they stay
      // visible from a distance.
      if (spawn.appearance) {
        const disc = MeshBuilder.CreateDisc(`npcSpawnDisc_${spawn.id}`, { radius: 0.45, tessellation: 24 }, scene)
        const discMat = new StandardMaterial(`npcSpawnDiscMat_${spawn.id}`, scene)
        discMat.diffuseColor = color
        discMat.emissiveColor = color.scale(0.6)
        discMat.specularColor = new Color3(0, 0, 0)
        discMat.backFaceCulling = false
        disc.material = discMat
        disc.rotation.x = Math.PI / 2
        disc.position = new Vector3(spawn.x, y + 0.02, spawn.z)
        disc.metadata = { npcSpawn: spawn }
        disc.parent = npcSpawnGroup
      } else {
        // Cylinder + top dot — visible from far away for sprite/non-customizable NPCs.
        const marker = MeshBuilder.CreateCylinder(`npcSpawn_${spawn.id}`, { height: 1.2, diameterTop: 0.3, diameterBottom: 0.5, tessellation: 8 }, scene)
        const markerMat = new StandardMaterial(`npcSpawnMat_${spawn.id}`, scene)
        markerMat.diffuseColor = color
        markerMat.emissiveColor = color.scale(0.4)
        markerMat.specularColor = new Color3(0, 0, 0)
        marker.material = markerMat
        marker.position = new Vector3(spawn.x, y + 0.6, spawn.z)
        marker.metadata = { npcSpawn: spawn }
        marker.parent = npcSpawnGroup

        const dot = MeshBuilder.CreateSphere(`npcDot_${spawn.id}`, { diameter: 0.25, segments: 6 }, scene)
        const dotMat = new StandardMaterial(`npcDotMat_${spawn.id}`, scene)
        dotMat.diffuseColor = new Color3(1, 1, 1)
        dotMat.emissiveColor = isSelected ? new Color3(1, 1, 0.3) : new Color3(0.8, 0.8, 0.8)
        dotMat.specularColor = new Color3(0, 0, 0)
        dot.material = dotMat
        dot.position = new Vector3(spawn.x, y + 1.35, spawn.z)
        dot.metadata = { npcSpawn: spawn }
        dot.parent = npcSpawnGroup
      }

      // Wander range circle — same for both marker styles. Visible on the
      // ground next to the preview so designers can still tune wander range
      // visually without the cylinder.
      if (spawn.wanderRange > 0) {
        const segments = 32
        const points = []
        for (let i = 0; i <= segments; i++) {
          const angle = (i / segments) * Math.PI * 2
          points.push(new Vector3(
            spawn.x + Math.cos(angle) * spawn.wanderRange,
            y + 0.08,
            spawn.z + Math.sin(angle) * spawn.wanderRange
          ))
        }
        const circle = MeshBuilder.CreateLines(`npcWander_${spawn.id}`, { points }, scene)
        circle.color = isSelected ? new Color3(1, 1, 0.3) : (aggressive ? new Color3(0.9, 0.3, 0.2) : new Color3(0.2, 0.6, 0.8))
        circle.alpha = isSelected ? 0.9 : 0.5
        circle.parent = npcSpawnGroup
      }
    }

    // Show/hide based on tool
    npcSpawnGroup.setEnabled(state.tool === ToolMode.NPC_SPAWN)
  }

  function refreshNpcSpawnList() {
    const listEl = sidebar.querySelector('#npcSpawnList')
    const countEl = sidebar.querySelector('#npcSpawnCount')
    if (!listEl) return
    if (countEl) countEl.textContent = npcSpawns.length

    listEl.innerHTML = ''
    for (const spawn of npcSpawns) {
      const def = npcDefs.find(d => d.id === spawn.npcId)
      // Per-spawn name takes precedence in the list so renamed NPCs are
      // easy to spot among generic ones.
      const name = spawn.name || def?.name || `NPC ${spawn.npcId}`
      const row = document.createElement('div')
      row.style.cssText = `display:flex;justify-content:space-between;align-items:center;padding:3px 5px;font-size:11px;cursor:pointer;border-radius:3px;margin-bottom:2px;${spawn === selectedNpcSpawn ? 'background:#1a4faf;' : 'background:#222;'}`
      row.innerHTML = `<span>${name} <span style="opacity:0.5;">(${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) r=${spawn.wanderRange}</span></span>`
      row.addEventListener('click', () => {
        selectedNpcSpawn = spawn
        // Type dropdown reflects the spawn's npcId; per-tab content is
        // redrawn so the inspector reflects whichever spawn was just selected.
        const sel = sidebar.querySelector('#npcTypeSelect')
        if (sel) sel.value = spawn.npcId
        if (typeof renderNpcInspector === 'function') renderNpcInspector()
        // Focus camera on spawn
        camera.target = new Vector3(spawn.x, map.getAverageTileHeight(Math.floor(spawn.x), Math.floor(spawn.z)), spawn.z)
        rebuildNpcSpawnMeshes()
        refreshNpcSpawnList()
        updateToolUI()
      })
      listEl.appendChild(row)
    }
  }

  function pickNpcSpawn(event) {
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(npcSpawnGroup) && mesh.metadata?.npcSpawn
    })
    if (!pick.hit) return null
    return pick.pickedMesh.metadata.npcSpawn
  }

  // --- Item Spawn system ---
  let itemSpawns = []         // { id, itemId, x, z, quantity }
  let _itemSpawnNextId = 1
  let itemDefs = []            // loaded from server
  const itemSpawnGroup = new TransformNode('itemSpawnGroup', scene)

  async function loadItemDefs() {
    try {
      const res = await fetch('/data/items.json')
      itemDefs = await res.json()
      const sel = sidebar.querySelector('#itemTypeSelect')
      if (sel) {
        sel.innerHTML = itemDefs.map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`).join('')
      }
    } catch (e) {
      console.warn('Failed to load item definitions:', e)
    }
  }
  loadItemDefs()

  function addItemSpawn(itemId, x, z, quantity = 1, id) {
    const spawn = { id: id || _itemSpawnNextId++, itemId, x, z, quantity }
    if (id && id >= _itemSpawnNextId) _itemSpawnNextId = id + 1
    itemSpawns.push(spawn)
    return spawn
  }

  function removeItemSpawn(spawn) {
    const idx = itemSpawns.indexOf(spawn)
    if (idx >= 0) itemSpawns.splice(idx, 1)
  }

  function serializeItemSpawns() {
    return itemSpawns.map(s => ({ id: s.id, itemId: s.itemId, x: s.x, z: s.z, quantity: s.quantity }))
  }

  function loadItemSpawns(data) {
    itemSpawns = []
    _itemSpawnNextId = 1
    for (const s of data || []) {
      addItemSpawn(s.itemId, s.x, s.z, s.quantity ?? 1, s.id)
    }
    rebuildItemSpawnMeshes()
    refreshItemSpawnList()
  }

  function rebuildItemSpawnMeshes() {
    for (const child of [...itemSpawnGroup.getChildren()]) child.dispose()
    for (const spawn of itemSpawns) {
      const def = itemDefs.find(d => d.id === spawn.itemId)
      const name = def?.name || `Item ${spawn.itemId}`
      const marker = MeshBuilder.CreateBox(`itemSpawn_${spawn.id}`, { width: 0.4, height: 0.3, depth: 0.4 }, scene)
      const mat = new StandardMaterial(`itemSpawnMat_${spawn.id}`, scene)
      mat.diffuseColor = new Color3(0.9, 0.75, 0.2)
      mat.emissiveColor = new Color3(0.4, 0.35, 0.1)
      mat.specularColor = new Color3(0, 0, 0)
      marker.material = mat
      const y = map.getAverageTileHeight(Math.floor(spawn.x), Math.floor(spawn.z))
      marker.position = new Vector3(spawn.x, y + 0.15, spawn.z)
      marker.metadata = { itemSpawn: spawn }
      marker.parent = itemSpawnGroup
    }
    itemSpawnGroup.setEnabled(state.tool === ToolMode.ITEM_SPAWN)
  }

  function refreshItemSpawnList() {
    const listEl = sidebar.querySelector('#itemSpawnList')
    const countEl = sidebar.querySelector('#itemSpawnCount')
    if (!listEl) return
    if (countEl) countEl.textContent = itemSpawns.length
    listEl.innerHTML = ''
    for (const spawn of itemSpawns) {
      const def = itemDefs.find(d => d.id === spawn.itemId)
      const name = def?.name || `Item ${spawn.itemId}`
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:3px 5px;font-size:11px;cursor:pointer;border-radius:3px;margin-bottom:2px;background:#222;'
      row.innerHTML = `<span>${name} <span style="opacity:0.5;">(${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)})</span></span>`
      row.addEventListener('click', () => {
        camera.target = new Vector3(spawn.x, map.getAverageTileHeight(Math.floor(spawn.x), Math.floor(spawn.z)), spawn.z)
      })
      listEl.appendChild(row)
    }
  }

  function pickItemSpawn(event) {
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(itemSpawnGroup) && mesh.metadata?.itemSpawn
    })
    if (!pick.hit) return null
    return pick.pickedMesh.metadata.itemSpawn
  }

  // --- Collision / Wall system ---
  // Stores wall edges, blocked tiles, floors, stairs per floor level
  const collisionData = {
    walls: {},        // "x,z" -> bitmask (N=1, E=2, S=4, W=8)
    wallHeights: {},  // "x,z" -> number
    floors: {},       // "x,z" -> number (elevated floor Y)
    stairs: {},       // "x,z" -> { direction, baseHeight, topHeight }
    floorLayers: {}   // floorNum -> { walls, wallHeights, floors, stairs }
  }
  let collisionMode = 'wall'  // 'wall' | 'block' | 'floor' | 'stair' | 'hole'
  let wallEraseMode = false
  let lockedWallEdge = 0  // locked edge direction during drag (0 = not locked)
  let wallLineStart = null  // {x, z, edge} for Ctrl+click line drawing
  let blockLineStart = null // {x, z} for Ctrl+click block line drawing
  let collisionFloor = 0
  let stairDirection = 'N'

  // Diagonal floor placement
  let diagFloorMode = false
  let diagFloorStart = null   // {x, z} world coords of first click
  let diagFloorWidth = 3      // perpendicular width in tiles
  let diagFloorPreview = null  // Babylon Mesh for ghost preview

  function snapAngle(angle, snapDeg = 45) {
    const snap = snapDeg * Math.PI / 180
    return Math.round(angle / snap) * snap
  }

  function disposeDiagFloorPreview() {
    if (diagFloorPreview) {
      diagFloorPreview.dispose()
      diagFloorPreview = null
    }
  }

  function cancelDiagFloor() {
    diagFloorStart = null
    disposeDiagFloorPreview()
  }
  const collisionGroup = new TransformNode('collisionGroup', scene)

  function getCollisionLayer() {
    if (collisionFloor === 0) return collisionData
    if (!collisionData.floorLayers[collisionFloor]) {
      collisionData.floorLayers[collisionFloor] = { walls: {}, wallHeights: {}, floors: {}, stairs: {}, holes: {} }
    }
    return collisionData.floorLayers[collisionFloor]
  }

  function getWallAt(x, z) {
    return getCollisionLayer().walls[`${x},${z}`] || 0
  }

  function setWallAt(x, z, bitmask) {
    const layer = getCollisionLayer()
    if (bitmask === 0) delete layer.walls[`${x},${z}`]
    else layer.walls[`${x},${z}`] = bitmask
  }

  function toggleWallEdge(x, z, edge) {
    const current = getWallAt(x, z)
    setWallAt(x, z, current ^ edge)
  }

  function setBlockedTile(x, z, blocked) {
    setWallAt(x, z, blocked ? 15 : 0) // 15 = all edges (N|E|S|W)
  }

  function setFloorAt(x, z, height) {
    const layer = getCollisionLayer()
    if (height == null) delete layer.floors[`${x},${z}`]
    else layer.floors[`${x},${z}`] = height
  }

  function setStairAt(x, z, data) {
    const layer = getCollisionLayer()
    if (!data) delete layer.stairs[`${x},${z}`]
    else layer.stairs[`${x},${z}`] = data
  }

  function setHoleAt(x, z, isHole) {
    const layer = getCollisionLayer()
    if (!layer.holes) layer.holes = {}
    if (!isHole) delete layer.holes[`${x},${z}`]
    else layer.holes[`${x},${z}`] = true
  }


  function serializeCollisionData() {
    return JSON.parse(JSON.stringify(collisionData))
  }

  function loadCollisionData(data) {
    collisionData.walls = data?.walls || {}
    collisionData.wallHeights = data?.wallHeights || {}
    collisionData.floors = data?.floors || {}
    collisionData.stairs = data?.stairs || {}
    collisionData.holes = data?.holes || {}
    collisionData.floorLayers = data?.floorLayers || {}
    rebuildCollisionMeshes()
  }

  // --- Biome painting (8x8 tile cells with fog overrides) ---

  const BIOME_CELL_SIZE = 1
  const biomeData = {
    defs: [],         // { id, name, fogColor:[r,g,b] 0-1, fogStart, fogEnd }
    cells: {}         // "cellX,cellZ" -> biome id
  }
  let nextBiomeId = 1
  let selectedBiomeId = null
  let editingBiomeId = null
  const biomeGroup = new TransformNode('biomeGroup', scene)
  // Hidden by default; updateToolUI() shows it only while the Biome tool is active.
  biomeGroup.setEnabled(false)
  let biomeOverlayMesh = null
  let biomeOverlayDirty = false
  // Drag-rectangle state: snapshot of cells at stroke start + start cell coords
  let biomeStrokeStart = null
  let biomeStrokeSnapshot = null
  let biomeStrokeId = null

  function serializeBiomesData() {
    return { defs: JSON.parse(JSON.stringify(biomeData.defs)), cells: { ...biomeData.cells } }
  }

  function loadBiomesData(data) {
    biomeData.defs = (data?.defs || []).map(d => ({ ...d, fogColor: [...d.fogColor] }))
    biomeData.cells = { ...(data?.cells || {}) }
    nextBiomeId = biomeData.defs.reduce((m, d) => Math.max(m, d.id), 0) + 1
    selectedBiomeId = biomeData.defs[0]?.id ?? null
    editingBiomeId = null
    biomeOverlayDirty = true
    rebuildBiomeOverlay()
    refreshBiomePalette()
  }

  function paintBiomeCell(cx, cz, id) {
    const key = `${cx},${cz}`
    if (id == null) {
      if (!(key in biomeData.cells)) return false
      delete biomeData.cells[key]
    } else {
      if (biomeData.cells[key] === id) return false
      biomeData.cells[key] = id
    }
    biomeOverlayDirty = true
    return true
  }

  function rebuildBiomeOverlay() {
    if (biomeOverlayMesh) {
      biomeOverlayMesh.dispose()
      biomeOverlayMesh = null
    }
    const entries = Object.entries(biomeData.cells)
    if (entries.length === 0) return

    // Build one translucent quad per painted cell, just above terrain so it's
    // visible from typical camera angles (not floating 50m in the sky).
    const positions = []
    const indices = []
    const colors = []
    const Y = 2
    let vi = 0
    for (const [key, id] of entries) {
      const def = biomeData.defs.find(d => d.id === id)
      if (!def) continue
      const [cx, cz] = key.split(',').map(Number)
      const x0 = cx * BIOME_CELL_SIZE
      const z0 = cz * BIOME_CELL_SIZE
      const x1 = x0 + BIOME_CELL_SIZE
      const z1 = z0 + BIOME_CELL_SIZE
      positions.push(x0, Y, z0, x1, Y, z0, x1, Y, z1, x0, Y, z1)
      indices.push(vi, vi + 1, vi + 2, vi, vi + 2, vi + 3)
      // Brighten the fog color for the overlay so dark biomes (e.g. Graveyard's
      // near-black purple) are still visible. Preserve hue, normalize so the
      // brightest channel is ~0.75.
      const [fr, fg, fb] = def.fogColor
      const maxChan = Math.max(fr, fg, fb, 0.01)
      const boost = 0.75 / maxChan
      const r = Math.min(1, fr * boost)
      const g = Math.min(1, fg * boost)
      const b = Math.min(1, fb * boost)
      for (let i = 0; i < 4; i++) colors.push(r, g, b, 0.85)
      vi += 4
    }
    if (positions.length === 0) return
    const mesh = new Mesh('biomeOverlay', scene)
    const vd = new VertexData()
    vd.positions = positions
    vd.indices = indices
    vd.colors = colors
    vd.applyToMesh(mesh, true)
    const mat = new StandardMaterial('biomeOverlayMat', scene)
    mat.emissiveColor = new Color3(1, 1, 1)
    mat.disableLighting = true
    mat.alpha = 0.85
    mat.backFaceCulling = false
    // Render on top so terrain doesn't occlude it
    mat.depthFunction = 519 // GL_ALWAYS — always pass depth test
    mesh.material = mat
    mesh.parent = biomeGroup
    mesh.isPickable = false
    biomeOverlayMesh = mesh
  }

  /** Get the best display height for collision visualization at a tile.
   *  Uses the highest of: terrain, floor height, or texture plane bridge height. */
  function getCollisionDisplayHeight(x, z) {
    let h = map.getAverageTileHeight(x, z)
    // Check if there's a floor at this tile (elevated platform)
    const layer = getCollisionLayer()
    const floorH = layer.floors?.[`${x},${z}`]
    if (floorH != null && floorH > h) h = floorH
    // Also check root floor (floor 0)
    const rootFloorH = collisionData.floors?.[`${x},${z}`]
    if (rootFloorH != null && rootFloorH > h) h = rootFloorH
    return h
  }

  function rebuildCollisionMeshes() {
    for (const child of [...collisionGroup.getChildren()]) child.dispose()

    const layer = getCollisionLayer()

    // Wall edge lines
    const wallLines = []
    for (const [key, bitmask] of Object.entries(layer.walls)) {
      const [x, z] = key.split(',').map(Number)
      const h = getCollisionDisplayHeight(x, z) + 0.15
      if (bitmask & 1) wallLines.push([new Vector3(x, h, z), new Vector3(x + 1, h, z)])           // N
      if (bitmask & 2) wallLines.push([new Vector3(x + 1, h, z), new Vector3(x + 1, h, z + 1)])   // E
      if (bitmask & 4) wallLines.push([new Vector3(x, h, z + 1), new Vector3(x + 1, h, z + 1)])   // S
      if (bitmask & 8) wallLines.push([new Vector3(x, h, z), new Vector3(x, h, z + 1)])           // W
    }
    if (wallLines.length > 0) {
      const lines = MeshBuilder.CreateLineSystem('collWalls', { lines: wallLines }, scene)
      lines.color = new Color3(1, 0.2, 0.2)
      lines.renderingGroupId = 3  // render on top of everything
      lines.parent = collisionGroup
    }

    // Floor tiles — flat quads
    for (const [key, height] of Object.entries(layer.floors || {})) {
      const [x, z] = key.split(',').map(Number)
      const plane = MeshBuilder.CreatePlane(`collFloor_${key}`, { size: 0.9 }, scene)
      plane.rotation.x = Math.PI / 2
      plane.position = new Vector3(x + 0.5, height + 0.05, z + 0.5)
      const mat = new StandardMaterial(`collFloorMat_${key}`, scene)
      mat.diffuseColor = new Color3(0.2, 0.5, 1)
      mat.emissiveColor = new Color3(0.1, 0.25, 0.5)
      mat.alpha = 0.4
      mat.specularColor = new Color3(0, 0, 0)
      mat.backFaceCulling = false
      plane.material = mat
      plane.renderingGroupId = 3
      plane.parent = collisionGroup
    }

    // Stairs — arrow indicators
    for (const [key, stair] of Object.entries(layer.stairs || {})) {
      const [x, z] = key.split(',').map(Number)
      const midH = (stair.baseHeight + stair.topHeight) / 2
      // Arrow line showing direction
      const cx = x + 0.5, cz = z + 0.5
      const dirVec = { N: [0, -0.4], E: [0.4, 0], S: [0, 0.4], W: [-0.4, 0] }[stair.direction] || [0, -0.4]
      const arrowLines = [
        [new Vector3(cx - dirVec[0], midH + 0.2, cz - dirVec[1]), new Vector3(cx + dirVec[0], midH + 0.2, cz + dirVec[1])]
      ]
      const arrow = MeshBuilder.CreateLineSystem(`collStair_${key}`, { lines: arrowLines }, scene)
      arrow.color = new Color3(0.2, 1, 0.4)
      arrow.renderingGroupId = 3
      arrow.parent = collisionGroup
    }

    // Hole tiles — semi-transparent red-orange planes
    for (const key of Object.keys(layer.holes || {})) {
      const [x, z] = key.split(',').map(Number)
      const h = getCollisionDisplayHeight(x, z)
      const plane = MeshBuilder.CreatePlane(`collHole_${key}`, { size: 0.9 }, scene)
      plane.rotation.x = Math.PI / 2
      plane.position = new Vector3(x + 0.5, h + 0.05, z + 0.5)
      const mat = new StandardMaterial(`collHoleMat_${key}`, scene)
      mat.diffuseColor = new Color3(0.9, 0.3, 0.1)
      mat.emissiveColor = new Color3(0.45, 0.15, 0.05)
      mat.alpha = 0.45
      mat.specularColor = new Color3(0, 0, 0)
      mat.backFaceCulling = false
      plane.material = mat
      plane.renderingGroupId = 3
      plane.parent = collisionGroup
    }

    collisionGroup.setEnabled(state.tool === ToolMode.COLLISION)
  }

  // Detect which tile edge is nearest to click position
  function getNearestEdge(tileX, tileZ, u, v) {
    // u,v are fractional position within tile (0-1)
    const dists = [v, 1 - u, 1 - v, u] // N, E, S, W distances to edges
    const edges = [1, 2, 4, 8]          // N, E, S, W bitmasks
    const labels = ['N', 'E', 'S', 'W']
    let minIdx = 0
    for (let i = 1; i < 4; i++) {
      if (dists[i] < dists[minIdx]) minIdx = i
    }
    return { edge: edges[minIdx], label: labels[minIdx] }
  }

  let _shadowInfluencesCache = null

  function invalidateShadowCache() { _shadowInfluencesCache = null }

  // --- Spatial index for placed objects ---
  // Divides world into SPATIAL_CELL-sized buckets so findObjectTopAt and
  // pickSurfacePoint only test objects near the cursor instead of all N objects.
  const SPATIAL_CELL = 8
  const _spatialGrid = new Map()

  function _spatialKey(cx, cz) { return cx * 65537 + cz }

  function _spatialRegister(obj) {
    const bounds = obj.userData.bounds
    if (!bounds) return
    const hw = bounds.width  * obj.scale.x * 0.5 + 1
    const hd = bounds.depth  * obj.scale.z * 0.5 + 1
    const x0 = Math.floor((obj.position.x - hw) / SPATIAL_CELL)
    const x1 = Math.floor((obj.position.x + hw) / SPATIAL_CELL)
    const z0 = Math.floor((obj.position.z - hd) / SPATIAL_CELL)
    const z1 = Math.floor((obj.position.z + hd) / SPATIAL_CELL)
    obj.userData._sc = [x0, x1, z0, z1]
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const k = _spatialKey(cx, cz)
        let cell = _spatialGrid.get(k)
        if (!cell) { cell = new Set(); _spatialGrid.set(k, cell) }
        cell.add(obj)
      }
    }
  }

  function _spatialUnregister(obj) {
    const sc = obj.userData._sc
    if (!sc) return
    const [x0, x1, z0, z1] = sc
    for (let cx = x0; cx <= x1; cx++) {
      for (let cz = z0; cz <= z1; cz++) {
        const cell = _spatialGrid.get(_spatialKey(cx, cz))
        if (cell) cell.delete(obj)
      }
    }
    delete obj.userData._sc
  }

  function _spatialNearby(worldX, worldZ, radius) {
    const cx0 = Math.floor((worldX - radius) / SPATIAL_CELL)
    const cx1 = Math.floor((worldX + radius) / SPATIAL_CELL)
    const cz0 = Math.floor((worldZ - radius) / SPATIAL_CELL)
    const cz1 = Math.floor((worldZ + radius) / SPATIAL_CELL)
    const seen = new Set()
    for (let cx = cx0; cx <= cx1; cx++) {
      for (let cz = cz0; cz <= cz1; cz++) {
        const cell = _spatialGrid.get(_spatialKey(cx, cz))
        if (!cell) continue
        for (const obj of cell) seen.add(obj)
      }
    }
    return seen
  }

  const undoStack = []
  const redoStack = []
  const MAX_HISTORY = 100

const state = {
  tool: ToolMode.SELECT,
  paintType: 'grass',
  halfPaint: false,
  hovered: { x: 0, z: 0 },
  showSplitLines: false,
  showTileGrid: false,
  isPainting: false,
  draggedTiles: new Set(),
  levelMode: false,
  levelHeight: null,
  smoothMode: false,
  historyCapturedThisStroke: false,
  lastTerrainEditTime: 0,
  terrainEditInterval: 110
}

let brushRadius = 3.2
let paintBrushRadius = 1

  // RAF dirty-flag: terrain edits mark this dirty; the actual rebuild happens once per animation frame.
  let _terrainDirty = false
  let _terrainDirtyOpts = { skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true }
  let _terrainDirtyRegion = null  // {x1,z1,x2,z2} when only heights changed; null = full rebuild needed

  function markTerrainDirty({ skipTexturePlanes = true, skipShadows = false, skipTextureOverlays = true, heightsOnly = false, region = null, rebuildTexturePlanes = false, rebuildTextureOverlays = false } = {}) {
    // Convenience: explicit rebuild flags override skip flags
    if (rebuildTexturePlanes) skipTexturePlanes = false
    if (rebuildTextureOverlays) skipTextureOverlays = false
    _terrainDirty = true
    if (!skipTexturePlanes)   _terrainDirtyOpts.skipTexturePlanes   = false
    if (!skipShadows)         _terrainDirtyOpts.skipShadows         = false
    if (!skipTextureOverlays) _terrainDirtyOpts.skipTextureOverlays = false

    if (heightsOnly && region) {
      if (_terrainDirtyRegion) {
        _terrainDirtyRegion.x1 = Math.min(_terrainDirtyRegion.x1, region.x1)
        _terrainDirtyRegion.z1 = Math.min(_terrainDirtyRegion.z1, region.z1)
        _terrainDirtyRegion.x2 = Math.max(_terrainDirtyRegion.x2, region.x2)
        _terrainDirtyRegion.z2 = Math.max(_terrainDirtyRegion.z2, region.z2)
      } else {
        _terrainDirtyRegion = { ...region }
      }
    } else {
      _terrainDirtyRegion = null  // structural change — need full rebuild
    }
  }

  // Highlight mesh for hovered tile
  const highlight = MeshBuilder.CreatePlane('highlight', { size: 1 }, scene)
  highlight.rotation.x = Math.PI / 2 // Face up in RHS
  const highlightMat = new StandardMaterial('highlightMat', scene)
  highlightMat.emissiveColor = new Color3(1, 1, 0)
  highlightMat.diffuseColor = new Color3(0, 0, 0)
  highlightMat.specularColor = new Color3(0, 0, 0)
  highlightMat.disableLighting = true
  highlightMat.alpha = 0.18
  highlightMat.backFaceCulling = false
  highlight.material = highlightMat

  // Half-paint hover preview: a cut line + filled polygon over the half
  // that will be painted on click.
  let halfPaintPreviewLine = null
  let halfPaintPreviewFill = null
  const halfPaintFillMat = new StandardMaterial('halfPaintFillMat', scene)
  halfPaintFillMat.emissiveColor = new Color3(0.2, 0.9, 0.4)
  halfPaintFillMat.diffuseColor = new Color3(0, 0, 0)
  halfPaintFillMat.specularColor = new Color3(0, 0, 0)
  halfPaintFillMat.disableLighting = true
  halfPaintFillMat.alpha = 0.28
  halfPaintFillMat.backFaceCulling = false
  halfPaintFillMat.zOffset = -3

  // Memo of last preview inputs. Mousemove fires far more often than the
  // cursor crosses tile/half/angle boundaries, so skip the mesh rebuild
  // when nothing relevant has changed since the last frame.
  let halfPaintPreviewKey = null

  function clearHalfPaintPreview() {
    if (halfPaintPreviewLine) { halfPaintPreviewLine.dispose(); halfPaintPreviewLine = null }
    if (halfPaintPreviewFill) { halfPaintPreviewFill.dispose(); halfPaintPreviewFill = null }
    halfPaintPreviewKey = null
  }

  function updateHalfPaintPreview(tile, eventLike) {
    if (state.tool !== ToolMode.PAINT || !state.halfPaint || !tile) {
      clearHalfPaintPreview()
      return
    }
    const u = tile.u ?? 0.5
    const v = tile.v ?? 0.5

    const existing = map.getTile(tile.x, tile.z)
    const hadHalfMode = !!(existing && existing.textureHalfMode && (existing.textureId || existing.textureIdB))
    const cutAngle = hadHalfMode
      ? existing.textureCutAngle
      : pickTextureCutAngle(u, v, eventLike)
    const cursorHalf = cutSideOf(u, v, cutAngle)

    const key = `${tile.x},${tile.z},${cutAngle.toFixed(4)},${cursorHalf}`
    if (key === halfPaintPreviewKey) return
    halfPaintPreviewKey = key

    if (halfPaintPreviewLine) { halfPaintPreviewLine.dispose(); halfPaintPreviewLine = null }
    if (halfPaintPreviewFill) { halfPaintPreviewFill.dispose(); halfPaintPreviewFill = null }

    const { halfA, halfB, cutEndpoints } = computeCutPolygons(cutAngle)
    const ring = cursorHalf === 'A' ? halfA : halfB
    if (ring.length < 3) return

    const h = map.getTileCornerHeights(tile.x, tile.z)
    const lift = 0.05

    const positions = []
    for (const p of ring) {
      positions.push(tile.x + p.u, bilerpCorners(h.tl, h.tr, h.bl, h.br, p.u, p.v) + lift, tile.z + p.v)
    }
    const indices = fanTriangulate(ring.length)
    halfPaintPreviewFill = new Mesh('halfPaintFill', scene)
    const vd = new VertexData()
    vd.positions = positions
    vd.indices = indices
    const normals = []
    VertexData.ComputeNormals(positions, indices, normals)
    vd.normals = normals
    vd.applyToMesh(halfPaintPreviewFill)
    halfPaintPreviewFill.material = halfPaintFillMat
    halfPaintPreviewFill.isPickable = false

    const linePoints = cutEndpoints.map((p) => new Vector3(
      tile.x + p.u,
      bilerpCorners(h.tl, h.tr, h.bl, h.br, p.u, p.v) + lift + 0.005,
      tile.z + p.v,
    ))
    halfPaintPreviewLine = MeshBuilder.CreateLines('halfPaintCut', { points: linePoints }, scene)
    halfPaintPreviewLine.color = new Color3(0.05, 1, 0.4)
    halfPaintPreviewLine.isPickable = false
    halfPaintPreviewLine.renderingGroupId = 1
  }

  const uiRoot = document.createElement('div')
  uiRoot.style.position = 'absolute'
  uiRoot.style.inset = '0'
  uiRoot.style.pointerEvents = 'none'
  uiRoot.style.zIndex = '20'
  container.appendChild(uiRoot)

  // Top bar
  const topBar = document.createElement('div')
  topBar.id = 'topBar'
  topBar.innerHTML = `
    <span class="app-title">ProjectRS</span>
    <span class="top-sep"></span>
    <button id="saveMapBtn">Save Backup</button>
    <label class="file-label">Import Chunk <input id="importChunkInput" type="file" accept=".json" /></label>
    <button id="restoreAutoSaveBtn">Restore Auto-Save</button>
    <span class="top-sep"></span>
    <select id="serverMapSelect" style="width:110px;font-size:11px;"></select>
    <button id="serverLoadBtn" title="Load map from game server">Load Server</button>
    <button id="serverSaveBtn" title="Save map to game server (overwrites!)">Save Server</button>
    <button id="serverReloadBtn" title="Hot-reload map in running game">Reload Game</button>
    <button id="newDungeonBtn" title="Create a new dungeon map">+ Dungeon</button>
    <button id="questsBtn" title="Edit quests.json (storyline definitions)">Quests</button>
    <span class="top-sep"></span>
    <span class="top-label" id="mapSizeLabel">192 x 64</span>
    <button id="chunkGridBtn" title="Add/remove chunks">Chunks</button>
    <div id="chunkGridPopup" style="display:none;position:absolute;top:32px;background:#1a1a1a;border:1px solid #555;border-radius:6px;padding:8px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.5);">
      <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Click to add · Shift+click to remove</div>
      <div id="chunkGridContainer" style="display:inline-grid;gap:2px;"></div>
    </div>
    <span class="top-sep"></span>
    <span class="top-label">World X</span>
    <input id="worldOffsetX" type="number" value="0" style="width:60px;" />
    <span class="top-label">World Z</span>
    <input id="worldOffsetZ" type="number" value="0" style="width:60px;" />
    <span class="top-sep"></span>
    <button id="helpBtn" title="Keyboard shortcuts">?</button>
  `
  uiRoot.appendChild(topBar)

  // Compass
  const compass = document.createElement('div')
  compass.id = 'compass'
  compass.innerHTML = `
    <div id="compass-needle">
      <div id="compass-north">N</div>
      <div id="compass-arrow-n"></div>
      <div id="compass-arrow-s"></div>
    </div>
  `
  uiRoot.appendChild(compass)

  function updateCompass() {
    const angleDeg = (-yaw) * (180 / Math.PI)
    document.getElementById('compass-needle').style.transform = `rotate(${angleDeg}deg)`
  }

  // Sidebar
  const sidebar = document.createElement('div')
  sidebar.id = 'sidebar'
  sidebar.innerHTML = `
    <div class="tool-row">
      <button id="toolTerrain" class="tool-btn" title="Terrain Tool (1)">Terrain</button>
      <button id="toolPaint" class="tool-btn" title="Paint Tool (2)">Paint</button>
      <button id="toolPlace" class="tool-btn" title="Place Asset (3)">Place</button>
      <button id="toolSelect" class="tool-btn" title="Select (4)">Select</button>
      <button id="toolTexturePlane" class="tool-btn" title="Texture Plane (5)">T.Plane</button>
      <button id="toolNpcSpawn" class="tool-btn" title="NPC Spawn (6)">NPCs</button>
      <button id="toolCollision" class="tool-btn" title="Collision (7)">Collision</button>
      <button id="toolItemSpawn" class="tool-btn" title="Item Spawn (8)">Items</button>
      <button id="toolBiome" class="tool-btn" title="Biome Paint (9)">Biome</button>
      <!-- Layers panel removed -->
      <button id="heightCullBtn" class="tool-btn" title="Height cull cycle (H)">H: Off</button>
    </div>
    <div class="ctx-divider"></div>

    <div class="ctx-panel" id="ctx-terrain">
      <label style="margin-top:0;font-size:11px;color:rgba(255,255,255,0.45);">Brush Size <span id="brushSizeLabel">3.2</span></label>
      <input id="brushSizeSlider" type="range" min="0.4" max="16" step="0.2" value="3.2" style="margin-top:3px;" />
      <button id="toggleSmoothMode" style="margin-top:8px;">Smooth Mode: Off</button>
      <button id="toggleLevelMode" style="margin-top:4px;">Level Mode: Off</button>
      <div id="levelHeightRow" style="display:none;margin-top:6px;">
        <div style="display:flex;gap:5px;align-items:center;">
          <input id="levelHeightInput" type="number" step="0.25" placeholder="Height" style="flex:1;margin-top:0;" />
          <button id="clearLevelHeight" style="width:auto;padding:7px 8px;margin-top:0;flex-shrink:0;">Clear</button>
        </div>
        <div class="hint" style="margin-top:4px;">Click a tile to sample · or type any value</div>
      </div>
      <div class="hint">Left drag raise · Shift lower · Ctrl smooth<br>Q/E raise/lower hovered · L level mode</div>
    </div>

    <div class="ctx-panel" id="ctx-paint" style="display:none">
      <label style="margin-top:0;font-size:11px;color:rgba(255,255,255,0.45);">Brush Size <span id="paintBrushSizeLabel">1</span></label>
      <input id="paintBrushSizeSlider" type="range" min="1" max="16" step="1" value="1" style="margin-top:3px;" />
      <div class="ground-swatches" id="groundSwatches"></div>
      <div class="row">
        <label><input id="toggleHalfPaint" type="checkbox" /> Half Tile Paint</label>
        <label><input id="toggleSplitLines" type="checkbox" /> Show Split Lines</label>
        <label><input id="toggleTileGrid" type="checkbox" /> Show Tile Grid</label>
      </div>
      <div style="font-size:11px;opacity:0.6;margin:8px 0 4px;border-top:1px solid #444;padding-top:8px;">Texture Brushes</div>
      <div style="display:flex;gap:4px;margin-bottom:5px;align-items:center;">
        <div style="font-size:11px;opacity:0.6;">Slot:</div>
        <div id="texSlotA" style="flex:1;height:28px;border-radius:3px;border:2px solid #2d6cdf;cursor:pointer;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;text-shadow:0 0 2px #000;">A</div>
        <div id="texSlotB" style="flex:1;height:28px;border-radius:3px;border:2px solid #444;cursor:pointer;background-size:cover;background-position:center;display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff;text-shadow:0 0 2px #000;">B</div>
      </div>
      <button id="eraseTextureBrushBtn" style="width:100%;margin-bottom:5px;">Erase Texture</button>
      <div style="display:flex;gap:4px;margin-bottom:5px;">
        <button id="texCatAll" style="flex:1;font-size:11px;">All</button>
        <button id="texCatStretched" style="flex:1;font-size:11px;">Stretched</button>
      </div>
      <input id="paintTextureSearch" type="text" placeholder="Search textures..." style="width:100%;box-sizing:border-box;margin-bottom:5px;" />
      <div id="paintTexturePalette" style="display:grid;grid-template-columns:repeat(4,1fr);gap:4px;max-height:200px;overflow-y:auto;"></div>
      <div id="paintTextureScaleRow" style="display:none;margin-top:5px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Scale <span id="paintTextureScaleVal">1</span></label>
        <input id="paintTextureScale" type="range" min="1" max="8" step="1" value="1" style="width:100%;" />
      </div>
      <div id="paintDiagFloorRow" style="margin-top:6px;border-top:1px solid #444;padding-top:6px;">
        <label><input id="paintToggleDiagFloor" type="checkbox" /> Diagonal Floor (D)</label>
        <div id="paintDiagFloorOptions" style="display:none;margin-top:4px;">
          <label style="font-size:11px;color:rgba(255,255,255,0.45);">Width <span id="paintDiagFloorWidthVal">3</span></label>
          <input id="paintDiagFloorWidthSlider" type="range" min="1" max="20" step="1" value="3" style="width:100%;" />
          <div class="hint" style="margin-top:3px;">Click start → click end to place rotated floor<br>Shift = free angle · Esc = cancel</div>
        </div>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-place" style="display:none">
      <div class="asset-tabs">
        <button class="asset-tab active" id="tabProps">Props</button>
        <button class="asset-tab" id="tabModular">Modular</button>
        <button class="asset-tab" id="tabWalls">Walls</button>
        <button class="asset-tab" id="tabRoofs">Roofs</button>
        <button class="asset-tab" id="tabBought">Bought</button>
      </div>
      <select id="assetGroupSelect" style="display:none"></select>
      <input id="assetSearch" type="text" placeholder="Search assets..." />
      <div id="assetGrid" class="asset-grid"></div>
      <div style="margin-top:5px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Scale <span id="placeScaleLabel">1.0</span></label>
        <input id="placeScaleSlider" type="range" min="0.1" max="5" step="0.1" value="1.0" style="width:100%;margin-top:3px;" />
        <button id="refreshPreviewBtn" style="width:100%;margin-top:5px;">Refresh Preview</button>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-select" style="display:none">
      <div class="hint">
        G move · R rotate · S scale<br>
        X Y Z axis lock · click confirm · Esc cancel<br>
        Q/E raise/lower while moving · Shift snap<br>
        Alt free move (bypass snap) · K snap to grid<br>
        D dup in-place · Shift+D right · Ctrl+D left · Alt+D forward · Alt+A back<br>
        Shift+A stack upward<br>
        Delete / Backspace remove selected
      </div>
      <div id="layerAssignRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Layer</div>
        <div style="display:flex;gap:5px;align-items:center;">
          <select id="layerAssignSelect" style="flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:12px;"></select>
          <button id="layerAssignBtn" style="background:#1a4faf;color:#fff;border:none;border-radius:4px;padding:4px 8px;font-size:11px;cursor:pointer;white-space:nowrap;">Move</button>
        </div>
        <div id="layerCurrentLabel" style="font-size:10px;color:#888;margin-top:4px;"></div>
      </div>
      <div id="replaceRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <button id="replaceBtn" style="width:100%">Replace Selected</button>
        <div id="replacePanel" style="display:none;margin-top:6px;">
          <input id="replaceSearch" type="text" placeholder="Search assets..." style="width:100%;box-sizing:border-box;margin-bottom:5px;" />
          <div id="replaceGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-height:180px;overflow-y:auto;"></div>
        </div>
      </div>
      <div id="replaceTextureRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <button id="replaceTextureBtn" style="width:100%">Replace Texture</button>
        <div id="replaceTexturePanel" style="display:none;margin-top:6px;">
          <input id="replaceTextureSearch" type="text" placeholder="Search textures..." style="width:100%;box-sizing:border-box;margin-bottom:5px;" />
          <div id="replaceTextureGrid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:4px;max-height:180px;overflow-y:auto;"></div>
        </div>
      </div>
      <div id="tileSizeRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;opacity:0.6;margin-bottom:5px;">Scale to tiles (longest axis)</div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <button class="tile-size-btn" data-tiles="1">1</button>
          <button class="tile-size-btn" data-tiles="2">2</button>
          <button class="tile-size-btn" data-tiles="3">3</button>
          <button class="tile-size-btn" data-tiles="4">4</button>
          <button class="tile-size-btn" data-tiles="5">5</button>
        </div>
        <div style="display:flex;gap:4px;margin-top:5px;align-items:center;">
          <input id="customTileSize" type="number" min="0.25" max="20" step="0.25" value="1" style="width:60px;" />
          <button id="applyCustomTileSize">Apply</button>
        </div>
      </div>
      <div id="triggerRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Trigger</div>
        <div style="display:flex;gap:5px;align-items:center;margin-bottom:5px;">
          <select id="triggerType" style="flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:12px;">
            <option value="">— none —</option>
            <option value="teleport">Teleport</option>
          </select>
        </div>
        <div id="triggerTeleportFields" style="display:none;">
          <div style="font-size:10px;color:#888;margin-bottom:3px;">Destination chunk file</div>
          <input id="triggerDestChunk" type="text" placeholder="e.g. dungeon_1" style="width:100%;box-sizing:border-box;margin-bottom:5px;font-size:11px;" />
          <div style="font-size:10px;color:#888;margin-bottom:3px;">Entry point (X / Y / Z)</div>
          <div style="display:flex;gap:3px;">
            <input id="triggerEntryX" type="number" step="0.5" placeholder="X" style="flex:1;min-width:0;" />
            <input id="triggerEntryY" type="number" step="0.5" placeholder="Y" style="flex:1;min-width:0;" />
            <input id="triggerEntryZ" type="number" step="0.5" placeholder="Z" style="flex:1;min-width:0;" />
          </div>
        </div>
      </div>
      <div id="interactionSidesRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">Interaction tiles (player must approach from)</div>
        <div style="font-size:10px;color:#777;margin-bottom:6px;">Click a green cell to toggle. All off = any cardinal-adjacent tile. ↑ marks local +Z (forward).</div>
        <div id="interactionTilesGrid" style="display:inline-block;"></div>
        <div style="margin-top:6px;display:flex;gap:6px;">
          <button id="interactSidesAll" style="font-size:10px;padding:3px 6px;">All</button>
          <button id="interactSidesNone" style="font-size:10px;padding:3px 6px;">None</button>
          <button id="interactSidesFront" style="font-size:10px;padding:3px 6px;">Front only</button>
        </div>
      </div>
      <div id="planeRotationRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Plane Rotation</div>
        <div style="display:flex;gap:3px;margin-bottom:5px;">
          <button class="plane-preset-btn" data-rx="0" data-ry="0" data-rz="0" style="flex:1;font-size:10px;padding:4px 2px;">Vertical</button>
          <button class="plane-preset-btn" data-rx="-1.5708" data-ry="0" data-rz="0" style="flex:1;font-size:10px;padding:4px 2px;">Flat</button>
          <button class="plane-preset-btn" data-rx="-0.7854" data-ry="0" data-rz="0" style="flex:1;font-size:10px;padding:4px 2px;">45°</button>
        </div>
        <div style="display:flex;gap:3px;align-items:center;margin-bottom:3px;">
          <span style="font-size:10px;color:#888;width:14px;">X</span>
          <input id="planeRotX" type="range" min="-3.14" max="3.14" step="0.05" value="0" style="flex:1;" />
          <input id="planeRotXNum" type="number" step="5" style="width:42px;font-size:10px;" />
        </div>
        <div style="display:flex;gap:3px;align-items:center;margin-bottom:3px;">
          <span style="font-size:10px;color:#888;width:14px;">Y</span>
          <input id="planeRotY" type="range" min="-3.14" max="3.14" step="0.05" value="0" style="flex:1;" />
          <input id="planeRotYNum" type="number" step="5" style="width:42px;font-size:10px;" />
        </div>
        <div style="display:flex;gap:3px;align-items:center;">
          <span style="font-size:10px;color:#888;width:14px;">Z</span>
          <input id="planeRotZ" type="range" min="-3.14" max="3.14" step="0.05" value="0" style="flex:1;" />
          <input id="planeRotZNum" type="number" step="5" style="width:42px;font-size:10px;" />
        </div>
        <div class="hint" style="margin-top:4px;">Scroll = tilt · Ctrl+Scroll = spin · Shift = fine</div>
      </div>
      <div id="texNoRoofRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:6px;">
        <label style="font-size:11px;cursor:pointer;"><input id="texNoRoof" type="checkbox" /> No Roof (stays visible indoors)</label>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-texture" style="display:none">
      <input id="textureSearch" type="text" placeholder="Search textures..." />
      <div id="texturePalette" style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;max-height:200px;overflow:auto;margin-top:7px;"></div>
      <div style="margin-top:5px;">
        <button id="useTexturePlaneBtn" style="width:100%">Plane Mode</button>
      </div>
      <button id="rotateTextureBtn">Rotate Texture (R)</button>
      <label style="margin-top:6px;font-size:11px;color:rgba(255,255,255,0.45);">Scale <span id="textureScaleVal">1</span></label>
      <input id="textureScale" type="range" min="1" max="8" step="1" value="1" />
      <label style="margin-top:5px;"><input id="toggleTexturePlaneV" type="checkbox" checked /> Vertical plane (V)</label>
      <div id="diagFloorRow" style="margin-top:6px;border-top:1px solid #444;padding-top:6px;">
        <label><input id="toggleDiagFloor" type="checkbox" /> Diagonal Floor (D)</label>
        <div id="diagFloorOptions" style="display:none;margin-top:4px;">
          <label style="font-size:11px;color:rgba(255,255,255,0.45);">Width <span id="diagFloorWidthVal">3</span></label>
          <input id="diagFloorWidthSlider" type="range" min="1" max="20" step="1" value="3" style="width:100%;" />
          <div class="hint" style="margin-top:3px;">Click start → click end to place rotated floor<br>Shift = free angle · Esc = cancel</div>
        </div>
      </div>
      <div id="texTintRow" style="margin-top:8px;border-top:1px solid #444;padding-top:6px;">
        <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:3px;">Tint Color</div>
        <div style="display:flex;gap:4px;align-items:center;">
          <span style="font-size:10px;color:#f66;">R</span>
          <input id="texTintR" type="range" min="0" max="100" value="100" style="flex:1;" />
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          <span style="font-size:10px;color:#6f6;">G</span>
          <input id="texTintG" type="range" min="0" max="100" value="100" style="flex:1;" />
        </div>
        <div style="display:flex;gap:4px;align-items:center;">
          <span style="font-size:10px;color:#66f;">B</span>
          <input id="texTintB" type="range" min="0" max="100" value="100" style="flex:1;" />
        </div>
        <div style="display:flex;gap:4px;margin-top:3px;">
          <div id="texTintPreview" style="width:24px;height:24px;border:1px solid #555;border-radius:3px;background:#fff;"></div>
          <button id="texTintReset" style="flex:1;font-size:10px;padding:3px;">Reset White</button>
        </div>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-npc-spawn" style="display:none">
      <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:4px;">NPC Type</div>
      <select id="npcTypeSelect" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:5px 6px;font-size:12px;"></select>
      <!-- Tab bar — switches the content area below. Spawn tab shows
           per-instance controls (wander, aggression); the others edit the
           shared NpcDef or per-spawn overrides for the selected spawn. -->
      <div id="npcInspectorTabs" style="display:flex;gap:2px;margin-top:8px;border-bottom:1px solid #444;">
        <button class="npc-tab active-tool" data-tab="spawn" style="flex:1;font-size:10px;padding:5px 2px;background:#2a2a2a;border:1px solid #555;border-bottom:none;border-radius:3px 3px 0 0;color:#fff;cursor:pointer;">Spawn</button>
        <button class="npc-tab" data-tab="stats" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Stats</button>
        <button class="npc-tab" data-tab="appearance" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Look</button>
        <button class="npc-tab" data-tab="equipment" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Gear</button>
        <button class="npc-tab" data-tab="shop" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Shop</button>
        <button class="npc-tab" data-tab="dialogue" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Talk</button>
      </div>
      <div id="npcInspectorContent" style="margin-top:8px;"></div>
      <!-- Footer: per-def save button. Disabled until the user edits a
           def-level field. POSTs the full npcDefs array to /api/editor/npcs;
           server snapshots the previous file and hot-reloads. -->
      <div style="display:flex;gap:5px;margin-top:10px;border-top:1px solid #444;padding-top:8px;">
        <button id="saveNpcDefsBtn" style="flex:2;font-size:11px;padding:5px;background:#3a6c3a;color:#fff;cursor:pointer;border:1px solid #555;">Save NPC defs</button>
        <span id="saveNpcDefsStatus" style="flex:1;align-self:center;font-size:10px;color:#888;text-align:right;"></span>
      </div>
      <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:10px;border-top:1px solid #444;padding-top:8px;">Spawns <span id="npcSpawnCount">0</span></div>
      <div id="npcSpawnList" style="max-height:200px;overflow-y:auto;margin-top:4px;"></div>
    </div>

    <div class="ctx-panel" id="ctx-item-spawn" style="display:none">
      <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:4px;">Item Type</div>
      <select id="itemTypeSelect" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:5px 6px;font-size:12px;"></select>
      <div class="hint" style="margin-top:6px;">Click to place · Shift+Click to remove</div>
      <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-top:10px;border-top:1px solid #444;padding-top:8px;">Item Spawns <span id="itemSpawnCount">0</span></div>
      <div id="itemSpawnList" style="max-height:200px;overflow-y:auto;margin-top:4px;"></div>
    </div>

    <div class="ctx-panel" id="ctx-biome" style="display:none">
      <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:4px;">8x8 tile cells · Click + drag = rectangle fill · Shift+drag to erase · Ctrl+Z undo</div>
      <div id="biomeDefList" style="margin-bottom:8px;"></div>
      <button id="biomeAddBtn" style="width:100%;margin-bottom:8px;">+ New Biome</button>
      <div id="biomeEditor" style="display:none;border-top:1px solid #444;padding-top:8px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Name</label>
        <input id="biomeEditName" type="text" style="width:100%;margin-top:3px;margin-bottom:6px;" />
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Fog Color</label>
        <input id="biomeEditColor" type="color" style="width:100%;height:32px;margin-top:3px;margin-bottom:6px;" />
        <div style="display:flex;gap:5px;">
          <div style="flex:1;">
            <label style="font-size:11px;color:rgba(255,255,255,0.45);">Clear up to <span id="biomeEditStartVal">10</span> tiles</label>
            <input id="biomeEditStart" type="range" min="0" max="120" step="1" value="10" style="width:100%;" />
          </div>
          <div style="flex:1;">
            <label style="font-size:11px;color:rgba(255,255,255,0.45);">Full fog at <span id="biomeEditEndVal">40</span> tiles</label>
            <input id="biomeEditEnd" type="range" min="5" max="200" step="1" value="40" style="width:100%;" />
          </div>
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.35);margin-top:4px;line-height:1.3;">
          Fog starts appearing at <b>Clear</b> distance, reaches full opacity at <b>Full fog</b>.
          Lower values = denser, closer fog.
        </div>
        <div style="display:flex;gap:5px;margin-top:8px;">
          <button id="biomeSaveBtn" style="flex:1;">Save</button>
          <button id="biomeDeleteBtn" style="flex:1;background:#7a3030;">Delete</button>
        </div>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-collision" style="display:none">
      <div style="font-size:11px;color:rgba(255,255,255,0.45);margin-bottom:4px;">Mode</div>
      <div style="display:flex;gap:3px;margin-bottom:8px;">
        <button id="collWallBtn" class="tool-btn active-tool" style="flex:1;font-size:10px;padding:4px;">Walls</button>
        <button id="collBlockBtn" class="tool-btn" style="flex:1;font-size:10px;padding:4px;">Block Tile</button>
        <button id="collFloorBtn" class="tool-btn" style="flex:1;font-size:10px;padding:4px;">Floor</button>
        <button id="collStairBtn" class="tool-btn" style="flex:1;font-size:10px;padding:4px;">Stairs</button>
        <button id="collHoleBtn" class="tool-btn" style="flex:1;font-size:10px;padding:4px;">Hole</button>
      </div>
      <div id="collWallPanel">
        <div style="display:flex;gap:4px;align-items:center;margin-bottom:6px;">
          <select id="wallChunkSelect" style="flex:1;font-size:11px;padding:2px;"></select>
        </div>
        <button id="autoWallsBtn" style="width:100%;margin-bottom:4px;font-size:11px;">Auto-detect walls</button>
        <button id="clearRegionWallsBtn" style="width:100%;margin-bottom:4px;font-size:11px;">Clear walls</button>
        <button id="clearAllWallsBtn" style="width:100%;margin-bottom:4px;font-size:11px;">Clear all walls (this floor)</button>
        <div style="display:flex;gap:3px;margin-bottom:6px;">
          <button id="wallDrawBtn" class="tool-btn active-tool" style="flex:1;font-size:10px;padding:4px;">Draw</button>
          <button id="wallEraseBtn" class="tool-btn" style="flex:1;font-size:10px;padding:4px;">Erase</button>
        </div>
        <div class="hint">Click/drag edges · Shift = erase<br>Erase mode: drag to remove walls</div>
        <label style="margin-top:6px;font-size:11px;color:rgba(255,255,255,0.45);">Wall Height <span id="wallHeightLabel">1.8</span></label>
        <input id="wallHeightSlider" type="range" min="0.5" max="6" step="0.1" value="1.8" style="width:100%;margin-top:3px;" />
      </div>
      <div id="collBlockPanel" style="display:none;">
        <div class="hint">Click tile to block/unblock<br>Blocks all 4 edges</div>
      </div>
      <div id="collFloorPanel" style="display:none;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Floor Height <span id="floorHeightLabel">3.0</span></label>
        <input id="floorHeightInput" type="number" step="0.5" value="3.0" style="width:100%;margin-top:3px;" />
        <div class="hint" style="margin-top:4px;">Click to set floor · Shift+Click to remove</div>
      </div>
      <div id="collStairPanel" style="display:none;">
        <div style="display:flex;gap:3px;margin-bottom:5px;">
          <button class="stair-dir-btn active-tool" data-dir="N" style="flex:1;font-size:10px;padding:4px;">N</button>
          <button class="stair-dir-btn" data-dir="E" style="flex:1;font-size:10px;padding:4px;">E</button>
          <button class="stair-dir-btn" data-dir="S" style="flex:1;font-size:10px;padding:4px;">S</button>
          <button class="stair-dir-btn" data-dir="W" style="flex:1;font-size:10px;padding:4px;">W</button>
        </div>
        <div style="display:flex;gap:5px;margin-bottom:3px;">
          <div style="flex:1;">
            <div style="font-size:10px;color:#888;">Base H</div>
            <input id="stairBaseH" type="number" step="0.5" value="0" style="width:100%;" />
          </div>
          <div style="flex:1;">
            <div style="font-size:10px;color:#888;">Top H</div>
            <input id="stairTopH" type="number" step="0.5" value="3.5" style="width:100%;" />
          </div>
        </div>
        <div class="hint">Click to place stair · Shift+Click to remove</div>
      </div>
      <div id="collHolePanel" style="display:none;">
        <div class="hint">Click to toggle terrain hole<br>Shift+Click to remove</div>
      </div>
      <div style="margin-top:8px;border-top:1px solid #444;padding-top:6px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Floor Level <span id="collFloorLevel">0</span></label>
        <input id="collFloorLevelSlider" type="range" min="0" max="3" step="1" value="0" style="width:100%;margin-top:3px;" />
      </div>
    </div>
    <div style="margin-top:8px;border-top:1px solid #555;padding-top:6px;">
      <label style="font-size:11px;cursor:pointer;"><input id="togglePanMode" type="checkbox" /> Pan: Shift+MMB (default: MMB)</label>
    </div>
  `
  uiRoot.appendChild(sidebar)

  // Status bar
  const statusBar = document.createElement('div')
  statusBar.id = 'statusBar'
  statusBar.innerHTML = `<span id="statusText">Terrain Tool</span><span id="hoverText" style="margin-left:auto;opacity:0.55;"></span>`
  uiRoot.appendChild(statusBar)

  // Keybinds overlay
  const keybindsPanel = document.createElement('div')
  keybindsPanel.id = 'keybindsPanel'
  keybindsPanel.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;">
      <strong>Keyboard Shortcuts</strong>
      <button id="closeKeybinds">✕</button>
    </div>
    <div>
      <b>Tools:</b> 1 Terrain · 2 Paint · 3 Place · 4 Select · 5 Texture · 6 Texture Plane<br>
      <b>History:</b> Ctrl+Z undo · Ctrl+Shift+Z / Ctrl+Y redo<br>
      <b>Transform:</b> G move · R rotate · S scale · X/Y/Z axis · click confirm · Esc cancel<br>
      <b>While moving:</b> Q raise · E lower · Shift snap to grid · Alt disable edge snap<br>
      <b>Terrain:</b> Q/E raise/lower hovered · L level mode · F flip tile split<br>
      <b>Duplicate:</b> D in-place · Shift+D right · Ctrl+D left · Alt+D forward · Alt+A back · Shift+A stack up<br>
      <b>Other:</b> K snap to grid · V toggle plane vertical/horizontal · Del remove selected
    </div>
  `
  uiRoot.appendChild(keybindsPanel)

  // Layers panel removed — kept layers data for save compat
  const layersPanel = { classList: { toggle() {}, contains() { return false }, remove() {} }, innerHTML: '' }

  const toolButtons = {
    [ToolMode.TERRAIN]: sidebar.querySelector('#toolTerrain'),
    [ToolMode.PAINT]: sidebar.querySelector('#toolPaint'),
    [ToolMode.PLACE]: sidebar.querySelector('#toolPlace'),
    [ToolMode.SELECT]: sidebar.querySelector('#toolSelect'),
    [ToolMode.TEXTURE_PLANE]: sidebar.querySelector('#toolTexturePlane'),
    [ToolMode.NPC_SPAWN]: sidebar.querySelector('#toolNpcSpawn'),
    [ToolMode.COLLISION]: sidebar.querySelector('#toolCollision'),
    [ToolMode.ITEM_SPAWN]: sidebar.querySelector('#toolItemSpawn'),
    [ToolMode.BIOME]: sidebar.querySelector('#toolBiome')
  }

  toolButtons[ToolMode.TERRAIN]?.addEventListener('click', () => setTool(ToolMode.TERRAIN))
  toolButtons[ToolMode.PAINT]?.addEventListener('click', () => setTool(ToolMode.PAINT))
  toolButtons[ToolMode.PLACE]?.addEventListener('click', () => setTool(ToolMode.PLACE))
  toolButtons[ToolMode.SELECT]?.addEventListener('click', () => setTool(ToolMode.SELECT))
  toolButtons[ToolMode.TEXTURE_PLANE]?.addEventListener('click', () => setTool(ToolMode.TEXTURE_PLANE))
  toolButtons[ToolMode.NPC_SPAWN]?.addEventListener('click', () => setTool(ToolMode.NPC_SPAWN))
  toolButtons[ToolMode.COLLISION]?.addEventListener('click', () => setTool(ToolMode.COLLISION))
  toolButtons[ToolMode.ITEM_SPAWN]?.addEventListener('click', () => setTool(ToolMode.ITEM_SPAWN))
  toolButtons[ToolMode.BIOME]?.addEventListener('click', () => setTool(ToolMode.BIOME))

  // --- NPC Inspector: fetch defs + wire tabbed sidebar (must be after sidebar is created) ---
  // The inspector edits two kinds of state:
  //   • per-spawn (selectedNpcSpawn): wanderRange, aggressive, appearance,
  //     equipment, shop?, dialogue? — saved with the map via /api/editor/save-map.
  //   • shared NpcDef (npcDefs[i] for the spawn's npcId): stats, default shop,
  //     default dialogue — saved via /api/editor/npcs and hot-reloaded server-side.
  // npcDefsDirty gates the "Save NPC defs" button and is set by any def edit.
  let activeNpcTab = 'spawn'
  let npcDefsDirty = false

  function findSelectedDef() {
    if (!selectedNpcSpawn) return null
    return npcDefs.find(d => d.id === selectedNpcSpawn.npcId) || null
  }

  // The Save NPC defs button is always clickable; `npcDefsDirty` is kept as a
  // hint so Save Server can skip a redundant defs POST when nothing changed.
  // We deliberately don't grey out the button — it's hard for the user to
  // know which tabs dirty defs (Stats/Shop/Dialogue) vs which only edit
  // per-spawn data (Look/Gear/Spawn), and a no-op save is idempotent
  // server-side (atomic write + identical content).
  function markDefsDirty() {
    npcDefsDirty = true
    const status = sidebar.querySelector('#saveNpcDefsStatus')
    if (status && !status.textContent) status.textContent = 'unsaved'
  }

  function clearDefsDirty(statusText) {
    npcDefsDirty = false
    const status = sidebar.querySelector('#saveNpcDefsStatus')
    if (status) {
      status.textContent = statusText || ''
      if (statusText) setTimeout(() => { status.textContent = '' }, 3000)
    }
  }

  // Reuses the item-spawn system's itemDefs (declared above) — they share the
  // same /data/items.json source, no point in loading it twice.
  function fetchItemDefsOnce() {
    if (itemDefs.length > 0) return Promise.resolve(itemDefs)
    return loadItemDefs().then(() => itemDefs).catch(() => [])
  }

  /** Shared datalist used by every shop-row item picker. One node appended to
   *  the body — referenced via `list="shopItemDatalist"` on each input. Built
   *  once when itemDefs first loads; rebuilt only if the def set changes. */
  function ensureShopItemDatalist() {
    let dl = document.getElementById('shopItemDatalist')
    if (dl && dl.childElementCount === itemDefs.length) return  // already in sync
    if (!dl) {
      dl = document.createElement('datalist')
      dl.id = 'shopItemDatalist'
      document.body.appendChild(dl)
    }
    dl.innerHTML = ''
    // Sort by name so the dropdown is alphabetic — typing 'dagger' surfaces
    // every dagger tier in one block.
    const sorted = [...itemDefs].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
    for (const d of sorted) {
      const opt = document.createElement('option')
      opt.value = `${d.name} (${d.id})`
      dl.appendChild(opt)
    }
  }

  /** Parse the displayed value back to an item id. Accepts the canonical
   *  "ItemName (NN)" form, a bare integer (so power users can still type
   *  IDs), or returns 0 for an empty / unparseable value. */
  function parseItemIdFromDisplay(value) {
    if (!value) return 0
    const tail = value.match(/\((\d+)\)\s*$/)
    if (tail) return parseInt(tail[1])
    const n = parseInt(value)
    return Number.isFinite(n) ? n : 0
  }

  function formatItemDisplay(id) {
    const def = itemDefs.find(d => d.id === id)
    return def ? `${def.name} (${def.id})` : (id > 0 ? String(id) : '')
  }

  fetch('/data/npcs.json')
    .then(r => r.json())
    .then(defs => {
      npcDefs = defs
      const sel = sidebar.querySelector('#npcTypeSelect')
      if (sel) {
        sel.innerHTML = defs.map(d => `<option value="${d.id}">${d.name} (ID ${d.id}) — HP ${d.health}</option>`).join('')
      }
      renderNpcInspector()
    })
    .catch(e => console.warn('Failed to load NPC defs:', e))

  sidebar.querySelector('#npcTypeSelect')?.addEventListener('change', (e) => {
    if (selectedNpcSpawn) {
      selectedNpcSpawn.npcId = parseInt(e.target.value)
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
    }
    renderNpcInspector()
  })

  // Tab switcher
  for (const tabBtn of sidebar.querySelectorAll('.npc-tab')) {
    tabBtn.addEventListener('click', () => {
      activeNpcTab = tabBtn.dataset.tab
      for (const b of sidebar.querySelectorAll('.npc-tab')) {
        const active = b.dataset.tab === activeNpcTab
        b.classList.toggle('active-tool', active)
        b.style.background = active ? '#2a2a2a' : '#1a1a1a'
        b.style.color = active ? '#fff' : '#aaa'
        b.style.border = active ? '1px solid #555' : '1px solid #444'
        b.style.borderBottom = 'none'
      }
      renderNpcInspector()
    })
  }

  // Save NPC defs → POST /api/editor/npcs.
  // Always-clickable: even with no in-session edits, this writes the current
  // npcDefs back to disk (server side is idempotent: atomic write + snapshot).
  sidebar.querySelector('#saveNpcDefsBtn')?.addEventListener('click', async () => {
    const status = sidebar.querySelector('#saveNpcDefsStatus')
    if (status) status.textContent = 'saving…'
    try {
      const r = await fetch('/api/editor/npcs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ npcs: npcDefs }),
      })
      const body = await r.json().catch(() => ({}))
      if (r.ok && body.ok) {
        clearDefsDirty('saved ✓')
      } else {
        if (status) status.textContent = body.error || 'save failed'
      }
    } catch (err) {
      if (status) status.textContent = 'network error'
    }
  })

  /** Render the inspector content for the currently active tab. Called on
   *  tab switch, on selection change, and after any mutation that affects
   *  what the tab displays. Each tab rewires its own input listeners. */
  function renderNpcInspector() {
    const content = sidebar.querySelector('#npcInspectorContent')
    if (!content) return
    const def = findSelectedDef()

    // Always sync the type dropdown — independent of tab.
    if (selectedNpcSpawn) {
      const sel = sidebar.querySelector('#npcTypeSelect')
      if (sel) sel.value = selectedNpcSpawn.npcId
    }

    if (activeNpcTab === 'spawn') {
      renderSpawnTab(content)
    } else if (activeNpcTab === 'stats') {
      renderStatsTab(content, def)
    } else if (activeNpcTab === 'appearance') {
      renderAppearanceTab(content)
    } else if (activeNpcTab === 'equipment') {
      renderEquipmentTab(content)
    } else if (activeNpcTab === 'shop') {
      renderShopTab(content, def)
    } else if (activeNpcTab === 'dialogue') {
      renderDialogueTab(content, def)
    }
  }

  function renderSpawnTab(root) {
    const spawn = selectedNpcSpawn
    const def = findSelectedDef()
    const defaultWander = def?.wanderRange ?? 3
    const wander = spawn?.wanderRange ?? defaultWander
    const aggressiveEffective = spawn
      ? (spawn.aggressive === true || spawn.aggressive === false ? spawn.aggressive : !!def?.aggressive)
      : !!def?.aggressive
    const nameValue = spawn?.name ?? ''
    const defName = def?.name ?? ''
    root.innerHTML = `
      <label style="font-size:11px;color:rgba(255,255,255,0.45);">Name (override)</label>
      <input id="spawnNameInput" type="text" value="${nameValue.replace(/"/g, '&quot;')}" placeholder="${defName.replace(/"/g, '&quot;') || 'defaults to NPC type name'}" style="width:100%;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:4px 5px;font-size:11px;margin-top:3px;" ${spawn ? '' : 'disabled'} />
      <div class="hint" style="margin-top:2px;font-size:10px;color:rgba(255,255,255,0.35);">Per-spawn name. Leave blank to inherit "${defName}".</div>
      <label style="margin-top:10px;font-size:11px;color:rgba(255,255,255,0.45);">Wander Range <span id="wanderRangeLabel">${wander}</span></label>
      <input id="wanderRangeSlider" type="range" min="0" max="15" step="1" value="${wander}" style="width:100%;margin-top:3px;" ${spawn ? '' : 'disabled'} />
      <label style="margin-top:8px;font-size:11px;color:rgba(255,255,255,0.45);display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input id="aggressiveCheckbox" type="checkbox" ${aggressiveEffective ? 'checked' : ''} ${spawn ? '' : 'disabled'} />
        Aggressive (per-spawn override)
      </label>
      <div class="hint" style="margin-top:4px;font-size:10px;color:rgba(255,255,255,0.35);">
        ${spawn ? 'Editing the selected spawn.' : 'Click a placed NPC to edit its spawn.'}
        Click empty tile to place · Shift+click to remove.
      </div>
    `
    root.querySelector('#spawnNameInput')?.addEventListener('input', (e) => {
      if (selectedNpcSpawn) {
        const v = e.target.value.trim()
        // Empty string → drop the override so serializeNpcSpawns omits the
        // field and the runtime falls back to def.name.
        if (v) selectedNpcSpawn.name = v
        else delete selectedNpcSpawn.name
        refreshNpcSpawnList()
      }
    })
    root.querySelector('#wanderRangeSlider')?.addEventListener('input', (e) => {
      root.querySelector('#wanderRangeLabel').textContent = e.target.value
      if (selectedNpcSpawn) {
        selectedNpcSpawn.wanderRange = parseInt(e.target.value)
        rebuildNpcSpawnMeshes()
        refreshNpcSpawnList()
      }
    })
    root.querySelector('#aggressiveCheckbox')?.addEventListener('change', (e) => {
      if (selectedNpcSpawn) {
        selectedNpcSpawn.aggressive = e.target.checked
        refreshNpcSpawnList()
      }
    })
  }

  function renderStatsTab(root, def) {
    if (!def) {
      root.innerHTML = `<div class="hint">Select an NPC spawn (or pick a type) to edit shared stats.</div>`
      return
    }
    const numField = (key, label, step = 1, min = 0) => `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">${label}</span>
        <input data-def-key="${key}" type="number" step="${step}" min="${min}" value="${def[key] ?? 0}"
               style="width:70px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
      </div>
    `
    root.innerHTML = `
      <div style="font-size:10px;color:#ffaa44;margin-bottom:6px;">Editing shared NpcDef #${def.id} — affects every spawn of "${def.name}".</div>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">Name</span>
        <input data-def-key="name" type="text" value="${def.name ?? ''}" style="width:140px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
      </div>
      ${numField('health', 'Health')}
      ${numField('attack', 'Attack')}
      ${numField('strength', 'Strength')}
      ${numField('defence', 'Defence')}
      ${numField('attackSpeed', 'Attack speed (ticks)')}
      ${numField('respawnTime', 'Respawn time (ticks)')}
      ${numField('wanderRange', 'Default wander range')}
      <label style="font-size:11px;color:rgba(255,255,255,0.65);display:flex;align-items:center;gap:6px;margin-top:4px;cursor:pointer;">
        <input data-def-key="aggressive" type="checkbox" ${def.aggressive ? 'checked' : ''} />
        Aggressive by default
      </label>
      <label style="font-size:11px;color:rgba(255,255,255,0.65);display:flex;align-items:center;gap:6px;margin-top:2px;cursor:pointer;">
        <input data-def-key="bankAccess" type="checkbox" ${def.bankAccess ? 'checked' : ''} />
        Banker (offers bank when talked-to)
      </label>
      <label style="font-size:11px;color:rgba(255,255,255,0.65);display:flex;align-items:center;gap:6px;margin-top:2px;cursor:pointer;">
        <input data-def-key="stationary" type="checkbox" ${def.stationary ? 'checked' : ''} />
        Stationary (skip walk anim loading)
      </label>
    `
    for (const input of root.querySelectorAll('[data-def-key]')) {
      // 'input' fires every keystroke; 'change' only fires on blur for
      // number/text. Using 'input' makes the Save NPC defs button light up
      // the moment the user starts typing so it's obvious there are unsaved
      // changes. Checkboxes only fire 'change' (no 'input'), so listen to
      // both — 'change' covers checkbox; 'input' covers everything else.
      const evt = input.type === 'checkbox' ? 'change' : 'input'
      input.addEventListener(evt, () => {
        const key = input.dataset.defKey
        if (input.type === 'checkbox') {
          def[key] = input.checked
        } else if (input.type === 'number') {
          def[key] = parseFloat(input.value) || 0
        } else {
          def[key] = input.value
        }
        markDefsDirty()
        // Reflect Name updates in the dropdown live.
        if (key === 'name') {
          const sel = sidebar.querySelector('#npcTypeSelect')
          if (sel) {
            for (const opt of sel.options) {
              if (parseInt(opt.value) === def.id) opt.textContent = `${def.name} (ID ${def.id}) — HP ${def.health}`
            }
          }
        }
      })
    }
  }

  // Render a palette-swatch row for the appearance editor — values map to
  // shared/appearance.ts arrays. Returns the row element.
  function appearanceSwatchRow(label, palette, currentValue, onChange) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'margin-bottom:6px;'
    const lbl = document.createElement('div')
    lbl.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.65);margin-bottom:3px;'
    lbl.textContent = label
    wrap.appendChild(lbl)
    const swatches = document.createElement('div')
    swatches.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;'
    for (let i = 0; i < palette.length; i++) {
      const [r, g, b] = palette[i]
      const sw = document.createElement('button')
      const sel = (i === currentValue)
      sw.style.cssText = `width:18px;height:18px;border-radius:3px;cursor:pointer;background:rgb(${Math.round(r*255)},${Math.round(g*255)},${Math.round(b*255)});border:${sel ? '2px solid #ffcc44' : '1px solid #333'};padding:0;`
      sw.title = `#${i}`
      sw.addEventListener('click', () => onChange(i))
      swatches.appendChild(sw)
    }
    wrap.appendChild(swatches)
    return wrap
  }

  function renderAppearanceTab(root) {
    root.innerHTML = ''
    const spawn = selectedNpcSpawn
    if (!spawn) {
      root.innerHTML = `<div class="hint">Click an NPC spawn to edit its appearance override.</div>`
      return
    }
    const toggle = document.createElement('label')
    toggle.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.85);display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px;'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!spawn.appearance
    toggle.appendChild(cb)
    toggle.appendChild(document.createTextNode('Override appearance for this spawn'))
    root.appendChild(toggle)
    cb.addEventListener('change', () => {
      if (cb.checked) {
        spawn.appearance = { ...DEFAULT_APPEARANCE }
        ensureNpcPreview(spawn)
      } else {
        spawn.appearance = undefined
        disposeNpcPreview(spawn)
      }
      // Swap the cylinder marker ↔ ground disc so the preview character isn't
      // bisected by the selection indicator.
      rebuildNpcSpawnMeshes()
      renderAppearanceTab(root)
      refreshNpcSpawnList()
    })
    if (!spawn.appearance) {
      const hint = document.createElement('div')
      hint.className = 'hint'
      hint.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.35);'
      hint.textContent = 'No override — this spawn uses the default look for its NPC type.'
      root.appendChild(hint)
      return
    }
    // Persist the swatch pick and rebuild the row so the selected highlight moves.
    const setField = (field, value) => {
      spawn.appearance[field] = value
      ensureNpcPreview(spawn)
      renderAppearanceTab(root)
      refreshNpcSpawnList()
    }
    root.appendChild(appearanceSwatchRow('Skin', SKIN_COLORS, spawn.appearance.skinColor, v => setField('skinColor', v)))
    root.appendChild(appearanceSwatchRow('Shirt', SHIRT_COLORS, spawn.appearance.shirtColor, v => setField('shirtColor', v)))
    root.appendChild(appearanceSwatchRow('Pants', PANTS_COLORS, spawn.appearance.pantsColor, v => setField('pantsColor', v)))
    root.appendChild(appearanceSwatchRow('Shoes', SHOES_COLORS, spawn.appearance.shoesColor, v => setField('shoesColor', v)))
    root.appendChild(appearanceSwatchRow('Belt', BELT_COLORS, spawn.appearance.beltColor, v => setField('beltColor', v)))
    root.appendChild(appearanceSwatchRow('Hair color', HAIR_COLORS, spawn.appearance.hairColor, v => setField('hairColor', v)))
    // Hair style is just an index 0..HAIR_STYLE_COUNT — no palette, use a slider.
    const hairWrap = document.createElement('div')
    hairWrap.style.cssText = 'margin-bottom:6px;'
    hairWrap.innerHTML = `
      <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-bottom:3px;">Hair style <span style="opacity:0.5;">${spawn.appearance.hairStyle}</span></div>
      <input type="range" min="0" max="${HAIR_STYLE_COUNT}" step="1" value="${spawn.appearance.hairStyle}" style="width:100%;" />
    `
    hairWrap.querySelector('input').addEventListener('input', (e) => {
      spawn.appearance.hairStyle = parseInt(e.target.value)
      e.currentTarget.previousElementSibling.querySelector('span').textContent = spawn.appearance.hairStyle
      ensureNpcPreview(spawn)
    })
    root.appendChild(hairWrap)
  }

  function renderEquipmentTab(root) {
    root.innerHTML = ''
    const spawn = selectedNpcSpawn
    if (!spawn) {
      root.innerHTML = `<div class="hint">Click an NPC spawn to edit equipment.</div>`
      return
    }
    const toggle = document.createElement('label')
    toggle.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.85);display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px;'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = Array.isArray(spawn.equipment) && spawn.equipment.length === 10
    toggle.appendChild(cb)
    toggle.appendChild(document.createTextNode('Override equipment for this spawn'))
    root.appendChild(toggle)
    cb.addEventListener('change', () => {
      spawn.equipment = cb.checked ? [0,0,0,0,0,0,0,0,0,0] : undefined
      renderEquipmentTab(root)
    })
    if (!Array.isArray(spawn.equipment)) {
      const hint = document.createElement('div')
      hint.className = 'hint'
      hint.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.35);'
      hint.textContent = 'Equipment overrides require Appearance override too (gear renders only on 3D-character NPCs).'
      root.appendChild(hint)
      return
    }
    const SLOT_LABELS = ['Weapon','Shield','Head','Body','Legs','Neck','Ring','Hands','Feet','Cape']
    for (let i = 0; i < 10; i++) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:3px;'
      row.innerHTML = `
        <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">${SLOT_LABELS[i]}</span>
        <input type="number" min="0" value="${spawn.equipment[i] ?? 0}" style="width:80px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
      `
      const slotIdx = i
      row.querySelector('input').addEventListener('change', (e) => {
        spawn.equipment[slotIdx] = parseInt(e.target.value) || 0
      })
      root.appendChild(row)
    }
    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.35);margin-top:4px;'
    hint.textContent = 'Item IDs — see server/data/items.json. 0 = empty slot.'
    root.appendChild(hint)
  }

  /** Append a "Shared (def) | Override (this spawn)" mode toggle. Used by
   *  the Shop and Dialogue tabs — both edit either a shared NpcDef field or
   *  a per-spawn override of it. The disabled state for "Override" handles
   *  the "no spawn selected" case so the user understands why it's greyed. */
  function appendOverrideModeToggle(root, { overrideActive, hasSpawn, onSelectDef, onSelectOverride }) {
    const modeRow = document.createElement('div')
    modeRow.style.cssText = 'display:flex;gap:5px;margin-bottom:8px;'
    const make = (label, active) => {
      const btn = document.createElement('button')
      btn.textContent = label
      btn.style.cssText = `flex:1;font-size:10px;padding:4px;background:${active ? '#2a2a2a' : '#1a1a1a'};color:#fff;border:1px solid ${active ? '#666' : '#444'};cursor:pointer;border-radius:3px;`
      return btn
    }
    const defBtn = make('Shared (def)', !overrideActive)
    const ovrBtn = make('Override (this spawn)', overrideActive)
    if (!hasSpawn) ovrBtn.disabled = true
    defBtn.addEventListener('click', onSelectDef)
    ovrBtn.addEventListener('click', onSelectOverride)
    modeRow.appendChild(defBtn)
    modeRow.appendChild(ovrBtn)
    root.appendChild(modeRow)
  }

  function renderShopTab(root, def) {
    root.innerHTML = ''
    const spawn = selectedNpcSpawn
    if (!def) {
      root.innerHTML = `<div class="hint">Select an NPC spawn to edit its shop.</div>`
      return
    }
    // Mode toggle: edit the def's shop (affects every spawn of this NPC), or
    // a per-spawn override (this single placement). Default = def-level.
    const overrideActive = !!(spawn && spawn.shop)
    appendOverrideModeToggle(root, {
      overrideActive,
      hasSpawn: !!spawn,
      onSelectDef: () => {
        if (spawn) spawn.shop = undefined
        renderShopTab(root, def)
      },
      onSelectOverride: () => {
        if (spawn && !spawn.shop) {
          // Seed override from the def so the user has a starting point.
          spawn.shop = def.shop
            ? { name: def.shop.name, items: def.shop.items.map(i => ({ ...i })) }
            : { name: `${def.name}'s Shop`, items: [] }
        }
        renderShopTab(root, def)
      },
    })

    // Target object — the shop being edited (either def.shop or spawn.shop).
    const targetIsOverride = overrideActive
    const target = targetIsOverride ? spawn.shop : def.shop
    const hasShop = !!target

    const toggleRow = document.createElement('label')
    toggleRow.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.85);display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px;'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = hasShop
    toggleRow.appendChild(cb)
    toggleRow.appendChild(document.createTextNode(targetIsOverride ? 'Has shop (per spawn)' : 'Has shop (shared)'))
    root.appendChild(toggleRow)
    cb.addEventListener('change', () => {
      if (cb.checked) {
        const blank = { name: `${def.name}'s Shop`, items: [] }
        if (targetIsOverride) spawn.shop = blank
        else { def.shop = blank; markDefsDirty() }
      } else {
        if (targetIsOverride) spawn.shop = undefined
        else { def.shop = undefined; markDefsDirty() }
      }
      renderShopTab(root, def)
    })

    if (!hasShop) return

    // Shop name
    const nameRow = document.createElement('div')
    nameRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;'
    nameRow.innerHTML = `
      <span style="flex:0;font-size:11px;color:rgba(255,255,255,0.65);">Name</span>
      <input type="text" value="${target.name ?? ''}" style="flex:1;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
    `
    nameRow.querySelector('input').addEventListener('input', (e) => {
      target.name = e.target.value
      if (!targetIsOverride) markDefsDirty()
    })
    root.appendChild(nameRow)

    // Items list — two rows per item to fit the narrow sidebar without
    // truncating item names. Row 1: searchable item picker + delete; row 2:
    // labelled Price + Stock inputs.
    const items = target.items || (target.items = [])
    const list = document.createElement('div')
    list.style.cssText = 'border:1px solid #333;border-radius:3px;padding:6px;background:#161616;max-height:60vh;overflow-y:auto;'

    const needsItemDefs = itemDefs.length === 0
    if (needsItemDefs) {
      // Item picker autocomplete depends on the datalist; show a brief
      // placeholder while items.json loads, then re-render with full UX.
      const loading = document.createElement('div')
      loading.style.cssText = 'font-size:11px;color:#888;text-align:center;padding:8px;'
      loading.textContent = 'Loading item list…'
      list.appendChild(loading)
      root.appendChild(list)
      fetchItemDefsOnce().then(() => {
        ensureShopItemDatalist()
        renderShopTab(root, def)
      })
      return
    }
    ensureShopItemDatalist()

    for (let i = 0; i < items.length; i++) {
      const idx = i
      const item = items[i]
      const entry = document.createElement('div')
      entry.style.cssText = `display:flex;flex-direction:column;gap:3px;padding:4px;margin-bottom:4px;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:3px;`

      // Row 1: item picker + delete
      const row1 = document.createElement('div')
      row1.style.cssText = 'display:flex;gap:4px;align-items:center;'
      const itemInput = document.createElement('input')
      itemInput.type = 'text'
      itemInput.setAttribute('list', 'shopItemDatalist')
      itemInput.placeholder = 'Search item name or ID'
      itemInput.value = formatItemDisplay(item.itemId)
      itemInput.style.cssText = 'flex:1;min-width:0;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:4px 5px;font-size:11px;'
      const delBtn = document.createElement('button')
      delBtn.textContent = '×'
      delBtn.title = 'Remove item'
      delBtn.style.cssText = 'flex:0 0 auto;width:22px;height:22px;background:#6c2a2a;color:#fff;border:none;border-radius:3px;cursor:pointer;font-size:13px;line-height:1;'
      row1.appendChild(itemInput)
      row1.appendChild(delBtn)

      // Row 2: Price + Stock
      const row2 = document.createElement('div')
      row2.style.cssText = 'display:flex;gap:6px;align-items:center;font-size:10px;color:rgba(255,255,255,0.55);'
      const priceInput = document.createElement('input')
      priceInput.type = 'number'
      priceInput.min = '0'
      priceInput.value = String(item.price)
      priceInput.style.cssText = 'width:56px;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;'
      const stockInput = document.createElement('input')
      stockInput.type = 'number'
      stockInput.min = '0'
      stockInput.value = String(item.stock)
      stockInput.style.cssText = 'width:56px;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;'
      row2.innerHTML = '<span>Price</span>'
      row2.appendChild(priceInput)
      const stockLbl = document.createElement('span')
      stockLbl.textContent = 'Stock'
      stockLbl.style.marginLeft = '6px'
      row2.appendChild(stockLbl)
      row2.appendChild(stockInput)

      // Wiring
      const dirty = () => { if (!targetIsOverride) markDefsDirty() }
      itemInput.addEventListener('change', () => {
        const id = parseItemIdFromDisplay(itemInput.value)
        items[idx].itemId = id
        // Normalize the display back to canonical "Name (ID)" so an ID-only
        // entry gets its name filled in, and an unresolvable string visibly
        // resets to the raw ID instead of looking valid.
        itemInput.value = formatItemDisplay(id)
        const recognised = itemDefs.some(d => d.id === id)
        itemInput.style.borderColor = (id > 0 && recognised) ? '#444' : '#aa5544'
        dirty()
      })
      priceInput.addEventListener('change', () => { items[idx].price = parseInt(priceInput.value) || 0; dirty() })
      stockInput.addEventListener('change', () => { items[idx].stock = parseInt(stockInput.value) || 0; dirty() })
      delBtn.addEventListener('click', () => {
        items.splice(idx, 1)
        dirty()
        renderShopTab(root, def)
      })

      entry.appendChild(row1)
      entry.appendChild(row2)
      list.appendChild(entry)
    }
    root.appendChild(list)

    const addBtn = document.createElement('button')
    addBtn.textContent = '+ Add item'
    addBtn.style.cssText = 'width:100%;margin-top:6px;font-size:11px;padding:6px;background:#2a3a4a;color:#fff;border:1px solid #555;border-radius:3px;cursor:pointer;'
    addBtn.addEventListener('click', () => {
      // Default to itemId 0 so the user immediately sees the empty picker and
      // knows they need to choose one. The validation border (#aa5544) makes
      // unset rows visually loud.
      items.push({ itemId: 0, price: 1, stock: 1 })
      if (!targetIsOverride) markDefsDirty()
      renderShopTab(root, def)
    })
    root.appendChild(addBtn)
  }

  function renderDialogueTab(root, def) {
    root.innerHTML = ''
    const spawn = selectedNpcSpawn
    if (!def) {
      root.innerHTML = `<div class="hint">Select an NPC spawn to edit its dialogue.</div>`
      return
    }
    const overrideActive = !!(spawn && spawn.dialogue)
    appendOverrideModeToggle(root, {
      overrideActive,
      hasSpawn: !!spawn,
      onSelectDef: () => {
        if (spawn) spawn.dialogue = undefined
        renderDialogueTab(root, def)
      },
      onSelectOverride: () => {
        if (spawn && !spawn.dialogue) {
          // Deep-copy from the def so editing the override doesn't mutate
          // the shared tree.
          spawn.dialogue = def.dialogue
            ? JSON.parse(JSON.stringify(def.dialogue))
            : { root: 'start', nodes: { start: { id: 'start', lines: ['Hello!'], options: [{ label: 'Bye.' }] } } }
        }
        renderDialogueTab(root, def)
      },
    })

    const targetIsOverride = overrideActive
    const target = targetIsOverride ? spawn.dialogue : def.dialogue

    const toggleRow = document.createElement('label')
    toggleRow.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.85);display:flex;align-items:center;gap:6px;cursor:pointer;margin-bottom:6px;'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!target
    toggleRow.appendChild(cb)
    toggleRow.appendChild(document.createTextNode(targetIsOverride ? 'Has dialogue (per spawn)' : 'Has dialogue (shared)'))
    root.appendChild(toggleRow)
    cb.addEventListener('change', () => {
      const blank = { root: 'start', nodes: { start: { id: 'start', lines: ['Hello!'], options: [{ label: 'Bye.' }] } } }
      if (cb.checked) {
        if (targetIsOverride) spawn.dialogue = blank
        else { def.dialogue = blank; markDefsDirty() }
      } else {
        if (targetIsOverride) spawn.dialogue = undefined
        else { def.dialogue = undefined; markDefsDirty() }
      }
      renderDialogueTab(root, def)
    })

    if (!target) return

    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.4);margin-bottom:4px;'
    hint.innerHTML = `JSON view. Tree must have a <code>root</code> node id and a <code>nodes</code> map.<br>Actions: <code>openShop</code>, <code>openBank</code>, <code>openAppearance</code>, <code>giveItem</code>, <code>takeItem</code>, <code>closeDialogue</code>, <code>setQuestStage</code>, <code>completeQuest</code>.<br>Option gating: add <code>"requires": { "questId": "...", "minStage": N, "maxStage": N, "notStarted": true }</code> to hide options unless quest state matches.`
    root.appendChild(hint)

    const ta = document.createElement('textarea')
    ta.value = JSON.stringify(target, null, 2)
    ta.style.cssText = 'width:100%;height:240px;background:#0d0d0d;color:#cfc;border:1px solid #444;border-radius:3px;padding:5px;font-family:monospace;font-size:10px;resize:vertical;'
    root.appendChild(ta)
    const status = document.createElement('div')
    status.style.cssText = 'font-size:10px;color:#888;margin-top:3px;min-height:14px;'
    root.appendChild(status)
    ta.addEventListener('change', () => {
      try {
        const parsed = JSON.parse(ta.value)
        if (typeof parsed.root !== 'string' || !parsed.nodes || typeof parsed.nodes !== 'object') {
          status.textContent = 'Tree must have root (string) and nodes (object)'
          status.style.color = '#e44'
          return
        }
        if (!parsed.nodes[parsed.root]) {
          status.textContent = `root "${parsed.root}" not in nodes`
          status.style.color = '#e44'
          return
        }
        if (targetIsOverride) spawn.dialogue = parsed
        else { def.dialogue = parsed; markDefsDirty() }
        status.textContent = 'valid ✓'
        status.style.color = '#6c6'
      } catch (e) {
        status.textContent = `parse error: ${e.message}`
        status.style.color = '#e44'
      }
    })
  }

  // --- Texture plane rotation panel ---
  const _rad2deg = r => Math.round(r * 180 / Math.PI)
  const _deg2rad = d => d * Math.PI / 180

  function syncPlaneRotationUI() {
    if (!selectedTexturePlane) return
    const r = selectedTexturePlane.rotation
    sidebar.querySelector('#planeRotX').value = r.x ?? 0
    sidebar.querySelector('#planeRotY').value = r.y ?? 0
    sidebar.querySelector('#planeRotZ').value = r.z ?? 0
    sidebar.querySelector('#planeRotXNum').value = _rad2deg(r.x ?? 0)
    sidebar.querySelector('#planeRotYNum').value = _rad2deg(r.y ?? 0)
    sidebar.querySelector('#planeRotZNum').value = _rad2deg(r.z ?? 0)
  }

  for (const btn of sidebar.querySelectorAll('.plane-preset-btn')) {
    btn.addEventListener('click', () => {
      if (!selectedTexturePlane) return
      selectedTexturePlane.rotation.x = parseFloat(btn.dataset.rx)
      selectedTexturePlane.rotation.y = parseFloat(btn.dataset.ry)
      selectedTexturePlane.rotation.z = parseFloat(btn.dataset.rz)
      updateTexturePlaneMeshTransform(selectedTexturePlane)
      updateSelectionHelper()
      syncPlaneRotationUI()
    })
  }

  for (const axis of ['X', 'Y', 'Z']) {
    const slider = sidebar.querySelector(`#planeRot${axis}`)
    const num = sidebar.querySelector(`#planeRot${axis}Num`)
    slider?.addEventListener('input', () => {
      if (!selectedTexturePlane) return
      selectedTexturePlane.rotation[axis.toLowerCase()] = parseFloat(slider.value)
      updateTexturePlaneMeshTransform(selectedTexturePlane)
      updateSelectionHelper()
      num.value = _rad2deg(parseFloat(slider.value))
    })
    num?.addEventListener('change', () => {
      if (!selectedTexturePlane) return
      const rad = _deg2rad(parseFloat(num.value) || 0)
      selectedTexturePlane.rotation[axis.toLowerCase()] = rad
      slider.value = rad
      updateTexturePlaneMeshTransform(selectedTexturePlane)
      updateSelectionHelper()
    })
  }

  // --- Collision tool sub-mode buttons ---
  const collModes = { wall: 'collWallBtn', block: 'collBlockBtn', floor: 'collFloorBtn', stair: 'collStairBtn', hole: 'collHoleBtn' }
  const collPanels = { wall: 'collWallPanel', block: 'collBlockPanel', floor: 'collFloorPanel', stair: 'collStairPanel', hole: 'collHolePanel' }
  for (const [mode, btnId] of Object.entries(collModes)) {
    sidebar.querySelector(`#${btnId}`)?.addEventListener('click', () => {
      collisionMode = mode
      for (const [m, bid] of Object.entries(collModes)) {
        sidebar.querySelector(`#${bid}`)?.classList.toggle('active-tool', m === mode)
      }
      for (const [m, pid] of Object.entries(collPanels)) {
        const el = sidebar.querySelector(`#${pid}`)
        if (el) el.style.display = m === mode ? 'block' : 'none'
      }
    })
  }

  sidebar.querySelector('#wallHeightSlider')?.addEventListener('input', (e) => {
    sidebar.querySelector('#wallHeightLabel').textContent = parseFloat(e.target.value).toFixed(1)
  })

  sidebar.querySelector('#collFloorLevelSlider')?.addEventListener('input', (e) => {
    collisionFloor = parseInt(e.target.value)
    sidebar.querySelector('#collFloorLevel').textContent = collisionFloor
    rebuildCollisionMeshes()
  })


  for (const btn of sidebar.querySelectorAll('.stair-dir-btn')) {
    btn.addEventListener('click', () => {
      stairDirection = btn.dataset.dir
      for (const b of sidebar.querySelectorAll('.stair-dir-btn')) b.classList.toggle('active-tool', b === btn)
    })
  }

  sidebar.querySelector('#wallDrawBtn')?.addEventListener('click', () => {
    wallEraseMode = false
    sidebar.querySelector('#wallDrawBtn')?.classList.add('active-tool')
    sidebar.querySelector('#wallEraseBtn')?.classList.remove('active-tool')
  })
  sidebar.querySelector('#wallEraseBtn')?.addEventListener('click', () => {
    wallEraseMode = true
    sidebar.querySelector('#wallEraseBtn')?.classList.add('active-tool')
    sidebar.querySelector('#wallDrawBtn')?.classList.remove('active-tool')
  })

  sidebar.querySelector('#clearAllWallsBtn')?.addEventListener('click', () => {
    pushUndoState('collision')
    const layer = getCollisionLayer()
    layer.walls = {}
    layer.wallHeights = {}
    rebuildCollisionMeshes()
    statusText.textContent = 'Cleared all walls on floor ' + collisionFloor
  })

  // --- Chunk-based auto-wall system ---
  const WALL_CHUNK_SIZE = 64

  function buildWallChunkDropdown() {
    const select = sidebar.querySelector('#wallChunkSelect')
    if (!select) return
    select.innerHTML = ''
    const chunksX = Math.ceil(map.width / WALL_CHUNK_SIZE)
    const chunksZ = Math.ceil(map.height / WALL_CHUNK_SIZE)
    let i = 0
    for (let cz = 0; cz < chunksZ; cz++) {
      for (let cx = 0; cx < chunksX; cx++) {
        const opt = document.createElement('option')
        opt.value = `${cx},${cz}`
        opt.textContent = `Chunk ${i} (${cx},${cz})`
        select.appendChild(opt)
        i++
      }
    }
  }
  buildWallChunkDropdown()

  function getSelectedWallChunk() {
    const val = sidebar.querySelector('#wallChunkSelect')?.value || '0,0'
    const [cx, cz] = val.split(',').map(Number)
    return { cx, cz }
  }

  function getChunkRegion(chunk) {
    return {
      x1: chunk.cx * WALL_CHUNK_SIZE,
      z1: chunk.cz * WALL_CHUNK_SIZE,
      x2: Math.min((chunk.cx + 1) * WALL_CHUNK_SIZE - 1, map.width - 1),
      z2: Math.min((chunk.cz + 1) * WALL_CHUNK_SIZE - 1, map.height - 1)
    }
  }

  function autoDetectWallsInRegion(region) {
    let count = 0
    // Determine the expected Y range for the current collision floor
    // Floor 0 = ground level (terrain height), upper floors have elevated floor heights
    const layer = getCollisionLayer()
    const floorLevel = collisionFloor

    for (const obj of placedGroup.getChildren()) {
      const assetId = obj.userData?.assetId
      if (!assetId) continue
      const asset = assetRegistry.find(a => a.id === assetId)
      if (!asset?.name?.toLowerCase().includes('wall')) continue

      let min, max
      try {
        const b = obj.getHierarchyBoundingVectors(true)
        min = b.min; max = b.max
      } catch { continue }

      // Skip walls that belong to a different floor level
      // Ground floor walls should have their base near terrain height
      // Upper floor walls should have their base near the floor height of that level
      const wallBaseY = min.y
      const wallMidX = (min.x + max.x) / 2
      const wallMidZ = (min.z + max.z) / 2
      const terrainH = map.getAverageTileHeight(Math.floor(wallMidX), Math.floor(wallMidZ))

      if (floorLevel === 0) {
        // Ground floor: only include walls whose base is near terrain height (within 1.5 units)
        if (wallBaseY > terrainH + 1.5) continue
      } else {
        // Upper floor: wall must be elevated above terrain (i.e. NOT a ground-level wall)
        if (wallBaseY < terrainH + 1.0) continue
      }

      const sizeX = max.x - min.x
      const sizeZ = max.z - min.z
      const isXAligned = sizeX > sizeZ
      const isZAligned = sizeZ > sizeX

      const tileX0 = Math.floor(min.x)
      const tileX1 = Math.floor(max.x - 0.01)
      const tileZ0 = Math.floor(min.z)
      const tileZ1 = Math.floor(max.z - 0.01)

      for (let tx = tileX0; tx <= tileX1; tx++) {
        for (let tz = tileZ0; tz <= tileZ1; tz++) {
          if (tx < 0 || tz < 0 || tx >= map.width || tz >= map.height) continue
          if (tx < region.x1 || tx > region.x2 || tz < region.z1 || tz > region.z2) continue

          const wallCenterInTileX = ((min.x + max.x) / 2) - tx
          const wallCenterInTileZ = ((min.z + max.z) / 2) - tz

          let edge = 0
          if (isXAligned) {
            edge = wallCenterInTileZ < 0.5 ? 1 : 4
          } else if (isZAligned) {
            edge = wallCenterInTileX < 0.5 ? 8 : 2
          } else {
            const ne = getNearestEdge(tx, tz, wallCenterInTileX, wallCenterInTileZ)
            edge = ne.edge
          }

          const current = getWallAt(tx, tz)
          if (!(current & edge)) {
            setWallAt(tx, tz, current | edge)
            count++
          }
          // Mirror the edge to the neighboring tile so both sides are blocked
          // N(1) <-> S(4), E(2) <-> W(8)
          const mirror = { 1: { dx: 0, dz: -1, e: 4 }, 4: { dx: 0, dz: 1, e: 1 }, 2: { dx: 1, dz: 0, e: 8 }, 8: { dx: -1, dz: 0, e: 2 } }
          const m = mirror[edge]
          if (m) {
            const nx = tx + m.dx, nz = tz + m.dz
            if (nx >= 0 && nz >= 0 && nx < map.width && nz < map.height) {
              const ncurrent = getWallAt(nx, nz)
              if (!(ncurrent & m.e)) {
                setWallAt(nx, nz, ncurrent | m.e)
                count++
              }
            }
          }
        }
      }
    }
    return count
  }

  sidebar.querySelector('#autoWallsBtn')?.addEventListener('click', () => {
    const chunk = getSelectedWallChunk()
    pushUndoState('collision')
    const region = getChunkRegion(chunk)
    const count = autoDetectWallsInRegion(region)
    rebuildCollisionMeshes()
    statusText.textContent = `Auto-detected ${count} wall edges in chunk (${chunk.cx},${chunk.cz})`
  })

  sidebar.querySelector('#clearRegionWallsBtn')?.addEventListener('click', () => {
    const chunk = getSelectedWallChunk()
    const region = getChunkRegion(chunk)
    pushUndoState('collision')
    let count = 0
    for (let x = region.x1; x <= region.x2; x++) {
      for (let z = region.z1; z <= region.z2; z++) {
        if (getWallAt(x, z) !== 0) {
          setWallAt(x, z, 0)
          count++
        }
      }
    }
    rebuildCollisionMeshes()
    statusText.textContent = `Cleared ${count} wall tiles in chunk (${chunk.cx},${chunk.cz})`
  })

  const smoothModeBtn = sidebar.querySelector('#toggleSmoothMode')
  const levelModeBtn = sidebar.querySelector('#toggleLevelMode')
  const saveMapBtn = topBar.querySelector('#saveMapBtn')
  const mapSizeLabel = topBar.querySelector('#mapSizeLabel')
  const statusText = statusBar.querySelector('#statusText')
  const hoverText = statusBar.querySelector('#hoverText')

  const tabProps = sidebar.querySelector('#tabProps')
  const tabModular = sidebar.querySelector('#tabModular')
  const tabWalls = sidebar.querySelector('#tabWalls')
  const tabRoofs = sidebar.querySelector('#tabRoofs')
  const tabBought = sidebar.querySelector('#tabBought')
  const assetGroupSelect = sidebar.querySelector('#assetGroupSelect')
  const assetSearch = sidebar.querySelector('#assetSearch')
  const assetGrid = sidebar.querySelector('#assetGrid')
  const refreshPreviewBtn = sidebar.querySelector('#refreshPreviewBtn')
  const placeScaleSlider = sidebar.querySelector('#placeScaleSlider')
  const placeScaleLabel = sidebar.querySelector('#placeScaleLabel')

  const textureSearch = sidebar.querySelector('#textureSearch')
  const texturePalette = sidebar.querySelector('#texturePalette')
  const useTexturePlaneBtn = sidebar.querySelector('#useTexturePlaneBtn')
  const textureScaleSlider = sidebar.querySelector('#textureScale')
  const rotateTextureBtn = sidebar.querySelector('#rotateTextureBtn')

  // Tile-size preset buttons in select panel
  for (const btn of sidebar.querySelectorAll('.tile-size-btn')) {
    btn.addEventListener('click', () => {
      if (!selectedPlacedObject) return
      const tiles = parseFloat(btn.dataset.tiles)
      pushUndoState('objects')
      scaleObjectToTiles(selectedPlacedObject, tiles)
      updateSelectionHelper()
      invalidateShadowCache()
    })
  }
  const customTileSizeInput = sidebar.querySelector('#customTileSize')
  const applyCustomTileSizeBtn = sidebar.querySelector('#applyCustomTileSize')
  applyCustomTileSizeBtn?.addEventListener('click', () => {
    if (!selectedPlacedObject) return
    const tiles = parseFloat(customTileSizeInput.value)
    if (!isFinite(tiles) || tiles <= 0) return
    pushUndoState('objects')
    scaleObjectToTiles(selectedPlacedObject, tiles)
    updateSelectionHelper()
    invalidateShadowCache()
  })

  // Trigger metadata handlers
  function saveTriggerFromUI() {
    if (!selectedPlacedObject) return
    const type = sidebar.querySelector('#triggerType').value
    if (!type) {
      delete selectedPlacedObject.userData.trigger
      return
    }
    selectedPlacedObject.userData.trigger = {
      type,
      destChunk: sidebar.querySelector('#triggerDestChunk').value.trim(),
      entryX: parseFloat(sidebar.querySelector('#triggerEntryX').value) || 0,
      entryY: parseFloat(sidebar.querySelector('#triggerEntryY').value) || 0,
      entryZ: parseFloat(sidebar.querySelector('#triggerEntryZ').value) || 0
    }
  }

  sidebar.querySelector('#triggerType').addEventListener('change', () => {
    const isTP = sidebar.querySelector('#triggerType').value === 'teleport'
    sidebar.querySelector('#triggerTeleportFields').style.display = isTP ? 'block' : 'none'
    saveTriggerFromUI()
  })

  for (const id of ['#triggerDestChunk', '#triggerEntryX', '#triggerEntryY', '#triggerEntryZ']) {
    sidebar.querySelector(id).addEventListener('change', saveTriggerFromUI)
  }

  // Per-tile interaction bitmask in local frame: 4*W bits enumerating
  // cardinal-adjacent tiles in canonical CW order (see shared/objectFootprint).
  // For width=1 the 4 bits coincide with the legacy F/R/B/L layout.
  function placedObjectWidth(obj) {
    const defId = obj ? ASSET_TO_OBJECT_DEF[obj.userData?.assetId] : null
    if (defId == null) return 1
    const def = objectDefs.find(d => d.id === defId)
    return Math.max(1, Math.round(def?.width ?? 1))
  }
  function setInteractionMask(mask, opts = {}) {
    if (!selectedPlacedObject) return
    if (mask === 0) delete selectedPlacedObject.userData.interactionSides
    else selectedPlacedObject.userData.interactionSides = mask | 0
    if (opts.rerender !== false) renderInteractionTilesGrid()
    updateSelectionHelper()
  }
  function renderInteractionTilesGrid() {
    const container = sidebar.querySelector('#interactionTilesGrid')
    if (!container || !selectedPlacedObject) return
    const W = placedObjectWidth(selectedPlacedObject)
    const mask = selectedPlacedObject.userData.interactionSides | 0
    const cell = 24
    const gap = 2
    container.innerHTML = ''
    container.style.cssText = `display:grid;gap:${gap}px;grid-template-columns:repeat(${W + 2},${cell}px);grid-template-rows:repeat(${W + 2},${cell}px);`
    // Build the bit-index lookup from grid (row, col) → bit. Reuse the canonical
    // local order so what the user clicks here is exactly what the runtime checks.
    const local = localAdjacentTilesOrdered(W)
    const startOff = -Math.floor((W - 1) / 2)
    const cellBit = new Map() // 'r,c' -> bitIndex
    for (let bit = 0; bit < local.length; bit++) {
      const { x: lx, z: lz } = local[bit]
      const col = (lx - startOff) + 1
      const row = W + 1 - (lz - startOff) // +Z up means row 0 = top
      cellBit.set(`${row},${col}`, bit)
    }
    for (let row = 0; row < W + 2; row++) {
      for (let col = 0; col < W + 2; col++) {
        const div = document.createElement('div')
        div.style.cssText = `width:${cell}px;height:${cell}px;box-sizing:border-box;font-size:9px;display:flex;align-items:center;justify-content:center;`
        const isFootprint = row >= 1 && row <= W && col >= 1 && col <= W
        const isCorner = (row === 0 || row === W + 1) && (col === 0 || col === W + 1)
        const bitIdx = cellBit.get(`${row},${col}`)
        if (isFootprint) {
          div.style.background = '#444'
          div.style.border = '1px solid #222'
          // Arrow on the front-center footprint cell so rotation is unambiguous.
          if (row === 1 && col === Math.ceil((W + 1) / 2)) {
            div.textContent = '↑'
            div.style.color = '#aaa'
          }
        } else if (isCorner) {
          div.style.visibility = 'hidden'
        } else if (bitIdx !== undefined) {
          const on = (mask & (1 << bitIdx)) !== 0
          div.style.background = on ? '#0a7' : '#1a1a1a'
          div.style.border = on ? '1px solid #0fa' : '1px solid #444'
          div.style.cursor = 'pointer'
          div.title = `Bit ${bitIdx}`
          div.addEventListener('click', () => setInteractionMask(mask ^ (1 << bitIdx)))
        }
        container.appendChild(div)
      }
    }
  }
  // Quick-set buttons. "Front only" is the common case for furnaces / ranges.
  sidebar.querySelector('#interactSidesAll')?.addEventListener('click', () => {
    if (!selectedPlacedObject) return
    const W = placedObjectWidth(selectedPlacedObject)
    const full = (1 << (4 * W)) - 1
    setInteractionMask(full)
  })
  sidebar.querySelector('#interactSidesNone')?.addEventListener('click', () => setInteractionMask(0))
  sidebar.querySelector('#interactSidesFront')?.addEventListener('click', () => {
    if (!selectedPlacedObject) return
    const W = placedObjectWidth(selectedPlacedObject)
    setInteractionMask((1 << W) - 1) // bits 0..W-1 = front row
  })

  const replaceBtnEl = sidebar.querySelector('#replaceBtn')
  const replacePanel = sidebar.querySelector('#replacePanel')
  const replaceSearchEl = sidebar.querySelector('#replaceSearch')
  const replaceGridEl = sidebar.querySelector('#replaceGrid')

  function buildReplaceGrid() {
    const q = replaceSearchEl.value.trim().toLowerCase()
    const assets = assetRegistry.filter((a) => {
      if (!a.path?.toLowerCase().includes('modular assets')) return false
      return !q || (a.name || a.id).toLowerCase().includes(q)
    })
    replaceGridEl.innerHTML = ''
    if (replaceGridThumbObserver) replaceGridThumbObserver.disconnect()
    replaceGridThumbObserver = createThumbObserver(replaceGridEl)
    for (const asset of assets) {
      const card = document.createElement('div')
      card.className = 'asset-card'
      const img = document.createElement('img')
      img.className = 'asset-thumb'
      img.alt = asset.name
      img.dataset.assetPath = asset.path
      const label = document.createElement('div')
      label.className = 'asset-label'
      label.textContent = asset.name
      card.appendChild(img)
      card.appendChild(label)
      replaceGridEl.appendChild(card)
      card.addEventListener('click', async () => {
        await replaceSelectedWith(asset.id)
        replacePanel.style.display = 'none'
        replaceBtnEl.textContent = 'Replace Selected'
      })
      generateThumbnail(asset).then((url) => { if (url) img.src = url })
      replaceGridThumbObserver.observe(img)
    }
  }

  replaceBtnEl?.addEventListener('click', () => {
    const isOpen = replacePanel.style.display !== 'none'
    replacePanel.style.display = isOpen ? 'none' : 'block'
    replaceBtnEl.textContent = isOpen ? 'Replace Selected' : 'Cancel'
    if (!isOpen) {
      replaceSearchEl.value = ''
      buildReplaceGrid()
    }
  })
  replaceSearchEl?.addEventListener('input', buildReplaceGrid)

  const replaceTextureBtnEl = sidebar.querySelector('#replaceTextureBtn')
  const replaceTexturePanel = sidebar.querySelector('#replaceTexturePanel')
  const replaceTextureSearchEl = sidebar.querySelector('#replaceTextureSearch')
  const replaceTextureGridEl = sidebar.querySelector('#replaceTextureGrid')

  function buildReplaceTextureGrid() {
    const q = replaceTextureSearchEl.value.trim().toLowerCase()
    const textures = textureRegistry.filter((t) =>
      !q || (t.name || t.id).toLowerCase().includes(q)
    )
    replaceTextureGridEl.innerHTML = ''
    for (const tex of textures) {
      const img = document.createElement('img')
      img.src = tex.path
      img.title = tex.name || tex.id
      img.style.cssText = 'width:56px;height:56px;object-fit:cover;border:2px solid transparent;border-radius:4px;cursor:pointer;display:block;'
      img.onerror = () => { img.style.border = '2px solid red' }
      img.addEventListener('click', () => {
        replaceSelectedTexturesWith(tex.id)
        replaceTexturePanel.style.display = 'none'
        replaceTextureBtnEl.textContent = 'Replace Texture'
      })
      replaceTextureGridEl.appendChild(img)
    }
  }

  replaceTextureBtnEl?.addEventListener('click', () => {
    const isOpen = replaceTexturePanel.style.display !== 'none'
    replaceTexturePanel.style.display = isOpen ? 'none' : 'block'
    replaceTextureBtnEl.textContent = isOpen ? 'Replace Texture' : 'Cancel'
    if (!isOpen) {
      replaceTextureSearchEl.value = ''
      buildReplaceTextureGrid()
    }
  })
  replaceTextureSearchEl?.addEventListener('input', buildReplaceTextureGrid)

  mapSizeLabel.textContent = `${map.width} x ${map.height}`



  const GROUND_TYPES_OVERWORLD = [
    { id: 'grass', label: 'Grass', color: '#3d8a20' },
    { id: 'dirt',  label: 'Dirt',  color: '#7a5030' },
    { id: 'sand',  label: 'Sand',  color: '#c4a245' },
    { id: 'path',  label: 'Path',  color: '#8a7860' },
    { id: 'road',  label: 'Road',  color: '#7a7870' },
    { id: 'desert',    label: 'Desert',    color: '#d4b880' },
    { id: 'sandstone', label: 'Sandstone', color: '#b07a48' },
    { id: 'rock',      label: 'Rock',      color: '#6b6860' },
    { id: 'drysand',   label: 'Dry Sand',  color: '#9e6b38' },
    { id: 'water', label: 'Mud', color: '#5a3d1a' },
    { id: 'surface-water', label: 'Paddy Water', color: '#7ab8c8' },
  ]

  const GROUND_TYPES_DUNGEON = [
    { id: 'dungeon-floor', label: 'Stone Floor', color: '#3a2e20' },
    { id: 'dungeon-rock',  label: 'Rock',        color: '#4a3828' },
    { id: 'dirt',          label: 'Dirt',         color: '#7a5030' },
    { id: 'water',         label: 'Mud',          color: '#5a3d1a' },
    { id: 'surface-water', label: 'Still Water',  color: '#7ab8c8' },
  ]

  let GROUND_TYPES = GROUND_TYPES_OVERWORLD

  function buildGroundSwatches() {
    const container = sidebar.querySelector('#groundSwatches')
    if (!container) return
    container.innerHTML = ''
    for (const gt of GROUND_TYPES) {
      const div = document.createElement('div')
      div.className = 'ground-swatch'
      div.dataset.type = gt.id
      div.innerHTML = `
        <div class="swatch-color" style="background:${gt.color}"></div>
        <div class="swatch-label">${gt.label}</div>
      `
      div.addEventListener('click', () => {
        state.paintType = gt.id
        paintTabTextureId = null
        setTool(ToolMode.PAINT)
        refreshPaintTexturePalette()
        updateToolUI()
      })
      container.appendChild(div)
    }
  }

  function updateSwatches() {
    for (const el of sidebar.querySelectorAll('.ground-swatch')) {
      el.classList.toggle('active', el.dataset.type === state.paintType)
    }
  }

  function applyLayerVisibility() {
    if (heightCullEnabled) { applyHeightCull(); return }
    for (const obj of placedGroup.getChildren()) {
      const layer = layers.find((l) => l.id === (obj.userData?.layerId || 'layer_0'))
      obj.setEnabled(layer ? layer.visible : true)
    }
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.getChildMeshes()) {
        const plane = mesh.metadata?.texturePlane
        if (!plane) continue
        const layer = layers.find((l) => l.id === (plane.layerId || 'layer_0'))
        mesh.isVisible = layer ? layer.visible : true
      }
    }
    // Ensure texture overlays are visible when not culling
    if (textureOverlayGroup) textureOverlayGroup.setEnabled(true)
  }

  function refreshLayersPanel() { /* removed */ }

  function updateToolUI() {
    for (const [mode, button] of Object.entries(toolButtons)) {
      if (button) button.classList.toggle('active-tool', state.tool === mode)
    }

    if (layersPanel.classList.contains('visible')) refreshLayersPanel()

    // Show only the active context panel
    const ctxMap = {
      [ToolMode.TERRAIN]: 'ctx-terrain',
      [ToolMode.PAINT]: 'ctx-paint',
      [ToolMode.PLACE]: 'ctx-place',
      [ToolMode.SELECT]: 'ctx-select',
      [ToolMode.TEXTURE_PLANE]: 'ctx-texture',
      [ToolMode.NPC_SPAWN]: 'ctx-npc-spawn',
      [ToolMode.COLLISION]: 'ctx-collision',
      [ToolMode.ITEM_SPAWN]: 'ctx-item-spawn',
      [ToolMode.BIOME]: 'ctx-biome',
    }
    biomeGroup.setEnabled(state.tool === ToolMode.BIOME)
    for (const id of ['ctx-terrain', 'ctx-paint', 'ctx-place', 'ctx-select', 'ctx-texture', 'ctx-npc-spawn', 'ctx-item-spawn', 'ctx-collision', 'ctx-biome']) {
      const el = sidebar.querySelector(`#${id}`)
      if (el) el.style.display = 'none'
    }
    const activeCtx = ctxMap[state.tool]
    if (activeCtx) {
      const el = sidebar.querySelector(`#${activeCtx}`)
      if (el) el.style.display = 'block'
    }

    updateSwatches()

    smoothModeBtn.textContent = `Smooth Mode: ${state.smoothMode ? 'On' : 'Off'}`
    smoothModeBtn.classList.toggle('active-tool', state.smoothMode)

    levelModeBtn.textContent = `Level Mode: ${state.levelMode ? 'On' : 'Off'}`
    levelModeBtn.classList.toggle('active-tool', state.levelMode)

    levelHeightRow.style.display = state.levelMode ? 'block' : 'none'
    if (state.levelMode && state.levelHeight !== null && document.activeElement !== levelHeightInput) {
      levelHeightInput.value = state.levelHeight.toFixed(2)
    }

    useTexturePlaneBtn.classList.toggle('active-tool', state.tool === ToolMode.TEXTURE_PLANE)


    const vpCheckbox = sidebar.querySelector('#toggleTexturePlaneV')
    if (vpCheckbox) vpCheckbox.checked = texturePlaneVertical

    // Status bar
    let status = toolLabel(state.tool)
    if (state.tool === ToolMode.PAINT) {
      if (paintTabTextureId === '__erase__') status += ' · Erase Texture'
      else if (paintTabTextureId) status += ` · Texture: ${paintTabTextureId}`
      else status += ` · ${state.paintType}`
    }
    if (state.tool === ToolMode.PLACE && selectedAssetId) {
      const asset = assetRegistry.find((a) => a.id === selectedAssetId)
      status += ` · ${asset?.name || selectedAssetId}`
    }
    if (state.tool === ToolMode.TEXTURE_PLANE) {
      status += ` · ${selectedTextureId || 'no texture'}`
    }

    const eraseBtn = sidebar.querySelector('#eraseTextureBrushBtn')
    if (eraseBtn) eraseBtn.classList.toggle('active-tool', state.tool === ToolMode.PAINT && paintTabTextureId === '__erase__')

    // Show scale slider for painted textures (non-stretched, non-erase)
    if (paintTextureScaleRow) {
      const showScale = state.tool === ToolMode.PAINT && paintTabTextureId && paintTabTextureId !== '__erase__' && textureWorldUV
      paintTextureScaleRow.style.display = showScale ? 'block' : 'none'
    }
    if (state.tool === ToolMode.TEXTURE_PLANE) {
      status += ` · ${diagFloorMode ? 'diagonal floor' : texturePlaneVertical ? 'vertical' : 'horizontal'}`
      if (diagFloorMode && diagFloorStart) status += ' · click end point'
    }
    if (state.tool === ToolMode.PAINT && diagFloorMode && paintTabTextureId && paintTabTextureId !== '__erase__') {
      status += ' · diagonal floor'
      if (diagFloorStart) status += ' · click end point'
    }
    const diagOpts = sidebar.querySelector('#diagFloorOptions')
    if (diagOpts) diagOpts.style.display = diagFloorMode ? 'block' : 'none'
    const diagCb = sidebar.querySelector('#toggleDiagFloor')
    if (diagCb) diagCb.checked = diagFloorMode
    const paintDiagOpts = sidebar.querySelector('#paintDiagFloorOptions')
    if (paintDiagOpts) paintDiagOpts.style.display = diagFloorMode ? 'block' : 'none'
    const paintDiagCb = sidebar.querySelector('#paintToggleDiagFloor')
    if (paintDiagCb) paintDiagCb.checked = diagFloorMode
    if (state.tool === ToolMode.TERRAIN && state.smoothMode) status += ' · Smooth Mode'
    if (state.tool === ToolMode.TERRAIN && state.levelMode) {
      status += ' · Level Mode'
      if (state.levelHeight !== null) status += ` @ ${state.levelHeight.toFixed(2)}`
    }
    if (state.tool === ToolMode.NPC_SPAWN) {
      const sel = sidebar.querySelector('#npcTypeSelect')
      const npcName = sel?.options[sel.selectedIndex]?.text || ''
      if (npcName) status += ` · ${npcName}`
      if (selectedNpcSpawn) status += ' · Spawn selected'
    }
    if (selectedTexturePlane) status += ` · Plane: ${selectedTexturePlane.textureId}`
    if (selectedPlacedObject) status += ' · Object selected'

    const tileSizeRow = sidebar.querySelector('#tileSizeRow')
    if (tileSizeRow) {
      tileSizeRow.style.display = (state.tool === ToolMode.SELECT && selectedPlacedObject) ? 'block' : 'none'
    }
    const triggerRow = sidebar.querySelector('#triggerRow')
    if (triggerRow) {
      const showTrigger = state.tool === ToolMode.SELECT && selectedPlacedObject
      triggerRow.style.display = showTrigger ? 'block' : 'none'
      if (showTrigger) {
        const t = selectedPlacedObject.userData.trigger
        sidebar.querySelector('#triggerType').value = t?.type || ''
        const isTP = t?.type === 'teleport'
        sidebar.querySelector('#triggerTeleportFields').style.display = isTP ? 'block' : 'none'
        if (isTP) {
          sidebar.querySelector('#triggerDestChunk').value = t.destChunk || ''
          sidebar.querySelector('#triggerEntryX').value = t.entryX ?? ''
          sidebar.querySelector('#triggerEntryY').value = t.entryY ?? ''
          sidebar.querySelector('#triggerEntryZ').value = t.entryZ ?? ''
        }
      }
    }
    const interactionSidesRow = sidebar.querySelector('#interactionSidesRow')
    if (interactionSidesRow) {
      const showSides = state.tool === ToolMode.SELECT && selectedPlacedObject
      interactionSidesRow.style.display = showSides ? 'block' : 'none'
      if (showSides) renderInteractionTilesGrid()
    }
    const planeRotationRow = sidebar.querySelector('#planeRotationRow')
    if (planeRotationRow) {
      const showPlaneRot = (state.tool === ToolMode.SELECT || state.tool === ToolMode.TEXTURE_PLANE) && selectedTexturePlane
      planeRotationRow.style.display = showPlaneRot ? 'block' : 'none'
      if (showPlaneRot) syncPlaneRotationUI()
    }
    if (texNoRoofRow) {
      const showNoRoof = (state.tool === ToolMode.SELECT || state.tool === ToolMode.TEXTURE_PLANE) && selectedTexturePlane
      texNoRoofRow.style.display = showNoRoof ? 'block' : 'none'
      if (showNoRoof) texNoRoofCheckbox.checked = !!selectedTexturePlane.noRoof
    }
    const layerAssignRow = sidebar.querySelector('#layerAssignRow')
    if (layerAssignRow) {
      const showAssign = state.tool === ToolMode.SELECT &&
        (selectedPlacedObjects.length > 0 || selectedTexturePlane)
      layerAssignRow.style.display = showAssign ? 'block' : 'none'
      if (showAssign) {
        const sel = sidebar.querySelector('#layerAssignSelect')
        const lbl = sidebar.querySelector('#layerCurrentLabel')
        if (sel) {
          let currentId, allSame
          if (selectedTexturePlane) {
            currentId = selectedTexturePlane.layerId || 'layer_0'
            allSame = selectedTexturePlanes.every((p) => (p.layerId || 'layer_0') === currentId)
          } else {
            currentId = selectedPlacedObject?.userData?.layerId || 'layer_0'
            allSame = selectedPlacedObjects.every(
              (o) => (o.userData.layerId || 'layer_0') === currentId
            )
          }
          const currentLayer = layers.find((l) => l.id === currentId)
          sel.innerHTML = layers.map((l) =>
            `<option value="${l.id}"${l.id === currentId ? ' selected' : ''}>${l.name}</option>`
          ).join('')
          if (lbl) {
            lbl.textContent = allSame
              ? `Currently on: ${currentLayer?.name ?? 'Layer 1'}`
              : 'Multiple layers selected'
          }
        }
      }
    }
    const replaceRowEl = sidebar.querySelector('#replaceRow')
    if (replaceRowEl) {
      const showReplace = state.tool === ToolMode.SELECT && selectedPlacedObjects.length > 0
      replaceRowEl.style.display = showReplace ? 'block' : 'none'
      if (!showReplace) {
        const rp = sidebar.querySelector('#replacePanel')
        const rb = sidebar.querySelector('#replaceBtn')
        if (rp) rp.style.display = 'none'
        if (rb) rb.textContent = 'Replace Selected'
      }
    }
    const replaceTextureRowEl = sidebar.querySelector('#replaceTextureRow')
    if (replaceTextureRowEl) {
      const showReplaceTexture = state.tool === ToolMode.SELECT && selectedTexturePlanes.length > 0
      replaceTextureRowEl.style.display = showReplaceTexture ? 'block' : 'none'
      if (!showReplaceTexture) {
        const rp = sidebar.querySelector('#replaceTexturePanel')
        const rb = sidebar.querySelector('#replaceTextureBtn')
        if (rp) rp.style.display = 'none'
        if (rb) rb.textContent = 'Replace Texture'
      }
    }
    if (transformMode) {
      let axisLabel = 'ALL'
      if (transformAxis === 'x') axisLabel = 'X'
      else if (transformAxis === 'ground-z') axisLabel = 'Y'
      else if (transformAxis === 'height') axisLabel = 'Z'
      else if (transformAxis !== 'all') axisLabel = transformAxis.toUpperCase()
      status += ` · ${transformMode.toUpperCase()} (${axisLabel})`
    }
    statusText.textContent = status
  }

  function setTool(mode) {
    const wasCollision = state.tool === ToolMode.COLLISION
    state.tool = mode
    cancelDiagFloor()
    if (hoverEdgeHelper) { hoverEdgeHelper.dispose(); hoverEdgeHelper = null }
    npcSpawnGroup.setEnabled(mode === ToolMode.NPC_SPAWN)
    itemSpawnGroup.setEnabled(mode === ToolMode.ITEM_SPAWN)
    collisionGroup.setEnabled(mode === ToolMode.COLLISION)
    if (mode === ToolMode.COLLISION) rebuildCollisionMeshes()
    if (mode === ToolMode.NPC_SPAWN) {
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
    }
    // X-ray mode: make placed objects transparent in collision tool
    if (mode === ToolMode.COLLISION && !wasCollision) setPlacedObjectsXray(true)
    if (mode !== ToolMode.COLLISION && wasCollision) setPlacedObjectsXray(false)
    updateToolUI()
    updatePreviewObject().catch(console.error)
  }

  function setPlacedObjectsXray(xray) {
    for (const obj of placedGroup.getChildren()) {
      for (const mesh of obj.getChildMeshes ? obj.getChildMeshes() : []) {
        const mat = mesh.material
        if (!mat) continue
        if (xray) {
          // Store original alpha to restore later
          if (mat._origAlpha === undefined) mat._origAlpha = mat.alpha
          if (mat._origTransMode === undefined) mat._origTransMode = mat.transparencyMode
          mat.alpha = 0.15
          mat.transparencyMode = 2 // ALPHABLEND
        } else {
          if (mat._origAlpha !== undefined) { mat.alpha = mat._origAlpha; delete mat._origAlpha }
          if (mat._origTransMode !== undefined) { mat.transparencyMode = mat._origTransMode; delete mat._origTransMode }
        }
      }
    }
    // Also make texture planes transparent
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.getChildMeshes ? texturePlaneGroup.getChildMeshes() : []) {
        const mat = mesh.material
        if (!mat) continue
        if (xray) {
          if (mat._origAlpha === undefined) mat._origAlpha = mat.alpha
          mat.alpha = 0.1
        } else {
          if (mat._origAlpha !== undefined) { mat.alpha = mat._origAlpha; delete mat._origAlpha }
        }
      }
    }
  }

  function createBoundingBoxHelper(target, color) {
    try {
      const bounds = target.getHierarchyBoundingVectors(true)
      const min = bounds.min, max = bounds.max
      if (!min || !max || (min.x === max.x && min.y === max.y && min.z === max.z)) return null
      const lines = [
        [new Vector3(min.x, min.y, min.z), new Vector3(max.x, min.y, min.z)],
        [new Vector3(max.x, min.y, min.z), new Vector3(max.x, min.y, max.z)],
        [new Vector3(max.x, min.y, max.z), new Vector3(min.x, min.y, max.z)],
        [new Vector3(min.x, min.y, max.z), new Vector3(min.x, min.y, min.z)],
        [new Vector3(min.x, max.y, min.z), new Vector3(max.x, max.y, min.z)],
        [new Vector3(max.x, max.y, min.z), new Vector3(max.x, max.y, max.z)],
        [new Vector3(max.x, max.y, max.z), new Vector3(min.x, max.y, max.z)],
        [new Vector3(min.x, max.y, max.z), new Vector3(min.x, max.y, min.z)],
        [new Vector3(min.x, min.y, min.z), new Vector3(min.x, max.y, min.z)],
        [new Vector3(max.x, min.y, min.z), new Vector3(max.x, max.y, min.z)],
        [new Vector3(max.x, min.y, max.z), new Vector3(max.x, max.y, max.z)],
        [new Vector3(min.x, min.y, max.z), new Vector3(min.x, max.y, max.z)],
      ]
      const linesMesh = MeshBuilder.CreateLineSystem('selBox', { lines }, scene)
      linesMesh.color = color
      return linesMesh
    } catch { return null }
  }

  let _interactionSideMat = null
  function getInteractionSideMaterial() {
    if (_interactionSideMat) return _interactionSideMat
    const m = new StandardMaterial('interactionSideMat', scene)
    m.emissiveColor = new Color3(0.2, 1.0, 0.4)
    m.diffuseColor = new Color3(0, 0, 0)
    m.specularColor = new Color3(0, 0, 0)
    m.alpha = 0.4
    m.disableLighting = true
    m.backFaceCulling = false
    m.zOffset = -2 // push toward camera in depth so ground doesn't z-fight
    _interactionSideMat = m
    return m
  }

  function createInteractionSideMarkers(obj) {
    const localMask = obj?.userData?.interactionSides | 0
    if (!localMask) return []
    let rotY = obj.rotation?.y || 0
    if (obj.rotationQuaternion) {
      const e = obj.rotationQuaternion.toEulerAngles()
      rotY = e.y
    }
    const width = placedObjectWidth(obj)
    const worldMask = localSidesToWorldSides(localMask, rotY, width)
    if (!worldMask) return []
    const tiles = getObjectInteractionTiles(obj.position.x, obj.position.z, { width }, { allowedWorldSides: worldMask })
    const mat = getInteractionSideMaterial()
    const yBase = (obj.position.y || 0) + 0.02 // hair above ground to avoid z-fighting
    const meshes = []
    for (const t of tiles) {
      const marker = MeshBuilder.CreatePlane(`interactSide_${t.x}_${t.z}`, { size: 0.92 }, scene)
      marker.rotation.x = Math.PI / 2 // lay flat on XZ plane
      marker.position.set(t.x + 0.5, yBase, t.z + 0.5)
      marker.material = mat
      marker.isPickable = false
      marker.doNotSyncBoundingInfo = true
      marker.renderingGroupId = 1 // draw above default scene to stay visible
      meshes.push(marker)
    }
    return meshes
  }

  function clearSelectionHelper() {
    if (Array.isArray(selectionHelper)) {
      for (const h of selectionHelper) { if (h) h.dispose() }
    } else if (selectionHelper) {
      selectionHelper.dispose()
    }
    selectionHelper = null
  }

  function updateSelectionHelper() {
    clearSelectionHelper()

    const totalSelected = selectedPlacedObjects.length + selectedTexturePlanes.length
    const multiColor = new Color3(1.0, 0.67, 0.27)
    const singleColor = new Color3(0.4, 0.8, 1.0)
    const boxColor = totalSelected > 1 ? multiColor : singleColor

    const helpers = []

    for (const obj of selectedPlacedObjects) {
      const h = createBoundingBoxHelper(obj, boxColor)
      if (h) helpers.push(h)
      const sideMarkers = createInteractionSideMarkers(obj)
      for (const m of sideMarkers) helpers.push(m)
    }

    // Update emissive colors on all texture plane meshes to reflect selection state
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.getChildMeshes()) {
        const plane = mesh.metadata?.texturePlane
        if (!plane || !mesh.material) continue
        const isSel = selectedTexturePlanes.includes(plane)
        const tint = plane.tintColor || { r: 1, g: 1, b: 1 }
        mesh.material.emissiveColor = isSel ? new Color3(0.2, 0.4, 0.8) : new Color3(tint.r, tint.g, tint.b)
      }
    }

    if (texturePlaneGroup) {
      for (const plane of selectedTexturePlanes) {
        const mesh = texturePlaneGroup.getChildMeshes().find((c) => c.metadata?.texturePlane?.id === plane.id)
        if (!mesh) continue
        const h = createBoundingBoxHelper(mesh, boxColor)
        if (h) helpers.push(h)
      }
    }

    selectionHelper = helpers.length === 1 ? helpers[0] : helpers.length > 0 ? helpers : null
  }

  function clearSelection() {
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
    selectedTexturePlanes = []
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateSelectionHelper()
    updateToolUI()
  }

  function serializePlacedObjects() {
    const live = placedGroup.getChildren().map((obj) => {
      // When rotationQuaternion is set (after X/Z rotation), obj.rotation is stale.
      // Convert quaternion back to euler for serialization.
      let rx = obj.rotation.x, ry = obj.rotation.y, rz = obj.rotation.z
      if (obj.rotationQuaternion) {
        const euler = obj.rotationQuaternion.toEulerAngles()
        rx = euler.x; ry = euler.y; rz = euler.z
      }
      const out = {
        assetId: obj.userData.assetId || null,
        layerId: obj.userData.layerId || 'layer_0',
        position: { x: obj.position.x, y: obj.position.y, z: obj.position.z },
        rotation: { x: rx, y: ry, z: rz },
        scale: { x: obj.scale.x, y: obj.scale.y, z: obj.scale.z }
      }
      if (obj.userData.trigger) out.trigger = { ...obj.userData.trigger }
      if (obj.userData.interactionSides) out.interactionSides = obj.userData.interactionSides | 0
      return out
    })
    // Append orphaned placements (assetId not in registry) so they survive save/load.
    for (const o of _orphanPlacements) live.push(JSON.parse(JSON.stringify(o)))
    return live
  }

  async function rebuildPlacedObjectsFromData(placedObjectsData) {
    clearPlacedModels()
    _orphanPlacements = []  // full rebuild — reset and repopulate from data
    const _missing = new Map()

    // Pre-load all unique models in parallel so cache is warm before sequential cloning.
    const uniquePaths = [...new Set(
      (placedObjectsData || [])
        .map((p) => assetRegistry.find((a) => a.id === p.assetId)?.path)
        .filter(Boolean)
    )]
    await warmAssetCache(uniquePaths)

    // All models are now cached — clone synchronously (no per-object await)
    for (const placed of placedObjectsData || []) {
      const asset = assetRegistry.find((a) => a.id === placed.assetId)
      if (!asset) {
        _orphanPlacements.push(JSON.parse(JSON.stringify(placed)))
        const k = placed.assetId || '(no assetId)'
        _missing.set(k, (_missing.get(k) || 0) + 1)
        continue
      }

      const model = cloneAssetModelSync(asset.path)
      tuneModelLighting(model, asset.path)

      model.position.set(placed.position.x, placed.position.y, placed.position.z)
      model.rotationQuaternion = null
      model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
      model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = placed.layerId || 'layer_0'
      if (placed.trigger) model.userData.trigger = { ...placed.trigger }
      if (placed.interactionSides) model.userData.interactionSides = placed.interactionSides | 0
      const layer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(layer ? layer.visible : true)
      addPlacedModel(model)
    }
    reportMissingAssets(_missing, 'load')
    // Re-mask the placed objects under any active appearance preview — the
    // previous TransformNode refs we stashed in hiddenNodes are now disposed.
    if (typeof refreshNpcPreviewMasks === 'function') refreshNpcPreviewMasks()
  }

  function buildSaveData() {
    return {
      map: map.toJSON(),
      placedObjects: serializePlacedObjects(),
      layers: JSON.parse(JSON.stringify(layers)),
      activeLayerId,
      npcSpawns: serializeNpcSpawns(),
      itemSpawns: serializeItemSpawns(),
      collisionData: serializeCollisionData()
    }
  }

  function autoSave() {
    try {
      localStorage.setItem('projectrs-autosave', JSON.stringify(buildSaveData()))
      const prev = statusText.textContent
      statusText.textContent = 'Auto-saved'
      setTimeout(() => { statusText.textContent = prev }, 2000)
    } catch (e) {
      console.warn('Auto-save failed:', e)
    }
  }

  setInterval(autoSave, 15 * 60 * 1000)

  function downloadJSON(filename, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }

  async function loadSaveData(data) {
    if (!data?.map) return
    pushUndoState()

    saveFileHandle = null

    map = MapData.fromJSON(data.map)
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
      selectedTexturePlanes = []
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    state.levelHeight = null

    if (data.layers?.length) {
      layers = data.layers
      activeLayerId = data.activeLayerId || layers[0].id
      _layerCount = layers.length
    } else {
      layers = [{ id: 'layer_0', name: 'Layer 1', visible: true }]
      activeLayerId = 'layer_0'
      _layerCount = 1
    }
    refreshLayersPanel()

    await rebuildPlacedObjectsFromData(data.placedObjects || [])
    loadNpcSpawns(data.npcSpawns)
    loadItemSpawns(data.itemSpawns)
    loadCollisionData(data.collisionData)
    loadBiomesData(data.biomesData)

    mapSizeLabel.textContent = `${map.width} x ${map.height}`
    worldOffsetX.value = map.worldOffset.x
    worldOffsetZ.value = map.worldOffset.z
    applyMapType()
    markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
    updateSelectionHelper()
    updateToolUI()

    // Center camera on the active area of the map
    const activeChunks = map.activeChunks
    if (activeChunks && activeChunks.size > 0) {
      let sumX = 0, sumZ = 0, count = 0
      for (const ck of activeChunks) {
        const [cx, cz] = ck.split(',').map(Number)
        sumX += (cx + 0.5) * 64
        sumZ += (cz + 0.5) * 64
        count++
      }
      const centerX = sumX / count, centerZ = sumZ / count
      const h = map.getAverageTileHeight(Math.floor(centerX), Math.floor(centerZ))
      camera.target = new Vector3(centerX, h, centerZ)
    } else {
      // No active chunks — center on map middle
      const cx = map.width / 2, cz = map.height / 2
      const h = map.getAverageTileHeight(Math.floor(cx), Math.floor(cz))
      camera.target = new Vector3(cx, h, cz)
    }
    buildWallChunkDropdown()
  }

  async function importChunk(data, offsetX, offsetZ) {
    if (!data?.map) return
    pushUndoState()

    const src = MapData.fromJSON(data.map)

    // Merge tiles
    for (let z = 0; z < src.height; z++) {
      for (let x = 0; x < src.width; x++) {
        const dx = x + offsetX, dz = z + offsetZ
        if (dx >= 0 && dx < map.width && dz >= 0 && dz < map.height) {
          map.tiles[dz][dx] = JSON.parse(JSON.stringify(src.tiles[z][x]))
        }
      }
    }

    // Merge height vertices
    for (let z = 0; z <= src.height; z++) {
      for (let x = 0; x <= src.width; x++) {
        const dx = x + offsetX, dz = z + offsetZ
        if (dx >= 0 && dx <= map.width && dz >= 0 && dz <= map.height) {
          map.setVertexHeight(dx, dz, src.getVertexHeight(x, z))
        }
      }
    }

    // Add placed objects shifted by offset
    const _importPaths = [...new Set(
      (data.placedObjects || [])
        .map((p) => assetRegistry.find((a) => a.id === p.assetId)?.path)
        .filter(Boolean)
    )]
    const _importPreloaded = await Promise.all(_importPaths.map((path) => loadAssetModel(path).catch(() => null)))
    for (const inst of _importPreloaded) { if (inst) inst.dispose() }

    const _importMissing = new Map()
    for (const placed of data.placedObjects || []) {
      const asset = assetRegistry.find((a) => a.id === placed.assetId)
      if (!asset) {
        const orphan = JSON.parse(JSON.stringify(placed))
        orphan.position.x += offsetX
        orphan.position.z += offsetZ
        _orphanPlacements.push(orphan)
        const k = placed.assetId || '(no assetId)'
        _importMissing.set(k, (_importMissing.get(k) || 0) + 1)
        continue
      }
      const model = await loadAssetModel(asset.path)
      tuneModelLighting(model, asset.path)
      model.position.set(placed.position.x + offsetX, placed.position.y, placed.position.z + offsetZ)
      model.rotationQuaternion = null
      model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
      const isTree = asset.path?.toLowerCase().includes('tree')
      const isRock = asset.path?.toLowerCase().includes('rock')
      const boost = isTree ? 1.15 : isRock ? 0.85 : 1.0
      model.scale.set(placed.scale.x * boost, placed.scale.y * boost, placed.scale.z * boost)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = placed.layerId || activeLayerId
      if (placed.trigger) model.userData.trigger = { ...placed.trigger }
      if (placed.interactionSides) model.userData.interactionSides = placed.interactionSides | 0
      const _layer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(_layer ? _layer.visible : true)
      addPlacedModel(model)
    }
    reportMissingAssets(_importMissing, 'import chunk')

    // Import NPC spawns shifted by offset. Drop the source id so chunks
    // imported into an existing map don't collide with its id sequence.
    for (const s of data.npcSpawns || []) {
      addNpcSpawn({ ...s, id: undefined, x: s.x + offsetX, z: s.z + offsetZ, wanderRange: s.wanderRange ?? 3 })
    }
    rebuildNpcSpawnMeshes()
    refreshNpcSpawnList()

    markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
    updateToolUI()
  }

  function objectsFingerprint() {
    const children = placedGroup.getChildren()
    let h = children.length
    for (const obj of children) {
      const p = obj.position, s = obj.scale
      // Combine position + scale into a fast numeric hash
      h = (h * 31 + (p.x * 1000 | 0)) | 0
      h = (h * 31 + (p.y * 1000 | 0)) | 0
      h = (h * 31 + (p.z * 1000 | 0)) | 0
      h = (h * 31 + (s.x * 1000 | 0)) | 0
      h = (h * 31 + (s.y * 1000 | 0)) | 0
    }
    return h
  }

  function captureSnapshot(scope) {
    const snap = { scope: scope || 'full' }
    if (!scope || scope === 'full' || scope === 'terrain') {
      snap.map = JSON.parse(JSON.stringify(map.toJSON()))
    }
    if (!scope || scope === 'full' || scope === 'objects') {
      snap.placedObjects = serializePlacedObjects()
      snap.objectsFingerprint = objectsFingerprint()
    }
    if (!scope || scope === 'full' || scope === 'collision') {
      snap.collisionData = serializeCollisionData()
    }
    if (!scope || scope === 'full' || scope === 'spawns') {
      snap.npcSpawns = JSON.parse(JSON.stringify(serializeNpcSpawns()))
      snap.itemSpawns = JSON.parse(JSON.stringify(serializeItemSpawns()))
    }
    if (!scope || scope === 'full' || scope === 'biome') {
      snap.biomes = serializeBiomesData()
    }
    return snap
  }

  async function applySnapshot(snapshot) {
    const scope = snapshot.scope || 'full'

    if (snapshot.map) {
      const prevTerrainGen = map.terrainGeneration
      map = MapData.fromJSON(snapshot.map)
      mapSizeLabel.textContent = `${map.width} x ${map.height}`
      if (map.terrainGeneration !== prevTerrainGen) {
        markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
      } else {
        markTerrainDirty({ skipShadows: true })
      }
    }

    if (snapshot.placedObjects) {
      // Skip expensive rebuild if objects haven't actually changed
      const currentFp = objectsFingerprint()
      if (snapshot.objectsFingerprint !== currentFp || snapshot.placedObjects.length !== placedGroup.getChildren().length) {
        selectedPlacedObject = null
        selectedPlacedObjects = []
        transformMode = null
        transformStart = null
        transformLift = 0
        await rebuildPlacedObjectsFromData(snapshot.placedObjects || [])
      }
    }

    if (snapshot.collisionData) {
      loadCollisionData(snapshot.collisionData)
    }

    if (snapshot.npcSpawns) {
      loadNpcSpawns(snapshot.npcSpawns)
    }
    if (snapshot.itemSpawns) {
      loadItemSpawns(snapshot.itemSpawns)
    }
    if (snapshot.biomes) {
      loadBiomesData(snapshot.biomes)
    }

    if (scope === 'full' || scope === 'terrain') {
      rebuildTexturePlanesOnly()
      rebuildTextureOverlaysOnly()
    }

    if (state.tool === ToolMode.COLLISION) setPlacedObjectsXray(true)
    if (heightCullEnabled) applyHeightCull()
    updateSelectionHelper()
    updateToolUI()
  }

  /** Push undo state. Scope limits what's captured for faster undo:
   *  'collision' = only collision data, 'terrain' = only map data,
   *  'objects' = only placed objects, 'spawns' = only NPC/item spawns,
   *  'full' or omitted = everything */
  function pushUndoState(scope) {
    undoStack.push(captureSnapshot(scope))
    if (undoStack.length > MAX_HISTORY) undoStack.shift()
    redoStack.length = 0
  }

  async function undo() {
    if (!undoStack.length) return
    const prev = undoStack[undoStack.length - 1]
    redoStack.push(captureSnapshot(prev.scope))
    const snapshot = undoStack.pop()
    await applySnapshot(snapshot)
  }

  async function redo() {
    if (!redoStack.length) return
    const prev = redoStack[redoStack.length - 1]
    undoStack.push(captureSnapshot(prev.scope))
    const snapshot = redoStack.pop()
    await applySnapshot(snapshot)
  }

  function buildSplitLines() {
    const points = []

    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        const tile = map.getTile(x, z)
        const h = map.getTileCornerHeights(x, z)

        if (tile.split === 'forward') {
          points.push(
            new Vector3(x, h.tl + 0.03, z),
            new Vector3(x + 1, h.br + 0.03, z + 1)
          )
        } else {
          points.push(
            new Vector3(x + 1, h.tr + 0.03, z),
            new Vector3(x, h.bl + 0.03, z + 1)
          )
        }
      }
    }

    // Convert pairs of points to line system segments
    const segments = []
    for (let i = 0; i < points.length; i += 2) {
      segments.push([points[i], points[i + 1]])
    }
    const lines = MeshBuilder.CreateLineSystem('splitLines', { lines: segments }, scene)
    lines.color = new Color3(0, 0, 0)
    lines.alpha = 0.15
    lines.isVisible = state.showSplitLines
    return lines
  }

  function buildTileGrid() {
    const points = []
    const LIFT = 0.04

    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        const h = map.getTileCornerHeights(x, z)

        // top edge
        points.push(
          new Vector3(x,     h.tl + LIFT, z),
          new Vector3(x + 1, h.tr + LIFT, z)
        )
        // left edge
        points.push(
          new Vector3(x, h.tl + LIFT, z),
          new Vector3(x, h.bl + LIFT, z + 1)
        )
        // close the bottom and right borders
        if (z === map.height - 1) {
          points.push(
            new Vector3(x,     h.bl + LIFT, z + 1),
            new Vector3(x + 1, h.br + LIFT, z + 1)
          )
        }
        if (x === map.width - 1) {
          points.push(
            new Vector3(x + 1, h.tr + LIFT, z),
            new Vector3(x + 1, h.br + LIFT, z + 1)
          )
        }
      }
    }

    const segments = []
    for (let i = 0; i < points.length; i += 2) {
      segments.push([points[i], points[i + 1]])
    }
    const lines = MeshBuilder.CreateLineSystem('tileGrid', { lines: segments }, scene)
    lines.color = new Color3(1, 1, 1)
    lines.alpha = 0.18
    lines.isVisible = state.showTileGrid
    return lines
  }

  function buildObjectShadowInfluences() {
    // Per-vertex darkening [0..1] driven by proximity to placed objects
    const rows = map.height + 1
    const cols = map.width + 1
    const inf = []
    for (let i = 0; i < rows; i++) inf.push(new Float32Array(cols).fill(1.0))

    for (const obj of placedGroup.getChildren()) {
      let _size
      try {
        const bounds = obj.getHierarchyBoundingVectors(true)
        _size = { x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y, z: bounds.max.z - bounds.min.z }
        if (_size.x === 0 && _size.y === 0 && _size.z === 0) continue
      } catch { continue }

      const asset = assetRegistry.find((a) => a.id === obj.userData?.assetId)
      const isModular = asset?.path?.toLowerCase().includes('modular assets') ?? false
      const isTree = asset?.name?.toLowerCase().includes('tree') ?? false

      const footprint = Math.max(_size.x, _size.z) * 0.5
      const shadowR   = footprint + (isTree || isModular ? 2.8 : 1.0)
      const maxDark   = isTree || isModular ? 0.82 : 0.42

      const cx = obj.position.x
      const cz = obj.position.z

      const x0 = Math.max(0,        Math.floor(cx - shadowR))
      const x1 = Math.min(cols - 1, Math.ceil (cx + shadowR))
      const z0 = Math.max(0,        Math.floor(cz - shadowR))
      const z1 = Math.min(rows - 1, Math.ceil (cz + shadowR))

      for (let vz = z0; vz <= z1; vz++) {
        for (let vx = x0; vx <= x1; vx++) {
          const dx   = vx - cx
          const dz   = vz - cz
          const dist = Math.sqrt(dx * dx + dz * dz)
          if (dist >= shadowR) continue

          const t      = 1.0 - dist / shadowR
          const dark   = t * t * maxDark
          const factor = 1.0 - dark
          if (factor < inf[vz][vx]) inf[vz][vx] = factor
        }
      }
    }

    return inf
  }

  function disposeGroup(group) {
    if (!group) return
    group.dispose()
  }

  function rebuildTerrain({ skipTexturePlanes = false, skipShadows = false, skipTextureOverlays = false, _heightsOnlyRegion = null } = {}) {
    // Fast path: only heights changed in a known tile region — update land mesh in-place.
    if (_heightsOnlyRegion) {
      const shadowInf = _shadowInfluencesCache ?? buildObjectShadowInfluences()
      _shadowInfluencesCache = shadowInf
      if (updateTerrainLandHeights(map, shadowInf, _heightsOnlyRegion.x1, _heightsOnlyRegion.z1, _heightsOnlyRegion.x2, _heightsOnlyRegion.z2)) {
        // Build new meshes (created hidden by build functions)
        const newCliffs = buildCliffMeshes(map, scene)
        const wg = terrainGroup ? buildWaterMeshes(map, waterTexture, scene) : null
        const newWaterChildren = wg ? [...wg.getChildren()] : []
        if (wg) {
          for (const child of newWaterChildren) { child.setEnabled(false); child.parent = terrainGroup }
          wg.dispose()
        }

        // Dispose old cliffs and water
        disposeGroup(cliffs)
        if (terrainGroup) {
          for (const child of [...terrainGroup.getChildMeshes()]) {
            if ((child.name === 'terrain-water' || child.name === 'terrain-surface-water') && !newWaterChildren.includes(child)) {
              child.dispose()
            }
          }
        }

        // Enable new meshes
        if (newCliffs) newCliffs.setEnabled(true)
        for (const child of newWaterChildren) child.setEnabled(true)
        cliffs = newCliffs

        if (state.showSplitLines) {
          if (splitLines) splitLines.dispose()
          splitLines = buildSplitLines()
        }
        if (state.showTileGrid) {
          if (tileGrid) tileGrid.dispose()
          tileGrid = buildTileGrid()
        }
        applyLayerVisibility()
        return
      }
      // Partial update not available — fall through to full rebuild.
    }

    map.selectedTexturePlaneId = selectedTexturePlane ? selectedTexturePlane.id : null

    if (!skipShadows) _shadowInfluencesCache = null
    const shadowInf = _shadowInfluencesCache ?? buildObjectShadowInfluences()
    _shadowInfluencesCache = shadowInf

    // Build new meshes (all created hidden inside their build functions).
    // Clear the per-tile overlay mesh index BEFORE buildTextureOverlays runs —
    // buildTextureOverlays populates it as it goes, so clearing afterward
    // (the previous order) wiped every entry it had just added. Subsequent
    // shift-click erases couldn't find the mesh to dispose, leaving stale
    // overlays on screen even though the tile data was cleared.
    if (!skipTextureOverlays) overlayMeshesByTile.clear()
    const newTerrain = buildTerrainMeshes(map, waterTexture, shadowInf, scene)
    const newCliffs = buildCliffMeshes(map, scene)
    const newSplitLines = buildSplitLines()
    const newTileGrid = buildTileGrid()
    const newOverlays = !skipTextureOverlays ? buildTextureOverlays(map, textureRegistry, textureCache, scene, overlayMaterialCache, overlayMeshesByTile) : null
    const newPlanes = !skipTexturePlanes ? buildTexturePlanes(map, textureRegistry, textureCache, scene) : null

    // Dispose old meshes
    disposeGroup(terrainGroup)
    disposeGroup(cliffs)
    if (splitLines) splitLines.dispose()
    if (tileGrid) tileGrid.dispose()
    if (!skipTextureOverlays && textureOverlayGroup) textureOverlayGroup.dispose()
    if (!skipTexturePlanes && texturePlaneGroup) texturePlaneGroup.dispose()

    // Enable and swap in new meshes
    if (newTerrain) newTerrain.setEnabled(true)
    if (newCliffs) newCliffs.setEnabled(true)
    if (newOverlays) newOverlays.setEnabled(true)
    if (newPlanes) newPlanes.setEnabled(true)

    terrainGroup = newTerrain
    cliffs = newCliffs
    splitLines = newSplitLines
    tileGrid = newTileGrid
    if (!skipTextureOverlays) textureOverlayGroup = newOverlays
    if (!skipTexturePlanes) texturePlaneGroup = newPlanes

    updateSelectionHelper()
    applyLayerVisibility()
  }

  function rebuildTexturePlanesOnly() {
    const newPlanes = buildTexturePlanes(map, textureRegistry, textureCache, scene)
    if (texturePlaneGroup) texturePlaneGroup.dispose()
    if (newPlanes) newPlanes.setEnabled(true)
    texturePlaneGroup = newPlanes
    updateSelectionHelper()
  }

  function appendTexturePlane(plane) {
    if (!texturePlaneGroup) {
      texturePlaneGroup = new TransformNode('texture-planes', scene)
    }
    const mesh = buildSingleTexturePlane(plane, textureRegistry, textureCache, scene, false)
    if (mesh) mesh.parent = texturePlaneGroup
    updateSelectionHelper()
  }

  function removeTexturePlaneMesh(plane) {
    if (!texturePlaneGroup) return
    const mesh = texturePlaneGroup.getChildMeshes().find((m) => m.metadata?.texturePlane === plane)
    if (mesh) mesh.dispose()
  }

  function rebuildTextureOverlaysOnly() {
    // Clear BEFORE building — buildTextureOverlays populates the per-tile
    // mesh index, so clearing afterward wipes the fresh entries and breaks
    // subsequent single-tile dispose lookups (shift-click erase).
    overlayMeshesByTile.clear()
    const newOverlays = buildTextureOverlays(map, textureRegistry, textureCache, scene, overlayMaterialCache, overlayMeshesByTile)
    if (textureOverlayGroup) textureOverlayGroup.dispose()
    if (newOverlays) newOverlays.setEnabled(true)
    textureOverlayGroup = newOverlays
  }

  /** Fast single-tile texture overlay update — avoids full map rebuild */
  // One StandardMaterial per textureId, shared across all overlay meshes
  // (full-rebuild and single-tile paths both feed this cache via
  // getOrCreateOverlayMaterial). Without sharing, every paint click would
  // create a fresh material and leak it on dispose.
  const overlayMaterialCache = new Map()

  // Tile-coord → its current overlay meshes. Lets the single-tile incremental
  // rebuild path dispose in O(1) instead of scanning every child of the
  // texture-overlay group for name matches on every paint click.
  const overlayMeshesByTile = new Map()

  function disposeOverlayMeshesForTile(tx, tz) {
    const key = `${tx},${tz}`
    const meshes = overlayMeshesByTile.get(key)
    if (!meshes) return
    for (const m of meshes) m.dispose(false, false)
    overlayMeshesByTile.delete(key)
  }

  function updateTileTextureOverlay(tx, tz) {
    if (!textureOverlayGroup) {
      textureOverlayGroup = new TransformNode('texture-overlays', scene)
    }
    if (!textureOverlayGroup.isEnabled()) textureOverlayGroup.setEnabled(true)
    // Drop any existing overlay meshes for this tile. Don't dispose the
    // material — it's shared across tiles via overlayMaterialCache.
    disposeOverlayMeshesForTile(tx, tz)

    const tile = map.getTile(tx, tz)
    if (!tile || (!tile.textureId && !tile.textureIdB)) return
    const tileKey = `${tx},${tz}`

    const h = map.getTileCornerHeights(tx, tz)
    const overlayOffset = 0.008

    const addOverlay = (textureId, rotation, scale, worldUV, ring) => {
      if (ring.length < 3) return
      // Emissive 0.45 matches the full-rebuild path (TerrainMesh.buildTextureOverlays).
      // Cache is shared so first caller wins anyway — the single-tile path's
      // previous 0.18 was dead since map load always pre-seeded 0.45.
      const mat = getOrCreateOverlayMaterial(textureId, textureRegistry, textureCache, scene, overlayMaterialCache, 0.45)
      if (!mat) return

      const positions = []
      const uvs = []
      const s = Math.max(0.1, scale)
      const r = ((rotation % 4) + 4) % 4
      for (const p of ring) {
        const wx = tx + p.u
        const wz = tz + p.v
        const wy = bilerpCorners(h.tl, h.tr, h.bl, h.br, p.u, p.v) + overlayOffset
        positions.push(wx, wy, wz)
        if (worldUV) {
          uvs.push(wx / s, wz / s)
        } else {
          const [tu, tv] = transformOverlayUV(p.u, p.v, r, s)
          uvs.push(tu, tv)
        }
      }
      const indices = fanTriangulate(ring.length)

      const mesh = new Mesh(`texoverlay_${tx}_${tz}`, scene)
      const vd = new VertexData()
      vd.positions = positions
      vd.uvs = uvs
      vd.indices = indices
      const normals = []
      VertexData.ComputeNormals(positions, indices, normals)
      vd.normals = normals
      vd.applyToMesh(mesh)

      mesh.material = mat
      mesh.parent = textureOverlayGroup
      let list = overlayMeshesByTile.get(tileKey)
      if (!list) { list = []; overlayMeshesByTile.set(tileKey, list) }
      list.push(mesh)
    }

    if (tile.textureHalfMode) {
      const { halfA, halfB } = computeCutPolygons(tile.textureCutAngle)
      if (tile.textureId) addOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, halfA)
      if (tile.textureIdB) addOverlay(tile.textureIdB, tile.textureRotationB, tile.textureScaleB, false, halfB)
    } else if (tile.textureId) {
      addOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, fullTileRingForSplit(tile.split))
    }
  }

  function updateTexturePlaneMeshTransform(plane) {
    if (!texturePlaneGroup) return
    const mesh = texturePlaneGroup.getChildMeshes().find((m) => m.metadata?.texturePlane === plane)
    if (!mesh) return
    mesh.position.set(plane.position.x, plane.position.y, plane.position.z)
    mesh.rotation.set(plane.rotation?.x ?? 0, plane.rotation?.y ?? 0, plane.rotation?.z ?? 0)
    mesh.scaling.set(plane.scale?.x ?? 1, plane.scale?.y ?? 1, plane.scale?.z ?? 1)
  }

  function updateMouse(event) {
    // Update Babylon.js pointer position from the event
    const rect = canvas.getBoundingClientRect()
    scene.pointerX = event.clientX - rect.left
    scene.pointerY = event.clientY - rect.top
  }

  function getTerrainMeshes() {
    const meshes = []
    if (!terrainGroup) return meshes
    for (const child of terrainGroup.getChildMeshes()) meshes.push(child)
    return meshes
  }

  function isTerrainMesh(mesh) {
    return terrainGroup && mesh.isDescendantOf(terrainGroup)
  }

  function pickTerrainPoint(event) {
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => isTerrainMesh(mesh))
    if (!pick.hit) return null
    return pick.pickedPoint.clone()
  }

  function pickHorizontalPlane(event, y = 0) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    if (Math.abs(ray.direction.y) < 0.0001) return null
    const t = -(ray.origin.y - y) / ray.direction.y
    if (t < 0) return null
    return new Vector3(
      ray.origin.x + ray.direction.x * t,
      y,
      ray.origin.z + ray.direction.z * t
    )
  }

  function pickSurfacePoint(event, excludeObjects = []) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)

    // Pick terrain
    const terrainPick = scene.pickWithRay(ray, (mesh) => isTerrainMesh(mesh))

    // Pick placed objects (filter upward-facing, skip height-culled)
    const placedPick = scene.pickWithRay(ray, (mesh) => {
      if (!mesh.isDescendantOf(placedGroup)) return false
      if (!mesh.isVisible || !mesh.isEnabled()) return false
      // Walk up to find root placed object
      let node = mesh
      while (node.parent && node.parent !== placedGroup) node = node.parent
      if (!node.isEnabled()) return false
      return !excludeObjects.includes(node)
    })

    // Pick texture planes
    const planePick = texturePlaneGroup ? scene.pickWithRay(ray, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible
    }) : null

    // Find closest hit with upward-facing normal
    const candidates = []
    if (terrainPick?.hit) candidates.push(terrainPick)
    if (placedPick?.hit) {
      const n = placedPick.getNormal(true)
      if (n && n.y > 0.5) candidates.push(placedPick)
    }
    if (planePick?.hit) {
      const n = planePick.getNormal(true)
      if (n && n.y > 0.5) candidates.push(planePick)
    }

    candidates.sort((a, b) => a.distance - b.distance)
    return candidates.length > 0 ? candidates[0].pickedPoint.clone() : null
  }

  function pickTile(event) {
    updateMouse(event)

    // Try terrain mesh first
    let p = pickTerrainPoint(event)

    // Fallback: project ray onto horizontal plane at Y=0 (or last known height)
    // This ensures clicks always resolve to a tile, even over bridges/elevated surfaces
    if (!p) {
      p = pickHorizontalPlane(event, _pickTileFallbackY)
    }

    if (!p) return null

    _pickTileFallbackY = p.y

    const x = Math.floor(p.x)
    const z = Math.floor(p.z)

    if (x < 0 || z < 0 || x >= map.width || z >= map.height) return null
    return { x, z, u: p.x - x, v: p.z - z }
  }
  let _pickTileFallbackY = 0

  function pickPlacedObject(event) {
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(placedGroup) && mesh.isVisible && mesh.isEnabled()
    })
    if (!pick.hit) return null

    let obj = pick.pickedMesh
    while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
    return obj
  }

  async function importMapAtOffset(data, offsetX, offsetZ) {
  const imported = MapData.fromJSON(data)
  pushUndoState()

  // copy tiles
  for (let z = 0; z < imported.height; z++) {
    for (let x = 0; x < imported.width; x++) {
      const dstTile = map.getTile(x + offsetX, z + offsetZ)
      const srcTile = imported.getTile(x, z)
      if (!dstTile || !srcTile) continue

      map.tiles[z + offsetZ][x + offsetX] = JSON.parse(JSON.stringify(srcTile))
    }
  }

  // copy height vertices
  for (let z = 0; z <= imported.height; z++) {
    for (let x = 0; x <= imported.width; x++) {
      const dstX = x + offsetX
      const dstZ = z + offsetZ

      if (dstX < 0 || dstZ < 0 || dstX > map.width || dstZ > map.height) continue
      map.heights[dstZ][dstX] = imported.heights[z][x]
    }
  }

  // import texture planes
  for (const plane of imported.texturePlanes || []) {
    const clone = JSON.parse(JSON.stringify(plane))
    clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`
    clone.position.x += offsetX
    clone.position.z += offsetZ
    map.texturePlanes.push(clone)
  }

  // import placed objects — pre-load unique models in parallel first
  const _mergeUniquePaths = [...new Set(
    (data.placedObjects || [])
      .map((p) => assetRegistry.find((a) => a.id === p.assetId)?.path)
      .filter(Boolean)
  )]
  const _mergePreloaded = await Promise.all(_mergeUniquePaths.map((path) => loadAssetModel(path).catch(() => null)))
  for (const inst of _mergePreloaded) { if (inst) inst.dispose() }

  const _mergeMissing = new Map()
  for (const placed of data.placedObjects || []) {
    const asset = assetRegistry.find((a) => a.id === placed.assetId)
    if (!asset) {
      const orphan = JSON.parse(JSON.stringify(placed))
      orphan.position.x += offsetX
      orphan.position.z += offsetZ
      _orphanPlacements.push(orphan)
      const k = placed.assetId || '(no assetId)'
      _mergeMissing.set(k, (_mergeMissing.get(k) || 0) + 1)
      continue
    }

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model, asset.path)

    model.position.set(
      placed.position.x + offsetX,
      placed.position.y,
      placed.position.z + offsetZ
    )
    model.rotationQuaternion = null
    model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
    model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
    model.userData.assetId = asset.id
    model.userData.type = 'asset'
    model.userData.layerId = placed.layerId || activeLayerId
    const _importLayer = layers.find((l) => l.id === model.userData.layerId)
    model.setEnabled(_importLayer ? _importLayer.visible : true)
    addPlacedModel(model)
  }
  reportMissingAssets(_mergeMissing, 'import map')

  markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
  updateSelectionHelper()
  updateToolUI()
}

  function pickTexturePlane(event) {
    if (!texturePlaneGroup) return null
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible
    })
    return pick.hit ? pick.pickedMesh : null
  }

  // Returns { type: 'placed'|'plane', object, distance } for whichever is closest to camera
  function pickClosestSelectTarget(event) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)

    const placedPick = scene.pickWithRay(ray, (mesh) => {
      return mesh.isDescendantOf(placedGroup) && mesh.isVisible && mesh.isEnabled()
    })

    const planePick = texturePlaneGroup ? scene.pickWithRay(ray, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible && mesh.isEnabled()
    }) : null

    const bestPlaced = placedPick?.hit ? placedPick : null
    const bestPlane = planePick?.hit ? planePick : null

    if (!bestPlaced && !bestPlane) return null

    if (bestPlaced && (!bestPlane || bestPlaced.distance <= bestPlane.distance)) {
      let obj = bestPlaced.pickedMesh
      while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
      return { type: 'placed', object: obj, distance: bestPlaced.distance }
    }

    return { type: 'plane', object: bestPlane.pickedMesh, distance: bestPlane.distance }
  }

  function tileWorldPosition(x, z) {
    return new Vector3(
      x + 0.5,
      map.getAverageTileHeight(x, z),
      z + 0.5
    )
  }

  function getTexturePlaneSize(textureId) {
    return { width: 1, height: 1 }
  }

  function getPlaneFootprint(plane) {
    return {
      width: (plane.width || 1) * (plane.scale?.x ?? 1),
      depth: Math.max(0.1, plane.scale?.z ?? 0.1),
      height: (plane.height || 1) * (plane.scale?.y ?? 1)
    }
  }

  function getObjectFootprint(object) {
    const bounds = object.getHierarchyBoundingVectors(true)
    const sizeX = bounds.max.x - bounds.min.x
    const sizeY = bounds.max.y - bounds.min.y
    const sizeZ = bounds.max.z - bounds.min.z
    return {
      width: Math.max(sizeX, 0.1),
      depth: Math.max(sizeZ, 0.1),
      height: Math.max(sizeY, 0.1)
    }
  }

  function scaleObjectToTiles(obj, tiles) {
    const prevYScale = obj.scaling?.y ?? obj.scale?.y ?? 1
    if (obj.scaling) obj.scaling.set(1, 1, 1)
    else if (obj.scale) obj.scale.set(1, 1, 1)
    obj.computeWorldMatrix?.(true)
    try {
      const bounds = obj.getHierarchyBoundingVectors(true)
      const naturalLength = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z)
      if (naturalLength < 0.001) {
        if (obj.scaling) obj.scaling.set(1, prevYScale, 1)
        else if (obj.scale) obj.scale.set(1, prevYScale, 1)
        return
      }
      const s = tiles / naturalLength
      if (obj.scaling) obj.scaling.set(s, prevYScale, s)
      else if (obj.scale) obj.scale.set(s, prevYScale, s)
      obj.computeWorldMatrix?.(true)
    } catch {
      if (obj.scaling) obj.scaling.set(1, prevYScale, 1)
      else if (obj.scale) obj.scale.set(1, prevYScale, 1)
    }
  }

  function snapValue(value, step = 0.5) {
    return Math.round(value / step) * step
  }

  function snapThingPositionToGrid(position, step = 0.5) {
    position.x = snapValue(position.x, step)
    position.z = snapValue(position.z, step)
  }

  function isStoneModularAsset(asset) {
    const p = asset?.path?.toLowerCase() ?? ''
    return p.includes('stone modular') || p.includes('dark stone modular') || p.includes('new-dark-modular') || p.includes('wood modular')
  }

  function isModularAsset(assetId) {
    const asset = assetRegistry.find((a) => a.id === assetId)
    return asset?.path?.toLowerCase().includes('modular assets') ?? false
  }

  function findModularEdgeSnap(movingObj, targetX, targetZ) {
    const THRESHOLD = 0.65

    // Local extents relative to the object's position (constant while translating)
    const movingBounds = movingObj.getHierarchyBoundingVectors(true)
    const lMinX = movingBounds.min.x - movingObj.position.x
    const lMaxX = movingBounds.max.x - movingObj.position.x
    const lMinZ = movingBounds.min.z - movingObj.position.z
    const lMaxZ = movingBounds.max.z - movingObj.position.z

    // Predicted bbox at target position
    const tMinX = targetX + lMinX
    const tMaxX = targetX + lMaxX
    const tMinZ = targetZ + lMinZ
    const tMaxZ = targetZ + lMaxZ

    let bestX = null, bestZ = null
    let bestDX = THRESHOLD, bestDZ = THRESHOLD

    for (const other of placedGroup.getChildren()) {
      if (selectedPlacedObjects.includes(other)) continue
      if (!isModularAsset(other.userData?.assetId)) continue

      let ob
      try { const b = other.getHierarchyBoundingVectors(true); ob = { min: b.min, max: b.max } } catch { continue }

      // X: my left→other right, my right→other left, center align
      for (const [d, snap] of [
        [Math.abs(tMinX - ob.max.x), ob.max.x - lMinX],
        [Math.abs(tMaxX - ob.min.x), ob.min.x - lMaxX],
        [Math.abs(targetX - other.position.x), other.position.x],
      ]) {
        if (d < bestDX) { bestDX = d; bestX = snap }
      }

      // Z: my front→other back, my back→other front, center align
      for (const [d, snap] of [
        [Math.abs(tMinZ - ob.max.z), ob.max.z - lMinZ],
        [Math.abs(tMaxZ - ob.min.z), ob.min.z - lMaxZ],
        [Math.abs(targetZ - other.position.z), other.position.z],
      ]) {
        if (d < bestDZ) { bestDZ = d; bestZ = snap }
      }
    }

    // Fall back to 1-unit grid if no nearby object edge found
    return {
      x: bestX ?? snapValue(targetX, 1.0),
      z: bestZ ?? snapValue(targetZ, 1.0)
    }
  }

  function getRightVector(rotY) {
    return {
      x: Math.cos(rotY),
      z: -Math.sin(rotY)
    }
  }

  function getForwardVector(rotY) {
    return {
      x: Math.sin(rotY),
      z: Math.cos(rotY)
    }
  }

  function snapSelectedThingNow() {
    if (selectedTexturePlane) {
      snapThingPositionToGrid(selectedTexturePlane.position, 0.5)
      updateTexturePlaneMeshTransform(selectedTexturePlane)
      updateSelectionHelper()
      updateToolUI()
      return
    }

    if (selectedPlacedObject) {
      const step = isModularAsset(selectedPlacedObject.userData.assetId) ? 1.0 : 0.5
      selectedPlacedObject.position.x = snapValue(selectedPlacedObject.position.x, step)
      selectedPlacedObject.position.z = snapValue(selectedPlacedObject.position.z, step)
      updateSelectionHelper()
      updateToolUI()
    }
  }

  function snapPlaneFlushAlong(sourcePlane, targetPlane, direction = 'right') {
    const source = getPlaneFootprint(sourcePlane)
    const target = getPlaneFootprint(targetPlane)
    const rotY = targetPlane.rotation.y || 0

    const isForward = direction === 'forward' || direction === 'back'
    const sign = (direction === 'left' || direction === 'back') ? -1 : 1
    const vec = isForward ? getForwardVector(rotY) : getRightVector(rotY)
    const spacing = isForward
      ? (source.depth + target.depth) * 0.5
      : (source.width + target.width) * 0.5

    sourcePlane.position.x = targetPlane.position.x + vec.x * spacing * sign
    sourcePlane.position.z = targetPlane.position.z + vec.z * spacing * sign
    sourcePlane.position.y = targetPlane.position.y
  }

  function stackPlaneAbove(sourcePlane, targetPlane) {
    const source = getPlaneFootprint(sourcePlane)
    const target = getPlaneFootprint(targetPlane)
    sourcePlane.position.x = targetPlane.position.x
    sourcePlane.position.z = targetPlane.position.z
    sourcePlane.position.y = targetPlane.position.y + (target.height + source.height) * 0.5
  }


  function findTexturePlaneTopAt(event) {
    if (!texturePlaneGroup) return null
    updateMouse(event)
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return mesh.isDescendantOf(texturePlaneGroup) && mesh.isVisible
    })
    if (pick.hit) {
      const n = pick.getNormal(true)
      if (n && n.y > 0.5) return pick.pickedPoint.y
    }
    return null
  }

  function findObjectTopAt(worldX, worldZ, excludeObjects = []) {
    const MARGIN = 0.4
    let bestTop = null
    const candidates = _spatialNearby(worldX, worldZ, SPATIAL_CELL * 2)
    for (const obj of candidates) {
      if (excludeObjects.includes(obj)) continue
      if (obj.isEnabled && !obj.isEnabled()) continue

      // Use static bounds from load time to avoid animated sub-meshes inflating the box
      const bounds = obj.userData.bounds
      if (bounds) {
        const halfW = (bounds.width  * obj.scale.x) * 0.5 + MARGIN
        const halfD = (bounds.depth  * obj.scale.z) * 0.5 + MARGIN
        const top   =  obj.position.y + bounds.height * obj.scale.y
        if (
          worldX >= obj.position.x - halfW && worldX <= obj.position.x + halfW &&
          worldZ >= obj.position.z - halfD && worldZ <= obj.position.z + halfD &&
          (bestTop === null || top > bestTop)
        ) {
          bestTop = top
        }
      } else {
        obj.computeWorldMatrix(true)
        const _b = obj.getHierarchyBoundingVectors(true)
        const box = { min: _b.min, max: _b.max }
        if (box.min.x === box.max.x && box.min.y === box.max.y) continue
        if (
          worldX >= box.min.x - MARGIN && worldX <= box.max.x + MARGIN &&
          worldZ >= box.min.z - MARGIN && worldZ <= box.max.z + MARGIN &&
          (bestTop === null || box.max.y > bestTop)
        ) {
          bestTop = box.max.y
        }
      }
    }
    return bestTop
  }

  function findNearbyPlaneSnap(movingPlane, worldX, worldZ) {
    const SNAP_DIST = 0.5
    const movingFP = getPlaneFootprint(movingPlane)
    const movingRotY = movingPlane.rotation?.y || 0

    let best = null
    let bestDist = SNAP_DIST

    for (const plane of map.texturePlanes) {
      if (plane === movingPlane) continue
      if (!plane.vertical || !movingPlane.vertical) continue

      const targetFP = getPlaneFootprint(plane)
      const rotY = plane.rotation?.y || 0

      const rotDiff = ((movingRotY - rotY) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2)
      const aligned = rotDiff < 0.26 || rotDiff > (Math.PI * 2 - 0.26)
      if (!aligned) continue

      const right = getRightVector(rotY)
      const halfSpan = (targetFP.width + movingFP.width) * 0.5

      const candidates = [
        { x: plane.position.x + right.x * halfSpan, z: plane.position.z + right.z * halfSpan, y: plane.position.y },
        { x: plane.position.x - right.x * halfSpan, z: plane.position.z - right.z * halfSpan, y: plane.position.y }
      ]

      for (const c of candidates) {
        const dist = Math.sqrt((worldX - c.x) ** 2 + (worldZ - c.z) ** 2)
        if (dist < bestDist) {
          bestDist = dist
          best = c
        }
      }
    }

    return best
  }

  function snapObjectFlushAlongPosition(basePosition, baseRotationY, targetFootprint, sourceFootprint, direction = 'right') {
    const isForward = direction === 'forward' || direction === 'back'
    const sign = (direction === 'left' || direction === 'back') ? -1 : 1
    const vec = isForward ? getForwardVector(baseRotationY) : getRightVector(baseRotationY)

    // Project AABB extents onto the movement direction so spacing is correct at any rotation
    const ax = Math.abs(vec.x), az = Math.abs(vec.z)
    const targetExtent = ax * targetFootprint.width + az * targetFootprint.depth
    const sourceExtent = ax * sourceFootprint.width + az * sourceFootprint.depth
    const spacing = (targetExtent + sourceExtent) * 0.5

    return new Vector3(
      basePosition.x + vec.x * spacing * sign,
      basePosition.y,
      basePosition.z + vec.z * spacing * sign
    )
  }

  function snapAngleToQuarterIfClose(angle, threshold = 0.12) {
    const quarterTurn = Math.PI / 2
    const nearestQuarter = Math.round(angle / quarterTurn) * quarterTurn
    return Math.abs(angle - nearestQuarter) < threshold ? nearestQuarter : angle
  }

  function applyRotationSnapOnConfirm() {
    if (selectedTexturePlane) {
      selectedTexturePlane.rotation.x = snapAngleToQuarterIfClose(selectedTexturePlane.rotation.x)
      selectedTexturePlane.rotation.y = snapAngleToQuarterIfClose(selectedTexturePlane.rotation.y)
      selectedTexturePlane.rotation.z = snapAngleToQuarterIfClose(selectedTexturePlane.rotation.z)
      updateTexturePlaneMeshTransform(selectedTexturePlane)
    }

    if (selectedPlacedObject) {
      for (const obj of selectedPlacedObjects) {
        obj.rotation.x = snapAngleToQuarterIfClose(obj.rotation.x)
        obj.rotation.y = snapAngleToQuarterIfClose(obj.rotation.y)
        obj.rotation.z = snapAngleToQuarterIfClose(obj.rotation.z)
      }
      updateSelectionHelper()
    }
  }

// Gaussian vertex brush — operates on individual height vertices for smooth hills
function applyGaussianBrush(centerX, centerZ, delta, radius, sigma) {
  radius = radius ?? brushRadius
  sigma = sigma ?? radius * 0.47

  const minX = Math.max(0, Math.floor(centerX - radius))
  const maxX = Math.min(map.width, Math.ceil(centerX + radius))
  const minZ = Math.max(0, Math.floor(centerZ - radius))
  const maxZ = Math.min(map.height, Math.ceil(centerZ + radius))

  for (let vz = minZ; vz <= maxZ; vz++) {
    for (let vx = minX; vx <= maxX; vx++) {
      const dx = vx - centerX
      const dz = vz - centerZ
      const weight = Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma))
      if (weight > 0.005) {
        map.adjustVertexHeight(vx, vz, delta * weight)
      }
    }
  }
}

// Laplacian smooth — blends each vertex toward the average of its neighbours
function applySmoothBrush(centerX, centerZ, strength = 0.55) {
  const radius = brushRadius
  const sigma = radius * 0.47

  const minX = Math.max(0, Math.floor(centerX - radius))
  const maxX = Math.min(map.width, Math.ceil(centerX + radius))
  const minZ = Math.max(0, Math.floor(centerZ - radius))
  const maxZ = Math.min(map.height, Math.ceil(centerZ + radius))

  // First pass: compute Laplacian target for each vertex in range
  const targets = new Map()
  for (let vz = minZ; vz <= maxZ; vz++) {
    for (let vx = minX; vx <= maxX; vx++) {
      let sum = 0, count = 0
      for (const [dx, dz] of [[-1,0],[1,0],[0,-1],[0,1]]) {
        const nx = vx + dx, nz = vz + dz
        if (nx < 0 || nx > map.width || nz < 0 || nz > map.height) continue
        sum += map.getVertexHeight(nx, nz)
        count++
      }
      targets.set(`${vx},${vz}`, count > 0 ? sum / count : map.getVertexHeight(vx, vz))
    }
  }

  // Second pass: blend toward target weighted by Gaussian distance from center
  for (let vz = minZ; vz <= maxZ; vz++) {
    for (let vx = minX; vx <= maxX; vx++) {
      const dx = vx - centerX
      const dz = vz - centerZ
      const weight = Math.exp(-(dx * dx + dz * dz) / (2 * sigma * sigma))
      if (weight < 0.005) continue
      const current = map.getVertexHeight(vx, vz)
      const target = targets.get(`${vx},${vz}`)
      map.setVertexHeight(vx, vz, current + (target - current) * weight * strength)
    }
  }
}

/**
 * Pick a texture-cut angle from a cursor position inside a tile. The cut
 * line passes through tile center perpendicular to (cursor − center) so the
 * cursor sits on one clean side of the resulting cut. Snaps to common angles
 * (0°, 45°, 90°, 135°) within ±10° unless Alt is held — Alt gives free-form
 * angles for walls that aren't grid-aligned.
 */
function pickTextureCutAngle(u, v, eventLike) {
  const dx = u - 0.5
  const dy = v - 0.5
  // Within a tiny radius of center the direction is undefined — fall back
  // to a horizontal cut so the result is stable instead of jittery.
  if (Math.hypot(dx, dy) < 0.05) return 0

  let cutAngle = normalizeCutAngle(Math.atan2(dy, dx) + Math.PI / 2)

  if (!eventLike?.altKey) {
    for (const s of CUT_SNAP_ANGLES) {
      let d = Math.abs(cutAngle - s)
      if (d > Math.PI / 2) d = Math.PI - d
      if (d <= CUT_SNAP_TOLERANCE_RAD) { cutAngle = s; break }
    }
  }
  return cutAngle
}

function captureStrokeHistoryOnce(scope) {
  if (!state.historyCapturedThisStroke) {
    pushUndoState(scope || 'terrain')
    state.historyCapturedThisStroke = true
  }
}


function applyToolAtTile(tile, eventLike = null) {
  if (!tile) return

  if (state.tool === ToolMode.TERRAIN) {
    captureStrokeHistoryOnce()

    if (state.smoothMode) {
      applySmoothBrush(tile.x + 0.5, tile.z + 0.5, 0.3)
      const _r = Math.ceil(brushRadius)
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: tile.x - _r, z1: tile.z - _r, x2: tile.x + _r, z2: tile.z + _r } })
      return
    }

    if (state.levelMode) {
      if (state.levelHeight === null) {
        state.levelHeight = map.getAverageTileHeight(tile.x, tile.z)
        updateToolUI()
      }

      map.flattenTileToHeight(tile.x, tile.z, state.levelHeight)
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: tile.x, z1: tile.z, x2: tile.x, z2: tile.z } })
      return
    }

    if (brushRadius < 0.6) {
      // Minimum brush: affect only the 4 corners of the exact tile
      const delta = eventLike?.shiftKey ? -0.20 : 0.20
      if (eventLike?.ctrlKey) {
        map.flattenTile(tile.x, tile.z)
      } else {
        map.adjustVertexHeight(tile.x,     tile.z,     delta)
        map.adjustVertexHeight(tile.x + 1, tile.z,     delta)
        map.adjustVertexHeight(tile.x,     tile.z + 1, delta)
        map.adjustVertexHeight(tile.x + 1, tile.z + 1, delta)
      }
    } else if (eventLike?.ctrlKey) {
      applySmoothBrush(tile.x + 0.5, tile.z + 0.5)
    } else if (eventLike?.shiftKey) {
      applyGaussianBrush(tile.x + 0.5, tile.z + 0.5, -0.20)
    } else {
      applyGaussianBrush(tile.x + 0.5, tile.z + 0.5, 0.20)
    }

    const _r = Math.ceil(brushRadius)
    markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: tile.x - _r, z1: tile.z - _r, x2: tile.x + _r, z2: tile.z + _r } })
    return
  }

  if (state.tool === ToolMode.PAINT) {
    captureStrokeHistoryOnce()

    if (state.paintType === 'surface-water') {
      if (eventLike?.shiftKey) {
        map.clearWaterSurface(tile.x, tile.z)
      } else {
        map.paintWaterSurface(tile.x, tile.z)
      }
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true })
      return
    }

    if (eventLike?.shiftKey || paintTabTextureId) {
      const isErase = eventLike?.shiftKey || paintTabTextureId === '__erase__'
      if (state.halfPaint) {
        const u = tile.u ?? 0.5
        const v = tile.v ?? 0.5

        // Cut policy: if the tile is already half-painted, preserve the
        // existing cut so each side can be refined without the diagonal
        // jumping around. Fresh tiles (or tiles being converted from full
        // paint to half) derive the cut from cursor position — the cut is
        // perpendicular to (cursor − center), with snapping to common angles
        // unless Alt is held.
        const existing = map.getTile(tile.x, tile.z)
        const hadHalfMode = !!(existing && existing.textureHalfMode && (existing.textureId || existing.textureIdB))
        let cutAngle
        if (hadHalfMode) {
          cutAngle = existing.textureCutAngle
        } else {
          cutAngle = pickTextureCutAngle(u, v, eventLike)
          map.setTextureCutAngle(tile.x, tile.z, cutAngle)
        }

        const cursorHalf = cutSideOf(u, v, cutAngle)

        if (paintTabTextureIdB && !isErase) {
          // Cursor side wins: whichever slot the user is pointing at goes to A.
          const [aTex, bTex] = cursorHalf === 'A'
            ? [paintTabTextureId, paintTabTextureIdB]
            : [paintTabTextureIdB, paintTabTextureId]
          map.paintTextureTileFirst(tile.x, tile.z, aTex, textureRotation, textureScale)
          map.paintTextureTileSecond(tile.x, tile.z, bTex, textureRotation, textureScale)
        } else if (cursorHalf === 'A') {
          if (isErase) map.clearTextureTileFirst(tile.x, tile.z)
          else map.paintTextureTileFirst(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale)
        } else {
          if (isErase) map.clearTextureTileSecond(tile.x, tile.z)
          else map.paintTextureTileSecond(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale)
        }
      } else {
        if (isErase) map.clearTextureTile(tile.x, tile.z)
        else map.paintTextureTile(tile.x, tile.z, paintTabTextureId, textureRotation, textureScale, textureWorldUV)
      }
      updateTileTextureOverlay(tile.x, tile.z)
      return
    }

    const _pbr = paintBrushRadius - 1
    const cx = tile.x, cz = tile.z
    for (let dz = -_pbr; dz <= _pbr; dz++) {
      for (let dx = -_pbr; dx <= _pbr; dx++) {
        if (dx * dx + dz * dz > _pbr * _pbr + _pbr) continue
        const tx = cx + dx, tz = cz + dz
        if (tx < 0 || tz < 0 || tx >= map.width || tz >= map.height) continue
        if (state.paintType === 'water') {
          map.paintWaterTile(tx, tz)
        } else if (state.halfPaint && dx === 0 && dz === 0) {
          // Ground-color half paint is constrained to the two diagonals
          // (it shares tile.split with terrain triangulation, so we can't
          // add arbitrary angles here without changing slope rendering).
          // Pick the diagonal so the cursor's quadrant is its own triangle,
          // then paint that triangle. `isFirst = nearLeft` is correct for
          // both diagonals — the "first" triangle always contains the left
          // edge of the tile (TL+BL for forward, TL+BL+BR for back).
          const u = tile.u ?? 0.5
          const v = tile.v ?? 0.5
          const nearLeft = u < 0.5
          const nearTop = v < 0.5
          const needForward = nearLeft === nearTop
          map.setTileSplit(tx, tz, needForward ? 'forward' : 'back')
          if (nearLeft) map.paintTileFirst(tx, tz, state.paintType)
          else map.paintTileSecond(tx, tz, state.paintType)
        } else if (!state.halfPaint) {
          map.paintTile(tx, tz, state.paintType)
        }
      }
    }

    markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: cx - _pbr, z1: cz - _pbr, x2: cx + _pbr, z2: cz + _pbr } })
    return
  }

}

  // Returns the nearest tile-edge center {x, z} for wall placement based on cursor u/v
  // Walls snap 0.25 tiles inward from the chosen edge so the wall body sits inside
  // the tile with its outer face roughly flush at the tile boundary.
  function getWallEdgeSnap(hovered) {
    if (!hovered) return null
    const { x, z, u = 0.5, v = 0.5 } = hovered
    const dL = u, dR = 1 - u, dT = v, dB = 1 - v
    const min = Math.min(dL, dR, dT, dB)
    if (min === dL) return { x: x + 0.25, z: z + 0.5, edge: 8 }  // W
    if (min === dR) return { x: x + 0.75, z: z + 0.5, edge: 2 }  // E
    if (min === dT) return { x: x + 0.5,  z: z + 0.25, edge: 1 } // N
    return                 { x: x + 0.5,  z: z + 0.75, edge: 4 } // S
  }

  // Cache the (tile, nearest edge) signature so mousemove ticks that don't
  // change which edge is highlighted skip the 4-LinesMesh rebuild entirely.
  let hoverEdgeKey = null

  function clearHoverEdge() {
    if (hoverEdgeHelper) { hoverEdgeHelper.dispose(); hoverEdgeHelper = null }
    hoverEdgeKey = null
  }

  function updateHoverEdgeHelper() {
    if (state.tool !== ToolMode.PLACE) { clearHoverEdge(); return }
    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset?.name?.toLowerCase().includes('wall')) { clearHoverEdge(); return }
    const hovered = state.hovered
    if (hovered == null) { clearHoverEdge(); return }
    const { x, z, u = 0.5, v = 0.5 } = hovered
    const dists = [u, 1 - u, v, 1 - v]
    const nearestIdx = dists.indexOf(Math.min(...dists))

    const key = `${x},${z},${nearestIdx}`
    if (key === hoverEdgeKey && hoverEdgeHelper) return
    hoverEdgeKey = key

    if (hoverEdgeHelper) { hoverEdgeHelper.dispose(); hoverEdgeHelper = null }
    const h = map.getTileCornerHeights(x, z)

    // Marker positions match the inset snap positions
    const edges = [
      { px: x + 0.25, pz: z + 0.5,  ht: (h.tl * 0.75 + h.tr * 0.25 + h.bl * 0.75 + h.br * 0.25) * 0.5 },
      { px: x + 0.75, pz: z + 0.5,  ht: (h.tl * 0.25 + h.tr * 0.75 + h.bl * 0.25 + h.br * 0.75) * 0.5 },
      { px: x + 0.5,  pz: z + 0.25, ht: (h.tl * 0.75 + h.tr * 0.75 + h.bl * 0.25 + h.br * 0.25) * 0.5 },
      { px: x + 0.5,  pz: z + 0.75, ht: (h.tl * 0.25 + h.tr * 0.25 + h.bl * 0.75 + h.br * 0.75) * 0.5 },
    ]

    const group = new TransformNode('hoverEdge', scene)
    const S = 0.22

    for (let i = 0; i < 4; i++) {
      const { px, pz, ht } = edges[i]
      const y = ht + 0.06
      const active = i === nearestIdx
      const c = active ? new Color3(0.33, 0.67, 1.0) : new Color3(0.13, 0.33, 0.67)
      const alpha = active ? 1.0 : 0.45
      const segs = [
        [new Vector3(px - S, y, pz), new Vector3(px + S, y, pz)],
        [new Vector3(px, y, pz - S), new Vector3(px, y, pz + S)],
      ]
      const linesMesh = MeshBuilder.CreateLineSystem(`edgeLine_${i}`, { lines: segs }, scene)
      linesMesh.color = c
      linesMesh.alpha = alpha
      linesMesh.parent = group
    }

    hoverEdgeHelper = group
  }

  async function updatePreviewObject() {
    if (previewObject) {
      previewObject.dispose()
      previewObject = null
    }

    if (state.tool !== ToolMode.PLACE || !selectedAssetId) return

    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model, asset.path)

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
    }

    previewObject = makeGhostMaterial(model)
    model.dispose() // dispose the source instance — ghost is a separate clone
    previewObject.rotationQuaternion = null // use euler rotation instead of quaternion
    previewObject.rotation.set(previewRotation.x, previewRotation.y, previewRotation.z)
    previewObject.scaling.set(previewScale, previewScale, previewScale)
    previewObject.userData.assetId = asset.id
    // previewObject is already in the scene from makeGhostMaterial

    const pos = tileWorldPosition(state.hovered.x, state.hovered.z)
    if (asset.name?.toLowerCase().includes('wall')) {
      const snap = getWallEdgeSnap(state.hovered)
      if (snap) { pos.x = snap.x; pos.z = snap.z }
    }
    previewObject.position.copyFrom(pos)
  }

  async function placeSelectedAsset(tile, event) {
    if (!selectedAssetId) return

    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path)
    tuneModelLighting(model, asset.path)

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
    }

    pushUndoState('objects')

    const pos = tileWorldPosition(tile.x, tile.z)
    if (asset.name?.toLowerCase().includes('wall')) {
      const snap = getWallEdgeSnap(tile)
      if (snap) {
        pos.x = snap.x; pos.z = snap.z
      }
    }
    if (event) {
      const sp = pickSurfacePoint(event)
      if (sp) {
        pos.y = sp.y
        if (asset.path?.toLowerCase().includes('tree')) {
          pos.x = Math.round(sp.x)
          pos.z = Math.round(sp.z)
        }
      }
    }
    if (asset.path?.toLowerCase().includes('tree')) {
      pos.x = Math.round(pos.x)
      pos.z = Math.round(pos.z)
    }
    model.position.copyFrom(pos)
    model.rotationQuaternion = null // use euler rotation
    model.rotation.set(previewRotation.x, previewRotation.y, previewRotation.z)
    model.scaling.set(previewScale, previewScale, previewScale)
    model.userData.assetId = asset.id
    model.userData.type = 'asset'
    model.userData.layerId = activeLayerId
    addPlacedModel(model)
    invalidateShadowCache()
  }

  function replaceSelectedTexturesWith(textureId) {
    if (!selectedTexturePlanes.length) return
    pushUndoState('terrain')
    for (const plane of selectedTexturePlanes) {
      plane.textureId = textureId
      removeTexturePlaneMesh(plane)
      appendTexturePlane(plane)
    }
    updateSelectionHelper()
    updateToolUI()
  }

  async function replaceSelectedWith(assetId) {
    if (!selectedPlacedObjects.length) return
    const newAsset = assetRegistry.find((a) => a.id === assetId)
    if (!newAsset) return
    pushUndoState('objects')
    const replacements = []
    for (const obj of [...selectedPlacedObjects]) {
      const model = await loadAssetModel(newAsset.path)
      tuneModelLighting(model, newAsset.path)
      model.position.copyFrom(obj.position)
      if (obj.rotationQuaternion) {
        model.rotationQuaternion = obj.rotationQuaternion.clone()
      } else {
        model.rotationQuaternion = null
        model.rotation.copyFrom(obj.rotation)
      }
      model.scale.copyFrom(obj.scale)
      model.userData.assetId = newAsset.id
      model.userData.type = 'asset'
      model.userData.layerId = obj.userData.layerId || activeLayerId
      const _rLayer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(_rLayer ? _rLayer.visible : true)
      removePlacedModel(obj)
      addPlacedModel(model)
      replacements.push(model)
    }
    selectedPlacedObjects = replacements
    selectedPlacedObject = replacements[replacements.length - 1] || null
    invalidateShadowCache()
    updateSelectionHelper()
    updateToolUI()
  }

  async function duplicateSelected(mode = 'right') {
    const hasBoth = selectedTexturePlanes.length > 0 && selectedPlacedObjects.length > 0
    pushUndoState(hasBoth ? 'full' : (selectedTexturePlane ? 'terrain' : 'objects'))

    // Mixed selection: duplicate both types together with a shared offset
    if (hasBoth) {
      // Compute offset from the primary placed object (GLB snap logic)
      let offsetVec = new Vector3()
      if (mode !== 'inplace' && mode !== 'stack' && selectedPlacedObject) {
        const primaryFootprint = getObjectFootprint(selectedPlacedObject)
        const newPos = snapObjectFlushAlongPosition(
          selectedPlacedObject.position,
          selectedPlacedObject.rotation.y,
          primaryFootprint,
          primaryFootprint,
          ['forward', 'back'].includes(mode) ? mode : (mode === 'left' ? 'left' : 'right')
        )
        offsetVec = newPos.subtract(selectedPlacedObject.position)
      }

      // Duplicate texture planes
      const newPlanes = []
      for (const src of selectedTexturePlanes) {
        const clone = JSON.parse(JSON.stringify(src))
        clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`
        clone.position.x += offsetVec.x
        clone.position.y += offsetVec.y
        clone.position.z += offsetVec.z
        map.texturePlanes.push(clone)
        newPlanes.push(clone)
      }
      for (const p of newPlanes) appendTexturePlane(p)

      // Duplicate GLB objects
      const newModels = []
      for (const src of selectedPlacedObjects) {
        if (!src.userData?.assetId) continue
        const asset = assetRegistry.find((a) => a.id === src.userData.assetId)
        if (!asset) continue
        const model = await loadAssetModel(asset.path)
        tuneModelLighting(model, asset.path)
        if (src.rotationQuaternion) {
          model.rotationQuaternion = src.rotationQuaternion.clone()
        } else {
          model.rotationQuaternion = null
          model.rotation.copyFrom(src.rotation)
        }
        model.scale.copyFrom(src.scale)
        model.userData.assetId = asset.id
        model.userData.type = 'asset'
        model.userData.layerId = src.userData.layerId || activeLayerId
        addPlacedModel(model)
        model.computeWorldMatrix(true)
        model.position.copyFrom(src.position.add(offsetVec))
        newModels.push(model)
      }

      selectedTexturePlanes = newPlanes
      selectedTexturePlane = newPlanes[newPlanes.length - 1] ?? null
      selectedPlacedObjects = newModels
      selectedPlacedObject = newModels[newModels.length - 1] ?? null
      invalidateShadowCache()
      updateSelectionHelper()
      updateToolUI()
      return
    }

    if (selectedTexturePlane) {
      if (selectedTexturePlanes.length > 1) {
        // Compute offset from primary plane then apply it to all
        let offsetX = 0, offsetZ = 0, offsetY = 0
        if (mode !== 'stack' && mode !== 'inplace') {
          const primaryClone = JSON.parse(JSON.stringify(selectedTexturePlane))
          if (mode === 'forward' || mode === 'back') {
            snapPlaneFlushAlong(primaryClone, selectedTexturePlane, mode)
          } else {
            snapPlaneFlushAlong(primaryClone, selectedTexturePlane, mode === 'left' ? 'left' : 'right')
          }
          offsetX = primaryClone.position.x - selectedTexturePlane.position.x
          offsetZ = primaryClone.position.z - selectedTexturePlane.position.z
          offsetY = primaryClone.position.y - selectedTexturePlane.position.y
        }

        const newPlanes = []
        for (const src of selectedTexturePlanes) {
          const clone = JSON.parse(JSON.stringify(src))
          clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`
          if (mode === 'stack') {
            stackPlaneAbove(clone, src)
          } else {
            clone.position.x = src.position.x + offsetX
            clone.position.z = src.position.z + offsetZ
            clone.position.y = src.position.y + offsetY
          }
          map.texturePlanes.push(clone)
          newPlanes.push(clone)
        }

        selectedTexturePlanes = newPlanes
        selectedTexturePlane = newPlanes[newPlanes.length - 1]
        selectedPlacedObject = null
        for (const p of newPlanes) appendTexturePlane(p)
        updateSelectionHelper()
        updateToolUI()
        return
      }

      const clone = JSON.parse(JSON.stringify(selectedTexturePlane))
      clone.id = `plane_${Date.now()}_${Math.floor(Math.random() * 100000)}`

      if (mode === 'inplace') {
        // keep same position
      } else if (mode === 'stack') {
        stackPlaneAbove(clone, selectedTexturePlane)
      } else {
        snapPlaneFlushAlong(clone, selectedTexturePlane, mode === 'forward' || mode === 'back' ? mode : (mode === 'left' ? 'left' : 'right'))
      }

      map.texturePlanes.push(clone)
      selectedTexturePlane = clone
      selectedTexturePlanes = [clone]
      selectedPlacedObject = null
      appendTexturePlane(clone)
      updateSelectionHelper()
      updateToolUI()
      return
    }

    if (selectedPlacedObjects.length > 1) {
      let offsetVec = new Vector3()

      if (mode !== 'stack') {
        const primaryFootprint = getObjectFootprint(selectedPlacedObject)
        const newPos = snapObjectFlushAlongPosition(
          selectedPlacedObject.position,
          selectedPlacedObject.rotation.y,
          primaryFootprint,
          primaryFootprint,
          ['forward','back'].includes(mode) ? mode : (mode === 'left' ? 'left' : 'right')
        )
        offsetVec = newPos.subtract(selectedPlacedObject.position)
      }

      const newModels = []
      for (const src of selectedPlacedObjects) {
        if (!src.userData?.assetId) continue
        const asset = assetRegistry.find((a) => a.id === src.userData.assetId)
        if (!asset) continue

        const model = await loadAssetModel(asset.path)
        tuneModelLighting(model, asset.path)
        if (src.rotationQuaternion) {
          model.rotationQuaternion = src.rotationQuaternion.clone()
        } else {
          model.rotationQuaternion = null
          model.rotation.copyFrom(src.rotation)
        }
        model.scale.copyFrom(src.scale)
        model.userData.assetId = asset.id
        model.userData.type = 'asset'
        model.userData.layerId = src.userData.layerId || activeLayerId
        addPlacedModel(model)
        model.computeWorldMatrix(true)

        if (mode === 'inplace') {
          model.position.copyFrom(src.position)
        } else if (mode === 'stack') {
          const srcFootprint = getObjectFootprint(src)
          const cloneFootprint = getObjectFootprint(model)
          model.position.copyFrom(src.position)
          model.position.y += (srcFootprint.height + cloneFootprint.height) * 0.5
        } else {
          model.position.copyFrom(src.position.add(offsetVec))
        }

        newModels.push(model)
      }

      if (newModels.length > 0) {
        selectedPlacedObject = newModels[0]
        selectedPlacedObjects = [...newModels]
        selectedTexturePlane = null
      selectedTexturePlanes = []
        invalidateShadowCache()
        updateSelectionHelper()
        updateToolUI()
      }
      return
    }

    if (selectedPlacedObject?.userData?.assetId) {
      const asset = assetRegistry.find((a) => a.id === selectedPlacedObject.userData.assetId)
      if (!asset) return

      const model = await loadAssetModel(asset.path)
      tuneModelLighting(model, asset.path)

      const targetFootprint = getObjectFootprint(selectedPlacedObject)

      if (selectedPlacedObject.rotationQuaternion) {
        model.rotationQuaternion = selectedPlacedObject.rotationQuaternion.clone()
      } else {
        model.rotationQuaternion = null
        model.rotation.copyFrom(selectedPlacedObject.rotation)
      }
      model.scale.copyFrom(selectedPlacedObject.scale)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = selectedPlacedObject.userData.layerId || activeLayerId

      addPlacedModel(model)
      model.computeWorldMatrix(true)

      const sourceFootprint = getObjectFootprint(model)

      if (mode === 'inplace') {
        model.position.copyFrom(selectedPlacedObject.position)
      } else if (mode === 'stack') {
        model.position.copyFrom(selectedPlacedObject.position)
        model.position.y += (targetFootprint.height + sourceFootprint.height) * 0.5
      } else {
        model.position.copyFrom(
          snapObjectFlushAlongPosition(
            selectedPlacedObject.position,
            selectedPlacedObject.rotation.y,
            targetFootprint,
            sourceFootprint,
            ['forward','back'].includes(mode) ? mode : (mode === 'left' ? 'left' : 'right')
          )
        )
      }

      selectedPlacedObject = model
      selectedPlacedObjects = [model]
      selectedTexturePlane = null
      selectedTexturePlanes = []
      invalidateShadowCache()
      updateSelectionHelper()
      updateToolUI()
    }
  }

  function beginTransform(mode) {
    if (!selectedTexturePlane && !selectedPlacedObject) return

    const hasBoth = selectedTexturePlanes.length > 0 && selectedPlacedObjects.length > 0
    pushUndoState(hasBoth ? 'full' : (selectedTexturePlane ? 'terrain' : 'objects'))
    transformMode = mode
    transformLift = 0
    movePlaneStart = null

    if (mode === 'scale') transformAxis = 'all'

    // Determine primary anchor: prefer whichever was selected last
    const primaryIsPlane = selectedTexturePlane && (!selectedPlacedObject ||
      (selectedTexturePlanes.indexOf(selectedTexturePlane) >= selectedPlacedObjects.indexOf(selectedPlacedObject)))

    const _getRotEuler = (o) => {
      if (o.rotationQuaternion) {
        const e = o.rotationQuaternion.toEulerAngles()
        return { x: e.x, y: e.y, z: e.z }
      }
      return { x: o.rotation.x, y: o.rotation.y, z: o.rotation.z }
    }

    if (primaryIsPlane) {
      transformStart = JSON.parse(JSON.stringify({
        primaryType: 'plane',
        position: selectedTexturePlane.position,
        rotation: selectedTexturePlane.rotation,
        scale: selectedTexturePlane.scale,
        width: selectedTexturePlane.width,
        height: selectedTexturePlane.height,
        groupStarts: selectedTexturePlanes
          .filter((p) => p !== selectedTexturePlane)
          .map((p) => ({ plane: p, position: { ...p.position }, rotation: { ...p.rotation } }))
      }))
      // Re-attach plane references (JSON.parse loses them)
      if (transformStart.groupStarts) {
        const others = selectedTexturePlanes.filter((p) => p !== selectedTexturePlane)
        for (let i = 0; i < transformStart.groupStarts.length; i++) {
          transformStart.groupStarts[i].plane = others[i]
        }
      }
      // Also capture GLB objects as cross-type group members
      if (selectedPlacedObjects.length > 0) {
        transformStart.crossGroupStarts = selectedPlacedObjects.map((o) => ({
          obj: o,
          position: o.position.clone(),
        }))
      }
    } else if (selectedPlacedObject) {
      transformStart = {
        primaryType: 'object',
        position: selectedPlacedObject.position.clone(),
        rotation: _getRotEuler(selectedPlacedObject),
        quaternion: selectedPlacedObject.rotationQuaternion?.clone() || null,
        scale: selectedPlacedObject.scale.clone(),
        groupStarts: selectedPlacedObjects
          .filter((o) => o !== selectedPlacedObject)
          .map((o) => ({
            obj: o,
            position: o.position.clone(),
            rotation: _getRotEuler(o),
            quaternion: o.rotationQuaternion?.clone() || null
          }))
      }
      // Also capture texture planes as cross-type group members
      if (selectedTexturePlanes.length > 0) {
        transformStart.crossPlaneStarts = selectedTexturePlanes.map((p) => ({
          plane: p,
          position: { ...p.position },
        }))
      }
    }

    updateToolUI()
  }

  function cancelTransform() {
    if (!transformMode || !transformStart) return

    const primaryIsPlane = transformStart.primaryType === 'plane'

    if (primaryIsPlane) {
      // Primary was a texture plane
      if (selectedTexturePlane) {
        selectedTexturePlane.position = { ...transformStart.position }
        selectedTexturePlane.rotation = { ...transformStart.rotation }
        selectedTexturePlane.scale = { ...transformStart.scale }
        selectedTexturePlane.width = transformStart.width
        selectedTexturePlane.height = transformStart.height
        updateTexturePlaneMeshTransform(selectedTexturePlane)
      }
      if (transformStart.groupStarts?.length) {
        for (const { plane, position, rotation } of transformStart.groupStarts) {
          plane.position = { ...position }
          plane.rotation = { ...rotation }
          updateTexturePlaneMeshTransform(plane)
        }
      }
      if (transformStart.crossGroupStarts?.length) {
        for (const { obj, position } of transformStart.crossGroupStarts) {
          obj.position.copyFrom(position)
        }
      }
    } else {
      // Primary was a GLB object
      if (selectedPlacedObject) {
        selectedPlacedObject.position.copyFrom(transformStart.position)
        if (transformStart.quaternion) {
          selectedPlacedObject.rotationQuaternion = transformStart.quaternion.clone()
        } else {
          selectedPlacedObject.rotationQuaternion = null
          selectedPlacedObject.rotation.set(
            transformStart.rotation.x,
            transformStart.rotation.y,
            transformStart.rotation.z
          )
        }
        selectedPlacedObject.scale.copyFrom(transformStart.scale)
      }
      if (transformStart.groupStarts?.length) {
        for (const { obj, position, rotation, quaternion } of transformStart.groupStarts) {
          obj.position.copyFrom(position)
          if (quaternion) {
            obj.rotationQuaternion = quaternion.clone()
          } else if (rotation) {
            obj.rotationQuaternion = null
            obj.rotation.set(rotation.x, rotation.y, rotation.z)
          }
        }
      }
      if (transformStart.crossPlaneStarts?.length) {
        for (const { plane, position } of transformStart.crossPlaneStarts) {
          plane.position = { ...position }
          updateTexturePlaneMeshTransform(plane)
        }
      }
    }

    // Re-register moved GLB objects at their restored positions
    if (transformMode === 'move' && selectedPlacedObjects.length) {
      for (const obj of selectedPlacedObjects) {
        _spatialUnregister(obj)
        _spatialRegister(obj)
      }
      invalidateShadowCache()
    }

    updateSelectionHelper()

    if (transformMode === 'rotate') lastRotateAxis = transformAxis
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateToolUI()
  }

  function confirmTransform() {
    if (transformMode === 'move') {
      for (const obj of selectedPlacedObjects) {
        _spatialUnregister(obj)
        _spatialRegister(obj)
      }
      invalidateShadowCache()
    }

    if (transformMode === 'rotate') {
      applyRotationSnapOnConfirm()
      lastRotateAxis = transformAxis
    }

    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateToolUI()
  }

  function countAssetsByGroup(section) {
    const counts = new Map()
    for (const asset of assetRegistry) {
      if (section !== 'all' && asset.section !== section) continue
      counts.set(asset.group, (counts.get(asset.group) || 0) + 1)
    }
    return counts
  }

  function refreshAssetGroupOptions() {
    const counts = countAssetsByGroup(assetSectionFilter)
    assetGroupsForCurrentSection = ['all', ...Array.from(counts.keys()).sort((a, b) => a.localeCompare(b))]

    assetGroupSelect.innerHTML = ''
    for (const group of assetGroupsForCurrentSection) {
      const option = document.createElement('option')
      option.value = group
      option.textContent =
        group === 'all'
          ? `All (${Array.from(counts.values()).reduce((a, b) => a + b, 0)})`
          : `${group} (${counts.get(group) || 0})`
      assetGroupSelect.appendChild(option)
    }

    if (!assetGroupsForCurrentSection.includes(assetGroupFilter)) assetGroupFilter = 'all'
    assetGroupSelect.value = assetGroupFilter
  }

  // --- Thumbnail system ---
  const thumbnailCache = new Map()
  let assetGridThumbObserver = null
  let replaceGridThumbObserver = null

  function createThumbObserver(rootEl) {
    return new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        obs.unobserve(entry.target)
        const path = entry.target.dataset.assetPath
        if (!path) continue
        getThumbnail(path)
          .then((url) => { if (url) entry.target.src = url })
          .catch(() => {})
      }
    }, { root: rootEl, rootMargin: '150px', threshold: 0.01 })
  }

  function generateThumbnail(asset) {
    if (thumbnailCache.has(asset.id)) return Promise.resolve(thumbnailCache.get(asset.id))

    const cvs = document.createElement('canvas')
    cvs.width = 80
    cvs.height = 80
    const ctx = cvs.getContext('2d')

    const pathLower = asset.path?.toLowerCase() || ''
    if (pathLower.includes('white')) ctx.fillStyle = '#889'
    else if (pathLower.includes('wood')) ctx.fillStyle = '#654'
    else if (pathLower.includes('dark stone')) ctx.fillStyle = '#433'
    else if (pathLower.includes('stone')) ctx.fillStyle = '#776'
    else if (pathLower.includes('tree') || pathLower.includes('bush') || pathLower.includes('grass')) ctx.fillStyle = '#264'
    else if (pathLower.includes('rock')) ctx.fillStyle = '#554'
    else if (pathLower.includes('fence') || pathLower.includes('gate')) ctx.fillStyle = '#543'
    else if (pathLower.includes('roof')) ctx.fillStyle = '#744'
    else ctx.fillStyle = '#445'
    ctx.fillRect(0, 0, 80, 80)

    ctx.fillStyle = '#fff'
    ctx.font = 'bold 11px sans-serif'
    ctx.textAlign = 'center'
    const name = asset.name || asset.id || '?'
    const words = name.split(/\s+/)
    const startY = 40 - (words.length - 1) * 7
    for (let i = 0; i < Math.min(words.length, 5); i++) {
      ctx.fillText(words[i], 40, startY + i * 14)
    }

    const dataUrl = cvs.toDataURL()
    thumbnailCache.set(asset.id, dataUrl)
    return Promise.resolve(dataUrl)
  }

  function refreshAssetList() {
    const q = assetSearch.value.trim().toLowerCase()

    const WALL_FILES = ['stone wall.glb', 'dark stone wall.glb', 'white wall.glb', 'wood wall.glb']

    filteredAssets = assetRegistry.filter((asset) => {
      if (assetSectionFilter === '__walls__') {
        const fileName = asset.path.split('/').pop().toLowerCase()
        return WALL_FILES.includes(fileName)
      }
      if (assetSectionFilter !== 'all' && asset.section !== assetSectionFilter) return false
      if (assetGroupFilter !== 'all' && asset.group !== assetGroupFilter) return false

      if (!q) return true

      const haystack = [
        asset.name,
        asset.section,
        asset.group,
        asset.folderPath,
        ...(asset.tags || [])
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(q)
    })

    if (filteredAssets.length && !filteredAssets.find((a) => a.id === selectedAssetId)) {
      selectedAssetId = filteredAssets[0].id
    }

    assetGrid.innerHTML = ''
    if (assetGridThumbObserver) assetGridThumbObserver.disconnect()
    assetGridThumbObserver = createThumbObserver(assetGrid)

    if (!filteredAssets.length) {
      assetGrid.innerHTML = '<div class="asset-grid-empty">No assets found</div>'
      updateToolUI()
      return
    }

    for (const asset of filteredAssets) {
      const card = document.createElement('div')
      card.className = 'asset-card' + (asset.id === selectedAssetId ? ' selected' : '')
      card.dataset.assetId = asset.id

      const img = document.createElement('img')
      img.className = 'asset-thumb'
      img.alt = asset.name
      img.dataset.assetPath = asset.path

      const label = document.createElement('div')
      label.className = 'asset-label'
      label.textContent = asset.name

      const rotateBtn = document.createElement('div')
      rotateBtn.className = 'asset-rotate-btn'
      rotateBtn.textContent = '↻'
      rotateBtn.title = 'Edit thumbnail rotation'
      rotateBtn.addEventListener('click', (ev) => {
        ev.stopPropagation()
        const path = asset.path
        openThumbnailRotationEditor(path, () => {
          // Re-render the asset thumbnail now that the override changed.
          getThumbnail(path).then((url) => { if (url) img.src = url }).catch(() => {})
        })
      })

      card.appendChild(img)
      card.appendChild(label)
      card.appendChild(rotateBtn)
      assetGrid.appendChild(card)

      card.addEventListener('click', async () => {
        selectedAssetId = asset.id
        assetGrid.querySelectorAll('.asset-card').forEach((c) => c.classList.remove('selected'))
        card.classList.add('selected')
        // Always reset the slider on asset switch — to the asset's defaultScale
        // if present, otherwise to 1.0. Without this, picking grass (0.5) and
        // then any other asset would leave the slider stuck at 0.5.
        const targetScale = (typeof asset.defaultScale === 'number' && asset.defaultScale > 0)
          ? asset.defaultScale
          : 1.0
        previewScale = targetScale
        placeScaleSlider.value = String(targetScale)
        placeScaleLabel.textContent = targetScale.toFixed(1)
        updateToolUI()
        await updatePreviewObject()
      })

      generateThumbnail(asset).then((url) => {
        if (url) img.src = url
      })
      assetGridThumbObserver.observe(img)
    }

    updateToolUI()
  }

  function refreshTexturePalette() {
    const q = textureSearch.value.trim().toLowerCase()

    filteredTextures = textureRegistry.filter((tex) => {
      const name = (tex.name || '').toLowerCase()
      const id = String(tex.id || '').toLowerCase()
      return name.includes(q) || id.includes(q)
    })

    if (
      filteredTextures.length &&
      !filteredTextures.find((tex) => tex.id === selectedTextureId)
    ) {
      selectedTextureId = filteredTextures[0].id
    }

    texturePalette.innerHTML = ''

    if (!filteredTextures.length) {
      texturePalette.innerHTML = `
        <div style="grid-column:1 / -1; font-size:12px; opacity:0.8; padding:8px 0;">
          No textures found
        </div>
      `
      return
    }

    for (const tex of filteredTextures) {
      const wrap = document.createElement('div')
      wrap.style.display = 'flex'
      wrap.style.flexDirection = 'column'
      wrap.style.alignItems = 'center'
      wrap.style.gap = '4px'

      const img = document.createElement('img')
      img.src = tex.path
      img.title = tex.name || tex.id
      img.style.width = '56px'
      img.style.height = '56px'
      img.style.objectFit = 'cover'
      img.style.border = tex.id === selectedTextureId ? '2px solid #2d6cdf' : '2px solid transparent'
      img.style.cursor = 'pointer'
      img.style.borderRadius = '4px'
      img.style.display = 'block'

      img.onerror = () => {
        img.style.border = '2px solid red'
        img.title = `Failed to load: ${tex.path}`
      }

      img.addEventListener('click', () => {
        selectedTextureId = tex.id
        refreshTexturePalette()
        updateToolUI()
      })

      img.addEventListener('dblclick', () => {
        selectedTextureId = tex.id
        setTool(ToolMode.TEXTURE_PLANE)
        refreshTexturePalette()
        updateToolUI()
      })

      const label = document.createElement('div')
      label.textContent = tex.name
      label.style.fontSize = '10px'
      label.style.textAlign = 'center'
      label.style.wordBreak = 'break-word'

      wrap.appendChild(img)
      wrap.appendChild(label)
      texturePalette.appendChild(wrap)
    }
  }

  const paintTexturePalette = sidebar.querySelector('#paintTexturePalette')
  const paintTextureSearch = sidebar.querySelector('#paintTextureSearch')
  const texSlotA = sidebar.querySelector('#texSlotA')
  const texSlotB = sidebar.querySelector('#texSlotB')
  let paintTextureCat = 'all'

  function refreshSlotUI() {
    const activeId = paintTextureSlot === 'A' ? paintTabTextureId : paintTabTextureIdB
    const inactiveId = paintTextureSlot === 'A' ? paintTabTextureIdB : paintTabTextureId
    const activeTex = textureRegistry.find(t => t.id === activeId)
    const inactiveTex = textureRegistry.find(t => t.id === inactiveId)

    if (texSlotA) {
      const isA = paintTextureSlot === 'A'
      texSlotA.style.border = `2px solid ${isA ? '#2d6cdf' : '#444'}`
      const aId = paintTabTextureId
      const aTex = textureRegistry.find(t => t.id === aId)
      texSlotA.style.backgroundImage = aTex ? `url(${aTex.path})` : 'none'
      texSlotA.textContent = aTex ? '' : 'A'
    }
    if (texSlotB) {
      const isB = paintTextureSlot === 'B'
      texSlotB.style.border = `2px solid ${isB ? '#2d6cdf' : '#444'}`
      const bTex = textureRegistry.find(t => t.id === paintTabTextureIdB)
      texSlotB.style.backgroundImage = bTex ? `url(${bTex.path})` : 'none'
      texSlotB.textContent = bTex ? '' : 'B'
    }
  }

  texSlotA?.addEventListener('click', () => { paintTextureSlot = 'A'; refreshSlotUI(); refreshPaintTexturePalette() })
  texSlotB?.addEventListener('click', () => { paintTextureSlot = 'B'; refreshSlotUI(); refreshPaintTexturePalette() })

  const texCatAll = sidebar.querySelector('#texCatAll')
  const texCatStretched = sidebar.querySelector('#texCatStretched')
  texCatAll?.addEventListener('click', () => { paintTextureCat = 'all'; refreshPaintTexturePalette() })
  texCatStretched?.addEventListener('click', () => { paintTextureCat = 'stretched'; refreshPaintTexturePalette() })

  function refreshPaintTexturePalette() {
    if (!paintTexturePalette) return
    const q = (paintTextureSearch?.value || '').trim().toLowerCase()
    const list = textureRegistry.filter((tex) => {
      if (paintTextureCat === 'stretched' && !tex.defaultScale) return false
      if (paintTextureCat === 'all' && tex.defaultScale) return false
      const name = (tex.name || '').toLowerCase()
      return !q || name.includes(q) || String(tex.id).toLowerCase().includes(q)
    })
    const activeSlotId = paintTextureSlot === 'A' ? paintTabTextureId : paintTabTextureIdB
    paintTexturePalette.innerHTML = ''
    for (const tex of list) {
      const img = document.createElement('img')
      img.src = tex.path
      img.title = tex.name || tex.id
      img.style.cssText = `width:100%;aspect-ratio:1;object-fit:cover;cursor:pointer;border-radius:3px;border:2px solid ${tex.id === activeSlotId ? '#2d6cdf' : 'transparent'};`
      img.addEventListener('click', () => {
        if (paintTextureSlot === 'B') {
          paintTabTextureIdB = tex.id
        } else {
          paintTabTextureId = tex.id
          textureWorldUV = !!tex.defaultScale
          if (tex.defaultScale) {
            textureScale = tex.defaultScale
            if (paintTextureScaleSlider) {
              paintTextureScaleSlider.value = tex.defaultScale
              if (paintTextureScaleVal) paintTextureScaleVal.textContent = tex.defaultScale
            }
          } else {
            textureWorldUV = false
          }
        }
        setTool(ToolMode.PAINT)
        refreshSlotUI()
        refreshPaintTexturePalette()
        updateToolUI()
      })
      paintTexturePalette.appendChild(img)
    }
  }

  paintTextureSearch?.addEventListener('input', refreshPaintTexturePalette)

  const paintTextureScaleRow = sidebar.querySelector('#paintTextureScaleRow')
  const paintTextureScaleSlider = sidebar.querySelector('#paintTextureScale')
  const paintTextureScaleVal = sidebar.querySelector('#paintTextureScaleVal')
  paintTextureScaleSlider?.addEventListener('input', (e) => {
    textureScale = Number(e.target.value)
    if (paintTextureScaleVal) paintTextureScaleVal.textContent = textureScale
  })

  const eraseTextureBrushBtn = sidebar.querySelector('#eraseTextureBrushBtn')
  eraseTextureBrushBtn?.addEventListener('click', () => {
    paintTabTextureId = '__erase__'
    setTool(ToolMode.PAINT)
    refreshPaintTexturePalette()
    updateToolUI()
  })

  sidebar.querySelector('#paintToggleDiagFloor')?.addEventListener('change', (e) => {
    diagFloorMode = e.target.checked
    if (!diagFloorMode) cancelDiagFloor()
    updateToolUI()
  })

  sidebar.querySelector('#paintDiagFloorWidthSlider')?.addEventListener('input', (e) => {
    diagFloorWidth = Number(e.target.value)
    sidebar.querySelector('#paintDiagFloorWidthVal').textContent = diagFloorWidth
    sidebar.querySelector('#diagFloorWidthVal').textContent = diagFloorWidth
    sidebar.querySelector('#diagFloorWidthSlider').value = diagFloorWidth
  })

  const allTabs = [tabProps, tabModular, tabWalls, tabRoofs, tabBought]
  const clearTabs = () => allTabs.forEach(t => t.classList.remove('active'))

  tabProps.addEventListener('click', async () => {
    assetSectionFilter = 'Models'
    assetGroupFilter = 'all'
    clearTabs(); tabProps.classList.add('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  tabModular.addEventListener('click', async () => {
    assetSectionFilter = 'Modular Assets'
    assetGroupFilter = 'all'
    clearTabs(); tabModular.classList.add('active')
    assetGroupSelect.style.display = ''
    refreshAssetGroupOptions()
    refreshAssetList()
    await updatePreviewObject()
  })

  tabWalls.addEventListener('click', async () => {
    assetSectionFilter = '__walls__'
    assetGroupFilter = 'all'
    clearTabs(); tabWalls.classList.add('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  tabRoofs.addEventListener('click', async () => {
    assetSectionFilter = 'Roofs'
    assetGroupFilter = 'all'
    clearTabs(); tabRoofs.classList.add('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  tabBought.addEventListener('click', async () => {
    assetSectionFilter = 'Bought Assets'
    assetGroupFilter = 'all'
    clearTabs(); tabBought.classList.add('active')
    assetGroupSelect.style.display = ''
    refreshAssetGroupOptions()
    refreshAssetList()
    await updatePreviewObject()
  })

  assetGroupSelect.addEventListener('change', async (e) => {
    assetGroupFilter = e.target.value
    refreshAssetList()
    await updatePreviewObject()
  })

  assetSearch.addEventListener('input', refreshAssetList)

  refreshPreviewBtn.addEventListener('click', async () => {
    await updatePreviewObject()
  })

  placeScaleSlider.addEventListener('input', () => {
    previewScale = parseFloat(placeScaleSlider.value)
    placeScaleLabel.textContent = previewScale.toFixed(1)
    if (previewObject) {
      previewObject.scaling.set(previewScale, previewScale, previewScale)
    }
  })

  textureSearch.addEventListener('input', refreshTexturePalette)

  useTexturePlaneBtn.addEventListener('click', () => {
    setTool(ToolMode.TEXTURE_PLANE)
  })

  smoothModeBtn.addEventListener('click', () => {
    state.smoothMode = !state.smoothMode
    if (state.smoothMode) { state.levelMode = false; state.levelHeight = null }
    updateToolUI()
  })

  levelModeBtn.addEventListener('click', () => {
    state.levelMode = !state.levelMode
    state.levelHeight = null
    if (state.levelMode) state.smoothMode = false
    updateToolUI()
  })

  const brushSizeSlider = sidebar.querySelector('#brushSizeSlider')
  const brushSizeLabel = sidebar.querySelector('#brushSizeLabel')

  brushSizeSlider.addEventListener('input', (e) => {
    brushRadius = parseFloat(e.target.value)
    brushSizeLabel.textContent = brushRadius.toFixed(1)
  })

  const paintBrushSizeSlider = sidebar.querySelector('#paintBrushSizeSlider')
  const paintBrushSizeLabel = sidebar.querySelector('#paintBrushSizeLabel')

  paintBrushSizeSlider.addEventListener('input', (e) => {
    paintBrushRadius = parseInt(e.target.value)
    paintBrushSizeLabel.textContent = paintBrushRadius
  })


  const levelHeightRow = sidebar.querySelector('#levelHeightRow')
  const levelHeightInput = sidebar.querySelector('#levelHeightInput')

  levelHeightInput.addEventListener('change', (e) => {
    const val = parseFloat(e.target.value)
    if (Number.isFinite(val)) state.levelHeight = val
  })

  sidebar.querySelector('#clearLevelHeight').addEventListener('click', () => {
    state.levelHeight = null
    levelHeightInput.value = ''
  })

  async function getSaveHandle() {
    if (saveFileHandle) return saveFileHandle
    return null
  }

  async function idbGet(key) {
    return new Promise((resolve) => {
      const req = indexedDB.open('projectrs', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readonly')
        const r = tx.objectStore('kv').get(key)
        r.onsuccess = () => resolve(r.result)
        r.onerror = () => resolve(null)
      }
      req.onerror = () => resolve(null)
    })
  }

  async function idbSet(key, value) {
    return new Promise((resolve) => {
      const req = indexedDB.open('projectrs', 1)
      req.onupgradeneeded = () => req.result.createObjectStore('kv')
      req.onsuccess = () => {
        const tx = req.result.transaction('kv', 'readwrite')
        tx.objectStore('kv').put(value, key)
        tx.oncomplete = resolve
        tx.onerror = resolve
      }
      req.onerror = resolve
    })
  }

  saveMapBtn.addEventListener('click', async () => {
    const suggestedName = map.mapType === 'dungeon' ? 'dungeon.json' : 'main.json'
    if (!window.showSaveFilePicker) { downloadJSON(suggestedName, buildSaveData()); return }
    try {
      let handle = await getSaveHandle()
      if (!handle) {
        handle = await window.showSaveFilePicker({
          suggestedName,
          types: [{ description: 'JSON Map', accept: { 'application/json': ['.json'] } }]
        })
        saveFileHandle = handle
      }
      const writable = await handle.createWritable()
      await writable.write(JSON.stringify(buildSaveData(), null, 2))
      await writable.close()
      const prev = statusText.textContent
      statusText.textContent = 'Saved'
      setTimeout(() => { statusText.textContent = prev }, 1500)
    } catch (e) {
      if (e.name !== 'AbortError') { console.warn('Save failed:', e); downloadJSON('main.json', buildSaveData()) }
    }
  })

  const restoreAutoSaveBtn = topBar.querySelector('#restoreAutoSaveBtn')
  restoreAutoSaveBtn.addEventListener('click', async () => {
    const raw = localStorage.getItem('projectrs-autosave')
    if (!raw) { alert('No auto-save found.'); return }
    await loadSaveData(JSON.parse(raw))
  })

  // --- Server map integration ---
  const SERVER_API = '/api/editor'
  const serverMapSelect = topBar.querySelector('#serverMapSelect')
  const serverLoadBtn = topBar.querySelector('#serverLoadBtn')
  const serverSaveBtn = topBar.querySelector('#serverSaveBtn')
  const serverReloadBtn = topBar.querySelector('#serverReloadBtn')
  const questsBtn = topBar.querySelector('#questsBtn')

  // Quests editor — structured form. Two-pane modal: list of quests on the
  // left (with new/delete), per-quest editor on the right with all fields
  // exposed as proper inputs (no JSON). Save POSTs the entire array to
  // /api/editor/quests; server hot-reloads via DataLoader.reloadQuests.
  // Reuses the existing item-picker datalist and npcDefs cache so authors
  // pick by name rather than typing IDs.
  questsBtn?.addEventListener('click', () => openQuestsEditor())

  async function openQuestsEditor() {
    const existing = document.getElementById('questsModal')
    if (existing) { existing.style.display = 'flex'; return }

    const ALL_QUEST_SKILLS = [
      'accuracy', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery', 'hitpoints',
      'woodcut', 'fishing', 'cooking', 'mining', 'smithing', 'crafting', 'roguery',
    ]

    let quests = []
    let objectDefs = []
    let selectedQuestId = null

    const overlay = document.createElement('div')
    overlay.id = 'questsModal'
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:999;display:flex;align-items:center;justify-content:center;'
    overlay.innerHTML = `
      <div style="background:#1a1a1a;border:1px solid #555;border-radius:6px;width:min(960px,95vw);max-height:88vh;display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #333;">
          <div style="font-size:14px;font-weight:700;color:#eee;flex:1;">Quests Editor</div>
          <button id="qSaveAll" style="background:#3a6c3a;color:#fff;border:1px solid #555;border-radius:3px;padding:5px 12px;font-size:12px;cursor:pointer;">Save All</button>
          <span id="qStatus" style="font-size:11px;color:#888;min-width:120px;text-align:right;"></span>
          <button id="qClose" style="background:#3a3a3a;color:#fff;border:1px solid #555;border-radius:3px;padding:5px 10px;font-size:12px;cursor:pointer;">Close</button>
        </div>
        <div style="display:flex;flex:1;min-height:0;">
          <div id="qListPane" style="width:240px;border-right:1px solid #333;display:flex;flex-direction:column;background:#161616;">
            <div style="padding:8px;display:flex;gap:6px;">
              <button id="qNew" style="flex:1;background:#2a4a6c;color:#fff;border:1px solid #555;border-radius:3px;padding:5px;font-size:11px;cursor:pointer;">+ New Quest</button>
              <button id="qDelete" style="background:#6c2a2a;color:#fff;border:1px solid #555;border-radius:3px;padding:5px 10px;font-size:11px;cursor:pointer;" title="Delete selected">×</button>
            </div>
            <div id="qList" style="flex:1;overflow-y:auto;padding:0 8px 8px 8px;"></div>
          </div>
          <div id="qEditor" style="flex:1;overflow-y:auto;padding:14px 18px;color:#ddd;font-family:Arial,Helvetica,sans-serif;"></div>
        </div>
      </div>`
    document.body.appendChild(overlay)

    const listEl = overlay.querySelector('#qList')
    const editorEl = overlay.querySelector('#qEditor')
    const statusEl = overlay.querySelector('#qStatus')
    const setStatus = (msg, color) => { statusEl.textContent = msg; statusEl.style.color = color || '#888'; if (color) setTimeout(() => { if (statusEl.textContent === msg) statusEl.textContent = '' }, 4000) }

    overlay.querySelector('#qClose').addEventListener('click', () => { overlay.style.display = 'none' })
    overlay.querySelector('#qNew').addEventListener('click', () => {
      const id = 'quest_' + Math.random().toString(36).slice(2, 7)
      quests.push({ id, name: 'New quest', blurb: '', stages: [{ id: 0, description: '', trigger: { type: 'dialogue' } }], rewards: {} })
      selectedQuestId = id
      renderList(); renderEditor()
    })
    overlay.querySelector('#qDelete').addEventListener('click', () => {
      if (!selectedQuestId) return
      if (!confirm('Delete this quest? In-progress player saves will reference a missing def.')) return
      quests = quests.filter(q => q.id !== selectedQuestId)
      selectedQuestId = quests[0]?.id ?? null
      renderList(); renderEditor()
    })
    overlay.querySelector('#qSaveAll').addEventListener('click', async () => {
      try {
        const r = await fetch('/api/editor/quests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quests }),
        })
        const body = await r.json().catch(() => ({}))
        if (r.ok && body.ok) setStatus(`Saved ${quests.length} quest(s) ✓`, '#6e6')
        else setStatus(`Save failed: ${body.error || 'unknown'}`, '#e44')
      } catch (e) { setStatus(`Network error: ${e.message}`, '#e44') }
    })

    // Load quests + objects in parallel; itemDefs already lazy-loaded by the
    // shared shop datalist helper.
    await Promise.all([
      fetch('/data/quests.json').then(r => r.json()).then(d => { quests = Array.isArray(d) ? d : [] }).catch(() => { quests = [] }),
      fetch('/data/objects.json').then(r => r.json()).then(d => { objectDefs = Array.isArray(d) ? d : [] }).catch(() => { objectDefs = [] }),
      fetchItemDefsOnce().then(() => ensureShopItemDatalist()),
    ])
    if (quests.length > 0 && !selectedQuestId) selectedQuestId = quests[0].id
    renderList(); renderEditor()

    function renderList() {
      listEl.innerHTML = ''
      if (quests.length === 0) {
        const empty = document.createElement('div')
        empty.style.cssText = 'color:#666;font-size:11px;font-style:italic;padding:8px;text-align:center;'
        empty.textContent = 'No quests. Click "+ New Quest" to start.'
        listEl.appendChild(empty)
        return
      }
      for (const q of quests) {
        const row = document.createElement('div')
        const selected = q.id === selectedQuestId
        row.style.cssText = `padding:6px 8px;margin-bottom:3px;font-size:12px;color:#fff;cursor:pointer;border-radius:3px;background:${selected ? '#1a4faf' : '#222'};`
        row.innerHTML = `<div style="font-weight:bold;">${escapeHtml(q.name || '(unnamed)')}</div><div style="font-size:10px;color:#aaa;">${q.stages?.length || 0} stage(s) · id: ${escapeHtml(q.id)}</div>`
        row.addEventListener('click', () => { selectedQuestId = q.id; renderList(); renderEditor() })
        listEl.appendChild(row)
      }
    }

    function renderEditor() {
      editorEl.innerHTML = ''
      const q = quests.find(x => x.id === selectedQuestId)
      if (!q) {
        editorEl.innerHTML = '<div style="color:#666;font-style:italic;text-align:center;padding:40px;">Select a quest from the list, or click "+ New Quest".</div>'
        return
      }

      // Top: name + id + blurb + repeatable
      editorEl.appendChild(field('Name', textInput(q.name || '', v => { q.name = v; renderList() })))
      editorEl.appendChild(field('Quest ID (do not change after players have started)', textInput(q.id, v => { const nv = v.trim() || q.id; if (nv !== q.id && quests.some(qq => qq.id === nv)) { setStatus('ID already exists', '#e44'); return } q.id = nv; selectedQuestId = nv; renderList() }, { font: 'monospace', color: '#cfc' })))
      editorEl.appendChild(field('Blurb (shown when not started, italic)', textArea(q.blurb || '', v => { q.blurb = v }, 50)))
      editorEl.appendChild(checkboxRow('Repeatable (quest can be re-acquired after completion)', !!q.repeatable, v => { q.repeatable = v }))

      // Start trigger
      const startTrigSection = sectionWrap('Start trigger', 'Fires when the player does the matching event AND the chance roll passes. Leave as "(none — manual)" to require a setQuestStage dialogue action to start the quest.')
      const startTrigContent = document.createElement('div')
      startTrigSection.appendChild(startTrigContent)
      const renderStartTrig = () => {
        startTrigContent.innerHTML = ''
        const startTypeRow = document.createElement('div')
        startTypeRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin-bottom:8px;'
        const lbl = document.createElement('label')
        lbl.textContent = 'Type:'
        lbl.style.cssText = 'font-size:11px;color:#aaa;'
        startTypeRow.appendChild(lbl)
        const sel = document.createElement('select')
        sel.style.cssText = 'background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;'
        for (const opt of [
          ['', '(none — manual)'],
          ['npcKill', 'npcKill — kill an NPC'],
          ['itemPickup', 'itemPickup — gain an item'],
          ['chestOpen', 'chestOpen — open a chest'],
        ]) {
          const o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1]; sel.appendChild(o)
        }
        sel.value = q.startTrigger?.type || ''
        sel.addEventListener('change', () => {
          if (!sel.value) { delete q.startTrigger; renderStartTrig(); return }
          q.startTrigger = makeBlankTrigger(sel.value)
          renderStartTrig()
        })
        startTypeRow.appendChild(sel)
        startTrigContent.appendChild(startTypeRow)
        if (q.startTrigger) startTrigContent.appendChild(renderTriggerFields(q.startTrigger, true))
      }
      renderStartTrig()
      editorEl.appendChild(startTrigSection)

      // Stages
      const stagesSection = sectionWrap('Stages', 'Story progression. Stage 0 is where the player starts when the quest begins. Each stage has a journal entry (description) and an optional auto-advance trigger.')
      const stagesContent = document.createElement('div')
      stagesSection.appendChild(stagesContent)
      const renderStages = () => {
        stagesContent.innerHTML = ''
        if (!q.stages) q.stages = []
        for (let i = 0; i < q.stages.length; i++) {
          stagesContent.appendChild(renderStageBlock(q, i, renderStages))
        }
        const addBtn = document.createElement('button')
        addBtn.textContent = '+ Add stage'
        addBtn.style.cssText = 'background:#2a4a6c;color:#fff;border:1px solid #555;border-radius:3px;padding:5px 12px;font-size:11px;cursor:pointer;margin-top:6px;'
        addBtn.addEventListener('click', () => {
          q.stages.push({ id: q.stages.length, description: '', trigger: { type: 'dialogue' } })
          renderStages()
        })
        stagesContent.appendChild(addBtn)
      }
      renderStages()
      editorEl.appendChild(stagesSection)

      // Rewards
      const rewardsSection = sectionWrap('Rewards', 'Granted on completeQuest action.')
      rewardsSection.appendChild(renderRewardsBlock(q))
      editorEl.appendChild(rewardsSection)
    }

    function renderStageBlock(q, idx, rerender) {
      const stage = q.stages[idx]
      stage.id = idx // keep ids in sync with array position so reorder is safe
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#1d1d1d;border:1px solid #3a3a3a;border-radius:4px;padding:8px;margin-bottom:8px;'
      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:6px;'
      const t = document.createElement('div')
      t.textContent = `Stage ${idx}`
      t.style.cssText = 'flex:1;font-size:12px;font-weight:bold;color:#ffcc44;'
      head.appendChild(t)
      const upBtn = iconBtn('▲', 'Move up', () => { if (idx === 0) return; const tmp = q.stages[idx - 1]; q.stages[idx - 1] = q.stages[idx]; q.stages[idx] = tmp; rerender() })
      const dnBtn = iconBtn('▼', 'Move down', () => { if (idx === q.stages.length - 1) return; const tmp = q.stages[idx + 1]; q.stages[idx + 1] = q.stages[idx]; q.stages[idx] = tmp; rerender() })
      const rmBtn = iconBtn('✕', 'Delete stage', () => { if (!confirm(`Delete stage ${idx}?`)) return; q.stages.splice(idx, 1); rerender() })
      rmBtn.style.background = '#6c2a2a'
      head.appendChild(upBtn); head.appendChild(dnBtn); head.appendChild(rmBtn)
      wrap.appendChild(head)
      wrap.appendChild(field('Journal entry (shown in the quest popup at this stage)', textArea(stage.description || '', v => { stage.description = v }, 70)))

      // Trigger sub-form
      const trigWrap = document.createElement('div')
      trigWrap.style.cssText = 'margin-top:6px;'
      const trigLabel = document.createElement('label')
      trigLabel.textContent = 'Auto-advance trigger:'
      trigLabel.style.cssText = 'font-size:11px;color:#aaa;display:block;margin-bottom:4px;'
      trigWrap.appendChild(trigLabel)
      const trigBody = document.createElement('div')
      trigWrap.appendChild(trigBody)
      const renderTrig = () => {
        trigBody.innerHTML = ''
        const sel = document.createElement('select')
        sel.style.cssText = 'background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;margin-bottom:6px;'
        for (const opt of [
          ['dialogue', 'dialogue — wait for dialogue action'],
          ['npcKill', 'npcKill — kill an NPC'],
          ['itemPickup', 'itemPickup — gain an item'],
          ['chestOpen', 'chestOpen — open a chest'],
        ]) {
          const o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1]; sel.appendChild(o)
        }
        sel.value = stage.trigger?.type || 'dialogue'
        sel.addEventListener('change', () => { stage.trigger = makeBlankTrigger(sel.value); renderTrig() })
        trigBody.appendChild(sel)
        if (stage.trigger && stage.trigger.type !== 'dialogue') trigBody.appendChild(renderTriggerFields(stage.trigger, false))
      }
      renderTrig()
      wrap.appendChild(trigWrap)
      return wrap
    }

    function renderTriggerFields(trigger, includeChance) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#101010;border:1px solid #2a2a2a;border-radius:3px;padding:6px 8px;display:flex;flex-direction:column;gap:6px;'
      if (trigger.type === 'npcKill') {
        wrap.appendChild(field('NPC', npcSelect(trigger.npcDefId ?? 0, v => { trigger.npcDefId = v })))
        wrap.appendChild(field('Count needed', numberInput(trigger.count ?? 1, 1, v => { if (v <= 1) delete trigger.count; else trigger.count = v })))
      } else if (trigger.type === 'itemPickup') {
        wrap.appendChild(field('Item', itemPicker(trigger.itemId ?? 0, v => { trigger.itemId = v })))
        wrap.appendChild(field('Quantity needed', numberInput(trigger.quantity ?? 1, 1, v => { if (v <= 1) delete trigger.quantity; else trigger.quantity = v })))
      } else if (trigger.type === 'chestOpen') {
        wrap.appendChild(field('Specific chest type (optional — leave blank for any chest)', chestSelect(trigger.chestDefId, v => { if (v == null) delete trigger.chestDefId; else trigger.chestDefId = v })))
        wrap.appendChild(field('Count needed', numberInput(trigger.count ?? 1, 1, v => { if (v <= 1) delete trigger.count; else trigger.count = v })))
      }
      if (includeChance && trigger.type !== 'dialogue') {
        wrap.appendChild(field('Chance (0–1, leave 1 for always)', numberInput(trigger.chance ?? 1, 0, v => { if (v >= 1 || v <= 0) delete trigger.chance; else trigger.chance = v }, { step: '0.01', max: 1 })))
      }
      return wrap
    }

    function renderRewardsBlock(q) {
      const wrap = document.createElement('div')
      if (!q.rewards) q.rewards = {}

      // XP rows
      wrap.appendChild(subhead('XP per skill'))
      const xpList = document.createElement('div')
      const renderXp = () => {
        xpList.innerHTML = ''
        const entries = Object.entries(q.rewards.xp || {})
        for (const [skill, amount] of entries) {
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;align-items:center;'
          const sel = document.createElement('select')
          sel.style.cssText = 'flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px;font-size:11px;'
          for (const s of ALL_QUEST_SKILLS) { const o = document.createElement('option'); o.value = s; o.textContent = s; sel.appendChild(o) }
          sel.value = skill
          sel.addEventListener('change', () => {
            if (!q.rewards.xp) q.rewards.xp = {}
            const amt = q.rewards.xp[skill]
            delete q.rewards.xp[skill]
            q.rewards.xp[sel.value] = amt
            renderXp()
          })
          const amt = numberInput(amount, 0, v => { if (!q.rewards.xp) q.rewards.xp = {}; q.rewards.xp[sel.value] = v }, { width: '90px' })
          const rm = iconBtn('✕', 'Remove', () => { delete q.rewards.xp[sel.value]; renderXp() })
          rm.style.background = '#6c2a2a'
          row.appendChild(sel); row.appendChild(amt); row.appendChild(rm)
          xpList.appendChild(row)
        }
        const addBtn = document.createElement('button')
        addBtn.textContent = '+ Add XP reward'
        addBtn.style.cssText = 'background:#2a4a6c;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;margin-top:4px;'
        addBtn.addEventListener('click', () => {
          if (!q.rewards.xp) q.rewards.xp = {}
          const unused = ALL_QUEST_SKILLS.find(s => !(s in q.rewards.xp)) || ALL_QUEST_SKILLS[0]
          q.rewards.xp[unused] = 100
          renderXp()
        })
        xpList.appendChild(addBtn)
      }
      renderXp()
      wrap.appendChild(xpList)

      // Item rows
      wrap.appendChild(subhead('Items'))
      const itemList = document.createElement('div')
      const renderItems = () => {
        itemList.innerHTML = ''
        if (!q.rewards.items) q.rewards.items = []
        for (let i = 0; i < q.rewards.items.length; i++) {
          const idx = i
          const drop = q.rewards.items[idx]
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:6px;margin-bottom:4px;align-items:center;'
          row.appendChild(itemPicker(drop.itemId, v => { drop.itemId = v }))
          row.appendChild(numberInput(drop.quantity, 1, v => { drop.quantity = v }, { width: '80px' }))
          const rm = iconBtn('✕', 'Remove', () => { q.rewards.items.splice(idx, 1); renderItems() })
          rm.style.background = '#6c2a2a'
          row.appendChild(rm)
          itemList.appendChild(row)
        }
        const addBtn = document.createElement('button')
        addBtn.textContent = '+ Add item reward'
        addBtn.style.cssText = 'background:#2a4a6c;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 10px;font-size:11px;cursor:pointer;margin-top:4px;'
        addBtn.addEventListener('click', () => { q.rewards.items.push({ itemId: 10, quantity: 1 }); renderItems() })
        itemList.appendChild(addBtn)
      }
      renderItems()
      wrap.appendChild(itemList)
      return wrap
    }

    // ---- field widget helpers ----

    function field(labelText, control) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'margin-bottom:10px;'
      const lbl = document.createElement('label')
      lbl.textContent = labelText
      lbl.style.cssText = 'display:block;font-size:11px;color:#aaa;margin-bottom:3px;'
      wrap.appendChild(lbl)
      wrap.appendChild(control)
      return wrap
    }
    function sectionWrap(title, hint) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#161616;border:1px solid #2a2a2a;border-radius:4px;padding:10px 12px;margin:14px 0;'
      const t = document.createElement('div')
      t.textContent = title
      t.style.cssText = 'font-size:13px;font-weight:bold;color:#fff;margin-bottom:4px;border-bottom:1px solid #333;padding-bottom:4px;'
      wrap.appendChild(t)
      if (hint) {
        const h = document.createElement('div')
        h.textContent = hint
        h.style.cssText = 'font-size:10px;color:#888;margin-bottom:8px;line-height:1.35;'
        wrap.appendChild(h)
      }
      return wrap
    }
    function subhead(text) {
      const h = document.createElement('div')
      h.textContent = text
      h.style.cssText = 'font-size:11px;color:#aaa;font-weight:bold;margin:8px 0 4px 0;'
      return h
    }
    function textInput(value, onChange, opts) {
      const input = document.createElement('input')
      input.type = 'text'
      input.value = value
      input.style.cssText = `width:100%;background:#0d0d0d;color:${opts?.color || '#fff'};border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;font-family:${opts?.font || 'inherit'};box-sizing:border-box;`
      input.addEventListener('input', () => onChange(input.value))
      return input
    }
    function textArea(value, onChange, minHeight) {
      const ta = document.createElement('textarea')
      ta.value = value
      ta.style.cssText = `width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:6px;font-size:12px;font-family:inherit;resize:vertical;min-height:${minHeight || 50}px;box-sizing:border-box;`
      ta.addEventListener('input', () => onChange(ta.value))
      return ta
    }
    function numberInput(value, min, onChange, opts) {
      const input = document.createElement('input')
      input.type = 'number'
      input.value = value
      input.min = min
      if (opts?.step) input.step = opts.step
      if (opts?.max != null) input.max = opts.max
      input.style.cssText = `width:${opts?.width || '100%'};background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;`
      input.addEventListener('change', () => { const v = parseFloat(input.value); if (!isNaN(v)) onChange(v) })
      return input
    }
    function checkboxRow(label, value, onChange) {
      const wrap = document.createElement('label')
      wrap.style.cssText = 'display:flex;align-items:center;gap:8px;margin:6px 0 10px 0;font-size:11px;color:#aaa;cursor:pointer;'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = value
      cb.addEventListener('change', () => onChange(cb.checked))
      wrap.appendChild(cb)
      wrap.appendChild(document.createTextNode(label))
      return wrap
    }
    function iconBtn(label, title, onClick) {
      const btn = document.createElement('button')
      btn.textContent = label
      btn.title = title
      btn.style.cssText = 'background:#3a3a3a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 8px;font-size:11px;cursor:pointer;flex:0 0 auto;'
      btn.addEventListener('click', onClick)
      return btn
    }
    function npcSelect(value, onChange) {
      const sel = document.createElement('select')
      sel.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      const empty = document.createElement('option'); empty.value = '0'; empty.textContent = '(pick an NPC)'; sel.appendChild(empty)
      for (const def of [...npcDefs].sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
        const o = document.createElement('option'); o.value = String(def.id); o.textContent = `${def.name} (${def.id})`; sel.appendChild(o)
      }
      sel.value = String(value)
      sel.addEventListener('change', () => onChange(parseInt(sel.value)))
      return sel
    }
    function chestSelect(value, onChange) {
      const sel = document.createElement('select')
      sel.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '(any chest type)'; sel.appendChild(empty)
      for (const def of objectDefs.filter(d => d.category === 'chest').sort((a, b) => a.name.localeCompare(b.name))) {
        const o = document.createElement('option'); o.value = String(def.id); o.textContent = `${def.name} (${def.id})`; sel.appendChild(o)
      }
      sel.value = value == null ? '' : String(value)
      sel.addEventListener('change', () => { onChange(sel.value === '' ? null : parseInt(sel.value)) })
      return sel
    }
    function itemPicker(value, onChange) {
      const input = document.createElement('input')
      input.type = 'text'
      input.setAttribute('list', 'shopItemDatalist')
      input.placeholder = 'Search item name or ID'
      input.value = formatItemDisplay(value)
      input.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      input.addEventListener('change', () => {
        const id = parseItemIdFromDisplay(input.value)
        onChange(id)
        input.value = formatItemDisplay(id)
      })
      return input
    }
    function makeBlankTrigger(type) {
      if (type === 'npcKill') return { type, npcDefId: 0 }
      if (type === 'itemPickup') return { type, itemId: 0 }
      if (type === 'chestOpen') return { type }
      return { type: 'dialogue' }
    }
    function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])) }
  }

  async function refreshServerMapList(preserveSelection) {
    const prev = preserveSelection ? serverMapSelect.value : null
    try {
      const res = await fetch(`${SERVER_API}/maps`)
      const data = await res.json()
      if (data.ok && data.maps) {
        // Sort: kcmap first, then other surface maps, then underground/dungeons last
        const primary = data.maps.filter(m => m.id === 'kcmap')
        const surface = data.maps.filter(m => m.id !== 'kcmap' && m.id !== 'underground')
        const legacy = data.maps.filter(m => m.id === 'underground')
        let html = ''
        if (primary.length) {
          html += primary.map(m => `<option value="${m.id}">${m.name || m.id} (${m.width}x${m.height})</option>`).join('')
        }
        if (surface.length) {
          html += `<optgroup label="── Other Maps ──">`
          html += surface.map(m => `<option value="${m.id}">${m.name || m.id} (${m.width}x${m.height})</option>`).join('')
          html += `</optgroup>`
        }
        if (legacy.length) {
          html += `<optgroup label="── Legacy Maps ──">`
          html += legacy.map(m => `<option value="${m.id}">${m.name || m.id} (${m.width}x${m.height})</option>`).join('')
          html += `</optgroup>`
        }
        serverMapSelect.innerHTML = html
        // Restore previous selection or default to kcmap
        if (prev && serverMapSelect.querySelector(`option[value="${prev}"]`)) {
          serverMapSelect.value = prev
        } else {
          serverMapSelect.value = 'kcmap'
        }
      }
    } catch {
      serverMapSelect.innerHTML = '<option>Server offline</option>'
    }
  }
  refreshServerMapList()

  topBar.querySelector('#newDungeonBtn').addEventListener('click', async () => {
    const name = prompt('Dungeon name (e.g. "Goblin Cave"):')
    if (!name) return
    const mapId = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
    if (!mapId) { alert('Invalid name'); return }
    const sizeStr = prompt('Size (tiles, e.g. 64):', '64')
    const size = parseInt(sizeStr) || 64
    try {
      const res = await fetch(`${SERVER_API}/new-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapId, name, width: size, height: size, dungeon: true })
      })
      const data = await res.json()
      if (!data.ok) { alert(`Failed: ${data.error}`); return }
      await refreshServerMapList(true)
      serverMapSelect.value = mapId
      statusText.textContent = `Created dungeon "${name}" (${size}x${size})`
    } catch (e) {
      alert('Server error: ' + e.message)
    }
  })

  serverLoadBtn.addEventListener('click', async () => {
    const mapId = serverMapSelect.value
    if (!mapId) return
    try {
      const res = await fetch(`${SERVER_API}/export-map?mapId=${encodeURIComponent(mapId)}`)
      const data = await res.json()
      if (!data.ok) { statusText.textContent = `Load failed: ${data.error}`; return }

      const mapData = JSON.parse(data.files['map.json'])
      const meta = JSON.parse(data.files['meta.json'])
      const spawns = JSON.parse(data.files['spawns.json'])
      const walls = data.files['walls.json'] ? JSON.parse(data.files['walls.json']) : null
      const biomes = data.files['biomes.json'] ? JSON.parse(data.files['biomes.json']) : null

      // Convert server format to editor save format
      const saveData = {
        map: mapData.map || mapData,
        placedObjects: mapData.placedObjects || [],
        layers: mapData.layers || [{ id: 'layer_0', name: 'Layer 1', visible: true }],
        activeLayerId: mapData.activeLayerId || 'layer_0',
        // Pass spawns through with full fidelity — loadNpcSpawns reads every
        // override (appearance, name, equipment, shop, dialogue) directly off
        // these objects. Mirror of the save-side fix: a prior inline mapper
        // here was projecting onto a 6-field shape and silently wiping
        // per-spawn overrides on every server-load → save round trip.
        npcSpawns: spawns.npcs ?? [],
        itemSpawns: (spawns.items || []).map((s, i) => ({ id: i + 1, itemId: s.itemId, x: s.x, z: s.z, quantity: s.quantity ?? 1 })),
        collisionData: walls,
        biomesData: biomes
      }
      await loadSaveData(saveData)
      statusText.textContent = `Loaded "${mapId}" from server`
    } catch (e) {
      statusText.textContent = `Server error: ${e.message}`
    }
  })

  serverSaveBtn.addEventListener('click', async () => {
    const mapId = serverMapSelect.value
    if (!mapId) return
    if (!confirm(`Overwrite "${mapId}" on the game server?`)) return

    // If the inspector has unsaved NPC-def edits (stats / shared shop /
    // shared dialogue), flush them first. The map save endpoint only writes
    // spawns.json + map data; without this, a single "Save Server" click
    // silently loses every def-level edit since the last explicit "Save NPC
    // defs". Per-spawn overrides go through with the map save below.
    if (npcDefsDirty) {
      statusText.textContent = 'Saving NPC defs…'
      try {
        const r = await fetch('/api/editor/npcs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ npcs: npcDefs }),
        })
        const body = await r.json().catch(() => ({}))
        if (r.ok && body.ok) {
          clearDefsDirty('NPC defs saved ✓')
        } else {
          // Abort — proceeding would land a half-save where the map was
          // written but the defs weren't, leaving the editor and live world
          // inconsistent.
          statusText.textContent = `NPC defs save failed: ${body.error || 'unknown'}`
          return
        }
      } catch (err) {
        statusText.textContent = `NPC defs save network error: ${err.message}`
        return
      }
    }

    const saveData = buildSaveData()
    const meta = {
      id: mapId,
      name: mapId.charAt(0).toUpperCase() + mapId.slice(1),
      width: map.width,
      height: map.height,
      waterLevel: map.waterLevel,
      spawnPoint: { x: Math.floor(map.width / 2) + 0.5, z: Math.floor(map.height / 2) + 0.5 },
      fogColor: map.mapType === 'dungeon' ? [0.05, 0.02, 0.1] : [0.4, 0.6, 0.9],
      fogStart: map.mapType === 'dungeon' ? 5 : 30,
      fogEnd: map.mapType === 'dungeon' ? 25 : 50,
      transitions: []
    }

    // Build spawns via the shared serializer so per-spawn overrides
    // (appearance, equipment, shop, dialogue) round-trip — the previous
    // inline mapper was silently dropping every override field besides
    // wanderRange + aggressive.
    const spawns = {
      npcs: serializeNpcSpawns(),
      objects: [],
      items: itemSpawns.map(s => ({ itemId: s.itemId, x: s.x, z: s.z, quantity: s.quantity }))
    }

    // Build KCMapFile
    const mapFile = {
      map: saveData.map,
      placedObjects: saveData.placedObjects,
      layers: saveData.layers,
      activeLayerId: saveData.activeLayerId
    }

    try {
      const res = await fetch(`${SERVER_API}/save-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapId, meta, spawns, mapData: mapFile, walls: serializeCollisionData(), biomes: serializeBiomesData() })
      })
      const data = await res.json()
      if (data.ok) {
        statusText.textContent = `Saved "${mapId}" to server`
        refreshServerMapList(true)
      } else {
        statusText.textContent = `Save failed: ${data.error}`
      }
    } catch (e) {
      statusText.textContent = `Server error: ${e.message}`
    }
  })

  // --- Biome palette UI ---
  const biomeDefListEl = sidebar.querySelector('#biomeDefList')
  const biomeAddBtn = sidebar.querySelector('#biomeAddBtn')
  const biomeEditorEl = sidebar.querySelector('#biomeEditor')
  const biomeEditName = sidebar.querySelector('#biomeEditName')
  const biomeEditColor = sidebar.querySelector('#biomeEditColor')
  const biomeEditStart = sidebar.querySelector('#biomeEditStart')
  const biomeEditStartVal = sidebar.querySelector('#biomeEditStartVal')
  const biomeEditEnd = sidebar.querySelector('#biomeEditEnd')
  const biomeEditEndVal = sidebar.querySelector('#biomeEditEndVal')
  const biomeSaveBtn = sidebar.querySelector('#biomeSaveBtn')
  const biomeDeleteBtn = sidebar.querySelector('#biomeDeleteBtn')

  function hexToRgb01(hex) {
    const h = hex.replace('#', '')
    return [parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255]
  }
  function rgb01ToHex(c) {
    const toHex = v => Math.max(0, Math.min(255, Math.round(v * 255))).toString(16).padStart(2, '0')
    return `#${toHex(c[0])}${toHex(c[1])}${toHex(c[2])}`
  }

  function refreshBiomePalette() {
    if (!biomeDefListEl) return
    biomeDefListEl.innerHTML = ''
    for (const def of biomeData.defs) {
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px;padding:5px;margin-bottom:3px;border-radius:3px;cursor:pointer;background:' + (def.id === selectedBiomeId ? 'rgba(45,108,223,0.3)' : 'rgba(255,255,255,0.04)')
      const sw = document.createElement('div')
      sw.style.cssText = `width:16px;height:16px;border-radius:2px;flex-shrink:0;background:${rgb01ToHex(def.fogColor)};border:1px solid #222;`
      const name = document.createElement('div')
      name.textContent = def.name
      name.style.cssText = 'flex:1;font-size:12px;'
      const edit = document.createElement('button')
      edit.textContent = '⋯'
      edit.title = 'Edit'
      edit.style.cssText = 'width:22px;height:22px;padding:0;font-size:11px;'
      edit.addEventListener('click', (ev) => { ev.stopPropagation(); openBiomeEditor(def.id) })
      row.addEventListener('click', () => { selectedBiomeId = def.id; refreshBiomePalette() })
      row.appendChild(sw)
      row.appendChild(name)
      row.appendChild(edit)
      biomeDefListEl.appendChild(row)
    }
  }

  function openBiomeEditor(id) {
    const def = biomeData.defs.find(d => d.id === id)
    if (!def) return
    editingBiomeId = id
    biomeEditName.value = def.name
    biomeEditColor.value = rgb01ToHex(def.fogColor)
    biomeEditStart.value = String(def.fogStart)
    biomeEditStartVal.textContent = String(def.fogStart)
    biomeEditEnd.value = String(def.fogEnd)
    biomeEditEndVal.textContent = String(def.fogEnd)
    biomeEditorEl.style.display = 'block'
  }

  biomeAddBtn?.addEventListener('click', () => {
    const def = { id: nextBiomeId++, name: `Biome ${biomeData.defs.length + 1}`, fogColor: [0.1, 0.05, 0.15], fogStart: 8, fogEnd: 25 }
    biomeData.defs.push(def)
    selectedBiomeId = def.id
    openBiomeEditor(def.id)
    refreshBiomePalette()
  })
  biomeEditStart?.addEventListener('input', () => { biomeEditStartVal.textContent = biomeEditStart.value })
  biomeEditEnd?.addEventListener('input', () => { biomeEditEndVal.textContent = biomeEditEnd.value })
  biomeSaveBtn?.addEventListener('click', () => {
    const def = biomeData.defs.find(d => d.id === editingBiomeId)
    if (!def) return
    def.name = biomeEditName.value.trim() || def.name
    def.fogColor = hexToRgb01(biomeEditColor.value)
    def.fogStart = parseFloat(biomeEditStart.value) || 0
    def.fogEnd = parseFloat(biomeEditEnd.value) || 100
    biomeOverlayDirty = true
    rebuildBiomeOverlay()
    refreshBiomePalette()
  })
  biomeDeleteBtn?.addEventListener('click', () => {
    if (editingBiomeId == null) return
    if (!confirm('Delete this biome def? Painted cells will be cleared.')) return
    const id = editingBiomeId
    biomeData.defs = biomeData.defs.filter(d => d.id !== id)
    for (const key of Object.keys(biomeData.cells)) {
      if (biomeData.cells[key] === id) delete biomeData.cells[key]
    }
    if (selectedBiomeId === id) selectedBiomeId = biomeData.defs[0]?.id ?? null
    editingBiomeId = null
    biomeEditorEl.style.display = 'none'
    biomeOverlayDirty = true
    rebuildBiomeOverlay()
    refreshBiomePalette()
  })

  serverReloadBtn.addEventListener('click', async () => {
    const mapId = serverMapSelect.value
    if (!mapId) return
    try {
      const res = await fetch(`${SERVER_API}/reload-map`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapId })
      })
      const data = await res.json()
      statusText.textContent = data.ok ? `Reloaded "${mapId}" in game` : `Reload failed: ${data.error}`
    } catch (e) {
      statusText.textContent = `Server error: ${e.message}`
    }
  })

  const importChunkInput = topBar.querySelector('#importChunkInput')
  importChunkInput.addEventListener('change', async (event) => {
    const file = event.target.files?.[0]
    if (!file) return

    const text = await file.text()
    const data = JSON.parse(text)
    importChunkInput.value = ''

    const rawX = prompt('Import at tile X offset:', '0')
    if (rawX === null) return
    const rawZ = prompt('Import at tile Z offset:', '0')
    if (rawZ === null) return

    const offsetX = parseInt(rawX, 10) || 0
    const offsetZ = parseInt(rawZ, 10) || 0

    await importChunk(data, offsetX, offsetZ)

    const prev = statusText.textContent
    statusText.textContent = `Chunk imported at (${offsetX}, ${offsetZ})`
    setTimeout(() => { statusText.textContent = prev }, 2500)
  })

  const DUNGEON_THRESHOLD = 2000

  function applyMapType() {
    const isDungeon = map.worldOffset.x >= DUNGEON_THRESHOLD
    map.mapType = isDungeon ? 'dungeon' : 'overworld'

    if (isDungeon) {
      scene.clearColor = new Color4(0, 0, 0, 1)
      scene.fogColor = new Color3(0, 0, 0)
      scene.fogStart = 18
      scene.fogEnd = 48
      sun.intensity = 0.1
      sun.diffuse = new Color3(0.42, 0.29, 0.13)
      fill.intensity = 0.05
      fill.diffuse = new Color3(0.29, 0.19, 0.06)
      ambient.diffuse = new Color3(0.48, 0.38, 0.25)
      ambient.intensity = 0.55
    } else {
      scene.clearColor = new Color4(0.4, 0.6, 0.9, 1.0)
      scene.fogColor = new Color3(0.4, 0.6, 0.9)
      scene.fogStart = 80
      scene.fogEnd = 200
      sun.intensity = 1.1
      sun.diffuse = new Color3(1.0, 0.84, 0.54)
      fill.intensity = 0.65
      fill.diffuse = new Color3(0.67, 0.73, 0.80)
      ambient.diffuse = new Color3(0.54, 0.54, 0.54)
      ambient.intensity = 0.9
    }

    GROUND_TYPES = isDungeon ? GROUND_TYPES_DUNGEON : GROUND_TYPES_OVERWORLD
    buildGroundSwatches()
  }

  const worldOffsetX = topBar.querySelector('#worldOffsetX')
  const worldOffsetZ = topBar.querySelector('#worldOffsetZ')

  worldOffsetX.addEventListener('change', () => {
    const v = Number(worldOffsetX.value)
    if (Number.isFinite(v)) { map.worldOffset.x = v; applyMapType() }
  })

  worldOffsetZ.addEventListener('change', () => {
    const v = Number(worldOffsetZ.value)
    if (Number.isFinite(v)) map.worldOffset.z = v
  })

  const CHUNK = 64
  const chunkGridBtn = topBar.querySelector('#chunkGridBtn')
  const chunkGridPopup = topBar.querySelector('#chunkGridPopup')
  const chunkGridContainer = topBar.querySelector('#chunkGridContainer')

  chunkGridBtn.addEventListener('click', () => {
    chunkGridPopup.style.display = chunkGridPopup.style.display === 'none' ? 'block' : 'none'
    if (chunkGridPopup.style.display === 'block') rebuildChunkGrid()
  })

  // Close popup when clicking outside
  document.addEventListener('mousedown', (e) => {
    if (chunkGridPopup.style.display === 'block' && !chunkGridPopup.contains(e.target) && e.target !== chunkGridBtn) {
      chunkGridPopup.style.display = 'none'
    }
  })

  function getChunkBounds() {
    // Get bounding box of active chunks
    let minCx = Infinity, minCz = Infinity, maxCx = -Infinity, maxCz = -Infinity
    for (const key of map.activeChunks) {
      const [cx, cz] = key.split(',').map(Number)
      minCx = Math.min(minCx, cx); minCz = Math.min(minCz, cz)
      maxCx = Math.max(maxCx, cx); maxCz = Math.max(maxCz, cz)
    }
    if (minCx === Infinity) { minCx = 0; minCz = 0; maxCx = 0; maxCz = 0 }
    return { minCx, minCz, maxCx, maxCz }
  }

  function rebuildChunkGrid() {
    const { minCx, minCz, maxCx, maxCz } = getChunkBounds()
    // Show 1 empty cell border around active chunks for adding new ones
    const gx0 = minCx - 1, gz0 = minCz - 1
    const gx1 = maxCx + 1, gz1 = maxCz + 1
    const cols = gx1 - gx0 + 1
    chunkGridContainer.style.gridTemplateColumns = `repeat(${cols}, 28px)`
    chunkGridContainer.innerHTML = ''
    for (let gz = gz0; gz <= gz1; gz++) {
      for (let gx = gx0; gx <= gx1; gx++) {
        const active = map.activeChunks.has(`${gx},${gz}`)
        // Only show inactive cells if they're adjacent to an active chunk
        const adjacent = !active && (
          map.activeChunks.has(`${gx-1},${gz}`) || map.activeChunks.has(`${gx+1},${gz}`) ||
          map.activeChunks.has(`${gx},${gz-1}`) || map.activeChunks.has(`${gx},${gz+1}`)
        )
        const cell = document.createElement('div')
        cell.style.cssText = `width:28px;height:28px;border-radius:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;`
        if (active) {
          cell.style.background = '#2d6cdf'
          cell.textContent = `${gx},${gz}`
          cell.title = `Chunk (${gx},${gz}) — Shift+click to remove`
        } else if (adjacent) {
          cell.style.background = '#333'
          cell.style.border = '1px dashed #666'
          cell.textContent = '+'
          cell.title = `Click to add chunk (${gx},${gz})`
        } else {
          cell.style.background = 'transparent'
          cell.style.cursor = 'default'
        }
        if (active || adjacent) {
          const cx = gx, cz = gz
          cell.addEventListener('click', (e) => {
            if (active && e.shiftKey) {
              removeChunk(cx, cz)
            } else if (!active && adjacent) {
              addChunk(cx, cz)
            }
            rebuildChunkGrid()
          })
        }
        chunkGridContainer.appendChild(cell)
      }
    }
  }

  function addChunk(cx, cz) {
    pushUndoState('terrain')
    // Expand backing array if needed
    const needRight = (cx + 1) * CHUNK
    const needBottom = (cz + 1) * CHUNK
    const needLeft = cx * CHUNK
    const needTop = cz * CHUNK
    let ox = 0, oz = 0
    let newW = map.width, newH = map.height
    if (needLeft < 0) { ox = -needLeft; newW += ox }
    if (needTop < 0) { oz = -needTop; newH += oz }
    if (needRight + ox > newW) newW = needRight + ox
    if (needBottom + oz > newH) newH = needBottom + oz

    if (newW !== map.width || newH !== map.height || ox !== 0 || oz !== 0) {
      map = map.resize(newW, newH, ox, oz)
      if (ox !== 0 || oz !== 0) {
        for (const child of placedGroup.getChildren()) {
          child.position.x += ox
          child.position.z += oz
          if (child.metadata) {
            if (child.metadata.x != null) child.metadata.x += ox
            if (child.metadata.z != null) child.metadata.z += oz
          }
        }
        for (const s of npcSpawns) { s.x += ox; s.z += oz }
        for (const s of itemSpawns) { s.x += ox; s.z += oz }
        _spatialGrid.clear()
        for (const child of placedGroup.getChildren()) _spatialRegister(child)
      }
    }
    // The chunk coord may have shifted if we expanded left/up
    const finalCx = cx + Math.floor(ox / CHUNK)
    const finalCz = cz + Math.floor(oz / CHUNK)
    map.activeChunks.add(`${finalCx},${finalCz}`)
    afterChunkChange()
  }

  function removeChunk(cx, cz) {
    if (map.activeChunks.size <= 1) return // keep at least one chunk
    pushUndoState('terrain')
    map.activeChunks.delete(`${cx},${cz}`)
    afterChunkChange()
  }

  function afterChunkChange() {
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
    selectedTexturePlanes = []
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    mapSizeLabel.textContent = `${map.width} x ${map.height}`
    rebuildTexturePlanesOnly()
    updateSelectionHelper()
    updateToolUI()
    markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
  }

  sidebar.querySelector('#toggleSplitLines').addEventListener('change', (e) => {
    state.showSplitLines = e.target.checked
    if (splitLines) splitLines.isVisible = state.showSplitLines
  })

  sidebar.querySelector('#toggleTileGrid').addEventListener('change', (e) => {
    state.showTileGrid = e.target.checked
    if (tileGrid) tileGrid.isVisible = state.showTileGrid
  })

  sidebar.querySelector('#toggleHalfPaint').addEventListener('change', (e) => {
    state.halfPaint = e.target.checked
    if (!state.halfPaint) clearHalfPaintPreview()
  })

  const panModeCheckbox = sidebar.querySelector('#togglePanMode')
  panModeCheckbox.checked = shiftPanMode
  panModeCheckbox.addEventListener('change', (e) => {
    shiftPanMode = e.target.checked
    localStorage.setItem('editor_shiftPanMode', shiftPanMode)
  })

  sidebar.querySelector('#toggleTexturePlaneV').addEventListener('change', (e) => {
    texturePlaneVertical = e.target.checked
    if (texturePlaneVertical) {
      diagFloorMode = false
      cancelDiagFloor()
      const cb = sidebar.querySelector('#toggleDiagFloor')
      if (cb) cb.checked = false
    }
    updateToolUI()
  })

  sidebar.querySelector('#toggleDiagFloor').addEventListener('change', (e) => {
    diagFloorMode = e.target.checked
    if (diagFloorMode) {
      texturePlaneVertical = false
      const cb = sidebar.querySelector('#toggleTexturePlaneV')
      if (cb) cb.checked = false
    } else {
      cancelDiagFloor()
    }
    updateToolUI()
  })

  sidebar.querySelector('#diagFloorWidthSlider').addEventListener('input', (e) => {
    diagFloorWidth = Number(e.target.value)
    sidebar.querySelector('#diagFloorWidthVal').textContent = diagFloorWidth
    sidebar.querySelector('#paintDiagFloorWidthVal').textContent = diagFloorWidth
    sidebar.querySelector('#paintDiagFloorWidthSlider').value = diagFloorWidth
  })

  topBar.querySelector('#helpBtn').addEventListener('click', () => {
    keybindsPanel.classList.toggle('visible')
  })

  keybindsPanel.querySelector('#closeKeybinds').addEventListener('click', () => {
    keybindsPanel.classList.remove('visible')
  })

  // Layers toggle removed

  const heightCullLevels = [
    { label: 'Off', value: Infinity },
    { label: '1F', value: 1.8 },
    { label: '1F+Roof', value: 3.5 },
    { label: '2F', value: 5.5 },
    { label: '2F+Roof', value: 7.5 },
    { label: '3F', value: 9.5 },
    { label: '3F+Roof', value: 11.5 },
  ]
  let heightCullIndex = 0

  function cycleHeightCull() {
    heightCullIndex = (heightCullIndex + 1) % heightCullLevels.length
    const level = heightCullLevels[heightCullIndex]
    heightCullEnabled = level.value !== Infinity
    heightCullThreshold = level.value
    const btn = sidebar.querySelector('#heightCullBtn')
    if (btn) {
      btn.textContent = `H: ${level.label}`
      btn.classList.toggle('active-tool', heightCullEnabled)
    }
    if (heightCullEnabled) applyHeightCull()
    else applyLayerVisibility()
  }

  sidebar.querySelector('#heightCullBtn')?.addEventListener('click', cycleHeightCull)

  function assignSelectedToLayer(layerId) {
    if (!selectedPlacedObjects.length && !selectedTexturePlane) return
    pushUndoState(selectedTexturePlane ? 'terrain' : 'objects')
    for (const obj of selectedPlacedObjects) obj.userData.layerId = layerId
    for (const plane of selectedTexturePlanes) plane.layerId = layerId
    applyLayerVisibility()
    updateToolUI()
  }

  sidebar.querySelector('#layerAssignSelect')?.addEventListener('change', (e) => {
    assignSelectedToLayer(e.target.value)
  })

  sidebar.querySelector('#layerAssignBtn')?.addEventListener('click', () => {
    const sel = sidebar.querySelector('#layerAssignSelect')
    if (sel) assignSelectedToLayer(sel.value)
  })

  rotateTextureBtn.addEventListener('click', () => {
    textureRotation = (textureRotation + 1) % 4
    updateToolUI()
  })

  const textureScaleVal = sidebar.querySelector('#textureScaleVal')
  textureScaleSlider.addEventListener('input', (e) => {
    textureScale = Number(e.target.value)
    if (textureScaleVal) textureScaleVal.textContent = textureScale
    if (selectedTexturePlane) {
      selectedTexturePlane.uvRepeat = textureScale
      removeTexturePlaneMesh(selectedTexturePlane)
      appendTexturePlane(selectedTexturePlane)
    }
  })

  // No-Roof checkbox
  const texNoRoofCheckbox = sidebar.querySelector('#texNoRoof')
  const texNoRoofRow = sidebar.querySelector('#texNoRoofRow')
  texNoRoofCheckbox.addEventListener('change', () => {
    if (!selectedTexturePlane) return
    for (const plane of selectedTexturePlanes) {
      if (texNoRoofCheckbox.checked) {
        plane.noRoof = true
      } else {
        delete plane.noRoof
      }
    }
  })

  // Tint color sliders
  const texTintR = sidebar.querySelector('#texTintR')
  const texTintG = sidebar.querySelector('#texTintG')
  const texTintB = sidebar.querySelector('#texTintB')
  const texTintPreview = sidebar.querySelector('#texTintPreview')

  function getTexTint() {
    return { r: texTintR.value / 100, g: texTintG.value / 100, b: texTintB.value / 100 }
  }
  function updateTintPreview() {
    const t = getTexTint()
    texTintPreview.style.background = `rgb(${Math.round(t.r*255)},${Math.round(t.g*255)},${Math.round(t.b*255)})`
  }
  function applyTintToSelected() {
    if (!selectedTexturePlane) return
    const t = getTexTint()
    selectedTexturePlane.tintColor = { r: t.r, g: t.g, b: t.b }
    removeTexturePlaneMesh(selectedTexturePlane)
    appendTexturePlane(selectedTexturePlane)
  }
  for (const slider of [texTintR, texTintG, texTintB]) {
    slider.addEventListener('input', () => { updateTintPreview(); applyTintToSelected() })
  }
  sidebar.querySelector('#texTintReset').addEventListener('click', () => {
    texTintR.value = 100; texTintG.value = 100; texTintB.value = 100
    updateTintPreview()
    applyTintToSelected()
  })

  canvas.addEventListener('mousemove', (event) => {
    const tile = pickTile(event)
    if (!tile) return

    state.hovered = tile

    const y = map.getAverageTileHeight(tile.x, tile.z) + 0.04
    highlight.position.set(tile.x + 0.5, y, tile.z + 0.5)
    hoverText.textContent = `tile (${tile.x}, ${tile.z})  elev ${y.toFixed(2)}`

    if (previewObject) {
      const sp = pickSurfacePoint(event)
      const pos = tileWorldPosition(tile.x, tile.z)
      if (sp) pos.y = sp.y
      const _prevAsset = assetRegistry.find((a) => a.id === previewObject.userData.assetId)
      if (_prevAsset?.name?.toLowerCase().includes('wall')) {
        const snap = getWallEdgeSnap(tile)
        if (snap) { pos.x = snap.x; pos.z = snap.z }
      }
      if (_prevAsset?.path?.toLowerCase().includes('tree')) {
        if (sp) { pos.x = Math.round(sp.x); pos.z = Math.round(sp.z) }
        else { pos.x = Math.round(tile.x + 0.5); pos.z = Math.round(tile.z + 0.5) }
      }
      previewObject.position.copyFrom(pos)
    }
    updateHoverEdgeHelper()
    updateHalfPaintPreview(tile, event)

    // Diagonal floor preview
    if (diagFloorMode && diagFloorStart && (state.tool === ToolMode.TEXTURE_PLANE || state.tool === ToolMode.PAINT)) {
      let cursorX = tile.x + tile.u
      let cursorZ = tile.z + tile.v
      if (!event.shiftKey) {
        cursorX = Math.floor(cursorX) + 0.5
        cursorZ = Math.floor(cursorZ) + 0.5
      }
      const dx = cursorX - diagFloorStart.x
      const dz = cursorZ - diagFloorStart.z
      const length = Math.sqrt(dx * dx + dz * dz)
      if (length > 0.1) {
        let angle = Math.atan2(dz, dx)
        if (!event.shiftKey) angle = snapAngle(angle)
        const midX = (diagFloorStart.x + cursorX) / 2
        const midZ = (diagFloorStart.z + cursorZ) / 2
        const midY = map.getAverageTileHeight(Math.floor(midX), Math.floor(midZ)) + 0.06

        disposeDiagFloorPreview()
        diagFloorPreview = MeshBuilder.CreatePlane('diagFloorPreview', {
          width: length,
          height: diagFloorWidth,
          sideOrientation: Mesh.DOUBLESIDE
        }, scene)
        diagFloorPreview.position.set(midX, midY, midZ)
        diagFloorPreview.rotation.set(-Math.PI / 2, angle, 0)
        const mat = new StandardMaterial('diagFloorPreviewMat', scene)
        mat.diffuseColor = new Color3(0.3, 0.6, 1.0)
        mat.alpha = 0.35
        mat.backFaceCulling = false
        diagFloorPreview.material = mat
        diagFloorPreview.isPickable = false
      }
    }

    const terrainPoint = transformMode === 'move' ? pickTerrainPoint(event) : null

    if (transformMode === 'move' && selectedTexturePlane && transformStart?.primaryType === 'plane') {
      // For vertical planes, fall back to a virtual horizontal plane at the plane's current Y
      // so movement isn't blocked when the cursor passes over a wall model
      const cursorPoint = terrainPoint
        ?? (selectedTexturePlane.vertical ? pickHorizontalPlane(event, selectedTexturePlane.position.y) : null)
      if (!cursorPoint) {
        updateTexturePlaneMeshTransform(selectedTexturePlane)
        updateSelectionHelper()
        return
      }

      const snappedX = event.shiftKey ? snapValue(cursorPoint.x, 0.5) : cursorPoint.x
      const snappedZ = event.shiftKey ? snapValue(cursorPoint.z, 0.5) : cursorPoint.z

      const planeHalfHeight =
        ((selectedTexturePlane.height || 1) * (selectedTexturePlane.scale?.y ?? 1)) / 2

      if (transformAxis === 'x') {
        selectedTexturePlane.position.x = snappedX
      } else if (transformAxis === 'ground-z') {
        selectedTexturePlane.position.z = snappedZ
      } else if (transformAxis === 'height') {
        if (!movePlaneStart) {
          movePlaneStart = {
            mouseY: event.clientY,
            value: selectedTexturePlane.position.y
          }
        }

        const deltaY = (movePlaneStart.mouseY - event.clientY) * 0.02
        selectedTexturePlane.position.y = movePlaneStart.value + deltaY
      } else {
        if (selectedTexturePlane.vertical) {
          const planeSnap = !event.altKey && findNearbyPlaneSnap(selectedTexturePlane, snappedX, snappedZ)
          if (planeSnap) {
            selectedTexturePlane.position.x = planeSnap.x
            selectedTexturePlane.position.z = planeSnap.z
            selectedTexturePlane.position.y = planeSnap.y + transformLift
          } else {
            selectedTexturePlane.position.x = snappedX
            selectedTexturePlane.position.z = snappedZ
            selectedTexturePlane.position.y = (transformStart?.position.y ?? (terrainPoint ? terrainPoint.y + planeHalfHeight : selectedTexturePlane.position.y)) + transformLift
          }
        } else {
          selectedTexturePlane.position.x = snappedX
          selectedTexturePlane.position.z = snappedZ
          if (terrainPoint) selectedTexturePlane.position.y = terrainPoint.y + 0.05 + transformLift
        }
      }

      updateTexturePlaneMeshTransform(selectedTexturePlane)

      // Move group members by the same delta
      const dx = selectedTexturePlane.position.x - transformStart.position.x
      const dy = selectedTexturePlane.position.y - transformStart.position.y
      const dz = selectedTexturePlane.position.z - transformStart.position.z
      if (transformStart?.groupStarts?.length) {
        for (const { plane, position } of transformStart.groupStarts) {
          plane.position.x = position.x + dx
          plane.position.y = position.y + dy
          plane.position.z = position.z + dz
          updateTexturePlaneMeshTransform(plane)
        }
      }
      // Also move cross-type GLB objects
      if (transformStart?.crossGroupStarts?.length) {
        for (const { obj, position } of transformStart.crossGroupStarts) {
          obj.position.set(position.x + dx, position.y + dy, position.z + dz)
        }
      }

      updateSelectionHelper()
      return
    }

    if (transformMode === 'move' && selectedPlacedObject && transformStart?.primaryType !== 'plane') {
      if (transformAxis === 'height') {
        // Vertical: mouse Y delta
        if (!movePlaneStart) {
          movePlaneStart = { mouseY: event.clientY, value: selectedPlacedObject.position.y }
        }
        const deltaY = (movePlaneStart.mouseY - event.clientY) * 0.02
        selectedPlacedObject.position.y = movePlaneStart.value + deltaY
      } else if (transformAxis === 'x' || transformAxis === 'ground-z') {
        // Single axis: delta-based so movement is predictable
        if (!movePlaneStart) {
          const initPick = pickHorizontalPlane(event, selectedPlacedObject.position.y)
          movePlaneStart = {
            pickX: initPick?.x ?? selectedPlacedObject.position.x,
            pickZ: initPick?.z ?? selectedPlacedObject.position.z
          }
        }
        const movePoint = pickHorizontalPlane(event, selectedPlacedObject.position.y)
        if (!movePoint) return
        const dx = movePoint.x - movePlaneStart.pickX
        const dz = movePoint.z - movePlaneStart.pickZ
        if (transformAxis === 'x') {
          selectedPlacedObject.position.x = event.shiftKey
            ? snapValue(transformStart.position.x + dx, 0.5)
            : transformStart.position.x + dx
        } else {
          selectedPlacedObject.position.z = event.shiftKey
            ? snapValue(transformStart.position.z + dz, 0.5)
            : transformStart.position.z + dz
        }
      } else {
        // Unconstrained: object follows cursor on terrain
        const movePoint = pickHorizontalPlane(event, selectedPlacedObject.position.y)
        if (!movePoint) return

        const _movingAsset = assetRegistry.find((a) => a.id === selectedPlacedObject.userData.assetId)
        const movingIsWallModular = isModularAsset(selectedPlacedObject.userData.assetId)
          && _movingAsset?.name?.toLowerCase().includes('wall')

        let newX, newZ
        if (movingIsWallModular && !event.altKey) {
          const snap = findModularEdgeSnap(selectedPlacedObject, movePoint.x, movePoint.z)
          newX = snap.x; newZ = snap.z
        } else if (event.shiftKey) {
          newX = snapValue(movePoint.x, 0.5)
          newZ = snapValue(movePoint.z, 0.5)
        } else {
          newX = movePoint.x; newZ = movePoint.z
        }

        let targetY
        if (transformLift !== 0) {
          targetY = selectedPlacedObject.position.y
        } else if (!event.altKey) {
          const sp = pickSurfacePoint(event, selectedPlacedObjects)
          targetY = sp?.y ?? terrainPoint?.y ?? selectedPlacedObject.position.y
        } else {
          targetY = terrainPoint?.y ?? selectedPlacedObject.position.y
        }
        selectedPlacedObject.position.set(newX, targetY, newZ)
      }

      // Move group members by the same delta as the primary
      const dx = selectedPlacedObject.position.x - transformStart.position.x
      const dy = selectedPlacedObject.position.y - transformStart.position.y
      const dz = selectedPlacedObject.position.z - transformStart.position.z
      if (transformStart?.groupStarts?.length) {
        for (const { obj, position } of transformStart.groupStarts) {
          obj.position.set(position.x + dx, position.y + dy, position.z + dz)
        }
      }
      // Also move cross-type texture planes
      if (transformStart?.crossPlaneStarts?.length) {
        for (const { plane, position } of transformStart.crossPlaneStarts) {
          plane.position.x = position.x + dx
          plane.position.y = position.y + dy
          plane.position.z = position.z + dz
          updateTexturePlaneMeshTransform(plane)
        }
      }

      return
    }

    if (isDragSelecting && dragSelectStart) {
      const dx = event.clientX - dragSelectStart.x
      const dy = event.clientY - dragSelectStart.y
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragSelectBox.style.display = 'block'
      }
      updateDragSelectBox(dragSelectStart.x, dragSelectStart.y, event.clientX, event.clientY)
      return
    }

if (state.isPainting && state.tool !== ToolMode.PLACE && state.tool !== ToolMode.SELECT) {
  const key = `${tile.x},${tile.z}`

  if (state.tool === ToolMode.BIOME) {
    if (!biomeStrokeStart || !biomeStrokeSnapshot) return
    const cx = Math.floor(tile.x / BIOME_CELL_SIZE)
    const cz = Math.floor(tile.z / BIOME_CELL_SIZE)
    // Reset to stroke-start state and re-fill the rectangle from start to current cell.
    // Lets the user drag out a rectangle in any direction; re-shrinks if they overshoot.
    biomeData.cells = { ...biomeStrokeSnapshot }
    const x0 = Math.min(biomeStrokeStart.cx, cx)
    const x1 = Math.max(biomeStrokeStart.cx, cx)
    const z0 = Math.min(biomeStrokeStart.cz, cz)
    const z1 = Math.max(biomeStrokeStart.cz, cz)
    for (let zz = z0; zz <= z1; zz++) {
      for (let xx = x0; xx <= x1; xx++) {
        const key = `${xx},${zz}`
        if (biomeStrokeId == null) delete biomeData.cells[key]
        else biomeData.cells[key] = biomeStrokeId
      }
    }
    biomeOverlayDirty = true
    rebuildBiomeOverlay()
    return
  }

  if (
    state.tool === ToolMode.TERRAIN ||
    state.tool === ToolMode.PAINT
  ) {
    if (state.tool === ToolMode.TERRAIN) {
      const now = performance.now()

      if (!state.draggedTiles.has(key) && now - state.lastTerrainEditTime >= state.terrainEditInterval) {
        state.draggedTiles.add(key)
        state.lastTerrainEditTime = now
        applyToolAtTile(tile, event)
      }
    } else if (state.tool === ToolMode.COLLISION) {
      if (collisionMode === 'wall') {
        const erasing = wallEraseMode || event.shiftKey
        if (erasing) {
          // Erase mode: clear all edges per tile, track by tile
          const tileKey = `${tile.x},${tile.z}`
          if (!state.draggedTiles.has(tileKey)) {
            state.draggedTiles.add(tileKey)
            setWallAt(tile.x, tile.z, 0)
            delete getCollisionLayer().wallHeights[`${tile.x},${tile.z}`]
            rebuildCollisionMeshes()
          }
        } else {
          // Draw mode: use the locked edge from mousedown so dragging extends the same edge
          const edge = lockedWallEdge || getNearestEdge(tile.x, tile.z, tile.u, tile.v).edge
          const edgeKey = `${tile.x},${tile.z},${edge}`
          if (!state.draggedTiles.has(edgeKey)) {
            state.draggedTiles.add(edgeKey)
            const current = getWallAt(tile.x, tile.z)
            setWallAt(tile.x, tile.z, current | edge)
            rebuildCollisionMeshes()
          }
        }
      } else if (collisionMode === 'block') {
        if (!state.draggedTiles.has(key)) {
          state.draggedTiles.add(key)
          setBlockedTile(tile.x, tile.z, !event.shiftKey)
          rebuildCollisionMeshes()
        }
      } else if (collisionMode === 'hole') {
        if (!state.draggedTiles.has(key)) {
          state.draggedTiles.add(key)
          setHoleAt(tile.x, tile.z, !event.shiftKey)
          rebuildCollisionMeshes()
        }
      }
    } else {
      if (!state.draggedTiles.has(key)) {
        state.draggedTiles.add(key)
        applyToolAtTile(tile, event)
      }
    }
  }
}
  })

  const dragSelectBox = document.createElement('div')
  dragSelectBox.style.cssText = 'position:fixed;border:1px solid rgba(102,204,255,0.9);background:rgba(102,204,255,0.07);pointer-events:none;display:none;z-index:9999;'
  document.body.appendChild(dragSelectBox)

  function updateDragSelectBox(x1, y1, x2, y2) {
    dragSelectBox.style.left = Math.min(x1, x2) + 'px'
    dragSelectBox.style.top = Math.min(y1, y2) + 'px'
    dragSelectBox.style.width = Math.abs(x2 - x1) + 'px'
    dragSelectBox.style.height = Math.abs(y2 - y1) + 'px'
  }

  function worldToScreen(worldPos) {
    const projected = Vector3.Project(
      worldPos,
      Matrix.Identity(),
      scene.getTransformMatrix(),
      camera.viewport.toGlobal(engine.getRenderWidth(), engine.getRenderHeight())
    )
    const rect = canvas.getBoundingClientRect()
    return {
      x: projected.x + rect.left,
      y: projected.y + rect.top
    }
  }

  canvas.addEventListener('mousedown', async (event) => {
    if (event.button !== 0) return

    // SELECT tool drag-select starts before tile check so it works anywhere on canvas
    if (state.tool === ToolMode.SELECT && !transformMode) {
      const picked = pickClosestSelectTarget(event)
      if (picked?.type === 'plane') {
        const plane = picked.object.metadata?.texturePlane
        if (plane) {
          if (event.shiftKey) {
            const idx = selectedTexturePlanes.indexOf(plane)
            if (idx >= 0) {
              selectedTexturePlanes.splice(idx, 1)
              selectedTexturePlane = selectedTexturePlanes[selectedTexturePlanes.length - 1] ?? null
            } else {
              selectedTexturePlanes.push(plane)
              selectedTexturePlane = plane
            }
          } else {
            selectedTexturePlane = plane
            selectedTexturePlanes = [plane]
            selectedPlacedObject = null
            selectedPlacedObjects = []
          }
          updateSelectionHelper()
          updateToolUI()
          return
        }
      }

      if (picked?.type === 'placed') {
        const pickedObject = picked.object
        if (event.shiftKey) {
          const idx = selectedPlacedObjects.indexOf(pickedObject)
          if (idx >= 0) {
            selectedPlacedObjects.splice(idx, 1)
            selectedPlacedObject = selectedPlacedObjects[selectedPlacedObjects.length - 1] ?? null
          } else {
            selectedPlacedObjects.push(pickedObject)
            selectedPlacedObject = pickedObject
          }
        } else {
          selectedPlacedObjects = [pickedObject]
          selectedPlacedObject = pickedObject
          selectedTexturePlane = null
          selectedTexturePlanes = []
        }
        updateSelectionHelper()
        updateToolUI()
        return
      }

      // No object hit — deselect immediately; show drag box only if mouse moves
      if (!event.shiftKey) clearSelection()
      isDragSelecting = true
      dragSelectStart = { x: event.clientX, y: event.clientY }
      return
    }

    const tile = pickTile(event)
    if (!tile) return

    if (transformMode) {
      confirmTransform()
      updateSelectionHelper()
      return
    }

    if (state.tool === ToolMode.TEXTURE_PLANE) {
      if (!selectedTextureId || typeof map.addTexturePlane !== 'function') return

      // Diagonal floor mode: two-click placement
      if (diagFloorMode) {
        let worldX = tile.x + tile.u
        let worldZ = tile.z + tile.v
        if (!event.shiftKey) {
          worldX = Math.floor(worldX) + 0.5
          worldZ = Math.floor(worldZ) + 0.5
        }
        if (!diagFloorStart) {
          diagFloorStart = { x: worldX, z: worldZ }
          statusText.textContent = 'Diagonal floor start — click end point (Esc to cancel)'
          updateToolUI()
          return
        }
        // Second click: place the rotated floor plane
        const dx = worldX - diagFloorStart.x
        const dz = worldZ - diagFloorStart.z
        const length = Math.sqrt(dx * dx + dz * dz)
        if (length < 0.1) { cancelDiagFloor(); updateToolUI(); return }

        let angle = Math.atan2(dz, dx)
        if (!event.shiftKey) angle = snapAngle(angle)

        const midX = (diagFloorStart.x + worldX) / 2
        const midZ = (diagFloorStart.z + worldZ) / 2
        const midY = map.getAverageTileHeight(Math.floor(midX), Math.floor(midZ)) + 0.05

        pushUndoState('terrain')

        const plane = map.addTexturePlane(
          selectedTextureId,
          midX, midY, midZ,
          length,
          diagFloorWidth,
          false
        )
        plane.rotation = { x: -Math.PI / 2, y: angle, z: 0 }
        plane.uvRepeat = textureScale
        plane.texRotation = textureRotation
        selectedTexturePlane = plane
        selectedTexturePlanes = [plane]
        selectedPlacedObject = null
        appendTexturePlane(plane)
        cancelDiagFloor()
        updateToolUI()
        return
      }

      const planeSize = getTexturePlaneSize(selectedTextureId)
      const y = map.getAverageTileHeight(tile.x, tile.z) + (texturePlaneVertical ? planeSize.height / 2 : 0.05)

      pushUndoState('terrain')

      const plane = map.addTexturePlane(
        selectedTextureId,
        tile.x + 0.5,
        y,
        tile.z + 0.5,
        planeSize.width,
        planeSize.height,
        texturePlaneVertical
      )

      plane.uvRepeat = textureScale
      plane.texRotation = textureRotation
      selectedTexturePlane = plane
      selectedTexturePlanes = [plane]
      selectedPlacedObject = null
      appendTexturePlane(plane)
      updateToolUI()
      return
    }


    if (state.tool === ToolMode.PLACE) {
      await placeSelectedAsset(tile, event)
      return
    }

    if (state.tool === ToolMode.NPC_SPAWN) {
      // Shift+click = remove spawn at cursor
      if (event.shiftKey) {
        const picked = pickNpcSpawn(event)
        if (picked) {
          pushUndoState('spawns')
          removeNpcSpawn(picked)
          rebuildNpcSpawnMeshes()
          refreshNpcSpawnList()
          updateToolUI()
        }
        return
      }
      // Normal click: check if clicking existing spawn first
      const picked = pickNpcSpawn(event)
      if (picked) {
        selectedNpcSpawn = picked
        const sel = sidebar.querySelector('#npcTypeSelect')
        if (sel) sel.value = picked.npcId
        if (typeof renderNpcInspector === 'function') renderNpcInspector()
        rebuildNpcSpawnMeshes()
        refreshNpcSpawnList()
        updateToolUI()
        return
      }
      // Place new spawn — pull wander/aggressive from the Spawn tab if it's
      // currently rendered, otherwise fall through to the def defaults.
      const npcId = parseInt(sidebar.querySelector('#npcTypeSelect')?.value)
      if (!npcId) return
      const defForPlace = npcDefs.find(d => d.id === npcId)
      const wanderSlider = sidebar.querySelector('#wanderRangeSlider')
      const aggCb = sidebar.querySelector('#aggressiveCheckbox')
      const wanderRange = wanderSlider ? (parseInt(wanderSlider.value) || (defForPlace?.wanderRange ?? 3)) : (defForPlace?.wanderRange ?? 3)
      // Only treat the aggressive box as an override when the Spawn tab is
      // visible AND the user has set it; otherwise leave it null so the spawn
      // inherits the def's flag.
      const aggressive = aggCb ? aggCb.checked : null
      pushUndoState('spawns')
      const spawn = addNpcSpawn({ npcId, x: tile.x + 0.5, z: tile.z + 0.5, wanderRange, aggressive })
      selectedNpcSpawn = spawn
      if (typeof renderNpcInspector === 'function') renderNpcInspector()
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
      updateToolUI()
      return
    }

    if (state.tool === ToolMode.ITEM_SPAWN) {
      if (event.shiftKey) {
        const picked = pickItemSpawn(event)
        if (picked) {
          pushUndoState('spawns')
          removeItemSpawn(picked)
          rebuildItemSpawnMeshes()
          refreshItemSpawnList()
        }
        return
      }
      const itemId = parseInt(sidebar.querySelector('#itemTypeSelect')?.value)
      if (!itemId) return
      pushUndoState('spawns')
      addItemSpawn(itemId, tile.x + 0.5, tile.z + 0.5)
      rebuildItemSpawnMeshes()
      refreshItemSpawnList()
      return
    }

    if (state.tool === ToolMode.BIOME) {
      const cx = Math.floor(tile.x / BIOME_CELL_SIZE)
      const cz = Math.floor(tile.z / BIOME_CELL_SIZE)
      const id = event.shiftKey ? null : selectedBiomeId
      if (id == null && !event.shiftKey) {
        console.warn('[biome] no biome selected — click a biome in the right panel first')
        return
      }
      // Begin a stroke: snapshot for undo + drag-rectangle base state
      pushUndoState('biome')
      biomeStrokeStart = { cx, cz }
      biomeStrokeSnapshot = { ...biomeData.cells }
      biomeStrokeId = id
      paintBiomeCell(cx, cz, id)
      if (biomeOverlayDirty) rebuildBiomeOverlay()
      state.isPainting = true
      return
    }

    if (state.tool === ToolMode.COLLISION) {
      if (!state.historyCapturedThisStroke) { pushUndoState('collision'); state.historyCapturedThisStroke = true }
      if (collisionMode === 'wall') {
        const erasing = wallEraseMode || event.shiftKey
        if (erasing) {
          // Erase: clear ALL edges on this tile
          setWallAt(tile.x, tile.z, 0)
          delete getCollisionLayer().wallHeights[`${tile.x},${tile.z}`]
          lockedWallEdge = 0
          wallLineStart = null
        } else if (event.ctrlKey || event.metaKey) {
          // Ctrl+click: line draw mode
          const { edge } = getNearestEdge(tile.x, tile.z, tile.u, tile.v)
          if (!wallLineStart) {
            // First click: set start point and edge direction
            wallLineStart = { x: tile.x, z: tile.z, edge }
            setWallAt(tile.x, tile.z, getWallAt(tile.x, tile.z) | edge)
            statusText.textContent = `Wall line start: (${tile.x},${tile.z}) — Ctrl+click end point`
          } else {
            // Second click: draw line from start to here with locked edge
            const e = wallLineStart.edge
            const dx = tile.x - wallLineStart.x
            const dz = tile.z - wallLineStart.z
            const steps = Math.max(Math.abs(dx), Math.abs(dz))
            for (let i = 0; i <= steps; i++) {
              const t = steps === 0 ? 0 : i / steps
              const tx = Math.round(wallLineStart.x + dx * t)
              const tz = Math.round(wallLineStart.z + dz * t)
              setWallAt(tx, tz, getWallAt(tx, tz) | e)
            }
            statusText.textContent = `Wall line: ${steps + 1} edges placed`
            wallLineStart = null
          }
        } else {
          const { edge } = getNearestEdge(tile.x, tile.z, tile.u, tile.v)
          lockedWallEdge = edge  // lock this edge direction for the drag
          wallLineStart = null
          toggleWallEdge(tile.x, tile.z, edge)
          // Set wall height if non-default
          const wallH = parseFloat(sidebar.querySelector('#wallHeightSlider')?.value) || 1.8
          if (wallH !== 1.8 && getWallAt(tile.x, tile.z) > 0) {
            getCollisionLayer().wallHeights[`${tile.x},${tile.z}`] = wallH
          }
        }
      } else if (collisionMode === 'block') {
        if (event.shiftKey) {
          setBlockedTile(tile.x, tile.z, false)
          blockLineStart = null
        } else if (event.ctrlKey || event.metaKey) {
          if (!blockLineStart) {
            blockLineStart = { x: tile.x, z: tile.z }
            setBlockedTile(tile.x, tile.z, true)
            statusText.textContent = `Block line start: (${tile.x},${tile.z}) — Ctrl+click end point`
          } else {
            const dx = tile.x - blockLineStart.x
            const dz = tile.z - blockLineStart.z
            const steps = Math.max(Math.abs(dx), Math.abs(dz))
            for (let i = 0; i <= steps; i++) {
              const t = steps === 0 ? 0 : i / steps
              const tx = Math.round(blockLineStart.x + dx * t)
              const tz = Math.round(blockLineStart.z + dz * t)
              setBlockedTile(tx, tz, true)
            }
            statusText.textContent = `Block line: ${steps + 1} tiles blocked`
            blockLineStart = null
          }
        } else {
          const current = getWallAt(tile.x, tile.z)
          setBlockedTile(tile.x, tile.z, current !== 15)
          blockLineStart = null
        }
      } else if (collisionMode === 'floor') {
        if (event.shiftKey) {
          setFloorAt(tile.x, tile.z, null)
        } else {
          const h = parseFloat(sidebar.querySelector('#floorHeightInput')?.value) || 3.0
          setFloorAt(tile.x, tile.z, h)
        }
      } else if (collisionMode === 'stair') {
        if (event.shiftKey) {
          setStairAt(tile.x, tile.z, null)
        } else {
          setStairAt(tile.x, tile.z, {
            direction: stairDirection,
            baseHeight: parseFloat(sidebar.querySelector('#stairBaseH')?.value) || 0,
            topHeight: parseFloat(sidebar.querySelector('#stairTopH')?.value) || 3.5
          })
        }
      } else if (collisionMode === 'hole') {
        if (event.shiftKey) {
          setHoleAt(tile.x, tile.z, false)
        } else {
          const layer = getCollisionLayer()
          const key = `${tile.x},${tile.z}`
          const current = layer.holes && layer.holes[key]
          setHoleAt(tile.x, tile.z, !current)
        }
      }
      rebuildCollisionMeshes()
      state.isPainting = true
      state.draggedTiles.clear()
      state.draggedTiles.add(`${tile.x},${tile.z}`)
      return
    }

    // Diagonal floor mode intercept for PAINT tool
    if (diagFloorMode && state.tool === ToolMode.PAINT && paintTabTextureId && paintTabTextureId !== '__erase__') {
      let worldX = tile.x + tile.u
      let worldZ = tile.z + tile.v
      if (!event.shiftKey) {
        worldX = Math.floor(worldX) + 0.5
        worldZ = Math.floor(worldZ) + 0.5
      }
      if (!diagFloorStart) {
        diagFloorStart = { x: worldX, z: worldZ }
        statusText.textContent = 'Diagonal floor start — click end point (Esc to cancel)'
        updateToolUI()
        return
      }
      const dx = worldX - diagFloorStart.x
      const dz = worldZ - diagFloorStart.z
      const length = Math.sqrt(dx * dx + dz * dz)
      if (length < 0.1) { cancelDiagFloor(); updateToolUI(); return }

      let angle = Math.atan2(dz, dx)
      if (!event.shiftKey) angle = snapAngle(angle)

      const midX = (diagFloorStart.x + worldX) / 2
      const midZ = (diagFloorStart.z + worldZ) / 2
      const midY = map.getAverageTileHeight(Math.floor(midX), Math.floor(midZ)) + 0.05

      pushUndoState('terrain')

      const plane = map.addTexturePlane(
        paintTabTextureId,
        midX, midY, midZ,
        length,
        diagFloorWidth,
        false
      )
      plane.rotation = { x: -Math.PI / 2, y: angle, z: 0 }
      plane.uvRepeat = textureScale
      plane.texRotation = textureRotation
      selectedTexturePlane = plane
      selectedTexturePlanes = [plane]
      selectedPlacedObject = null
      appendTexturePlane(plane)
      cancelDiagFloor()
      updateToolUI()
      return
    }

    state.isPainting = true
    state.historyCapturedThisStroke = false
    state.draggedTiles.clear()
    state.lastTerrainEditTime = 0



    const key = `${tile.x},${tile.z}`
    state.draggedTiles.add(key)
    applyToolAtTile(tile, event)
  })

  window.addEventListener('mouseup', (event) => {
    if (event.button === 0) {
      const wasPainting = state.isPainting
      const paintingTool = state.tool === ToolMode.TERRAIN || state.tool === ToolMode.PAINT
      state.isPainting = false
      state.draggedTiles.clear()
      state.historyCapturedThisStroke = false
      lockedWallEdge = 0
      // Clear biome drag-rectangle state at end of stroke
      biomeStrokeStart = null
      biomeStrokeSnapshot = null
      biomeStrokeId = null

      if (wasPainting && paintingTool) {
        // Shadow cache is stale after terrain edits, but a full rebuild is expensive.
        // Just invalidate the cache so the NEXT rebuild (e.g. from undo) picks it up.
        invalidateShadowCache()
        // Rebuild texture overlays so they align with new terrain heights
        if (state.tool === ToolMode.TERRAIN) {
          markTerrainDirty({ rebuildTextureOverlays: true })
        }
      }

      if (isDragSelecting && dragSelectStart) {
        isDragSelecting = false
        dragSelectBox.style.display = 'none'

        const dx = event.clientX - dragSelectStart.x
        const dy = event.clientY - dragSelectStart.y

        if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
          const left = Math.min(dragSelectStart.x, event.clientX)
          const right = Math.max(dragSelectStart.x, event.clientX)
          const top = Math.min(dragSelectStart.y, event.clientY)
          const bottom = Math.max(dragSelectStart.y, event.clientY)

          if (!event.shiftKey) {
            selectedPlacedObjects = []
            selectedPlacedObject = null
            selectedTexturePlanes = []
            selectedTexturePlane = null
          }

          for (const obj of placedGroup.getChildren()) {
            const s = worldToScreen(obj.position)
            if (s.x >= left && s.x <= right && s.y >= top && s.y <= bottom) {
              if (!selectedPlacedObjects.includes(obj)) selectedPlacedObjects.push(obj)
            }
          }

          // Also select texture planes within the drag box
          if (texturePlaneGroup) {
            for (const mesh of texturePlaneGroup.getChildMeshes()) {
              const plane = mesh.metadata?.texturePlane
              if (!plane) continue
              const s = worldToScreen(new Vector3(plane.position.x, plane.position.y, plane.position.z))
              if (s.x >= left && s.x <= right && s.y >= top && s.y <= bottom) {
                if (!selectedTexturePlanes.includes(plane)) selectedTexturePlanes.push(plane)
              }
            }
          }

          selectedPlacedObject = selectedPlacedObjects[selectedPlacedObjects.length - 1] ?? null
          selectedTexturePlane = selectedTexturePlanes[selectedTexturePlanes.length - 1] ?? null
          updateSelectionHelper()
          updateToolUI()
        }

        dragSelectStart = null
      }
    }
  })

  let isRightDragging = false
  let isMiddleDragging = false
  let isMiddlePanning = false

  let yaw = 0.78
  let pitch = 1.02
  let distance = 31
  const target = new Vector3(12, 2, 12)
  let heightCullEnabled = false
  let heightCullThreshold = 3.5 // default: hides 2nd floor and above

  function applyHeightCull() {
    const cullY = heightCullEnabled ? heightCullThreshold : Infinity
    for (const obj of placedGroup.getChildren()) {
      const layer = layers.find((l) => l.id === (obj.userData.layerId || 'layer_0'))
      const layerVisible = layer ? layer.visible : true
      obj.setEnabled(layerVisible && obj.position.y <= cullY)
    }
    if (texturePlaneGroup) {
      for (const mesh of texturePlaneGroup.getChildMeshes()) {
        const plane = mesh.metadata?.texturePlane
        if (!plane) continue
        const layer = layers.find((l) => l.id === (plane.layerId || 'layer_0'))
        const layerVisible = layer ? layer.visible : true
        mesh.isVisible = layerVisible && plane.position.y <= cullY
      }
    }
    // Also cull texture overlays by height
    if (textureOverlayGroup) {
      for (const mesh of textureOverlayGroup.getChildMeshes()) {
        mesh.isVisible = mesh.position.y <= cullY
      }
    }
  }

  function updateCamera() {
    // Three.js convention: yaw=0 faces +X, pitch=PI/4 is 45deg down
    // Babylon ArcRotateCamera (RHS): alpha=horizontal angle, beta=vertical (0=top, PI/2=horizon)
    // The original Three.js computed position as:
    //   x = cos(yaw)*sin(pitch)*dist, y = cos(pitch)*dist, z = sin(yaw)*sin(pitch)*dist
    // Babylon alpha rotates around Y axis, beta tilts from pole
    camera.alpha = yaw + Math.PI / 2
    camera.beta = pitch
    camera.radius = distance
    camera.target.copyFrom(target)
    updateCompass()
    if (heightCullEnabled) applyHeightCull()
  }

  function panCamera(deltaX, deltaY) {
    // Camera is at alpha = yaw + PI/2, so forward in XZ = (sin(yaw), 0, -cos(yaw))
    // and right in XZ = (cos(yaw), 0, sin(yaw))
    const fx = Math.sin(yaw), fz = -Math.cos(yaw)
    const rx = Math.cos(yaw), rz = Math.sin(yaw)

    const panScale = distance * 0.0025
    target.x += -deltaX * panScale * rx + deltaY * panScale * fx
    target.z += -deltaX * panScale * rz + deltaY * panScale * fz
    updateCamera()
  }

  updateCamera()

  canvas.addEventListener('contextmenu', (e) => e.preventDefault())

  canvas.addEventListener('mouseleave', () => {
    clearHalfPaintPreview()
  })

  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) isRightDragging = true
    if (e.button === 1) {
      const wantPan = shiftPanMode ? e.shiftKey : !e.shiftKey
      if (wantPan) isMiddlePanning = true
      else isMiddleDragging = true
    }
  })

  window.addEventListener('mouseup', (e) => {
    if (e.button === 2) isRightDragging = false
    if (e.button === 1) {
      isMiddleDragging = false
      isMiddlePanning = false
    }
  })

  window.addEventListener('mousemove', (e) => {
    if (isRightDragging || isMiddleDragging) {
      yaw -= e.movementX * 0.005
      pitch -= e.movementY * 0.005
      pitch = Math.max(0.45, Math.min(Math.PI / 2 - 0.08, pitch))
      updateCamera()
    }

    if (isMiddlePanning) {
      panCamera(e.movementX, e.movementY)
    }
  })

  canvas.addEventListener('wheel', (e) => {
    if (transformMode === 'rotate') {
      e.preventDefault()

      // X key → X rotation, Y key → Y rotation, Z key → Z rotation, default → Y
      const threeAxis = transformAxis === 'x' ? 'x'
        : transformAxis === 'ground-z' ? 'y'
        : transformAxis === 'height' ? 'z'
        : 'y'

      const totalSelected = selectedPlacedObjects.length + selectedTexturePlanes.length
      const hasBothTypes = selectedPlacedObjects.length > 0 && selectedTexturePlanes.length > 0

      // Single texture plane only — rotate in place with Euler
      if (selectedTexturePlane && !hasBothTypes && selectedTexturePlanes.length === 1) {
        if (e.shiftKey) {
          selectedTexturePlane.rotation[threeAxis] += (e.deltaY > 0 ? 1 : -1) * (Math.PI / 180) // 1° steps
        } else {
          const step = Math.PI / 12 // 15° steps
          selectedTexturePlane.rotation[threeAxis] += e.deltaY > 0 ? step : -step
          selectedTexturePlane.rotation[threeAxis] = snapAngleToQuarterIfClose(selectedTexturePlane.rotation[threeAxis], 0.08)
        }

        updateTexturePlaneMeshTransform(selectedTexturePlane)
        updateSelectionHelper()
        return
      }

      // Multi-select or mixed selection: orbit all around group center
      if (totalSelected > 1 || selectedPlacedObject) {
        const delta = (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? Math.PI / 180 : Math.PI / 12)
        const worldAxis = threeAxis === 'x' ? new Vector3(1, 0, 0)
          : threeAxis === 'y' ? new Vector3(0, 1, 0)
          : new Vector3(0, 0, 1)
        const q = Quaternion.RotationAxis(worldAxis, delta)

        if (totalSelected > 1) {
          // Compute combined center across both types
          let cx = 0, cy = 0, cz = 0
          for (const obj of selectedPlacedObjects) {
            cx += obj.position.x; cy += obj.position.y; cz += obj.position.z
          }
          for (const p of selectedTexturePlanes) {
            cx += p.position.x; cy += p.position.y; cz += p.position.z
          }
          cx /= totalSelected; cy /= totalSelected; cz /= totalSelected

          const m = new Matrix()
          q.toRotationMatrix(m)

          // Orbit + rotate GLB objects
          for (const obj of selectedPlacedObjects) {
            const rel = new Vector3(obj.position.x - cx, obj.position.y - cy, obj.position.z - cz)
            const rotated = Vector3.TransformCoordinates(rel, m)
            obj.position.x = cx + rotated.x
            obj.position.y = cy + rotated.y
            obj.position.z = cz + rotated.z
            if (!obj.rotationQuaternion) obj.rotationQuaternion = Quaternion.FromEulerAngles(obj.rotation.x, obj.rotation.y, obj.rotation.z)
            obj.rotationQuaternion = q.multiply(obj.rotationQuaternion)
          }

          // Orbit + rotate texture planes
          for (const p of selectedTexturePlanes) {
            const rel = new Vector3(p.position.x - cx, p.position.y - cy, p.position.z - cz)
            const rotated = Vector3.TransformCoordinates(rel, m)
            p.position.x = cx + rotated.x
            p.position.y = cy + rotated.y
            p.position.z = cz + rotated.z
            p.rotation[threeAxis] += delta
            updateTexturePlaneMeshTransform(p)
          }
        } else {
          // Single GLB object: rotate in place
          if (!selectedPlacedObject.rotationQuaternion) selectedPlacedObject.rotationQuaternion = Quaternion.FromEulerAngles(selectedPlacedObject.rotation.x, selectedPlacedObject.rotation.y, selectedPlacedObject.rotation.z)
          selectedPlacedObject.rotationQuaternion = q.multiply(selectedPlacedObject.rotationQuaternion)
        }

        updateSelectionHelper()
        return
      }

      // Single texture plane with multiple selected (no GLBs)
      if (selectedTexturePlanes.length > 1) {
        const delta = (e.deltaY > 0 ? 1 : -1) * (e.shiftKey ? Math.PI / 180 : Math.PI / 12)

        let cx = 0, cy = 0, cz = 0
        for (const p of selectedTexturePlanes) {
          cx += p.position.x; cy += p.position.y; cz += p.position.z
        }
        cx /= selectedTexturePlanes.length; cy /= selectedTexturePlanes.length; cz /= selectedTexturePlanes.length

        const worldAxis = threeAxis === 'x' ? new Vector3(1, 0, 0)
          : threeAxis === 'y' ? new Vector3(0, 1, 0)
          : new Vector3(0, 0, 1)
        const q = Quaternion.RotationAxis(worldAxis, delta)
        const m = new Matrix()
        q.toRotationMatrix(m)

        for (const p of selectedTexturePlanes) {
          const rel = new Vector3(p.position.x - cx, p.position.y - cy, p.position.z - cz)
          const rotated = Vector3.TransformCoordinates(rel, m)
          p.position.x = cx + rotated.x
          p.position.y = cy + rotated.y
          p.position.z = cz + rotated.z
          p.rotation[threeAxis] += delta
          updateTexturePlaneMeshTransform(p)
        }

        updateSelectionHelper()
        return
      }
    }

    if (transformMode === 'scale') {
      e.preventDefault()

      const step = e.shiftKey ? 0.05 : 0.15
      const delta = e.deltaY > 0 ? -step : step

      if (selectedTexturePlane) {
        if (transformAxis === 'all') {
          selectedTexturePlane.width  = Math.max(0.1, selectedTexturePlane.width  + delta)
          selectedTexturePlane.height = Math.max(0.1, selectedTexturePlane.height + delta)
        } else if (transformAxis === 'x') {
          selectedTexturePlane.width  = Math.max(0.1, selectedTexturePlane.width  + delta)
        } else if (transformAxis === 'height') {   // Z key = vertical = plane height
          selectedTexturePlane.height = Math.max(0.1, selectedTexturePlane.height + delta)
        } else if (transformAxis === 'ground-z') { // Y key = depth scale
          selectedTexturePlane.scale.z = Math.max(0.1, selectedTexturePlane.scale.z + delta)
        }

        removeTexturePlaneMesh(selectedTexturePlane)
        appendTexturePlane(selectedTexturePlane)
        return
      }

      if (selectedPlacedObject) {
        // Translate unified axis → Three.js scale axis
        const scaleAxis = transformAxis === 'height' ? 'y' : transformAxis === 'ground-z' ? 'z' : transformAxis
        if (transformAxis === 'all') {
          const nextX = Math.max(0.1, selectedPlacedObject.scale.x + delta)
          const nextY = Math.max(0.1, selectedPlacedObject.scale.y + delta)
          const nextZ = Math.max(0.1, selectedPlacedObject.scale.z + delta)
          selectedPlacedObject.scale.set(nextX, nextY, nextZ)
        } else {
          selectedPlacedObject.scale[scaleAxis] = Math.max(
            0.1,
            selectedPlacedObject.scale[scaleAxis] + delta
          )
        }

        updateSelectionHelper()
        return
      }
    }

    // Quick-rotate selected texture plane without entering transform mode
    // Scroll = tilt up/down, Ctrl+Scroll = spin, Shift = fine
    if (selectedTexturePlane && !transformMode && (state.tool === ToolMode.SELECT || state.tool === ToolMode.TEXTURE_PLANE)) {
      e.preventDefault()
      const fine = e.shiftKey
      const step = fine ? 0.05 : Math.PI / 12
      const delta = e.deltaY > 0 ? step : -step
      const axis = e.ctrlKey ? 'y' : 'x'  // ctrl = spin, default = tilt up/down
      selectedTexturePlane.rotation[axis] += delta
      if (!fine) selectedTexturePlane.rotation[axis] = snapAngleToQuarterIfClose(selectedTexturePlane.rotation[axis], 0.08)
      updateTexturePlaneMeshTransform(selectedTexturePlane)
      updateSelectionHelper()
      syncPlaneRotationUI()
      return
    }

    distance += e.deltaY * 0.01
    distance = Math.max(2, Math.min(120, distance))
    updateCamera()
  })

  window.addEventListener('resize', () => {
    engine.resize()
  })

  window.addEventListener('keydown', async (event) => {
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const key = event.key.toLowerCase()
    const { x, z } = state.hovered

    if (event.ctrlKey && key === 'z' && !event.shiftKey) {
      event.preventDefault()
      await undo()
      return
    }

    if ((event.ctrlKey && key === 'y') || (event.ctrlKey && event.shiftKey && key === 'z')) {
      event.preventDefault()
      await redo()
      return
    }

    if (key === 'delete' || key === 'backspace') {
      if (selectedNpcSpawn && state.tool === ToolMode.NPC_SPAWN) {
        pushUndoState('spawns')
        removeNpcSpawn(selectedNpcSpawn)
        if (typeof renderNpcInspector === 'function') renderNpcInspector()
        rebuildNpcSpawnMeshes()
        refreshNpcSpawnList()
        updateToolUI()
        return
      }
      if (selectedTexturePlane) {
        pushUndoState('terrain')
        removeTexturePlaneMesh(selectedTexturePlane)
        map.texturePlanes = map.texturePlanes.filter((p) => p.id !== selectedTexturePlane.id)
        selectedTexturePlane = null
        selectedTexturePlanes = []
        updateSelectionHelper()
        updateToolUI()
        return
      }

      if (selectedPlacedObjects.length > 0) {
        pushUndoState('objects')
        for (const obj of selectedPlacedObjects) removePlacedModel(obj)
        selectedPlacedObject = null
        selectedPlacedObjects = []
        invalidateShadowCache()
        updateSelectionHelper()
        updateToolUI()
        return
      }
    }

    if (key === 'escape') {
      if (diagFloorStart) {
        cancelDiagFloor()
        updateToolUI()
        return
      }
      cancelTransform()
      return
    }

    if (key === 'l') {
      state.levelMode = !state.levelMode
      state.levelHeight = null
      updateToolUI()
      return
    }

    if (key === 'h') {
      cycleHeightCull()
      return
    }

    if (transformMode === 'move') {
      if (key === 'q' || key === 'e') {
        const delta = key === 'q' ? 0.1 : -0.1
        transformLift += delta
        if (selectedTexturePlane) {
          selectedTexturePlane.position.y += delta
          updateTexturePlaneMeshTransform(selectedTexturePlane)
          if (transformStart?.groupStarts?.length) {
            for (const { plane } of transformStart.groupStarts) {
              plane.position.y += delta
              updateTexturePlaneMeshTransform(plane)
            }
          }
          updateSelectionHelper()
        }
        if (selectedPlacedObject) {
          selectedPlacedObject.position.y += delta
          if (transformStart?.groupStarts?.length) {
            for (const { obj } of transformStart.groupStarts) obj.position.y += delta
          }
        }
        return
      }
    }

if (key === 'q') {
  if (!event.repeat) pushUndoState('terrain')
  if (brushRadius < 0.6) {
    map.adjustVertexHeight(x,     z,     0.18)
    map.adjustVertexHeight(x + 1, z,     0.18)
    map.adjustVertexHeight(x,     z + 1, 0.18)
    map.adjustVertexHeight(x + 1, z + 1, 0.18)
  } else {
    applyGaussianBrush(x + 0.5, z + 0.5, 0.18)
  }
  const _qr = Math.ceil(brushRadius)
  markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: x - _qr, z1: z - _qr, x2: x + _qr, z2: z + _qr } })
  return
}

if (key === 'e') {
  if (!event.repeat) pushUndoState('terrain')
  if (brushRadius < 0.6) {
    map.adjustVertexHeight(x,     z,     -0.18)
    map.adjustVertexHeight(x + 1, z,     -0.18)
    map.adjustVertexHeight(x,     z + 1, -0.18)
    map.adjustVertexHeight(x + 1, z + 1, -0.18)
  } else {
    applyGaussianBrush(x + 0.5, z + 0.5, -0.18)
  }
  const _er = Math.ceil(brushRadius)
  markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: x - _er, z1: z - _er, x2: x + _er, z2: z + _er } })
  return
}

    if (key === '[' || key === ']') {
      const delta = key === ']' ? 1 : -1
      if (state.tool === ToolMode.PAINT) {
        paintBrushRadius = Math.max(1, Math.min(16, paintBrushRadius + delta))
        paintBrushSizeSlider.value = paintBrushRadius
        paintBrushSizeLabel.textContent = paintBrushRadius
      } else if (state.tool === ToolMode.TERRAIN) {
        brushRadius = Math.max(0.4, Math.min(16, brushRadius + delta * 0.4))
        brushSizeSlider.value = brushRadius
        brushSizeLabel.textContent = brushRadius.toFixed(1)
      }
      return
    }

    if (key === 'k') {
      snapSelectedThingNow()
      return
    }

    if (key === 'f') {
      pushUndoState('terrain')
      map.flipTileSplit(x, z)
      updateTileTextureOverlay(x, z)
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true, heightsOnly: true, region: { x1: x, z1: z, x2: x, z2: z } })
      return
    }

    if (key === '1') return setTool(ToolMode.TERRAIN)
    if (key === '2') return setTool(ToolMode.PAINT)
    if (key === '3') return setTool(ToolMode.PLACE)
    if (key === '4') return setTool(ToolMode.SELECT)
    if (key === '5') return setTool(ToolMode.TEXTURE_PLANE)
    if (key === '6') return setTool(ToolMode.NPC_SPAWN)
    if (key === '7') return setTool(ToolMode.COLLISION)
    if (key === '8') return setTool(ToolMode.ITEM_SPAWN)

    if (key === 'v') {
      texturePlaneVertical = !texturePlaneVertical
      if (texturePlaneVertical) {
        diagFloorMode = false
        cancelDiagFloor()
      }
      updateToolUI()
      return
    }

    if (key === 'd' && !event.ctrlKey && !event.metaKey && (state.tool === ToolMode.TEXTURE_PLANE || state.tool === ToolMode.PAINT)) {
      diagFloorMode = !diagFloorMode
      if (diagFloorMode) {
        texturePlaneVertical = false
        const cb = sidebar.querySelector('#toggleTexturePlaneV')
        if (cb) cb.checked = false
      } else {
        cancelDiagFloor()
      }
      updateToolUI()
      return
    }

    if (key === 'x' || key === 'y' || key === 'z') {
      // Consistent convention across all modes:
      // X = east-west, Y = north-south (Three.js Z), Z = vertical (Three.js Y)
      if (key === 'x') transformAxis = 'x'
      else if (key === 'y') transformAxis = 'ground-z'
      else if (key === 'z') transformAxis = 'height'

      // Reset move start so delta recomputes for new axis constraint
      if (transformMode === 'move') movePlaneStart = null

      updateToolUI()
      return
    }

    if (key === 'g') {
      // If nothing is selected, try to pick whatever is under the cursor
      if (!selectedTexturePlane && !selectedPlacedObject) {
        if (texturePlaneGroup) {
          const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m.isDescendantOf(texturePlaneGroup) && m.isVisible)
          if (pick.hit && pick.pickedMesh?.metadata?.texturePlane) {
            selectedTexturePlane = pick.pickedMesh.metadata?.texturePlane
            selectedPlacedObject = null
            const rep = selectedTexturePlane.uvRepeat || 1
            textureScale = rep
            textureScaleSlider.value = rep
            if (textureScaleVal) textureScaleVal.textContent = rep
            // Load tint color
            const tint = selectedTexturePlane.tintColor || { r: 1, g: 1, b: 1 }
            texTintR.value = Math.round(tint.r * 100)
            texTintG.value = Math.round(tint.g * 100)
            texTintB.value = Math.round(tint.b * 100)
            updateTintPreview()
            setTool(ToolMode.SELECT)
            updateSelectionHelper()
          }
        }

        if (!selectedTexturePlane) {
          const pick = scene.pick(scene.pointerX, scene.pointerY, (m) => m.isDescendantOf(placedGroup) && m.isEnabled())
          if (pick.hit) {
            let obj = pick.pickedMesh
            while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
            selectedPlacedObject = obj
            selectedTexturePlane = null
            selectedTexturePlanes = []
            setTool(ToolMode.SELECT)
            updateSelectionHelper()
          }
        }
      }

      transformAxis = 'all'
      beginTransform('move')
      return
    }

    if (key === 'r') {
      if (selectedTexturePlane || selectedPlacedObject) {
        transformAxis = lastRotateAxis
        beginTransform('rotate')
        return
      }

      if (state.tool === ToolMode.TEXTURE_PLANE || (state.tool === ToolMode.PAINT && paintTabTextureId && paintTabTextureId !== '__erase__')) {
        textureRotation = (textureRotation + 1) % 4
        updateToolUI()
        return
      }

      // Rotate preview: X key→X axis, Y key→Y axis, Z key→Z axis, default→Y
      const previewAxis = transformAxis === 'x' ? 'x'
        : transformAxis === 'ground-z' ? 'y'
        : transformAxis === 'height' ? 'z'
        : 'y'
      previewRotation[previewAxis] += Math.PI / 2
      if (previewObject) {
        previewObject.rotationQuaternion = null
        previewObject.rotation.set(previewRotation.x, previewRotation.y, previewRotation.z)
      }
      return
    }

    if (key === 's') {
      transformAxis = 'all'
      beginTransform('scale')
      return
    }

    if (key === 'a' && event.shiftKey) {
      await duplicateSelected('stack')
      return
    }

    if (key === 'a' && event.altKey) {
      await duplicateSelected('back')
      return
    }

    if (key === 'd' && event.ctrlKey && event.shiftKey) {
      await duplicateSelected('right')
      return
    }

    if (key === 'd' && event.ctrlKey) {
      await duplicateSelected('left')
      return
    }

    if (key === 'd' && event.altKey) {
      await duplicateSelected('forward')
      return
    }

    if (key === 'd' && !event.ctrlKey && !event.altKey && !event.shiftKey) {
      await duplicateSelected('inplace')
      return
    }

    if (key === 'd' && event.shiftKey) {
      await duplicateSelected('right')
      return
    }
  })

  async function initAssets() {
    try {
      assetRegistry = await loadAssetRegistry()

      // Default to Props tab
      assetSectionFilter = 'Models'
      assetGroupFilter = 'all'
      clearTabs(); tabProps.classList.add('active')
      assetGroupSelect.style.display = 'none'

      filteredAssets = [...assetRegistry]
      selectedAssetId = filteredAssets.find((a) => a.section === 'Models')?.id || filteredAssets[0]?.id || ''

      refreshAssetList()

      await updatePreviewObject()
    } catch (err) {
      assetGrid.innerHTML = '<div class="asset-grid-empty">Failed to load assets</div>'
      console.error(err)
    }
  }

  async function loadImageMeta(path) {
    return new Promise((resolve) => {
      const img = new Image()
      img.onload = () => resolve({
        width: img.naturalWidth || 64,
        height: img.naturalHeight || 64
      })
      img.onerror = () => resolve({ width: 64, height: 64 })
      img.src = path
    })
  }

  async function initTextures() {
    try {
      textureRegistry = await loadTextureRegistry()
      filteredTextures = [...textureRegistry].sort((a, b) => a.name.localeCompare(b.name))

      for (const tex of textureRegistry) {
        const loadedTexture = new Texture(tex.path, scene, false, true, Texture.NEAREST_LINEAR_MIPLINEAR)
        loadedTexture.anisotropicFilteringLevel = 1
        loadedTexture.wrapU = Texture.CLAMP_ADDRESSMODE
        loadedTexture.wrapV = Texture.CLAMP_ADDRESSMODE
        textureCache.set(tex.id, loadedTexture)

        // Get image dimensions via onload
        const meta = await loadImageMeta(tex.path)
        textureMeta.set(tex.id, meta)
      }

      selectedTextureId = filteredTextures[0]?.id || null
      refreshTexturePalette()
      refreshPaintTexturePalette()
      markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
      updateToolUI()
    } catch (err) {
      console.error('initTextures failed:', err)
      texturePalette.innerHTML = `
        <div style="grid-column:1 / -1; font-size:12px; color:#ff8080; padding:8px 0;">
          Failed to load textures
        </div>
      `
      selectedTextureId = null
      updateToolUI()
    }
  }

  buildGroundSwatches()
  refreshLayersPanel()
  updateToolUI()

  async function initDefaultSave() {
    const params = new URLSearchParams(window.location.search)
    const mapParam = params.get('map')
    if (mapParam) {
      try {
        const res = await fetch(`/worldsave/${encodeURIComponent(mapParam)}.json`)
        if (res.ok) {
          const data = await res.json()
          await loadSaveData(data)
          pushUndoState()
          return
        }
      } catch (e) {
        console.warn('Could not load default save:', e)
      }
    }
    // No map loaded — build the default empty terrain
    markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
    pushUndoState()
  }

  Promise.all([initAssets(), initTextures()]).then(() => initDefaultSave())

  engine.runRenderLoop(() => {
    if (_terrainDirty) {
      rebuildTerrain({ ..._terrainDirtyOpts, _heightsOnlyRegion: _terrainDirtyRegion })
      _terrainDirty = false
      _terrainDirtyRegion = null
      _terrainDirtyOpts = { skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true }
    }
    // Selection helpers are recreated on change, no per-frame update needed
    const t = performance.now() * 0.0003
    waterTexture.uOffset = t * 0.18
    waterTexture.vOffset = t * 0.09
    scene.render()
  })
}