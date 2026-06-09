import { Engine } from '@babylonjs/core/Engines/engine'
import { Scene } from '@babylonjs/core/scene'
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera'
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight'
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight'
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial'
import { SceneLoader } from '@babylonjs/core/Loading/sceneLoader'
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
  BODY_TYPE_NAMES,
  SHIRT_COLORS,
  PANTS_COLORS,
  SHOES_COLORS,
  BELT_COLORS,
  SKIN_COLORS,
  HAIR_COLORS,
  hairStyleChoicesForBodyType,
  normalizeAppearance,
  CHARACTER_TARGET_HEIGHT,
  CHARACTER_IDLE_ANIM,
  computeCutPolygons,
  fanTriangulate,
  bilerpCorners,
  normalizeCutAngle,
  cutSideOf,
  transformOverlayUV,
  fullTileRingForSplit,
  CUT_HORIZONTAL,
  CUT_DIAG_TL_BR,
  CUT_VERTICAL,
  CUT_DIAG_BL_TR,
  DEFAULT_CUT_ANGLE,
  CUT_SNAP_ANGLES,
  CUT_SNAP_TOLERANCE_RAD,
  getObjectFootprintMinTile,
  localAdjacentTilesOrdered,
  ASSET_TO_OBJECT_DEF,
  BLOCKING_TILES,
  classifyTileType,
  NPC_COMBAT_ANIMATIONS,
  deriveUpperFloorTilesFromPlanes,
  resolveEquipmentModelPath,
  BANK_ACCESS_SPAWN_NAME,
  isAllowedBankAccessSpawn,
  validateBankAccessSpawns,
  DEFAULT_WATER_FLOW,
  normalizeWaterFlow,
  npcCombatLevel,
  npcCombatSummary,
  npcMeleeDefenceRoll,
  calculateHitChance,
  osrsMeleeMaxHit,
  ACC_BASE,
  effectiveNpcCombatStats,
  normalizeNpcVisualScale,
  shouldPersistNpcVisualScale,
  RELIC_ITEM_IDS,
  relicCombatDropForLevel,
  relicCombatDropBandForLevel,
  hasNpcEquipmentFits,
  normalizeNpcEquipmentFits,
} from '@projectrs/shared'
// Reused from the client package via vite alias (editor/vite.config.js).
// CharacterEntity loads the rigged character GLB and exposes applyAppearance —
// exactly what we need for the editor's per-spawn preview. Runtime GLBs are
// served through the editor dev server's client-public proxy.
import { CharacterEntity, loadGearTemplate } from '@client/rendering/CharacterEntity'
import { loadStaticGearTemplate } from '@client/rendering/CharacterGearLoader'
import { applyNpcGearFitToNode, createNpcGearTemplateWithFit } from '@client/rendering/NpcGearAttachment'
import { Npc3DEntity } from '@client/rendering/Npc3DEntity'
import { resolveNpcModelSourceId, resolveNpcVisualConfig } from '@client/data/NpcConfig'
import { mergeNpcGearSlotFit, resolveNpcGearSlotConfig } from '@client/data/NpcGearConfig'
import { EQUIP_SLOT_BONES } from '@client/data/EquipmentConfig'
import { resolveItemModelPath as resolveRuntimeItemModelPath } from '@client/rendering/ItemIcon'
import { loadAssetRegistry } from './assets-system/AssetRegistry'
import { loadAssetModel, cloneAssetModelSync, warmAssetCache, makeGhostMaterial, initAssetLoader } from './assets-system/AssetLoader'
import { getThumbnail } from './assets-system/ThumbnailRenderer'
import { openThumbnailRotationEditor } from './assets-system/ThumbnailRotationEditor'
import { openItemThumbnailBrowser } from './assets-system/ItemThumbnailBrowser'
import { openItemStatsEditor } from './item-stats/ItemStatsEditor'
import { openDropTableEditor } from './drop-tables/DropTableEditor'
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
  const waterTexture = new Texture('/assets/textures/1.png', scene, false, true, Texture.TRILINEAR_SAMPLINGMODE)
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

  function setHierarchyPickable(node, pickable) {
    if (!node) return
    if ('isPickable' in node) node.isPickable = pickable
    const meshes = node.getChildMeshes ? node.getChildMeshes() : []
    for (const mesh of meshes) mesh.isPickable = pickable
  }

  function setHierarchyWorldMatrixFrozen(node, frozen) {
    if (!node) return
    const descendants = node.getDescendants ? node.getDescendants(false) : (node.getChildMeshes ? node.getChildMeshes() : [])
    const nodes = [node, ...descendants]
    for (const child of nodes) {
      if (frozen) {
        child.computeWorldMatrix?.(true)
        child.freezeWorldMatrix?.()
      } else {
        child.unfreezeWorldMatrix?.()
      }
    }
  }

  function hierarchyHasAnimations(node) {
    if (!node) return false
    const descendants = node.getDescendants ? node.getDescendants(false) : [
      ...(node.getChildren ? node.getChildren() : []),
      ...(node.getChildMeshes ? node.getChildMeshes() : [])
    ]
    const nodes = [node, ...descendants]
    return nodes.some((child) => Array.isArray(child.animations) && child.animations.length > 0)
  }

  function freezePlacedModel(model) {
    if (!model?.userData || model.userData._editorTransforming) return
    if (hierarchyHasAnimations(model)) return
    if (model.userData._worldMatrixFrozen) setHierarchyWorldMatrixFrozen(model, false)
    setHierarchyWorldMatrixFrozen(model, true)
    model.userData._worldMatrixFrozen = true
  }

  function unfreezePlacedModel(model) {
    if (!model?.userData?._worldMatrixFrozen) return
    setHierarchyWorldMatrixFrozen(model, false)
    model.userData._worldMatrixFrozen = false
  }

  function unfreezePlacedModels(models) {
    for (const model of models || []) {
      if (!model?.userData) continue
      model.userData._editorTransforming = true
      unfreezePlacedModel(model)
    }
  }

  function freezePlacedModels(models) {
    for (const model of models || []) {
      if (!model?.userData) continue
      delete model.userData._editorTransforming
      freezePlacedModel(model)
    }
  }

  function nextFrame() {
    return new Promise(resolve => requestAnimationFrame(resolve))
  }

  async function yieldIfOverBudget(workState, budgetMs = 3) {
    const now = performance.now()
    if (now - workState.startedAt < budgetMs) return
    await nextFrame()
    workState.startedAt = performance.now()
  }

  function updatePlacedModelDerivedData(model) {
    const asset = assetById.get(model.userData?.assetId)
    const path = asset?.path?.toLowerCase() || ''
    const name = asset?.name?.toLowerCase() || ''
    model.userData._isModularAsset = path.includes('modular assets')
    model.userData._isTreeAsset = path.includes('tree') || name.includes('tree')
  }

  function addPlacedModel(model, { invalidateShadow = true } = {}) {
    ensureNodeCompat(model)
    setHierarchyPickable(model, true)
    updatePlacedModelDerivedData(model)
    model.parent = placedGroup
    _spatialRegister(model)
    freezePlacedModel(model)
    if (invalidateShadow) invalidateShadowCache()
    const asset = assetById.get(model.userData.assetId)
    if (asset) setupModelAnimations(model, asset.path)
    if (typeof refreshBrokenLadderIndicators === 'function' && isLadderPlacedObject(model)) refreshBrokenLadderIndicators()
  }

  function removePlacedModel(model) {
    const wasLadder = typeof isLadderPlacedObject === 'function' && isLadderPlacedObject(model)
    _spatialUnregister(model)
    invalidateShadowCache()
    disposeMixer(model)
    model.dispose()
    if (wasLadder && typeof refreshBrokenLadderIndicators === 'function') refreshBrokenLadderIndicators()
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
  let assetById = new Map()
  let editorServerMaps = []
  let editorTeleportEntries = []
  let editorDungeonExits = []
  let currentServerMapId = 'kcmap'
  let filteredAssets = []
  let selectedAssetId = ''
  let previewObject = null
  let previewRotation = { x: 0, y: 0, z: 0 }
  let previewScale = 1.0
  let hoverEdgeHelper = null
  let wallPlacementTargetActive = false

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
  let dragSelectBox = null

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
  const texturePlaneNodesById = new Map()
  const texturePlaneMaterialCache = new Map()

  let texturePlaneVertical = true
  let texturePlaneBridge = false

  // --- NPC Spawn system ---
  let npcDefs = []           // loaded from /api/editor/npcs
  let npcSpawns = []         // { id, npcId, x, z, wanderRange, scale?, maxRange?, huntRange?, facing? }
  let _npcSpawnNextId = 1
  let selectedNpcSpawn = null
  let npcPlacementMode = 'place' // 'place' | 'select' | 'move'
  let npcTypeResultsOpen = false
  let npcTypeResultIndex = 0
  const npcSpawnGroup = new TransformNode('npcSpawnGroup', scene)

  // Per-spawn override fields and the predicates that decide whether they get
  // emitted on save. Single source of truth for both addNpcSpawn and
  // serializeNpcSpawns — adding a new override here is the ONLY change needed
  // for it to round-trip through load → in-memory → save. Matches the
  // SpawnEntry shape in shared/types.ts.
  const NPC_SPAWN_OVERRIDE_FIELDS = {
    aggressive:   v => v === true || v === false,
    maxRange:     v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    huntRange:    v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    attackRange:  v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    retreatHealth: v => typeof v === 'number' && Number.isFinite(v) && v >= 0,
    scale:        shouldPersistNpcVisualScale,
    facing:       v => typeof v === 'number' && Number.isFinite(v),
    appearance:   v => !!v,
    equipment:    v => Array.isArray(v) && (v.length === 10 || v.length === 11),
    equipmentFits: hasNpcEquipmentFits,
    shop:         v => !!v,
    dialogue:     v => !!v,
    name:         v => !!v,
    // Per-spawn stat overrides: object with optional numeric fields. Save
    // when at least one field is set (an empty {} would still round-trip but
    // bloats the JSON for nothing).
    stats:        v => v && typeof v === 'object' && Object.keys(v).length > 0,
    // Per-slot raw RGB overrides; same shape: keep non-empty objects.
    customColors: v => v && typeof v === 'object' && Object.keys(v).length > 0,
    // Forced attack animation name (e.g. 'attack_2h_smash'). Bypasses the
    // weapon-driven picker on the client when set.
    attackAnim:   v => typeof v === 'string' && v.length > 0,
  }

  function npcDefById(npcId) {
    return npcDefs.find(d => d.id === npcId)
  }

  const NPC_DEF_DEFAULT_SPAWN_FIELDS = {
    defaultAppearance: 'appearance',
    defaultEquipment: 'equipment',
    defaultCustomColors: 'customColors',
    defaultAttackAnim: 'attackAnim',
  }

  function cloneNpcSpawnValue(value) {
    return value && typeof value === 'object' ? structuredClone(value) : value
  }

  function applyNpcDefSpawnDefaults(spawn, def) {
    if (!spawn || !def) return
    for (const [defField, spawnField] of Object.entries(NPC_DEF_DEFAULT_SPAWN_FIELDS)) {
      if (spawn[spawnField] != null) continue
      const value = def[defField]
      const accept = NPC_SPAWN_OVERRIDE_FIELDS[spawnField]
      if (accept?.(value)) spawn[spawnField] = cloneNpcSpawnValue(value)
    }
  }

  function applyNpcDefDefaultsToExistingSpawns() {
    for (const spawn of npcSpawns) applyNpcDefSpawnDefaults(spawn, npcDefById(spawn.npcId))
  }

  function bankAccessSaveErrors(mapId, spawns = npcSpawns) {
    return validateBankAccessSpawns(mapId, spawns, npcDefById)
  }

  function ensureBankAccessSpawnName(spawn, def) {
    if (def?.bankAccess && !spawn.name) spawn.name = BANK_ACCESS_SPAWN_NAME
  }

  function bankAccessSpawnHint(def) {
    return `${def?.name || 'This NPC'} opens the bank. Bank-enabled spawns must be explicitly named "${BANK_ACCESS_SPAWN_NAME}".`
  }

  function normalizeNpcFacing(value) {
    if (!Number.isFinite(value)) return 0
    let angle = value
    while (angle > Math.PI) angle -= Math.PI * 2
    while (angle < -Math.PI) angle += Math.PI * 2
    return Math.abs(angle) < 0.0001 ? 0 : angle
  }

  function npcFacingAngle(spawn) {
    return normalizeNpcFacing(spawn?.facing ?? 0)
  }

  function npcFacingDeg(spawn) {
    return Math.round(npcFacingAngle(spawn) * 180 / Math.PI)
  }

  function npcFacingFromDeg(deg) {
    const numeric = Number(deg)
    return normalizeNpcFacing((Number.isFinite(numeric) ? numeric : 0) * Math.PI / 180)
  }

  function normalizeNpcSpawnScale(value) {
    return normalizeNpcVisualScale(Number(value))
  }

  function npcVisualScale(spawn) {
    return normalizeNpcSpawnScale(spawn?.scale ?? 1)
  }

  function formatNpcScale(scale) {
    return `${normalizeNpcSpawnScale(scale).toFixed(2)}x`
  }

  function setNpcSpawnScale(spawn, value) {
    if (!spawn) return 1
    const scale = normalizeNpcSpawnScale(value)
    if (Math.abs(scale - 1) < 0.0001) delete spawn.scale
    else spawn.scale = scale
    const entry = npcPreviews.get(spawn.id)
    entry?.entity?.setVisualScale?.(scale)
    return scale
  }

  function formatNpcFacing(angle) {
    const deg = Math.round(normalizeNpcFacing(angle) * 180 / Math.PI)
    if (deg === 0) return 'South (+Z)'
    if (deg === 90) return 'East (+X)'
    if (deg === -90) return 'West (-X)'
    if (Math.abs(deg) === 180) return 'North (-Z)'
    return `${deg}°`
  }

  function npcSpawnIsStationary(spawn, def = npcDefById(spawn?.npcId)) {
    if (!spawn) return false
    return def?.stationary === true || (spawn.wanderRange ?? def?.wanderRange ?? 0) <= 0
  }

  function npcModelSourceDef(def) {
    const sourceId = resolveNpcModelSourceId(def?.id ?? 0, def)
    return sourceId ? (npcDefById(sourceId) || null) : null
  }

  function npcTypeModelLabel(def) {
    if (!def) return ''
    const visual = resolveNpcVisualConfig(def.id, def)
    const sourceId = visual.sourceId
    const sourceDef = npcModelSourceDef(def)
    const sourceName = sourceDef?.name || `NPC ${sourceId}`
    const own = sourceId === def.id
    if (visual.modelCfg) return own ? 'Own 3D model' : `Model: ${sourceName}`
    if (visual.profile?.modelPath) return own ? 'Skinned model' : `Model: ${sourceName}`
    if (visual.profile) return own ? 'Humanoid model' : `Humanoid: ${sourceName}`
    return own ? 'Default model' : `Model #${sourceId}`
  }

  function npcTypeCombatLevel(def) {
    return def ? npcCombatLevel(effectiveNpcCombatStats(def)) : 0
  }

  function npcSpawnCombatLevel(spawn, def = npcDefById(spawn?.npcId)) {
    return def ? npcCombatLevel(effectiveNpcCombatStats(def, spawn?.stats)) : 0
  }

  function npcPreviewVisualConfig(spawn) {
    if (!spawn) return null
    const def = npcDefById(spawn.npcId)
    return resolveNpcVisualConfig(spawn.npcId, def, spawn.appearance ?? null)
  }

  function shouldShowNpcPreview(spawn) {
    const visual = npcPreviewVisualConfig(spawn)
    return !!(visual?.modelCfg || visual?.profile?.modelPath || spawn?.appearance)
  }

  function npcPreviewKey(spawn) {
    const visual = npcPreviewVisualConfig(spawn)
    const modelCfg = visual?.modelCfg
    if (modelCfg) {
      return `npc3d:${visual.sourceId}:${modelCfg.file}:${modelCfg.scale}:${modelCfg.facingOffsetY ?? 0}`
    }
    if (visual?.profile?.modelPath || spawn?.appearance) {
      return `character:${visual.characterModelPath}`
    }
    return ''
  }

  function addNpcSpawn(input) {
    const { npcId, x, z, wanderRange, id } = input
    // `aggressive` is always present on the in-memory spawn (possibly null)
    // because some UI code reads it without a `in spawn` guard.
    const spawn = { id: id || _npcSpawnNextId++, npcId, x, z, wanderRange, aggressive: input.aggressive ?? null }
    applyNpcDefSpawnDefaults(spawn, npcDefById(npcId))
    // Other override fields: only set if their save predicate accepts the
    // value so a fresh spawn doesn't carry empty values.
    for (const field of Object.keys(NPC_SPAWN_OVERRIDE_FIELDS)) {
      if (field === 'aggressive') continue
      if (NPC_SPAWN_OVERRIDE_FIELDS[field](input[field])) {
        if (field === 'scale') spawn[field] = normalizeNpcSpawnScale(input[field])
        else if (field === 'equipmentFits') spawn[field] = normalizeNpcEquipmentFits(input[field])
        else spawn[field] = cloneNpcSpawnValue(input[field])
      }
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

  function stampNpcSpawnPickMetadataOnNode(node, spawn) {
    if (!node || !spawn) return false
    node.metadata = { ...(node.metadata || {}), npcSpawn: spawn }
    return true
  }

  function stampNpcPreviewPickMetadata(spawn, entry) {
    if (!spawn || !entry?.entity) return false
    let stamped = false
    const root = entry.entity.getRoot?.()
    if (root) {
      stamped = stampNpcSpawnPickMetadataOnNode(root, spawn) || stamped
      const meshes = root.getChildMeshes ? root.getChildMeshes() : []
      for (const mesh of meshes) {
        stamped = stampNpcSpawnPickMetadataOnNode(mesh, spawn) || stamped
      }
    }
    const meshes = entry.entity.getMeshes?.() || []
    for (const mesh of meshes) {
      stamped = stampNpcSpawnPickMetadataOnNode(mesh, spawn) || stamped
    }
    const mesh = entry.entity.getMesh?.()
    if (mesh) stamped = stampNpcSpawnPickMetadataOnNode(mesh, spawn) || stamped
    return stamped
  }

  function ensureNpcPreviewPickMetadata(spawn, entry) {
    if (stampNpcPreviewPickMetadata(spawn, entry)) return
    if (entry.pickMetadataReadyScheduled) return
    entry.pickMetadataReadyScheduled = true
    const afterReady = entry.entity.whenReady?.()
    if (afterReady?.then) {
      afterReady.then(() => {
        entry.pickMetadataReadyScheduled = false
        if (npcPreviews.get(spawn.id) === entry) stampNpcPreviewPickMetadata(spawn, entry)
      })
      return
    }
    requestAnimationFrame(() => {
      entry.pickMetadataReadyScheduled = false
      if (npcPreviews.get(spawn.id) !== entry) {
        return
      }
      stampNpcPreviewPickMetadata(spawn, entry)
    })
  }

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

  /** Lazy-loaded global gear rigging overrides (server/data/gear-overrides.json).
   *  Maps itemId → { boneName?, localPosition?, localRotation?, scale?, file? }.
   *  Mirrors GameManager.gearOverrides — same JSON file, same shape: an OBJECT
   *  keyed by stringified item id (NOT an array). Loading it as an array
   *  silently produced an empty Map, so `/geardebug` rigging never applied
   *  to the editor preview. */
  let editorGearOverrides = null
  let editorGearOverridesPromise = null
  function ensureGearOverrides() {
    if (editorGearOverrides) return Promise.resolve(editorGearOverrides)
    if (editorGearOverridesPromise) return editorGearOverridesPromise
    editorGearOverridesPromise = fetch('/data/gear-overrides.json')
      .then(r => r.ok ? r.json() : {})
      .then(obj => {
        const map = new Map()
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          for (const [id, ov] of Object.entries(obj)) map.set(Number(id), ov)
        }
        editorGearOverrides = map
        return map
      })
      .catch(() => (editorGearOverrides = new Map()))
    return editorGearOverridesPromise
  }

  /** Invalidate the cached overrides + every preview's gear so the next
   *  ensureGearOverrides() refetches from disk. Exposed on window in dev
   *  for the "re-rig and reload" workflow: edit in /geardebug → save →
   *  call editorReloadGearOverrides() in devtools → preview picks up
   *  the new positions without a page refresh. */
  function reloadGearOverrides() {
    editorGearOverrides = null
    editorGearOverridesPromise = null
    for (const [, entry] of npcPreviews) {
      // Force detach so applyEquipmentToPreview re-attaches with new offsets
      // (its short-circuit "already wearing this item" check would otherwise
      // skip the reload).
      for (const slot of EDITOR_EQUIP_SLOT_ORDER) {
        entry.entity.detachGear(slot)
        entry.entity.detachSkinnedArmor?.(slot)
      }
    }
    disposeNpcModelPreviewGearTemplateCache()
    for (const [id, entry] of npcPreviews) {
      const spawn = npcSpawns.find(s => s.id === id)
      if (spawn) void applyEquipmentToPreview(spawn, entry)
    }
  }
  if (import.meta.env.DEV) window.editorReloadGearOverrides = reloadGearOverrides

  /** Build the same GearDef shape GameManager builds, given an item def and
   *  a slot name. Mirrors applyGearToCharacter.buildDef so the preview rigs
   *  gear the same way the live game does. */
  function resolveEditorGearOverride(itemId, bodyType = 0) {
    const override = editorGearOverrides?.get(itemId)
    if (!override) return null
    const base = {
      boneName: override.boneName,
      localPosition: override.localPosition,
      localRotation: override.localRotation,
      scale: override.scale,
      centerOrigin: override.centerOrigin,
      file: override.file,
    }
    if (bodyType <= 0) return base
    const body = override.bodyTypeOverrides?.[String(bodyType)]
    return body ? { ...base, ...body } : base
  }

  function resolveEditorGearFile(slotName, itemId, bodyType = 0) {
    const itemDef = itemDefs.find(d => d.id === itemId)
    const rawOverride = editorGearOverrides?.get(itemId)
    const bodyOverrideFile = bodyType > 0
      ? rawOverride?.bodyTypeOverrides?.[String(bodyType)]?.file
      : null
    if (bodyOverrideFile) return bodyOverrideFile
    if (bodyType > 0 && itemDef?.bodyTypeModels?.[String(bodyType)]) {
      return resolveEquipmentModelPath(itemDef, bodyType, slotName)
    }
    if (rawOverride?.file) return rawOverride.file
    return resolveEquipmentModelPath(itemDef, bodyType, slotName) ?? `/assets/equipment/${slotName}/${itemId}.glb`
  }

  function buildGearDef(slotName, itemId, bodyType = 0) {
    const boneConfig = EQUIP_SLOT_BONES[slotName]
    if (!boneConfig) return null
    const override = resolveEditorGearOverride(itemId, bodyType)
    const gearFile = resolveEditorGearFile(slotName, itemId, bodyType)
    return {
      itemId,
      file: gearFile,
      boneName: override?.boneName ?? boneConfig.boneName,
      localPosition: override?.localPosition ?? boneConfig.localPosition,
      localRotation: override?.localRotation ?? boneConfig.localRotation,
      scale: override?.scale ?? boneConfig.scale,
      centerOrigin: override?.centerOrigin ?? false,
    }
  }

  /** PLAYER_REMOTE_EQUIPMENT index order — matches both
   *  EQUIP_SLOT_NAMES (client) and the spawn.equipment array stored on disk. */
  const EDITOR_EQUIP_SLOT_ORDER = ['weapon', 'shield', 'head', 'body', 'legs', 'neck', 'ring', 'hands', 'feet', 'cape']
  const EDITOR_SKINNED_GEAR_SLOTS = new Set(['body', 'legs', 'hands', 'feet'])
  const npcModelPreviewGearTemplateCache = new Map()

  function disposeNpcModelPreviewGearTemplateCache() {
    for (const template of npcModelPreviewGearTemplateCache.values()) {
      template.template?.dispose?.()
    }
    npcModelPreviewGearTemplateCache.clear()
  }

  function npcModelGearBaseFit(spawn, slot) {
    if (!spawn) return null
    return resolveNpcGearSlotConfig(spawn.npcId, npcDefById(spawn.npcId), slot)
  }

  function npcModelGearFit(spawn, slot) {
    const base = npcModelGearBaseFit(spawn, slot)
    return base ? mergeNpcGearSlotFit(base, spawn.equipmentFits?.[slot]) : null
  }

  function applyNpcModelGearFitToPreview(spawn, slot) {
    const entry = npcPreviews.get(spawn?.id)
    if (!entry || entry.kind !== 'npc3d') return false
    const fit = npcModelGearFit(spawn, slot)
    return fit ? applyNpcGearFitToNode(entry.entity.getGearNode(slot), fit) : false
  }

  function npcEquipmentFitOverride(spawn, slot) {
    return spawn?.equipmentFits?.[slot] ?? null
  }

  function pruneNpcEquipmentFits(spawn) {
    if (!spawn?.equipmentFits) return
    for (const slot of Object.keys(spawn.equipmentFits)) {
      if (!spawn.equipmentFits[slot] || Object.keys(spawn.equipmentFits[slot]).length === 0) {
        delete spawn.equipmentFits[slot]
      }
    }
    if (Object.keys(spawn.equipmentFits).length === 0) delete spawn.equipmentFits
  }

  function writeNpcEquipmentFitOverride(spawn, slot, patch) {
    const base = npcModelGearBaseFit(spawn, slot)
    if (!spawn || !base) return
    const current = { ...(spawn.equipmentFits?.[slot] ?? {}) }
    const next = { ...current, ...patch }
    const cleaned = {}

    if (typeof next.scale === 'number' && Number.isFinite(next.scale) && next.scale > 0 && Math.abs(next.scale - base.scale) > 0.0001) {
      cleaned.scale = next.scale
    }
    for (const key of ['localPosition', 'localRotation']) {
      const value = next[key]
      const baseValue = base[key]
      if (!value || !baseValue) continue
      const x = Number(value.x)
      const y = Number(value.y)
      const z = Number(value.z)
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue
      if (Math.abs(x - baseValue.x) > 0.0001 || Math.abs(y - baseValue.y) > 0.0001 || Math.abs(z - baseValue.z) > 0.0001) {
        cleaned[key] = { x, y, z }
      }
    }

    if (Object.keys(cleaned).length === 0) {
      if (spawn.equipmentFits) delete spawn.equipmentFits[slot]
    } else {
      if (!spawn.equipmentFits) spawn.equipmentFits = {}
      spawn.equipmentFits[slot] = cleaned
    }
    pruneNpcEquipmentFits(spawn)
    if (!applyNpcModelGearFitToPreview(spawn, slot)) refreshNpcPreviewGear(spawn, slot)
  }

  function clearNpcEquipmentFitSlot(spawn, slot) {
    if (!spawn?.equipmentFits) return
    delete spawn.equipmentFits[slot]
    pruneNpcEquipmentFits(spawn)
    if (!applyNpcModelGearFitToPreview(spawn, slot)) refreshNpcPreviewGear(spawn, slot)
  }

  function disposeImportedGearResult(result) {
    for (const group of result.animationGroups ?? []) group.dispose()
    for (const skeleton of result.skeletons ?? []) skeleton.dispose()
    for (const mesh of result.meshes ?? []) mesh.dispose()
  }

  function flattenPreviewGearMaterials(meshes) {
    for (const mesh of meshes) {
      const pbrMat = mesh.material
      if (!pbrMat || !pbrMat.getClassName || pbrMat.getClassName() !== 'PBRMaterial') continue
      const flat = new StandardMaterial(`${pbrMat.name}_flat`, scene)
      if (pbrMat.albedoTexture) flat.diffuseTexture = pbrMat.albedoTexture
      if (pbrMat.albedoColor) {
        const b = 1.3
        flat.diffuseColor = new Color3(
          Math.min(1, pbrMat.albedoColor.r * b),
          Math.min(1, pbrMat.albedoColor.g * b),
          Math.min(1, pbrMat.albedoColor.b * b),
        )
      }
      flat.specularColor = Color3.Black()
      const dc = flat.diffuseColor
      flat.emissiveColor = new Color3(dc.r * 0.55, dc.g * 0.55, dc.b * 0.55)
      flat.backFaceCulling = pbrMat.backFaceCulling ?? true
      mesh.material = flat
    }
  }

  function buildGearTemplateFromImportedResult(result, def) {
    const root = new TransformNode(`gearTemplate_${def.itemId}`, scene)
    for (const mesh of result.meshes) {
      if (!mesh.parent || mesh.parent.name === '__root__') mesh.parent = root
    }

    if (!def.centerOrigin) {
      let minY = Infinity
      for (const mesh of result.meshes) {
        if (mesh.getTotalVertices && mesh.getTotalVertices() === 0) continue
        mesh.computeWorldMatrix(true)
        const bb = mesh.getBoundingInfo().boundingBox
        minY = Math.min(minY, bb.minimumWorld.y)
      }
      if (isFinite(minY)) {
        for (const mesh of result.meshes) mesh.position.y -= minY
      }
    }

    root.setEnabled(false)
    for (const child of root.getChildMeshes()) child.setEnabled(false)
    return {
      template: root,
      boneName: def.boneName,
      localPosition: new Vector3(def.localPosition?.x ?? 0, def.localPosition?.y ?? 0, def.localPosition?.z ?? 0),
      localRotation: new Vector3(def.localRotation?.x ?? 0, def.localRotation?.y ?? 0, def.localRotation?.z ?? 0),
      scale: def.scale ?? 1,
    }
  }

  async function loadGearSmartForPreview(spawn, entry, slot, itemId, def) {
    const stillCurrent = () => npcPreviews.get(spawn.id) === entry
      && Array.isArray(spawn.equipment)
      && spawn.equipment[EDITOR_EQUIP_SLOT_ORDER.indexOf(slot)] === itemId

    try {
      const lastSlash = def.file.lastIndexOf('/')
      const dir = def.file.substring(0, lastSlash + 1)
      const file = def.file.substring(lastSlash + 1)
      const result = await SceneLoader.ImportMeshAsync('', dir, file, scene)
      if (!stillCurrent()) {
        disposeImportedGearResult(result)
        return null
      }

      const itemDef = itemDefs.find(d => d.id === itemId)
      const bodyHideStyle = itemDef?.bodyHideStyle === 'chain' ? 'chain' : 'plate'

      if (result.skeletons.length === 0 && EDITOR_SKINNED_GEAR_SLOTS.has(slot)) {
        const ok = await entry.entity.attachManualSkinnedArmor(slot, def.file, result.meshes, itemId, bodyHideStyle, stillCurrent)
        if (!stillCurrent()) {
          disposeImportedGearResult(result)
          return null
        }
        if (ok) {
          const loaderRoot = result.meshes.find(m => m.name === '__root__')
          if (loaderRoot) loaderRoot.dispose()
          const override = resolveEditorGearOverride(itemId, spawn.appearance?.bodyType ?? 0)
          if (override) entry.entity.applySkinnedArmorTransform(slot, override)
          return null
        }
      }

      if (result.skeletons.length > 0) {
        flattenPreviewGearMaterials(result.meshes)

        if (slot === 'head') {
          const armorSkel = result.skeletons[0]
          const headBone = armorSkel.bones.find(b => b.name === 'mixamorig:Head')
          let headBindY = 0
          if (headBone) {
            const tn = headBone.getTransformNode()
            if (tn) {
              tn.computeWorldMatrix(true)
              headBindY = tn.absolutePosition.y
            }
          }
          for (const sk of result.skeletons) sk.dispose()
          for (const mesh of result.meshes) mesh.skeleton = null
          def.boneName = 'mixamorig:Head'
          def.centerOrigin = true
          const tmpl = buildGearTemplateFromImportedResult(result, def)
          if (!stillCurrent()) {
            tmpl.template.dispose()
            return null
          }
          for (const child of tmpl.template.getChildren()) child.position.y -= headBindY
          return tmpl
        }

        if (EDITOR_SKINNED_GEAR_SLOTS.has(slot)) {
          entry.entity.detachGear(slot)
          if (!stillCurrent()) {
            disposeImportedGearResult(result)
            return null
          }
          entry.entity.attachSkinnedArmor(slot, result.meshes, result.skeletons[0], itemId, bodyHideStyle)
          const loaderRoot = result.meshes.find(m => m.name === '__root__')
          if (loaderRoot) loaderRoot.dispose()
          const override = resolveEditorGearOverride(itemId, spawn.appearance?.bodyType ?? 0)
          if (override) entry.entity.applySkinnedArmorTransform(slot, override)
          return null
        }
      }

      return buildGearTemplateFromImportedResult(result, def)
    } catch (e) {
      console.warn(`[editor-gear] couldn't preview ${slot}/${itemId}: ${e?.message ?? e}`)
      return null
    }
  }

  async function loadNpcModelGearTemplateForPreview(spawn, slot, itemId, itemDef, baseFit) {
    const sourceId = resolveNpcModelSourceId(spawn.npcId, npcDefById(spawn.npcId))
    const cacheKey = `npc:${sourceId}/${slot}/${itemId}`
    let template = npcModelPreviewGearTemplateCache.get(cacheKey)
    if (template) return template

    const gearFile = resolveEquipmentModelPath(itemDef, 0, slot)
    if (!gearFile) return null
    const gearDef = {
      itemId,
      file: gearFile,
      boneName: baseFit.boneName,
      localPosition: baseFit.localPosition,
      localRotation: baseFit.localRotation,
      scale: baseFit.scale,
      centerOrigin: baseFit.centerOrigin,
      headRenderMode: itemDef?.headRenderMode,
    }
    template = await loadStaticGearTemplate(scene, itemId, gearDef, baseFit.sourceBoneName)
    if (!template) return null
    if (baseFit.axisCorrection) {
      template.axisCorrection = new Quaternion(
        baseFit.axisCorrection.x,
        baseFit.axisCorrection.y,
        baseFit.axisCorrection.z,
        baseFit.axisCorrection.w,
      )
    }
    npcModelPreviewGearTemplateCache.set(cacheKey, template)
    return template
  }

  async function applyNpcModelEquipmentToPreview(spawn, entry) {
    if (!Array.isArray(spawn.equipment)) {
      for (const slot of EDITOR_EQUIP_SLOT_ORDER) entry.entity.detachGear(slot)
      return
    }
    if (itemDefs.length === 0) await fetchItemDefsOnce()
    if (npcPreviews.get(spawn.id) !== entry) return

    for (let i = 0; i < EDITOR_EQUIP_SLOT_ORDER.length; i++) {
      const slot = EDITOR_EQUIP_SLOT_ORDER[i]
      const baseFit = npcModelGearBaseFit(spawn, slot)
      if (!baseFit) {
        entry.entity.detachGear(slot)
        continue
      }
      const itemId = spawn.equipment[i] ?? 0
      if (itemId <= 0) {
        entry.entity.detachGear(slot)
        continue
      }
      const itemDef = itemDefs.find(d => d.id === itemId)
      if (!itemDef || itemDef.equipSlot !== slot) {
        entry.entity.detachGear(slot)
        continue
      }

      const fit = npcModelGearFit(spawn, slot)
      if (!fit) continue
      if (entry.entity.getGearItemId(slot) === itemId) {
        applyNpcModelGearFitToPreview(spawn, slot)
        continue
      }

      const template = await loadNpcModelGearTemplateForPreview(spawn, slot, itemId, itemDef, baseFit)
      if (!template || npcPreviews.get(spawn.id) !== entry) return
      entry.entity.attachGear(slot, itemId, createNpcGearTemplateWithFit(template, fit))
      stampNpcPreviewPickMetadata(spawn, entry)
    }
  }

  /** Apply (or re-apply) the spawn's equipment array to its preview entity.
   *  Matches the game runtime: rigid pieces are bone-parented; body/legs/
   *  hands/feet are skinned to the humanoid skeleton. */
  async function applyEquipmentToPreview(spawn, entry) {
    if (entry.kind === 'npc3d') {
      await applyNpcModelEquipmentToPreview(spawn, entry)
      return
    }
    if (!Array.isArray(spawn.equipment)) {
      // No equipment array — detach anything currently shown.
      for (const slot of EDITOR_EQUIP_SLOT_ORDER) {
        entry.entity.detachGear(slot)
        entry.entity.detachSkinnedArmor(slot)
      }
      return
    }
    await ensureGearOverrides()
    if (!editorGearOverrides) return // network failed silently; nothing to apply
    // Fetch item defs if the user opened Gear tab before they were loaded.
    if (itemDefs.length === 0) await fetchItemDefsOnce()
    if (npcPreviews.get(spawn.id) !== entry) return  // stale callback

    for (let i = 0; i < EDITOR_EQUIP_SLOT_ORDER.length; i++) {
      const slot = EDITOR_EQUIP_SLOT_ORDER[i]
      const itemId = spawn.equipment[i] ?? 0
      if (itemId <= 0) {
        entry.entity.detachGear(slot)
        entry.entity.detachSkinnedArmor(slot)
        continue
      }
      // Already wearing this exact item? Skip re-load (loadGearTemplate
      // is ~50ms per GLB).
      const hasExpectedSkinnedAttachment = !EDITOR_SKINNED_GEAR_SLOTS.has(slot) || entry.entity.getSkinnedArmorMeshes(slot)
      if (entry.entity.getGearItemId(slot) === itemId && hasExpectedSkinnedAttachment) continue
      const def = buildGearDef(slot, itemId, spawn.appearance?.bodyType ?? 0)
      if (!def) continue
      try {
        const tmpl = EDITOR_SKINNED_GEAR_SLOTS.has(slot) || slot === 'head'
          ? await loadGearSmartForPreview(spawn, entry, slot, itemId, def)
          : await loadGearTemplate(scene, def)
        if (!tmpl) {
          // Skinned armor attaches directly and returns null.
          stampNpcPreviewPickMetadata(spawn, entry)
          continue
        }
        if (npcPreviews.get(spawn.id) !== entry) return
        entry.entity.attachGear(slot, itemId, tmpl)
        stampNpcPreviewPickMetadata(spawn, entry)
      } catch (e) {
        console.warn(`[editor-gear] couldn't preview ${slot}/${itemId}: ${e?.message ?? e}`)
      }
    }
  }

  function ensureNpcPreview(spawn) {
    if (!shouldShowNpcPreview(spawn)) {
      disposeNpcPreview(spawn)
      return
    }
    const previewKey = npcPreviewKey(spawn)
    let entry = npcPreviews.get(spawn.id)
    if (entry && entry.key !== previewKey) {
      disposeNpcPreview(spawn)
      entry = null
    }
    if (!entry) {
      const visual = npcPreviewVisualConfig(spawn)
      const modelCfg = visual?.modelCfg
      const visualScale = npcVisualScale(spawn)
      if (modelCfg) {
        const def = npcDefById(spawn.npcId)
        const label = spawn.name || def?.name || `NPC ${spawn.npcId}`
        const entity = new Npc3DEntity(scene, modelCfg.file, modelCfg.scale, modelCfg.anims, {
          label,
          materialColors: modelCfg.materialColors,
          visualScale,
          originMode: modelCfg.originMode,
          groundOffset: modelCfg.groundOffset,
          facingOffsetY: modelCfg.facingOffsetY,
          animSpeedRatio: modelCfg.animSpeedRatio,
          preserveAnimationRoles: modelCfg.preserveAnimationRoles,
        })
        entity.setEntityIdMetadata(spawn.id)
        entry = { entity, hiddenNodes: new Set(), kind: 'npc3d', key: previewKey }
      } else {
        const modelPath = visual.characterModelPath
        const entity = new CharacterEntity(scene, {
          name: `npcPreview_${spawn.id}`,
          modelPath,
          targetHeight: CHARACTER_TARGET_HEIGHT,
          visualScale,
          additionalAnimations: [
            { name: 'idle', path: CHARACTER_IDLE_ANIM },
          ],
        })
        entry = { entity, hiddenNodes: new Set(), kind: 'character', key: previewKey }
      }
      npcPreviews.set(spawn.id, entry)
    }
    entry.entity.setVisualScale?.(npcVisualScale(spawn))
    ensureNpcPreviewPickMetadata(spawn, entry)
    const y = map.getAverageTileHeight(Math.floor(spawn.x), Math.floor(spawn.z))
    entry.entity.setPositionXYZ(spawn.x, y, spawn.z)
    entry.entity.setFacingAngle(npcFacingAngle(spawn))
    ensureNpcPreviewPickMetadata(spawn, entry)
    maskPlacedObjectsForPreview(spawn, entry)
    // applyAppearance idempotently re-derives material colors + hair mesh
    // visibility from the appearance struct; safe to call on every edit.
    // Per-spawn raw RGB overrides (spawn.customColors) take precedence over
    // palette indices — pass them through so the preview matches the live game.
    entry.entity.whenReady().then(() => {
      if (npcPreviews.get(spawn.id) !== entry) return
      entry.entity.setFacingAngle(npcFacingAngle(spawn))
      if (entry.kind === 'character' && spawn.appearance) {
        entry.entity.applyAppearance(spawn.appearance, spawn.customColors ?? null)
      }
      // Now load gear. Fire-and-forget — errors handled inside.
      void applyEquipmentToPreview(spawn, entry)
    })
  }

  function disposeNpcPreview(spawn) {
    if (!spawn) return
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
    disposeNpcModelPreviewGearTemplateCache()
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

  function addNpcFacingArrow(spawn, y, color, isSelected) {
    const angle = npcFacingAngle(spawn)
    const dx = Math.sin(angle)
    const dz = Math.cos(angle)
    const length = isSelected ? 0.95 : 0.75
    const headSize = isSelected ? 0.24 : 0.18
    const py = y + 0.14
    const tail = new Vector3(spawn.x, py, spawn.z)
    const head = new Vector3(spawn.x + dx * length, py, spawn.z + dz * length)
    const left = new Vector3(
      head.x + Math.sin(angle + Math.PI * 0.75) * headSize,
      py,
      head.z + Math.cos(angle + Math.PI * 0.75) * headSize,
    )
    const right = new Vector3(
      head.x + Math.sin(angle - Math.PI * 0.75) * headSize,
      py,
      head.z + Math.cos(angle - Math.PI * 0.75) * headSize,
    )
    const arrow = MeshBuilder.CreateLines(`npcFacing_${spawn.id}`, {
      points: [tail, head, left, head, right],
    }, scene)
    arrow.color = color
    arrow.alpha = isSelected ? 1 : 0.7
    arrow.metadata = { npcSpawn: spawn }
    arrow.parent = npcSpawnGroup
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
        const entry = npcPreviews.get(id)
        if (entry) {
          restorePlacedObjectsFromPreview(entry)
          entry.entity.dispose()
        }
        npcPreviews.delete(id)
      }
    }
    for (const spawn of npcSpawns) {
      if (shouldShowNpcPreview(spawn)) ensureNpcPreview(spawn)
      else disposeNpcPreview(spawn)
    }

    for (const spawn of npcSpawns) {
      const def = npcDefs.find(d => d.id === spawn.npcId)
      const isSelected = spawn === selectedNpcSpawn
      const aggressive = def?.aggressive
      const y = map.getAverageTileHeight(Math.floor(spawn.x), Math.floor(spawn.z))
      const color = isSelected ? new Color3(1, 1, 0.2) : (aggressive ? new Color3(0.9, 0.2, 0.15) : new Color3(0.15, 0.7, 0.9))
      const showFacing = isSelected || npcSpawnIsStationary(spawn, def) || Number.isFinite(spawn.facing)
      const visualScale = npcVisualScale(spawn)
      const markerScale = Math.max(1, Math.min(visualScale, 4))

      // Spawns with a real 3D preview would be obscured by the full marker.
      // Use a thin ground disc as the selection affordance instead.
      if (shouldShowNpcPreview(spawn)) {
        const disc = MeshBuilder.CreateDisc(`npcSpawnDisc_${spawn.id}`, { radius: 0.45 * markerScale, tessellation: 24 }, scene)
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
        const marker = MeshBuilder.CreateCylinder(`npcSpawn_${spawn.id}`, { height: 1.2 * markerScale, diameterTop: 0.3 * markerScale, diameterBottom: 0.5 * markerScale, tessellation: 8 }, scene)
        const markerMat = new StandardMaterial(`npcSpawnMat_${spawn.id}`, scene)
        markerMat.diffuseColor = color
        markerMat.emissiveColor = color.scale(0.4)
        markerMat.specularColor = new Color3(0, 0, 0)
        marker.material = markerMat
        marker.position = new Vector3(spawn.x, y + 0.6 * markerScale, spawn.z)
        marker.metadata = { npcSpawn: spawn }
        marker.parent = npcSpawnGroup

        const dot = MeshBuilder.CreateSphere(`npcDot_${spawn.id}`, { diameter: 0.25 * markerScale, segments: 6 }, scene)
        const dotMat = new StandardMaterial(`npcDotMat_${spawn.id}`, scene)
        dotMat.diffuseColor = new Color3(1, 1, 1)
        dotMat.emissiveColor = isSelected ? new Color3(1, 1, 0.3) : new Color3(0.8, 0.8, 0.8)
        dotMat.specularColor = new Color3(0, 0, 0)
        dot.material = dotMat
        dot.position = new Vector3(spawn.x, y + 1.35 * markerScale, spawn.z)
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
        circle.isPickable = false
        circle.parent = npcSpawnGroup
      }
      if (showFacing) addNpcFacingArrow(spawn, y, color, isSelected)
    }

    // Show/hide based on tool
    npcSpawnGroup.setEnabled(state.tool === ToolMode.NPC_SPAWN)
  }

  function selectNpcSpawn(spawn, focusCamera = false) {
    selectedNpcSpawn = spawn || null
    if (selectedNpcSpawn) {
      const sel = sidebar.querySelector('#npcTypeSelect')
      if (sel) sel.value = selectedNpcSpawn.npcId
      if (focusCamera) {
        camera.target = new Vector3(
          selectedNpcSpawn.x,
          map.getAverageTileHeight(Math.floor(selectedNpcSpawn.x), Math.floor(selectedNpcSpawn.z)),
          selectedNpcSpawn.z,
        )
      }
    }
    syncNpcTypeInput()
    if (typeof renderNpcInspector === 'function') renderNpcInspector()
    rebuildNpcSpawnMeshes()
    refreshNpcSpawnList()
    updateNpcPlacementControls()
    updateToolUI()
  }

  function updateNpcPlacementControls() {
    if (npcPlacementMode === 'move' && !selectedNpcSpawn) npcPlacementMode = 'select'
    const panel = sidebar?.querySelector?.('#ctx-npc-spawn')
    if (!panel) return
    for (const btn of panel.querySelectorAll('[data-npc-mode]')) {
      const active = btn.dataset.npcMode === npcPlacementMode
      btn.classList.toggle('active-tool', active)
      btn.style.background = active ? '#2f4f7f' : '#262626'
      btn.style.borderColor = active ? '#6f9ad8' : '#555'
      btn.style.color = active ? '#fff' : '#ddd'
    }
    const selectedLabel = panel.querySelector('#npcSelectedLabel')
    if (selectedLabel) {
      if (selectedNpcSpawn) {
        const def = npcDefById(selectedNpcSpawn.npcId)
        const scale = npcVisualScale(selectedNpcSpawn)
        const scaleText = Math.abs(scale - 1) > 0.0001 ? ` · ${formatNpcScale(scale)}` : ''
        const levelText = def ? ` · level-${npcSpawnCombatLevel(selectedNpcSpawn, def)}` : ''
        selectedLabel.textContent = `${selectedNpcSpawn.name || def?.name || `NPC ${selectedNpcSpawn.npcId}`} @ ${selectedNpcSpawn.x.toFixed(1)}, ${selectedNpcSpawn.z.toFixed(1)}${levelText} · ${formatNpcFacing(npcFacingAngle(selectedNpcSpawn))}${scaleText}`
      } else {
        selectedLabel.textContent = 'No spawn selected'
      }
    }
    const moveBtn = panel.querySelector('#npcModeMoveBtn')
    if (moveBtn) moveBtn.disabled = !selectedNpcSpawn
    const dupBtn = panel.querySelector('#npcDuplicateSelectedBtn')
    if (dupBtn) dupBtn.disabled = !selectedNpcSpawn
    const delBtn = panel.querySelector('#npcDeleteSelectedBtn')
    if (delBtn) delBtn.disabled = !selectedNpcSpawn
    const variantBtn = panel.querySelector('#npcCreateVariantBtn')
    if (variantBtn) variantBtn.disabled = !selectedOrCurrentNpcDef()
  }

  function refreshNpcSpawnList() {
    const listEl = sidebar.querySelector('#npcSpawnList')
    const countEl = sidebar.querySelector('#npcSpawnCount')
    if (!listEl) return
    if (countEl) countEl.textContent = npcSpawns.length

    listEl.innerHTML = ''
    if (npcSpawns.length === 0) {
      const empty = document.createElement('div')
      empty.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.4);padding:5px;background:#1b1b1b;border-radius:3px;'
      empty.textContent = 'No NPC spawns'
      listEl.appendChild(empty)
      updateNpcPlacementControls()
      return
    }
    for (const spawn of npcSpawns) {
      const def = npcDefs.find(d => d.id === spawn.npcId)
      // Per-spawn name takes precedence in the list so renamed NPCs are
      // easy to spot among generic ones.
      const name = spawn.name || def?.name || `NPC ${spawn.npcId}`
      const row = document.createElement('div')
      row.style.cssText = `display:flex;justify-content:space-between;align-items:center;gap:5px;padding:4px 5px;font-size:11px;cursor:pointer;border-radius:3px;margin-bottom:2px;${spawn === selectedNpcSpawn ? 'background:#1a4faf;' : 'background:#222;'}`
      const label = document.createElement('span')
      label.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      const facingText = npcSpawnIsStationary(spawn, def) || Number.isFinite(spawn.facing)
        ? ` f=${formatNpcFacing(npcFacingAngle(spawn))}`
        : ''
      const scale = npcVisualScale(spawn)
      const scaleText = Math.abs(scale - 1) > 0.0001 ? ` s=${formatNpcScale(scale)}` : ''
      const levelText = def ? ` level-${npcSpawnCombatLevel(spawn, def)}` : ''
      label.textContent = `${name}${levelText} (${spawn.x.toFixed(1)}, ${spawn.z.toFixed(1)}) r=${spawn.wanderRange}${facingText}${scaleText}`
      row.appendChild(label)
      const del = document.createElement('button')
      del.type = 'button'
      del.textContent = 'Delete'
      del.title = 'Delete spawn'
      del.style.cssText = 'flex:0 0 auto;font-size:10px;padding:2px 5px;background:#4a2222;color:#fff;border:1px solid #7a4444;border-radius:3px;cursor:pointer;'
      del.addEventListener('click', (event) => {
        event.stopPropagation()
        pushUndoState('spawns')
        removeNpcSpawn(spawn)
        if (selectedNpcSpawn === spawn) selectedNpcSpawn = null
        rebuildNpcSpawnMeshes()
        refreshNpcSpawnList()
        renderNpcInspector()
        updateNpcPlacementControls()
        updateToolUI()
      })
      row.appendChild(del)
      row.addEventListener('click', () => {
        selectNpcSpawn(spawn, true)
      })
      listEl.appendChild(row)
    }
    updateNpcPlacementControls()
  }

  function pickNpcSpawn(event) {
    updateMouse(event)
    const spawnFromMesh = (mesh) => {
      let node = mesh
      while (node) {
        if (node.metadata?.npcSpawn) return node.metadata.npcSpawn
        const entityId = node.metadata?.kind === 'npc' ? node.metadata?.entityId : null
        if (Number.isFinite(entityId)) {
          const spawn = npcSpawns.find(s => s.id === entityId)
          if (spawn) return spawn
        }
        node = node.parent
      }
      return null
    }
    const pick = scene.pick(scene.pointerX, scene.pointerY, (mesh) => {
      return !!spawnFromMesh(mesh)
    })
    if (!pick.hit) return null
    return spawnFromMesh(pick.pickedMesh)
  }

  // --- Item Spawn system ---
  let itemSpawns = []         // { id, itemId, x, z, quantity }
  let _itemSpawnNextId = 1
  let itemDefs = []            // loaded from server
  let questObjectDefs = []      // loaded for quest authoring item/object pickers
  let editorObjectDefs = []     // loaded from server; used by select-object UI
  let editorObjectDefById = new Map()
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

  function resolveItemThumbnailModelPath(def) {
    return resolveRuntimeItemModelPath(def)
  }

  async function loadEditorObjectDefs() {
    try {
      const res = await fetch('/data/objects.json')
      const data = await res.json()
      editorObjectDefs = Array.isArray(data) ? data : []
      editorObjectDefById = new Map(editorObjectDefs.map(def => [def.id, def]))
    } catch (e) {
      console.warn('Failed to load object definitions:', e)
      editorObjectDefs = []
      editorObjectDefById = new Map()
    } finally {
      try {
        if (assetSectionFilter === '__resources__') refreshAssetGroupOptions()
        if (assetSectionFilter === 'Models' || assetSectionFilter === '__resources__') refreshAssetList()
      } catch {}
      try { updateToolUI() } catch {}
    }
  }
  loadEditorObjectDefs()

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
    tiles: {},        // "x,z" -> walkable tile height override
    floorLayers: {}   // floorNum -> { walls, wallHeights, floors, stairs, tiles }
  }
  let collisionMode = 'wall'  // 'wall' | 'block' | 'floor' | 'stair' | 'hole'
  let wallEraseMode = false
  let lockedWallEdge = 0  // locked edge direction during drag (0 = not locked)
  let wallLineStart = null  // {x, z, edge} for Ctrl+click line drawing
  let blockLineStart = null // {x, z} for Ctrl+click block line drawing
  let collisionFloor = 0

  // Diagonal floor placement
  let diagFloorMode = false
  let diagFloorStart = null   // {x, z} world coords of first click
  let diagFloorWidth = 3      // perpendicular width in tiles
  let diagFloorPreview = null  // Babylon Mesh for ghost preview
  let diagFloorPreviewKey = null
  let diagFloorPreviewMat = null

  function snapAngle(angle, snapDeg = 45) {
    const snap = snapDeg * Math.PI / 180
    return Math.round(angle / snap) * snap
  }

  function disposeDiagFloorPreview() {
    if (diagFloorPreview) {
      diagFloorPreview.dispose()
      diagFloorPreview = null
    }
    diagFloorPreviewKey = null
  }

  function getDiagFloorPreviewMaterial() {
    if (diagFloorPreviewMat) return diagFloorPreviewMat
    const mat = new StandardMaterial('diagFloorPreviewMat', scene)
    mat.diffuseColor = new Color3(0.3, 0.6, 1.0)
    mat.alpha = 0.35
    mat.backFaceCulling = false
    diagFloorPreviewMat = mat
    return mat
  }

  function cancelDiagFloor() {
    diagFloorStart = null
    disposeDiagFloorPreview()
  }

  function setTexturePlaneBridgeFlag(plane, enabled) {
    if (!plane) return
    if (enabled) {
      plane.bridge = true
      plane.noRoof = true
    } else {
      delete plane.bridge
    }
  }

  function applyTexturePlaneCreationFlags(plane) {
    setTexturePlaneBridgeFlag(plane, texturePlaneBridge)
  }
  const collisionGroup = new TransformNode('collisionGroup', scene)

  function createCollisionLayer(source = {}) {
    return {
      ...source,
      walls: source.walls || {},
      wallHeights: source.wallHeights || {},
      floors: source.floors || {},
      stairs: source.stairs || {},
      tiles: source.tiles || {},
      holes: source.holes || {},
    }
  }

  function normalizeCollisionFloorLayers(layers = {}) {
    const out = {}
    for (const [floor, layer] of Object.entries(layers || {})) {
      out[floor] = createCollisionLayer(layer)
    }
    return out
  }

  function getCollisionLayer() {
    if (collisionFloor === 0) return collisionData
    if (!collisionData.floorLayers[collisionFloor]) {
      collisionData.floorLayers[collisionFloor] = createCollisionLayer()
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
    const root = createCollisionLayer(data || {})
    collisionData.walls = root.walls
    collisionData.wallHeights = root.wallHeights
    collisionData.floors = root.floors
    collisionData.stairs = root.stairs
    collisionData.tiles = root.tiles
    collisionData.holes = root.holes
    collisionData.floorLayers = normalizeCollisionFloorLayers(data?.floorLayers)
    rebuildCollisionMeshes()
  }

  // --- Biome painting (8x8 tile cells with fog/sky overrides) ---

  const BIOME_CELL_SIZE = 1
  const DEFAULT_SKYBOX_COLOR = [0.4, 0.62, 0.92]
  const DEFAULT_DUNGEON_SKYBOX_COLOR = [0, 0, 0]
  const biomeData = {
    defs: [],         // { id, name, fogColor:[r,g,b] 0-1, fogStart, fogEnd, skybox:{color:[r,g,b]} }
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

  function rgb01Array(value, fallback) {
    const source = Array.isArray(value) && value.length >= 3 ? value : fallback
    return [
      Math.max(0, Math.min(1, Number(source[0]) || 0)),
      Math.max(0, Math.min(1, Number(source[1]) || 0)),
      Math.max(0, Math.min(1, Number(source[2]) || 0))
    ]
  }

  function normalizeSkyboxConfig(value, fallbackColor = DEFAULT_SKYBOX_COLOR) {
    return { color: rgb01Array(value?.color, fallbackColor), showSun: value?.showSun !== false }
  }

  function loadBiomesData(data) {
    biomeData.defs = (data?.defs || []).map(d => ({
      ...d,
      fogColor: rgb01Array(d.fogColor, [0.4, 0.6, 0.9]),
      skybox: normalizeSkyboxConfig(d.skybox, DEFAULT_SKYBOX_COLOR)
    }))
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

  function buildCollisionFloorVisualMaps() {
    const explicit = new Map()
    for (const [floorKey, layer] of Object.entries(collisionData.floorLayers || {})) {
      const floor = Number(floorKey)
      if (!Number.isFinite(floor) || floor <= 0) continue
      const byTile = new Map()
      for (const [key, h] of Object.entries(layer.floors || {})) {
        const [x, z] = key.split(',').map(Number)
        if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(h)) byTile.set(z * map.width + x, h)
      }
      for (const [key, h] of Object.entries(layer.tiles || {})) {
        const [x, z] = key.split(',').map(Number)
        if (Number.isFinite(x) && Number.isFinite(z) && Number.isFinite(h)) byTile.set(z * map.width + x, h)
      }
      explicit.set(floor, byTile)
    }

    const derived = deriveUpperFloorTilesFromPlanes(map.texturePlanes || [], map.width, map.height)

    // Fallback for editor-authored maps whose floorLayers are sparse: rank
    // every horizontal texture-plane surface above terrain per tile. Floor 1
    // means the lowest elevated surface at that tile, floor 2 the next, etc.
    const ranked = new Map()
    for (const plane of map.texturePlanes || []) {
      const rx = plane.rotation?.x ?? 0
      if (Math.abs(Math.abs(rx) - Math.PI / 2) >= 0.1) continue
      const py = plane.position?.y ?? 0
      const px = plane.position?.x ?? 0
      const pz = plane.position?.z ?? 0
      const sx = plane.scale?.x ?? 1
      const sy = plane.scale?.y ?? 1
      const ry = plane.rotation?.y ?? 0
      const hw = ((plane.width ?? 1) * sx) / 2
      const hd = ((plane.height ?? 1) * sy) / 2
      const cosR = Math.cos(ry)
      const sinR = Math.sin(ry)
      const tx0 = Math.max(0, Math.floor(px - Math.abs(cosR * hw) - Math.abs(sinR * hd)))
      const tx1 = Math.min(map.width - 1, Math.floor(px + Math.abs(cosR * hw) + Math.abs(sinR * hd)))
      const tz0 = Math.max(0, Math.floor(pz - Math.abs(sinR * hw) - Math.abs(cosR * hd)))
      const tz1 = Math.min(map.height - 1, Math.floor(pz + Math.abs(sinR * hw) + Math.abs(cosR * hd)))
      for (let tz = tz0; tz <= tz1; tz++) {
        for (let tx = tx0; tx <= tx1; tx++) {
          const tcx = tx + 0.5
          const tcz = tz + 0.5
          const lx = (tcx - px) * cosR + (tcz - pz) * sinR
          const lz = -(tcx - px) * sinR + (tcz - pz) * cosR
          if (Math.abs(lx) > hw || Math.abs(lz) > hd) continue
          const terrainH = map.getAverageTileHeight(tx, tz)
          if (py <= terrainH + 0.75) continue
          const idx = tz * map.width + tx
          let heights = ranked.get(idx)
          if (!heights) {
            heights = []
            ranked.set(idx, heights)
          }
          if (!heights.some(h => Math.abs(h - py) < 0.15)) heights.push(py)
        }
      }
    }
    for (const heights of ranked.values()) heights.sort((a, b) => a - b)

    return { explicit, derived, ranked }
  }

  function resolveCollisionFloorDisplayHeight(x, z, floor, visualMaps) {
    if (floor <= 0) return getCollisionDisplayHeight(x, z)
    const idx = z * map.width + x
    const direct =
      visualMaps.explicit.get(floor)?.get(idx)
      ?? visualMaps.derived.get(floor)?.get(idx)
      ?? visualMaps.ranked.get(idx)?.[floor - 1]
    if (direct != null) return direct

    // Boundary walls are often authored just outside the walkable plane. Use
    // the nearest neighboring tile on the same selected floor for display Y.
    let best = null
    let bestDist = Infinity
    const searchRadius = 2
    for (let dz = -searchRadius; dz <= searchRadius; dz++) {
      for (let dx = -searchRadius; dx <= searchRadius; dx++) {
        if (dx === 0 && dz === 0) continue
        const nx = x + dx
        const nz = z + dz
        if (nx < 0 || nx >= map.width || nz < 0 || nz >= map.height) continue
        const nIdx = nz * map.width + nx
        const h =
          visualMaps.explicit.get(floor)?.get(nIdx)
          ?? visualMaps.derived.get(floor)?.get(nIdx)
          ?? visualMaps.ranked.get(nIdx)?.[floor - 1]
        if (h == null) continue
        const dist = dx * dx + dz * dz
        if (dist < bestDist) {
          bestDist = dist
          best = h
        }
      }
    }
    return best ?? getCollisionDisplayHeight(x, z)
  }

  function rebuildCollisionMeshes() {
    for (const child of [...collisionGroup.getChildren()]) child.dispose(false, true)

    const layer = getCollisionLayer()
    const visualMaps = buildCollisionFloorVisualMaps()

    // Wall edges — render as 3D rectangle outlines at the actual wallHeights.
    // Top edge is color-coded: yellow = default 1.8, orange = custom-height
    // entry. Lets the author see at a glance whether collision walls match
    // the placed GLB wall meshes.
    //
    // Layer-wall base height: mirrors the runtime collision lookup —
    //   layer.floors → layer.tiles → texture-plane elev → terrain.
    // Without the elev fallback, upper-floor walls would visualise at Y=0
    // even though collision blocks at Y=elev (same bug the game client had).
    const wallBaseAt = (x, z) => {
      return resolveCollisionFloorDisplayHeight(x, z, collisionFloor, visualMaps)
    }

    const DEFAULT_WALL_H = 1.8
    const baseLines = []
    const sideLines = []
    const topLinesDefault = []
    const topLinesCustom = []
    for (const [key, bitmask] of Object.entries(layer.walls)) {
      const [x, z] = key.split(',').map(Number)
      const baseY = wallBaseAt(x, z) + 0.02
      const customH = layer.wallHeights?.[key]
      const wallH = customH != null ? customH : DEFAULT_WALL_H
      const topY = baseY + wallH
      const edges = []
      if (bitmask & 1) edges.push([[x, z], [x + 1, z]])                 // N
      if (bitmask & 2) edges.push([[x + 1, z], [x + 1, z + 1]])         // E
      if (bitmask & 4) edges.push([[x, z + 1], [x + 1, z + 1]])         // S
      if (bitmask & 8) edges.push([[x, z], [x, z + 1]])                 // W
      for (const [[ax, az], [bx, bz]] of edges) {
        baseLines.push([new Vector3(ax, baseY, az), new Vector3(bx, baseY, bz)])
        sideLines.push([new Vector3(ax, baseY, az), new Vector3(ax, topY, az)])
        sideLines.push([new Vector3(bx, baseY, bz), new Vector3(bx, topY, bz)])
        const topLine = [new Vector3(ax, topY, az), new Vector3(bx, topY, bz)]
        if (customH != null) topLinesCustom.push(topLine)
        else topLinesDefault.push(topLine)
      }
    }
    const makeLines = (name, lines, color) => {
      if (!lines.length) return
      const m = MeshBuilder.CreateLineSystem(name, { lines }, scene)
      m.color = color
      m.renderingGroupId = 3
      m.isPickable = false
      m.parent = collisionGroup
    }
    makeLines('collWallBases', baseLines, new Color3(1, 0.2, 0.2))         // red bottoms
    makeLines('collWallSides', sideLines, new Color3(1, 0.4, 0.4))         // pink verticals
    makeLines('collWallTopsDefault', topLinesDefault, new Color3(1, 1, 0.2))   // yellow = default 1.8
    makeLines('collWallTopsCustom', topLinesCustom, new Color3(1, 0.6, 0.1))   // orange = per-tile override

    const addFlatQuad = (positions, indices, x, y, z, size = 0.9) => {
      const half = size * 0.5
      const base = positions.length / 3
      positions.push(
        x + 0.5 - half, y, z + 0.5 - half,
        x + 0.5 + half, y, z + 0.5 - half,
        x + 0.5 + half, y, z + 0.5 + half,
        x + 0.5 - half, y, z + 0.5 + half,
      )
      indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    }

    const makeQuadMesh = (name, positions, indices, mat) => {
      if (!positions.length) return
      const mesh = new Mesh(name, scene)
      const vd = new VertexData()
      vd.positions = positions
      vd.indices = indices
      const normals = []
      VertexData.ComputeNormals(positions, indices, normals)
      vd.normals = normals
      vd.applyToMesh(mesh)
      mesh.material = mat
      mesh.renderingGroupId = 3
      mesh.isPickable = false
      mesh.parent = collisionGroup
    }

    // Floor tiles — batched into one mesh. Creating a plane and material per
    // tile made collision painting pay object/material churn on every drag step.
    const floorPositions = []
    const floorIndices = []
    for (const [key, height] of Object.entries(layer.floors || {})) {
      const [x, z] = key.split(',').map(Number)
      addFlatQuad(floorPositions, floorIndices, x, height + 0.05, z)
    }
    if (floorPositions.length) {
      const floorMat = new StandardMaterial('collFloorMat', scene)
      floorMat.diffuseColor = new Color3(0.2, 0.5, 1)
      floorMat.emissiveColor = new Color3(0.1, 0.25, 0.5)
      floorMat.alpha = 0.4
      floorMat.specularColor = new Color3(0, 0, 0)
      floorMat.backFaceCulling = false
      makeQuadMesh('collFloors', floorPositions, floorIndices, floorMat)
    }

    // Stairs — one batched line system instead of one LinesMesh per stair.
    const stairLines = []
    for (const [key, stair] of Object.entries(layer.stairs || {})) {
      const [x, z] = key.split(',').map(Number)
      const midH = (stair.baseHeight + stair.topHeight) / 2
      // Arrow line showing direction
      const cx = x + 0.5, cz = z + 0.5
      const dirVec = { N: [0, -0.4], E: [0.4, 0], S: [0, 0.4], W: [-0.4, 0] }[stair.direction] || [0, -0.4]
      stairLines.push([new Vector3(cx - dirVec[0], midH + 0.2, cz - dirVec[1]), new Vector3(cx + dirVec[0], midH + 0.2, cz + dirVec[1])])
    }
    if (stairLines.length) {
      const stairs = MeshBuilder.CreateLineSystem('collStairs', { lines: stairLines }, scene)
      stairs.color = new Color3(0.2, 1, 0.4)
      stairs.renderingGroupId = 3
      stairs.isPickable = false
      stairs.parent = collisionGroup
    }

    // Hole tiles — batched into one mesh.
    const holePositions = []
    const holeIndices = []
    for (const key of Object.keys(layer.holes || {})) {
      const [x, z] = key.split(',').map(Number)
      const h = resolveCollisionFloorDisplayHeight(x, z, collisionFloor, visualMaps)
      addFlatQuad(holePositions, holeIndices, x, h + 0.05, z)
    }
    if (holePositions.length) {
      const holeMat = new StandardMaterial('collHoleMat', scene)
      holeMat.diffuseColor = new Color3(0.9, 0.3, 0.1)
      holeMat.emissiveColor = new Color3(0.45, 0.15, 0.05)
      holeMat.alpha = 0.45
      holeMat.specularColor = new Color3(0, 0, 0)
      holeMat.backFaceCulling = false
      makeQuadMesh('collHoles', holePositions, holeIndices, holeMat)
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

  function _spatialRefresh(obj) {
    _spatialUnregister(obj)
    _spatialRegister(obj)
    freezePlacedModel(obj)
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
  let historyRestoreInProgress = false
  let placedObjectRebuildToken = 0

const state = {
  tool: ToolMode.SELECT,
  paintType: 'grass',
  halfPaint: false,
  halfPaintCutMode: 'cursor',
  halfPaintCutAngle: DEFAULT_CUT_ANGLE,
  halfPaintCutOffset: 0,
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
let selectedWaterFlowChunk = null

  // RAF dirty-flag: terrain edits mark this dirty; the actual rebuild happens once per animation frame.
  let _terrainDirty = false
  let _terrainDirtyOpts = { skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true }
  let _terrainDirtyRegion = null  // {x1,z1,x2,z2} when only heights changed; null = full rebuild needed
  let _terrainStrokeRegion = null
  let _collisionDirty = false

  function unionTileRegion(a, b) {
    if (!b) return a
    if (!a) return { ...b }
    a.x1 = Math.min(a.x1, b.x1)
    a.z1 = Math.min(a.z1, b.z1)
    a.x2 = Math.max(a.x2, b.x2)
    a.z2 = Math.max(a.z2, b.z2)
    return a
  }

  function markTerrainDirty({ skipTexturePlanes = true, skipShadows = false, skipTextureOverlays = true, heightsOnly = false, region = null, rebuildTexturePlanes = false, rebuildTextureOverlays = false } = {}) {
    // Convenience: explicit rebuild flags override skip flags
    if (rebuildTexturePlanes) skipTexturePlanes = false
    if (rebuildTextureOverlays) skipTextureOverlays = false
    _terrainDirty = true
    if (!skipTexturePlanes)   _terrainDirtyOpts.skipTexturePlanes   = false
    if (!skipShadows)         _terrainDirtyOpts.skipShadows         = false
    if (!skipTextureOverlays) _terrainDirtyOpts.skipTextureOverlays = false

    if (heightsOnly && region) {
      _terrainDirtyRegion = unionTileRegion(_terrainDirtyRegion, region)
      if (state.isPainting && state.tool === ToolMode.TERRAIN) _terrainStrokeRegion = unionTileRegion(_terrainStrokeRegion, region)
    } else {
      _terrainDirtyRegion = null  // structural change — need full rebuild
    }
  }

  function markCollisionDirty() {
    _collisionDirty = true
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
  highlight.isPickable = false

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
    const { angle: cutAngle, offset: cutOffset } = resolveHalfPaintCut(tile, u, v, eventLike, existing)
    const cursorHalf = cutSideOf(u, v, cutAngle, cutOffset)

    const key = `${tile.x},${tile.z},${cutAngle.toFixed(4)},${cutOffset.toFixed(3)},${cursorHalf}`
    if (key === halfPaintPreviewKey) return
    halfPaintPreviewKey = key

    if (halfPaintPreviewLine) { halfPaintPreviewLine.dispose(); halfPaintPreviewLine = null }
    if (halfPaintPreviewFill) { halfPaintPreviewFill.dispose(); halfPaintPreviewFill = null }

    const { halfA, halfB, cutEndpoints } = computeCutPolygons(cutAngle, cutOffset)
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
    halfPaintPreviewFill.isPickable = false
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
    <button id="itemsBtn" title="Edit item stats and compare weapon DPS">Items</button>
    <button id="dropsBtn" title="Edit NPC loot tables">Drops</button>
    <button id="itemThumbsTopBtn" title="Choose render side for inventory and ground 3D item thumbnails">Item Thumbs</button>
    <span class="top-sep"></span>
    <span class="top-label" id="mapSizeLabel">192 x 64</span>
    <button id="chunkGridBtn" title="Add/remove chunks">Chunks</button>
    <div id="chunkGridPopup" style="display:none;position:absolute;top:32px;background:#1a1a1a;border:1px solid #555;border-radius:6px;padding:8px;z-index:100;box-shadow:0 4px 12px rgba(0,0,0,0.5);">
      <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Click active chunk to edit water flow · Shift+click to remove</div>
      <div id="chunkGridContainer" style="display:inline-grid;gap:2px;"></div>
      <div style="margin-top:8px;padding-top:8px;border-top:1px solid #333;">
        <div id="chunkWaterFlowTitle" style="font-size:11px;color:#ddd;margin-bottom:5px;">Water flow: select a chunk</div>
        <select id="chunkWaterFlowPreset" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:11px;">
          <option value="default">Default</option>
          <option value="n">North (-Z)</option>
          <option value="ne">North-East</option>
          <option value="e">East (+X)</option>
          <option value="se">South-East</option>
          <option value="s">South (+Z)</option>
          <option value="sw">South-West</option>
          <option value="w">West (-X)</option>
          <option value="nw">North-West</option>
          <option value="custom">Custom</option>
        </select>
        <div style="display:flex;gap:4px;margin-top:5px;align-items:center;">
          <input id="chunkWaterFlowX" type="number" step="0.1" value="-1" title="Flow X: east is positive" style="width:58px;font-size:11px;" />
          <input id="chunkWaterFlowZ" type="number" step="0.1" value="-0.5" title="Flow Z: south is positive" style="width:58px;font-size:11px;" />
          <button id="chunkWaterFlowApply" style="width:auto;padding:4px 7px;font-size:11px;">Apply</button>
          <button id="chunkWaterFlowClear" style="width:auto;padding:4px 7px;font-size:11px;">Clear</button>
        </div>
      </div>
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
      <div id="halfPaintOptions" style="display:none;margin-top:6px;border:1px solid #444;border-radius:4px;padding:6px;background:#1b1b1b;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Half cut</label>
        <select id="halfPaintCutMode" style="width:100%;margin-top:3px;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:11px;">
          <option value="cursor">Cursor direction</option>
          <option value="horizontal">Horizontal</option>
          <option value="vertical">Vertical</option>
          <option value="diag_tl_br">Diagonal TL-BR</option>
          <option value="diag_bl_tr">Diagonal BL-TR</option>
          <option value="custom">Custom angle</option>
        </select>
        <div id="halfPaintAngleRow" style="display:none;margin-top:6px;">
          <label style="font-size:11px;color:rgba(255,255,255,0.45);">Angle <span id="halfPaintAngleVal">135</span>°</label>
          <input id="halfPaintAngle" type="range" min="0" max="179" step="1" value="135" style="width:100%;" />
        </div>
        <div style="margin-top:6px;">
          <label style="font-size:11px;color:rgba(255,255,255,0.45);">Half Paint Size <span id="halfPaintOffsetVal">50%</span></label>
          <input id="halfPaintOffset" type="range" min="-0.45" max="0.45" step="0.01" value="0" style="width:100%;" />
        </div>
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
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Texture Size <span id="paintTextureScaleVal">1</span></label>
        <input id="paintTextureScale" type="range" min="0.25" max="8" step="0.25" value="1" style="width:100%;" />
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
        <button class="asset-tab" id="tabResources">Resources</button>
        <button class="asset-tab" id="tabModular">Modular</button>
        <button class="asset-tab" id="tabWalls">Walls</button>
        <button class="asset-tab" id="tabRoofs">Roofs</button>
        <button class="asset-tab" id="tabBought">Bought</button>
      </div>
      <select id="assetGroupSelect" style="display:none"></select>
      <div style="display:flex;gap:5px;align-items:center;margin-bottom:5px;">
        <input id="assetSearch" type="text" placeholder="Search assets..." style="flex:1;min-width:0;" />
        <button id="itemThumbsBtn" title="Choose render side for inventory and ground 3D item thumbnails" style="width:auto;padding:5px 7px;font-size:11px;">Thumbs</button>
      </div>
      <div id="assetGrid" class="asset-grid"></div>
      <div style="margin-top:5px;">
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Scale <span id="placeScaleLabel">1.0</span></label>
        <input id="placeScaleSlider" type="range" min="0.1" max="5" step="0.1" value="1.0" style="width:100%;margin-top:3px;" />
        <button id="refreshPreviewBtn" style="width:100%;margin-top:5px;">Refresh Preview</button>
        <div class="hint" style="margin-top:5px;">Hover wall = exact align<br>Ctrl/Cmd upper snap · Alt bypass snap</div>
      </div>
    </div>

    <div class="ctx-panel" id="ctx-select" style="display:none">
      <div class="hint">
        G move · R rotate · S scale<br>
        X Y Z axis lock · click confirm · Esc cancel<br>
        Q/E raise/lower while moving · Shift snap · Ctrl/Cmd surface<br>
        Alt free move (bypass snap) · K snap to grid<br>
        D dup in-place · Shift+D right · Ctrl+D left · Alt+D forward · Alt+A back<br>
        Shift+A stack upward<br>
        Delete / Backspace remove selected
      </div>
      <button id="clearSelectionBtn" style="width:100%;margin-top:8px;">Clear Selection</button>
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
      <div id="objectNameRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Quest object name</div>
        <input id="objectNameInput" type="text" placeholder="Optional named quest object" style="width:100%;box-sizing:border-box;font-size:11px;" />
        <label id="doorDefaultOpenLabel" style="display:none;align-items:center;gap:6px;font-size:11px;color:#ddd;margin-top:8px;cursor:pointer;">
          <input id="doorDefaultOpenInput" type="checkbox" />
          Open by default
        </label>
        <label id="doorOpenDirectionLabel" style="display:none;font-size:11px;color:#ddd;margin-top:6px;">
          <span style="display:block;color:#aaa;margin-bottom:3px;">Open direction</span>
          <select id="doorOpenDirectionSelect" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:11px;">
            <option value="-1">-90</option>
            <option value="1">+90</option>
          </select>
        </label>
        <div id="doorLockedFields" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid #333;">
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#ddd;cursor:pointer;">
            <input id="doorLockedInput" type="checkbox" />
            Locked
          </label>
          <div style="font-size:10px;color:#888;margin:6px 0 3px;">Required key item</div>
          <input id="doorKeyItemInput" list="shopItemDatalist" type="text" placeholder="Key item (optional)" style="width:100%;box-sizing:border-box;font-size:11px;" />
          <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:#ddd;margin-top:6px;cursor:pointer;">
            <input id="doorConsumeKeyInput" type="checkbox" />
            Consume key
          </label>
          <div style="font-size:10px;color:#888;margin:6px 0 3px;">Locked message</div>
          <input id="doorLockedMessageInput" type="text" placeholder="The door is locked." style="width:100%;box-sizing:border-box;font-size:11px;" />
        </div>
        <label id="altarTierLabel" style="display:none;font-size:11px;color:#ddd;margin-top:8px;padding-top:8px;border-top:1px solid #333;">
          <span style="display:block;color:#aaa;margin-bottom:3px;">Altar tier</span>
          <select id="altarTierSelect" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:11px;">
            <option value="1">Tier 1 relics</option>
            <option value="2">Tier 2 relics</option>
            <option value="3">Tier 3 relics</option>
            <option value="4">Tier 4 relics</option>
            <option value="5">Tier 5 relics</option>
          </select>
        </label>
        <div id="ladderWiringRow" style="display:none;margin-top:8px;padding-top:8px;border-top:1px solid #333;">
          <div style="font-size:11px;color:#aaa;margin-bottom:4px;">Vertical link wiring</div>
          <div id="ladderWiringStatus" style="font-size:11px;margin-bottom:6px;color:#ddd;">(status)</div>
          <div style="display:flex;gap:5px;margin-bottom:5px;align-items:center;">
            <span style="font-size:10px;color:#888;">Floor:</span>
            <select id="ladderFloorSelect" style="flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:3px 5px;font-size:11px;">
              <option value="0">0</option><option value="1">1</option><option value="2">2</option><option value="3">3</option>
            </select>
            <span style="font-size:10px;color:#888;">→</span>
            <select id="ladderTargetFloorSelect" style="flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:3px 5px;font-size:11px;">
              <option value="0">0</option><option value="1" selected>1</option><option value="2">2</option><option value="3">3</option>
            </select>
          </div>
          <button id="ladderWireToBtn" style="width:100%;font-size:11px;padding:4px 6px;margin-bottom:5px;">Wire to another link object...</button>
          <button id="ladderSelfBidiBtn" style="width:100%;font-size:11px;padding:4px 6px;margin-bottom:5px;">Make bidirectional (this only)</button>
          <button id="ladderClearLinksBtn" style="width:100%;font-size:11px;padding:4px 6px;color:#ffb0b0;">Clear all links</button>
          <div id="ladderLinksList" style="margin-top:6px;font-size:10px;color:#999;line-height:1.4;"></div>
        </div>
        <div style="font-size:11px;color:#aaa;margin:8px 0 4px;">Examine text</div>
        <textarea id="objectExamineText" placeholder="It's an old sealed letter." style="width:100%;height:54px;box-sizing:border-box;font-size:11px;resize:vertical;"></textarea>
        <div style="font-size:11px;color:#aaa;margin:8px 0 4px;">Interaction effect</div>
        <input id="objectEffectAction" type="text" placeholder="Action label, e.g. Examine" style="width:100%;box-sizing:border-box;font-size:11px;margin-bottom:5px;" />
        <div style="font-size:10px;color:#888;margin:3px 0 4px;">Player overhead sequence</div>
        <textarea id="objectEffectSay" style="display:none;"></textarea>
        <div id="objectEffectSayRows" style="display:flex;flex-direction:column;gap:5px;margin-bottom:5px;"></div>
        <button id="objectEffectAddSayLine" style="width:100%;font-size:11px;padding:4px 6px;margin-bottom:5px;">Add player chat line (+3s)</button>
        <textarea id="objectEffectMessage" placeholder="Private chat-panel message (optional)" style="width:100%;height:44px;box-sizing:border-box;font-size:11px;resize:vertical;"></textarea>
      </div>
      <div id="triggerRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:6px;">Dungeon teleport</div>
        <div style="display:flex;gap:5px;align-items:center;margin-bottom:5px;">
          <select id="triggerType" style="flex:1;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:4px 6px;font-size:12px;">
            <option value="">Default destination</option>
            <option value="teleport">Custom dungeon map</option>
          </select>
        </div>
        <div id="triggerTeleportFields" style="display:none;">
          <div style="font-size:10px;color:#888;margin-bottom:3px;">Destination map</div>
          <input id="triggerDestChunk" type="text" list="triggerDestMapList" placeholder="e.g. underground" style="width:100%;box-sizing:border-box;margin-bottom:5px;font-size:11px;" />
          <datalist id="triggerDestMapList"></datalist>
          <div style="font-size:10px;color:#888;margin-bottom:3px;">Entry point (X / Y / Z)</div>
          <div style="display:flex;gap:3px;">
            <input id="triggerEntryX" type="number" step="0.5" placeholder="X" style="flex:1;min-width:0;" />
            <input id="triggerEntryY" type="number" step="0.5" placeholder="Y" style="flex:1;min-width:0;" />
            <input id="triggerEntryZ" type="number" step="0.5" placeholder="Z" style="flex:1;min-width:0;" />
          </div>
          <button id="triggerUseDungeonExitBtn" style="width:100%;font-size:11px;padding:4px 6px;margin-top:5px;">Use placed dungeon exit</button>
          <button id="triggerUseMapCenterBtn" style="width:100%;font-size:11px;padding:4px 6px;margin-top:5px;">Use map center</button>
          <div id="triggerDungeonExitStatus" style="font-size:10px;color:#888;line-height:1.35;margin-top:4px;"></div>
          <div id="teleportOccupancyPanel" style="margin-top:7px;border:1px solid #333;border-radius:4px;background:#171717;padding:6px;">
            <div style="font-size:10px;color:#aaa;margin-bottom:4px;">Source map placement</div>
            <canvas id="teleportSourceMapCanvas" width="220" height="132" style="display:block;width:100%;height:132px;background:#0d0d0d;border:1px solid #2d2d2d;border-radius:3px;box-sizing:border-box;"></canvas>
            <div id="teleportSourceMapSummary" style="font-size:10px;color:#aaa;line-height:1.35;margin-top:5px;margin-bottom:7px;"></div>
            <div style="font-size:10px;color:#aaa;margin-bottom:4px;border-top:1px solid #2d2d2d;padding-top:7px;">Destination landing points</div>
            <canvas id="teleportOccupancyCanvas" width="220" height="132" style="display:block;width:100%;height:132px;background:#0d0d0d;border:1px solid #2d2d2d;border-radius:3px;box-sizing:border-box;"></canvas>
            <div id="teleportOccupancySummary" style="font-size:10px;color:#aaa;line-height:1.35;margin-top:5px;"></div>
            <div id="teleportSourceProximity" style="font-size:10px;color:#888;line-height:1.35;margin-top:3px;"></div>
            <div id="teleportOccupancyList" style="font-size:10px;color:#888;line-height:1.35;margin-top:5px;max-height:54px;overflow-y:auto;"></div>
          </div>
        </div>
      </div>
      <div id="interactionSidesRow" style="display:none;margin-top:8px;border-top:1px solid #444;padding-top:8px;">
        <div style="font-size:11px;color:#aaa;margin-bottom:4px;">Required use tiles</div>
        <div style="font-size:10px;color:#777;margin-bottom:6px;">Green tiles are valid interaction destinations. Select one tile to force exact pathing. All off = any adjacent tile. ↑ marks local +Z/front.</div>
        <div id="interactionTilesGrid" style="display:inline-block;"></div>
        <div id="interactionTilesSummary" style="font-size:10px;color:#999;margin-top:4px;"></div>
        <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
          <button id="interactSidesNone" style="font-size:10px;padding:3px 6px;">Any adjacent</button>
          <button id="interactSidesFrontCenter" style="font-size:10px;padding:3px 6px;">Front center</button>
          <button id="interactSidesFront" style="font-size:10px;padding:3px 6px;">Front row</button>
          <button id="interactSidesAll" style="font-size:10px;padding:3px 6px;">All perimeter</button>
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
      <div id="texBridgeRow" style="display:none;margin-top:6px;">
        <label style="font-size:11px;cursor:pointer;"><input id="texBridge" type="checkbox" /> Bridge / Walkway (snap to plane)</label>
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
      <label style="margin-top:5px;"><input id="toggleTexturePlaneBridge" type="checkbox" /> Bridge / Walkway</label>
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
      <input id="npcTypeSearch" autocomplete="off" placeholder="Search NPC name or ID" style="width:100%;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:4px;padding:5px 6px;font-size:12px;" />
      <div id="npcTypeResults" style="display:none;max-height:168px;overflow-y:auto;margin-top:4px;background:#181818;border:1px solid #444;border-radius:4px;"></div>
      <select id="npcTypeSelect" style="display:none;"></select>
      <div id="npcTypeSummary" style="font-size:10px;color:rgba(255,255,255,0.45);margin-top:4px;min-height:13px;"></div>
      <button id="npcCreateVariantBtn" style="width:100%;margin-top:6px;font-size:11px;padding:6px;background:#34465d;color:#fff;cursor:pointer;border:1px solid #617891;border-radius:3px;" title="Creates a new reusable NPC type. Use this before editing name, stats, drops, shop, or dialogue for a new mob.">Create new NPC type</button>
      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:8px;">
        <div style="font-size:11px;color:rgba(255,255,255,0.55);">NPC Library</div>
        <div id="npcTypeLibraryCount" style="font-size:10px;color:rgba(255,255,255,0.35);"></div>
      </div>
      <div id="npcTypeLibrary" style="max-height:190px;overflow-y:auto;margin-top:4px;display:grid;grid-template-columns:1fr;gap:4px;"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:4px;margin-top:8px;">
        <button id="npcModePlaceBtn" data-npc-mode="place" style="font-size:11px;padding:5px;background:#262626;color:#ddd;cursor:pointer;border:1px solid #555;border-radius:3px;">Place</button>
        <button id="npcModeSelectBtn" data-npc-mode="select" style="font-size:11px;padding:5px;background:#262626;color:#ddd;cursor:pointer;border:1px solid #555;border-radius:3px;">Select</button>
        <button id="npcModeMoveBtn" data-npc-mode="move" style="font-size:11px;padding:5px;background:#262626;color:#ddd;cursor:pointer;border:1px solid #555;border-radius:3px;">Move</button>
      </div>
      <div style="display:flex;gap:4px;margin-top:5px;">
        <button id="npcDuplicateSelectedBtn" style="flex:1;font-size:11px;padding:5px;background:#33334f;color:#fff;cursor:pointer;border:1px solid #555;border-radius:3px;" title="Copies this placed spawn only. It does not create a new NPC type.">Clone spawn</button>
        <button id="npcDeleteSelectedBtn" style="flex:1;font-size:11px;padding:5px;background:#4a2222;color:#fff;cursor:pointer;border:1px solid #744;border-radius:3px;">Delete spawn</button>
      </div>
      <div id="npcSelectedLabel" style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:5px;min-height:13px;"></div>
      <!-- Tab bar — switches the content area below. Spawn tab shows
           per-instance controls (wander, aggression); the others edit the
           shared NpcDef or per-spawn overrides for the selected spawn. -->
      <div id="npcInspectorTabs" style="display:flex;gap:2px;margin-top:8px;border-bottom:1px solid #444;">
        <button class="npc-tab active-tool" data-tab="spawn" style="flex:1;font-size:10px;padding:5px 2px;background:#2a2a2a;border:1px solid #555;border-bottom:none;border-radius:3px 3px 0 0;color:#fff;cursor:pointer;">Spawn</button>
        <button class="npc-tab" data-tab="stats" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Stats</button>
        <button class="npc-tab" data-tab="appearance" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Look</button>
        <button class="npc-tab" data-tab="equipment" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Gear</button>
        <button class="npc-tab" data-tab="drops" style="flex:1;font-size:10px;padding:5px 2px;background:#1a1a1a;border:1px solid #444;border-bottom:none;border-radius:3px 3px 0 0;color:#aaa;cursor:pointer;">Drops</button>
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
        <label style="font-size:11px;color:rgba(255,255,255,0.45);">Sky Color</label>
        <input id="biomeEditSkyColor" type="color" style="width:100%;height:32px;margin-top:3px;margin-bottom:6px;" />
        <label style="display:flex;align-items:center;gap:6px;font-size:11px;color:rgba(255,255,255,0.65);margin-bottom:8px;">
          <input id="biomeEditShowSun" type="checkbox" checked />
          Show east sun
        </label>
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

  const editorNotice = document.createElement('div')
  editorNotice.id = 'editorNotice'
  editorNotice.style.cssText = 'position:absolute;top:44px;left:50%;transform:translateX(-50%);max-width:min(720px,calc(100vw - 32px));padding:8px 12px;border-radius:4px;background:rgba(20,24,30,0.96);border:1px solid rgba(255,255,255,0.18);box-shadow:0 8px 24px rgba(0,0,0,0.35);font-size:12px;line-height:1.35;color:#fff;display:none;pointer-events:auto;z-index:80;white-space:pre-wrap;'
  uiRoot.appendChild(editorNotice)

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
      <b>While moving:</b> Q raise · E lower · Shift snap to grid · Ctrl/Cmd use upper surface · Alt disable edge snap<br>
      <b>Terrain:</b> Q/E raise/lower hovered · L level mode · F flip tile split<br>
      <b>Clone objects:</b> D in-place · Shift+D right · Ctrl+D left · Alt+D forward · Alt+A back · Shift+A stack up<br>
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
  let builtInNpcDefBaseline = new Map()
  const unlockedSharedNpcDefIds = new Set()
  const BUILT_IN_NPC_DEF_MAX_ID = 99
  const DEFAULT_SHOP_RESTOCK_TICKS = 100
  const SHOP_EDITOR_ITEMS_PER_PAGE = 6
  let shopEditorPageIndex = 0

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

  function stableJson(value) {
    if (value === null) return 'null'
    if (Array.isArray(value)) {
      return `[${value.map(item => item === undefined ? 'null' : stableJson(item)).join(',')}]`
    }
    if (typeof value === 'object') {
      const entries = Object.keys(value)
        .filter(key => value[key] !== undefined)
        .sort()
        .map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      return `{${entries.join(',')}}`
    }
    if (typeof value === 'number' && !Number.isFinite(value)) return 'null'
    return JSON.stringify(value)
  }

  function snapshotBuiltInNpcDefs(defs = npcDefs) {
    builtInNpcDefBaseline = new Map()
    for (const def of defs) {
      if (Number.isInteger(def?.id) && def.id <= BUILT_IN_NPC_DEF_MAX_ID) {
        builtInNpcDefBaseline.set(def.id, stableJson(def))
      }
    }
  }

  function changedBuiltInNpcDefs() {
    const current = new Map()
    for (const def of npcDefs) {
      if (Number.isInteger(def?.id) && def.id <= BUILT_IN_NPC_DEF_MAX_ID) {
        current.set(def.id, def)
      }
    }
    const changes = []
    for (const [id, def] of current) {
      const before = builtInNpcDefBaseline.get(id)
      if (before === undefined) {
        changes.push({ id, name: def.name || `NPC ${id}`, kind: 'added' })
      } else if (before !== stableJson(def)) {
        changes.push({ id, name: def.name || `NPC ${id}`, kind: 'changed' })
      }
    }
    for (const [id, before] of builtInNpcDefBaseline) {
      if (!current.has(id)) {
        let name = `NPC ${id}`
        try {
          name = JSON.parse(before)?.name || name
        } catch {}
        changes.push({ id, name, kind: 'removed' })
      }
    }
    return changes.sort((a, b) => a.id - b.id)
  }

  function confirmBuiltInNpcDefSave() {
    const changes = changedBuiltInNpcDefs()
    if (changes.length === 0) return true
    const listed = changes
      .slice(0, 10)
      .map(change => `#${change.id} ${change.name} (${change.kind})`)
      .join('\n')
    const more = changes.length > 10 ? `\n...and ${changes.length - 10} more` : ''
    return window.confirm(
      `You changed built-in NPC types (IDs 1-${BUILT_IN_NPC_DEF_MAX_ID}):\n\n${listed}${more}\n\nThese changes affect existing mobs everywhere. Continue saving NPC defs?`
    )
  }

  function isNpcSharedEditUnlocked(def) {
    return !!def && unlockedSharedNpcDefIds.has(def.id)
  }

  function unlockNpcSharedEditing(def) {
    if (!def) return false
    const ok = window.confirm(
      `Unlock shared editing for #${def.id} ${def.name || 'NPC'}?\n\nChanges here affect every spawn using this NPC type. For a new mob, use "Create new NPC type" first.`
    )
    if (!ok) return false
    unlockedSharedNpcDefIds.add(def.id)
    renderNpcInspector()
    return true
  }

  function appendNpcSharedEditGate(root, def, scopeLabel = 'shared fields') {
    if (isNpcSharedEditUnlocked(def)) return true
    const card = document.createElement('div')
    card.style.cssText = 'font-size:11px;color:#f2d195;margin:0 0 8px;padding:7px;background:#241f14;border:1px solid #5c4524;border-radius:4px;line-height:1.35;'
    card.innerHTML = `
      <div style="font-weight:bold;color:#ffcc66;margin-bottom:4px;">Shared NPC type locked</div>
      <div style="font-size:10px;color:rgba(255,255,255,0.62);margin-bottom:7px;">
        ${escapeEditorHtml(scopeLabel)} affect NPC type #${def.id} "${escapeEditorHtml(def.name || 'NPC')}" and every spawn using it.
      </div>
      <button data-create-npc-type style="width:100%;font-size:11px;padding:5px;background:#34465d;color:#fff;cursor:pointer;border:1px solid #617891;border-radius:3px;margin-bottom:5px;">Create new NPC type from this</button>
      <button data-unlock-npc-shared style="width:100%;font-size:11px;padding:5px;background:#3b2f20;color:#fff;cursor:pointer;border:1px solid #725634;border-radius:3px;">Unlock shared editing</button>
    `
    root.appendChild(card)
    card.querySelector('[data-create-npc-type]')?.addEventListener('click', createNpcVariantFromCurrentType)
    card.querySelector('[data-unlock-npc-shared]')?.addEventListener('click', () => unlockNpcSharedEditing(def))
    return false
  }

  // Reuses the item-spawn system's itemDefs (declared above) — they share the
  // same /data/items.json source, no point in loading it twice.
  function fetchItemDefsOnce() {
    if (itemDefs.length > 0) return Promise.resolve(itemDefs)
    return loadItemDefs().then(() => itemDefs).catch(() => [])
  }

  /** Shared datalist used by every item picker. One node appended to the body —
   *  referenced via `list="shopItemDatalist"` on each input. In quest authoring
   *  it also includes named placed objects that produce items, so authors can
   *  search by the quest object name while still saving the underlying itemId. */
  function ensureShopItemDatalist() {
    let dl = document.getElementById('shopItemDatalist')
    const questObjectItems = questObjectItemChoices()
    const signature = JSON.stringify({
      itemCount: itemDefs.length,
      questObjectItems: questObjectItems.map(c => `${c.name}:${c.itemId}:${c.source}`),
    })
    if (dl && dl.dataset.signature === signature) return  // already in sync
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
    for (const choice of questObjectItems) {
      const opt = document.createElement('option')
      opt.value = `${choice.name}: ${formatItemDisplay(choice.itemId)}`
      opt.label = `${choice.source} quest object`
      dl.appendChild(opt)
    }
    dl.dataset.signature = signature
  }

  function questObjectItemChoices() {
    if (!placedGroup || !questObjectDefs.length) return []
    const choices = []
    const seen = new Set()
    for (const obj of placedGroup.getChildren()) {
      const name = obj.userData?.name
      const objectDefId = ASSET_TO_OBJECT_DEF[obj.userData?.assetId]
      if (!name || objectDefId == null) continue
      const def = questObjectDefs.find(d => d.id === objectDefId)
      if (!def) continue
      const add = (itemId, source) => {
        if (!Number.isInteger(itemId) || itemId <= 0) return
        const key = `${name}:${itemId}:${source}`
        if (seen.has(key)) return
        seen.add(key)
        choices.push({ name, itemId, source })
      }
      add(def.harvestItemId, def.name || 'Object')
      for (const drop of def.extraLoot || []) add(drop.itemId, def.name || 'Object')
    }
    return choices.sort((a, b) => `${a.name} ${formatItemDisplay(a.itemId)}`.localeCompare(`${b.name} ${formatItemDisplay(b.itemId)}`))
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

  function escapeEditorHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function formatNpcTypeDisplay(def) {
    return def ? `${def.name} (ID ${def.id})` : ''
  }

  function formatNpcTypeOptionLabel(def) {
    if (!def) return ''
    const suffix = def.bankAccess ? ' — BANK' : ''
    return `${def.name} (ID ${def.id}) — level-${npcTypeCombatLevel(def)} — HP ${def.health} — ${npcTypeModelLabel(def)}${suffix}`
  }

  function formatNpcTypeSummary(def) {
    if (!def) return ''
    return `level-${npcTypeCombatLevel(def)} · HP ${def.health} · Wander ${def.wanderRange ?? 0} · ${npcTypeModelLabel(def)}${def.aggressive ? ' · Aggressive' : ''}${def.bankAccess ? ' · Bank' : ''}`
  }

  function parseNpcTypeDisplay(value) {
    const text = String(value || '').trim()
    if (!text) return 0
    const exact = npcDefs.find(def => formatNpcTypeDisplay(def) === text)
    if (exact) return exact.id
    const idMatch = text.match(/\bID\s*(\d+)\b/i) || text.match(/\((\d+)\)\s*$/)
    if (idMatch) return parseInt(idMatch[1])
    const bareId = parseInt(text)
    if (Number.isFinite(bareId) && npcDefs.some(def => def.id === bareId)) return bareId
    const lower = text.toLowerCase()
    const exactNameMatches = npcDefs.filter(def => String(def.name || '').toLowerCase() === lower)
    if (exactNameMatches.length === 1) return exactNameMatches[0].id
    if (exactNameMatches.length > 1) return 0
    const matches = npcTypeMatches(text)
    return matches.length === 1 ? matches[0].id : 0
  }

  function npcTypeMatches(query) {
    const q = String(query || '').trim().toLowerCase()
    const terms = q.split(/\s+/).filter(Boolean)
    const scored = []
    for (const def of npcDefs) {
      const name = String(def.name || '').toLowerCase()
      const id = String(def.id)
      const haystack = `${name} ${id}`
      let score = 0
      if (terms.length > 0) {
        if (id === q) score = -100
        else if (name === q) score = -90
        else if (name.startsWith(q)) score = -70
        else if (terms.every(term => haystack.includes(term))) score = -40
        else continue
      }
      scored.push({ def, score })
    }
    return scored
      .sort((a, b) => a.score - b.score || (a.def.name || '').localeCompare(b.def.name || '') || a.def.id - b.def.id)
      .slice(0, terms.length > 0 ? 16 : scored.length)
      .map(row => row.def)
  }

  function renderNpcTypeResults(query = '') {
    const results = sidebar?.querySelector?.('#npcTypeResults')
    if (!results) return
    if (!npcTypeResultsOpen) {
      results.style.display = 'none'
      return
    }
    results.innerHTML = ''
    const matches = npcTypeMatches(query)
    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No matches'
      empty.style.cssText = 'padding:6px;font-size:11px;color:rgba(255,255,255,0.45);'
      results.appendChild(empty)
      results.style.display = 'block'
      return
    }

    const input = sidebar.querySelector('#npcTypeSearch')
    const selectedId = parseInt(sidebar.querySelector('#npcTypeSelect')?.value || '0')
    if (npcTypeResultIndex < 0 || npcTypeResultIndex >= matches.length) npcTypeResultIndex = 0
    matches.forEach((def, index) => {
      const row = document.createElement('button')
      row.type = 'button'
      const active = document.activeElement === input ? index === npcTypeResultIndex : def.id === selectedId
      row.style.cssText = `display:flex;justify-content:space-between;align-items:center;gap:8px;width:100%;text-align:left;padding:5px 7px;background:${active ? '#274b7a' : 'transparent'};color:#fff;border:0;border-bottom:1px solid #2a2a2a;cursor:pointer;font-size:11px;`
      const name = document.createElement('span')
      name.textContent = `${def.name} (${def.id})`
      name.style.cssText = 'min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      const meta = document.createElement('span')
      meta.textContent = `level-${npcTypeCombatLevel(def)} · HP ${def.health} · ${npcTypeModelLabel(def)}${def.bankAccess ? ' · Bank' : ''}`
      meta.style.cssText = 'flex:0 0 auto;color:rgba(255,255,255,0.48);'
      row.appendChild(name)
      row.appendChild(meta)
      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        setNpcTypeSelection(def.id)
      })
      results.appendChild(row)
    })
    results.style.display = 'block'
  }

  function npcTypeSpawnCounts() {
    const counts = new Map()
    for (const spawn of npcSpawns) {
      counts.set(spawn.npcId, (counts.get(spawn.npcId) || 0) + 1)
    }
    return counts
  }

  function renderNpcTypeLibrary(query = '') {
    const library = sidebar?.querySelector?.('#npcTypeLibrary')
    const countEl = sidebar?.querySelector?.('#npcTypeLibraryCount')
    if (!library) return
    const matches = npcTypeMatches(query)
    const counts = npcTypeSpawnCounts()
    const selectedId = parseInt(sidebar.querySelector('#npcTypeSelect')?.value || '0')
    library.innerHTML = ''
    if (countEl) countEl.textContent = query ? `${matches.length}/${npcDefs.length}` : `${npcDefs.length}`
    if (matches.length === 0) {
      const empty = document.createElement('div')
      empty.textContent = 'No matching NPCs'
      empty.style.cssText = 'padding:6px;font-size:11px;color:rgba(255,255,255,0.45);background:#1b1b1b;border-radius:3px;'
      library.appendChild(empty)
      return
    }
    for (const def of matches) {
      const used = counts.get(def.id) || 0
      const active = def.id === selectedId
      const card = document.createElement('button')
      card.type = 'button'
      card.style.cssText = `width:100%;text-align:left;padding:6px;background:${active ? '#243f68' : '#1f1f1f'};color:#fff;border:1px solid ${active ? '#6f9ad8' : '#3a3a3a'};border-radius:4px;cursor:pointer;`
      const top = document.createElement('div')
      top.style.cssText = 'display:flex;justify-content:space-between;gap:8px;align-items:center;'
      const name = document.createElement('div')
      name.textContent = `${def.name || 'NPC'}`
      name.style.cssText = 'font-size:11px;font-weight:600;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      const id = document.createElement('div')
      id.textContent = `#${def.id}`
      id.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.45);flex:0 0 auto;'
      top.appendChild(name)
      top.appendChild(id)
      const meta = document.createElement('div')
      meta.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.55);margin-top:3px;display:flex;gap:5px;flex-wrap:wrap;'
      const badges = [
        `level-${npcTypeCombatLevel(def)}`,
        `HP ${def.health ?? 0}`,
        `W ${def.wanderRange ?? 0}`,
        npcTypeModelLabel(def),
        used > 0 ? `Used ${used}` : 'Unused',
        def.id >= 100 ? 'Custom' : '',
        def.aggressive ? 'Aggro' : '',
        def.bankAccess ? 'Bank' : '',
      ].filter(Boolean)
      meta.textContent = badges.join(' · ')
      card.appendChild(top)
      card.appendChild(meta)
      card.addEventListener('click', () => setNpcTypeSelection(def.id))
      library.appendChild(card)
    }
  }

  function closeNpcTypeResultsSoon() {
    setTimeout(() => {
      if (document.activeElement === sidebar?.querySelector?.('#npcTypeSearch')) return
      npcTypeResultsOpen = false
      renderNpcTypeResults()
    }, 120)
  }

  function populateNpcTypeControls(defs) {
    const sel = sidebar.querySelector('#npcTypeSelect')
    if (sel) {
      sel.innerHTML = defs.map(d => {
        const title = d.bankAccess ? ` title="Bank-enabled spawns must be named &quot;${BANK_ACCESS_SPAWN_NAME}&quot;."` : ''
        return `<option value="${d.id}"${title}>${formatNpcTypeOptionLabel(d)}</option>`
      }).join('')
      if (!sel.value && defs[0]) sel.value = defs[0].id
    }
    syncNpcTypeInput()
  }

  function syncNpcTypeInput() {
    const sel = sidebar?.querySelector?.('#npcTypeSelect')
    const input = sidebar?.querySelector?.('#npcTypeSearch')
    const summary = sidebar?.querySelector?.('#npcTypeSummary')
    const selectedTypeId = selectedNpcSpawn?.npcId ?? parseInt(sel?.value || '0')
    const def = npcDefById(selectedTypeId)
    if (input && def && document.activeElement !== input) input.value = formatNpcTypeDisplay(def)
    renderNpcTypeResults(input?.value || '')
    if (summary) {
      summary.textContent = formatNpcTypeSummary(def)
    }
    renderNpcTypeLibrary(document.activeElement === input ? input?.value || '' : '')
  }

  function setNpcTypeSelection(npcId) {
    const requestedDef = npcDefById(npcId)
    if (!requestedDef) {
      syncNpcTypeInput()
      return false
    }
    const sel = sidebar.querySelector('#npcTypeSelect')
    const input = sidebar.querySelector('#npcTypeSearch')
    if (sel) sel.value = requestedDef.id
    if (selectedNpcSpawn) {
      if (requestedDef.bankAccess) {
        const mapId = serverMapSelect?.value || ''
        const candidate = { ...selectedNpcSpawn, npcId: requestedDef.id }
        ensureBankAccessSpawnName(candidate, requestedDef)
        if (!isAllowedBankAccessSpawn(mapId, candidate)) {
          alert(bankAccessSpawnHint(requestedDef))
          if (sel) sel.value = selectedNpcSpawn.npcId
          syncNpcTypeInput()
          return false
        }
        selectedNpcSpawn.name = candidate.name
      }
      selectedNpcSpawn.npcId = requestedDef.id
      applyNpcDefSpawnDefaults(selectedNpcSpawn, requestedDef)
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
    }
    if (input) input.value = formatNpcTypeDisplay(requestedDef)
    npcTypeResultsOpen = false
    syncNpcTypeInput()
    renderNpcInspector()
    updateNpcPlacementControls()
    updateToolUI()
    return true
  }

  function setNpcPlacementMode(mode) {
    if (!['place', 'select', 'move'].includes(mode)) return
    if (mode === 'move' && !selectedNpcSpawn) mode = 'select'
    npcPlacementMode = mode
    updateNpcPlacementControls()
    updateToolUI()
  }

  function currentNpcPlacementDefaults() {
    const npcId = parseInt(sidebar.querySelector('#npcTypeSelect')?.value)
    if (!npcId) return null
    const defForPlace = npcDefs.find(d => d.id === npcId)
    const wanderSlider = sidebar.querySelector('#wanderRangeSlider')
    const aggCb = sidebar.querySelector('#aggressiveCheckbox')
    const wanderRange = wanderSlider ? (parseInt(wanderSlider.value) || (defForPlace?.wanderRange ?? 3)) : (defForPlace?.wanderRange ?? 3)
    const aggressive = aggCb ? aggCb.checked : null
    return { npcId, defForPlace, wanderRange, aggressive }
  }

  function createNpcSpawnAtTile(tile) {
    const defaults = currentNpcPlacementDefaults()
    if (!defaults) return null
    const spawnInput = {
      npcId: defaults.npcId,
      x: tile.x + 0.5,
      z: tile.z + 0.5,
      wanderRange: defaults.wanderRange,
      aggressive: defaults.aggressive,
    }
    ensureBankAccessSpawnName(spawnInput, defaults.defForPlace)
    if (defaults.defForPlace?.bankAccess) {
      const mapId = serverMapSelect?.value || ''
      if (!isAllowedBankAccessSpawn(mapId, spawnInput)) {
        alert(bankAccessSpawnHint(defaults.defForPlace))
        return null
      }
    }
    pushUndoState('spawns')
    const spawn = addNpcSpawn(spawnInput)
    selectNpcSpawn(spawn, false)
    return spawn
  }

  function moveSelectedNpcSpawnToTile(tile) {
    if (!selectedNpcSpawn) return false
    pushUndoState('spawns')
    selectedNpcSpawn.x = tile.x + 0.5
    selectedNpcSpawn.z = tile.z + 0.5
    selectNpcSpawn(selectedNpcSpawn, false)
    return true
  }

  function deleteSelectedNpcSpawn() {
    if (!selectedNpcSpawn) return
    pushUndoState('spawns')
    const removed = selectedNpcSpawn
    removeNpcSpawn(removed)
    selectedNpcSpawn = null
    rebuildNpcSpawnMeshes()
    refreshNpcSpawnList()
    renderNpcInspector()
    updateNpcPlacementControls()
    updateToolUI()
  }

  async function loadNpcDefsForEditor() {
    const urls = ['/api/editor/npcs', '/data/npcs.json']
    let lastError = null
    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: 'no-store' })
        if (!r.ok) throw new Error(`${url} returned ${r.status}`)
        const defs = await r.json()
        if (!Array.isArray(defs)) throw new Error(`${url} did not return an NPC array`)
        return defs
      } catch (err) {
        lastError = err
      }
    }
    throw lastError || new Error('Failed to load NPC defs')
  }

  loadNpcDefsForEditor()
    .then(defs => {
      npcDefs = defs
      snapshotBuiltInNpcDefs(defs)
      applyNpcDefDefaultsToExistingSpawns()
      populateNpcTypeControls(defs)
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
      renderNpcInspector()
    })
    .catch(e => console.warn('Failed to load NPC defs:', e))

  sidebar.querySelector('#npcTypeSelect')?.addEventListener('change', (e) => {
    setNpcTypeSelection(parseInt(e.target.value))
  })

  sidebar.querySelector('#npcTypeSearch')?.addEventListener('change', (e) => {
    const npcId = parseNpcTypeDisplay(e.target.value)
    if (setNpcTypeSelection(npcId)) {
      const def = npcDefById(npcId)
      if (def) e.target.value = formatNpcTypeDisplay(def)
    } else {
      syncNpcTypeInput()
    }
  })

  sidebar.querySelector('#npcTypeSearch')?.addEventListener('input', (e) => {
    npcTypeResultsOpen = true
    npcTypeResultIndex = 0
    renderNpcTypeResults(e.target.value)
    renderNpcTypeLibrary(e.target.value)
  })

  sidebar.querySelector('#npcTypeSearch')?.addEventListener('focus', (e) => {
    npcTypeResultsOpen = true
    npcTypeResultIndex = 0
    const selectedDef = npcDefById(parseInt(sidebar.querySelector('#npcTypeSelect')?.value || '0'))
    if (selectedDef && e.target.value === formatNpcTypeDisplay(selectedDef)) e.target.value = ''
    renderNpcTypeResults(e.target.value)
    renderNpcTypeLibrary(e.target.value)
  })

  sidebar.querySelector('#npcTypeSearch')?.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const matches = npcTypeMatches(e.target.value)
      if (matches.length > 0) {
        e.preventDefault()
        npcTypeResultsOpen = true
        npcTypeResultIndex = e.key === 'ArrowDown'
          ? Math.min(matches.length - 1, npcTypeResultIndex + 1)
          : Math.max(0, npcTypeResultIndex - 1)
        renderNpcTypeResults(e.target.value)
      }
    } else if (e.key === 'Enter') {
      const matches = npcTypeMatches(e.target.value)
      const picked = matches[npcTypeResultIndex] || matches[0]
      if (picked) {
        e.preventDefault()
        setNpcTypeSelection(picked.id)
      }
    } else if (e.key === 'Escape') {
      npcTypeResultsOpen = false
      renderNpcTypeResults()
      syncNpcTypeInput()
    }
  })

  sidebar.querySelector('#npcTypeSearch')?.addEventListener('blur', () => {
    syncNpcTypeInput()
    closeNpcTypeResultsSoon()
  })

  for (const btn of sidebar.querySelectorAll('[data-npc-mode]')) {
    btn.addEventListener('click', () => setNpcPlacementMode(btn.dataset.npcMode))
  }
  sidebar.querySelector('#npcCreateVariantBtn')?.addEventListener('click', createNpcVariantFromCurrentType)
  sidebar.querySelector('#npcDuplicateSelectedBtn')?.addEventListener('click', duplicateSelectedNpcSpawn)
  sidebar.querySelector('#npcDeleteSelectedBtn')?.addEventListener('click', deleteSelectedNpcSpawn)

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
      await saveNpcDefsToServer()
    } catch (err) {
      if (status) status.textContent = err?.cancelled ? 'save cancelled' : (err?.message || 'save failed')
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
    syncNpcTypeInput()

    if (activeNpcTab === 'spawn') {
      renderSpawnTab(content)
    } else if (activeNpcTab === 'stats') {
      renderStatsTab(content, def)
    } else if (activeNpcTab === 'appearance') {
      renderAppearanceTab(content)
    } else if (activeNpcTab === 'equipment') {
      renderEquipmentTab(content)
    } else if (activeNpcTab === 'drops') {
      renderDropsTab(content, def)
    } else if (activeNpcTab === 'shop') {
      renderShopTab(content, def)
    } else if (activeNpcTab === 'dialogue') {
      renderDialogueTab(content, def)
    }
  }

  /** Friendly labels for the attack-anim dropdown. Only animation names whose
   *  GLB is actually loaded for combat NPCs (NPC_COMBAT_ANIMATIONS) belong
   *  here — other names would just silently fail to play. */
  const ATTACK_ANIM_LABELS = {
    attack_punch:    'Punch',
    attack_slash:    'Slash',
    attack_1h_slash: '1H slash',
    attack_2h_slash: '2H slash',
    attack_2h_smash: '2H smash',
    stab:            'Stab',
    kick:            'Kick',
  }
  const ATTACK_ANIM_NAMES = NPC_COMBAT_ANIMATIONS
    .map(a => a.name)
    .filter(n => n !== 'idle' && n !== 'walk')

  /** Clone the selected spawn, place it one tile east, select the copy.
   *  structuredClone deep-copies override fields (stats, customColors,
   *  appearance, equipment, shop, dialogue) so edits to the duplicate
   *  don't leak back to the original. */
  function duplicateSelectedNpcSpawn() {
    if (!selectedNpcSpawn) return
    const def = npcDefById(selectedNpcSpawn.npcId)
    const src = selectedNpcSpawn
    const copy = structuredClone(src)
    // structuredClone preserves `id`; strip it so addNpcSpawn assigns a fresh one.
    delete copy.id
    copy.x = src.x + 1
    copy.z = src.z
    ensureBankAccessSpawnName(copy, def)
    if (def?.bankAccess) {
      const mapId = serverMapSelect?.value || ''
      if (!isAllowedBankAccessSpawn(mapId, copy)) {
        alert(bankAccessSpawnHint(def))
        return
      }
    }
    pushUndoState('spawns')
    const created = addNpcSpawn(copy)
    selectedNpcSpawn = created
    rebuildNpcSpawnMeshes()
    refreshNpcSpawnList()
    renderNpcInspector()
  }

  function renderSpawnTab(root) {
    const spawn = selectedNpcSpawn
    const def = findSelectedDef() || npcDefById(parseInt(sidebar.querySelector('#npcTypeSelect')?.value))
    const defaultWander = def?.wanderRange ?? 3
    const wander = spawn?.wanderRange ?? defaultWander
    const aggressiveEffective = spawn
      ? (spawn.aggressive === true || spawn.aggressive === false ? spawn.aggressive : !!def?.aggressive)
      : !!def?.aggressive
    const nameValue = spawn?.name ?? ''
    const defName = def?.name ?? ''
    const curAnim = spawn?.attackAnim ?? ''
    const animOptions = ATTACK_ANIM_NAMES
      .map(n => `<option value="${n}" ${n === curAnim ? 'selected' : ''}>${ATTACK_ANIM_LABELS[n] ?? n}</option>`)
      .join('')
    const posX = spawn?.x ?? 0
    const posZ = spawn?.z ?? 0
    const visualScale = npcVisualScale(spawn)
    const facingDeg = spawn ? npcFacingDeg(spawn) : 0
    const facingLabel = formatNpcFacing(spawn ? npcFacingAngle(spawn) : 0)
    const stationary = spawn ? npcSpawnIsStationary(spawn, def) : false
    const facingHint = stationary
      ? "Used as this stationary spawn's idle direction."
      : 'Set wander range to 0 for this to remain visible after spawn.'
    root.innerHTML = `
      <label style="font-size:11px;color:rgba(255,255,255,0.45);">Name (override)</label>
      <input id="spawnNameInput" type="text" value="${nameValue.replace(/"/g, '&quot;')}" placeholder="${defName.replace(/"/g, '&quot;') || 'defaults to NPC type name'}" style="width:100%;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:4px 5px;font-size:11px;margin-top:3px;" ${spawn ? '' : 'disabled'} />
      <div class="hint" style="margin-top:2px;font-size:10px;color:rgba(255,255,255,0.35);">This renames only this placed spawn. Use "Create new NPC type" before editing name, stats, drops, shop, or dialogue for a new mob.</div>
      <label style="margin-top:10px;font-size:11px;color:rgba(255,255,255,0.45);">Position</label>
      <div style="display:flex;gap:5px;margin-top:3px;">
        <div style="flex:1;">
          <div style="font-size:10px;color:rgba(255,255,255,0.45);">X</div>
          <input id="spawnXInput" type="number" step="0.5" value="${posX.toFixed(1)}" style="width:100%;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" ${spawn ? '' : 'disabled'} />
        </div>
        <div style="flex:1;">
          <div style="font-size:10px;color:rgba(255,255,255,0.45);">Z</div>
          <input id="spawnZInput" type="number" step="0.5" value="${posZ.toFixed(1)}" style="width:100%;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" ${spawn ? '' : 'disabled'} />
        </div>
      </div>
      <label style="margin-top:10px;font-size:11px;color:rgba(255,255,255,0.45);">Visual Scale <span id="npcScaleLabel">${formatNpcScale(visualScale)}</span></label>
      <input id="npcScaleSlider" type="range" min="0.25" max="4" step="0.05" value="${visualScale}" style="width:100%;margin-top:3px;" ${spawn ? '' : 'disabled'} />
      <div style="display:flex;gap:5px;margin-top:3px;">
        <input id="npcScaleInput" type="number" min="0.1" max="8" step="0.05" value="${visualScale.toFixed(2)}" style="flex:1;min-width:0;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" ${spawn ? '' : 'disabled'} />
        <button id="npcScaleResetBtn" type="button" style="flex:0 0 auto;font-size:10px;padding:3px 7px;background:#262626;color:#ddd;border:1px solid #555;border-radius:3px;cursor:pointer;" ${spawn ? '' : 'disabled'}>Reset</button>
      </div>
      <label style="margin-top:10px;font-size:11px;color:rgba(255,255,255,0.45);">Wander Range <span id="wanderRangeLabel">${wander}</span></label>
      <input id="wanderRangeSlider" type="range" min="0" max="15" step="1" value="${wander}" style="width:100%;margin-top:3px;" ${spawn ? '' : 'disabled'} />
      <label style="margin-top:10px;font-size:11px;color:rgba(255,255,255,0.45);">Facing <span id="npcFacingLabel">${facingLabel}</span></label>
      <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:3px;margin-top:4px;">
        <button type="button" data-facing-deg="180" style="font-size:10px;padding:4px;background:#262626;color:#ddd;border:1px solid #555;border-radius:3px;cursor:pointer;" ${spawn ? '' : 'disabled'}>N</button>
        <button type="button" data-facing-deg="90" style="font-size:10px;padding:4px;background:#262626;color:#ddd;border:1px solid #555;border-radius:3px;cursor:pointer;" ${spawn ? '' : 'disabled'}>E</button>
        <button type="button" data-facing-deg="0" style="font-size:10px;padding:4px;background:#262626;color:#ddd;border:1px solid #555;border-radius:3px;cursor:pointer;" ${spawn ? '' : 'disabled'}>S</button>
        <button type="button" data-facing-deg="-90" style="font-size:10px;padding:4px;background:#262626;color:#ddd;border:1px solid #555;border-radius:3px;cursor:pointer;" ${spawn ? '' : 'disabled'}>W</button>
      </div>
      <input id="npcFacingSlider" type="range" min="-180" max="180" step="15" value="${facingDeg}" style="width:100%;margin-top:5px;" ${spawn ? '' : 'disabled'} />
      <div class="hint" style="margin-top:2px;font-size:10px;color:rgba(255,255,255,0.35);">${facingHint}</div>
      <label style="margin-top:8px;font-size:11px;color:rgba(255,255,255,0.45);display:flex;align-items:center;gap:6px;cursor:pointer;">
        <input id="aggressiveCheckbox" type="checkbox" ${aggressiveEffective ? 'checked' : ''} ${spawn ? '' : 'disabled'} />
        Aggressive (per-spawn override)
      </label>
      <label style="margin-top:10px;font-size:11px;color:rgba(255,255,255,0.45);">Attack animation</label>
      <select id="spawnAttackAnimSelect" style="width:100%;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:4px 5px;font-size:11px;margin-top:3px;" ${spawn ? '' : 'disabled'}>
        <option value="" ${curAnim ? '' : 'selected'}>(weapon-driven)</option>
        ${animOptions}
      </select>
      <div class="hint" style="margin-top:2px;font-size:10px;color:rgba(255,255,255,0.35);">Forces a swing animation regardless of equipped weapon. Combat NPCs only.</div>
      <button id="basicGuardPresetBtn" style="width:100%;margin-top:10px;font-size:11px;padding:5px;background:#2f3d33;color:#fff;cursor:pointer;border:1px solid #4c6a52;border-radius:3px;" ${spawn ? '' : 'disabled'}>Make basic guard</button>
      <div class="hint" style="margin-top:4px;font-size:10px;color:rgba(255,255,255,0.35);">${spawn ? 'Selected spawn' : 'No spawn selected'}</div>
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
    const writeScale = (raw, { rebuild = true } = {}) => {
      if (!selectedNpcSpawn) return
      const scale = setNpcSpawnScale(selectedNpcSpawn, raw)
      const label = root.querySelector('#npcScaleLabel')
      if (label) label.textContent = formatNpcScale(scale)
      const slider = root.querySelector('#npcScaleSlider')
      if (slider) slider.value = String(Math.max(0.25, Math.min(4, scale)))
      const input = root.querySelector('#npcScaleInput')
      if (input) input.value = scale.toFixed(2)
      if (rebuild) rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
      updateNpcPlacementControls()
    }
    const scaleSlider = root.querySelector('#npcScaleSlider')
    scaleSlider?.addEventListener('input', (e) => writeScale(e.target.value, { rebuild: false }))
    scaleSlider?.addEventListener('change', (e) => writeScale(e.target.value, { rebuild: true }))
    root.querySelector('#npcScaleInput')?.addEventListener('change', (e) => writeScale(e.target.value))
    root.querySelector('#npcScaleResetBtn')?.addEventListener('click', () => writeScale(1))
    const writeFacingDeg = (deg) => {
      if (!selectedNpcSpawn) return
      selectedNpcSpawn.facing = npcFacingFromDeg(deg)
      const label = root.querySelector('#npcFacingLabel')
      if (label) label.textContent = formatNpcFacing(selectedNpcSpawn.facing)
      const slider = root.querySelector('#npcFacingSlider')
      if (slider) slider.value = String(npcFacingDeg(selectedNpcSpawn))
      ensureNpcPreview(selectedNpcSpawn)
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
      updateNpcPlacementControls()
    }
    root.querySelector('#npcFacingSlider')?.addEventListener('input', (e) => writeFacingDeg(e.target.value))
    for (const btn of root.querySelectorAll('[data-facing-deg]')) {
      btn.addEventListener('click', () => writeFacingDeg(btn.dataset.facingDeg))
    }
    root.querySelector('#aggressiveCheckbox')?.addEventListener('change', (e) => {
      if (selectedNpcSpawn) {
        selectedNpcSpawn.aggressive = e.target.checked
        refreshNpcSpawnList()
      }
    })
    root.querySelector('#spawnAttackAnimSelect')?.addEventListener('change', (e) => {
      if (selectedNpcSpawn) {
        const v = e.target.value
        if (v) selectedNpcSpawn.attackAnim = v
        else delete selectedNpcSpawn.attackAnim
      }
    })
    // Position inputs — `change` (not `input`) fires on blur/Enter only, so the
    // expensive rebuildNpcSpawnMeshes runs once per edit instead of every keystroke.
    const updatePosition = (axis, raw) => {
      if (!selectedNpcSpawn) return
      const v = parseFloat(raw)
      if (!Number.isFinite(v)) return
      selectedNpcSpawn[axis] = v
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
    }
    root.querySelector('#spawnXInput')?.addEventListener('change', (e) => updatePosition('x', e.target.value))
    root.querySelector('#spawnZInput')?.addEventListener('change', (e) => updatePosition('z', e.target.value))
    root.querySelector('#basicGuardPresetBtn')?.addEventListener('click', () => applyBasicGuardPreset())
  }

  /** Combat-stat keys eligible for per-spawn override. Matches the
   *  NpcStatOverrides shape in shared/types.ts. wanderRange is intentionally
   *  out because it already has its own per-spawn field on the Spawn tab. */
  const NPC_ATTACK_STYLES = ['stab', 'slash', 'crush']
  const NPC_NUMERIC_STAT_FIELDS = [
    ['health', 'Health'],
    ['attack', 'Attack level'],
    ['strength', 'Strength level'],
    ['defence', 'Defence level'],
    ['combatLevel', 'Combat level override'],
    ['attackBonus', 'Attack bonus'],
    ['strengthBonus', 'Strength bonus'],
    ['stabDefence', 'Stab defence'],
    ['slashDefence', 'Slash defence'],
    ['crushDefence', 'Crush defence'],
    ['rangedDefence', 'Ranged defence'],
    ['magicDefence', 'Magic defence'],
    ['attackSpeed', 'Attack speed (ticks)'],
    ['respawnTime', 'Respawn time (ticks)'],
  ]
  const NPC_OPTIONAL_NUMERIC_STATS = new Set([
    'combatLevel', 'attackBonus', 'strengthBonus', 'stabDefence', 'slashDefence',
    'crushDefence', 'rangedDefence', 'magicDefence',
  ])
  const SPAWN_NUMERIC_STAT_KEYS = NPC_NUMERIC_STAT_FIELDS.map(([key]) => key)
  const NPC_STARTER_RECOMMENDATIONS = {
    1: {
      source: '2004Scape chicken',
      fields: { health: 3, attack: 1, strength: 1, defence: 1, combatLevel: 1, attackBonus: -47, strengthBonus: -42, stabDefence: -42, slashDefence: -42, crushDefence: -42, rangedDefence: -42, magicDefence: -42, attackStyle: 'stab', attackSpeed: 4 },
    },
    18: {
      source: '2004Scape rat',
      fields: { health: 2, attack: 1, strength: 1, defence: 1, combatLevel: 1, attackBonus: -47, strengthBonus: -53, stabDefence: -42, slashDefence: -42, crushDefence: -42, rangedDefence: -42, magicDefence: -42, attackStyle: 'crush', attackSpeed: 4 },
    },
    6: {
      source: '2004Scape spider',
      fields: { health: 2, attack: 1, strength: 1, defence: 1, combatLevel: 1, attackBonus: -35, strengthBonus: -58, stabDefence: -53, slashDefence: -53, crushDefence: -53, rangedDefence: -53, magicDefence: -53, attackStyle: 'stab', attackSpeed: 4 },
    },
    10: {
      source: '2004Scape cow',
      fields: { health: 8, attack: 1, strength: 1, defence: 1, combatLevel: 2, attackBonus: -15, strengthBonus: -15, stabDefence: -21, slashDefence: -21, crushDefence: -21, rangedDefence: -21, magicDefence: -21, attackStyle: 'crush', attackSpeed: 4 },
    },
    3: {
      source: '2004Scape basic goblin',
      fields: { health: 5, attack: 1, strength: 1, defence: 1, combatLevel: 2, attackBonus: -21, strengthBonus: -15, stabDefence: -15, slashDefence: -15, crushDefence: -15, rangedDefence: -15, magicDefence: -15, attackStyle: 'crush', attackSpeed: 4 },
    },
    20: {
      source: '2004Scape farmer',
      fields: { health: 12, attack: 3, strength: 4, defence: 8, combatLevel: 7, attackBonus: 5, strengthBonus: 6, attackStyle: 'stab', attackSpeed: 6 },
    },
    7: {
      source: '2004Scape guard',
      fields: { health: 22, attack: 19, strength: 18, defence: 14, combatLevel: 21, attackBonus: 4, strengthBonus: 5, stabDefence: 18, slashDefence: 25, crushDefence: 19, rangedDefence: 20, magicDefence: -4, attackStyle: 'stab', attackSpeed: 4 },
    },
    5: {
      source: '2004Scape skeleton',
      fields: { health: 24, attack: 17, strength: 17, defence: 17, combatLevel: 18, stabDefence: 5, slashDefence: 5, crushDefence: -5, rangedDefence: 5, attackStyle: 'crush', attackSpeed: 4 },
    },
    25: {
      source: '2004Scape brown bear',
      fields: { health: 27, attack: 17, strength: 18, defence: 15, combatLevel: 21, attackStyle: 'slash', attackSpeed: 4 },
    },
  }

  function effectiveNpcEditorStats(def, overrides = null) {
    const combat = effectiveNpcCombatStats(def, overrides)
    const attackSpeed = Number(overrides?.attackSpeed ?? def.attackSpeed)
    return {
      ...combat,
      attackSpeed: Number.isFinite(attackSpeed) && attackSpeed > 0 ? Math.floor(attackSpeed) : 4,
    }
  }

  function formatStatNumber(value, digits = 2) {
    if (!Number.isFinite(value)) return '0'
    if (Number.isInteger(value)) return String(value)
    return value.toFixed(digits).replace(/\.?0+$/, '')
  }

  function roughNpcDpsEstimate(stats) {
    const summary = npcCombatSummary(stats)
    const playerDefenceRoll = (1 + 8) * ACC_BASE
    const hitChance = calculateHitChance(summary.attackRoll, playerDefenceRoll)
    const avgDamage = summary.maxHit / 2
    const interval = Math.max(1, stats.attackSpeed) * 0.6
    return {
      dps: hitChance * avgDamage / interval,
      hitChance,
      maxHit: summary.maxHit,
    }
  }

  function roughPlayerDpsEstimate(stats) {
    const attackRoll = (1 + 3 + 8) * ACC_BASE
    const defenceRoll = npcMeleeDefenceRoll(stats, 'crush')
    const hitChance = calculateHitChance(attackRoll, defenceRoll)
    const maxHit = osrsMeleeMaxHit(1 + 8, 0)
    const dps = hitChance * (maxHit / 2) / (4 * 0.6)
    return {
      dps,
      hitChance,
      ttk: dps > 0 ? stats.health / dps : Infinity,
    }
  }

  function formatRecommendationFields(fields) {
    const bonuses = [
      ['attackBonus', 'AtkB'],
      ['strengthBonus', 'StrB'],
      ['stabDefence', 'StabD'],
      ['slashDefence', 'SlashD'],
      ['crushDefence', 'CrushD'],
      ['rangedDefence', 'RangeD'],
      ['magicDefence', 'MagicD'],
    ]
      .filter(([key]) => fields[key] !== undefined)
      .map(([key, label]) => `${label} ${fields[key]}`)
      .join(', ')
    return [
      `L${fields.combatLevel ?? 'auto'} HP ${fields.health}`,
      `A/S/D ${fields.attack}/${fields.strength}/${fields.defence}`,
      `style ${fields.attackStyle ?? 'average'}`,
      `speed ${fields.attackSpeed ?? 4}`,
      bonuses,
    ].filter(Boolean).join(' | ')
  }

  function applyNpcStatRecommendation(target, fields) {
    for (const key of SPAWN_NUMERIC_STAT_KEYS) {
      if (fields[key] !== undefined) target[key] = fields[key]
      else if (NPC_OPTIONAL_NUMERIC_STATS.has(key)) delete target[key]
    }
    if (fields.attackStyle) target.attackStyle = fields.attackStyle
    else delete target.attackStyle
  }

  function selectedOrCurrentNpcDef() {
    const selectedDef = findSelectedDef()
    if (selectedDef) return selectedDef
    const selectedId = parseInt(sidebar.querySelector('#npcTypeSelect')?.value || '0')
    return npcDefById(selectedId)
  }

  function nextNpcDefId() {
    let nextId = 100
    const taken = new Set(npcDefs.map(d => d.id))
    while (taken.has(nextId)) nextId++
    return nextId
  }

  /** Fork the given NpcDef into a brand-new id and swap the selected spawn
   *  to it. Mutating the original def directly is the easy way to lose a
   *  baseline (e.g. renaming "Custom Humanoid" to "Vampire" wipes the
   *  template). This button lets users branch first, customize after.
   *
   *  Picks the next unused integer id ≥ 100 so user-authored mobs don't
   *  collide with the hand-curated ids in the 1..21 range.
   */
  function duplicateNpcDef(srcDef, options = {}) {
    if (!srcDef) return null
    const clone = structuredClone(srcDef)
    clone.id = nextNpcDefId()
    clone.name = options.name || `${srcDef.name || 'NPC'} variant`
    const sourceModelId = Number.isInteger(options.modelNpcId) && options.modelNpcId > 0
      ? options.modelNpcId
      : resolveNpcModelSourceId(srcDef.id, srcDef)
    if (sourceModelId > 0) clone.modelNpcId = sourceModelId

    if (options.applySpawnOverrides && selectedNpcSpawn?.npcId === srcDef.id) {
      if (selectedNpcSpawn.stats) {
        for (const key of SPAWN_NUMERIC_STAT_KEYS) {
          const value = selectedNpcSpawn.stats[key]
          if (Number.isFinite(value)) clone[key] = value
        }
        const attackStyle = selectedNpcSpawn.stats.attackStyle
        if (NPC_ATTACK_STYLES.includes(attackStyle)) clone.attackStyle = attackStyle
      }
      if (!options.name && selectedNpcSpawn.name) clone.name = selectedNpcSpawn.name
    }

    npcDefs.push(clone)
    unlockedSharedNpcDefIds.add(clone.id)
    populateNpcTypeControls(npcDefs)

    const sel = sidebar.querySelector('#npcTypeSelect')
    if (sel) sel.value = clone.id

    // Switch the selected spawn to the new def so the inspector retargets.
    if (selectedNpcSpawn && options.switchSelectedSpawn !== false) {
      pushUndoState('spawns')
      selectedNpcSpawn.npcId = clone.id
      if (options.consumeSpawnOverrides) {
        delete selectedNpcSpawn.name
        delete selectedNpcSpawn.stats
      }
      rebuildNpcSpawnMeshes()
      refreshNpcSpawnList()
    }
    markDefsDirty()
    syncNpcTypeInput()
    return clone
  }

  function createNpcVariantFromCurrentType() {
    const srcDef = selectedOrCurrentNpcDef()
    if (!srcDef) return
    const retargetsSelectedSpawn = !!selectedNpcSpawn
    const defaultName = selectedNpcSpawn?.name || `${srcDef.name || 'NPC'} variant`
    const rawName = window.prompt('New NPC type name', defaultName)
    if (rawName == null) return
    const name = rawName.trim()
    if (!name) {
      window.alert('Enter a name for the new NPC type.')
      return
    }
    const newDef = duplicateNpcDef(srcDef, {
      name,
      applySpawnOverrides: true,
      consumeSpawnOverrides: true,
    })
    if (!newDef) return
    const saveHint = retargetsSelectedSpawn
      ? 'Use Save NPC defs for the new type, then Save Server for the selected spawn.'
      : 'Use Save NPC defs to persist the new type.'
    showEditorNotice(`Created NPC type #${newDef.id}: ${newDef.name}\nDuplicate display names are allowed; use the ID to pick the right variant.\nModel source: ${npcTypeModelLabel(newDef)}\n${saveHint}`, 'success', 7000)
    renderNpcInspector()
    updateNpcPlacementControls()
  }

  function renderStatsTab(root, def) {
    root.innerHTML = ''
    const spawn = selectedNpcSpawn
    if (!def) {
      root.innerHTML = `<div class="hint">Select an NPC spawn (or pick a type) to edit stats.</div>`
      return
    }
    // Mode toggle: edit the def (affects every spawn) or this spawn's stats
    // override (one placement only). Mirrors the Shop / Dialogue tabs.
    const overrideActive = !!(spawn && spawn.stats)
    appendOverrideModeToggle(root, {
      overrideActive,
      hasSpawn: !!spawn,
      onSelectDef: () => {
        if (spawn?.stats) {
          pushUndoState('spawns')
          delete spawn.stats
        }
        renderStatsTab(root, def)
        refreshNpcSpawnList()
      },
      onSelectOverride: () => {
        if (spawn && !spawn.stats) {
          pushUndoState('spawns')
          spawn.stats = {}
        }
        renderStatsTab(root, def)
        refreshNpcSpawnList()
      },
    })

    const combatLevelReadout = document.createElement('div')
    combatLevelReadout.style.cssText = 'font-size:11px;color:#ffcc66;margin:0 0 8px;padding:5px 6px;background:#241f14;border:1px solid #4a3820;border-radius:3px;'
    const dpsReadout = document.createElement('div')
    dpsReadout.style.cssText = 'font-size:11px;color:#d7e6ff;margin:0 0 8px;padding:5px 6px;background:#162033;border:1px solid #2c4569;border-radius:3px;line-height:1.4;'
    const refreshCombatLevelReadout = () => {
      const stats = effectiveNpcEditorStats(def, spawn?.stats)
      const summary = npcCombatSummary(stats)
      const npcDps = roughNpcDpsEstimate(stats)
      const playerDps = roughPlayerDpsEstimate(stats)
      combatLevelReadout.textContent = `Combat ${summary.combatLevel} | Max hit ${summary.maxHit} | Attack roll ${summary.attackRoll} | Def S/L/C/R/M ${summary.stabDefenceRoll}/${summary.slashDefenceRoll}/${summary.crushDefenceRoll}/${summary.rangedDefenceRoll}/${summary.magicDefenceRoll}`
      dpsReadout.textContent = `Rough DPS: NPC ${formatStatNumber(npcDps.dps, 3)} (${Math.round(npcDps.hitChance * 100)}% hit, max ${npcDps.maxHit}) | L1 unarmed player ${formatStatNumber(playerDps.dps, 3)} (${Math.round(playerDps.hitChance * 100)}% hit, TTK ${Number.isFinite(playerDps.ttk) ? `${formatStatNumber(playerDps.ttk, 1)}s` : 'never'})`
    }
    refreshCombatLevelReadout()
    root.appendChild(combatLevelReadout)
    root.appendChild(dpsReadout)

    if (!overrideActive && !appendNpcSharedEditGate(root, def, 'Stats edits')) {
      return
    }

    const recommendation = NPC_STARTER_RECOMMENDATIONS[def.id]
    if (recommendation) {
      const rec = document.createElement('div')
      rec.style.cssText = 'font-size:11px;color:#dff7d6;margin:0 0 8px;padding:6px;background:#162816;border:1px solid #365b35;border-radius:3px;line-height:1.35;'
      rec.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <b style="color:#a8e28e;flex:1;">Recommendation: ${recommendation.source}</b>
          <button id="applyNpcStatRecommendationBtn" style="font-size:10px;padding:3px 6px;background:#29421f;color:#fff;border:1px solid #4f7c3e;border-radius:3px;cursor:pointer;">Apply</button>
        </div>
        <div>${formatRecommendationFields(recommendation.fields)}</div>
      `
      root.appendChild(rec)
      rec.querySelector('#applyNpcStatRecommendationBtn')?.addEventListener('click', () => {
        if (overrideActive) pushUndoState('spawns')
        const target = overrideActive ? (spawn.stats ||= {}) : def
        applyNpcStatRecommendation(target, recommendation.fields)
        if (!overrideActive) {
          markDefsDirty()
          const sel = sidebar.querySelector('#npcTypeSelect')
          if (sel) {
            for (const opt of sel.options) {
              if (parseInt(opt.value) === def.id) {
                opt.textContent = formatNpcTypeOptionLabel(def)
                break
              }
            }
          }
          updateNpcPlacementControls()
          syncNpcTypeInput()
        }
        refreshNpcSpawnList()
        renderStatsTab(root, def)
      })
    }

    if (overrideActive) {
      // Per-spawn override editor. Each row: label, the override input (blank
      // = inherit from def), and a small "× clear" button.
      const banner = document.createElement('div')
      banner.style.cssText = 'font-size:10px;color:#44ccff;margin-bottom:6px;'
      banner.textContent = `Override for this spawn — leave a field blank to inherit "${def.name}".`
      root.appendChild(banner)
      for (const [key, label] of NPC_NUMERIC_STAT_FIELDS) {
        const row = document.createElement('div')
        row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;'
        const cur = spawn.stats[key]
        const placeholder = def[key] ?? (NPC_OPTIONAL_NUMERIC_STATS.has(key) ? 'auto' : 0)
        row.innerHTML = `
          <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">${label}</span>
          <input type="number" step="1" value="${cur ?? ''}" placeholder="${placeholder}"
                 style="width:70px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
          <button title="Inherit from def" style="font-size:10px;padding:2px 6px;background:#2a2a2a;color:#aaa;border:1px solid #444;border-radius:3px;cursor:pointer;">×</button>
        `
        const input = row.querySelector('input')
        let capturedUndo = false
        const captureUndo = () => {
          if (capturedUndo) return
          pushUndoState('spawns')
          capturedUndo = true
        }
        input.addEventListener('input', () => {
          captureUndo()
          const v = input.value.trim()
          if (v === '') delete spawn.stats[key]
          else spawn.stats[key] = parseFloat(v) || 0
          refreshCombatLevelReadout()
          refreshNpcSpawnList()
        })
        input.addEventListener('blur', () => {
          capturedUndo = false
        })
        row.querySelector('button').addEventListener('click', () => {
          pushUndoState('spawns')
          delete spawn.stats[key]
          input.value = ''
          refreshCombatLevelReadout()
          refreshNpcSpawnList()
        })
        root.appendChild(row)
      }
      const styleRow = document.createElement('div')
      styleRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;'
      const curStyle = spawn.stats.attackStyle ?? ''
      styleRow.innerHTML = `
        <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">Attack style</span>
        <select style="width:90px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;">
          <option value="">inherit (${def.attackStyle || 'average'})</option>
          ${NPC_ATTACK_STYLES.map(style => `<option value="${style}" ${curStyle === style ? 'selected' : ''}>${style}</option>`).join('')}
        </select>
        <button title="Inherit from def" style="font-size:10px;padding:2px 6px;background:#2a2a2a;color:#aaa;border:1px solid #444;border-radius:3px;cursor:pointer;">×</button>
      `
      const select = styleRow.querySelector('select')
      select.addEventListener('change', () => {
        pushUndoState('spawns')
        if (!select.value) delete spawn.stats.attackStyle
        else spawn.stats.attackStyle = select.value
        refreshCombatLevelReadout()
        refreshNpcSpawnList()
      })
      styleRow.querySelector('button').addEventListener('click', () => {
        pushUndoState('spawns')
        delete spawn.stats.attackStyle
        select.value = ''
        refreshCombatLevelReadout()
        refreshNpcSpawnList()
      })
      root.appendChild(styleRow)
      return
    }

    // Shared-def editor (original behavior).
    const numField = (key, label, step = 1) => `
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">${label}</span>
        <input data-def-key="${key}" type="number" step="${step}" value="${def[key] ?? ''}" placeholder="${NPC_OPTIONAL_NUMERIC_STATS.has(key) ? 'auto' : '0'}"
               style="width:70px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
      </div>
    `
    const attackStyleOptions = [''].concat(NPC_ATTACK_STYLES)
      .map(style => `<option value="${style}" ${def.attackStyle === style || (!style && !def.attackStyle) ? 'selected' : ''}>${style || 'average melee defence'}</option>`)
      .join('')
    const shared = document.createElement('div')
    shared.innerHTML = `
      <div style="font-size:10px;color:#ffaa44;margin-bottom:6px;">Editing shared NPC type #${def.id} — affects every spawn of "${def.name}". For a new mob, create a new NPC type first.</div>
      <button id="duplicateNpcDefBtn" style="width:100%;margin-bottom:8px;font-size:11px;padding:5px;background:#34465d;color:#fff;cursor:pointer;border:1px solid #617891;border-radius:3px;" title="Creates a new reusable NPC type with its own name, stats, drops, shop, and dialogue while reusing this model.">Create new NPC type from this</button>
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">Name</span>
        <input data-def-key="name" type="text" value="${def.name ?? ''}" style="width:140px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
      </div>
      ${NPC_NUMERIC_STAT_FIELDS.map(([key, label]) => numField(key, label)).join('')}
      <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
        <span style="flex:1;font-size:11px;color:rgba(255,255,255,0.65);">Attack style</span>
        <select data-def-key="attackStyle" style="width:140px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;">${attackStyleOptions}</select>
      </div>
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
    root.appendChild(shared)
    shared.querySelector('#duplicateNpcDefBtn')?.addEventListener('click', createNpcVariantFromCurrentType)
    for (const input of shared.querySelectorAll('[data-def-key]')) {
      // 'input' fires every keystroke; 'change' only fires on blur for
      // number/text. Using 'input' makes the Save NPC defs button light up
      // the moment the user starts typing so it's obvious there are unsaved
      // changes. Checkboxes only fire 'change' (no 'input'), so listen to
      // both — 'change' covers checkbox; 'input' covers everything else.
      const evt = input.type === 'checkbox' || input.tagName === 'SELECT' ? 'change' : 'input'
      input.addEventListener(evt, () => {
        const key = input.dataset.defKey
        if (input.type === 'checkbox') {
          def[key] = input.checked
        } else if (input.type === 'number') {
          const raw = input.value.trim()
          if (raw === '' && NPC_OPTIONAL_NUMERIC_STATS.has(key)) delete def[key]
          else def[key] = parseFloat(raw) || 0
        } else if (input.tagName === 'SELECT' && key === 'attackStyle') {
          if (input.value) def[key] = input.value
          else delete def[key]
        } else {
          def[key] = input.value
        }
        refreshCombatLevelReadout()
        markDefsDirty()
        const sel = sidebar.querySelector('#npcTypeSelect')
        if (sel) {
          for (const opt of sel.options) {
            if (parseInt(opt.value) === def.id) {
              opt.textContent = formatNpcTypeOptionLabel(def)
              break
            }
          }
        }
        refreshNpcSpawnList()
        updateNpcPlacementControls()
        syncNpcTypeInput()
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

  /** Build a "Custom RGB" picker row paired with a palette swatch row.
   *  When spawn.customColors[slot] is set, it takes precedence over the
   *  palette index in CharacterEntity.applyAppearance. `slot` is an
   *  AppearanceColorSlot key (e.g. 'shirtColor') — same indexer as the
   *  appearance struct itself. */
  function customRgbRow(spawn, slot) {
    const wrap = document.createElement('div')
    wrap.style.cssText = 'display:flex;align-items:center;gap:6px;margin:-2px 0 6px 0;'
    const cur = spawn.customColors?.[slot]
    const hex = cur
      ? `#${[cur[0], cur[1], cur[2]].map(v => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')).join('')}`
      : '#888888'
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = !!cur
    cb.title = 'Custom RGB overrides the palette pick'
    const picker = document.createElement('input')
    picker.type = 'color'
    picker.value = hex
    picker.disabled = !cb.checked
    picker.style.cssText = 'width:32px;height:18px;padding:0;border:1px solid #444;background:transparent;cursor:pointer;'
    const lbl = document.createElement('span')
    lbl.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.55);'
    lbl.textContent = 'Custom RGB'
    wrap.appendChild(cb)
    wrap.appendChild(picker)
    wrap.appendChild(lbl)

    const writeFromPicker = () => {
      const h = picker.value.replace('#', '')
      const r = parseInt(h.slice(0, 2), 16) / 255
      const g = parseInt(h.slice(2, 4), 16) / 255
      const b = parseInt(h.slice(4, 6), 16) / 255
      if (!spawn.customColors) spawn.customColors = {}
      spawn.customColors[slot] = [r, g, b]
      ensureNpcPreview(spawn)
    }
    cb.addEventListener('change', () => {
      picker.disabled = !cb.checked
      if (cb.checked) {
        writeFromPicker()
      } else if (spawn.customColors) {
        delete spawn.customColors[slot]
        // Strip empty objects so they don't bloat the saved JSON.
        if (Object.keys(spawn.customColors).length === 0) delete spawn.customColors
        ensureNpcPreview(spawn)
      }
    })
    picker.addEventListener('input', () => {
      if (cb.checked) writeFromPicker()
    })
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
        // Custom RGB only makes sense alongside the palette appearance; drop
        // it so we don't leak a colors object onto a spawn with no rig override.
        delete spawn.customColors
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
    spawn.appearance = normalizeAppearance(spawn.appearance)
    // Persist the swatch pick and rebuild the row so the selected highlight moves.
    const setField = (field, value) => {
      spawn.appearance[field] = value
      spawn.appearance = normalizeAppearance(spawn.appearance)
      ensureNpcPreview(spawn)
      renderAppearanceTab(root)
      refreshNpcSpawnList()
    }
    const bodyWrap = document.createElement('label')
    bodyWrap.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;font-size:11px;color:rgba(255,255,255,0.65);'
    bodyWrap.innerHTML = `
      <span>Body</span>
      <select style="flex:1;background:#121212;color:#ddd;border:1px solid #333;border-radius:3px;padding:3px 5px;font-size:11px;">
        ${BODY_TYPE_NAMES.map((name, idx) => `<option value="${idx}"${idx === spawn.appearance.bodyType ? ' selected' : ''}>${name}</option>`).join('')}
      </select>
    `
    bodyWrap.querySelector('select').addEventListener('change', (e) => setField('bodyType', parseInt(e.target.value)))
    root.appendChild(bodyWrap)
    // Each row: palette swatches + a Custom RGB row beneath. Custom RGB,
    // when toggled on, wins over the palette pick in CharacterEntity.applyAppearance.
    root.appendChild(appearanceSwatchRow('Skin', SKIN_COLORS, spawn.appearance.skinColor, v => setField('skinColor', v)))
    root.appendChild(customRgbRow(spawn, 'skinColor'))
    root.appendChild(appearanceSwatchRow('Shirt', SHIRT_COLORS, spawn.appearance.shirtColor, v => setField('shirtColor', v)))
    root.appendChild(customRgbRow(spawn, 'shirtColor'))
    root.appendChild(appearanceSwatchRow('Pants', PANTS_COLORS, spawn.appearance.pantsColor, v => setField('pantsColor', v)))
    root.appendChild(customRgbRow(spawn, 'pantsColor'))
    root.appendChild(appearanceSwatchRow('Shoes', SHOES_COLORS, spawn.appearance.shoesColor, v => setField('shoesColor', v)))
    root.appendChild(customRgbRow(spawn, 'shoesColor'))
    root.appendChild(appearanceSwatchRow('Belt', BELT_COLORS, spawn.appearance.beltColor, v => setField('beltColor', v)))
    root.appendChild(customRgbRow(spawn, 'beltColor'))
    root.appendChild(appearanceSwatchRow('Hair color', HAIR_COLORS, spawn.appearance.hairColor, v => setField('hairColor', v)))
    root.appendChild(customRgbRow(spawn, 'hairColor'))
    // Hair style is just an index into the body-type's allowed hair choices.
    const hairChoices = hairStyleChoicesForBodyType(spawn.appearance.bodyType)
    const hairMin = Math.min(...hairChoices)
    const hairMax = Math.max(...hairChoices)
    const hairWrap = document.createElement('div')
    hairWrap.style.cssText = 'margin-bottom:6px;'
    hairWrap.innerHTML = `
      <div style="font-size:11px;color:rgba(255,255,255,0.65);margin-bottom:3px;">Hair style <span style="opacity:0.5;">${spawn.appearance.hairStyle}</span></div>
      <input type="range" min="${hairMin}" max="${hairMax}" step="1" value="${spawn.appearance.hairStyle}" style="width:100%;" />
    `
    hairWrap.querySelector('input').addEventListener('input', (e) => {
      const value = parseInt(e.target.value)
      spawn.appearance.hairStyle = hairChoices.includes(value) ? value : hairChoices[0]
      e.currentTarget.previousElementSibling.querySelector('span').textContent = spawn.appearance.hairStyle
      spawn.appearance = normalizeAppearance(spawn.appearance)
      ensureNpcPreview(spawn)
    })
    root.appendChild(hairWrap)
  }

  /** PLAYER_REMOTE_EQUIPMENT layout (index → equipSlot). Grouped for visual
   *  hierarchy in the Gear tab. `groupLabel` collapses adjacent rows with the
   *  same group into a single section header. */
  const EQUIP_SLOTS = [
    { label: 'Weapon', slot: 'weapon', group: 'Weapons' },
    { label: 'Shield', slot: 'shield', group: 'Weapons' },
    { label: 'Head',   slot: 'head',   group: 'Armor'   },
    { label: 'Body',   slot: 'body',   group: 'Armor'   },
    { label: 'Legs',   slot: 'legs',   group: 'Armor'   },
    { label: 'Hands',  slot: 'hands',  group: 'Armor'   },
    { label: 'Feet',   slot: 'feet',   group: 'Armor'   },
    { label: 'Neck',   slot: 'neck',   group: 'Accessories' },
    { label: 'Ring',   slot: 'ring',   group: 'Accessories' },
    { label: 'Cape',   slot: 'cape',   group: 'Accessories' },
  ]

  /** Build (or rebuild if stale) a per-slot datalist filtered to items whose
   *  ItemDef.equipSlot matches. Reuses the same pattern as
   *  `ensureShopItemDatalist` but ten datalists instead of one — so each
   *  slot's typeahead only suggests items the slot can actually wear.
   *  Idempotent: skips work when the count matches. */
  function ensureEquipItemDatalists() {
    for (const { slot } of EQUIP_SLOTS) {
      const id = `equipItemDatalist_${slot}`
      const matches = itemDefs.filter(d => d.equipSlot === slot)
      let dl = document.getElementById(id)
      if (dl && dl.childElementCount === matches.length) continue
      if (!dl) {
        dl = document.createElement('datalist')
        dl.id = id
        document.body.appendChild(dl)
      }
      dl.innerHTML = ''
      const sorted = [...matches].sort((a, b) => (a.name || '').localeCompare(b.name || ''))
      for (const d of sorted) {
        const opt = document.createElement('option')
        opt.value = `${d.name} (${d.id})`
        dl.appendChild(opt)
      }
    }
  }

  /** Refresh the editor preview's gear after the user edits a slot. Only
   *  re-applies gear if the preview entity already exists. Humanoid previews
   *  use CharacterEntity gear; purpose-built NPC models use their configured
   *  model-bone attachment slots. */
  function refreshNpcPreviewGear(spawn, reloadSlot = null) {
    const entry = npcPreviews.get(spawn?.id)
    if (!entry) return
    if (reloadSlot) {
      entry.entity.detachGear?.(reloadSlot)
      entry.entity.detachSkinnedArmor?.(reloadSlot)
    }
    entry.entity.whenReady().then(() => {
      if (npcPreviews.get(spawn.id) !== entry) return
      void applyEquipmentToPreview(spawn, entry)
    })
  }

  function applyBasicGuardPreset(spawn = selectedNpcSpawn) {
    if (!spawn) return
    pushUndoState('npc guard preset')
    const guardDef = npcDefs.find(d => d.name === 'Guard') || npcDefs.find(d => d.id === 7)
    if (guardDef) spawn.npcId = guardDef.id
    delete spawn.name
    spawn.aggressive = false
    spawn.wanderRange = spawn.wanderRange ?? guardDef?.wanderRange ?? 2
    spawn.appearance = { ...DEFAULT_APPEARANCE, hairStyle: 1 }
    // PLAYER_REMOTE_EQUIPMENT order:
    // [weapon, shield, head, body, legs, neck, ring, hands, feet, cape, ammo]
    spawn.equipment = [87, 97, 94, 99, 98, 0, 0, 0, 0, 0, 0]
    delete spawn.equipmentFits
    delete spawn.attackAnim

    const sel = sidebar.querySelector('#npcTypeSelect')
    if (sel) sel.value = spawn.npcId
    ensureNpcPreview(spawn)
    refreshNpcPreviewGear(spawn)
    rebuildNpcSpawnMeshes()
    refreshNpcSpawnList()
    renderNpcInspector()
  }

  function npcModelGearFitRows(spawn) {
    if (!spawn || !Array.isArray(spawn.equipment)) return []
    const rows = []
    for (const { label, slot } of EQUIP_SLOTS) {
      const slotIdx = EDITOR_EQUIP_SLOT_ORDER.indexOf(slot)
      if (slotIdx < 0) continue
      const itemId = spawn.equipment[slotIdx] ?? 0
      if (itemId <= 0) continue
      const baseFit = npcModelGearBaseFit(spawn, slot)
      if (!baseFit) continue
      const itemDef = itemDefs.find(d => d.id === itemId)
      if (itemDef?.equipSlot && itemDef.equipSlot !== slot) continue
      rows.push({ label, slot, itemId, itemDef, baseFit })
    }
    return rows
  }

  function formatEditorNumber(value, decimals = 2) {
    return Number.isFinite(value) ? Number(value).toFixed(decimals) : '0'
  }

  function escapeNpcGearHtml(value) {
    return String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }

  function vectorInputMarkup(slot, key, values, decimals, step) {
    return ['x', 'y', 'z'].map(axis => `
      <label style="display:flex;align-items:center;gap:3px;min-width:0;">
        <span style="width:10px;color:rgba(255,255,255,0.45);font-size:10px;text-transform:uppercase;">${axis}</span>
        <input data-fit-slot="${slot}" data-fit-vector="${key}" data-fit-axis="${axis}" type="number" step="${step}" value="${formatEditorNumber(values[axis], decimals)}"
               style="width:100%;min-width:0;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:10px;" />
      </label>
    `).join('')
  }

  function renderNpcModelGearFitControls(root, spawn) {
    const rows = npcModelGearFitRows(spawn)
    if (rows.length === 0) return

    const section = document.createElement('div')
    section.style.cssText = 'margin-top:10px;padding-top:8px;border-top:1px solid #333;'
    section.innerHTML = `
      <div style="font-size:10px;color:#88aaff;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Model fit</div>
      <div style="font-size:10px;color:rgba(255,255,255,0.45);line-height:1.35;margin-bottom:6px;">
        Saved on this spawn only. Defaults still come from the NPC model gear config.
      </div>
    `

    for (const row of rows) {
      const fit = npcModelGearFit(spawn, row.slot)
      if (!fit) continue
      const rotDeg = {
        x: fit.localRotation.x * 180 / Math.PI,
        y: fit.localRotation.y * 180 / Math.PI,
        z: fit.localRotation.z * 180 / Math.PI,
      }
      const card = document.createElement('div')
      card.style.cssText = 'border:1px solid #333;background:#181818;border-radius:4px;padding:6px;margin-bottom:6px;'
      card.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:5px;">
          <div style="flex:1;min-width:0;font-size:11px;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">
            ${escapeNpcGearHtml(row.label)} · ${escapeNpcGearHtml(row.itemDef?.name || `Item ${row.itemId}`)}
          </div>
          <button data-fit-reset="${row.slot}" title="Reset fit" style="font-size:10px;padding:2px 6px;background:#2a2a2a;color:#aaa;border:1px solid #444;border-radius:3px;cursor:pointer;">Reset</button>
        </div>
        <div style="display:grid;grid-template-columns:42px 1fr 58px;align-items:center;gap:5px;margin-bottom:5px;">
          <span style="font-size:10px;color:rgba(255,255,255,0.62);">Scale</span>
          <input data-fit-scale-range="${row.slot}" type="range" min="0.1" max="3" step="0.01" value="${fit.scale}" style="width:100%;" />
          <input data-fit-scale-input="${row.slot}" type="number" min="0.05" max="10" step="0.05" value="${formatEditorNumber(fit.scale, 2)}"
                 style="width:100%;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:10px;" />
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.55);margin:4px 0 3px;">Offset</div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;margin-bottom:5px;">
          ${vectorInputMarkup(row.slot, 'localPosition', fit.localPosition, 2, '0.01')}
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.55);margin:4px 0 3px;">Rotation</div>
        <div style="display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:4px;">
          ${vectorInputMarkup(row.slot, 'localRotation', rotDeg, 1, '1')}
        </div>
      `
      section.appendChild(card)
    }

    section.querySelectorAll('[data-fit-scale-range], [data-fit-scale-input]').forEach(input => {
      input.addEventListener('input', (e) => {
        const slot = e.target.dataset.fitScaleRange || e.target.dataset.fitScaleInput
        const value = Math.max(0.05, Number(e.target.value) || npcModelGearBaseFit(spawn, slot)?.scale || 1)
        writeNpcEquipmentFitOverride(spawn, slot, { scale: value })
        const range = section.querySelector(`[data-fit-scale-range="${slot}"]`)
        const number = section.querySelector(`[data-fit-scale-input="${slot}"]`)
        if (range && range !== e.target) range.value = String(Math.min(3, Math.max(0.1, value)))
        if (number && number !== e.target) number.value = formatEditorNumber(value, 2)
      })
    })

    section.querySelectorAll('[data-fit-vector]').forEach(input => {
      input.addEventListener('input', (e) => {
        const slot = e.target.dataset.fitSlot
        const key = e.target.dataset.fitVector
        const axis = e.target.dataset.fitAxis
        const fit = npcModelGearFit(spawn, slot)
        if (!fit || !axis) return
        const value = Number(e.target.value)
        if (!Number.isFinite(value)) return
        const current = fit[key]
        const next = { x: current.x, y: current.y, z: current.z }
        next[axis] = key === 'localRotation' ? value * Math.PI / 180 : value
        writeNpcEquipmentFitOverride(spawn, slot, { [key]: next })
      })
    })

    section.querySelectorAll('[data-fit-reset]').forEach(btn => {
      btn.addEventListener('click', () => {
        clearNpcEquipmentFitSlot(spawn, btn.dataset.fitReset)
        renderEquipmentTab(root)
      })
    })

    root.appendChild(section)
  }

  function renderEquipmentTab(root) {
    root.innerHTML = ''
    const spawn = selectedNpcSpawn
    if (!spawn) {
      root.innerHTML = `<div class="hint">Click an NPC spawn to edit equipment.</div>`
      return
    }
    // Lazy-load item defs. CRITICAL: only schedule a re-render if defs
    // weren't loaded yet — otherwise the Promise resolves immediately, the
    // callback re-enters renderEquipmentTab, schedules another microtask,
    // and the tab is in a tight infinite render loop that freezes Chrome.
    if (itemDefs.length === 0) {
      fetchItemDefsOnce().then(() => {
        if (selectedNpcSpawn !== spawn) return
        ensureEquipItemDatalists()
        const activeTab = sidebar.querySelector('.npc-tab.active-tool')?.dataset?.tab
        if (activeTab === 'equipment') renderEquipmentTab(root)
      })
    } else {
      ensureEquipItemDatalists()
    }
    // Auto-init the equipment array on first visit — no more "tick this
    // confusing override box first" friction. An array of zeros gets stripped
    // by serializeNpcSpawns (override predicate requires a non-empty array
    // with at least one non-zero, see NPC_SPAWN_OVERRIDE_FIELDS).
    if (!Array.isArray(spawn.equipment) || (spawn.equipment.length !== 10 && spawn.equipment.length !== 11)) {
      spawn.equipment = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
    }

    // Header line — anchors what the user is editing.
    const header = document.createElement('div')
    header.style.cssText = 'font-size:11px;color:rgba(255,255,255,0.6);margin-bottom:8px;line-height:1.4;'
    header.innerHTML = `
      Pick items to equip on this spawn. Type to filter — only items that fit each slot appear in the dropdown. Live preview updates on commit.
      <button id="basicGuardGearPresetBtn" style="width:100%;margin-top:8px;font-size:11px;padding:5px;background:#2f3d33;color:#fff;cursor:pointer;border:1px solid #4c6a52;border-radius:3px;">Make basic guard</button>
    `
    root.appendChild(header)
    root.querySelector('#basicGuardGearPresetBtn')?.addEventListener('click', () => applyBasicGuardPreset(spawn))

    // Slot rows, grouped. Visual separator + group header before each new group.
    let lastGroup = null
    for (let i = 0; i < EQUIP_SLOTS.length; i++) {
      const { label, slot, group } = EQUIP_SLOTS[i]
      if (group !== lastGroup) {
        const groupHeader = document.createElement('div')
        groupHeader.style.cssText = 'font-size:10px;color:#88aaff;text-transform:uppercase;letter-spacing:0.5px;margin:8px 0 4px 0;padding-bottom:2px;border-bottom:1px solid #2a3a55;'
        groupHeader.textContent = group
        root.appendChild(groupHeader)
        lastGroup = group
      }
      const slotIdx = EDITOR_EQUIP_SLOT_ORDER.indexOf(slot)
      if (slotIdx < 0) continue
      const curId = spawn.equipment[slotIdx] ?? 0
      const row = document.createElement('div')
      row.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px;'
      row.innerHTML = `
        <span style="flex:0 0 50px;font-size:11px;color:rgba(255,255,255,0.75);">${label}</span>
        <input list="equipItemDatalist_${slot}" type="text" value="${curId > 0 ? formatItemDisplay(curId).replace(/"/g, '&quot;') : ''}"
               placeholder="(empty — type to search)"
               style="flex:1;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:4px 6px;font-size:11px;min-width:0;" />
        <button title="Clear slot" style="font-size:12px;padding:2px 8px;background:#2a2a2a;color:#aaa;border:1px solid #444;border-radius:3px;cursor:pointer;">×</button>
      `
      const input = row.querySelector('input')
      const clearBtn = row.querySelector('button')
      const commit = () => {
        const id = parseItemIdFromDisplay(input.value)
        spawn.equipment[slotIdx] = id
        if (id <= 0) clearNpcEquipmentFitSlot(spawn, slot)
        // Snap to canonical "Name (ID)" form on resolve so the user sees the
        // matched item. Blank stays blank.
        input.value = id > 0 ? formatItemDisplay(id) : ''
        const ok = id === 0 || itemDefs.some(d => d.id === id)
        input.style.borderColor = ok ? '#444' : '#a55'
        refreshNpcPreviewGear(spawn)
        if (npcModelGearBaseFit(spawn, slot) || id <= 0) renderEquipmentTab(root)
      }
      input.addEventListener('change', commit)
      clearBtn.addEventListener('click', () => {
        spawn.equipment[slotIdx] = 0
        clearNpcEquipmentFitSlot(spawn, slot)
        input.value = ''
        input.style.borderColor = '#444'
        refreshNpcPreviewGear(spawn)
        if (npcModelGearBaseFit(spawn, slot)) renderEquipmentTab(root)
      })
      root.appendChild(row)
    }

    renderNpcModelGearFitControls(root, spawn)

    const hint = document.createElement('div')
    hint.className = 'hint'
    hint.style.cssText = 'font-size:10px;color:rgba(255,255,255,0.4);margin-top:10px;line-height:1.4;padding-top:8px;border-top:1px solid #333;'
    const visual = npcPreviewVisualConfig(spawn)
    const previewText = visual?.modelCfg
      ? 'equipped supported slots show on this NPC model using its configured bones.'
      : spawn.appearance
        ? 'equipped gear shows on the editor character above using the same humanoid rig path as the game.'
        : 'enable an <i>appearance</i> override (Look tab) to see humanoid gear preview.'
    hint.innerHTML = `
      <b>Preview:</b> ${previewText}<br>
      If a piece was just re-rigged, refresh the editor to reload gear-overrides.json.
    `
    root.appendChild(hint)
  }

  function openDropsEditor(selectedNpcId = selectedNpcSpawn?.npcId) {
    return openDropTableEditor({
      npcDefs,
      items: itemDefs,
      loadItems: fetchItemDefsOnce,
      selectedNpcId,
      isNpcEditable: isNpcSharedEditUnlocked,
      onRequestUnlock: unlockNpcSharedEditing,
      onDirty: markDefsDirty,
      onSave: saveNpcDefsToServer,
    })
  }

  function lootChanceLabel(chance) {
    const pct = Math.max(0, Math.min(1, Number(chance) || 0)) * 100
    if (pct >= 100) return 'Always'
    if (pct <= 0) return 'Never'
    if (pct < 1) return `${pct.toFixed(2)}%`
    if (pct < 10) return `${pct.toFixed(1)}%`
    return `${Math.round(pct)}%`
  }

  function roundDropChanceForSave(chance) {
    return Number(Math.max(0, Math.min(1, Number(chance) || 0)).toFixed(6))
  }

  function itemNameForEditor(itemId) {
    return itemDefs.find(d => d.id === itemId)?.name || `Item ${itemId}`
  }

  function syncNpcRelicDropToCombatLevel(def) {
    if (!def) return null
    if (!Array.isArray(def.lootTable)) def.lootTable = []
    const combatLevel = npcCombatLevel(effectiveNpcCombatStats(def))
    const existingRelicDrops = def.lootTable.filter(drop => drop && RELIC_ITEM_IDS.has(drop.itemId))
    const preferredItemId = existingRelicDrops.find(drop => Number.isInteger(drop?.itemId))?.itemId
    const recommendation = relicCombatDropForLevel(combatLevel, preferredItemId)
    const nonRelicDrops = def.lootTable.filter(drop => !(drop && RELIC_ITEM_IDS.has(drop.itemId)))

    if (!recommendation) {
      if (existingRelicDrops.length > 0) {
        def.lootTable = nonRelicDrops
        markDefsDirty()
      }
      return { combatLevel, recommendation: null, changed: existingRelicDrops.length > 0 }
    }

    const nextDrop = {
      itemId: recommendation.itemId,
      quantity: recommendation.quantity,
      chance: roundDropChanceForSave(recommendation.chance),
    }
    const unchanged = existingRelicDrops.length === 1
      && existingRelicDrops[0].itemId === nextDrop.itemId
      && Math.max(1, Number(existingRelicDrops[0].quantity) || 1) === nextDrop.quantity
      && roundDropChanceForSave(existingRelicDrops[0].chance) === nextDrop.chance

    def.lootTable = [...nonRelicDrops, nextDrop]
    if (!unchanged) markDefsDirty()
    return { combatLevel, recommendation: { ...recommendation, chance: nextDrop.chance }, changed: !unchanged }
  }

  function renderDropsTab(root, def) {
    root.innerHTML = ''
    if (!def) {
      root.innerHTML = `<div class="hint">Select an NPC spawn (or pick a type) to edit drops.</div>`
      return
    }

    if (!appendNpcSharedEditGate(root, def, 'Drop edits')) {
      return
    }

    if (itemDefs.length === 0) {
      root.innerHTML = `<div class="hint">Loading item names...</div>`
      fetchItemDefsOnce().then(() => {
        if (activeNpcTab === 'drops') renderDropsTab(root, def)
      })
      return
    }

    if (!Array.isArray(def.lootTable)) def.lootTable = []
    const rows = def.lootTable.map(drop => {
      const item = itemDefs.find(d => d.id === drop.itemId)
      const chance = Math.max(0, Math.min(1, Number(drop.chance) || 0))
      const expectedQty = (Number(drop.quantity) || 0) * chance
      const expectedValue = expectedQty * (Number(item?.value) || 0)
      return { drop, item, chance, expectedQty, expectedValue }
    })
    const guaranteed = rows.filter(row => row.chance >= 1).length
    const random = rows.filter(row => row.chance > 0 && row.chance < 1).length
    const expectedValue = rows.reduce((sum, row) => sum + row.expectedValue, 0)
    const sharedCombatLevel = npcCombatLevel(effectiveNpcCombatStats(def))
    const relicRows = rows.filter(row => row.drop && RELIC_ITEM_IDS.has(row.drop.itemId))
    const currentRelic = relicRows[0] || null
    const relicRecommendation = relicCombatDropForLevel(sharedCombatLevel, currentRelic?.drop?.itemId)
    const relicBand = relicCombatDropBandForLevel(sharedCombatLevel)
    const currentRelicText = currentRelic
      ? `${itemNameForEditor(currentRelic.drop.itemId)} x${Math.max(1, currentRelic.drop.quantity || 1)} - ${lootChanceLabel(currentRelic.chance)}${relicRows.length > 1 ? ` (+${relicRows.length - 1} duplicate)` : ''}`
      : 'None'
    const recommendedItemName = relicRecommendation ? itemNameForEditor(relicRecommendation.itemId) : ''
    const targetRelicText = relicRecommendation
      ? `Tier ${relicRecommendation.tier}: ${recommendedItemName} x${relicRecommendation.quantity} - ${lootChanceLabel(relicRecommendation.chance)}`
      : `No relic tier at combat level ${sharedCombatLevel}`
    const relicButtonDisabled = !relicRecommendation && relicRows.length === 0

    root.innerHTML = `
      <div style="font-size:10px;color:#ffaa44;margin-bottom:6px;">Editing shared NPC type #${def.id} — affects every spawn of "${escapeEditorHtml(def.name)}".</div>
      <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:5px;margin-bottom:8px;">
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:6px;text-align:center;">
          <div style="font-size:15px;color:#fff;font-weight:bold;">${rows.length}</div>
          <div style="font-size:10px;color:#888;">entries</div>
        </div>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:6px;text-align:center;">
          <div style="font-size:15px;color:#fff;font-weight:bold;">${guaranteed}</div>
          <div style="font-size:10px;color:#888;">always</div>
        </div>
        <div style="background:#1a1a1a;border:1px solid #333;border-radius:4px;padding:6px;text-align:center;">
          <div style="font-size:15px;color:#fff;font-weight:bold;">${expectedValue.toFixed(expectedValue >= 10 ? 0 : 1)}</div>
          <div style="font-size:10px;color:#888;">value/kill</div>
        </div>
      </div>
      <button id="openDropTablesBtn" style="width:100%;font-size:11px;padding:6px;background:#2a4a6c;color:#fff;cursor:pointer;border:1px solid #5d7897;border-radius:3px;">Open drop table editor</button>
      <div style="display:flex;gap:5px;margin-top:6px;">
        <button id="quickAlwaysDropBtn" style="flex:1;font-size:11px;padding:5px;background:#315c31;color:#fff;cursor:pointer;border:1px solid #4d7d4d;border-radius:3px;">+ Always</button>
        <button id="quickRandomDropBtn" style="flex:1;font-size:11px;padding:5px;background:#5f5130;color:#fff;cursor:pointer;border:1px solid #826f45;border-radius:3px;">+ Random</button>
      </div>
      <div style="margin-top:6px;background:#181512;border:1px solid #3b2d1b;border-radius:4px;padding:6px;">
        <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;font-size:11px;color:#ffcc66;font-weight:bold;">
          <span>Relic drop</span>
          <span style="font-size:10px;color:rgba(255,255,255,0.45);font-weight:normal;">Combat ${sharedCombatLevel}${relicBand ? ` - tier ${relicBand.tier}` : ''}</span>
        </div>
        <div style="font-size:10px;color:rgba(255,255,255,0.55);margin-top:4px;line-height:1.35;">
          Current: ${escapeEditorHtml(currentRelicText)}<br>
          Target: ${escapeEditorHtml(targetRelicText)}
        </div>
        <button id="syncRelicDropBtn" style="width:100%;margin-top:6px;font-size:11px;padding:5px;background:${relicButtonDisabled ? '#252525' : '#5b4724'};color:${relicButtonDisabled ? '#777' : '#fff'};cursor:${relicButtonDisabled ? 'default' : 'pointer'};border:1px solid ${relicButtonDisabled ? '#333' : '#806535'};border-radius:3px;" ${relicButtonDisabled ? 'disabled' : ''}>${relicRecommendation ? 'Sync relic to combat level' : 'Remove relic drop'}</button>
      </div>
      <div style="font-size:10px;color:#888;margin:8px 0 4px;">${guaranteed} guaranteed · ${random} random</div>
      <div id="dropTabRows" style="display:flex;flex-direction:column;gap:5px;"></div>
    `

    const list = root.querySelector('#dropTabRows')
    if (rows.length === 0) {
      list.innerHTML = `<div class="hint" style="font-size:10px;color:rgba(255,255,255,0.35);">No drops on this NPC type.</div>`
    } else {
      for (const row of rows.slice(0, 8)) {
        const div = document.createElement('div')
        div.style.cssText = 'background:#171717;border:1px solid #333;border-radius:4px;padding:5px 6px;'
        div.innerHTML = `
          <div style="display:flex;justify-content:space-between;gap:8px;font-size:11px;color:#ddd;">
            <span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeEditorHtml(row.item?.name || `Item ${row.drop.itemId}`)} x${Math.max(1, row.drop.quantity || 1)}</span>
            <b style="flex:0 0 auto;color:#ffcc66;">${lootChanceLabel(row.chance)}</b>
          </div>
          <div style="height:5px;background:#0c0c0c;border-radius:999px;overflow:hidden;margin-top:4px;">
            <i style="display:block;height:100%;width:${Math.max(2, Math.min(100, row.chance * 100))}%;background:${row.chance >= 1 ? '#5a8f5a' : row.chance >= 0.25 ? '#4d789e' : row.chance >= 0.05 ? '#8a7940' : '#9a5d4c'};"></i>
          </div>
        `
        list.appendChild(div)
      }
      if (rows.length > 8) {
        const more = document.createElement('div')
        more.style.cssText = 'font-size:10px;color:#888;text-align:center;padding:3px;'
        more.textContent = `+ ${rows.length - 8} more`
        list.appendChild(more)
      }
    }

    root.querySelector('#openDropTablesBtn')?.addEventListener('click', () => openDropsEditor(def.id))
    root.querySelector('#syncRelicDropBtn')?.addEventListener('click', () => {
      const result = syncNpcRelicDropToCombatLevel(def)
      if (result?.changed) {
        showEditorNotice(`Relic drop updated for ${def.name} (combat ${result.combatLevel}).`, 'success', 4000)
      }
      renderDropsTab(root, def)
    })
    root.querySelector('#quickAlwaysDropBtn')?.addEventListener('click', () => {
      def.lootTable.push({ itemId: 0, quantity: 1, chance: 1 })
      markDefsDirty()
      openDropsEditor(def.id)
    })
    root.querySelector('#quickRandomDropBtn')?.addEventListener('click', () => {
      def.lootTable.push({ itemId: 0, quantity: 1, chance: 0.25 })
      markDefsDirty()
      openDropsEditor(def.id)
    })
  }

  /** Append a "Shared type | This spawn" mode toggle. Used by
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
    const defBtn = make('Shared type', !overrideActive)
    const ovrBtn = make('This spawn', overrideActive)
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
            ? { name: def.shop.name, restockTicks: def.shop.restockTicks ?? DEFAULT_SHOP_RESTOCK_TICKS, items: def.shop.items.map(i => ({ ...i })) }
            : { name: `${def.name}'s Shop`, restockTicks: DEFAULT_SHOP_RESTOCK_TICKS, items: [] }
        }
        renderShopTab(root, def)
      },
    })

    // Target object — the shop being edited (either def.shop or spawn.shop).
    const targetIsOverride = overrideActive
    if (!targetIsOverride && !appendNpcSharedEditGate(root, def, 'Shop edits')) {
      return
    }
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
        const blank = { name: `${def.name}'s Shop`, restockTicks: DEFAULT_SHOP_RESTOCK_TICKS, items: [] }
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

    const restockRow = document.createElement('div')
    restockRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;'
    restockRow.innerHTML = `
      <span style="flex:0;font-size:11px;color:rgba(255,255,255,0.65);white-space:nowrap;">Restock ticks</span>
      <input type="number" min="0" step="1" value="${target.restockTicks ?? DEFAULT_SHOP_RESTOCK_TICKS}" style="width:72px;background:#1a1a1a;color:#fff;border:1px solid #444;border-radius:3px;padding:3px;font-size:11px;" />
    `
    restockRow.querySelector('input').addEventListener('change', (e) => {
      target.restockTicks = Math.max(0, parseInt(e.target.value) || 0)
      e.target.value = String(target.restockTicks)
      if (!targetIsOverride) markDefsDirty()
    })
    root.appendChild(restockRow)

    // Items list — two rows per item to fit the narrow sidebar without
    // truncating item names. Row 1: searchable item picker + delete; row 2:
    // labelled Price + Stock inputs.
    const items = target.items || (target.items = [])
    const list = document.createElement('div')
    list.style.cssText = 'border:1px solid #333;border-radius:3px;padding:6px;background:#161616;'

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

    const pageCount = Math.max(1, Math.ceil(items.length / SHOP_EDITOR_ITEMS_PER_PAGE))
    shopEditorPageIndex = Math.max(0, Math.min(shopEditorPageIndex, pageCount - 1))
    const startIndex = shopEditorPageIndex * SHOP_EDITOR_ITEMS_PER_PAGE
    const endIndex = Math.min(items.length, startIndex + SHOP_EDITOR_ITEMS_PER_PAGE)

    for (let i = startIndex; i < endIndex; i++) {
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

    if (items.length > SHOP_EDITOR_ITEMS_PER_PAGE) {
      const pager = document.createElement('div')
      pager.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:8px;margin-top:6px;'
      const prev = document.createElement('button')
      prev.textContent = '<'
      prev.disabled = shopEditorPageIndex <= 0
      prev.style.cssText = 'min-width:32px;font-size:11px;padding:4px;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:3px;cursor:pointer;'
      prev.addEventListener('click', () => {
        shopEditorPageIndex--
        renderShopTab(root, def)
      })
      const label = document.createElement('span')
      label.textContent = `${shopEditorPageIndex + 1}/${pageCount}`
      label.style.cssText = 'font-size:11px;color:#bbb;min-width:40px;text-align:center;'
      const next = document.createElement('button')
      next.textContent = '>'
      next.disabled = shopEditorPageIndex >= pageCount - 1
      next.style.cssText = 'min-width:32px;font-size:11px;padding:4px;background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:3px;cursor:pointer;'
      next.addEventListener('click', () => {
        shopEditorPageIndex++
        renderShopTab(root, def)
      })
      pager.append(prev, label, next)
      root.appendChild(pager)
    }

    const addBtn = document.createElement('button')
    addBtn.textContent = '+ Add item'
    addBtn.style.cssText = 'width:100%;margin-top:6px;font-size:11px;padding:6px;background:#2a3a4a;color:#fff;border:1px solid #555;border-radius:3px;cursor:pointer;'
    addBtn.addEventListener('click', () => {
      // Default to itemId 0 so the user immediately sees the empty picker and
      // knows they need to choose one. The validation border (#aa5544) makes
      // unset rows visually loud.
      items.push({ itemId: 0, price: 1, stock: 1 })
      shopEditorPageIndex = Math.floor((items.length - 1) / SHOP_EDITOR_ITEMS_PER_PAGE)
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
    if (!targetIsOverride && !appendNpcSharedEditGate(root, def, 'Dialogue edits')) {
      return
    }
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
    hint.innerHTML = `JSON view. Tree must have a <code>root</code> node id and a <code>nodes</code> map.<br>Actions: use <code>action</code> for one effect or <code>actions</code> for a list. Supported: <code>openShop</code>, <code>openBank</code>, <code>openAppearance</code>, <code>giveItem</code>, <code>takeItem</code>, <code>bankInventoryItemsForCoins</code>, <code>closeDialogue</code>, <code>setQuestStage</code>, <code>completeQuest</code>.<br>Option gating: legacy <code>requires</code>, or generic <code>condition</code>/<code>conditions</code>. Conditions: <code>questStage</code>, <code>questStarted</code>, <code>questNotStarted</code>, <code>questCompleted</code>, <code>hasItem</code>, <code>hasEquippedItem</code>, <code>skillLevel</code>, <code>combatLevel</code>, <code>all</code>, <code>any</code>, <code>not</code>.`
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
  const collModes = { wall: 'collWallBtn', block: 'collBlockBtn', floor: 'collFloorBtn', hole: 'collHoleBtn' }
  const collPanels = { wall: 'collWallPanel', block: 'collBlockPanel', floor: 'collFloorPanel', hole: 'collHolePanel' }
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

  const WALL_DETECT_KEYWORDS = ['wall', 'fence', 'gate']

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
      const assetName = asset?.name?.toLowerCase() || ''
      if (!WALL_DETECT_KEYWORDS.some(k => assetName.includes(k))) continue

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
  const itemThumbsTopBtn = topBar.querySelector('#itemThumbsTopBtn')
  const mapSizeLabel = topBar.querySelector('#mapSizeLabel')
  const statusText = statusBar.querySelector('#statusText')
  const hoverText = statusBar.querySelector('#hoverText')
  let statusHoldUntil = 0
  let editorNoticeTimer = null

  function showEditorNotice(message, kind = 'info', duration = 6000) {
    const colors = {
      info: ['rgba(20,24,30,0.96)', 'rgba(255,255,255,0.18)'],
      success: ['rgba(18,55,34,0.96)', 'rgba(95,210,130,0.55)'],
      error: ['rgba(72,22,22,0.97)', 'rgba(255,96,96,0.6)'],
    }
    const [bg, border] = colors[kind] || colors.info
    statusHoldUntil = performance.now() + duration
    statusText.textContent = message
    editorNotice.textContent = message
    editorNotice.style.background = bg
    editorNotice.style.borderColor = border
    editorNotice.style.display = 'block'
    if (editorNoticeTimer) clearTimeout(editorNoticeTimer)
    editorNoticeTimer = setTimeout(() => {
      editorNotice.style.display = 'none'
      editorNoticeTimer = null
    }, duration)
  }

  const tabProps = sidebar.querySelector('#tabProps')
  const tabResources = sidebar.querySelector('#tabResources')
  const tabModular = sidebar.querySelector('#tabModular')
  const tabWalls = sidebar.querySelector('#tabWalls')
  const tabRoofs = sidebar.querySelector('#tabRoofs')
  const tabBought = sidebar.querySelector('#tabBought')
  const assetGroupSelect = sidebar.querySelector('#assetGroupSelect')
  const assetSearch = sidebar.querySelector('#assetSearch')
  const itemThumbsBtn = sidebar.querySelector('#itemThumbsBtn')
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
      unfreezePlacedModel(selectedPlacedObject)
      scaleObjectToTiles(selectedPlacedObject, tiles)
      _spatialRefresh(selectedPlacedObject)
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
    unfreezePlacedModel(selectedPlacedObject)
    scaleObjectToTiles(selectedPlacedObject, tiles)
    _spatialRefresh(selectedPlacedObject)
    updateSelectionHelper()
    invalidateShadowCache()
  })

  const objectNameInput = sidebar.querySelector('#objectNameInput')
  objectNameInput?.addEventListener('input', () => {
    if (!selectedPlacedObject) return
    const name = objectNameInput.value.trim()
    if (name) selectedPlacedObject.userData.name = name
    else delete selectedPlacedObject.userData.name
    ensureShopItemDatalist()
  })
  function placedObjectDef(obj) {
    const defId = obj ? ASSET_TO_OBJECT_DEF[obj.userData?.assetId] : null
    if (defId == null) return null
    return editorObjectDefById.get(defId) || null
  }
  function isDoorPlacedObject(obj) {
    const def = placedObjectDef(obj)
    return def?.category === 'door'
  }
  function isAltarPlacedObject(obj) {
    const def = placedObjectDef(obj)
    return def?.category === 'altar'
  }
  function isLadderPlacedObject(obj) {
    const def = placedObjectDef(obj)
    return def?.category === 'ladder'
  }
  function isTeleportPlacedObject(obj) {
    const def = placedObjectDef(obj)
    return Boolean(obj && (def?.transition || obj.userData?.trigger?.type === 'teleport'))
  }
  function isRoofLikeAssetId(assetId) {
    const lower = String(assetId || '').toLowerCase()
    return lower.includes('roof') || lower.includes('slab')
  }
  function isRoofLikePlacedObject(obj) {
    return Boolean(obj && isRoofLikeAssetId(obj.userData?.assetId))
  }
  function selectedRoofLikePlacedObjects() {
    return selectedPlacedObjects.filter(isRoofLikePlacedObject)
  }
  function copyNoRoofFlag(src, dest) {
    if (src?.userData?.noRoof) dest.userData.noRoof = true
    else delete dest.userData.noRoof
  }
  function mapInfoById(mapId) {
    return editorServerMaps.find(m => m?.id === mapId) || null
  }
  function defaultTeleportMapId(obj) {
    const existing = obj?.userData?.trigger?.destChunk
    if (existing) return existing
    const defTarget = placedObjectDef(obj)?.transition?.targetMap
    if (defTarget) return defTarget
    const dungeon = editorServerMaps.find(m => m?.id !== currentServerMapId && (m.mapType === 'dungeon' || m.id === 'underground'))
    if (dungeon?.id) return dungeon.id
    const other = editorServerMaps.find(m => m?.id && m.id !== currentServerMapId)
    return other?.id || 'underground'
  }
  function defaultTeleportEntry(mapId) {
    const info = mapInfoById(mapId)
    const width = Number.isFinite(info?.width) && info.width > 0 ? info.width : 64
    const height = Number.isFinite(info?.height) && info.height > 0 ? info.height : 64
    return {
      x: Math.floor(width / 2) + 0.5,
      y: 0,
      z: Math.floor(height / 2) + 0.5,
    }
  }
  function syncTeleportMapDatalist() {
    const list = sidebar.querySelector('#triggerDestMapList')
    if (!list) return
    const attr = (value) => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
    list.innerHTML = editorServerMaps
      .filter(m => m?.id)
      .map(m => {
        const type = m.mapType ? `, ${m.mapType}` : ''
        const size = m.width && m.height ? ` (${m.width}x${m.height}${type})` : type ? ` (${m.mapType})` : ''
        return `<option value="${attr(m.id)}" label="${attr(`${m.name || m.id}${size}`)}"></option>`
      })
      .join('')
  }
  function ensureTeleportDefaultsInUI() {
    const destInput = sidebar.querySelector('#triggerDestChunk')
    const entryX = sidebar.querySelector('#triggerEntryX')
    const entryY = sidebar.querySelector('#triggerEntryY')
    const entryZ = sidebar.querySelector('#triggerEntryZ')
    if (!destInput || !entryX || !entryY || !entryZ) return
    if (!destInput.value.trim()) destInput.value = defaultTeleportMapId(selectedPlacedObject)
    const entry = defaultTeleportEntry(destInput.value.trim())
    if (!entryX.value) entryX.value = entry.x
    if (!entryY.value) entryY.value = entry.y
    if (!entryZ.value) entryZ.value = entry.z
  }
  function fillTeleportEntryFromMapCenter() {
    const destInput = sidebar.querySelector('#triggerDestChunk')
    const entryX = sidebar.querySelector('#triggerEntryX')
    const entryY = sidebar.querySelector('#triggerEntryY')
    const entryZ = sidebar.querySelector('#triggerEntryZ')
    if (!destInput || !entryX || !entryY || !entryZ) return
    if (!destInput.value.trim()) destInput.value = defaultTeleportMapId(selectedPlacedObject)
    const entry = defaultTeleportEntry(destInput.value.trim())
    entryX.value = entry.x
    entryY.value = entry.y
    entryZ.value = entry.z
    saveTriggerFromUI()
  }
  function dungeonExitsForMap(mapId) {
    return editorDungeonExits.filter(exit => (
      exit?.mapId === mapId &&
      Number.isFinite(exit.x) &&
      Number.isFinite(exit.z)
    ))
  }
  function teleportExitLanding(exit) {
    return {
      x: Number.isFinite(exit?.landingX) ? exit.landingX : exit?.x,
      y: Number.isFinite(exit?.landingY) ? exit.landingY : (exit?.y ?? 0),
      z: Number.isFinite(exit?.landingZ) ? exit.landingZ : exit?.z,
    }
  }
  function nearestDungeonExitForMap(mapId, anchor) {
    const exits = dungeonExitsForMap(mapId)
    if (!exits.length) return null
    const reference = anchor || defaultTeleportEntry(mapId)
    return exits
      .map(exit => {
        const landing = teleportExitLanding(exit)
        return { exit, landing, distance: teleportDistance2d(reference.x, reference.z, landing.x, landing.z) }
      })
      .sort((a, b) => a.distance - b.distance)[0]
  }
  function setDungeonExitStatus(message, color = '#888') {
    const status = sidebar.querySelector('#triggerDungeonExitStatus')
    if (!status) return
    status.style.color = color
    status.textContent = message
  }
  function fillTeleportEntryFromDungeonExit() {
    const typeInput = sidebar.querySelector('#triggerType')
    const fields = sidebar.querySelector('#triggerTeleportFields')
    const destInput = sidebar.querySelector('#triggerDestChunk')
    const entryX = sidebar.querySelector('#triggerEntryX')
    const entryY = sidebar.querySelector('#triggerEntryY')
    const entryZ = sidebar.querySelector('#triggerEntryZ')
    if (!typeInput || !fields || !destInput || !entryX || !entryY || !entryZ) return

    typeInput.value = 'teleport'
    fields.style.display = 'block'
    if (!destInput.value.trim()) destInput.value = defaultTeleportMapId(selectedPlacedObject)
    const targetMap = destInput.value.trim()
    const fallback = defaultTeleportEntry(targetMap)
    const rawX = parseFloat(entryX.value)
    const rawY = parseFloat(entryY.value)
    const rawZ = parseFloat(entryZ.value)
    const anchor = {
      x: Number.isFinite(rawX) ? rawX : fallback.x,
      y: Number.isFinite(rawY) ? rawY : fallback.y,
      z: Number.isFinite(rawZ) ? rawZ : fallback.z,
    }
    const match = nearestDungeonExitForMap(targetMap, anchor)
    if (!match) {
      setDungeonExitStatus(`No saved CavernExit1 on ${targetMap}. Place one in that dungeon, save the map, then try again.`, '#ffb45f')
      renderTeleportOccupancyPreview()
      return
    }

    const landing = match.landing || teleportExitLanding(match.exit)
    entryX.value = formatTeleportNumber(landing.x)
    entryY.value = formatTeleportNumber(landing.y)
    entryZ.value = formatTeleportNumber(landing.z)
    saveTriggerFromUI()
    const coord = `${formatTeleportNumber(landing.x)}, ${formatTeleportNumber(landing.y)}, ${formatTeleportNumber(landing.z)}`
    setDungeonExitStatus(`Linked to ${match.exit.objectName || match.exit.assetId || 'CavernExit1'} on ${targetMap} at ${coord}.`, '#7bdca8')
    updateToolUI()
  }
  function formatTeleportNumber(value) {
    if (!Number.isFinite(value)) return '?'
    const rounded = Math.round(value * 10) / 10
    return Number.isInteger(rounded) ? String(rounded) : rounded.toFixed(1)
  }
  function teleportDistance2d(ax, az, bx, bz) {
    const dx = ax - bx
    const dz = az - bz
    return Math.sqrt(dx * dx + dz * dz)
  }
  function currentTeleportDraft() {
    if (!selectedPlacedObject || !isTeleportPlacedObject(selectedPlacedObject)) return null
    const type = sidebar.querySelector('#triggerType')?.value || selectedPlacedObject.userData?.trigger?.type || ''
    if (type !== 'teleport') return null
    const dest = sidebar.querySelector('#triggerDestChunk')?.value.trim() || defaultTeleportMapId(selectedPlacedObject)
    if (!dest) return null
    const fallback = defaultTeleportEntry(dest)
    const rawX = parseFloat(sidebar.querySelector('#triggerEntryX')?.value)
    const rawY = parseFloat(sidebar.querySelector('#triggerEntryY')?.value)
    const rawZ = parseFloat(sidebar.querySelector('#triggerEntryZ')?.value)
    return {
      targetMap: dest,
      x: Number.isFinite(rawX) ? rawX : fallback.x,
      y: Number.isFinite(rawY) ? rawY : fallback.y,
      z: Number.isFinite(rawZ) ? rawZ : fallback.z,
    }
  }
  function teleportEntryLabel(entry) {
    const name = entry.objectName ? `${entry.objectName} · ` : ''
    const kind = entry.custom ? 'custom' : 'default'
    return `${name}${entry.sourceMap} (${formatTeleportNumber(entry.sourceX)}, ${formatTeleportNumber(entry.sourceZ)}) · ${kind}`
  }
  function teleportExitLabel(exit) {
    const name = exit.objectName ? `${exit.objectName} · ` : ''
    const landing = teleportExitLanding(exit)
    return `${name}${exit.mapId} exit (${formatTeleportNumber(exit.x)}, ${formatTeleportNumber(exit.z)}) landing (${formatTeleportNumber(landing.x)}, ${formatTeleportNumber(landing.z)})`
  }
  function teleportHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
  }
  function renderTeleportSourceMapPreview(canvas, summary, sourceEntries, nearestSource) {
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const sourceX = selectedPlacedObject?.position?.x
    const sourceZ = selectedPlacedObject?.position?.z
    const hasSource = Number.isFinite(sourceX) && Number.isFinite(sourceZ)
    const w = canvas.width
    const h = canvas.height
    const pad = 12
    const plotW = w - pad * 2
    const plotH = h - pad * 2
    const width = Math.max(1, map.width || 64)
    const height = Math.max(1, map.height || 64)
    const project = (x, z) => ({
      x: pad + Math.max(0, Math.min(1, x / width)) * plotW,
      y: pad + Math.max(0, Math.min(1, z / height)) * plotH,
    })

    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, w, h)

    if (map.activeChunks?.size) {
      ctx.fillStyle = '#142233'
      for (const key of map.activeChunks) {
        const [cx, cz] = key.split(',').map(Number)
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue
        const a = project(cx * WALL_CHUNK_SIZE, cz * WALL_CHUNK_SIZE)
        const b = project(Math.min((cx + 1) * WALL_CHUNK_SIZE, width), Math.min((cz + 1) * WALL_CHUNK_SIZE, height))
        ctx.fillRect(a.x, a.y, Math.max(1, b.x - a.x), Math.max(1, b.y - a.y))
      }
    }

    ctx.strokeStyle = '#2c3b4a'
    ctx.lineWidth = 1
    for (let x = 0; x <= width; x += WALL_CHUNK_SIZE) {
      const p = project(x, 0)
      ctx.beginPath(); ctx.moveTo(p.x, pad); ctx.lineTo(p.x, h - pad); ctx.stroke()
    }
    for (let z = 0; z <= height; z += WALL_CHUNK_SIZE) {
      const p = project(0, z)
      ctx.beginPath(); ctx.moveTo(pad, p.y); ctx.lineTo(w - pad, p.y); ctx.stroke()
    }
    ctx.strokeStyle = '#626262'
    ctx.strokeRect(pad, pad, plotW, plotH)

    for (const entry of sourceEntries) {
      const p = project(entry.sourceX, entry.sourceZ)
      ctx.beginPath()
      ctx.arc(p.x, p.y, entry.custom ? 4 : 3, 0, Math.PI * 2)
      ctx.fillStyle = entry.custom ? '#ff6868' : '#c98542'
      ctx.fill()
    }

    if (hasSource) {
      const current = project(sourceX, sourceZ)
      if (nearestSource) {
        const near = project(nearestSource.entry.sourceX, nearestSource.entry.sourceZ)
        ctx.beginPath()
        ctx.moveTo(current.x, current.y)
        ctx.lineTo(near.x, near.y)
        ctx.strokeStyle = nearestSource.distance < 8 ? '#ff6868' : '#ffd166'
        ctx.lineWidth = 2
        ctx.stroke()
      }
      ctx.beginPath()
      ctx.arc(current.x, current.y, 6, 0, Math.PI * 2)
      ctx.strokeStyle = '#55f0a3'
      ctx.lineWidth = 2
      ctx.stroke()
      ctx.fillStyle = '#55f0a3'
      ctx.fillRect(current.x - 1, current.y - 1, 2, 2)
    }

    const sourceCoord = hasSource
      ? `${formatTeleportNumber(sourceX)}, ${formatTeleportNumber(selectedPlacedObject?.position?.y ?? 0)}, ${formatTeleportNumber(sourceZ)}`
      : 'unknown'
    if (!nearestSource) {
      summary.style.color = '#a8d8ff'
      summary.textContent = `${currentServerMapId}: current entrance at ${sourceCoord}. No nearby saved entrances on this map.`
    } else {
      summary.style.color = nearestSource.distance < 8 ? '#ff9e9e' : nearestSource.distance < 24 ? '#ffd27a' : '#a8d8ff'
      summary.textContent = `${currentServerMapId}: current entrance at ${sourceCoord}. Nearest saved entrance is ${formatTeleportNumber(nearestSource.distance)} tiles away and points to ${nearestSource.entry.targetMap}.`
    }
  }
  function renderTeleportOccupancyPreview() {
    const panel = sidebar.querySelector('#teleportOccupancyPanel')
    const sourceCanvas = sidebar.querySelector('#teleportSourceMapCanvas')
    const sourceMapSummary = sidebar.querySelector('#teleportSourceMapSummary')
    const canvas = sidebar.querySelector('#teleportOccupancyCanvas')
    const summary = sidebar.querySelector('#teleportOccupancySummary')
    const sourceSummary = sidebar.querySelector('#teleportSourceProximity')
    const list = sidebar.querySelector('#teleportOccupancyList')
    if (!panel || !sourceCanvas || !sourceMapSummary || !canvas || !summary || !sourceSummary || !list) return
    const draft = currentTeleportDraft()
    panel.style.display = draft ? 'block' : 'none'
    if (!draft) return

    const mapInfo = mapInfoById(draft.targetMap)
    const width = Number.isFinite(mapInfo?.width) && mapInfo.width > 0 ? mapInfo.width : 64
    const height = Number.isFinite(mapInfo?.height) && mapInfo.height > 0 ? mapInfo.height : 64
    const entries = editorTeleportEntries.filter(entry => entry.targetMap === draft.targetMap)
    const exits = dungeonExitsForMap(draft.targetMap)
    const withLandingDistance = entries
      .map(entry => ({ entry, distance: teleportDistance2d(draft.x, draft.z, entry.targetX, entry.targetZ) }))
      .sort((a, b) => a.distance - b.distance)
    const withExitDistance = exits
      .map(exit => {
        const landing = teleportExitLanding(exit)
        return { exit, landing, distance: teleportDistance2d(draft.x, draft.z, landing.x, landing.z) }
      })
      .sort((a, b) => a.distance - b.distance)
    const nearestLanding = withLandingDistance[0] || null
    const nearestExit = withExitDistance[0] || null
    const sourceX = selectedPlacedObject?.position?.x
    const sourceZ = selectedPlacedObject?.position?.z
    const nearbySources = Number.isFinite(sourceX) && Number.isFinite(sourceZ)
      ? editorTeleportEntries
        .filter(entry => entry.sourceMap === currentServerMapId)
        .map(entry => ({ entry, distance: teleportDistance2d(sourceX, sourceZ, entry.sourceX, entry.sourceZ) }))
        .filter(item => item.distance > 0.5)
        .sort((a, b) => a.distance - b.distance)
      : []
    const nearestSource = nearbySources[0] || null
    const sourceEntries = editorTeleportEntries.filter(entry => entry.sourceMap === currentServerMapId)
    renderTeleportSourceMapPreview(sourceCanvas, sourceMapSummary, sourceEntries, nearestSource)

    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const w = canvas.width
    const h = canvas.height
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = '#0d0d0d'
    ctx.fillRect(0, 0, w, h)
    const pad = 12
    const plotW = w - pad * 2
    const plotH = h - pad * 2
    const project = (x, z) => ({
      x: pad + Math.max(0, Math.min(1, x / width)) * plotW,
      y: pad + Math.max(0, Math.min(1, z / height)) * plotH,
    })
    ctx.strokeStyle = '#242424'
    ctx.lineWidth = 1
    for (let i = 0; i <= 4; i++) {
      const gx = pad + (plotW * i / 4)
      const gy = pad + (plotH * i / 4)
      ctx.beginPath(); ctx.moveTo(gx, pad); ctx.lineTo(gx, h - pad); ctx.stroke()
      ctx.beginPath(); ctx.moveTo(pad, gy); ctx.lineTo(w - pad, gy); ctx.stroke()
    }
    ctx.strokeStyle = '#555'
    ctx.strokeRect(pad, pad, plotW, plotH)
    for (const exit of exits) {
      const p = project(exit.x, exit.z)
      ctx.fillStyle = '#62c8ff'
      ctx.fillRect(p.x - 4, p.y - 4, 8, 8)
      ctx.strokeStyle = '#d8f4ff'
      ctx.lineWidth = 1
      ctx.strokeRect(p.x - 4.5, p.y - 4.5, 9, 9)
      const landing = teleportExitLanding(exit)
      if (Number.isFinite(landing.x) && Number.isFinite(landing.z) && teleportDistance2d(exit.x, exit.z, landing.x, landing.z) > 0.05) {
        const lp = project(landing.x, landing.z)
        ctx.beginPath()
        ctx.arc(lp.x, lp.y, 4, 0, Math.PI * 2)
        ctx.fillStyle = '#7ce8ff'
        ctx.fill()
        ctx.strokeStyle = '#ffffff'
        ctx.stroke()
        ctx.beginPath()
        ctx.moveTo(p.x, p.y)
        ctx.lineTo(lp.x, lp.y)
        ctx.strokeStyle = '#4aaed6'
        ctx.lineWidth = 1
        ctx.stroke()
      }
    }
    for (const entry of entries) {
      const p = project(entry.targetX, entry.targetZ)
      ctx.beginPath()
      ctx.arc(p.x, p.y, entry.custom ? 4 : 3, 0, Math.PI * 2)
      ctx.fillStyle = entry.custom ? '#ff6868' : '#c98542'
      ctx.fill()
    }
    const current = project(draft.x, draft.z)
    if (nearestLanding) {
      const near = project(nearestLanding.entry.targetX, nearestLanding.entry.targetZ)
      ctx.beginPath()
      ctx.moveTo(current.x, current.y)
      ctx.lineTo(near.x, near.y)
      ctx.strokeStyle = nearestLanding.distance < 1.5 ? '#ff6868' : '#ffd166'
      ctx.lineWidth = 2
      ctx.stroke()
    }
    if (nearestExit) {
      const nearExit = project(nearestExit.landing.x, nearestExit.landing.z)
      ctx.beginPath()
      ctx.moveTo(current.x, current.y)
      ctx.lineTo(nearExit.x, nearExit.y)
      ctx.strokeStyle = nearestExit.distance < 1.5 ? '#62c8ff' : '#73d7ff'
      ctx.lineWidth = 1
      ctx.stroke()
    }
    ctx.beginPath()
    ctx.arc(current.x, current.y, 6, 0, Math.PI * 2)
    ctx.strokeStyle = '#55f0a3'
    ctx.lineWidth = 2
    ctx.stroke()
    ctx.fillStyle = '#55f0a3'
    ctx.fillRect(current.x - 1, current.y - 1, 2, 2)

    const mapLabel = mapInfo?.name || draft.targetMap
    const coordLabel = `${formatTeleportNumber(draft.x)}, ${formatTeleportNumber(draft.y)}, ${formatTeleportNumber(draft.z)}`
    const entryOutOfBounds = draft.x < 0 || draft.x >= width || draft.z < 0 || draft.z >= height
    const exitPhrase = exits.length
      ? `${exits.length} placed exit${exits.length === 1 ? '' : 's'}`
      : 'no placed exits'
    if (entryOutOfBounds) {
      summary.style.color = '#ff9e9e'
      summary.textContent = `${mapLabel}: current entry ${coordLabel} is outside this ${width}x${height} map. Use a placed exit or choose an in-bounds tile.`
    } else if (!nearestLanding) {
      summary.style.color = '#a8d8ff'
      summary.textContent = `${mapLabel}: ${exitPhrase}. No saved landing points yet. Current entry ${coordLabel}.`
    } else {
      const distance = formatTeleportNumber(nearestLanding.distance)
      const nearestCoord = `${formatTeleportNumber(nearestLanding.entry.targetX)}, ${formatTeleportNumber(nearestLanding.entry.targetY ?? 0)}, ${formatTeleportNumber(nearestLanding.entry.targetZ)}`
      summary.style.color = nearestLanding.distance < 1.5 ? '#ff9e9e' : nearestLanding.distance < 8 ? '#ffd27a' : '#a8d8ff'
      summary.textContent = `${mapLabel}: ${entries.length} saved landing point${entries.length === 1 ? '' : 's'}, ${exitPhrase}. Nearest saved landing is ${distance} tiles away at ${nearestCoord}.`
    }

    sourceSummary.textContent = 'Green = current, square = exit object, blue dot = exit landing, red = custom saved, amber = default saved. Source grid uses 64-tile chunks.'

    const exitRows = withExitDistance.slice(0, 5).map(({ exit, landing, distance }) => {
      const target = `${formatTeleportNumber(landing.x)}, ${formatTeleportNumber(landing.y)}, ${formatTeleportNumber(landing.z)}`
      return `<div>${teleportHtml(formatTeleportNumber(distance))} tiles · ${teleportHtml(target)} · exit · ${teleportHtml(teleportExitLabel(exit))}</div>`
    })
    const landingRows = withLandingDistance.slice(0, 5).map(({ entry, distance }) => {
      const target = `${formatTeleportNumber(entry.targetX)}, ${formatTeleportNumber(entry.targetY ?? 0)}, ${formatTeleportNumber(entry.targetZ)}`
      return `<div>${teleportHtml(formatTeleportNumber(distance))} tiles · ${teleportHtml(target)} · ${teleportHtml(teleportEntryLabel(entry))}</div>`
    })
    list.innerHTML = [
      exitRows.length ? `<div style="color:#84d4ff;">Placed exits</div>${exitRows.join('')}` : '',
      landingRows.length ? `<div style="color:#d7b273;margin-top:4px;">Saved landing points</div>${landingRows.join('')}` : '',
    ].filter(Boolean).join('') || '<div>No saved exits or entries for this destination map.</div>'
  }
  function getAllPlacedLadders() {
    return placedGroup.getChildren().filter(isLadderPlacedObject)
  }
  // The tile where the player must stand to interact with this ladder.
  // Honours the editor's "Interaction tiles" grid: takes the first picked
  // local-frame tile, rotates by the ladder's rotY (quantised to 90°), and
  // translates to world coords. Falls back to the +Z neighbour when no tile
  // was picked, matching the convention used by the existing maps.
  function ladderInteractionTile(obj) {
    if (!obj) return null
    const baseX = Math.floor(obj.position.x)
    const baseZ = Math.floor(obj.position.z)
    const picked = typeof currentInteractionTiles === 'function' ? currentInteractionTiles(obj) : []
    if (!picked.length) return { x: baseX, z: baseZ + 1 }
    let rotY = obj.rotation?.y || 0
    if (obj.rotationQuaternion) rotY = obj.rotationQuaternion.toEulerAngles().y
    const q = (((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4)
    const tile = picked[0]
    let rx = tile.x, rz = tile.z
    if (q === 1) { rx = tile.z; rz = -tile.x }
    else if (q === 2) { rx = -tile.x; rz = -tile.z }
    else if (q === 3) { rx = -tile.z; rz = tile.x }
    return { x: baseX + rx, z: baseZ + rz }
  }

  function ladderFloorTargetAt(tile, floor) {
    if (!tile) return null
    const tx = Math.floor(tile.x)
    const tz = Math.floor(tile.z)
    if (tx < 0 || tz < 0 || tx >= map.width || tz >= map.height) return null
    const idx = tz * map.width + tx
    if (floor <= 0) {
      const tileData = map.getTile(tx, tz)
      if (!tileData) return null
      const tileType = classifyTileType(tileData, map.getTileCornerHeights(tx, tz), map.getTileWaterLevel(tx, tz))
      const rootFloorH = collisionData.floors?.[`${tx},${tz}`]
      if (!BLOCKING_TILES.has(tileType)) return { floor: 0, y: map.getAverageTileHeight(tx, tz) }
      if (Number.isFinite(rootFloorH)) return { floor: 0, y: rootFloorH }
      return null
    }

    const visualMaps = buildCollisionFloorVisualMaps()
    const y =
      visualMaps.explicit.get(floor)?.get(idx)
      ?? visualMaps.derived.get(floor)?.get(idx)
      ?? visualMaps.ranked.get(idx)?.[floor - 1]
    return Number.isFinite(y) ? { floor, y } : null
  }

  function ladderEndpointForTileFloor(tile, floor) {
    const target = ladderFloorTargetAt(tile, floor)
    if (!target) return null
    return { x: tile.x + 0.5, z: tile.z + 0.5, floor, y: target.y }
  }

  // Returns null if the ladder is properly wired, otherwise a short reason.
  // "Properly wired" = every link's `to` resolves to a partner ladder that
  // has a matching reciprocal link back, OR a single-object bidirectional
  // self-pair (both directions on the same placement).
  function ladderBrokenReason(obj, allLadders) {
    const links = obj?.userData?.verticalLinks || []
    if (links.length === 0) return 'no links'
    const ladders = allLadders || getAllPlacedLadders()
    for (const link of links) {
      const to = link?.to
      if (!to || !Number.isFinite(to.x) || !Number.isFinite(to.z) || !Number.isFinite(to.floor)) return 'malformed link'
      const tx = Math.floor(to.x); const tz = Math.floor(to.z)
      if (!ladderFloorTargetAt({ x: tx, z: tz }, to.floor)) return `floor ${to.floor} missing at destination`
      const frm = link.from
      if (!frm || !Number.isFinite(frm.x) || !Number.isFinite(frm.z) || !Number.isFinite(frm.floor)) return 'malformed link'
      if (!ladderFloorTargetAt({ x: Math.floor(frm.x), z: Math.floor(frm.z) }, frm.floor)) return `floor ${frm.floor} missing at source`
      const reciprocal = ladders.some(L => (L.userData?.verticalLinks || []).some(rl =>
        rl?.from && Math.floor(rl.from.x) === tx && Math.floor(rl.from.z) === tz && rl.from.floor === to.floor
        && rl?.to && Math.floor(rl.to.x) === Math.floor(frm.x) && Math.floor(rl.to.z) === Math.floor(frm.z) && rl.to.floor === frm.floor
      ))
      if (!reciprocal) return 'one-way (no return)'
    }
    return null
  }

  let pendingLadderWireSource = null
  let brokenLadderIndicators = []
  let ladderIndicatorMat = null

  function getLadderIndicatorMaterial() {
    if (ladderIndicatorMat) return ladderIndicatorMat
    const mat = new StandardMaterial('brokenLadderMat', scene)
    mat.emissiveColor = new Color3(1, 0.15, 0.15)
    mat.diffuseColor = new Color3(0, 0, 0)
    mat.specularColor = new Color3(0, 0, 0)
    mat.alpha = 0.78
    mat.disableLighting = true
    mat.backFaceCulling = false
    ladderIndicatorMat = mat
    return mat
  }

  function disposeBrokenLadderIndicators() {
    for (const m of brokenLadderIndicators) m?.dispose?.()
    brokenLadderIndicators = []
  }

  // Always-on red beam above any ladder with broken/missing links. Refreshed
  // after map load, save, ladder edits, and wire-flow completion.
  function refreshBrokenLadderIndicators() {
    disposeBrokenLadderIndicators()
    const ladders = getAllPlacedLadders()
    if (ladders.length === 0) return
    const mat = getLadderIndicatorMaterial()
    for (const L of ladders) {
      if (!ladderBrokenReason(L, ladders)) continue
      const beam = MeshBuilder.CreateCylinder(`brokenLadderBeam_${L.uniqueId}`, {
        height: 8,
        diameterTop: 0.35,
        diameterBottom: 0.35,
        tessellation: 12,
      }, scene)
      beam.material = mat
      beam.position.set(L.position.x, L.position.y + 4, L.position.z)
      beam.isPickable = false
      beam.renderingGroupId = 1
      brokenLadderIndicators.push(beam)
    }
  }

  function describeLadderEndpoint(ep) {
    if (!ep) return '?'
    return `(${Math.floor(ep.x)},${Math.floor(ep.z)}) F${ep.floor}`
  }

  function renderLadderWiringPanel(obj) {
    if (!obj) return
    const statusEl = sidebar.querySelector('#ladderWiringStatus')
    const listEl = sidebar.querySelector('#ladderLinksList')
    const wireBtn = sidebar.querySelector('#ladderWireToBtn')
    const reason = ladderBrokenReason(obj)
    if (pendingLadderWireSource === obj) {
      statusEl.innerHTML = '<span style="color:#ffd28a;">Click another link object to pair (Esc to cancel)</span>'
    } else if (!reason) {
      statusEl.innerHTML = `<span style="color:#8fdc8f;">✓ Wired (${(obj.userData.verticalLinks||[]).length} link${(obj.userData.verticalLinks||[]).length===1?'':'s'})</span>`
    } else {
      statusEl.innerHTML = `<span style="color:#ff9090;">⚠ ${reason}</span>`
    }
    if (wireBtn) wireBtn.textContent = pendingLadderWireSource === obj ? 'Cancel wiring' : 'Wire to another link object...'
    const links = obj.userData.verticalLinks || []
    listEl.innerHTML = links.length === 0
      ? '<em style="color:#666;">(no links)</em>'
      : links.map((l, i) => `${i + 1}. <b>${l.fromAction || 'Climb'}</b> ${describeLadderEndpoint(l.from)} → ${describeLadderEndpoint(l.to)}`).join('<br>')
  }

  // Make a ladder fully self-bidirectional at its OWN interaction tile, so it
  // works from both floors regardless of which way the player is travelling.
  // Matches the working chunk_7_4 pattern: one placement, two reciprocal links
  // sharing the same X/Z, only differing in `from.floor`.
  function makeLadderSelfBidirectional(obj, fromFloor, toFloor) {
    if (!obj || fromFloor === toFloor) return false
    const tile = ladderInteractionTile(obj)
    const from = ladderEndpointForTileFloor(tile, fromFloor)
    const to = ladderEndpointForTileFloor(tile, toFloor)
    if (!from || !to) {
      showEditorNotice(`No walkable floor ${!from ? fromFloor : toFloor} at this ladder's interaction tile.`, 'error')
      return false
    }
    obj.userData.verticalLinks = [
      {
        from: { ...from },
        to: { ...to },
        fromAction: fromFloor < toFloor ? 'Climb-up' : 'Climb-down',
      },
      {
        from: { ...to },
        to: { ...from },
        fromAction: toFloor < fromFloor ? 'Climb-up' : 'Climb-down',
      },
    ]
    return true
  }
  // "Wire to another ladder" — convenience action that makes both selected
  // ladders fully self-bidirectional in one click. They function as independent
  // vertical portals at their own tiles (each works from both floors), so the
  // player can use either entry point.
  function wireLadderPair(a, b, fromFloor, toFloor) {
    if (!a || !b || fromFloor === toFloor) return false
    const okA = makeLadderSelfBidirectional(a, fromFloor, toFloor)
    const okB = b === a ? okA : makeLadderSelfBidirectional(b, fromFloor, toFloor)
    return okA && okB
  }

  function cancelPendingLadderWire() {
    pendingLadderWireSource = null
    if (selectedPlacedObject && isLadderPlacedObject(selectedPlacedObject)) renderLadderWiringPanel(selectedPlacedObject)
  }

  function attachLadderWiringHandlers() {
    const wireBtn = sidebar.querySelector('#ladderWireToBtn')
    const selfBtn = sidebar.querySelector('#ladderSelfBidiBtn')
    const clearBtn = sidebar.querySelector('#ladderClearLinksBtn')
    const fromSel = sidebar.querySelector('#ladderFloorSelect')
    const toSel = sidebar.querySelector('#ladderTargetFloorSelect')
    wireBtn?.addEventListener('click', () => {
      if (!selectedPlacedObject || !isLadderPlacedObject(selectedPlacedObject)) return
      if (pendingLadderWireSource === selectedPlacedObject) {
        cancelPendingLadderWire()
        return
      }
      pendingLadderWireSource = selectedPlacedObject
      renderLadderWiringPanel(selectedPlacedObject)
    })
    selfBtn?.addEventListener('click', () => {
      if (!selectedPlacedObject || !isLadderPlacedObject(selectedPlacedObject)) return
      const from = parseInt(fromSel.value, 10) | 0
      const to = parseInt(toSel.value, 10) | 0
      if (from === to) { window.alert('Source and target floor must differ.'); return }
      wireLadderPair(selectedPlacedObject, selectedPlacedObject, from, to)
      refreshBrokenLadderIndicators()
      renderLadderWiringPanel(selectedPlacedObject)
    })
    clearBtn?.addEventListener('click', () => {
      if (!selectedPlacedObject || !isLadderPlacedObject(selectedPlacedObject)) return
      if (!window.confirm('Clear all vertical links on this object?')) return
      selectedPlacedObject.userData.verticalLinks = []
      refreshBrokenLadderIndicators()
      renderLadderWiringPanel(selectedPlacedObject)
    })
  }
  attachLadderWiringHandlers()
  const doorDefaultOpenInput = sidebar.querySelector('#doorDefaultOpenInput')
  doorDefaultOpenInput?.addEventListener('change', () => {
    if (!selectedPlacedObject || !isDoorPlacedObject(selectedPlacedObject)) return
    if (doorDefaultOpenInput.checked) selectedPlacedObject.userData.defaultOpen = true
    else delete selectedPlacedObject.userData.defaultOpen
    updateSelectionHelper()
  })
  const doorOpenDirectionSelect = sidebar.querySelector('#doorOpenDirectionSelect')
  doorOpenDirectionSelect?.addEventListener('change', () => {
    if (!selectedPlacedObject || !isDoorPlacedObject(selectedPlacedObject)) return
    const dir = parseInt(doorOpenDirectionSelect.value, 10) === 1 ? 1 : -1
    if (dir === 1) selectedPlacedObject.userData.openDirection = 1
    else delete selectedPlacedObject.userData.openDirection
    updateSelectionHelper()
  })
  const doorLockedInput = sidebar.querySelector('#doorLockedInput')
  doorLockedInput?.addEventListener('change', () => {
    if (!selectedPlacedObject || !isDoorPlacedObject(selectedPlacedObject)) return
    if (doorLockedInput.checked) selectedPlacedObject.userData.locked = true
    else {
      delete selectedPlacedObject.userData.locked
      delete selectedPlacedObject.userData.keyItemId
      delete selectedPlacedObject.userData.consumeKey
      delete selectedPlacedObject.userData.lockedMessage
    }
    updateSelectionHelper()
  })
  const doorKeyItemInput = sidebar.querySelector('#doorKeyItemInput')
  doorKeyItemInput?.addEventListener('change', () => {
    if (!selectedPlacedObject || !isDoorPlacedObject(selectedPlacedObject)) return
    const id = parseItemIdFromDisplay(doorKeyItemInput.value)
    if (id > 0) {
      selectedPlacedObject.userData.locked = true
      selectedPlacedObject.userData.keyItemId = id
      doorKeyItemInput.value = formatItemDisplay(id)
    } else {
      delete selectedPlacedObject.userData.keyItemId
      doorKeyItemInput.value = ''
    }
    updateSelectionHelper()
  })
  const doorConsumeKeyInput = sidebar.querySelector('#doorConsumeKeyInput')
  doorConsumeKeyInput?.addEventListener('change', () => {
    if (!selectedPlacedObject || !isDoorPlacedObject(selectedPlacedObject)) return
    if (doorConsumeKeyInput.checked) selectedPlacedObject.userData.consumeKey = true
    else delete selectedPlacedObject.userData.consumeKey
    updateSelectionHelper()
  })
  const doorLockedMessageInput = sidebar.querySelector('#doorLockedMessageInput')
  doorLockedMessageInput?.addEventListener('input', () => {
    if (!selectedPlacedObject || !isDoorPlacedObject(selectedPlacedObject)) return
    const message = doorLockedMessageInput.value.trim()
    if (message) selectedPlacedObject.userData.lockedMessage = message
    else delete selectedPlacedObject.userData.lockedMessage
  })
  const altarTierSelect = sidebar.querySelector('#altarTierSelect')
  altarTierSelect?.addEventListener('change', () => {
    if (!selectedPlacedObject || !isAltarPlacedObject(selectedPlacedObject)) return
    const tier = Math.max(1, Math.floor(Number(altarTierSelect.value) || 1))
    selectedPlacedObject.userData.altarTier = tier
    updateSelectionHelper()
  })
  function saveObjectQuestFieldsFromUI() {
    if (!selectedPlacedObject) return
    const examineText = sidebar.querySelector('#objectExamineText')?.value.trim() || ''
    if (examineText) selectedPlacedObject.userData.examineText = examineText
    else delete selectedPlacedObject.userData.examineText

    const action = sidebar.querySelector('#objectEffectAction')?.value.trim() || ''
    syncObjectSayRowsToTextarea()
    const sayRaw = sidebar.querySelector('#objectEffectSay')?.value.trim() || ''
    const saySequence = parseObjectSaySequence(sayRaw)
    const message = sidebar.querySelector('#objectEffectMessage')?.value.trim() || ''
    const existing = selectedPlacedObject.userData.interactions?.[0] || {}
    const hasServerEffects = !!(existing.effects?.length || existing.condition || existing.conditions?.length || existing.depleteObject)
    if (action && (saySequence.length > 0 || message || hasServerEffects)) {
      const next = { ...existing, action }
      if (saySequence.length) next.saySequence = saySequence
      else delete next.saySequence
      if (message) next.message = message
      else delete next.message
      selectedPlacedObject.userData.interactions = [next]
    } else {
      delete selectedPlacedObject.userData.interactions
    }
  }
  function parseObjectSaySequence(raw) {
    return String(raw || '')
      .split(/\r?\n/)
      .map((line, idx) => {
        const text = line.trim()
        if (!text) return null
        const match = text.match(/^(\d+(?:\.\d+)?)\s*(?:s|sec|secs|seconds)?\s*[|:]\s*(.+)$/i)
        if (match) return { delaySeconds: Math.min(30, parseFloat(match[1]) || 0), text: match[2].trim() }
        return { delaySeconds: idx * 3, text }
      })
      .filter(line => line && line.text)
  }
  function getNextObjectSayDelay(raw) {
    const sequence = parseObjectSaySequence(raw)
    if (sequence.length === 0) return 0
    return Math.min(30, Math.max(...sequence.map(line => line.delaySeconds ?? 0)) + 3)
  }
  function syncObjectSayRowsToTextarea() {
    const rows = sidebar.querySelector('#objectEffectSayRows')
    const textarea = sidebar.querySelector('#objectEffectSay')
    if (!rows || !textarea) return
    const lines = [...rows.querySelectorAll('.object-say-row')]
      .map(row => {
        const delay = Math.min(30, Math.max(0, parseFloat(row.querySelector('.object-say-delay')?.value) || 0))
        const text = row.querySelector('.object-say-text')?.value.trim() || ''
        return text ? `${delay} | ${text}` : ''
      })
      .filter(Boolean)
    textarea.value = lines.join('\n')
  }
  function renderObjectSayRows(sequence) {
    const rows = sidebar.querySelector('#objectEffectSayRows')
    const textarea = sidebar.querySelector('#objectEffectSay')
    if (!rows || !textarea) return
    rows.innerHTML = ''
    for (const line of sequence) addObjectSayRow(line.delaySeconds ?? 0, line.text || '', { skipSave: true })
    syncObjectSayRowsToTextarea()
  }
  function addObjectSayRow(delaySeconds = 0, text = '', opts = {}) {
    const rows = sidebar.querySelector('#objectEffectSayRows')
    if (!rows) return
    const row = document.createElement('div')
    row.className = 'object-say-row'
    row.style.cssText = 'display:grid;grid-template-columns:44px 1fr 24px;gap:4px;align-items:center;'

    const delay = document.createElement('input')
    delay.className = 'object-say-delay'
    delay.type = 'number'
    delay.min = '0'
    delay.max = '30'
    delay.step = '0.5'
    delay.value = `${delaySeconds}`
    delay.title = 'Delay in seconds'
    delay.style.cssText = 'width:100%;box-sizing:border-box;font-size:11px;'

    const message = document.createElement('input')
    message.className = 'object-say-text'
    message.type = 'text'
    message.placeholder = 'Player chat text'
    message.value = text
    message.style.cssText = 'width:100%;box-sizing:border-box;font-size:11px;'

    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = 'x'
    remove.title = 'Remove line'
    remove.style.cssText = 'width:24px;height:22px;padding:0;font-size:11px;'

    const onChange = () => {
      syncObjectSayRowsToTextarea()
      saveObjectQuestFieldsFromUI()
    }
    delay.addEventListener('input', onChange)
    message.addEventListener('input', onChange)
    remove.addEventListener('click', () => {
      row.remove()
      onChange()
    })

    row.append(delay, message, remove)
    rows.appendChild(row)
    if (!opts.skipSave) onChange()
    return row
  }
  function formatObjectSaySequence(effect) {
    if (!effect) return ''
    if (Array.isArray(effect.saySequence)) {
      return effect.saySequence
        .filter(line => line && typeof line.text === 'string')
        .map(line => `${line.delaySeconds ?? 0} | ${line.text}`)
        .join('\n')
    }
    return effect.say || ''
  }
  let objectSayRowsRenderKey = ''
  let interactionTilesRenderKey = ''
  for (const id of ['#objectExamineText', '#objectEffectAction', '#objectEffectSay', '#objectEffectMessage']) {
    sidebar.querySelector(id)?.addEventListener('input', saveObjectQuestFieldsFromUI)
  }
  sidebar.querySelector('#objectEffectAddSayLine')?.addEventListener('click', () => {
    syncObjectSayRowsToTextarea()
    const say = sidebar.querySelector('#objectEffectSay')
    const delay = getNextObjectSayDelay(say?.value || '')
    const row = addObjectSayRow(delay, '')
    row?.querySelector('.object-say-text')?.focus()
  })

  // Trigger metadata handlers
  function saveTriggerFromUI() {
    if (!selectedPlacedObject) return
    const type = sidebar.querySelector('#triggerType').value
    if (!type) {
      delete selectedPlacedObject.userData.trigger
      renderTeleportOccupancyPreview()
      return
    }
    const destChunk = sidebar.querySelector('#triggerDestChunk').value.trim()
    if (!destChunk) {
      delete selectedPlacedObject.userData.trigger
      renderTeleportOccupancyPreview()
      return
    }
    const entryX = parseFloat(sidebar.querySelector('#triggerEntryX').value)
    const entryY = parseFloat(sidebar.querySelector('#triggerEntryY').value)
    const entryZ = parseFloat(sidebar.querySelector('#triggerEntryZ').value)
    const fallback = defaultTeleportEntry(destChunk)
    selectedPlacedObject.userData.trigger = {
      type,
      destChunk,
      entryX: Number.isFinite(entryX) ? entryX : fallback.x,
      entryY: Number.isFinite(entryY) ? entryY : fallback.y,
      entryZ: Number.isFinite(entryZ) ? entryZ : fallback.z
    }
    renderTeleportOccupancyPreview()
  }

  sidebar.querySelector('#triggerType').addEventListener('change', () => {
    const isTP = sidebar.querySelector('#triggerType').value === 'teleport'
    sidebar.querySelector('#triggerTeleportFields').style.display = isTP ? 'block' : 'none'
    if (isTP) ensureTeleportDefaultsInUI()
    saveTriggerFromUI()
    updateToolUI()
  })

  for (const id of ['#triggerDestChunk', '#triggerEntryX', '#triggerEntryY', '#triggerEntryZ']) {
    sidebar.querySelector(id).addEventListener('input', saveTriggerFromUI)
    sidebar.querySelector(id).addEventListener('change', saveTriggerFromUI)
  }
  sidebar.querySelector('#triggerUseMapCenterBtn')?.addEventListener('click', fillTeleportEntryFromMapCenter)
  sidebar.querySelector('#triggerUseDungeonExitBtn')?.addEventListener('click', fillTeleportEntryFromDungeonExit)

  function placedObjectWidth(obj) {
    const defId = obj ? ASSET_TO_OBJECT_DEF[obj.userData?.assetId] : null
    if (defId == null) return 1
    const def = editorObjectDefById.get(defId)
    return Math.max(1, Math.round(def?.width ?? 1))
  }
  function normalizeInteractionTiles(tiles) {
    const seen = new Set()
    const out = []
    for (const tile of Array.isArray(tiles) ? tiles : []) {
      const x = Math.round(Number(tile?.x))
      const z = Math.round(Number(tile?.z))
      if (!Number.isFinite(x) || !Number.isFinite(z)) continue
      const key = `${x},${z}`
      if (seen.has(key)) continue
      seen.add(key)
      out.push({ x, z })
    }
    return out
  }
  function currentInteractionTiles(obj) {
    const explicit = normalizeInteractionTiles(obj?.userData?.interactionTiles)
    if (explicit.length) return explicit
    const W = placedObjectWidth(obj)
    const mask = obj?.userData?.interactionSides | 0
    if (!mask) return []
    return localAdjacentTilesOrdered(W).filter((_, bit) => (mask & (1 << bit)) !== 0)
  }
  function setInteractionTiles(tiles, opts = {}) {
    if (!selectedPlacedObject) return
    const normalized = normalizeInteractionTiles(tiles)
    delete selectedPlacedObject.userData.interactionSides
    if (normalized.length) selectedPlacedObject.userData.interactionTiles = normalized
    else delete selectedPlacedObject.userData.interactionTiles
    interactionTilesRenderKey = ''
    if (opts.rerender !== false) renderInteractionTilesGrid()
    updateSelectionHelper()
    // For ladders, link.from carries the player-stand tile, so a stale link
    // ignores any newly picked interaction tile. Re-derive in place so the
    // chosen tile is the one the server actually paths the player to.
    if (typeof isLadderPlacedObject === 'function' && isLadderPlacedObject(selectedPlacedObject)) {
      const links = selectedPlacedObject.userData?.verticalLinks
      if (Array.isArray(links) && links.length > 0) {
        rewireLadderInteractionTileInPlace(selectedPlacedObject)
        if (typeof refreshBrokenLadderIndicators === 'function') refreshBrokenLadderIndicators()
        if (typeof renderLadderWiringPanel === 'function') renderLadderWiringPanel(selectedPlacedObject)
      }
    }
  }
  // Update an already-wired ladder's link.from/to X/Z to match the current
  // interactionTiles, without touching the floor pairs already chosen.
  // Also refreshes each endpoint's `y` so the server can expose the climb
  // action immediately after a save/reload.
  function rewireLadderInteractionTileInPlace(obj) {
    if (!obj) return
    const tile = ladderInteractionTile(obj)
    const links = obj.userData?.verticalLinks || []
    for (const link of links) {
      if (link?.from) {
        const next = ladderEndpointForTileFloor(tile, link.from.floor)
        link.from.x = tile.x + 0.5
        link.from.z = tile.z + 0.5
        if (next) link.from.y = next.y
        else delete link.from.y
      }
      if (link?.to) {
        const next = ladderEndpointForTileFloor(tile, link.to.floor)
        link.to.x = tile.x + 0.5
        link.to.z = tile.z + 0.5
        if (next) link.to.y = next.y
        else delete link.to.y
      }
    }
  }
  function renderInteractionTilesGrid() {
    const container = sidebar.querySelector('#interactionTilesGrid')
    if (!container || !selectedPlacedObject) return
    const W = placedObjectWidth(selectedPlacedObject)
    const selectedTiles = currentInteractionTiles(selectedPlacedObject)
    const renderKey = `${selectedPlacedObject.uniqueId ?? selectedPlacedObject.id ?? selectedPlacedObject.name}|${W}|${JSON.stringify(selectedTiles)}`
    if (renderKey === interactionTilesRenderKey) return
    interactionTilesRenderKey = renderKey
    const selectedKeys = new Set(selectedTiles.map(t => `${t.x},${t.z}`))
    const summary = sidebar.querySelector('#interactionTilesSummary')
    const selectedCount = selectedTiles.length
    if (summary) {
      summary.textContent = selectedCount === 0
        ? 'Any adjacent perimeter tile is valid.'
        : `${selectedCount} required tile${selectedCount === 1 ? '' : 's'} selected.`
    }
    const cell = 24
    const gap = 2
    const pad = 2
    const gridSize = W + pad * 2
    const startOff = getObjectFootprintMinTile(0, W)
    const footMin = startOff
    const footMax = startOff + W - 1
    const gridMin = footMin - pad
    const gridMax = footMax + pad
    container.innerHTML = ''
    container.style.cssText = `display:grid;gap:${gap}px;grid-template-columns:repeat(${gridSize},${cell}px);grid-template-rows:repeat(${gridSize},${cell}px);`
    for (let row = 0; row < gridSize; row++) {
      for (let col = 0; col < gridSize; col++) {
        const lx = gridMin + col
        const lz = gridMax - row
        const div = document.createElement('div')
        div.style.cssText = `width:${cell}px;height:${cell}px;box-sizing:border-box;font-size:9px;display:flex;align-items:center;justify-content:center;`
        const isFootprint = lx >= footMin && lx <= footMax && lz >= footMin && lz <= footMax
        if (isFootprint) {
          div.style.background = '#444'
          div.style.border = '1px solid #222'
          if (lz === footMax && lx === Math.floor((footMin + footMax) / 2)) {
            div.textContent = '↑'
            div.style.color = '#aaa'
          }
        } else {
          const key = `${lx},${lz}`
          const on = selectedKeys.has(key)
          div.style.background = on ? '#0a7' : '#1a1a1a'
          div.style.border = on ? '1px solid #0fa' : '1px solid #444'
          div.style.cursor = 'pointer'
          div.title = on ? 'Required use tile' : 'Click to require this use tile'
          div.addEventListener('click', () => {
            const next = selectedTiles.filter(t => !(t.x === lx && t.z === lz))
            if (!on) next.push({ x: lx, z: lz })
            setInteractionTiles(next)
          })
        }
        container.appendChild(div)
      }
    }
  }
  // Quick-set buttons. "Front center" is the common case for furnaces / ranges.
  sidebar.querySelector('#interactSidesAll')?.addEventListener('click', () => {
    if (!selectedPlacedObject) return
    const W = placedObjectWidth(selectedPlacedObject)
    setInteractionTiles(localAdjacentTilesOrdered(W))
  })
  sidebar.querySelector('#interactSidesNone')?.addEventListener('click', () => setInteractionTiles([]))
  sidebar.querySelector('#interactSidesFrontCenter')?.addEventListener('click', () => {
    if (!selectedPlacedObject) return
    const W = placedObjectWidth(selectedPlacedObject)
    const startOff = getObjectFootprintMinTile(0, W)
    setInteractionTiles([{ x: startOff + Math.floor(W / 2), z: startOff + W }])
  })
  sidebar.querySelector('#interactSidesFront')?.addEventListener('click', () => {
    if (!selectedPlacedObject) return
    const W = placedObjectWidth(selectedPlacedObject)
    setInteractionTiles(localAdjacentTilesOrdered(W).slice(0, W))
  })

  const replaceBtnEl = sidebar.querySelector('#replaceBtn')
  const replacePanel = sidebar.querySelector('#replacePanel')
  const replaceSearchEl = sidebar.querySelector('#replaceSearch')
  const replaceGridEl = sidebar.querySelector('#replaceGrid')
  sidebar.querySelector('#clearSelectionBtn')?.addEventListener('click', clearSelection)

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
    { id: 'surface-water', label: 'Water', color: '#7ab8c8' },
  ]

  const GROUND_TYPES_DUNGEON = [
    { id: 'void',              label: 'Void',        color: '#050505' },
    { id: 'dungeon-floor',     label: 'Stone Floor', color: '#3a2e20' },
    { id: 'dungeon-stone',     label: 'Grey Stone',  color: '#5c5c58' },
    { id: 'dungeon-slate',     label: 'Slate',       color: '#3e4a51' },
    { id: 'dungeon-rubble',    label: 'Rubble',      color: '#4d453a' },
    { id: 'dungeon-basalt',    label: 'Basalt',      color: '#222226' },
    { id: 'dungeon-moss',      label: 'Mossy Floor', color: '#2e472b' },
    { id: 'dungeon-torchlight', label: 'Torch Glow', color: '#a36529' },
    { id: 'dungeon-rock',      label: 'Rock Cliff',  color: '#4a3828' },
    { id: 'dungeon-grey-rock', label: 'Grey Cliff',  color: '#515452' },
    { id: 'dungeon-dark-rock', label: 'Dark Cliff',  color: '#201d1b' },
    { id: 'dirt',              label: 'Dirt',        color: '#7a5030' },
    { id: 'water',             label: 'Mud',         color: '#5a3d1a' },
    { id: 'surface-water',     label: 'Water',       color: '#7ab8c8' },
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
    const createBridgeCheckbox = sidebar.querySelector('#toggleTexturePlaneBridge')
    if (createBridgeCheckbox) createBridgeCheckbox.checked = texturePlaneBridge

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

    // Show size slider for every active painted texture. Half-tile painting
    // still uses textureScale even when the texture is not world-UV/stretched.
    if (paintTextureScaleRow) {
      const hasPaintTexture = (paintTabTextureId && paintTabTextureId !== '__erase__') || !!paintTabTextureIdB
      const showScale = state.tool === ToolMode.PAINT && hasPaintTexture
      paintTextureScaleRow.style.display = showScale ? 'block' : 'none'
    }
    if (state.tool === ToolMode.TEXTURE_PLANE) {
      status += ` · ${diagFloorMode ? 'diagonal floor' : texturePlaneVertical ? 'vertical' : 'horizontal'}`
      if (texturePlaneBridge) status += ' · bridge'
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
      status += ` · ${npcPlacementMode}`
      if (selectedNpcSpawn) status += ' · Spawn selected'
    }
    if (selectedTexturePlane) status += ` · Plane: ${selectedTexturePlane.textureId}`
    if (selectedPlacedObject) status += ' · Object selected'

    const tileSizeRow = sidebar.querySelector('#tileSizeRow')
    if (tileSizeRow) {
      tileSizeRow.style.display = (state.tool === ToolMode.SELECT && selectedPlacedObject) ? 'block' : 'none'
    }
    const objectNameRow = sidebar.querySelector('#objectNameRow')
    if (objectNameRow) {
      const showObjectName = state.tool === ToolMode.SELECT && selectedPlacedObject
      objectNameRow.style.display = showObjectName ? 'block' : 'none'
      const input = sidebar.querySelector('#objectNameInput')
      if (showObjectName && input && document.activeElement !== input) {
        input.value = selectedPlacedObject.userData.name || ''
      }
      const examine = sidebar.querySelector('#objectExamineText')
      const action = sidebar.querySelector('#objectEffectAction')
      const say = sidebar.querySelector('#objectEffectSay')
      const sayRows = sidebar.querySelector('#objectEffectSayRows')
      const addSayLine = sidebar.querySelector('#objectEffectAddSayLine')
      const message = sidebar.querySelector('#objectEffectMessage')
      const effect = selectedPlacedObject?.userData?.interactions?.[0] || null
      const doorLabel = sidebar.querySelector('#doorDefaultOpenLabel')
      const doorInput = sidebar.querySelector('#doorDefaultOpenInput')
      const doorDirectionLabel = sidebar.querySelector('#doorOpenDirectionLabel')
      const doorDirectionSelect = sidebar.querySelector('#doorOpenDirectionSelect')
      const doorLockedFields = sidebar.querySelector('#doorLockedFields')
      const doorLockedInput = sidebar.querySelector('#doorLockedInput')
      const doorKeyItemInput = sidebar.querySelector('#doorKeyItemInput')
      const doorConsumeKeyInput = sidebar.querySelector('#doorConsumeKeyInput')
      const doorLockedMessageInput = sidebar.querySelector('#doorLockedMessageInput')
      const altarTierLabel = sidebar.querySelector('#altarTierLabel')
      const altarTierSelect = sidebar.querySelector('#altarTierSelect')
      const showDoorDefault = showObjectName && isDoorPlacedObject(selectedPlacedObject)
      const showAltarTier = showObjectName && isAltarPlacedObject(selectedPlacedObject)
      if (doorLabel) doorLabel.style.display = showDoorDefault ? 'flex' : 'none'
      if (doorDirectionLabel) doorDirectionLabel.style.display = showDoorDefault ? 'block' : 'none'
      if (doorLockedFields) doorLockedFields.style.display = showDoorDefault ? 'block' : 'none'
      if (altarTierLabel) altarTierLabel.style.display = showAltarTier ? 'block' : 'none'
      if (showDoorDefault && doorInput && document.activeElement !== doorInput) {
        doorInput.checked = selectedPlacedObject.userData.defaultOpen === true
      }
      if (showDoorDefault && doorDirectionSelect && document.activeElement !== doorDirectionSelect) {
        doorDirectionSelect.value = selectedPlacedObject.userData.openDirection === 1 ? '1' : '-1'
      }
      if (showDoorDefault && doorLockedInput && document.activeElement !== doorLockedInput) {
        doorLockedInput.checked = selectedPlacedObject.userData.locked === true
      }
      if (showDoorDefault && doorKeyItemInput && document.activeElement !== doorKeyItemInput) {
        doorKeyItemInput.value = formatItemDisplay(selectedPlacedObject.userData.keyItemId || 0)
      }
      if (showDoorDefault && doorConsumeKeyInput && document.activeElement !== doorConsumeKeyInput) {
        doorConsumeKeyInput.checked = selectedPlacedObject.userData.consumeKey === true
      }
      if (showDoorDefault && doorLockedMessageInput && document.activeElement !== doorLockedMessageInput) {
        doorLockedMessageInput.value = selectedPlacedObject.userData.lockedMessage || ''
      }
      if (showAltarTier && altarTierSelect && document.activeElement !== altarTierSelect) {
        altarTierSelect.value = String(Math.max(1, Math.floor(selectedPlacedObject.userData.altarTier || 1)))
      }
      const ladderWiringRow = sidebar.querySelector('#ladderWiringRow')
      const showLadderUI = showObjectName && isLadderPlacedObject(selectedPlacedObject)
      if (ladderWiringRow) {
        ladderWiringRow.style.display = showLadderUI ? 'block' : 'none'
        if (showLadderUI) renderLadderWiringPanel(selectedPlacedObject)
      }
      if (showObjectName && examine && document.activeElement !== examine) examine.value = selectedPlacedObject.userData.examineText || ''
      if (showObjectName && action && document.activeElement !== action) action.value = effect?.action || 'Examine'
      if (showObjectName && say && sayRows && !sayRows.contains(document.activeElement)) {
        const nextSay = formatObjectSaySequence(effect)
        const renderKey = `${selectedPlacedObject.uniqueId ?? selectedPlacedObject.id ?? selectedPlacedObject.name}|${nextSay}`
        if (renderKey !== objectSayRowsRenderKey) {
          objectSayRowsRenderKey = renderKey
          say.value = nextSay
          renderObjectSayRows(parseObjectSaySequence(nextSay))
        }
      }
      if (addSayLine) addSayLine.disabled = !showObjectName
      if (showObjectName && message && document.activeElement !== message) message.value = effect?.message || ''
      if (!showObjectName) objectSayRowsRenderKey = ''
    }
    const triggerRow = sidebar.querySelector('#triggerRow')
    if (triggerRow) {
      const showTrigger = state.tool === ToolMode.SELECT && selectedPlacedObject && isTeleportPlacedObject(selectedPlacedObject)
      triggerRow.style.display = showTrigger ? 'block' : 'none'
      if (showTrigger) {
        const t = selectedPlacedObject.userData.trigger
        const typeInput = sidebar.querySelector('#triggerType')
        if (typeInput && document.activeElement !== typeInput) typeInput.value = t?.type || ''
        const isTP = t?.type === 'teleport'
        sidebar.querySelector('#triggerTeleportFields').style.display = isTP ? 'block' : 'none'
        if (isTP) {
          const dest = sidebar.querySelector('#triggerDestChunk')
          const entryX = sidebar.querySelector('#triggerEntryX')
          const entryY = sidebar.querySelector('#triggerEntryY')
          const entryZ = sidebar.querySelector('#triggerEntryZ')
          if (dest && document.activeElement !== dest) dest.value = t.destChunk || ''
          if (entryX && document.activeElement !== entryX) entryX.value = t.entryX ?? ''
          if (entryY && document.activeElement !== entryY) entryY.value = t.entryY ?? ''
          if (entryZ && document.activeElement !== entryZ) entryZ.value = t.entryZ ?? ''
        }
        renderTeleportOccupancyPreview()
      }
    }
    const interactionSidesRow = sidebar.querySelector('#interactionSidesRow')
    if (interactionSidesRow) {
      const showSides = state.tool === ToolMode.SELECT && selectedPlacedObject
      interactionSidesRow.style.display = showSides ? 'block' : 'none'
      if (showSides) renderInteractionTilesGrid()
      else interactionTilesRenderKey = ''
    }
    const planeRotationRow = sidebar.querySelector('#planeRotationRow')
    if (planeRotationRow) {
      const showPlaneRot = (state.tool === ToolMode.SELECT || state.tool === ToolMode.TEXTURE_PLANE) && selectedTexturePlane
      planeRotationRow.style.display = showPlaneRot ? 'block' : 'none'
      if (showPlaneRot) syncPlaneRotationUI()
    }
    if (texNoRoofRow) {
      const roofObjects = selectedTexturePlane ? [] : selectedRoofLikePlacedObjects()
      const showNoRoof = ((state.tool === ToolMode.SELECT || state.tool === ToolMode.TEXTURE_PLANE) && selectedTexturePlane)
        || (state.tool === ToolMode.SELECT && roofObjects.length > 0)
      texNoRoofRow.style.display = showNoRoof ? 'block' : 'none'
      if (showNoRoof) {
        if (selectedTexturePlane) {
          texNoRoofCheckbox.indeterminate = false
          texNoRoofCheckbox.checked = !!selectedTexturePlane.noRoof
        } else {
          const checkedCount = roofObjects.filter((obj) => obj.userData.noRoof === true).length
          texNoRoofCheckbox.checked = checkedCount === roofObjects.length
          texNoRoofCheckbox.indeterminate = checkedCount > 0 && checkedCount < roofObjects.length
        }
      } else {
        texNoRoofCheckbox.indeterminate = false
      }
    }
    if (texBridgeRow) {
      const showBridge = (state.tool === ToolMode.SELECT || state.tool === ToolMode.TEXTURE_PLANE) && selectedTexturePlane
      texBridgeRow.style.display = showBridge ? 'block' : 'none'
      if (showBridge) texBridgeCheckbox.checked = !!selectedTexturePlane.bridge
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
    if (performance.now() >= statusHoldUntil) statusText.textContent = status
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
      syncNpcTypeInput()
      updateNpcPlacementControls()
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
      linesMesh.isPickable = false
      linesMesh.metadata = { ...(linesMesh.metadata || {}), editorHelper: true }
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
    const explicitTiles = currentInteractionTiles(obj)
    if (!explicitTiles.length) return []
    let rotY = obj.rotation?.y || 0
    if (obj.rotationQuaternion) {
      const e = obj.rotationQuaternion.toEulerAngles()
      rotY = e.y
    }
    const q = (((Math.round(rotY / (Math.PI / 2)) % 4) + 4) % 4)
    const rotate = (tile) => {
      if (q === 1) return { x: tile.z, z: -tile.x }
      if (q === 2) return { x: -tile.x, z: -tile.z }
      if (q === 3) return { x: -tile.z, z: tile.x }
      return tile
    }
    const tiles = explicitTiles.map(tile => {
      const r = rotate(tile)
      return { x: Math.floor(obj.position.x) + r.x, z: Math.floor(obj.position.z) + r.z }
    })
    const mat = getInteractionSideMaterial()
    const yBase = (obj.position.y || 0) + 0.02 // hair above ground to avoid z-fighting
    const meshes = []
    for (const t of tiles) {
      const marker = MeshBuilder.CreatePlane(`interactSide_${t.x}_${t.z}`, { size: 0.92 }, scene)
      marker.rotation.x = Math.PI / 2 // lay flat on XZ plane
      marker.position.set(t.x + 0.5, yBase, t.z + 0.5)
      marker.material = mat
      marker.isPickable = false
      marker.metadata = { ...(marker.metadata || {}), editorHelper: true, interactionTileMarker: true }
      marker.doNotSyncBoundingInfo = true
      marker.renderingGroupId = 1 // draw above default scene to stay visible
      meshes.push(marker)
    }
    return meshes
  }

  function placedObjectRotY(obj) {
    if (!obj) return 0
    if (obj.rotationQuaternion) return obj.rotationQuaternion.toEulerAngles().y
    return obj.rotation?.y || 0
  }

  let _doorOpenPreviewMatNeg = null
  let _doorOpenPreviewMatPos = null
  function getDoorOpenPreviewMaterial(dir) {
    if (dir === 1 && _doorOpenPreviewMatPos) return _doorOpenPreviewMatPos
    if (dir !== 1 && _doorOpenPreviewMatNeg) return _doorOpenPreviewMatNeg
    const m = new StandardMaterial(dir === 1 ? 'doorOpenPreviewMatPos' : 'doorOpenPreviewMatNeg', scene)
    const color = dir === 1 ? new Color3(1.0, 0.82, 0.12) : new Color3(0.12, 0.95, 1.0)
    m.diffuseColor = color
    m.emissiveColor = color.scale(0.75)
    m.specularColor = new Color3(0, 0, 0)
    m.alpha = 0.42
    m.disableLighting = true
    m.backFaceCulling = false
    m.transparencyMode = 2
    if (dir === 1) _doorOpenPreviewMatPos = m
    else _doorOpenPreviewMatNeg = m
    return m
  }

  function createDoorOpenDirectionHelper(obj) {
    if (!isDoorPlacedObject(obj) || obj.userData.defaultOpen !== true) return []
    const bounds = obj.getHierarchyBoundingVectors?.(true)
    const min = bounds?.min
    const max = bounds?.max
    const cx = (min && max) ? (min.x + max.x) / 2 : obj.position.x
    const cz = (min && max) ? (min.z + max.z) / 2 : obj.position.z
    const y = (max?.y ?? obj.position.y + 1.6) + 0.18
    const radius = Math.max(0.6, Math.min(1.25, Math.max(
      max && min ? max.x - min.x : 1,
      max && min ? max.z - min.z : 1,
    ) * 0.75))
    const dir = obj.userData.openDirection === 1 ? 1 : -1
    // The game rotates the door pivot in Babylon's parent/local space. This
    // world-space editor preview needs the opposite sign to land on the same
    // visible side as the in-game opened door.
    const previewDir = -dir
    const start = placedObjectRotY(obj)
    const end = start + previewDir * Math.PI / 2
    const previewWidth = Math.max(0.65, Math.min(1.8, Math.max(
      max && min ? max.x - min.x : 1,
      max && min ? max.z - min.z : 1,
    )))
    const previewHeight = Math.max(1.2, Math.min(3.2, max && min ? max.y - min.y : 2))
    const previewThickness = 0.08
    const hinge = obj.getAbsolutePosition ? obj.getAbsolutePosition().clone() : obj.position.clone()
    const center = new Vector3(
      hinge.x + Math.cos(end) * previewWidth * 0.5,
      (min?.y ?? obj.position.y) + previewHeight * 0.5,
      hinge.z - Math.sin(end) * previewWidth * 0.5,
    )
    const panel = MeshBuilder.CreateBox('doorOpenPreviewPanel', {
      width: previewWidth,
      height: previewHeight,
      depth: previewThickness,
    }, scene)
    panel.position = center
    panel.rotationQuaternion = null
    panel.rotation.y = end
    panel.material = getDoorOpenPreviewMaterial(dir)
    panel.isPickable = false
    panel.metadata = { ...(panel.metadata || {}), editorHelper: true, doorOpenDirectionHelper: true }
    panel.renderingGroupId = 1

    const steps = 12
    const arc = []
    for (let i = 0; i <= steps; i++) {
      const t = i / steps
      const a = start + (end - start) * t
      arc.push(new Vector3(cx + Math.sin(a) * radius, y, cz + Math.cos(a) * radius))
    }
    const tip = arc[arc.length - 1]
    const backA = end - previewDir * 0.38
    const sideA = end - previewDir * 0.18
    const arrowSize = 0.28
    const lines = [
      arc,
      [
        tip,
        new Vector3(
          cx + Math.sin(backA) * (radius - arrowSize),
          y,
          cz + Math.cos(backA) * (radius - arrowSize),
        ),
      ],
      [
        tip,
        new Vector3(
          tip.x - Math.sin(sideA) * arrowSize,
          y,
          tip.z - Math.cos(sideA) * arrowSize,
        ),
      ],
    ]
    const mesh = MeshBuilder.CreateLineSystem('doorOpenDirectionHelper', { lines }, scene)
    mesh.color = dir === 1 ? new Color3(1.0, 0.82, 0.25) : new Color3(0.25, 0.95, 1.0)
    mesh.isPickable = false
    mesh.metadata = { ...(mesh.metadata || {}), editorHelper: true, doorOpenDirectionHelper: true }
    mesh.renderingGroupId = 1
    return [panel, mesh]
  }

  function clearSelectionHelper() {
    if (Array.isArray(selectionHelper)) {
      for (const h of selectionHelper) { if (h) h.dispose() }
    } else if (selectionHelper) {
      selectionHelper.dispose()
    }
    selectionHelper = null
  }

  function cleanupStaleSelectionHelperMeshes() {
    for (const mesh of [...scene.meshes]) {
      if (mesh.metadata?.editorHelper || mesh.name === 'selBox' || mesh.name?.startsWith('interactSide_')) {
        mesh.dispose()
      }
    }
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
      const doorOpenHelpers = createDoorOpenDirectionHelper(obj)
      for (const m of doorOpenHelpers) helpers.push(m)
    }

    if (texturePlaneGroup) {
      for (const plane of selectedTexturePlanes) {
        const node = texturePlaneNodeFor(plane)
        if (!node) continue
        const h = createBoundingBoxHelper(node, boxColor)
        if (h) helpers.push(h)
      }
    }

    selectionHelper = helpers.length === 1 ? helpers[0] : helpers.length > 0 ? helpers : null
  }

  function clearSelection() {
    freezePlacedModels(selectedPlacedObjects)
    selectedPlacedObject = null
    selectedPlacedObjects = []
    selectedTexturePlane = null
    selectedTexturePlanes = []
    isDragSelecting = false
    dragSelectStart = null
    if (dragSelectBox) dragSelectBox.style.display = 'none'
    cleanupStaleSelectionHelperMeshes()
    objectSayRowsRenderKey = ''
    interactionTilesRenderKey = ''
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateSelectionHelper()
    updateToolUI()
  }

  function stablePlacementStringify(value) {
    if (Array.isArray(value)) {
      return `[${value.map(stablePlacementStringify).join(',')}]`
    }
    if (value && typeof value === 'object') {
      return `{${Object.keys(value).sort().map((key) =>
        `${JSON.stringify(key)}:${stablePlacementStringify(value[key])}`
      ).join(',')}}`
    }
    const primitive = JSON.stringify(value)
    return primitive === undefined ? 'undefined' : primitive
  }

  function dedupePlacedObjectData(placedObjects, context = 'placed objects') {
    if (!Array.isArray(placedObjects) || placedObjects.length === 0) return []
    const seen = new Set()
    const unique = []
    let removed = 0
    for (const placed of placedObjects) {
      const key = stablePlacementStringify(placed)
      if (seen.has(key)) {
        removed++
        continue
      }
      seen.add(key)
      unique.push(placed)
    }
    if (removed > 0) {
      console.warn(`[editor] Removed ${removed} exact duplicate ${context}`)
    }
    return unique
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
      if (obj.userData.name) out.name = obj.userData.name
      if (obj.userData.examineText) out.examineText = obj.userData.examineText
      if (obj.userData.interactions?.length) out.interactions = JSON.parse(JSON.stringify(obj.userData.interactions))
      if (obj.userData.defaultOpen) out.defaultOpen = true
      if (obj.userData.openDirection === 1) out.openDirection = 1
      if (obj.userData.locked) out.locked = true
      if (Number.isInteger(obj.userData.keyItemId) && obj.userData.keyItemId > 0) out.keyItemId = obj.userData.keyItemId
      if (obj.userData.consumeKey) out.consumeKey = true
      if (obj.userData.lockedMessage) out.lockedMessage = obj.userData.lockedMessage
      if (obj.userData.noRoof) out.noRoof = true
      if (Number.isInteger(obj.userData.altarTier) && obj.userData.altarTier > 1) out.altarTier = obj.userData.altarTier
      if (obj.userData.trigger) out.trigger = { ...obj.userData.trigger }
      if (obj.userData.verticalLinks?.length) out.verticalLinks = JSON.parse(JSON.stringify(obj.userData.verticalLinks))
      if (obj.userData.interactionTiles?.length) out.interactionTiles = JSON.parse(JSON.stringify(obj.userData.interactionTiles))
      if (obj.userData.interactionSides) out.interactionSides = obj.userData.interactionSides | 0
      return out
    })
    // Append orphaned placements (assetId not in registry) so they survive save/load.
    for (const o of _orphanPlacements) live.push(JSON.parse(JSON.stringify(o)))
    return dedupePlacedObjectData(live, 'placed object(s) while serializing')
  }

  async function rebuildPlacedObjectsFromData(placedObjectsData) {
    const rebuildToken = ++placedObjectRebuildToken
    const uniquePlacedObjects = dedupePlacedObjectData(placedObjectsData, 'placed object(s) while loading')
    clearPlacedModels()
    _orphanPlacements = []  // full rebuild — reset and repopulate from data
    const _missing = new Map()

    // Pre-load unique models before sequential cloning.
    const uniquePaths = [...new Set(
      uniquePlacedObjects
        .map((p) => assetById.get(p.assetId)?.path)
        .filter(Boolean)
    )]
    await warmAssetCache(uniquePaths)
    if (rebuildToken !== placedObjectRebuildToken) return

    const workState = { startedAt: performance.now() }
    for (const placed of uniquePlacedObjects) {
      if (rebuildToken !== placedObjectRebuildToken) return
      const asset = assetById.get(placed.assetId)
      if (!asset) {
        _orphanPlacements.push(JSON.parse(JSON.stringify(placed)))
        const k = placed.assetId || '(no assetId)'
        _missing.set(k, (_missing.get(k) || 0) + 1)
        continue
      }

      const model = cloneAssetModelSync(asset.path)
      tuneModelLighting(model, asset.path)
      if (rebuildToken !== placedObjectRebuildToken) {
        model.dispose()
        return
      }

      model.position.set(placed.position.x, placed.position.y, placed.position.z)
      model.rotationQuaternion = null
      model.rotation.set(placed.rotation.x, placed.rotation.y, placed.rotation.z)
      model.scale.set(placed.scale.x, placed.scale.y, placed.scale.z)
      model.userData.assetId = asset.id
      model.userData.type = 'asset'
      model.userData.layerId = placed.layerId || 'layer_0'
      if (placed.name) model.userData.name = placed.name
      if (placed.examineText) model.userData.examineText = placed.examineText
      if (placed.interactions?.length) model.userData.interactions = JSON.parse(JSON.stringify(placed.interactions))
      if (placed.defaultOpen) model.userData.defaultOpen = true
      if (placed.openDirection === 1) model.userData.openDirection = 1
      if (placed.locked) model.userData.locked = true
      if (Number.isInteger(placed.keyItemId) && placed.keyItemId > 0) model.userData.keyItemId = placed.keyItemId
      if (placed.consumeKey) model.userData.consumeKey = true
      if (placed.lockedMessage) model.userData.lockedMessage = placed.lockedMessage
      if (placed.noRoof) model.userData.noRoof = true
      if (Number.isInteger(placed.altarTier) && placed.altarTier > 0) model.userData.altarTier = placed.altarTier
      if (placed.trigger) model.userData.trigger = { ...placed.trigger }
      if (placed.verticalLinks?.length) model.userData.verticalLinks = JSON.parse(JSON.stringify(placed.verticalLinks))
      if (placed.interactionTiles?.length) model.userData.interactionTiles = JSON.parse(JSON.stringify(placed.interactionTiles))
      if (placed.interactionSides) model.userData.interactionSides = placed.interactionSides | 0
      const layer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(layer ? layer.visible : true)
      addPlacedModel(model, { invalidateShadow: false })
      await yieldIfOverBudget(workState)
      if (rebuildToken !== placedObjectRebuildToken) return
    }
    invalidateShadowCache()
    reportMissingAssets(_missing, 'load')
    // Re-mask the placed objects under any active appearance preview — the
    // previous TransformNode refs we stashed in hiddenNodes are now disposed.
    if (typeof refreshNpcPreviewMasks === 'function') refreshNpcPreviewMasks()
    refreshBrokenLadderIndicators()
  }

  function buildSaveData() {
    return {
      map: map.toJSON(),
      placedObjects: serializePlacedObjects(),
      layers: JSON.parse(JSON.stringify(layers)),
      activeLayerId,
      npcSpawns: serializeNpcSpawns(),
      itemSpawns: serializeItemSpawns(),
      collisionData: serializeCollisionData(),
      biomesData: serializeBiomesData()
    }
  }

  function countObjectEntries(value) {
    if (!value || typeof value !== 'object') return 0
    return Object.keys(value).length
  }

  function countCollisionEdits(data) {
    if (!data || typeof data !== 'object') return 0
    let count = 0
    count += countObjectEntries(data.walls)
    count += countObjectEntries(data.wallHeights)
    count += countObjectEntries(data.floors)
    count += countObjectEntries(data.stairs)
    count += countObjectEntries(data.tiles)
    count += countObjectEntries(data.holes)
    for (const layer of Object.values(data.floorLayers || {})) {
      count += countCollisionEdits(layer)
    }
    return count
  }

  function countTileEdits(mapData) {
    if (!mapData || typeof mapData !== 'object') return 0
    const defaultGround = mapData.defaultGround || 'grass'
    const tiles = Array.isArray(mapData.tiles) ? mapData.tiles : []
    let count = 0
    for (const row of tiles) {
      if (!Array.isArray(row)) continue
      for (const tile of row) {
        if (!tile) continue
        if (typeof tile === 'string') {
          if (tile !== defaultGround) count++
          continue
        }
        if (tile.ground && tile.ground !== defaultGround) count++
        if (tile.groundB && tile.groundB !== defaultGround) count++
        if (tile.split && tile.split !== 'forward') count++
        if (tile.textureId || tile.textureIdB) count++
        if (tile.waterPainted || tile.waterSurface || tile.waterSurfaceB) count++
      }
    }
    const heights = Array.isArray(mapData.heights) ? mapData.heights : []
    for (const row of heights) {
      if (!Array.isArray(row)) continue
      for (const height of row) {
        if (Number.isFinite(height) && Math.abs(height) > 0.001) count++
      }
    }
    return count
  }

  function autosaveStats(data) {
    if (!data || typeof data !== 'object') {
      return { weight: 0, tileEdits: 0, collisionEdits: 0, biomeEdits: 0 }
    }
    const objectCount = Array.isArray(data.placedObjects) ? data.placedObjects.length : 0
    const npcCount = Array.isArray(data.npcSpawns) ? data.npcSpawns.length : 0
    const itemCount = Array.isArray(data.itemSpawns) ? data.itemSpawns.length : 0
    const planeCount = Array.isArray(data.map?.texturePlanes) ? data.map.texturePlanes.length : 0
    const chunkCount = Array.isArray(data.map?.activeChunks) ? data.map.activeChunks.length : 0
    const tileEditCount = countTileEdits(data.map)
    const collisionCount = countCollisionEdits(data.collisionData)
    const biomeCount = countObjectEntries(data.biomesData?.cells) + (Array.isArray(data.biomesData?.defs) ? data.biomesData.defs.length : 0)
    const area = (data.map?.width || 0) * (data.map?.height || 0)
    const weight = objectCount * 10 + npcCount * 3 + itemCount + planeCount * 2 + chunkCount + tileEditCount + collisionCount + biomeCount + Math.floor(area / 4096)
    return {
      weight,
      tileEdits: tileEditCount,
      collisionEdits: collisionCount,
      biomeEdits: biomeCount
    }
  }

  function autosaveWeight(data) {
    return autosaveStats(data).weight
  }

  function parseAutosave(raw) {
    if (!raw) return null
    try { return JSON.parse(raw) } catch { return null }
  }

  function previousAutosaveWeight(prevText) {
    const meta = parseAutosave(localStorage.getItem('projectrs-autosave-meta'))
    if (Number.isFinite(meta?.weight)) return meta.weight
    return autosaveWeight(parseAutosave(prevText))
  }

  let autosaveDirty = false
  let autosaveTimer = null
  let autosaveStatusTimer = null
  let suppressAutosaveDirty = false

  function autoSave({ force = false, silent = false } = {}) {
    if (!force && !autosaveDirty) return
    if (autosaveTimer) {
      clearTimeout(autosaveTimer)
      autosaveTimer = null
    }
    try {
      const nextData = buildSaveData()
      const nextStats = autosaveStats(nextData)
      const nextText = JSON.stringify(nextData)
      const prevText = localStorage.getItem('projectrs-autosave')
      const nextWeight = nextStats.weight
      const prevWeight = previousAutosaveWeight(prevText)

      // Do not let an empty/default editor boot clobber the last useful work.
      if (prevText && prevWeight > 20 && nextWeight <= 2) {
        console.warn('Auto-save skipped: refusing to overwrite non-empty autosave with empty map')
        autosaveDirty = false
        return
      }

      if (prevText && prevText !== nextText) {
        localStorage.setItem('projectrs-autosave-prev', prevText)
      }
      localStorage.setItem('projectrs-autosave', nextText)
      localStorage.setItem('projectrs-autosave-meta', JSON.stringify({
        savedAt: new Date().toISOString(),
        weight: nextWeight,
        width: nextData.map?.width,
        height: nextData.map?.height,
        objects: nextData.placedObjects?.length || 0,
        npcs: nextData.npcSpawns?.length || 0,
        items: nextData.itemSpawns?.length || 0,
        tileEdits: nextStats.tileEdits,
        collisionEdits: nextStats.collisionEdits,
        biomeEdits: nextStats.biomeEdits,
      }))
      autosaveDirty = false
      if (!silent) {
        const prev = statusText.textContent
        statusText.textContent = 'Auto-saved'
        if (autosaveStatusTimer) clearTimeout(autosaveStatusTimer)
        autosaveStatusTimer = setTimeout(() => { statusText.textContent = prev }, 2000)
      }
    } catch (e) {
      console.warn('Auto-save failed:', e)
    }
  }

  function scheduleAutoSave() {
    if (suppressAutosaveDirty) return
    autosaveDirty = true
    if (autosaveTimer) return
    autosaveTimer = setTimeout(() => autoSave(), 2000)
  }

  function pushUndoStateWithoutAutosave(scope) {
    const previous = suppressAutosaveDirty
    suppressAutosaveDirty = true
    try {
      pushUndoState(scope)
    } finally {
      suppressAutosaveDirty = previous
    }
  }

  setInterval(() => autoSave({ silent: true }), 60 * 1000)
  window.addEventListener('beforeunload', () => autoSave({ force: true, silent: true }))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') autoSave({ force: true, silent: true })
  })

  function includeMapFocusPoint(bounds, x, z) {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return
    bounds.minX = Math.min(bounds.minX, x)
    bounds.minZ = Math.min(bounds.minZ, z)
    bounds.maxX = Math.max(bounds.maxX, x)
    bounds.maxZ = Math.max(bounds.maxZ, z)
    bounds.count++
  }

  function includeMapFocusTile(bounds, x, z) {
    includeMapFocusPoint(bounds, x, z)
    includeMapFocusPoint(bounds, x + 1, z + 1)
  }

  function loadedMapFocusBounds() {
    const bounds = { minX: Infinity, minZ: Infinity, maxX: -Infinity, maxZ: -Infinity, count: 0 }

    // Sparse dungeon maps render void as no mesh, so active chunk bounds alone
    // can point the camera at empty space. Prefer actual visible terrain.
    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        if (!map.isTileInActiveChunk(x, z)) continue
        const tile = map.getTile(x, z)
        if (!tile) continue
        const hasVisibleGround = tile.ground && tile.ground !== 'void'
        const hasSecondGround = tile.groundB && tile.groundB !== 'void'
        if (hasVisibleGround || hasSecondGround || tile.waterPainted || tile.waterSurface || tile.waterSurfaceB) {
          includeMapFocusTile(bounds, x, z)
        }
      }
    }

    // If a map currently has only placed objects/spawns, still frame those.
    for (const obj of placedGroup.getChildren()) includeMapFocusPoint(bounds, obj.position.x, obj.position.z)
    for (const spawn of npcSpawns) includeMapFocusPoint(bounds, spawn.x, spawn.z)
    for (const spawn of itemSpawns) includeMapFocusPoint(bounds, spawn.x, spawn.z)

    if (bounds.count > 0) return bounds

    if (map.activeChunks?.size) {
      for (const ck of map.activeChunks) {
        const [cx, cz] = ck.split(',').map(Number)
        if (!Number.isFinite(cx) || !Number.isFinite(cz)) continue
        includeMapFocusPoint(bounds, cx * 64, cz * 64)
        includeMapFocusPoint(bounds, Math.min(map.width, (cx + 1) * 64), Math.min(map.height, (cz + 1) * 64))
      }
    }

    if (bounds.count > 0) return bounds

    includeMapFocusPoint(bounds, 0, 0)
    includeMapFocusPoint(bounds, map.width, map.height)
    return bounds
  }

  function focusCameraOnLoadedMap() {
    const bounds = loadedMapFocusBounds()
    const centerX = (bounds.minX + bounds.maxX) / 2
    const centerZ = (bounds.minZ + bounds.maxZ) / 2
    const tileX = Math.max(0, Math.min(map.width - 1, Math.floor(centerX)))
    const tileZ = Math.max(0, Math.min(map.height - 1, Math.floor(centerZ)))
    const h = map.getAverageTileHeight(tileX, tileZ)
    const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxZ - bounds.minZ)
    target.x = centerX
    target.y = h
    target.z = centerZ
    distance = Math.max(14, Math.min(90, extent * 1.4 + 14))
    updateCamera()
  }

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
    pushUndoStateWithoutAutosave()

    saveFileHandle = null

    map = MapData.fromJSON(data.map)
    selectedWaterFlowChunk = null
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

    focusCameraOnLoadedMap()
    buildWallChunkDropdown()
    if (typeof syncChunkWaterFlowControls === 'function') syncChunkWaterFlowControls()
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
        .map((p) => assetById.get(p.assetId)?.path)
        .filter(Boolean)
    )]
    await warmAssetCache(_importPaths)

    const _importMissing = new Map()
    const _importWork = { startedAt: performance.now() }
    for (const placed of data.placedObjects || []) {
      const asset = assetById.get(placed.assetId)
      if (!asset) {
        const orphan = JSON.parse(JSON.stringify(placed))
        orphan.position.x += offsetX
        orphan.position.z += offsetZ
        _orphanPlacements.push(orphan)
        const k = placed.assetId || '(no assetId)'
        _importMissing.set(k, (_importMissing.get(k) || 0) + 1)
        continue
      }
      const model = cloneAssetModelSync(asset.path)
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
      if (placed.name) model.userData.name = placed.name
      if (placed.examineText) model.userData.examineText = placed.examineText
      if (placed.interactions?.length) model.userData.interactions = JSON.parse(JSON.stringify(placed.interactions))
      if (placed.noRoof) model.userData.noRoof = true
      if (placed.trigger) model.userData.trigger = { ...placed.trigger }
      if (placed.verticalLinks?.length) model.userData.verticalLinks = JSON.parse(JSON.stringify(placed.verticalLinks))
      if (placed.interactionTiles?.length) model.userData.interactionTiles = JSON.parse(JSON.stringify(placed.interactionTiles))
      if (placed.interactionSides) model.userData.interactionSides = placed.interactionSides | 0
      const _layer = layers.find((l) => l.id === model.userData.layerId)
      model.setEnabled(_layer ? _layer.visible : true)
      addPlacedModel(model, { invalidateShadow: false })
      await yieldIfOverBudget(_importWork)
    }
    invalidateShadowCache()
    reportMissingAssets(_importMissing, 'import chunk')

    // Import NPC spawns shifted by offset. Drop the source id so chunks
    // imported into an existing map don't collide with its id sequence.
    for (const s of data.npcSpawns || []) {
      addNpcSpawn({ ...s, id: undefined, x: s.x + offsetX, z: s.z + offsetZ, wanderRange: s.wanderRange ?? 3 })
    }
    rebuildNpcSpawnMeshes()
    refreshNpcSpawnList()

    markTerrainDirty({
      rebuildTexturePlanes: true,
      rebuildTextureOverlays: true,
      region: { x1: offsetX, z1: offsetZ, x2: offsetX + src.width - 1, z2: offsetZ + src.height - 1 }
    })
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
    scheduleAutoSave()
  }

  async function undo() {
    if (!undoStack.length || historyRestoreInProgress) return
    historyRestoreInProgress = true
    try {
      const prev = undoStack[undoStack.length - 1]
      redoStack.push(captureSnapshot(prev.scope))
      const snapshot = undoStack.pop()
      await applySnapshot(snapshot)
    } finally {
      historyRestoreInProgress = false
    }
  }

  async function redo() {
    if (!redoStack.length || historyRestoreInProgress) return
    historyRestoreInProgress = true
    try {
      const prev = redoStack[redoStack.length - 1]
      undoStack.push(captureSnapshot(prev.scope))
      const snapshot = redoStack.pop()
      await applySnapshot(snapshot)
    } finally {
      historyRestoreInProgress = false
    }
  }

  function buildSplitLines() {
    const points = []

    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        if (!map.isTileInActiveChunk(x, z)) continue
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
    lines.isPickable = false
    return lines
  }

  function buildTileGrid() {
    const points = []
    const LIFT = 0.04

    for (let z = 0; z < map.height; z++) {
      for (let x = 0; x < map.width; x++) {
        if (!map.isTileInActiveChunk(x, z)) continue
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
    lines.isPickable = false
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
      const cachedBounds = obj.userData?.bounds
      if (cachedBounds) {
        const sx = Math.abs(obj.scale?.x ?? obj.scaling?.x ?? 1)
        const sy = Math.abs(obj.scale?.y ?? obj.scaling?.y ?? 1)
        const sz = Math.abs(obj.scale?.z ?? obj.scaling?.z ?? 1)
        _size = { x: cachedBounds.width * sx, y: cachedBounds.height * sy, z: cachedBounds.depth * sz }
      } else {
        try {
          const bounds = obj.getHierarchyBoundingVectors(true)
          _size = { x: bounds.max.x - bounds.min.x, y: bounds.max.y - bounds.min.y, z: bounds.max.z - bounds.min.z }
        } catch { continue }
      }
      if (_size.x === 0 && _size.y === 0 && _size.z === 0) continue

      const isModular = obj.userData?._isModularAsset ?? false
      const isTree = obj.userData?._isTreeAsset ?? false

      const footprint = Math.max(_size.x, _size.z) * 0.5
      const shadowR   = footprint + (isTree || isModular ? 2.8 : 1.0)
      const shadowRSq = shadowR * shadowR
      const invShadowR = 1 / shadowR
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
          const distSq = dx * dx + dz * dz
          if (distSq >= shadowRSq) continue

          const t      = 1.0 - Math.sqrt(distSq) * invShadowR
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

  function texturePlaneIdForNode(node) {
    const directId = node?.metadata?.texturePlane?.id
    if (directId) return directId
    const child = node?.getChildMeshes?.().find((m) => m.metadata?.texturePlane?.id)
    return child?.metadata?.texturePlane?.id ?? null
  }

  function indexTexturePlaneNode(node) {
    const id = texturePlaneIdForNode(node)
    if (id) texturePlaneNodesById.set(id, node)
  }

  function reindexTexturePlaneNodes() {
    texturePlaneNodesById.clear()
    if (!texturePlaneGroup) return
    for (const node of texturePlaneGroup.getChildren()) indexTexturePlaneNode(node)
  }

  function texturePlaneNodeFor(plane) {
    const node = texturePlaneNodesById.get(plane?.id)
    if (node) return node
    if (!texturePlaneGroup) return null
    const found = texturePlaneGroup.getChildren().find((child) => texturePlaneIdForNode(child) === plane?.id) ?? null
    if (found) indexTexturePlaneNode(found)
    return found
  }

  function setTexturePlaneNodeFrozen(node, frozen) {
    if (!node) return
    const nodes = [node, ...(node.getChildMeshes?.() || [])]
    for (const child of nodes) {
      if (frozen) {
        child.computeWorldMatrix?.(true)
        child.freezeWorldMatrix?.()
      } else {
        child.unfreezeWorldMatrix?.()
      }
    }
  }

  function replaceTerrainWaterMeshes() {
    if (!terrainGroup) return
    const wg = buildWaterMeshes(map, waterTexture, scene)
    const newWaterChildren = [...wg.getChildren()]
    for (const child of newWaterChildren) {
      child.setEnabled(false)
      child.parent = terrainGroup
    }
    wg.dispose(true)

    for (const child of [...terrainGroup.getChildMeshes()]) {
      if ((child.name === 'terrain-water' || child.name === 'terrain-surface-water') && !newWaterChildren.includes(child)) {
        child.dispose()
      }
    }

    for (const child of newWaterChildren) child.setEnabled(true)
  }

  function rebuildTerrain({ skipTexturePlanes = false, skipShadows = false, skipTextureOverlays = false, _heightsOnlyRegion = null } = {}) {
    // Fast path: only heights changed in a known tile region — update land mesh in-place.
    if (_heightsOnlyRegion) {
      const shadowInf = _shadowInfluencesCache ?? buildObjectShadowInfluences()
      _shadowInfluencesCache = shadowInf
      if (updateTerrainLandHeights(map, shadowInf, _heightsOnlyRegion.x1, _heightsOnlyRegion.z1, _heightsOnlyRegion.x2, _heightsOnlyRegion.z2)) {
        if (!(state.isPainting && state.tool === ToolMode.TERRAIN)) {
          replaceTerrainWaterMeshes()
        }
        if (!skipTextureOverlays) {
          updateTextureOverlaysInRegion(_heightsOnlyRegion)
        }

        if (state.isPainting && state.tool === ToolMode.TERRAIN) {
          applyLayerVisibility()
          return
        }

        // Build new meshes (created hidden by build functions)
        const newCliffs = buildCliffMeshes(map, scene)

        // Dispose old cliffs
        disposeGroup(cliffs)

        // Enable new meshes
        if (newCliffs) newCliffs.setEnabled(true)
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
    const newSplitLines = state.showSplitLines ? buildSplitLines() : null
    const newTileGrid = state.showTileGrid ? buildTileGrid() : null
    const newOverlays = !skipTextureOverlays ? buildTextureOverlays(map, textureRegistry, textureCache, scene, overlayMaterialCache, overlayMeshesByTile) : null
    const newPlanes = !skipTexturePlanes ? buildTexturePlanes(map, textureRegistry, textureCache, scene, texturePlaneMaterialCache) : null

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
    if (!skipTexturePlanes) {
      texturePlaneGroup = newPlanes
      reindexTexturePlaneNodes()
    }

    updateSelectionHelper()
    applyLayerVisibility()
  }

  function rebuildTexturePlanesOnly() {
    const newPlanes = buildTexturePlanes(map, textureRegistry, textureCache, scene, texturePlaneMaterialCache)
    if (texturePlaneGroup) texturePlaneGroup.dispose()
    if (newPlanes) newPlanes.setEnabled(true)
    texturePlaneGroup = newPlanes
    reindexTexturePlaneNodes()
    updateSelectionHelper()
  }

  function appendTexturePlane(plane) {
    if (!texturePlaneGroup) {
      texturePlaneGroup = new TransformNode('texture-planes', scene)
      texturePlaneGroup.setEnabled(true)
    }
    const mesh = buildSingleTexturePlane(plane, textureRegistry, textureCache, scene, false, texturePlaneMaterialCache)
    if (mesh) {
      mesh.parent = texturePlaneGroup
      indexTexturePlaneNode(mesh)
    }
    updateSelectionHelper()
  }

  function removeTexturePlaneMesh(plane) {
    const node = texturePlaneNodeFor(plane)
    if (node) {
      texturePlaneNodesById.delete(plane?.id)
      node.dispose()
    }
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

  function updateTextureOverlaysInRegion(region) {
    if (!region) return
    const x1 = Math.max(0, Math.floor(region.x1) - 1)
    const z1 = Math.max(0, Math.floor(region.z1) - 1)
    const x2 = Math.min(map.width - 1, Math.ceil(region.x2) + 1)
    const z2 = Math.min(map.height - 1, Math.ceil(region.z2) + 1)
    for (let tz = z1; tz <= z2; tz++) {
      for (let tx = x1; tx <= x2; tx++) {
        updateTileTextureOverlay(tx, tz)
      }
    }
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
      mesh.isPickable = false
      mesh.parent = textureOverlayGroup
      let list = overlayMeshesByTile.get(tileKey)
      if (!list) { list = []; overlayMeshesByTile.set(tileKey, list) }
      list.push(mesh)
    }

      if (tile.textureHalfMode) {
        const { halfA, halfB } = computeCutPolygons(tile.textureCutAngle, tile.textureCutOffset ?? 0)
        if (tile.textureId) addOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, halfA)
        if (tile.textureIdB) addOverlay(tile.textureIdB, tile.textureRotationB, tile.textureScaleB, false, halfB)
    } else if (tile.textureId) {
      addOverlay(tile.textureId, tile.textureRotation, tile.textureScale, tile.textureWorldUV, fullTileRingForSplit(tile.split))
    }
  }

  function updateTexturePlaneMeshTransform(plane) {
    const node = texturePlaneNodeFor(plane)
    if (!node) return
    setTexturePlaneNodeFrozen(node, false)
    node.position.set(plane.position.x, plane.position.y, plane.position.z)
    node.rotation.set(plane.rotation?.x ?? 0, plane.rotation?.y ?? 0, plane.rotation?.z ?? 0)
    node.scaling.set(plane.scale?.x ?? 1, plane.scale?.y ?? 1, plane.scale?.z ?? 1)
    setTexturePlaneNodeFrozen(node, true)
  }

  let _lastMouseEvent = null
  function updateMouse(event) {
    if (_lastMouseEvent === event) return
    _lastMouseEvent = event
    // Update Babylon.js pointer position from the event
    const rect = canvas.getBoundingClientRect()
    scene.pointerX = event.clientX - rect.left
    scene.pointerY = event.clientY - rect.top
  }

  function getTerrainDisplayHeightAt(worldX, worldZ) {
    if (worldX < 0 || worldZ < 0 || worldX >= map.width || worldZ >= map.height) return null
    const tx = Math.max(0, Math.min(map.width - 1, Math.floor(worldX)))
    const tz = Math.max(0, Math.min(map.height - 1, Math.floor(worldZ)))
    const u = Math.max(0, Math.min(1, worldX - tx))
    const v = Math.max(0, Math.min(1, worldZ - tz))
    const h = map.getTileCornerHeights(tx, tz)
    let y = bilerpCorners(h.tl, h.tr, h.bl, h.br, u, v)
    const tile = map.getTile(tx, tz)
    if (tile?.waterSurface || tile?.waterSurfaceB) y += 0.05
    if (map.shouldRenderWaterTile?.(tx, tz)) y = Math.max(y, map.getTileWaterLevel(tx, tz) + 0.02)
    return y
  }

  function getRayMapRange(ray) {
    let tMin = 0
    let tMax = camera.maxZ || 1000
    const slab = (origin, dir, min, max) => {
      if (Math.abs(dir) < 1e-6) return origin >= min && origin <= max
      let a = (min - origin) / dir
      let b = (max - origin) / dir
      if (a > b) { const tmp = a; a = b; b = tmp }
      tMin = Math.max(tMin, a)
      tMax = Math.min(tMax, b)
      return tMin <= tMax
    }
    if (!slab(ray.origin.x, ray.direction.x, 0, map.width)) return null
    if (!slab(ray.origin.z, ray.direction.z, 0, map.height)) return null
    return tMax >= Math.max(0, tMin) ? { tMin: Math.max(0, tMin), tMax } : null
  }

  function pointOnRay(ray, t) {
    return new Vector3(
      ray.origin.x + ray.direction.x * t,
      ray.origin.y + ray.direction.y * t,
      ray.origin.z + ray.direction.z * t
    )
  }

  function pickTerrainPointFromRay(ray, fallbackY = _pickTileFallbackY) {
    const range = getRayMapRange(ray)
    if (range) {
      const sampleCount = 40
      let prevT = range.tMin
      let prev = pointOnRay(ray, prevT)
      let prevH = getTerrainDisplayHeightAt(prev.x, prev.z)
      let prevF = prevH == null ? Infinity : prev.y - prevH

      for (let i = 1; i <= sampleCount; i++) {
        const t = range.tMin + (range.tMax - range.tMin) * (i / sampleCount)
        const p = pointOnRay(ray, t)
        const h = getTerrainDisplayHeightAt(p.x, p.z)
        if (h == null) continue
        const f = p.y - h
        if (prevF >= 0 && f <= 0) {
          let lo = prevT
          let hi = t
          for (let j = 0; j < 10; j++) {
            const mid = (lo + hi) * 0.5
            const mp = pointOnRay(ray, mid)
            const mh = getTerrainDisplayHeightAt(mp.x, mp.z)
            if (mh == null) { hi = mid; continue }
            if (mp.y - mh > 0) lo = mid
            else hi = mid
          }
          const hit = pointOnRay(ray, hi)
          const hy = getTerrainDisplayHeightAt(hit.x, hit.z)
          if (hy != null) hit.y = hy
          return hit
        }
        prevT = t
        prevF = f
      }
    }

    const p = pickHorizontalPlaneFromRay(ray, fallbackY)
    if (!p) return null
    const y = getTerrainDisplayHeightAt(p.x, p.z)
    if (y == null) return null
    p.y = y
    return p
  }

  function pickTerrainPoint(event) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    return pickTerrainPointFromRay(ray)
  }

  function pickActiveChunkPlanePoint(event) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    const p = pickHorizontalPlaneFromRay(ray, _pickTileFallbackY)
    if (!p) return null
    const x = Math.floor(p.x)
    const z = Math.floor(p.z)
    if (x < 0 || z < 0 || x >= map.width || z >= map.height) return null
    if (!map.isTileInActiveChunk(x, z)) return null
    const y = getTerrainDisplayHeightAt(p.x, p.z)
    p.y = y ?? _pickTileFallbackY
    return p
  }

  function pickHorizontalPlaneFromRay(ray, y = 0) {
    if (Math.abs(ray.direction.y) < 0.0001) return null
    const t = -(ray.origin.y - y) / ray.direction.y
    if (t < 0) return null
    return pointOnRay(ray, t)
  }

  function pickHorizontalPlane(event, y = 0) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    return pickHorizontalPlaneFromRay(ray, y)
  }

  function pickSurfacePointFromRay(ray, excludeObjects = []) {
    const texturePlanePoint = pickTexturePlaneSurfacePointFromRay(ray)
    let point
    if (texturePlanePoint) {
      point = texturePlanePoint.clone()
    } else {
      const terrainPoint = pickTerrainPointFromRay(ray)
      if (!terrainPoint) return null
      point = terrainPoint.clone()
      const planeTop = findTexturePlaneTopAtWorld(point.x, point.z)
      if (planeTop != null && planeTop > point.y) point.y = planeTop
    }

    const objectTop = findObjectTopAt(point.x, point.z, excludeObjects)
    if (objectTop != null && objectTop > point.y) point.y = objectTop

    return point
  }

  function pickSurfacePoint(event, excludeObjects = []) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    return pickSurfacePointFromRay(ray, excludeObjects)
  }

  function shouldUseStackedPlacementSurface(eventLike) {
    return !!(eventLike?.ctrlKey || eventLike?.metaKey)
  }

  function pickPlacementPointFromRay(ray, excludeObjects = [], eventLike = null) {
    if (shouldUseStackedPlacementSurface(eventLike)) {
      return pickSurfacePointFromRay(ray, excludeObjects)
    }
    return pickTerrainPointFromRay(ray)
  }

  function pickPlacementPoint(event, excludeObjects = []) {
    updateMouse(event)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    return pickPlacementPointFromRay(ray, excludeObjects, event)
  }

  function tileFromWorldPoint(point) {
    if (!point) return null
    const x = Math.floor(point.x)
    const z = Math.floor(point.z)
    if (x < 0 || z < 0 || x >= map.width || z >= map.height) return null
    return { x, z, u: point.x - x, v: point.z - z }
  }

  function pickTile(event) {
    updateMouse(event)

    // Try terrain mesh first
    let p = pickTerrainPoint(event)

    // Fallback: project ray onto horizontal plane at Y=0 (or last known height)
    // This ensures clicks always resolve to a tile, even over bridges/elevated surfaces
    if (!p) {
      p = pickActiveChunkPlanePoint(event) ?? pickHorizontalPlane(event, _pickTileFallbackY)
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

  // import placed objects
  const _mergeUniquePaths = [...new Set(
    (data.placedObjects || [])
      .map((p) => assetById.get(p.assetId)?.path)
      .filter(Boolean)
  )]
  await warmAssetCache(_mergeUniquePaths)

  const _mergeMissing = new Map()
  const _mergeWork = { startedAt: performance.now() }
  for (const placed of data.placedObjects || []) {
    const asset = assetById.get(placed.assetId)
    if (!asset) {
      const orphan = JSON.parse(JSON.stringify(placed))
      orphan.position.x += offsetX
      orphan.position.z += offsetZ
      _orphanPlacements.push(orphan)
      const k = placed.assetId || '(no assetId)'
      _mergeMissing.set(k, (_mergeMissing.get(k) || 0) + 1)
      continue
    }

    const model = cloneAssetModelSync(asset.path)
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
    if (placed.name) model.userData.name = placed.name
    if (placed.examineText) model.userData.examineText = placed.examineText
    if (placed.interactions?.length) model.userData.interactions = JSON.parse(JSON.stringify(placed.interactions))
    if (placed.defaultOpen) model.userData.defaultOpen = true
    if (placed.openDirection === 1) model.userData.openDirection = 1
    if (placed.locked) model.userData.locked = true
    if (Number.isInteger(placed.keyItemId) && placed.keyItemId > 0) model.userData.keyItemId = placed.keyItemId
    if (placed.consumeKey) model.userData.consumeKey = true
    if (placed.lockedMessage) model.userData.lockedMessage = placed.lockedMessage
    if (placed.noRoof) model.userData.noRoof = true
    if (Number.isInteger(placed.altarTier) && placed.altarTier > 0) model.userData.altarTier = placed.altarTier
    if (placed.trigger) model.userData.trigger = { ...placed.trigger }
    if (placed.verticalLinks?.length) model.userData.verticalLinks = JSON.parse(JSON.stringify(placed.verticalLinks))
    if (placed.interactionTiles?.length) model.userData.interactionTiles = JSON.parse(JSON.stringify(placed.interactionTiles))
    if (placed.interactionSides) model.userData.interactionSides = placed.interactionSides | 0
    const _importLayer = layers.find((l) => l.id === model.userData.layerId)
    model.setEnabled(_importLayer ? _importLayer.visible : true)
    addPlacedModel(model, { invalidateShadow: false })
    await yieldIfOverBudget(_mergeWork)
  }
  invalidateShadowCache()
  reportMissingAssets(_mergeMissing, 'import map')

  markTerrainDirty({
    rebuildTexturePlanes: true,
    rebuildTextureOverlays: true,
    region: { x1: offsetX, z1: offsetZ, x2: offsetX + imported.width - 1, z2: offsetZ + imported.height - 1 }
  })
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

  const WALL_PLACEMENT_KEYWORDS = ['wall', 'fence', 'gate']

  function assetSearchText(asset) {
    const tags = Array.isArray(asset?.tags) ? asset.tags : []
    return [
      asset?.id,
      asset?.name,
      asset?.path,
      asset?.section,
      asset?.group,
      ...tags
    ].filter(Boolean).join(' ').toLowerCase()
  }

  function isWallPlacementAsset(asset) {
    const text = assetSearchText(asset)
    return WALL_PLACEMENT_KEYWORDS.some((keyword) => text.includes(keyword))
  }

  function isModularAsset(assetId) {
    const asset = assetById.get(assetId) || assetRegistry.find((a) => a.id === assetId)
    return asset?.path?.toLowerCase().includes('modular assets') ?? false
  }

  function placedRootFromPickedMesh(mesh) {
    if (!mesh?.isDescendantOf?.(placedGroup)) return null
    let obj = mesh
    while (obj.parent && obj.parent !== placedGroup) obj = obj.parent
    return obj?.parent === placedGroup ? obj : null
  }

  function isPlacedWallObject(obj) {
    const asset = assetById.get(obj?.userData?.assetId)
    return isWallPlacementAsset(asset)
  }

  function nodeEulerRotation(node) {
    if (node?.rotationQuaternion) {
      try { return node.rotationQuaternion.toEulerAngles() } catch {}
    }
    return new Vector3(node?.rotation?.x ?? 0, node?.rotation?.y ?? 0, node?.rotation?.z ?? 0)
  }

  function wallPlacementTargetInfo(target) {
    if (!target) return null

    let topY = null
    let bounds = null
    try {
      const b = target.getHierarchyBoundingVectors(true)
      bounds = b
      topY = b.max.y
    } catch {}

    return {
      object: target,
      x: target.position.x,
      z: target.position.z,
      topY,
      bounds,
      rotation: nodeEulerRotation(target),
      scaling: target.scaling?.clone?.() ?? target.scale?.clone?.() ?? null
    }
  }

  function xzDistanceToBounds(point, bounds) {
    if (!point || !bounds) return Infinity
    const dx = point.x < bounds.min.x
      ? bounds.min.x - point.x
      : point.x > bounds.max.x
        ? point.x - bounds.max.x
        : 0
    const dz = point.z < bounds.min.z
      ? bounds.min.z - point.z
      : point.z > bounds.max.z
        ? point.z - bounds.max.z
        : 0
    return Math.hypot(dx, dz)
  }

  function findNearbyWallPlacementTarget(referencePoint) {
    if (!referencePoint) return null

    const STACK_SNAP_RADIUS = 0.45
    let best = null
    let bestScore = Infinity

    for (const obj of _spatialNearby(referencePoint.x, referencePoint.z, SPATIAL_CELL * 2)) {
      if (obj.isEnabled?.() === false || !isPlacedWallObject(obj)) continue

      const info = wallPlacementTargetInfo(obj)
      if (!info) continue

      const dxz = info.bounds
        ? xzDistanceToBounds(referencePoint, info.bounds)
        : Math.hypot(referencePoint.x - info.x, referencePoint.z - info.z)
      if (dxz > STACK_SNAP_RADIUS) continue

      const yScore = Number.isFinite(info.topY)
        ? Math.abs(referencePoint.y - info.topY) * 0.05
        : 0
      const score = dxz + yScore
      if (score < bestScore) {
        best = info
        bestScore = score
      }
    }

    return best
  }

  function resetPlacementNodeTransform(node) {
    if (!node) return
    node.rotationQuaternion = null
    node.rotation.set(previewRotation.x, previewRotation.y, previewRotation.z)
    node.scaling.set(previewScale, previewScale, previewScale)
  }

  function findWallPlacementTarget(eventLike, asset, referencePoint = null) {
    if (!eventLike || eventLike.altKey || !isWallPlacementAsset(asset)) return null
    updateMouse(eventLike)
    const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
    const pick = scene.pickWithRay(ray, (mesh) => {
      if (!mesh.isVisible || !mesh.isEnabled()) return false
      const root = placedRootFromPickedMesh(mesh)
      return !!(root && root.isEnabled?.() !== false && isPlacedWallObject(root))
    })

    if (pick?.hit) {
      const target = placedRootFromPickedMesh(pick.pickedMesh)
      if (target && isPlacedWallObject(target)) return wallPlacementTargetInfo(target)
    }

    return shouldUseStackedPlacementSurface(eventLike)
      ? findNearbyWallPlacementTarget(referencePoint)
      : null
  }

  function applyWallPlacementSnap(node, pos, asset, placementTile, eventLike = null, referencePoint = null) {
    if (!isWallPlacementAsset(asset)) return false

    resetPlacementNodeTransform(node)
    wallPlacementTargetActive = false

    const target = findWallPlacementTarget(eventLike, asset, referencePoint ?? pos)
    if (target) {
      pos.x = target.x
      pos.z = target.z
      if (shouldUseStackedPlacementSurface(eventLike) && Number.isFinite(target.topY)) {
        pos.y = target.topY
      }
      node?.rotation?.copyFrom(target.rotation)
      if (target.scaling) node?.scaling?.copyFrom(target.scaling)
      wallPlacementTargetActive = true
      return true
    }

    const snap = getWallEdgeSnap(placementTile)
    if (snap) {
      pos.x = snap.x
      pos.z = snap.z
    }
    return false
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

    for (const other of _spatialNearby(targetX, targetZ, SPATIAL_CELL * 2)) {
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


  function isHorizontalTexturePlane(plane) {
    const rx = plane?.rotation?.x ?? 0
    return Math.abs(Math.abs(rx) - Math.PI / 2) < 0.12
  }

  function isTexturePlanePickableSurface(plane) {
    if (!isHorizontalTexturePlane(plane)) return false
    const layer = layers.find((l) => l.id === (plane.layerId || 'layer_0'))
    if (layer && !layer.visible) return false
    const py = plane.position?.y ?? 0
    if (heightCullEnabled && py > heightCullThreshold) return false
    return true
  }

  function pickTexturePlaneSurfacePointFromRay(ray) {
    if (!texturePlaneGroup) return null
    const pick = scene.pickWithRay(ray, (mesh) => {
      if (!mesh.isDescendantOf(texturePlaneGroup) || !mesh.isVisible || !mesh.isEnabled()) return false
      const plane = mesh.metadata?.texturePlane
      return isTexturePlanePickableSurface(plane)
    })
    if (!pick?.hit || !pick.pickedPoint) return null
    const point = pick.pickedPoint.clone()
    const plane = pick.pickedMesh?.metadata?.texturePlane
    if (Number.isFinite(plane?.position?.y)) point.y = plane.position.y
    return point
  }

  function findTexturePlaneTopAtWorld(worldX, worldZ) {
    let best = null
    for (const plane of map.texturePlanes || []) {
      if (!isTexturePlanePickableSurface(plane)) continue

      const px = plane.position?.x ?? 0
      const pz = plane.position?.z ?? 0
      const py = plane.position?.y ?? 0
      const sx = plane.scale?.x ?? 1
      const sy = plane.scale?.y ?? 1
      const ry = plane.rotation?.y ?? 0
      const hw = Math.max(0.01, (plane.width ?? 1) * sx) * 0.5
      const hd = Math.max(0.01, (plane.height ?? 1) * sy) * 0.5
      const cosR = Math.cos(ry)
      const sinR = Math.sin(ry)
      const lx = (worldX - px) * cosR + (worldZ - pz) * sinR
      const lz = -(worldX - px) * sinR + (worldZ - pz) * cosR
      if (Math.abs(lx) > hw || Math.abs(lz) > hd) continue
      if (best == null || py > best) best = py
    }
    return best
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

function halfPaintPresetAngle(mode) {
  if (mode === 'horizontal') return CUT_HORIZONTAL
  if (mode === 'vertical') return CUT_VERTICAL
  if (mode === 'diag_tl_br') return CUT_DIAG_TL_BR
  if (mode === 'diag_bl_tr') return CUT_DIAG_BL_TR
  return state.halfPaintCutAngle
}

function hasHalfWaterSurface(tile) {
  return !!tile && (!!tile.waterSurface) !== (!!tile.waterSurfaceB)
}

function resolveHalfPaintCut(tile, u, v, eventLike, existing = null) {
  const hadHalfMode = !!(existing && (
    (existing.textureHalfMode && (existing.textureId || existing.textureIdB)) ||
    hasHalfWaterSurface(existing)
  ))
  if (state.halfPaintCutMode === 'cursor') {
    const angle = hadHalfMode ? (existing.textureCutAngle ?? DEFAULT_CUT_ANGLE) : pickTextureCutAngle(u, v, eventLike)
    return {
      angle,
      offset: cutSideOf(u, v, angle, 0) === 'A' ? state.halfPaintCutOffset : -state.halfPaintCutOffset,
      shouldWrite: true,
    }
  }
  const angle = normalizeCutAngle(halfPaintPresetAngle(state.halfPaintCutMode))
  return {
    angle,
    offset: cutSideOf(u, v, angle, 0) === 'A' ? state.halfPaintCutOffset : -state.halfPaintCutOffset,
    shouldWrite: true,
  }
}

function captureStrokeHistoryOnce(scope) {
  if (!state.historyCapturedThisStroke) {
    pushUndoState(scope || 'terrain')
    state.historyCapturedThisStroke = true
  }
}

function baseGroundForTexturePaint() {
  return (map.mapType === 'dungeon' || map.defaultGround === 'void') ? 'dungeon-floor' : 'grass'
}

function ensurePaintableGroundForTexture(tx, tz) {
  const tile = map.getTile(tx, tz)
  if (!tile || tile.ground !== 'void') return false
  map.paintTile(tx, tz, baseGroundForTexturePaint())
  return true
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
      if (state.halfPaint) {
        const u = tile.u ?? 0.5
        const v = tile.v ?? 0.5
        const existing = map.getTile(tile.x, tile.z)
        const { angle: cutAngle, offset: cutOffset, shouldWrite } = resolveHalfPaintCut(tile, u, v, eventLike, existing)
        if (shouldWrite) {
          map.setTextureCutAngle(tile.x, tile.z, cutAngle)
          map.setTextureCutOffset(tile.x, tile.z, cutOffset)
        }

        const half = cutSideOf(u, v, cutAngle, cutOffset)
        if (eventLike?.shiftKey) map.clearWaterSurfaceHalf(tile.x, tile.z, half)
        else map.paintWaterSurfaceHalf(tile.x, tile.z, half)
      } else {
        if (eventLike?.shiftKey) {
          map.clearWaterSurface(tile.x, tile.z)
        } else {
          map.paintWaterSurface(tile.x, tile.z)
        }
      }
      markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, skipTextureOverlays: true })
      return
    }

    if (eventLike?.shiftKey || paintTabTextureId) {
      const isErase = eventLike?.shiftKey || paintTabTextureId === '__erase__'
      const createdBaseGround = !isErase && ensurePaintableGroundForTexture(tile.x, tile.z)
      if (state.halfPaint) {
        const u = tile.u ?? 0.5
        const v = tile.v ?? 0.5

        // Cut policy: cursor mode preserves an existing half-painted cut so
        // each side can be refined without the diagonal jumping around.
        // Preset/custom modes intentionally overwrite the cut angle/offset.
        const existing = map.getTile(tile.x, tile.z)
        const { angle: cutAngle, offset: cutOffset, shouldWrite } = resolveHalfPaintCut(tile, u, v, eventLike, existing)
        if (shouldWrite) {
          map.setTextureCutAngle(tile.x, tile.z, cutAngle)
          map.setTextureCutOffset(tile.x, tile.z, cutOffset)
        }

        const cursorHalf = cutSideOf(u, v, cutAngle, cutOffset)

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
      if (createdBaseGround) {
        markTerrainDirty({ skipTexturePlanes: true, skipShadows: true, rebuildTextureOverlays: true })
      } else {
        updateTileTextureOverlay(tile.x, tile.z)
      }
      return
    }

    const _pbr = paintBrushRadius - 1
    const cx = tile.x, cz = tile.z
    let structuralPaint = false
    for (let dz = -_pbr; dz <= _pbr; dz++) {
      for (let dx = -_pbr; dx <= _pbr; dx++) {
        if (dx * dx + dz * dz > _pbr * _pbr + _pbr) continue
        const tx = cx + dx, tz = cz + dz
        if (tx < 0 || tz < 0 || tx >= map.width || tz >= map.height) continue
        const beforeGround = map.getTile(tx, tz)?.ground
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
        const afterGround = map.getTile(tx, tz)?.ground
        if (beforeGround === 'void' || afterGround === 'void') structuralPaint = true
      }
    }

    markTerrainDirty({
      skipTexturePlanes: true,
      skipShadows: true,
      skipTextureOverlays: true,
      heightsOnly: !structuralPaint,
      region: structuralPaint ? null : { x1: cx - _pbr, z1: cz - _pbr, x2: cx + _pbr, z2: cz + _pbr }
    })
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
    if (!isWallPlacementAsset(asset)) { clearHoverEdge(); return }
    if (wallPlacementTargetActive && previewObject) { clearHoverEdge(); return }
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
      linesMesh.isPickable = false
      linesMesh.parent = group
    }

    hoverEdgeHelper = group
  }

  async function updatePreviewObject() {
    wallPlacementTargetActive = false
    if (previewObject) {
      previewObject.dispose()
      previewObject = null
    }

    if (state.tool !== ToolMode.PLACE || !selectedAssetId) return

    const asset = assetRegistry.find((a) => a.id === selectedAssetId)
    if (!asset) return

    const model = await loadAssetModel(asset.path, { doNotInstantiate: true })
    if (!model) return
    tuneModelLighting(model, asset.path)

    if (isStoneModularAsset(asset)) {
      model.scale.y = 1
    }

    previewObject = makeGhostMaterial(model)
    model.dispose() // dispose the source instance — ghost is a separate clone
    if (!previewObject) return
    previewObject.rotationQuaternion = null // use euler rotation instead of quaternion
    previewObject.rotation.set(previewRotation.x, previewRotation.y, previewRotation.z)
    previewObject.scaling.set(previewScale, previewScale, previewScale)
    previewObject.userData.assetId = asset.id
    setHierarchyPickable(previewObject, false)
    // previewObject is already in the scene from makeGhostMaterial

    const pos = tileWorldPosition(state.hovered.x, state.hovered.z)
    applyWallPlacementSnap(previewObject, pos, asset, state.hovered)
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

    const surfacePoint = event ? pickPlacementPoint(event) : null
    const placementTile = tileFromWorldPoint(surfacePoint) || tile
    const pos = tileWorldPosition(placementTile.x, placementTile.z)
    if (surfacePoint) pos.y = surfacePoint.y
    model.position.copyFrom(pos)
    model.rotationQuaternion = null // use euler rotation
    model.rotation.set(previewRotation.x, previewRotation.y, previewRotation.z)
    model.scaling.set(previewScale, previewScale, previewScale)
    applyWallPlacementSnap(model, pos, asset, placementTile, event, surfacePoint)
    if (asset.path?.toLowerCase().includes('tree')) {
      pos.x = surfacePoint ? Math.round(surfacePoint.x) : Math.round(pos.x)
      pos.z = surfacePoint ? Math.round(surfacePoint.z) : Math.round(pos.z)
    }
    model.position.copyFrom(pos)
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
      if (obj.userData.noRoof && isRoofLikeAssetId(newAsset.id)) model.userData.noRoof = true
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
        copyNoRoofFlag(src, model)
        addPlacedModel(model)
        model.computeWorldMatrix(true)
        model.position.copyFrom(src.position.add(offsetVec))
        _spatialRefresh(model)
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
        copyNoRoofFlag(src, model)
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
        _spatialRefresh(model)

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
      copyNoRoofFlag(selectedPlacedObject, model)

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
      _spatialRefresh(model)

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
    unfreezePlacedModels(selectedPlacedObjects)

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

    // Re-register moved/scaled GLB objects at their restored bounds
    if ((transformMode === 'move' || transformMode === 'scale') && selectedPlacedObjects.length) {
      for (const obj of selectedPlacedObjects) {
        _spatialUnregister(obj)
        _spatialRegister(obj)
      }
      invalidateShadowCache()
    }

    updateSelectionHelper()

    if (transformMode === 'rotate') lastRotateAxis = transformAxis
    freezePlacedModels(selectedPlacedObjects)
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateToolUI()
  }

  function confirmTransform() {
    if (transformMode === 'move' || transformMode === 'scale') {
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

    freezePlacedModels(selectedPlacedObjects)
    transformMode = null
    transformStart = null
    transformLift = 0
    movePlaneStart = null
    updateToolUI()
  }

  function interactableAssetCategory(asset) {
    const defId = ASSET_TO_OBJECT_DEF[asset.id]
    const def = defId != null ? editorObjectDefById.get(defId) : null
    if (def?.category) return def.category

    // Object defs load asynchronously. Keep the tab useful while they are still
    // loading by falling back to mapped asset names only.
    if (defId != null) {
      const haystack = `${asset.id} ${asset.name} ${asset.path}`.toLowerCase()
      if (haystack.includes('rock')) return 'rock'
      if (haystack.includes('tree')) return 'tree'
    }
    return null
  }

  function isInteractableRockAsset(asset) {
    return interactableAssetCategory(asset) === 'rock'
  }

  function resourceAssetGroup(asset) {
    const category = interactableAssetCategory(asset)
    if (category === 'rock') return 'Rocks'
    if (category === 'tree') return 'Trees'
    return null
  }

  function assetMatchesSection(asset, section) {
    if (section === '__resources__') return resourceAssetGroup(asset) !== null
    if (section === 'Models' && isInteractableRockAsset(asset)) return false
    if (section !== 'all' && asset.section !== section) return false
    return true
  }

  function assetGroupForSection(asset, section) {
    if (section === '__resources__') return resourceAssetGroup(asset) || 'General'
    return asset.group
  }

  function countAssetsByGroup(section) {
    const counts = new Map()
    for (const asset of assetRegistry) {
      if (!assetMatchesSection(asset, section)) continue
      const group = assetGroupForSection(asset, section)
      counts.set(group, (counts.get(group) || 0) + 1)
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
  const ASSET_GRID_BATCH_SIZE = 96
  let assetGridRenderLimit = ASSET_GRID_BATCH_SIZE
  let assetGridFilterKey = ''

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
    const nextFilterKey = `${assetSectionFilter}|${assetGroupFilter}|${q}`
    if (nextFilterKey !== assetGridFilterKey) {
      assetGridFilterKey = nextFilterKey
      assetGridRenderLimit = ASSET_GRID_BATCH_SIZE
    }

    const WALL_FILES = ['stone wall.glb', 'dark stone wall.glb', 'white wall.glb', 'wood wall.glb']

    filteredAssets = assetRegistry.filter((asset) => {
      if (assetSectionFilter === '__walls__') {
        const fileName = asset.path.split('/').pop().toLowerCase()
        return WALL_FILES.includes(fileName)
      }
      if (!assetMatchesSection(asset, assetSectionFilter)) return false
      const sectionGroup = assetGroupForSection(asset, assetSectionFilter)
      if (assetGroupFilter !== 'all' && sectionGroup !== assetGroupFilter) return false

      if (!q) return true

      const objectDefId = ASSET_TO_OBJECT_DEF[asset.id]
      const objectDef = objectDefId != null ? editorObjectDefById.get(objectDefId) : null
      const haystack = [
        asset.name,
        asset.section,
        sectionGroup,
        asset.folderPath,
        objectDef?.name,
        objectDef?.category,
        ...(asset.tags || [])
      ]
        .join(' ')
        .toLowerCase()

      return haystack.includes(q)
    })

    const selectedAssetIndex = filteredAssets.findIndex((a) => a.id === selectedAssetId)
    if (filteredAssets.length && (selectedAssetIndex < 0 || selectedAssetIndex >= assetGridRenderLimit)) {
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

    const visibleAssets = filteredAssets.slice(0, assetGridRenderLimit)

    for (const asset of visibleAssets) {
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

    if (visibleAssets.length < filteredAssets.length) {
      const more = document.createElement('button')
      more.type = 'button'
      more.className = 'asset-grid-more'
      more.textContent = `Show ${Math.min(ASSET_GRID_BATCH_SIZE, filteredAssets.length - visibleAssets.length)} more (${visibleAssets.length}/${filteredAssets.length})`
      more.addEventListener('click', () => {
        assetGridRenderLimit += ASSET_GRID_BATCH_SIZE
        refreshAssetList()
      })
      assetGrid.appendChild(more)
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
      const isStretched = !!tex.defaultScale || String(tex.path || '').includes('/stretched-textures/')
      if (paintTextureCat === 'stretched' && !isStretched) return false
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
        }
        textureScale = tex.defaultScale || 1
        if (paintTextureScaleSlider) {
          paintTextureScaleSlider.value = textureScale
          if (paintTextureScaleVal) paintTextureScaleVal.textContent = textureScale
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

  const allTabs = [tabProps, tabResources, tabModular, tabWalls, tabRoofs, tabBought]
  const clearTabs = () => allTabs.forEach(t => t.classList.remove('active'))

  tabProps.addEventListener('click', async () => {
    assetSectionFilter = 'Models'
    assetGroupFilter = 'all'
    clearTabs(); tabProps.classList.add('active')
    assetGroupSelect.style.display = 'none'
    refreshAssetList()
    await updatePreviewObject()
  })

  tabResources.addEventListener('click', async () => {
    assetSectionFilter = '__resources__'
    assetGroupFilter = 'all'
    clearTabs(); tabResources.classList.add('active')
    assetGroupSelect.style.display = ''
    refreshAssetGroupOptions()
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
  const openItemThumbnailEditor = () => {
    openItemThumbnailBrowser({
      loadItems: async () => {
        if (!itemDefs.length) await loadItemDefs()
        return itemDefs
      },
      resolveModelPath: resolveItemThumbnailModelPath,
    })
  }
  itemThumbsTopBtn?.addEventListener('click', openItemThumbnailEditor)
  itemThumbsBtn?.addEventListener('click', openItemThumbnailEditor)

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
    const candidates = [
      localStorage.getItem('projectrs-autosave'),
      localStorage.getItem('projectrs-autosave-prev'),
    ]
      .map(parseAutosave)
      .filter(Boolean)
      .sort((a, b) => autosaveWeight(b) - autosaveWeight(a))
    if (!candidates.length) { alert('No auto-save found.'); return }
    await loadSaveData(candidates[0])
  })

  // --- Server map integration ---
  const SERVER_API = '/api/editor'
  const serverMapSelect = topBar.querySelector('#serverMapSelect')
  const serverLoadBtn = topBar.querySelector('#serverLoadBtn')
  const serverSaveBtn = topBar.querySelector('#serverSaveBtn')
  const serverReloadBtn = topBar.querySelector('#serverReloadBtn')
  const questsBtn = topBar.querySelector('#questsBtn')
  const itemsBtn = topBar.querySelector('#itemsBtn')
  const dropsBtn = topBar.querySelector('#dropsBtn')
  let serverHealthOk = null
  let serverHealthTimer = null
  let serverHealthInFlight = false
  let serverSaveInProgress = false

  serverMapSelect?.addEventListener('change', () => {
    currentServerMapId = serverMapSelect.value || currentServerMapId
  })

  function setServerHealth(ok, detail = '') {
    const previous = serverHealthOk
    if (previous === ok && ok) return
    const wasOk = previous !== false
    serverHealthOk = ok
    if (serverSaveBtn) {
      serverSaveBtn.disabled = !ok || serverSaveInProgress
      serverSaveBtn.title = ok
        ? 'Save map to game server (overwrites!)'
        : `SERVER DOWN - Save disabled${detail ? `: ${detail}` : ''}`
    }
    if (serverReloadBtn) {
      serverReloadBtn.disabled = !ok
      serverReloadBtn.title = ok
        ? 'Hot-reload map in running game'
        : `SERVER DOWN - Reload disabled${detail ? `: ${detail}` : ''}`
    }
    if (!ok) {
      const message = `SERVER IS DOWN - DO NOT KEEP BUILDING WITHOUT SAVE BACKUP\n${detail || 'Cannot reach game server on :4000'}`
      showEditorNotice(message, 'error', 600000)
      if (wasOk) {
        window.alert(message)
      }
    } else if (previous === false) {
      showEditorNotice('Server connection restored', 'success', 4000)
    }
  }

  async function checkServerHealth() {
    if (serverHealthInFlight) return
    serverHealthInFlight = true
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 3000)
    try {
      const res = await fetch('/api/status', { cache: 'no-store', signal: controller.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      setServerHealth(true)
    } catch (err) {
      const detail = err?.name === 'AbortError'
        ? 'API heartbeat timed out'
        : (err?.message || String(err))
      setServerHealth(false, detail)
    } finally {
      clearTimeout(timeout)
      serverHealthInFlight = false
    }
  }

  checkServerHealth()
  serverHealthTimer = setInterval(checkServerHealth, 5000)

  async function refreshTeleportEntries() {
    try {
      const res = await fetch(`${SERVER_API}/teleport-entries`, { cache: 'no-store' })
      const data = await res.json()
      editorTeleportEntries = data.ok && Array.isArray(data.teleports) ? data.teleports : []
      editorDungeonExits = data.ok && Array.isArray(data.exits) ? data.exits : []
    } catch {
      editorTeleportEntries = []
      editorDungeonExits = []
    }
    renderTeleportOccupancyPreview()
  }

  async function saveNpcDefsToServer() {
    if (!confirmBuiltInNpcDefSave()) {
      const err = new Error('NPC defs save cancelled')
      err.cancelled = true
      throw err
    }
    const r = await fetch('/api/editor/npcs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ npcs: npcDefs }),
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok || !body.ok) throw new Error(body.error || 'unknown')
    snapshotBuiltInNpcDefs()
    clearDefsDirty('NPC defs saved ✓')
  }

  function buildCurrentMapServerPayload(mapId) {
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
      skybox: {
        color: map.mapType === 'dungeon' ? [...DEFAULT_DUNGEON_SKYBOX_COLOR] : [...DEFAULT_SKYBOX_COLOR],
        showSun: map.mapType !== 'dungeon'
      },
      transitions: []
    }
    return {
      mapId,
      meta,
      spawns: {
        npcs: serializeNpcSpawns(),
        objects: [],
        items: itemSpawns.map(s => ({ itemId: s.itemId, x: s.x, z: s.z, quantity: s.quantity }))
      },
      mapData: {
        map: saveData.map,
        placedObjects: saveData.placedObjects,
        layers: saveData.layers,
        activeLayerId: saveData.activeLayerId
      },
      walls: serializeCollisionData(),
      biomes: serializeBiomesData()
    }
  }

  async function postEditorJson(path, payload, { timeoutMs = 120000, bodyText = null } = {}) {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), timeoutMs)
    let response
    let text = ''
    try {
      response = await fetch(`${SERVER_API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: bodyText ?? JSON.stringify(payload),
        signal: controller.signal,
      })
      text = await response.text()
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`Server did not respond within ${Math.round(timeoutMs / 1000)}s`)
      }
      throw new Error(`Could not reach server: ${err?.message || err}`)
    } finally {
      clearTimeout(timeout)
    }

    let data = {}
    if (text) {
      try {
        data = JSON.parse(text)
      } catch {
        data = { error: text.slice(0, 300) }
      }
    }

    if (!response.ok || !data.ok) {
      const detail = data.error || response.statusText || 'unknown'
      throw new Error(`HTTP ${response.status}: ${detail}`)
    }
    return data
  }

  async function saveCurrentMapToServer(mapId) {
    const payload = buildCurrentMapServerPayload(mapId)
    const bankAccessErrors = bankAccessSaveErrors(mapId, payload.spawns.npcs)
    if (bankAccessErrors.length > 0) {
      throw new Error(`Bank-enabled NPC spawn blocked:\n${bankAccessErrors.join('\n')}`)
    }
    const payloadText = JSON.stringify(payload)
    const bytes = new TextEncoder().encode(payloadText).length
    const mb = bytes / 1024 / 1024
    showEditorNotice(`Saving "${mapId}" to server (${mb.toFixed(1)} MB)…`, 'info', 120000)
    const data = await postEditorJson('/save-map', payload, { timeoutMs: 180000, bodyText: payloadText })
    await refreshServerMapList(true)
    return { ...data, bytes }
  }

  // Quests editor — structured form. Two-pane modal: list of quests on the
  // left (with new/delete), per-quest editor on the right with all fields
  // exposed as proper inputs (no JSON). Save POSTs the entire array to
  // /api/editor/quests; server hot-reloads via DataLoader.reloadQuests.
  // Reuses the existing item-picker datalist and npcDefs cache so authors
  // pick by name rather than typing IDs.
  questsBtn?.addEventListener('click', () => openQuestsEditor())
  dropsBtn?.addEventListener('click', () => openDropsEditor(selectedNpcSpawn?.npcId))
  itemsBtn?.addEventListener('click', () => openItemStatsEditor({
    onSaved(savedItems) {
      itemDefs = savedItems
      const sel = sidebar.querySelector('#itemTypeSelect')
      if (sel) {
        const previous = sel.value
        sel.innerHTML = itemDefs.map(d => `<option value="${d.id}">${d.name} (${d.id})</option>`).join('')
        if ([...sel.options].some(o => o.value === previous)) sel.value = previous
      }
      const dl = document.getElementById('shopItemDatalist')
      if (dl) dl.dataset.signature = ''
      ensureShopItemDatalist()
    }
  }))

  async function openQuestsEditor() {
    const existing = document.getElementById('questsModal')
    if (existing) { existing.style.display = 'flex'; return }

    const ALL_QUEST_SKILLS = [
      'weaponry', 'strength', 'defence', 'goodmagic', 'evilmagic', 'archery', 'hitpoints',
      'woodcutting', 'fishing', 'cooking', 'mining', 'smithing', 'crafting', 'roguery',
    ]

    let quests = []
    let objectDefs = []
    let knownNpcSpawns = []
    let selectedQuestId = null
    let validationResult = null
    let questDialogueTouchedCurrentMap = false

    const overlay = document.createElement('div')
    overlay.id = 'questsModal'
    overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:999;display:flex;align-items:center;justify-content:center;'
    overlay.innerHTML = `
      <div style="background:#1a1a1a;border:1px solid #555;border-radius:6px;width:min(960px,95vw);max-height:88vh;display:flex;flex-direction:column;">
        <div style="display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid #333;">
          <div style="font-size:14px;font-weight:700;color:#eee;flex:1;">Quests Editor</div>
          <button id="qValidate" style="background:#4a4a2a;color:#fff;border:1px solid #555;border-radius:3px;padding:5px 12px;font-size:12px;cursor:pointer;">Validate</button>
          <button id="qSaveAll" style="background:#3a6c3a;color:#fff;border:1px solid #555;border-radius:3px;padding:5px 12px;font-size:12px;cursor:pointer;">Save Quest + Dialogue</button>
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
      quests.push({ id, name: 'New quest', blurb: '', stages: [{ id: 0, description: '' }], rewards: {} })
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
    overlay.querySelector('#qValidate').addEventListener('click', () => {
      const result = validateQuestAuthoring()
      const total = result.errors.length + result.warnings.length
      if (result.errors.length > 0) setStatus(`${result.errors.length} error(s), ${result.warnings.length} warning(s)`, '#e44')
      else if (result.warnings.length > 0) setStatus(`${result.warnings.length} warning(s)`, '#fc6')
      else setStatus('No validation issues ✓', '#6e6')
      renderEditor()
      if (total > 0) {
        setTimeout(() => overlay.querySelector('#qValidationPanel')?.scrollIntoView({ block: 'nearest' }), 0)
      }
    })
    overlay.querySelector('#qSaveAll').addEventListener('click', async () => {
      try {
        const savedParts = []
        const needsNpcDefsSave = npcDefsDirty
        const needsMapDialogueSave = questDialogueTouchedCurrentMap || currentMapQuestDialogueNeedsSave()

        if (needsNpcDefsSave) {
          await saveNpcDefsToServer()
          savedParts.push('NPC defs')
        }

        if (needsMapDialogueSave) {
          const mapId = serverMapSelect.value
          if (!mapId) {
            setStatus('Map dialogue needs a loaded map before it can be saved.', '#e44')
            return
          }
          await saveCurrentMapToServer(mapId)
          questDialogueTouchedCurrentMap = false
          savedParts.push(`${mapId} map dialogue`)
        }

        const r = await fetch('/api/editor/quests', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ quests }),
        })
        const body = await r.json().catch(() => ({}))
        if (!r.ok || !body.ok) {
          setStatus(`Quest save failed: ${body.error || 'unknown'}`, '#e44')
          return
        }
        savedParts.push(`${quests.length} quest(s)`)

        setStatus(`Saved ${savedParts.join(', ')} ✓`, '#6e6')
      } catch (e) {
        if (e?.cancelled) setStatus('Save cancelled before NPC defs were written.', '#aaa')
        else setStatus(`Network error: ${e.message}`, '#e44')
      }
    })

    // Load quests + objects in parallel; itemDefs already lazy-loaded by the
    // shared shop datalist helper.
    await Promise.all([
      fetch('/data/quests.json').then(r => r.json()).then(d => { quests = Array.isArray(d) ? d : [] }).catch(() => { quests = [] }),
      fetch('/data/objects.json').then(r => r.json()).then(d => { objectDefs = Array.isArray(d) ? d : []; questObjectDefs = objectDefs }).catch(() => { objectDefs = []; questObjectDefs = [] }),
      loadKnownNpcSpawns(),
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

    async function loadKnownNpcSpawns() {
      const mapIds = new Set(['kcmap'])
      try {
        const res = await fetch(`${SERVER_API}/maps`)
        const body = await res.json()
        if (body?.ok && Array.isArray(body.maps)) {
          for (const mapInfo of body.maps) {
            if (mapInfo?.id) mapIds.add(mapInfo.id)
          }
        }
      } catch {}

      const loaded = []
      await Promise.all([...mapIds].map(async mapId => {
        try {
          const res = await fetch(`/data/maps/${encodeURIComponent(mapId)}/spawns.json`)
          if (!res.ok) return
          const body = await res.json()
          const rows = Array.isArray(body) ? body : (Array.isArray(body?.npcs) ? body.npcs : [])
          for (const spawn of rows) loaded.push({ ...spawn, mapId })
        } catch {}
      }))
      knownNpcSpawns = loaded
    }

    function currentMapQuestDialogueNeedsSave() {
      for (const q of quests) {
        const triggers = []
        if (q.startTrigger) triggers.push(q.startTrigger)
        for (const stage of q.stages || []) {
          if (stage?.trigger) triggers.push(stage.trigger)
        }
        for (const trigger of triggers) {
          if (trigger.type !== 'dialogue' || !trigger.npcDefId || !trigger.npcName) continue
          const spawn = npcSpawns.find(s => s.npcId === trigger.npcDefId && s.name === trigger.npcName)
          if (spawn?.dialogue) return true
        }
      }
      return false
    }

    function renderEditor() {
      editorEl.innerHTML = ''
      const q = quests.find(x => x.id === selectedQuestId)
      if (!q) {
        editorEl.innerHTML = '<div style="color:#666;font-style:italic;text-align:center;padding:40px;">Select a quest from the list, or click "+ New Quest".</div>'
        return
      }

      // Top: name + id + blurb + repeatable
      editorEl.appendChild(renderQuestFlowCard(q))
      editorEl.appendChild(renderValidationPanel(q.id))
      editorEl.appendChild(field('Quest name', textInput(q.name || '', v => { q.name = v; renderList() })))
      editorEl.appendChild(field('Quest ID (do not change after players have started)', textInput(q.id, v => { const nv = v.trim() || q.id; if (nv !== q.id && quests.some(qq => qq.id === nv)) { setStatus('ID already exists', '#e44'); return } q.id = nv; selectedQuestId = nv; renderList() }, { font: 'monospace', color: '#cfc' })))
      editorEl.appendChild(field('Not-started journal text', textArea(q.blurb || '', v => { q.blurb = v }, 50)))
      editorEl.appendChild(checkboxRow('Repeatable (quest can be re-acquired after completion)', !!q.repeatable, v => { q.repeatable = v }))

      // Start trigger
      const startTrigSection = sectionWrap('How the quest starts', 'Most quests should start from dialogue: leave this as manual and use a dialogue action that sets the quest to stage 0. Use an automatic start only when any matching world event should begin the quest.')
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
          ['', 'Manual: started by dialogue/action'],
          ...questTriggerOptions(),
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
        if (q.startTrigger) startTrigContent.appendChild(renderTriggerFields(q.startTrigger, true, renderStartTrig, { q, stageIndex: null }))
      }
      renderStartTrig()
      editorEl.appendChild(startTrigSection)

      // Stages
      const stagesSection = sectionWrap('Player steps', 'Each step is a journal entry plus the event that moves the player to the next step. Leave the event as manual when dialogue should decide what happens next.')
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
          q.stages.push({ id: q.stages.length, description: '' })
          renderStages()
        })
        stagesContent.appendChild(addBtn)
      }
      renderStages()
      editorEl.appendChild(stagesSection)

      // Rewards
      const rewardsSection = sectionWrap('Completion rewards', 'Granted when a dialogue option or quest event completes the quest.')
      rewardsSection.appendChild(renderRewardsBlock(q))
      editorEl.appendChild(rewardsSection)
      editorEl.appendChild(renderAuthoringHelpers(q))
    }

    function renderStageBlock(q, idx, rerender) {
      const stage = q.stages[idx]
      stage.id = idx // keep ids in sync with array position so reorder is safe
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#1d1d1d;border:1px solid #3a3a3a;border-radius:4px;padding:8px;margin-bottom:8px;'
      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;gap:5px;margin-bottom:6px;'
      const t = document.createElement('div')
      t.textContent = idx === 0 ? 'Step 1: quest begins' : `Step ${idx + 1}`
      t.style.cssText = 'flex:1;font-size:12px;font-weight:bold;color:#ffcc44;'
      head.appendChild(t)
      const summary = document.createElement('div')
      summary.textContent = triggerSummary(stage.trigger, idx === q.stages.length - 1 ? 'Complete the quest or set another stage from dialogue.' : `Moves to step ${idx + 2}.`)
      summary.style.cssText = 'font-size:10px;color:#aaa;margin:0 8px 0 0;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
      head.appendChild(summary)
      const upBtn = iconBtn('▲', 'Move up', () => { if (idx === 0) return; const tmp = q.stages[idx - 1]; q.stages[idx - 1] = q.stages[idx]; q.stages[idx] = tmp; rerender() })
      const dnBtn = iconBtn('▼', 'Move down', () => { if (idx === q.stages.length - 1) return; const tmp = q.stages[idx + 1]; q.stages[idx + 1] = q.stages[idx]; q.stages[idx] = tmp; rerender() })
      const rmBtn = iconBtn('✕', 'Delete stage', () => { if (!confirm(`Delete stage ${idx}?`)) return; q.stages.splice(idx, 1); rerender() })
      rmBtn.style.background = '#6c2a2a'
      head.appendChild(upBtn); head.appendChild(dnBtn); head.appendChild(rmBtn)
      wrap.appendChild(head)
      wrap.appendChild(field('What the quest journal tells the player', textArea(stage.description || '', v => { stage.description = v }, 70)))

      // Trigger sub-form
      const trigWrap = document.createElement('div')
      trigWrap.style.cssText = 'margin-top:6px;'
      const trigLabel = document.createElement('label')
      trigLabel.textContent = 'What moves the player forward:'
      trigLabel.style.cssText = 'font-size:11px;color:#aaa;display:block;margin-bottom:4px;'
      trigWrap.appendChild(trigLabel)
      const trigBody = document.createElement('div')
      trigWrap.appendChild(trigBody)
      const renderTrig = () => {
        trigBody.innerHTML = ''
        const sel = document.createElement('select')
        sel.style.cssText = 'background:#2a2a2a;color:#fff;border:1px solid #555;border-radius:3px;padding:4px 6px;font-size:11px;margin-bottom:6px;'
        for (const opt of [
          ['', 'Manual: dialogue/action decides'],
          ...questTriggerOptions(),
        ]) {
          const o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1]; sel.appendChild(o)
        }
        sel.value = stage.trigger?.type || ''
        sel.addEventListener('change', () => {
          if (!sel.value) delete stage.trigger
          else stage.trigger = makeBlankTrigger(sel.value)
          renderTrig()
          rerender()
        })
        trigBody.appendChild(sel)
        if (stage.trigger) trigBody.appendChild(renderTriggerFields(stage.trigger, false, renderTrig, { q, stageIndex: idx }))
        else trigBody.appendChild(manualAdvanceHelp(q, idx))
      }
      renderTrig()
      wrap.appendChild(trigWrap)
      if (idx === q.stages.length - 1) wrap.appendChild(renderFinalStageRewards(q))
      return wrap
    }

    function setQuestRenownReward(q, value) {
      if (!q.rewards) q.rewards = {}
      const renown = Math.floor(Number(value) || 0)
      if (renown <= 0) delete q.rewards.renown
      else q.rewards.renown = Math.max(1, Math.min(10, renown))
    }

    function renderFinalStageRewards(q) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'margin-top:8px;background:#141414;border:1px solid #333;border-radius:3px;padding:7px 8px;'
      const label = document.createElement('div')
      label.textContent = 'Quest completion reward'
      label.style.cssText = 'font-size:11px;font-weight:bold;color:#d6b16a;margin-bottom:5px;'
      wrap.appendChild(label)
      wrap.appendChild(field('Renown when this final step completes (1-10)', numberInput(q.rewards?.renown || 0, 0, v => {
        setQuestRenownReward(q, v)
      }, { width: '80px', max: 10 })))
      return wrap
    }

    function renderQuestFlowCard(q) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#101826;border:1px solid #315070;border-radius:4px;padding:10px 12px;margin-bottom:12px;'
      const title = document.createElement('div')
      title.textContent = 'Quest flow'
      title.style.cssText = 'font-size:13px;font-weight:bold;color:#d7ecff;margin-bottom:8px;'
      wrap.appendChild(title)

      const rows = []
      rows.push(['Start', q.startTrigger ? triggerSummary(q.startTrigger) : 'Manual: a dialogue/action starts the quest at step 1.'])
      for (let i = 0; i < (q.stages || []).length; i++) {
        const stage = q.stages[i]
        const journal = (stage.description || '').trim().replace(/\s+/g, ' ')
        rows.push([`Step ${i + 1}`, journal || '(empty journal entry)'])
        rows.push(['Advance', triggerSummary(stage.trigger, i === (q.stages || []).length - 1 ? 'Complete the quest or set another stage from dialogue.' : `Moves to step ${i + 2}.`)])
      }
      rows.push(['Reward', rewardSummary(q.rewards)])

      for (const [label, text] of rows) {
        const row = document.createElement('div')
        row.style.cssText = 'display:grid;grid-template-columns:82px 1fr;gap:10px;align-items:start;margin:4px 0;'
        const l = document.createElement('div')
        l.textContent = label
        l.style.cssText = 'font-size:10px;color:#8bb8df;text-transform:uppercase;letter-spacing:0.04em;'
        const v = document.createElement('div')
        v.textContent = text
        v.style.cssText = 'font-size:11px;color:#e8f3ff;line-height:1.35;'
        row.appendChild(l); row.appendChild(v); wrap.appendChild(row)
      }
      return wrap
    }

    function manualAdvanceHelp(q, idx) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#101010;border:1px solid #2a2a2a;border-radius:3px;padding:7px 8px;color:#aaa;font-size:11px;line-height:1.35;'
      const next = idx + 1
      const complete = idx >= (q.stages?.length || 0) - 1
      wrap.textContent = complete
        ? 'Manual step. Finish it from dialogue or an object interaction with completeQuest, or add another step and setQuestStage to that step.'
        : `Manual step. In dialogue, use setQuestStage with stage ${next} to move to step ${next + 1}.`
      return wrap
    }

    function triggerSummary(trigger, fallback) {
      if (!trigger) return fallback || 'Manual: dialogue/action decides.'
      const times = trigger.count && trigger.count > 1 ? `${trigger.count} times` : 'once'
      const chance = trigger.chance && trigger.chance < 1 ? ` (${Math.round(trigger.chance * 100)}% chance)` : ''
      if (trigger.type === 'dialogue') {
        const npc = trigger.npcName || npcDefs.find(d => d.id === trigger.npcDefId)?.name || (trigger.npcDefId ? `NPC ${trigger.npcDefId}` : 'any NPC')
        const option = trigger.optionLabel ? `, option "${trigger.optionLabel}"` : ''
        return `Talk to ${npc}${option} ${times}${chance}.`
      }
      if (trigger.type === 'npcKill') {
        const npc = npcDefs.find(d => d.id === trigger.npcDefId)?.name || `NPC ${trigger.npcDefId || '?'}`
        return `Kill ${npc} ${times}${chance}.`
      }
      if (trigger.type === 'itemPickup') {
        const item = formatItemDisplay(trigger.itemId || 0)
        const qty = trigger.quantity && trigger.quantity > 1 ? `${trigger.quantity}x ` : ''
        return `Get ${qty}${item}${trigger.source === 'ground' ? ' from the ground' : ''}${chance}.`
      }
      if (trigger.type === 'chestOpen') {
        const chest = objectDefs.find(d => d.id === trigger.chestDefId)?.name || (trigger.chestDefId ? `chest ${trigger.chestDefId}` : 'any chest')
        return `Open ${chest} ${times}${chance}.`
      }
      if (trigger.type === 'objectInteract') {
        const obj = trigger.objectName || objectDefs.find(d => d.id === trigger.objectDefId)?.name || (trigger.objectDefId ? `object ${trigger.objectDefId}` : 'any object')
        return `Use ${obj}${trigger.action ? ` with "${trigger.action}"` : ''} ${times}${chance}.`
      }
      return `Unknown trigger "${trigger.type}".`
    }

    function rewardSummary(rewards) {
      const parts = []
      const xp = Object.entries(rewards?.xp || {}).filter(([, amount]) => amount > 0)
      if (xp.length) parts.push(xp.map(([skill, amount]) => `${amount} ${skill} XP`).join(', '))
      const items = (rewards?.items || []).filter(item => item.itemId)
      if (items.length) parts.push(items.map(item => `${item.quantity || 1}x ${formatItemDisplay(item.itemId)}`).join(', '))
      const renown = rewards?.renown
      if (Number.isInteger(renown) && renown > 0) parts.push(`${renown} renown`)
      return parts.length ? parts.join('; ') : 'No rewards set.'
    }

    function renderDialogueBeatPicker(trigger, rerender) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#151515;border:1px solid #2a2a2a;border-radius:3px;padding:7px 8px;'

      const beats = dialogueBeatsForTrigger(trigger)
      if (beats.length > 0) {
        const label = document.createElement('label')
        label.textContent = 'Dialogue moment that advances this'
        label.style.cssText = 'display:block;font-size:11px;color:#aaa;margin-bottom:3px;'
        wrap.appendChild(label)

        const sel = document.createElement('select')
        sel.style.cssText = 'width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
        const any = document.createElement('option')
        any.value = ''
        any.textContent = 'Any dialogue option on this NPC'
        sel.appendChild(any)
        for (const beat of beats) {
          const o = document.createElement('option')
          o.value = `${beat.nodeId}\n${beat.optionLabel}`
          o.textContent = `${beat.npcSays} -> player chooses "${beat.optionLabel}"`
          sel.appendChild(o)
        }
        sel.value = trigger.nodeId && trigger.optionLabel ? `${trigger.nodeId}\n${trigger.optionLabel}` : ''
        sel.addEventListener('change', () => {
          if (!sel.value) {
            delete trigger.nodeId
            delete trigger.optionLabel
          } else {
            const [nodeId, optionLabel] = sel.value.split('\n')
            trigger.nodeId = nodeId
            trigger.optionLabel = optionLabel
          }
          rerender?.()
        })
        wrap.appendChild(sel)

        const selected = beats.find(beat => beat.nodeId === trigger.nodeId && beat.optionLabel === trigger.optionLabel)
        const preview = document.createElement('div')
        preview.style.cssText = 'font-size:11px;color:#aaa;line-height:1.35;margin-top:6px;'
        preview.textContent = selected
          ? `NPC says: ${selected.fullLines.join(' ')}`
          : 'Pick a specific NPC line and player response when only one dialogue choice should advance the quest.'
        wrap.appendChild(preview)
      } else {
        const empty = document.createElement('div')
        empty.style.cssText = 'font-size:11px;color:#aaa;line-height:1.35;margin-bottom:7px;'
        empty.textContent = trigger.npcDefId
          ? 'This NPC has no dialogue tree loaded in the editor. You can still match by raw node id and option label.'
          : 'Choose an NPC to pick from its actual dialogue lines, or use raw matching fields below.'
        wrap.appendChild(empty)
      }

      const advanced = document.createElement('details')
      advanced.style.cssText = 'margin-top:7px;'
      advanced.open = beats.length === 0
      const summary = document.createElement('summary')
      summary.textContent = 'Advanced matching'
      summary.style.cssText = 'font-size:11px;color:#8bb8df;cursor:pointer;'
      advanced.appendChild(summary)
      const body = document.createElement('div')
      body.style.cssText = 'margin-top:7px;'
      body.appendChild(field('Dialogue node ID', textInput(trigger.nodeId || '', v => { const s = v.trim(); if (s) trigger.nodeId = s; else delete trigger.nodeId }, { font: 'monospace' })))
      body.appendChild(field('Player option label', textInput(trigger.optionLabel || '', v => { const s = v.trim(); if (s) trigger.optionLabel = s; else delete trigger.optionLabel })))
      advanced.appendChild(body)
      wrap.appendChild(advanced)
      return wrap
    }

    function dialogueBeatsForTrigger(trigger) {
      const trees = dialogueTreesForTrigger(trigger)
      const beats = []
      const seen = new Set()
      for (const { tree } of trees) {
        if (!tree?.nodes || typeof tree.nodes !== 'object') continue
        for (const [nodeKey, node] of Object.entries(tree.nodes)) {
          if (!node || !Array.isArray(node.options)) continue
          const nodeId = node.id || nodeKey
          const lines = Array.isArray(node.lines) ? node.lines.filter(Boolean).map(String) : []
          const npcSays = summarizeDialogueLines(lines, nodeId)
          for (const opt of node.options) {
            if (!opt?.label) continue
            const key = `${nodeId}\n${opt.label}`
            if (seen.has(key)) continue
            seen.add(key)
            beats.push({ nodeId, optionLabel: opt.label, npcSays, fullLines: lines.length ? lines : [`Node ${nodeId}`] })
          }
        }
      }
      return beats.sort((a, b) => `${a.npcSays} ${a.optionLabel}`.localeCompare(`${b.npcSays} ${b.optionLabel}`))
    }

    function dialogueTreesForTrigger(trigger) {
      const trees = []
      const allSpawns = allQuestNpcSpawns()
      if (trigger.npcName) {
        for (const spawn of allSpawns.filter(s => s.npcId === trigger.npcDefId && s.name === trigger.npcName)) {
          const def = npcDefs.find(d => d.id === spawn.npcId)
          const tree = spawn.dialogue ?? def?.dialogue
          if (tree) trees.push({ label: spawn.name, tree })
        }
      } else if (trigger.npcDefId) {
        const def = npcDefs.find(d => d.id === trigger.npcDefId)
        if (def?.dialogue) trees.push({ label: def.name, tree: def.dialogue })
        for (const spawn of allSpawns.filter(s => s.npcId === trigger.npcDefId && s.dialogue)) {
          trees.push({ label: spawn.name || def?.name || `NPC ${trigger.npcDefId}`, tree: spawn.dialogue })
        }
      }
      return trees
    }

    function allQuestNpcSpawns() {
      const byKey = new Map()
      for (const spawn of [...knownNpcSpawns, ...npcSpawns]) {
        const key = `${spawn.mapId || 'current'}:${spawn.id ?? ''}:${spawn.npcId}:${spawn.name || ''}:${spawn.x ?? ''}:${spawn.z ?? ''}`
        byKey.set(key, spawn)
      }
      return [...byKey.values()]
    }

    function summarizeDialogueLines(lines, fallbackId) {
      const text = (lines || []).join(' ').replace(/\s+/g, ' ').trim()
      if (!text) return `Node ${fallbackId}`
      return text.length > 92 ? `${text.slice(0, 89)}...` : text
    }

    function renderAddDialogueOptionBlock(trigger, context, rerender) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#151515;border:1px solid #315070;border-radius:3px;padding:8px;'
      const head = document.createElement('div')
      head.textContent = 'Add the dialogue option to this NPC'
      head.style.cssText = 'font-size:11px;color:#d7ecff;font-weight:bold;margin-bottom:6px;'
      wrap.appendChild(head)

      if (!trigger.npcDefId) {
        const msg = document.createElement('div')
        msg.textContent = 'Choose an NPC first, then add the player option and NPC reply here.'
        msg.style.cssText = 'font-size:11px;color:#aaa;line-height:1.35;'
        wrap.appendChild(msg)
        return wrap
      }

      const tree = editableDialogueTreePreview(trigger)
      const nodeEntries = Object.entries(tree.nodes || {})
      const values = {
        parentNodeId: tree.root || nodeEntries[0]?.[0] || 'start',
        optionLabel: context?.stageIndex == null ? 'Start the quest.' : 'Ask about the quest.',
        npcReply: context?.stageIndex == null ? 'Let me tell you what I need.' : 'Here is what you need to know.',
        extraTurns: [],
      }

      const parentSelect = document.createElement('select')
      parentSelect.style.cssText = 'width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      for (const [nodeId, node] of nodeEntries.length ? nodeEntries : [['start', { id: 'start', lines: ['Hello!'], options: [] }]]) {
        const o = document.createElement('option')
        o.value = nodeId
        o.textContent = `${nodeId}: ${summarizeDialogueLines(node.lines || [], nodeId)}`
        parentSelect.appendChild(o)
      }
      parentSelect.value = values.parentNodeId
      parentSelect.addEventListener('change', () => { values.parentNodeId = parentSelect.value })

      wrap.appendChild(field('Add the option under NPC line', parentSelect))
      wrap.appendChild(field('Player option text', textInput(values.optionLabel, v => { values.optionLabel = v })))
      wrap.appendChild(field('NPC reply after the player chooses it', textArea(values.npcReply, v => { values.npcReply = v }, 55)))

      const extraTurnsWrap = document.createElement('div')
      extraTurnsWrap.style.cssText = 'margin-top:4px;'
      const renderExtraTurns = () => {
        extraTurnsWrap.innerHTML = ''
        for (let i = 0; i < values.extraTurns.length; i++) {
          const idx = i
          const item = values.extraTurns[idx]
          const row = document.createElement('div')
          row.style.cssText = 'background:#101010;border:1px solid #2a2a2a;border-radius:3px;padding:7px 8px;margin-bottom:6px;'
          const rowHead = document.createElement('div')
          rowHead.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:6px;'
          const rowTitle = document.createElement('div')
          rowTitle.textContent = item.kind === 'npc'
            ? `NPC continues ${idx + 1}`
            : `Player/NPC exchange ${idx + 1}`
          rowTitle.style.cssText = 'flex:1;font-size:11px;color:#ddd;font-weight:bold;'
          const rm = iconBtn('✕', 'Remove this entry', () => {
            values.extraTurns.splice(idx, 1)
            renderExtraTurns()
          })
          rm.style.background = '#6c2a2a'
          rowHead.appendChild(rowTitle)
          rowHead.appendChild(rm)
          row.appendChild(rowHead)
          if (item.kind === 'npc') {
            row.appendChild(field('NPC says next', textArea(item.npcLine, v => { item.npcLine = v }, 50)))
          } else {
            row.appendChild(field('Player says', textArea(item.playerLine, v => { item.playerLine = v }, 42)))
            row.appendChild(field('NPC replies', textArea(item.npcLine, v => { item.npcLine = v }, 50)))
          }
          extraTurnsWrap.appendChild(row)
        }
        const actions = document.createElement('div')
        actions.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;'
        const addNpc = document.createElement('button')
        addNpc.textContent = '+ NPC continues'
        addNpc.style.cssText = 'background:#26384d;color:#fff;border:1px solid #4c6580;border-radius:3px;padding:5px 10px;font-size:11px;cursor:pointer;'
        addNpc.addEventListener('click', () => {
          values.extraTurns.push({ kind: 'npc', npcLine: 'Here is more.' })
          renderExtraTurns()
        })
        const addExchange = document.createElement('button')
        addExchange.textContent = '+ Player/NPC exchange'
        addExchange.style.cssText = 'background:#26384d;color:#fff;border:1px solid #4c6580;border-radius:3px;padding:5px 10px;font-size:11px;cursor:pointer;'
        addExchange.addEventListener('click', () => {
          values.extraTurns.push({ kind: 'exchange', playerLine: 'I have another question.', npcLine: 'Here is more.' })
          renderExtraTurns()
        })
        actions.appendChild(addNpc)
        actions.appendChild(addExchange)
        extraTurnsWrap.appendChild(actions)
      }
      renderExtraTurns()
      wrap.appendChild(extraTurnsWrap)

      const applyBtn = document.createElement('button')
      applyBtn.textContent = 'Add option and wire quest advance'
      applyBtn.style.cssText = 'background:#2a4a6c;color:#fff;border:1px solid #5d86b0;border-radius:3px;padding:6px 10px;font-size:11px;cursor:pointer;margin-top:2px;'
      applyBtn.addEventListener('click', () => {
        const target = ensureEditableDialogueTree(trigger)
        if (!target) {
          setStatus(trigger.npcName ? 'Load the map containing this named NPC before adding its quest dialogue.' : 'Choose a valid NPC first', '#e44')
          return
        }
        const tree = target.tree
        if (!tree.root) tree.root = 'start'
        if (!tree.nodes || typeof tree.nodes !== 'object') tree.nodes = {}
        if (!tree.nodes[values.parentNodeId]) {
          tree.nodes[values.parentNodeId] = { id: values.parentNodeId, lines: ['Hello!'], options: [] }
          if (!tree.root) tree.root = values.parentNodeId
        }
        const parent = tree.nodes[values.parentNodeId]
        if (!Array.isArray(parent.lines)) parent.lines = []
        if (!Array.isArray(parent.options)) parent.options = []

        const optionLabel = (values.optionLabel || '').trim() || 'Ask about the quest.'
        const nodeBase = `${context?.q?.id || 'quest'}_${context?.stageIndex == null ? 'start' : `stage_${context.stageIndex}`}_reply`
        const replyNodeId = uniqueDialogueNodeId(tree, nodeBase)
        const condition = context?.stageIndex == null
          ? { type: 'questNotStarted', questId: context?.q?.id || '' }
          : { type: 'questStage', questId: context?.q?.id || '', minStage: context.stageIndex, maxStage: context.stageIndex }

        parent.options.push({ label: optionLabel, next: replyNodeId, condition })
        const firstReply = {
          id: replyNodeId,
          lines: dialogueLinesFromText(values.npcReply, 'Here is what you need to know.'),
          options: [],
        }
        tree.nodes[replyNodeId] = firstReply

        let currentNode = firstReply
        for (let i = 0; i < values.extraTurns.length; i++) {
          const turn = values.extraTurns[i]
          if (turn.kind === 'npc') {
            currentNode.lines.push(...dialogueLinesFromText(turn.npcLine, 'Here is more.'))
            continue
          }
          const playerNodeId = uniqueDialogueNodeId(tree, `${nodeBase}_player_${i + 1}`)
          const npcNodeId = uniqueDialogueNodeId(tree, `${nodeBase}_npc_${i + 1}`)
          currentNode.options.push({ label: 'Continue.', next: playerNodeId })
          tree.nodes[playerNodeId] = {
            id: playerNodeId,
            speaker: 'You',
            lines: dialogueLinesFromText(turn.playerLine, 'I have another question.'),
            options: [{ label: 'Continue.', next: npcNodeId }],
          }
          currentNode = {
            id: npcNodeId,
            lines: dialogueLinesFromText(turn.npcLine, 'Here is more.'),
            options: [],
          }
          tree.nodes[npcNodeId] = currentNode
        }
        currentNode.options.push({ label: 'Continue.' })

        trigger.nodeId = values.parentNodeId
        trigger.optionLabel = optionLabel
        if (target.kind === 'def') markDefsDirty()
        if (target.kind === 'spawn') questDialogueTouchedCurrentMap = true
        setStatus(target.kind === 'spawn' ? 'Added option. Use Save Quest + Dialogue to persist it.' : 'Added option. Use Save Quest + Dialogue to persist it.', '#6e6')
        rerender?.()
      })
      wrap.appendChild(applyBtn)
      return wrap
    }

    function editableDialogueTreePreview(trigger) {
      const target = findDialogueEditTarget(trigger)
      return target?.tree || { root: 'start', nodes: { start: { id: 'start', lines: ['Hello!'], options: [] } } }
    }

    function ensureEditableDialogueTree(trigger) {
      const target = findDialogueEditTarget(trigger)
      if (!target) return null
      if (!target.tree) {
        target.tree = { root: 'start', nodes: { start: { id: 'start', lines: ['Hello!'], options: [] } } }
        if (target.kind === 'spawn') target.owner.dialogue = target.tree
        else target.owner.dialogue = target.tree
      }
      return target
    }

    function findDialogueEditTarget(trigger) {
      if (!trigger.npcDefId) return null
      const currentSpawn = trigger.npcName
        ? npcSpawns.find(s => s.npcId === trigger.npcDefId && s.name === trigger.npcName)
        : null
      if (trigger.npcName && !currentSpawn) return null
      if (currentSpawn) {
        if (!currentSpawn.dialogue) {
          const def = npcDefs.find(d => d.id === currentSpawn.npcId)
          currentSpawn.dialogue = def?.dialogue
            ? JSON.parse(JSON.stringify(def.dialogue))
            : { root: 'start', nodes: { start: { id: 'start', lines: ['Hello!'], options: [] } } }
        }
        return { kind: 'spawn', owner: currentSpawn, tree: currentSpawn.dialogue }
      }
      const def = npcDefs.find(d => d.id === trigger.npcDefId)
      if (!def) return null
      return { kind: 'def', owner: def, tree: def.dialogue }
    }

    function uniqueDialogueNodeId(tree, base) {
      const clean = String(base || 'quest_reply').replace(/[^\w-]+/g, '_')
      let id = clean
      let i = 2
      while (tree.nodes?.[id]) {
        id = `${clean}_${i++}`
      }
      return id
    }

    function dialogueLinesFromText(text, fallback) {
      const lines = String(text || '')
        .split('\n')
        .map(line => line.trim())
        .filter(Boolean)
      return lines.length ? lines : [fallback]
    }

    function renderTriggerFields(trigger, includeChance, rerender, context) {
      const wrap = document.createElement('div')
      wrap.style.cssText = 'background:#101010;border:1px solid #2a2a2a;border-radius:3px;padding:6px 8px;display:flex;flex-direction:column;gap:6px;'
      if (trigger.type === 'dialogue') {
        wrap.appendChild(field('NPC (optional — leave blank for any NPC)', dialogueNpcSelect(trigger, () => { rerender?.() })))
        wrap.appendChild(renderAddDialogueOptionBlock(trigger, context, rerender))
        wrap.appendChild(renderDialogueBeatPicker(trigger, rerender))
        wrap.appendChild(field('Times needed', numberInput(trigger.count ?? 1, 1, v => { if (v <= 1) delete trigger.count; else trigger.count = v })))
      } else if (trigger.type === 'npcKill') {
        wrap.appendChild(field('NPC', npcSelect(trigger.npcDefId ?? 0, v => { trigger.npcDefId = v })))
        wrap.appendChild(field('Count needed', numberInput(trigger.count ?? 1, 1, v => { if (v <= 1) delete trigger.count; else trigger.count = v })))
      } else if (trigger.type === 'itemPickup') {
        wrap.appendChild(field('Item', itemPicker(trigger.itemId ?? 0, v => { trigger.itemId = v })))
        wrap.appendChild(field('Quantity needed', numberInput(trigger.quantity ?? 1, 1, v => { if (v <= 1) delete trigger.quantity; else trigger.quantity = v })))
        wrap.appendChild(field('Source', sourceSelect(trigger.source || 'any', v => { if (v === 'any') delete trigger.source; else trigger.source = v })))
      } else if (trigger.type === 'chestOpen') {
        wrap.appendChild(field('Specific chest type (optional — leave blank for any chest)', chestSelect(trigger.chestDefId, v => { if (v == null) delete trigger.chestDefId; else trigger.chestDefId = v })))
        wrap.appendChild(field('Count needed', numberInput(trigger.count ?? 1, 1, v => { if (v <= 1) delete trigger.count; else trigger.count = v })))
      } else if (trigger.type === 'objectInteract') {
        wrap.appendChild(field('Object (optional — leave blank for any object)', objectTriggerSelect(trigger, () => {})))
        wrap.appendChild(field('Action label (optional, exact match)', textInput(trigger.action || '', v => { const s = v.trim(); if (s) trigger.action = s; else delete trigger.action })))
        wrap.appendChild(field('Count needed', numberInput(trigger.count ?? 1, 1, v => { if (v <= 1) delete trigger.count; else trigger.count = v })))
      }
      if (includeChance) {
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

    function renderValidationPanel(questId) {
      const wrap = document.createElement('div')
      wrap.id = 'qValidationPanel'
      const messages = validationResult
        ? [...validationResult.errors, ...validationResult.warnings].filter(m => !questId || !m.questId || m.questId === questId)
        : []
      const hasErrors = validationResult?.errors?.some(m => !questId || !m.questId || m.questId === questId)
      wrap.style.cssText = `background:${messages.length ? '#201616' : '#142016'};border:1px solid ${messages.length ? (hasErrors ? '#804444' : '#806b35') : '#2d6638'};border-radius:4px;padding:8px 10px;margin-bottom:12px;`
      const head = document.createElement('div')
      head.style.cssText = `font-size:12px;font-weight:bold;color:${messages.length ? (hasErrors ? '#f88' : '#fc6') : '#8e8'};margin-bottom:${messages.length ? '6px' : '0'};`
      head.textContent = validationResult
        ? (messages.length ? `Validation issues (${messages.length})` : 'Validation clean')
        : 'Validation has not been run'
      wrap.appendChild(head)
      for (const msg of messages.slice(0, 12)) {
        const row = document.createElement('div')
        row.style.cssText = `font-size:11px;line-height:1.35;color:${msg.level === 'error' ? '#f99' : '#fc6'};margin:2px 0;`
        row.textContent = `${msg.level.toUpperCase()}: ${msg.path} — ${msg.message}`
        wrap.appendChild(row)
      }
      if (messages.length > 12) {
        const more = document.createElement('div')
        more.style.cssText = 'font-size:11px;color:#aaa;margin-top:4px;'
        more.textContent = `+ ${messages.length - 12} more issue(s)`
        wrap.appendChild(more)
      }
      return wrap
    }

    function renderAuthoringHelpers(q) {
      const section = sectionWrap('Dialogue helpers', 'Use these when an NPC option needs to start, advance, complete, or gate a quest. The generated snippet is for the dialogue option fields.')
      const body = document.createElement('div')
      body.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:start;'
      const actionBox = helperBox('Action builder')
      const conditionBox = helperBox('Condition builder')
      body.appendChild(actionBox)
      body.appendChild(conditionBox)
      section.appendChild(body)
      return section

      function helperBox(title) {
        const box = document.createElement('div')
        box.style.cssText = 'background:#101010;border:1px solid #2a2a2a;border-radius:3px;padding:8px;min-width:0;'
        const label = document.createElement('div')
        label.textContent = title
        label.style.cssText = 'font-size:11px;color:#aaa;font-weight:bold;margin-bottom:6px;'
        box.appendChild(label)
        const typeSel = document.createElement('select')
        typeSel.style.cssText = 'width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;margin-bottom:8px;'
        const options = title.startsWith('Action')
          ? [
              ['setQuestStage', 'Set quest stage'],
              ['completeQuest', 'Complete quest'],
              ['giveItem', 'Give item'],
              ['takeItem', 'Take item'],
              ['bankInventoryItemsForCoins', 'Bank items for coins'],
              ['openShop', 'Open shop'],
              ['openBank', 'Open bank'],
              ['openAppearance', 'Open appearance'],
              ['closeDialogue', 'Close dialogue'],
            ]
          : [
              ['questStage', 'Quest stage'],
              ['questStarted', 'Quest started'],
              ['questNotStarted', 'Quest not started'],
              ['questCompleted', 'Quest completed'],
              ['hasItem', 'Has item'],
              ['hasEquippedItem', 'Has equipped item'],
              ['skillLevel', 'Skill level'],
              ['combatLevel', 'Combat level'],
              ['all', 'All of'],
              ['any', 'Any of'],
              ['not', 'Not'],
            ]
        for (const [value, text] of options) {
          const o = document.createElement('option'); o.value = value; o.textContent = text; typeSel.appendChild(o)
        }
        box.appendChild(typeSel)
        const form = document.createElement('div')
        const out = document.createElement('textarea')
        out.readOnly = true
        out.style.cssText = 'width:100%;height:86px;background:#080808;color:#cfc;border:1px solid #333;border-radius:3px;padding:6px;font-family:monospace;font-size:10px;box-sizing:border-box;resize:vertical;'
        box.appendChild(form)
        box.appendChild(out)
        const render = () => {
          form.innerHTML = ''
          const values = {}
          const update = () => { out.value = JSON.stringify(buildSnippet(typeSel.value, title.startsWith('Action'), values), null, 2) }
          const addQuest = () => form.appendChild(field('Quest', questSelect(values.questId || selectedQuestId || quests[0]?.id || '', v => { values.questId = v; update() })))
          const addItemQty = () => {
            form.appendChild(field('Item', itemPicker(values.itemId || 0, v => { values.itemId = v; update() })))
            form.appendChild(field('Quantity', numberInput(values.qty || values.quantity || 1, 1, v => { values.qty = v; values.quantity = v; update() }, { width: '100%' })))
          }
          if (title.startsWith('Action')) {
            if (typeSel.value === 'setQuestStage') {
              addQuest()
              form.appendChild(field('Stage', numberInput(values.stage ?? 0, 0, v => { values.stage = v; update() }, { width: '100%' })))
            } else if (typeSel.value === 'completeQuest') addQuest()
            else if (typeSel.value === 'giveItem' || typeSel.value === 'takeItem') addItemQty()
            else if (typeSel.value === 'bankInventoryItemsForCoins') {
              form.appendChild(field('Fallback coin cost', numberInput(values.coinCost ?? 10, 0, v => { values.coinCost = v; update() }, { width: '100%' })))
            }
          } else {
            if (['questStage', 'questStarted', 'questNotStarted', 'questCompleted'].includes(typeSel.value)) addQuest()
            if (typeSel.value === 'questStage') {
              form.appendChild(field('Min stage', numberInput(values.minStage ?? 0, 0, v => { values.minStage = v; update() }, { width: '100%' })))
              form.appendChild(field('Max stage', numberInput(values.maxStage ?? 0, 0, v => { values.maxStage = v; update() }, { width: '100%' })))
            } else if (typeSel.value === 'hasItem') addItemQty()
            else if (typeSel.value === 'hasEquippedItem') form.appendChild(field('Item', itemPicker(values.itemId || 0, v => { values.itemId = v; update() })))
            else if (typeSel.value === 'skillLevel') {
              form.appendChild(field('Skill', skillSelect(values.skill || ALL_QUEST_SKILLS[0], v => { values.skill = v; update() })))
              form.appendChild(field('Level', numberInput(values.level || 1, 1, v => { values.level = v; update() }, { width: '100%' })))
            } else if (typeSel.value === 'combatLevel') {
              form.appendChild(field('Level', numberInput(values.level || 1, 1, v => { values.level = v; update() }, { width: '100%' })))
            }
          }
          update()
        }
        typeSel.addEventListener('change', render)
        render()
        return box
      }
    }

    function buildSnippet(type, isAction, values) {
      if (isAction) {
        if (type === 'setQuestStage') return { type, questId: values.questId || selectedQuestId || '', stage: values.stage ?? 0 }
        if (type === 'completeQuest') return { type, questId: values.questId || selectedQuestId || '' }
        if (type === 'giveItem' || type === 'takeItem') return { type, itemId: values.itemId || 0, qty: values.qty || 1 }
        if (type === 'bankInventoryItemsForCoins') {
          return {
            type,
            itemIds: [25, 26, 34, 35, 44, 45, 142, 407, 408],
            coinCost: values.coinCost ?? 10,
            coinCostByItemId: { 25: 1, 34: 1, 26: 2, 35: 3, 44: 4, 142: 4, 45: 6, 407: 8, 408: 8 },
            itemLabel: 'ore',
          }
        }
        return { type }
      }
      if (type === 'questStage') return { type, questId: values.questId || selectedQuestId || '', minStage: values.minStage ?? 0, maxStage: values.maxStage ?? 0 }
      if (type === 'questStarted' || type === 'questNotStarted' || type === 'questCompleted') return { type, questId: values.questId || selectedQuestId || '' }
      if (type === 'hasItem') return { type, itemId: values.itemId || 0, quantity: values.quantity || 1 }
      if (type === 'hasEquippedItem') return { type, itemId: values.itemId || 0 }
      if (type === 'skillLevel') return { type, skill: values.skill || ALL_QUEST_SKILLS[0], level: values.level || 1 }
      if (type === 'combatLevel') return { type, level: values.level || 1 }
      if (type === 'all' || type === 'any') return { type, conditions: [] }
      if (type === 'not') return { type, condition: { type: 'questStarted', questId: selectedQuestId || '' } }
      return { type }
    }

    function validateQuestAuthoring() {
      const errors = []
      const warnings = []
      const issue = (level, questId, path, message) => (level === 'error' ? errors : warnings).push({ level, questId, path, message })
      const questIds = new Set()
      const duplicateIds = new Set()
      for (const q of quests) {
        if (!q.id || typeof q.id !== 'string') issue('error', q.id, 'quest.id', 'Quest ID is required.')
        else if (questIds.has(q.id)) duplicateIds.add(q.id)
        else questIds.add(q.id)
      }
      for (const id of duplicateIds) issue('error', id, `quest "${id}"`, 'Duplicate quest ID.')

      for (const q of quests) {
        const qid = q.id || '(missing id)'
        if (!q.name) issue('warning', q.id, `${qid}.name`, 'Quest has no display name.')
        if (!Array.isArray(q.stages) || q.stages.length === 0) issue('error', q.id, `${qid}.stages`, 'Quest needs at least one stage.')
        validateTrigger(q.startTrigger, q.id, `${qid}.startTrigger`, true)
        for (let i = 0; i < (q.stages || []).length; i++) {
          const stage = q.stages[i]
          const isFinalStage = i === (q.stages || []).length - 1
          if (stage.id !== i) issue('warning', q.id, `${qid}.stages[${i}].id`, 'Stage ID will be normalized to its array index.')
          if (!stage.description) issue('warning', q.id, `${qid}.stages[${i}].description`, 'Stage journal entry is empty.')
          validateTrigger(stage.trigger, q.id, `${qid}.stages[${i}].trigger`, false, isFinalStage && questHasCompletionAction(q.id))
        }
        if (q.rewards?.xp) {
          for (const [skill, amount] of Object.entries(q.rewards.xp)) {
            if (!ALL_QUEST_SKILLS.includes(skill)) issue('error', q.id, `${qid}.rewards.xp.${skill}`, 'Unknown skill.')
            if (typeof amount !== 'number' || amount <= 0) issue('warning', q.id, `${qid}.rewards.xp.${skill}`, 'XP reward should be positive.')
          }
        }
        if (q.rewards?.renown !== undefined) {
          if (!Number.isInteger(q.rewards.renown) || q.rewards.renown < 1 || q.rewards.renown > 10) {
            issue('error', q.id, `${qid}.rewards.renown`, 'Renown reward must be a whole number from 1 to 10.')
          }
        }
        for (let i = 0; i < (q.rewards?.items || []).length; i++) {
          validateItemRef(q.rewards.items[i].itemId, q.id, `${qid}.rewards.items[${i}].itemId`, issue)
        }
      }

      for (const def of npcDefs) {
        if (def.dialogue) validateDialogueTree(def.dialogue, `NPC ${def.name} (${def.id})`, null)
      }
      for (const spawn of npcSpawns) {
        if (spawn.dialogue) validateDialogueTree(spawn.dialogue, `NPC spawn ${spawn.name || spawn.npcId} (${spawn.id})`, null)
      }

      validationResult = { errors, warnings }
      return validationResult

      function validateTrigger(trigger, questId, path, allowMissing, suppressMissingWarning) {
        if (!trigger) {
          if (!allowMissing && !suppressMissingWarning) issue('warning', questId, path, 'No trigger; this stage must be advanced by dialogue action or completion.')
          return
        }
        if (trigger.type === 'dialogue') {
          if (trigger.npcDefId !== undefined) validateNpcRef(trigger.npcDefId, questId, `${path}.npcDefId`, issue)
          if (trigger.npcName && !allQuestNpcSpawns().some(s => s.npcId === trigger.npcDefId && s.name === trigger.npcName)) {
            issue('warning', questId, `${path}.npcName`, 'No loaded map data has this named NPC spawn.')
          }
        } else if (trigger.type === 'itemPickup') {
          validateItemRef(trigger.itemId, questId, `${path}.itemId`, issue)
        } else if (trigger.type === 'npcKill') {
          validateNpcRef(trigger.npcDefId, questId, `${path}.npcDefId`, issue)
        } else if (trigger.type === 'chestOpen') {
          if (trigger.chestDefId !== undefined && !objectDefs.some(d => d.id === trigger.chestDefId && d.category === 'chest')) {
            issue('error', questId, `${path}.chestDefId`, 'Chest object ID does not exist or is not a chest.')
          }
        } else if (trigger.type === 'objectInteract') {
          if (trigger.objectDefId !== undefined && !objectDefs.some(d => d.id === trigger.objectDefId)) {
            issue('error', questId, `${path}.objectDefId`, 'Object ID does not exist.')
          }
          if (trigger.objectName && !namedPlacedObjects().some(o => o.objectDefId === trigger.objectDefId && o.name === trigger.objectName)) {
            issue('warning', questId, `${path}.objectName`, 'No currently loaded placed object has this object name.')
          }
        } else {
          issue('error', questId, path, `Unknown trigger type "${trigger.type}".`)
        }
        if (trigger.chance !== undefined && (typeof trigger.chance !== 'number' || trigger.chance <= 0 || trigger.chance > 1)) {
          issue('error', questId, `${path}.chance`, 'Chance must be > 0 and <= 1.')
        }
      }

      function validateDialogueTree(tree, label, questId) {
        if (!tree || typeof tree.root !== 'string' || !tree.nodes || typeof tree.nodes !== 'object') {
          issue('error', questId, label, 'Dialogue tree must have root and nodes.')
          return
        }
        if (!tree.nodes[tree.root]) issue('error', questId, `${label}.root`, `Root node "${tree.root}" is missing.`)
        for (const [nodeId, node] of Object.entries(tree.nodes)) {
          if (!Array.isArray(node.lines)) issue('error', questId, `${label}.${nodeId}.lines`, 'Node lines must be an array.')
          if (!Array.isArray(node.options)) issue('error', questId, `${label}.${nodeId}.options`, 'Node options must be an array.')
          for (let i = 0; i < (node.options || []).length; i++) {
            const opt = node.options[i]
            const path = `${label}.${nodeId}.options[${i}]`
            if (!opt.label) issue('warning', questId, `${path}.label`, 'Option has no label.')
            if (opt.next && !tree.nodes[opt.next]) issue('error', questId, `${path}.next`, `Next node "${opt.next}" is missing.`)
            if (opt.action) validateAction(opt.action, questId, `${path}.action`)
            for (let j = 0; j < (opt.actions || []).length; j++) validateAction(opt.actions[j], questId, `${path}.actions[${j}]`)
            if (opt.requires?.questId && !questIds.has(opt.requires.questId)) issue('error', opt.requires.questId, `${path}.requires.questId`, 'Referenced quest ID does not exist.')
            if (opt.condition) validateCondition(opt.condition, questId, `${path}.condition`)
            for (let j = 0; j < (opt.conditions || []).length; j++) validateCondition(opt.conditions[j], questId, `${path}.conditions[${j}]`)
          }
        }
      }

      function validateAction(action, questId, path) {
        if (!action?.type) return issue('error', questId, path, 'Action is missing type.')
        if (action.type === 'setQuestStage') {
          validateQuestRef(action.questId, questId, `${path}.questId`, issue)
          const def = quests.find(q => q.id === action.questId)
          if (def && (!Number.isInteger(action.stage) || action.stage < 0 || action.stage >= (def.stages?.length || 0))) issue('error', questId, `${path}.stage`, 'Stage is outside the target quest stage range.')
        } else if (action.type === 'completeQuest') validateQuestRef(action.questId, questId, `${path}.questId`, issue)
        else if (action.type === 'giveItem' || action.type === 'takeItem') validateItemRef(action.itemId, questId, `${path}.itemId`, issue)
        else if (action.type === 'bankInventoryItemsForCoins') {
          if (!Array.isArray(action.itemIds) || action.itemIds.length === 0) issue('error', questId, `${path}.itemIds`, 'Action needs at least one item ID.')
          else action.itemIds.forEach((itemId, idx) => validateItemRef(itemId, questId, `${path}.itemIds[${idx}]`, issue))
          if (!Number.isInteger(action.coinCost) || action.coinCost < 0) issue('error', questId, `${path}.coinCost`, 'Coin cost must be a non-negative whole number.')
          if (action.coinCostByItemId !== undefined) {
            if (!action.coinCostByItemId || typeof action.coinCostByItemId !== 'object' || Array.isArray(action.coinCostByItemId)) {
              issue('error', questId, `${path}.coinCostByItemId`, 'Per-item coin costs must be an object keyed by item ID.')
            } else {
              Object.entries(action.coinCostByItemId).forEach(([rawItemId, cost]) => {
                const itemId = Number(rawItemId)
                if (!Number.isInteger(itemId) || itemId <= 0) issue('error', questId, `${path}.coinCostByItemId.${rawItemId}`, 'Per-item coin cost key must be a valid item ID.')
                else validateItemRef(itemId, questId, `${path}.coinCostByItemId.${rawItemId}`, issue)
                if (!Number.isInteger(cost) || cost < 0) issue('error', questId, `${path}.coinCostByItemId.${rawItemId}`, 'Per-item coin cost must be a non-negative whole number.')
              })
            }
          }
        } else if (!['openShop', 'openBank', 'openAppearance', 'closeDialogue'].includes(action.type)) issue('error', questId, path, `Unknown action type "${action.type}".`)
      }

      function questHasCompletionAction(questId) {
        for (const def of npcDefs) {
          if (dialogueTreeCompletesQuest(def.dialogue, questId)) return true
        }
        for (const spawn of npcSpawns) {
          if (dialogueTreeCompletesQuest(spawn.dialogue, questId)) return true
        }
        if (placedGroup) {
          for (const obj of placedGroup.getChildren()) {
            for (const interaction of obj.userData?.interactions || []) {
              if (actionsCompleteQuest(interaction.effects, questId)) return true
            }
          }
        }
        return false
      }

      function dialogueTreeCompletesQuest(tree, questId) {
        if (!tree?.nodes) return false
        for (const node of Object.values(tree.nodes)) {
          for (const opt of node.options || []) {
            if (actionCompletesQuest(opt.action, questId)) return true
            if (actionsCompleteQuest(opt.actions, questId)) return true
          }
        }
        return false
      }

      function actionsCompleteQuest(actions, questId) {
        return Array.isArray(actions) && actions.some(action => actionCompletesQuest(action, questId))
      }

      function actionCompletesQuest(action, questId) {
        return action?.type === 'completeQuest' && action.questId === questId
      }

      function validateCondition(condition, questId, path) {
        if (!condition?.type) return issue('error', questId, path, 'Condition is missing type.')
        if (condition.type === 'all' || condition.type === 'any') {
          if (!Array.isArray(condition.conditions)) issue('error', questId, `${path}.conditions`, 'Composite condition needs a conditions array.')
          else condition.conditions.forEach((c, i) => validateCondition(c, questId, `${path}.conditions[${i}]`))
        } else if (condition.type === 'not') {
          if (!condition.condition) issue('error', questId, `${path}.condition`, 'not condition needs a child condition.')
          else validateCondition(condition.condition, questId, `${path}.condition`)
        } else if (['questStage', 'questStarted', 'questNotStarted', 'questCompleted'].includes(condition.type)) validateQuestRef(condition.questId, questId, `${path}.questId`, issue)
        else if (condition.type === 'hasItem' || condition.type === 'hasEquippedItem') validateItemRef(condition.itemId, questId, `${path}.itemId`, issue)
        else if (condition.type === 'skillLevel') {
          if (!ALL_QUEST_SKILLS.includes(condition.skill)) issue('error', questId, `${path}.skill`, 'Unknown skill.')
        } else if (condition.type !== 'combatLevel') issue('error', questId, path, `Unknown condition type "${condition.type}".`)
      }
    }

    function validateQuestRef(id, questId, path, issue) {
      if (!id || !quests.some(q => q.id === id)) issue('error', questId, path, 'Quest ID does not exist.')
    }

    function validateNpcRef(id, questId, path, issue) {
      if (!Number.isInteger(id) || !npcDefs.some(d => d.id === id)) issue('error', questId, path, 'NPC ID does not exist.')
    }

    function validateItemRef(id, questId, path, issue) {
      if (!Number.isInteger(id) || !itemDefs.some(d => d.id === id)) issue('error', questId, path, 'Item ID does not exist.')
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
    function questSelect(value, onChange) {
      const sel = document.createElement('select')
      sel.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      for (const q of [...quests].sort((a, b) => (a.name || '').localeCompare(b.name || ''))) {
        const o = document.createElement('option'); o.value = q.id; o.textContent = `${q.name || q.id} (${q.id})`; sel.appendChild(o)
      }
      sel.value = value
      sel.addEventListener('change', () => onChange(sel.value))
      return sel
    }
    function skillSelect(value, onChange) {
      const sel = document.createElement('select')
      sel.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      for (const skill of ALL_QUEST_SKILLS) {
        const o = document.createElement('option'); o.value = skill; o.textContent = skill; sel.appendChild(o)
      }
      sel.value = value
      sel.addEventListener('change', () => onChange(sel.value))
      return sel
    }
    function dialogueNpcSelect(trigger, onChange) {
      const input = document.createElement('input')
      input.type = 'text'
      input.setAttribute('list', 'questNpcDatalist')
      input.placeholder = 'Search NPC name, spawn name, or ID'
      input.value = formatQuestNpcDisplay(trigger)
      input.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'

      const sync = () => {
        const picked = parseQuestNpcDisplay(input.value)
        if (!picked) {
          delete trigger.npcDefId
          delete trigger.npcName
        } else if (picked.kind === 'spawn') {
          trigger.npcDefId = picked.npcDefId
          trigger.npcName = picked.name
        } else {
          trigger.npcDefId = picked.npcDefId
          delete trigger.npcName
        }
        input.value = formatQuestNpcDisplay(trigger)
        onChange()
      }
      input.addEventListener('change', sync)
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') {
          event.preventDefault()
          sync()
        }
      })
      ensureQuestNpcDatalist()
      return input
    }
    function ensureQuestNpcDatalist() {
      let dl = document.getElementById('questNpcDatalist')
      if (!dl) {
        dl = document.createElement('datalist')
        dl.id = 'questNpcDatalist'
        document.body.appendChild(dl)
      }
      dl.innerHTML = ''
      const empty = document.createElement('option')
      empty.value = ''
      empty.label = 'Any NPC'
      dl.appendChild(empty)
      for (const choice of questNpcChoices()) {
        const o = document.createElement('option')
        o.value = choice.display
        o.label = choice.search
        dl.appendChild(o)
      }
    }
    function questNpcChoices() {
      const choices = []
      const seenSpawns = new Set()
      for (const spawn of allQuestNpcSpawns()) {
        if (!spawn.name || !npcDefs.some(def => def.id === spawn.npcId)) continue
        const key = `${spawn.npcId}:${spawn.name}`
        if (seenSpawns.has(key)) continue
        seenSpawns.add(key)
        const def = npcDefs.find(d => d.id === spawn.npcId)
        const where = spawn.mapId ? `, ${spawn.mapId}` : ', current map'
        choices.push({
          kind: 'spawn',
          npcDefId: spawn.npcId,
          name: spawn.name,
          display: `${spawn.name} - ${def?.name || 'NPC'} (${spawn.npcId}${where})`,
          search: `${spawn.name} ${def?.name || ''} ${spawn.npcId} ${spawn.mapId || ''}`,
        })
      }
      for (const def of npcDefs) {
        choices.push({
          kind: 'def',
          npcDefId: def.id,
          display: `${def.name} (${def.id})`,
          search: `${def.name} ${def.id}`,
        })
      }
      return choices.sort((a, b) => a.display.localeCompare(b.display))
    }
    function parseQuestNpcDisplay(value) {
      const text = String(value || '').trim()
      if (!text) return null
      const exact = questNpcChoices().find(choice => choice.display === text)
      if (exact) return exact
      const idMatch = text.match(/\((\d+)(?:,|\))/)
      if (idMatch) {
        const id = parseInt(idMatch[1])
        const spawnName = text.split(' - ')[0]?.trim()
        const spawn = questNpcChoices().find(choice => choice.kind === 'spawn' && choice.npcDefId === id && choice.name === spawnName)
        if (spawn) return spawn
        if (npcDefs.some(def => def.id === id)) return { kind: 'def', npcDefId: id }
      }
      const lower = text.toLowerCase()
      const fuzzy = questNpcChoices().find(choice => choice.display.toLowerCase().includes(lower) || choice.search.toLowerCase().includes(lower))
      return fuzzy || null
    }
    function formatQuestNpcDisplay(trigger) {
      if (trigger.npcName) {
        const found = questNpcChoices().find(choice => choice.kind === 'spawn' && choice.npcDefId === trigger.npcDefId && choice.name === trigger.npcName)
        if (found) return found.display
        const def = npcDefs.find(d => d.id === trigger.npcDefId)
        return `${trigger.npcName} - ${def?.name || 'NPC'} (${trigger.npcDefId || '?'})`
      }
      if (trigger.npcDefId) {
        const found = questNpcChoices().find(choice => choice.kind === 'def' && choice.npcDefId === trigger.npcDefId)
        if (found) return found.display
        return `NPC ${trigger.npcDefId}`
      }
      return ''
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
    function objectTriggerSelect(trigger, onChange) {
      const sel = document.createElement('select')
      sel.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      const empty = document.createElement('option'); empty.value = ''; empty.textContent = '(any object)'; sel.appendChild(empty)

      for (const placed of namedPlacedObjects()) {
        const def = objectDefs.find(d => d.id === placed.objectDefId)
        const o = document.createElement('option')
        o.value = `placed:${placed.objectDefId}:${placed.name}`
        o.textContent = `${placed.name} (${def?.name || 'Object'} ID ${placed.objectDefId})`
        sel.appendChild(o)
      }

      for (const def of [...objectDefs].sort((a, b) => a.name.localeCompare(b.name))) {
        const o = document.createElement('option'); o.value = `def:${def.id}`; o.textContent = `${def.name} (${def.id})`; sel.appendChild(o)
      }

      sel.value = trigger.objectName
        ? `placed:${trigger.objectDefId ?? 0}:${trigger.objectName}`
        : (trigger.objectDefId ? `def:${trigger.objectDefId}` : '')
      sel.addEventListener('change', () => {
        if (!sel.value) {
          delete trigger.objectDefId
          delete trigger.objectName
        } else if (sel.value.startsWith('placed:')) {
          const [, rawId, ...nameParts] = sel.value.split(':')
          trigger.objectDefId = parseInt(rawId)
          trigger.objectName = nameParts.join(':')
        } else {
          trigger.objectDefId = parseInt(sel.value.slice('def:'.length))
          delete trigger.objectName
        }
        onChange()
      })
      return sel
    }
    function namedPlacedObjects() {
      const byKey = new Map()
      for (const obj of placedGroup.getChildren()) {
        const name = obj.userData?.name
        const objectDefId = ASSET_TO_OBJECT_DEF[obj.userData?.assetId]
        if (!name || objectDefId == null) continue
        byKey.set(`${objectDefId}:${name}`, { objectDefId, name })
      }
      return [...byKey.values()].sort((a, b) => a.name.localeCompare(b.name))
    }
    function itemPicker(value, onChange) {
      ensureShopItemDatalist()
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
    function sourceSelect(value, onChange) {
      const sel = document.createElement('select')
      sel.style.cssText = 'flex:1;width:100%;background:#0d0d0d;color:#fff;border:1px solid #444;border-radius:3px;padding:5px 6px;font-size:12px;box-sizing:border-box;'
      for (const opt of [
        ['any', 'Any item grant'],
        ['ground', 'Ground pickup only'],
        ['object', 'Object interaction only'],
        ['dialogue', 'Dialogue reward only'],
        ['harvest', 'Harvest only'],
        ['chest', 'Chest loot only'],
      ]) {
        const o = document.createElement('option'); o.value = opt[0]; o.textContent = opt[1]; sel.appendChild(o)
      }
      sel.value = value
      sel.addEventListener('change', () => onChange(sel.value))
      return sel
    }
    function questTriggerOptions() {
      return [
        ['dialogue', 'Player talks to an NPC'],
        ['npcKill', 'Player kills an NPC'],
        ['itemPickup', 'Player gets an item'],
        ['chestOpen', 'Player opens a chest'],
        ['objectInteract', 'Player uses an object'],
      ]
    }
    function makeBlankTrigger(type) {
      if (type === 'dialogue') return { type }
      if (type === 'npcKill') return { type, npcDefId: 0 }
      if (type === 'itemPickup') return { type, itemId: 0 }
      if (type === 'chestOpen') return { type }
      if (type === 'objectInteract') return { type }
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
        editorServerMaps = data.maps
        syncTeleportMapDatalist()
        // Sort: kcmap first, then other surface maps, then dungeons/legacy maps last
        const primary = data.maps.filter(m => m.id === 'kcmap')
        const dungeon = data.maps.filter(m => m.id !== 'kcmap' && (m.id === 'underground' || m.mapType === 'dungeon'))
        const surface = data.maps.filter(m => m.id !== 'kcmap' && m.id !== 'underground' && m.mapType !== 'dungeon')
        let html = ''
        if (primary.length) {
          html += primary.map(m => `<option value="${m.id}">${m.name || m.id} (${m.width}x${m.height})</option>`).join('')
        }
        if (surface.length) {
          html += `<optgroup label="── Other Maps ──">`
          html += surface.map(m => `<option value="${m.id}">${m.name || m.id} (${m.width}x${m.height})</option>`).join('')
          html += `</optgroup>`
        }
        if (dungeon.length) {
          html += `<optgroup label="── Dungeons ──">`
          html += dungeon.map(m => `<option value="${m.id}">${m.name || m.id} (${m.width}x${m.height})</option>`).join('')
          html += `</optgroup>`
        }
        serverMapSelect.innerHTML = html
        // Restore previous selection or default to kcmap
        if (prev && serverMapSelect.querySelector(`option[value="${prev}"]`)) {
          serverMapSelect.value = prev
        } else {
          serverMapSelect.value = 'kcmap'
        }
        currentServerMapId = serverMapSelect.value || currentServerMapId
        await refreshTeleportEntries()
      }
    } catch {
      editorServerMaps = []
      syncTeleportMapDatalist()
      serverMapSelect.innerHTML = '<option>Server offline</option>'
      editorTeleportEntries = []
      editorDungeonExits = []
      renderTeleportOccupancyPreview()
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
      currentServerMapId = mapId
      statusText.textContent = `Created dungeon "${name}" (${size}x${size})`
    } catch (e) {
      alert('Server error: ' + e.message)
    }
  })

  serverLoadBtn.addEventListener('click', async () => {
    const mapId = serverMapSelect.value
    if (!mapId) return
    currentServerMapId = mapId
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
    if (serverHealthOk === false) {
      showEditorNotice('SERVER IS DOWN - Save Server is blocked. Use Save Backup first.', 'error', 600000)
      return
    }

    // If the inspector has unsaved NPC-def edits (stats / shared shop /
    // shared dialogue), flush them first. The map save endpoint only writes
    // spawns.json + map data; without this, a single "Save Server" click
    // silently loses every def-level edit since the last explicit "Save NPC
    // defs". Per-spawn overrides go through with the map save below.
    if (npcDefsDirty) {
      showEditorNotice('Saving NPC defs…', 'info', 120000)
      try {
        await saveNpcDefsToServer()
      } catch (err) {
        if (err?.cancelled) {
          showEditorNotice('Save Server cancelled before NPC defs were written.', 'info', 6000)
        } else {
          showEditorNotice(`NPC defs save failed:\n${err.message}`, 'error', 12000)
        }
        return
      }
    }

    serverSaveInProgress = true
    serverSaveBtn.disabled = true
    try {
      const result = await saveCurrentMapToServer(mapId)
      const mb = result.bytes / 1024 / 1024
      showEditorNotice(`Saved "${mapId}" to server (${mb.toFixed(1)} MB)`, 'success', 8000)
    } catch (e) {
      showEditorNotice(`Save Server failed:\n${e.message}`, 'error', 15000)
    } finally {
      serverSaveInProgress = false
      serverSaveBtn.disabled = serverHealthOk === false
    }
  })

  // --- Biome palette UI ---
  const biomeDefListEl = sidebar.querySelector('#biomeDefList')
  const biomeAddBtn = sidebar.querySelector('#biomeAddBtn')
  const biomeEditorEl = sidebar.querySelector('#biomeEditor')
  const biomeEditName = sidebar.querySelector('#biomeEditName')
  const biomeEditColor = sidebar.querySelector('#biomeEditColor')
  const biomeEditSkyColor = sidebar.querySelector('#biomeEditSkyColor')
  const biomeEditShowSun = sidebar.querySelector('#biomeEditShowSun')
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
      sw.title = 'Fog color'
      const skySw = document.createElement('div')
      skySw.style.cssText = `width:16px;height:16px;border-radius:2px;flex-shrink:0;background:${rgb01ToHex(def.skybox?.color ?? DEFAULT_SKYBOX_COLOR)};border:1px solid #222;`
      skySw.title = 'Sky color'
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
      row.appendChild(skySw)
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
    biomeEditSkyColor.value = rgb01ToHex(def.skybox?.color ?? DEFAULT_SKYBOX_COLOR)
    biomeEditShowSun.checked = def.skybox?.showSun !== false
    biomeEditStart.value = String(def.fogStart)
    biomeEditStartVal.textContent = String(def.fogStart)
    biomeEditEnd.value = String(def.fogEnd)
    biomeEditEndVal.textContent = String(def.fogEnd)
    biomeEditorEl.style.display = 'block'
  }

  biomeAddBtn?.addEventListener('click', () => {
    const def = { id: nextBiomeId++, name: `Biome ${biomeData.defs.length + 1}`, fogColor: [0.1, 0.05, 0.15], fogStart: 8, fogEnd: 25, skybox: { color: [...DEFAULT_SKYBOX_COLOR], showSun: true } }
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
    def.skybox = normalizeSkyboxConfig({ color: hexToRgb01(biomeEditSkyColor.value), showSun: biomeEditShowSun.checked }, DEFAULT_SKYBOX_COLOR)
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
    const isDungeon = map.mapType === 'dungeon' || map.defaultGround === 'void' || map.worldOffset.x >= DUNGEON_THRESHOLD
    map.mapType = isDungeon ? 'dungeon' : 'overworld'
    map.defaultGround = isDungeon ? 'void' : (map.defaultGround === 'void' ? 'grass' : map.defaultGround)

    if (isDungeon) {
      scene.clearColor = new Color4(0, 0, 0, 1)
      scene.fogColor = new Color3(0, 0, 0)
      // The editor frames sparse dungeon maps from farther away than gameplay.
      // Tight in-game fog makes large maps like Sultan's Mine render fully black.
      scene.fogStart = 80
      scene.fogEnd = 180
      sun.intensity = 0.25
      sun.diffuse = new Color3(0.42, 0.29, 0.13)
      fill.intensity = 0.12
      fill.diffuse = new Color3(0.29, 0.19, 0.06)
      ambient.diffuse = new Color3(0.48, 0.38, 0.25)
      ambient.intensity = 0.75
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
    if (!GROUND_TYPES.some((gt) => gt.id === state.paintType)) {
      state.paintType = isDungeon ? 'dungeon-floor' : 'grass'
    }
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
  const chunkWaterFlowTitle = topBar.querySelector('#chunkWaterFlowTitle')
  const chunkWaterFlowPreset = topBar.querySelector('#chunkWaterFlowPreset')
  const chunkWaterFlowX = topBar.querySelector('#chunkWaterFlowX')
  const chunkWaterFlowZ = topBar.querySelector('#chunkWaterFlowZ')
  const chunkWaterFlowApply = topBar.querySelector('#chunkWaterFlowApply')
  const chunkWaterFlowClear = topBar.querySelector('#chunkWaterFlowClear')

  const WATER_FLOW_PRESETS = [
    { id: 'n', label: 'North (-Z)', flow: { x: 0, z: -1 } },
    { id: 'ne', label: 'North-East', flow: { x: 1, z: -1 } },
    { id: 'e', label: 'East (+X)', flow: { x: 1, z: 0 } },
    { id: 'se', label: 'South-East', flow: { x: 1, z: 1 } },
    { id: 's', label: 'South (+Z)', flow: { x: 0, z: 1 } },
    { id: 'sw', label: 'South-West', flow: { x: -1, z: 1 } },
    { id: 'w', label: 'West (-X)', flow: { x: -1, z: 0 } },
    { id: 'nw', label: 'North-West', flow: { x: -1, z: -1 } },
  ]

  function flowAlmostEqual(a, b) {
    const af = normalizeWaterFlow(a)
    const bf = normalizeWaterFlow(b)
    return Math.abs(af.x - bf.x) < 0.01 && Math.abs(af.z - bf.z) < 0.01
  }

  function waterFlowLabel(flow) {
    const normalized = normalizeWaterFlow(flow)
    if (flowAlmostEqual(normalized, DEFAULT_WATER_FLOW)) return 'Default'
    const preset = WATER_FLOW_PRESETS.find((p) => flowAlmostEqual(normalized, p.flow))
    return preset ? preset.label : `${normalized.x.toFixed(2)}, ${normalized.z.toFixed(2)}`
  }

  function selectedFlowChunkKey() {
    return selectedWaterFlowChunk ? `${selectedWaterFlowChunk.cx},${selectedWaterFlowChunk.cz}` : null
  }

  function syncChunkWaterFlowControls() {
    const key = selectedFlowChunkKey()
    const hasSelection = !!key && map.activeChunks.has(key)
    const controls = [chunkWaterFlowPreset, chunkWaterFlowX, chunkWaterFlowZ, chunkWaterFlowApply, chunkWaterFlowClear]
    for (const el of controls) if (el) el.disabled = !hasSelection
    if (!hasSelection) {
      if (chunkWaterFlowTitle) chunkWaterFlowTitle.textContent = 'Water flow: select a chunk'
      return
    }

    const { cx, cz } = selectedWaterFlowChunk
    const flow = map.getChunkWaterFlow(cx, cz)
    const hasOverride = Object.prototype.hasOwnProperty.call(map.chunkWaterFlows, key)
    const preset = hasOverride
      ? WATER_FLOW_PRESETS.find((p) => flowAlmostEqual(flow, p.flow))
      : null

    if (chunkWaterFlowTitle) {
      chunkWaterFlowTitle.textContent = `Water flow (${cx},${cz}): ${hasOverride ? waterFlowLabel(flow) : 'Default'}`
    }
    if (chunkWaterFlowPreset) {
      chunkWaterFlowPreset.value = hasOverride ? (preset?.id || 'custom') : 'default'
    }
    if (chunkWaterFlowX) chunkWaterFlowX.value = flow.x.toFixed(2)
    if (chunkWaterFlowZ) chunkWaterFlowZ.value = flow.z.toFixed(2)
  }

  function setSelectedChunkWaterFlow(flow, label) {
    const key = selectedFlowChunkKey()
    if (!key || !map.activeChunks.has(key)) return
    pushUndoState('terrain')
    const { cx, cz } = selectedWaterFlowChunk
    if (flow) map.setChunkWaterFlow(cx, cz, flow)
    else map.clearChunkWaterFlow(cx, cz)
    replaceTerrainWaterMeshes()
    rebuildChunkGrid()
    syncChunkWaterFlowControls()
    statusText.textContent = `Water flow ${label || waterFlowLabel(map.getChunkWaterFlow(cx, cz))} set for chunk (${cx},${cz})`
  }

  chunkGridBtn.addEventListener('click', () => {
    chunkGridPopup.style.display = chunkGridPopup.style.display === 'none' ? 'block' : 'none'
    if (chunkGridPopup.style.display === 'block') {
      rebuildChunkGrid()
      syncChunkWaterFlowControls()
    }
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
        const selected = selectedFlowChunkKey() === `${gx},${gz}`
        // Only show inactive cells if they're adjacent to an active chunk
        const adjacent = !active && (
          map.activeChunks.has(`${gx-1},${gz}`) || map.activeChunks.has(`${gx+1},${gz}`) ||
          map.activeChunks.has(`${gx},${gz-1}`) || map.activeChunks.has(`${gx},${gz+1}`)
        )
        const cell = document.createElement('div')
        cell.style.cssText = `width:28px;height:28px;border-radius:3px;cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:9px;color:#fff;`
        if (active) {
          cell.style.background = '#2d6cdf'
          if (selected) cell.style.outline = '2px solid #8fd1ff'
          cell.textContent = `${gx},${gz}`
          cell.title = `Chunk (${gx},${gz}) - water flow: ${waterFlowLabel(map.getChunkWaterFlow(gx, gz))} - Shift+click to remove`
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
            } else if (active) {
              selectedWaterFlowChunk = { cx, cz }
              syncChunkWaterFlowControls()
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
    selectedWaterFlowChunk = { cx: finalCx, cz: finalCz }
    afterChunkChange()
  }

  function removeChunk(cx, cz) {
    if (map.activeChunks.size <= 1) return // keep at least one chunk
    pushUndoState('terrain')
    map.activeChunks.delete(`${cx},${cz}`)
    map.clearChunkWaterFlow(cx, cz)
    if (selectedFlowChunkKey() === `${cx},${cz}`) selectedWaterFlowChunk = null
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
    syncChunkWaterFlowControls()
    markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
  }

  chunkWaterFlowPreset?.addEventListener('change', () => {
    const id = chunkWaterFlowPreset.value
    if (id === 'default') return setSelectedChunkWaterFlow(null, 'default')
    if (id === 'custom') return
    const preset = WATER_FLOW_PRESETS.find((p) => p.id === id)
    if (preset) setSelectedChunkWaterFlow(preset.flow, preset.label)
  })

  chunkWaterFlowApply?.addEventListener('click', () => {
    const x = Number(chunkWaterFlowX?.value)
    const z = Number(chunkWaterFlowZ?.value)
    if (!Number.isFinite(x) || !Number.isFinite(z) || Math.hypot(x, z) < 0.0001) {
      statusText.textContent = 'Water flow needs a non-zero X/Z direction'
      syncChunkWaterFlowControls()
      return
    }
    setSelectedChunkWaterFlow({ x, z }, 'custom')
  })

  chunkWaterFlowClear?.addEventListener('click', () => {
    setSelectedChunkWaterFlow(null, 'default')
  })

  sidebar.querySelector('#toggleSplitLines').addEventListener('change', (e) => {
    state.showSplitLines = e.target.checked
    if (state.showSplitLines && !splitLines) splitLines = buildSplitLines()
    if (splitLines) splitLines.isVisible = state.showSplitLines
  })

  sidebar.querySelector('#toggleTileGrid').addEventListener('change', (e) => {
    state.showTileGrid = e.target.checked
    if (state.showTileGrid && !tileGrid) tileGrid = buildTileGrid()
    if (tileGrid) tileGrid.isVisible = state.showTileGrid
  })

  function refreshHalfPaintOptionsUI() {
    const panel = sidebar.querySelector('#halfPaintOptions')
    const mode = sidebar.querySelector('#halfPaintCutMode')
    const angleRow = sidebar.querySelector('#halfPaintAngleRow')
    const angle = sidebar.querySelector('#halfPaintAngle')
    const angleVal = sidebar.querySelector('#halfPaintAngleVal')
    const offset = sidebar.querySelector('#halfPaintOffset')
    const offsetVal = sidebar.querySelector('#halfPaintOffsetVal')
    if (panel) panel.style.display = state.halfPaint ? 'block' : 'none'
    if (mode && mode.value !== state.halfPaintCutMode) mode.value = state.halfPaintCutMode
    if (angleRow) angleRow.style.display = state.halfPaintCutMode === 'custom' ? 'block' : 'none'
    const deg = Math.round(normalizeCutAngle(state.halfPaintCutAngle) * 180 / Math.PI)
    if (angle && Number(angle.value) !== deg) angle.value = String(deg)
    if (angleVal) angleVal.textContent = String(deg)
    if (offset && Number(offset.value) !== state.halfPaintCutOffset) offset.value = String(state.halfPaintCutOffset)
    if (offsetVal) offsetVal.textContent = `${Math.round((0.5 + state.halfPaintCutOffset) * 100)}%`
  }

  function refreshHalfPaintPreviewForHovered() {
    if (state.tool !== ToolMode.PAINT || !state.halfPaint) return
    if (!Number.isFinite(state.hovered?.x) || !Number.isFinite(state.hovered?.z)) return
    updateHalfPaintPreview(state.hovered, null)
  }

  sidebar.querySelector('#toggleHalfPaint').addEventListener('change', (e) => {
    state.halfPaint = e.target.checked
    if (!state.halfPaint) clearHalfPaintPreview()
    refreshHalfPaintOptionsUI()
    refreshHalfPaintPreviewForHovered()
  })

  sidebar.querySelector('#halfPaintCutMode')?.addEventListener('change', (e) => {
    state.halfPaintCutMode = e.target.value
    const preset = halfPaintPresetAngle(state.halfPaintCutMode)
    if (state.halfPaintCutMode !== 'cursor' && state.halfPaintCutMode !== 'custom') {
      state.halfPaintCutAngle = preset
    }
    halfPaintPreviewKey = null
    refreshHalfPaintOptionsUI()
    refreshHalfPaintPreviewForHovered()
  })

  sidebar.querySelector('#halfPaintAngle')?.addEventListener('input', (e) => {
    state.halfPaintCutMode = 'custom'
    state.halfPaintCutAngle = normalizeCutAngle(Number(e.target.value) * Math.PI / 180)
    halfPaintPreviewKey = null
    refreshHalfPaintOptionsUI()
    refreshHalfPaintPreviewForHovered()
  })

  sidebar.querySelector('#halfPaintOffset')?.addEventListener('input', (e) => {
    const value = Number(e.target.value)
    state.halfPaintCutOffset = Math.max(-0.45, Math.min(0.45, Number.isFinite(value) ? value : 0))
    halfPaintPreviewKey = null
    refreshHalfPaintOptionsUI()
    refreshHalfPaintPreviewForHovered()
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

  sidebar.querySelector('#toggleTexturePlaneBridge').addEventListener('change', (e) => {
    texturePlaneBridge = e.target.checked
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
    if (selectedTexturePlane) {
      for (const plane of selectedTexturePlanes) {
        if (texNoRoofCheckbox.checked) {
          plane.noRoof = true
        } else {
          delete plane.noRoof
          delete plane.bridge
        }
      }
      texBridgeCheckbox.checked = !!selectedTexturePlane.bridge
      return
    }

    const roofObjects = selectedRoofLikePlacedObjects()
    if (!roofObjects.length) return
    for (const obj of roofObjects) {
      if (texNoRoofCheckbox.checked) {
        obj.userData.noRoof = true
      } else {
        delete obj.userData.noRoof
      }
    }
    texNoRoofCheckbox.indeterminate = false
    updateToolUI()
  })

  const texBridgeCheckbox = sidebar.querySelector('#texBridge')
  const texBridgeRow = sidebar.querySelector('#texBridgeRow')
  texBridgeCheckbox.addEventListener('change', () => {
    if (!selectedTexturePlane) return
    for (const plane of selectedTexturePlanes) {
      if (texBridgeCheckbox.checked) {
        plane.bridge = true
        plane.noRoof = true
      } else {
        delete plane.bridge
      }
    }
    texNoRoofCheckbox.checked = !!selectedTexturePlane.noRoof
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

  function handleMoveTransform(event) {
    if (transformMode !== 'move') return false

    if (selectedTexturePlane && transformStart?.primaryType === 'plane') {
      const needsTerrainPick = transformAxis !== 'height'
      const terrainPoint = needsTerrainPick ? pickTerrainPoint(event) : null
      // For vertical planes, fall back to a virtual horizontal plane at the plane's current Y
      // so movement isn't blocked when the cursor passes over a wall model.
      const cursorPoint = terrainPoint
        ?? (selectedTexturePlane.vertical ? pickHorizontalPlane(event, selectedTexturePlane.position.y) : null)
      if (!cursorPoint && transformAxis !== 'height') {
        updateTexturePlaneMeshTransform(selectedTexturePlane)
        updateSelectionHelper()
        return true
      }

      const snappedX = cursorPoint ? (event.shiftKey ? snapValue(cursorPoint.x, 0.5) : cursorPoint.x) : selectedTexturePlane.position.x
      const snappedZ = cursorPoint ? (event.shiftKey ? snapValue(cursorPoint.z, 0.5) : cursorPoint.z) : selectedTexturePlane.position.z

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
          _spatialRefresh(obj)
        }
      }

      updateSelectionHelper()
      return true
    }

    if (selectedPlacedObject && transformStart?.primaryType !== 'plane') {
      if (transformAxis === 'height') {
        // Vertical: mouse Y delta
        if (!movePlaneStart) {
          movePlaneStart = { mouseY: event.clientY, value: selectedPlacedObject.position.y }
        }
        const deltaY = (movePlaneStart.mouseY - event.clientY) * 0.02
        selectedPlacedObject.position.y = movePlaneStart.value + deltaY
      } else if (transformAxis === 'x' || transformAxis === 'ground-z') {
        // Single axis: delta-based so movement is predictable.
        if (!movePlaneStart) {
          const initPick = pickHorizontalPlane(event, selectedPlacedObject.position.y)
          movePlaneStart = {
            pickX: initPick?.x ?? selectedPlacedObject.position.x,
            pickZ: initPick?.z ?? selectedPlacedObject.position.z
          }
        }
        const movePoint = pickHorizontalPlane(event, selectedPlacedObject.position.y)
        if (!movePoint) return true
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
        updateMouse(event)
        const ray = scene.createPickingRay(scene.pointerX, scene.pointerY, Matrix.Identity(), camera)
        const placementPoint = pickPlacementPointFromRay(ray, selectedPlacedObjects, event)
        const movePoint = placementPoint ?? pickHorizontalPlaneFromRay(ray, selectedPlacedObject.position.y)
        if (!movePoint) return true

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
        } else {
          targetY = placementPoint?.y ?? selectedPlacedObject.position.y
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
          _spatialRefresh(obj)
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
      _spatialRefresh(selectedPlacedObject)

      return true
    }

    return false
  }

  canvas.addEventListener('mousemove', (event) => {
    if (handleMoveTransform(event)) return

    const tile = pickTile(event)
    if (!tile) return

    state.hovered = tile

    const y = map.getAverageTileHeight(tile.x, tile.z) + 0.04
    highlight.position.set(tile.x + 0.5, y, tile.z + 0.5)
    hoverText.textContent = `tile (${tile.x}, ${tile.z})  elev ${y.toFixed(2)}`

    if (previewObject) {
      const sp = pickPlacementPoint(event)
      const placementTile = tileFromWorldPoint(sp) || tile
      if (sp && state.tool === ToolMode.PLACE) {
        state.hovered = placementTile
        highlight.position.set(placementTile.x + 0.5, sp.y + 0.04, placementTile.z + 0.5)
        hoverText.textContent = `tile (${placementTile.x}, ${placementTile.z})  elev ${sp.y.toFixed(2)}`
      }
      const pos = tileWorldPosition(placementTile.x, placementTile.z)
      if (sp) pos.y = sp.y
      const _prevAsset = assetRegistry.find((a) => a.id === previewObject.userData.assetId)
      wallPlacementTargetActive = false
      applyWallPlacementSnap(previewObject, pos, _prevAsset, placementTile, event, sp)
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

        const nextPreviewKey = `${midX.toFixed(3)},${midY.toFixed(3)},${midZ.toFixed(3)},${length.toFixed(3)},${angle.toFixed(4)},${diagFloorWidth}`
        if (nextPreviewKey !== diagFloorPreviewKey || !diagFloorPreview) {
          disposeDiagFloorPreview()
          diagFloorPreviewKey = nextPreviewKey
          diagFloorPreview = MeshBuilder.CreatePlane('diagFloorPreview', {
            width: length,
            height: diagFloorWidth,
            sideOrientation: Mesh.DOUBLESIDE
          }, scene)
          diagFloorPreview.position.set(midX, midY, midZ)
          diagFloorPreview.rotation.set(-Math.PI / 2, angle, 0)
          diagFloorPreview.isPickable = false
          diagFloorPreview.material = getDiagFloorPreviewMaterial()
          diagFloorPreview.isPickable = false
        }
      }
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

      if (state.tool === ToolMode.COLLISION) {
        if (collisionMode === 'wall') {
          const erasing = wallEraseMode || event.shiftKey
          if (erasing) {
            // Erase mode: clear all edges per tile, track by tile.
            const tileKey = `${tile.x},${tile.z}`
            if (!state.draggedTiles.has(tileKey)) {
              state.draggedTiles.add(tileKey)
              setWallAt(tile.x, tile.z, 0)
              delete getCollisionLayer().wallHeights[`${tile.x},${tile.z}`]
              markCollisionDirty()
            }
          } else {
            // Draw mode: use the locked edge from mousedown so dragging extends the same edge.
            const edge = lockedWallEdge || getNearestEdge(tile.x, tile.z, tile.u, tile.v).edge
            const edgeKey = `${tile.x},${tile.z},${edge}`
            if (!state.draggedTiles.has(edgeKey)) {
              state.draggedTiles.add(edgeKey)
              const current = getWallAt(tile.x, tile.z)
              setWallAt(tile.x, tile.z, current | edge)
              markCollisionDirty()
            }
          }
        } else if (collisionMode === 'block') {
          if (!state.draggedTiles.has(key)) {
            state.draggedTiles.add(key)
            setBlockedTile(tile.x, tile.z, !event.shiftKey)
            markCollisionDirty()
          }
        } else if (collisionMode === 'hole') {
          if (!state.draggedTiles.has(key)) {
            state.draggedTiles.add(key)
            setHoleAt(tile.x, tile.z, !event.shiftKey)
            markCollisionDirty()
          }
        }
        return
      }

      if (state.tool === ToolMode.TERRAIN) {
        const now = performance.now()
        if (!state.draggedTiles.has(key) && now - state.lastTerrainEditTime >= state.terrainEditInterval) {
          state.draggedTiles.add(key)
          state.lastTerrainEditTime = now
          applyToolAtTile(tile, event)
        }
      } else if (state.tool === ToolMode.PAINT) {
        if (!state.draggedTiles.has(key)) {
          state.draggedTiles.add(key)
          applyToolAtTile(tile, event)
        }
      }
    }
  })

  dragSelectBox = document.createElement('div')
  dragSelectBox.style.cssText = 'position:fixed;border:1px solid rgba(102,204,255,0.9);background:rgba(102,204,255,0.07);pointer-events:none;display:none;z-index:9999;'
  document.body.appendChild(dragSelectBox)

  function updateDragSelectBox(x1, y1, x2, y2) {
    dragSelectBox.style.left = Math.min(x1, x2) + 'px'
    dragSelectBox.style.top = Math.min(y1, y2) + 'px'
    dragSelectBox.style.width = Math.abs(x2 - x1) + 'px'
    dragSelectBox.style.height = Math.abs(y2 - y1) + 'px'
  }

  function beginDragSelect(event) {
    isDragSelecting = true
    dragSelectStart = { x: event.clientX, y: event.clientY }
    if (dragSelectBox) {
      dragSelectBox.style.display = 'none'
      updateDragSelectBox(event.clientX, event.clientY, event.clientX, event.clientY)
    }
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
          if (!event.shiftKey && (selectedPlacedObjects.length > 0 || selectedTexturePlanes.includes(plane))) {
            clearSelection()
            beginDragSelect(event)
            return
          }
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
        // If we're in ladder-wiring mode, finish the pairing rather than selecting.
        if (pendingLadderWireSource && isLadderPlacedObject(pickedObject) && pickedObject !== pendingLadderWireSource) {
          const fromSel = sidebar.querySelector('#ladderFloorSelect')
          const toSel = sidebar.querySelector('#ladderTargetFloorSelect')
          const fromFloor = parseInt(fromSel?.value || '0', 10) | 0
          const toFloor = parseInt(toSel?.value || '1', 10) | 0
          if (fromFloor === toFloor) {
            window.alert('Source and target floor must differ. Adjust the dropdowns first.')
          } else {
            wireLadderPair(pendingLadderWireSource, pickedObject, fromFloor, toFloor)
            pendingLadderWireSource = null
            refreshBrokenLadderIndicators()
            selectedPlacedObjects = [pickedObject]
            selectedPlacedObject = pickedObject
            selectedTexturePlane = null
            selectedTexturePlanes = []
            updateSelectionHelper()
            updateToolUI()
          }
          return
        }
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

      // No object hit: deselect immediately. A rectangle appears only if the
      // mouse moves past the drag threshold before mouseup.
      if (!event.shiftKey) clearSelection()
      beginDragSelect(event)
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
        applyTexturePlaneCreationFlags(plane)
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
      applyTexturePlaneCreationFlags(plane)

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
          selectNpcSpawn(picked, false)
          deleteSelectedNpcSpawn()
        }
        return
      }
      // Ctrl+click an empty tile = move the currently selected spawn here.
      // We dispose+re-create the 3D character preview at the new tile so the
      // GLB doesn't have to be reloaded from disk.
      if (event.ctrlKey && selectedNpcSpawn) {
        const picked = pickNpcSpawn(event)
        // If Ctrl+click lands ON a spawn, treat it as a normal select instead
        // of moving onto the clicked one.
        if (!picked) {
          moveSelectedNpcSpawnToTile(tile)
          return
        }
      }
      // Normal click: check if clicking existing spawn first
      const picked = pickNpcSpawn(event)
      if (picked) {
        selectNpcSpawn(picked, false)
        return
      }
      if (npcPlacementMode === 'move') {
        if (moveSelectedNpcSpawnToTile(tile)) setNpcPlacementMode('select')
        return
      }
      if (npcPlacementMode === 'place') {
        createNpcSpawnAtTile(tile)
        return
      }
      selectNpcSpawn(null, false)
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
      markCollisionDirty()
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
      applyTexturePlaneCreationFlags(plane)
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
    if (state.tool === ToolMode.TERRAIN) _terrainStrokeRegion = null



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
        // Finalize water/cliffs and refresh only the texture overlays whose
        // corners may have moved. A full overlay rebuild is visible on kcmap.
        if (state.tool === ToolMode.TERRAIN) {
          const region = _terrainStrokeRegion
          _terrainStrokeRegion = null
          if (region) {
            markTerrainDirty({
              skipTexturePlanes: true,
              skipShadows: true,
              rebuildTextureOverlays: true,
              heightsOnly: true,
              region
            })
          }
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
  const MIN_CAMERA_DISTANCE = 2
  const MAX_CAMERA_DISTANCE = 120
  const WHEEL_PIXELS_PER_ZOOM_STEP = 100
  const CLOSE_ZOOM_FACTOR_PER_STEP = 1.08
  const FAR_ZOOM_FACTOR_PER_STEP = 1.25
  const CLOSE_ZOOM_DISTANCE = 8
  const FAR_ZOOM_DISTANCE = 60
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

  function normalizedWheelPixels(event) {
    if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) return event.deltaY * 40
    if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) return event.deltaY * 800
    return event.deltaY
  }

  function smoothstep(edge0, edge1, value) {
    const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)))
    return t * t * (3 - 2 * t)
  }

  function zoomFactorPerStep() {
    const t = smoothstep(CLOSE_ZOOM_DISTANCE, FAR_ZOOM_DISTANCE, distance)
    return CLOSE_ZOOM_FACTOR_PER_STEP + (FAR_ZOOM_FACTOR_PER_STEP - CLOSE_ZOOM_FACTOR_PER_STEP) * t
  }

  function zoomCameraFromWheel(event) {
    const rawSteps = normalizedWheelPixels(event) / WHEEL_PIXELS_PER_ZOOM_STEP
    const steps = Math.max(-4, Math.min(4, rawSteps))
    const factor = Math.pow(zoomFactorPerStep(), steps)
    distance = Math.max(MIN_CAMERA_DISTANCE, Math.min(MAX_CAMERA_DISTANCE, distance * factor))
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

    e.preventDefault()
    zoomCameraFromWheel(e)
  }, { passive: false })

  window.addEventListener('resize', () => {
    engine.resize()
  })

  window.addEventListener('keydown', async (event) => {
    const key = event.key.toLowerCase()
    if (key === 'escape') {
      event.preventDefault()
      if (pendingLadderWireSource) {
        cancelPendingLadderWire()
      } else if (diagFloorStart) {
        cancelDiagFloor()
        updateToolUI()
      } else if (transformMode) {
        cancelTransform()
      } else {
        document.activeElement?.blur?.()
        clearSelection()
      }
      return
    }

    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return

    const { x, z } = state.hovered

    if (event.ctrlKey && key === 'z' && !event.shiftKey) {
      event.preventDefault()
      if (!event.repeat) await undo()
      return
    }

    if ((event.ctrlKey && key === 'y') || (event.ctrlKey && event.shiftKey && key === 'z')) {
      event.preventDefault()
      if (!event.repeat) await redo()
      return
    }

    // Shift+D on an NPC spawn clones it (mirrors the placed-object duplicate
    // pattern). Object/plane duplication on plain D fires below — we only
    // intercept when the NPC spawn tool is active and a spawn is selected,
    // so the other tools' Shift+D (right-clone for objects) is unaffected.
    if (key === 'd' && event.shiftKey && !event.ctrlKey && !event.altKey
        && state.tool === ToolMode.NPC_SPAWN && selectedNpcSpawn) {
      event.preventDefault()
      duplicateSelectedNpcSpawn()
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
      assetById = new Map(assetRegistry.map((asset) => [asset.id, asset]))

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
          pushUndoStateWithoutAutosave()
          return
        }
      } catch (e) {
        console.warn('Could not load default save:', e)
      }
    }
    // No map loaded — build the default empty terrain
    markTerrainDirty({ rebuildTexturePlanes: true, rebuildTextureOverlays: true })
    pushUndoStateWithoutAutosave()
  }

  Promise.all([initAssets(), initTextures()]).then(() => initDefaultSave())

  engine.runRenderLoop(() => {
    if (_collisionDirty) {
      rebuildCollisionMeshes()
      _collisionDirty = false
    }
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
