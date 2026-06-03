'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import '@babylonjs/loaders/glTF';
import {
  ArcRotateCamera,
  Camera,
  Color3,
  Color4,
  DirectionalLight,
  Engine,
  HemisphericLight,
  Scene,
  Vector3,
  type AbstractMesh,
} from '@babylonjs/core';
import type { ItemDef } from '../../../../shared/types';
import type { PlayerAppearance } from '../../../../shared/appearance';
import { CHARACTER_TARGET_HEIGHT, getCharacterModelPath } from '../../../../shared/character';
import type { GearOverride } from '../../../../client/src/data/EquipmentConfig';
import { CharacterEntity } from '../../../../client/src/rendering/CharacterEntity';
import { buildCharacterGearDef, loadCharacterGearSmart } from '../../../../client/src/rendering/CharacterGearLoader';

const AVATAR_GEAR_SLOTS = ['head', 'body', 'cape'] as const;
type AvatarGearSlot = (typeof AVATAR_GEAR_SLOTS)[number];

type AvatarTarget = {
  accountId: number;
  username: string;
  appearance: PlayerAppearance;
  headItemId: number | null;
  bodyItemId?: number | null;
  capeItemId?: number | null;
  equipment?: Record<AvatarGearSlot, number | null>;
  hash: string;
  url: string;
  baked: boolean;
};

const TOKEN_KEY = 'evilquest_token';
const SETTINGS_KEY = 'evilquest_forum_avatar_render_settings';

type AvatarRenderSettings = {
  yaw: number;
  elevation: number;
  cameraHeight: number;
  rootPitch: number;
  targetDrop: number;
  crop: number;
};

declare global {
  interface Window {
    __forumAvatarBakeDone?: boolean;
    __forumAvatarBakeResult?: { ok: boolean; baked: number; total: number; errors: string[] };
    __forumAvatarBakeSecret?: string;
  }
}

const DEFAULT_RENDER_SETTINGS: AvatarRenderSettings = {
  yaw: -0.31,
  elevation: 1.04,
  cameraHeight: 0.55,
  rootPitch: 0.15,
  targetDrop: 0.92,
  crop: 0.115,
};

function loadSavedRenderSettings(): AvatarRenderSettings {
  if (typeof window === 'undefined') return DEFAULT_RENDER_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_RENDER_SETTINGS;
    return { ...DEFAULT_RENDER_SETTINGS, ...JSON.parse(raw) };
  } catch {
    return DEFAULT_RENDER_SETTINGS;
  }
}

function authHeaders(): Headers {
  const headers = new Headers();
  const token = window.localStorage.getItem(TOKEN_KEY) || '';
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (window.__forumAvatarBakeSecret) headers.set('X-Forum-Avatar-Bake-Secret', window.__forumAvatarBakeSecret);
  return headers;
}

async function loadTargets(): Promise<AvatarTarget[]> {
  const res = await fetch('/api/dev/forum-avatar-targets', { headers: authHeaders(), credentials: 'same-origin', cache: 'no-store' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body.targets ?? [];
}

async function loadItems(): Promise<ItemDef[]> {
  const res = await fetch('/data/items.json', { headers: authHeaders(), credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load items.json (${res.status})`);
  return await res.json();
}

async function loadGearOverrides(): Promise<Record<string, GearOverride>> {
  const res = await fetch('/data/gear-overrides.json', { headers: authHeaders(), credentials: 'same-origin', cache: 'no-store' });
  if (!res.ok) throw new Error(`Failed to load gear-overrides.json (${res.status})`);
  return await res.json();
}

async function postAvatar(target: AvatarTarget, dataUrl: string): Promise<void> {
  const headers = authHeaders();
  headers.set('Content-Type', 'application/json');
  let lastError = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch('/api/dev/forum-avatar', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ accountId: target.accountId, hash: target.hash, dataUrl }),
      });
      const body = await res.json().catch(() => ({}));
      if (res.ok && body.ok) return;
      lastError = body.error || `HTTP ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
  }
  throw new Error(lastError || 'Upload failed');
}

function targetGearItemId(target: AvatarTarget, slot: AvatarGearSlot): number | null {
  if (target.equipment?.[slot]) return target.equipment[slot];
  if (slot === 'head') return target.headItemId ?? null;
  if (slot === 'body') return target.bodyItemId ?? null;
  return target.capeItemId ?? null;
}

async function attachAvatarGearSlot(
  scene: Scene,
  character: CharacterEntity,
  target: AvatarTarget,
  itemDefs: ItemDef[],
  gearOverrides: Record<string, GearOverride>,
  slotName: AvatarGearSlot,
): Promise<void> {
  const itemId = targetGearItemId(target, slotName);
  if (!itemId) return;
  const itemDef = itemDefs.find((item) => item.id === itemId && item.equipSlot === slotName);
  if (!itemDef) return;
  const bodyType = target.appearance.bodyType ?? 0;
  const built = buildCharacterGearDef(itemId, slotName, itemDef, gearOverrides[String(itemId)], bodyType);
  if (!built) return;
  const template = await loadCharacterGearSmart(
    scene,
    character,
    slotName,
    itemId,
    built.def,
    itemDef,
    built.override,
  );
  if (template) {
    character.attachGear(slotName, itemId, template);
    return;
  }
}

async function attachAvatarGear(
  scene: Scene,
  character: CharacterEntity,
  target: AvatarTarget,
  itemDefs: ItemDef[],
  gearOverrides: Record<string, GearOverride>,
): Promise<void> {
  for (const slotName of AVATAR_GEAR_SLOTS) {
    await attachAvatarGearSlot(scene, character, target, itemDefs, gearOverrides, slotName);
  }
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
}

function getRenderableBounds(scene: Scene): { min: Vector3; max: Vector3; count: number } | null {
  let min: Vector3 | null = null;
  let max: Vector3 | null = null;
  let count = 0;

  for (const mesh of scene.meshes) {
    if (!mesh.isEnabled() || !mesh.isVisible || mesh.visibility === 0 || mesh.getTotalVertices() <= 0) continue;
    if (mesh.name.includes('pickProxy')) continue;
    mesh.computeWorldMatrix(true);
    const box = mesh.getBoundingInfo().boundingBox;
    min = min ? Vector3.Minimize(min, box.minimumWorld) : box.minimumWorld.clone();
    max = max ? Vector3.Maximize(max, box.maximumWorld) : box.maximumWorld.clone();
    count++;
  }

  if (!min || !max || count === 0) return null;
  return { min, max, count };
}

async function settleAvatarScene(scene: Scene): Promise<void> {
  await scene.whenReadyAsync();
  for (let i = 0; i < 4; i++) {
    scene.render();
    await nextFrame();
  }
}

function frameAvatarCamera(scene: Scene, camera: ArcRotateCamera, settings: AvatarRenderSettings): void {
  const bounds = getRenderableBounds(scene);
  if (!bounds) throw new Error(`No visible avatar meshes found (${scene.meshes.length} scene meshes).`);

  const height = Math.max(0.01, bounds.max.y - bounds.min.y);
  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const centerZ = (bounds.min.z + bounds.max.z) / 2;
  const halfSize = Math.max(0.11, Math.min(0.26, height * settings.crop));
  const targetY = bounds.max.y - halfSize * settings.targetDrop;

  camera.alpha = 0;
  camera.beta = Math.PI / 2 - settings.elevation;
  camera.radius = 2;
  const target = new Vector3(centerX, targetY, centerZ);
  camera.setTarget(target);
  camera.setPosition(new Vector3(camera.position.x, camera.position.y + settings.cameraHeight, camera.position.z));
  camera.setTarget(target);
  camera.orthoLeft = -halfSize;
  camera.orthoRight = halfSize;
  camera.orthoTop = halfSize;
  camera.orthoBottom = -halfSize;
}

async function renderAvatar(
  target: AvatarTarget,
  itemDefs: ItemDef[],
  gearOverrides: Record<string, GearOverride>,
  settings: AvatarRenderSettings,
): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: false, antialias: true });
  engine.resize(true);
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0, 0, 0, 0);
  new HemisphericLight('forum_avatar_light', new Vector3(0, 1, -0.35), scene).intensity = 1.65;
  new DirectionalLight('forum_avatar_front_light', new Vector3(0.2, -0.5, 1), scene).intensity = 0.55;

  const camera = new ArcRotateCamera('forum_avatar_camera', Math.PI, 1.47, 1.35, new Vector3(0, 1.23, 0), scene);
  camera.mode = Camera.ORTHOGRAPHIC_CAMERA;
  camera.orthoLeft = -0.34;
  camera.orthoRight = 0.34;
  camera.orthoTop = 0.34;
  camera.orthoBottom = -0.34;
  scene.activeCamera = camera;

  const character = new CharacterEntity(scene, {
    name: `forum_avatar_${target.accountId}`,
    modelPath: getCharacterModelPath(target.appearance),
    targetHeight: CHARACTER_TARGET_HEIGHT,
  });
  character.setPickable(false);
  character.setPositionXYZ(0, 0, 0);
  await character.whenReady();
  character.setFacingAngle(-Math.PI / 2 + settings.yaw);
  const root = character.getRoot();
  if (root) root.rotation.x = settings.rootPitch;
  character.applyAppearance(target.appearance);
  await attachAvatarGear(scene, character, target, itemDefs, gearOverrides);
  await settleAvatarScene(scene);
  frameAvatarCamera(scene, camera, settings);

  for (let i = 0; i < 3; i++) scene.render();
  const dataUrl = canvas.toDataURL('image/webp', 0.88);
  character.dispose();
  scene.dispose();
  engine.dispose();
  return dataUrl;
}

export function ForumAvatarBakeApp() {
  const [log, setLog] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');
  const [targets, setTargets] = useState<AvatarTarget[]>([]);
  const [itemDefs, setItemDefs] = useState<ItemDef[]>([]);
  const [gearOverrides, setGearOverrides] = useState<Record<string, GearOverride>>({});
  const [settings, setSettings] = useState<AvatarRenderSettings>(() => loadSavedRenderSettings());
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewTargetId, setPreviewTargetId] = useState(0);
  const settingsRef = useRef(settings);
  const dragRef = useRef<{ x: number; y: number; yaw: number; elevation: number; latest: AvatarRenderSettings } | null>(null);
  const autorunStarted = useRef(false);

  function append(line: string) {
    setLog((current) => [...current, line]);
  }

  async function ensureBakeData(): Promise<{ allTargets: AvatarTarget[]; allItems: ItemDef[]; allGearOverrides: Record<string, GearOverride> }> {
    if (targets.length > 0 && itemDefs.length > 0 && Object.keys(gearOverrides).length > 0) {
      return { allTargets: targets, allItems: itemDefs, allGearOverrides: gearOverrides };
    }
    const [allTargets, allItems, allGearOverrides] = await Promise.all([loadTargets(), loadItems(), loadGearOverrides()]);
    setTargets(allTargets);
    setItemDefs(allItems);
    setGearOverrides(allGearOverrides);
    if (!previewTargetId && allTargets[0]) setPreviewTargetId(allTargets[0].accountId);
    return { allTargets, allItems, allGearOverrides };
  }

  async function renderPreview(nextSettings: AvatarRenderSettings = settings) {
    setProgress('Rendering preview...');
    try {
      const { allTargets, allItems, allGearOverrides } = await ensureBakeData();
      const target = allTargets.find((entry) => entry.accountId === previewTargetId) ?? allTargets[0];
      if (!target) throw new Error('No avatar targets found.');
      setPreviewTargetId(target.accountId);
      setPreviewUrl(await renderAvatar(target, allItems, allGearOverrides, nextSettings));
      setProgress('Preview ready.');
    } catch (error) {
      setProgress('Preview failed.');
      append(error instanceof Error ? error.message : String(error));
    }
  }

  async function runBake(onlyMissing: boolean) {
    setRunning(true);
    setLog([]);
    setProgress('Loading targets...');
    window.__forumAvatarBakeDone = false;
    try {
      const { allTargets, allItems, allGearOverrides } = await ensureBakeData();
      const targets = onlyMissing ? allTargets.filter((target) => !target.baked) : allTargets;
      append(`Found ${allTargets.length} avatar target(s), baking ${targets.length}.`);
      let done = 0;
      const errors: string[] = [];
      for (const target of targets) {
        setProgress(`${done + 1} / ${targets.length}: ${target.username}`);
        try {
          const dataUrl = await renderAvatar(target, allItems, allGearOverrides, settings);
          await postAvatar(target, dataUrl);
          append(`${target.username}: OK`);
        } catch (error) {
          const message = `${target.username}: ${error instanceof Error ? error.message : String(error)}`;
          errors.push(message);
          append(message);
        }
        done++;
      }
      setProgress('Done.');
      window.__forumAvatarBakeResult = { ok: errors.length === 0, baked: targets.length - errors.length, total: targets.length, errors };
    } catch (error) {
      setProgress('Failed.');
      const message = error instanceof Error ? error.message : String(error);
      append(message);
      window.__forumAvatarBakeResult = { ok: false, baked: 0, total: 0, errors: [message] };
    } finally {
      window.__forumAvatarBakeDone = true;
      setRunning(false);
    }
  }

  useEffect(() => {
    void ensureBakeData().catch((error) => append(error instanceof Error ? error.message : String(error)));
  }, []);

  useEffect(() => {
    settingsRef.current = settings;
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (autorunStarted.current) return;
    if (new URLSearchParams(window.location.search).get('autorun') !== 'missing') return;
    autorunStarted.current = true;
    void runBake(true);
  }, []);

  function updateSetting(key: keyof AvatarRenderSettings, value: number) {
    setSettings((current) => {
      const next = { ...current, [key]: value };
      settingsRef.current = next;
      return next;
    });
  }

  function resetSettings() {
    setSettings(DEFAULT_RENDER_SETTINGS);
    setPreviewUrl('');
  }

  function handleDragStart(event: PointerEvent<HTMLDivElement>) {
    dragRef.current = { x: event.clientX, y: event.clientY, yaw: settings.yaw, elevation: settings.elevation, latest: settings };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function handleDragMove(event: PointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag) return;
    const next = {
      ...settings,
      yaw: Math.max(-1.4, Math.min(1.4, drag.yaw + (event.clientX - drag.x) * 0.01)),
      elevation: Math.max(-0.25, Math.min(1.35, drag.elevation + (drag.y - event.clientY) * 0.01)),
    };
    drag.latest = next;
    setSettings(next);
  }

  function handleDragEnd() {
    const next = dragRef.current?.latest;
    dragRef.current = null;
    if (next) void renderPreview(next);
  }

  return (
    <main className="page forums-page">
      <section className="panel forum-panel">
        <h1 className="panel-title">Forum Avatar Baker</h1>
        <p className="forum-empty">Generates static WebP head avatars from saved character appearance and visible saved gear.</p>
        <div className="forum-bake-tuner">
          <div
            className="forum-bake-preview"
            role="presentation"
            onPointerDown={handleDragStart}
            onPointerMove={handleDragMove}
            onPointerUp={handleDragEnd}
            onPointerCancel={handleDragEnd}
          >
            {previewUrl ? <img src={previewUrl} alt="Avatar preview" /> : <span>Drag here after preview</span>}
          </div>
          <div className="forum-bake-controls">
            <label>
              Player
              <select value={previewTargetId} onChange={(event) => setPreviewTargetId(Number(event.target.value))}>
                {targets.map((target) => <option key={target.accountId} value={target.accountId}>{target.username}</option>)}
              </select>
            </label>
            <label>
              Side Angle
              <input type="range" min="-1.4" max="1.4" step="0.01" value={settings.yaw} onChange={(event) => updateSetting('yaw', Number(event.target.value))} onPointerUp={() => void renderPreview(settingsRef.current)} />
            </label>
            <label>
              Camera Angle
              <input type="range" min="-0.25" max="1.35" step="0.01" value={settings.elevation} onChange={(event) => updateSetting('elevation', Number(event.target.value))} onPointerUp={() => void renderPreview(settingsRef.current)} />
            </label>
            <label>
              Camera Height
              <input type="range" min="-0.8" max="1.2" step="0.01" value={settings.cameraHeight} onChange={(event) => updateSetting('cameraHeight', Number(event.target.value))} onPointerUp={() => void renderPreview(settingsRef.current)} />
            </label>
            <label>
              Head Pitch
              <input type="range" min="-0.8" max="0.8" step="0.01" value={settings.rootPitch} onChange={(event) => updateSetting('rootPitch', Number(event.target.value))} onPointerUp={() => void renderPreview(settingsRef.current)} />
            </label>
            <label>
              Aim
              <input type="range" min="0.45" max="1.9" step="0.01" value={settings.targetDrop} onChange={(event) => updateSetting('targetDrop', Number(event.target.value))} onPointerUp={() => void renderPreview(settingsRef.current)} />
            </label>
            <label>
              Zoom
              <input type="range" min="0.07" max="0.18" step="0.001" value={settings.crop} onChange={(event) => updateSetting('crop', Number(event.target.value))} onPointerUp={() => void renderPreview(settingsRef.current)} />
            </label>
            <div className="forum-composer-actions">
              <button type="button" disabled={running} onClick={() => void renderPreview()}>Render Preview</button>
              <button type="button" disabled={running} onClick={resetSettings}>Reset</button>
            </div>
          </div>
        </div>
        <div className="forum-composer-actions">
          <button type="button" disabled={running} onClick={() => void runBake(true)}>Bake Missing</button>
          <button type="button" disabled={running} onClick={() => void runBake(false)}>Rebake All</button>
          <a className="auth-topbar-link forum-nav-link" href="/forums">Back to Forums</a>
        </div>
        <p className="forum-empty">{progress}</p>
        <pre className="forum-bake-log">{log.join('\n')}</pre>
      </section>
    </main>
  );
}
