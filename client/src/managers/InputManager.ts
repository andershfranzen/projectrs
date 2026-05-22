import { Scene } from '@babylonjs/core/scene';
import { Vector3 } from '@babylonjs/core/Maths/math.vector';
import { AbstractMesh } from '@babylonjs/core/Meshes/abstractMesh';
import type { Node } from '@babylonjs/core/node';
import { Plane } from '@babylonjs/core/Maths/math.plane';
import { PointerEventTypes } from '@babylonjs/core/Events/pointerEvents';
import '@babylonjs/core/Culling/ray';
import type { ChunkManager } from '../rendering/ChunkManager';
import { SAME_PLANE_PICK_Y_TOLERANCE } from '../rendering/pickingConstants';

export type GroundClickCallback = (worldX: number, worldZ: number) => void;
export type TeleportClickCallback = (worldX: number, worldZ: number) => void;
export type ObjectClickCallback = (objectEntityId: number) => void;

/**
 * Handles mouse/keyboard input for the game.
 *
 * Ground clicks use ray-plane projection at player height so that walls,
 * placed objects, and other vertical geometry never block the click target.
 * Pathfinding handles obstacle avoidance.
 */
export class InputManager {
  private scene: Scene;
  private chunkManager: ChunkManager;
  private onGroundClick: GroundClickCallback | null = null;
  private onTeleportClick: TeleportClickCallback | null = null;
  private onObjectClick: ObjectClickCallback | null = null;
  private playerY: number = 0;
  /** Gates click handling during the post-login loading window. Until the
   *  spawn chunk's terrain + objects finish streaming, clicks would resolve
   *  against a sentinel-WALL world or fire pathfinds that walk past
   *  yet-to-load trees. GameManager flips this after the loading screen
   *  resolves. */
  private enabled: boolean = false;

  constructor(scene: Scene, chunkManager: ChunkManager) {
    this.scene = scene;
    this.chunkManager = chunkManager;

    this.scene.onPointerObservable.add((pointerInfo) => {
      if (pointerInfo.type === PointerEventTypes.POINTERDOWN) {
        if (pointerInfo.event.button !== 0) return;
        this.handlePrimaryAction(this.scene.pointerX, this.scene.pointerY, pointerInfo.event.shiftKey);
      }
    });
  }

  /** Update the current player Y height (call each frame during movement) */
  setPlayerY(y: number): void {
    this.playerY = y;
  }

  setEnabled(enabled: boolean): void { this.enabled = enabled; }
  isEnabled(): boolean { return this.enabled; }

  handlePrimaryActionAt(clientX: number, clientY: number, shiftKey: boolean = false): boolean {
    const canvas = this.scene.getEngine().getRenderingCanvas();
    if (!canvas) return false;
    const rect = canvas.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return false;
    const pointerX = (clientX - rect.left) * (this.scene.getEngine().getRenderWidth() / rect.width);
    const pointerY = (clientY - rect.top) * (this.scene.getEngine().getRenderHeight() / rect.height);
    return this.handlePrimaryAction(pointerX, pointerY, shiftKey);
  }

  private handlePrimaryAction(pointerX: number, pointerY: number, shiftKey: boolean): boolean {
    if (!this.enabled) return false;

    // Shift+click = debug teleport
    if (shiftKey && this.onTeleportClick) {
      const groundPos = this.pickGround(pointerX, pointerY);
      if (groundPos) {
        this.onTeleportClick(groundPos.x, groundPos.z);
        return true;
      }
      return false;
    }

    // Check for interactive object hit (trees, rocks, doors)
    // Use scene.pick (closest to camera) for objects — prevents clicking
    // a rock behind another rock or through terrain
    if (this.onObjectClick) {
      const pick = this.scene.pick(
        pointerX,
        pointerY,
        (mesh) => {
          // Only pick meshes that belong to interactive objects
          let node: Node | null = mesh;
          while (node) {
            if (node.metadata?.objectEntityId != null) return true;
            node = node.parent;
          }
          return false;
        },
        false,
        this.scene.activeCamera!
      );
      if (pick?.hit && pick.pickedMesh) {
        let node: Node | null = pick.pickedMesh;
        while (node) {
          if (node.metadata?.objectEntityId != null) {
            this.onObjectClick(node.metadata.objectEntityId);
            return true;
          }
          node = node.parent;
        }
      }
    }

    // Ground click: project ray onto horizontal plane at player height.
    // This ignores walls and objects entirely — click WHERE you want to go.
    const groundPos = this.pickGround(pointerX, pointerY);
    if (groundPos) {
      this.onGroundClick?.(groundPos.x, groundPos.z);
      return true;
    }

    return false;
  }

  /**
   * Pick the ground tile the cursor is over by raycasting against any walkable
   * surface — floor 0 terrain, upper-floor mesh sets, and texture planes —
   * then verify the picked point's Y matches the player's current floor at
   * that (x, z). Without the floor verification, clicks on a 2nd-floor
   * surface would resolve to the floor 0 X/Z behind/below it (RS2's "your
   * click only counts on your own plane" rule). Snapped to tile centre.
   */
  private pickGround(pointerX: number = this.scene.pointerX, pointerY: number = this.scene.pointerY): { x: number; z: number } | null {
    if (!this.scene.activeCamera) return null;

    // Accept any pickable visible mesh — the Y-match check below handles
    // floor/plane filtering. Walls, door frames, and roof slabs are
    // skipped via assetId so the ray traces through them to the floor /
    // ground behind, letting players click directly into a building.
    const isClickThroughAsset = (m: any): boolean => {
      let n = m;
      while (n) {
        const aid = n.metadata?.assetId;
        if (typeof aid === 'string') {
          const lower = aid.toLowerCase();
          if (lower.includes('wall')) return true;
          if (lower.includes('doorframe') || lower.includes('doorway')) return true;
          if (lower.includes('roof')) return true;
          if (lower.includes('truedoor')) return true;
        }
        n = n.parent;
      }
      return false;
    };
    const pickPredicate = (mesh: AbstractMesh) =>
      mesh.isEnabled() && mesh.isVisible && mesh.isPickable && !isClickThroughAsset(mesh);
    const isTexturePlane = (m: any): boolean => {
      let n = m;
      while (n) {
        if (n.metadata?.isTexPlane && n.metadata?.isFlat) return true;
        n = n.parent;
      }
      return false;
    };
    const validHit = (hit: { pickedPoint?: Vector3 | null; pickedMesh?: AbstractMesh | null }): { x: number; z: number } | null => {
      const p = hit.pickedPoint;
      if (!p) return null;
      if (hit.pickedMesh && isTexturePlane(hit.pickedMesh)) {
        const walkableHeights = this.chunkManager.getWalkableHeightsAt(p.x, p.z);
        const matchesWalkableHeight = walkableHeights.some(height => Math.abs(p.y - height) <= 0.35);
        const matchesPlayerPlane = Math.abs(p.y - this.playerY) <= SAME_PLANE_PICK_Y_TOLERANCE;
        if (!matchesWalkableHeight || !matchesPlayerPlane) return null;
        return {
          x: Math.floor(p.x) + 0.5,
          z: Math.floor(p.z) + 0.5,
        };
      }
      const floor = this.chunkManager.getCurrentFloor();
      const expectedY = this.chunkManager.getEffectiveHeight(p.x, p.z, floor, this.playerY);
      // Reject the click if the picked point is not on the player's current
      // plane. ±0.6 tolerance covers stair ramps + small height variation
      // within a floor; anything bigger is a different floor (or the click
      // landed on a roof/wall mistakenly registered as pickable).
      if (Math.abs(p.y - expectedY) > 0.6) return null;
      return {
        x: Math.floor(p.x) + 0.5,
        z: Math.floor(p.z) + 0.5,
      };
    };
    const ray = this.scene.createPickingRay(
      pointerX,
      pointerY,
      null,
      this.scene.activeCamera
    );
    const authoredPlaneHit = this.chunkManager.pickAuthoredFlatTexturePlane(ray.origin, ray.direction, this.playerY);
    if (authoredPlaneHit) {
      return {
        x: Math.floor(authoredPlaneHit.x) + 0.5,
        z: Math.floor(authoredPlaneHit.z) + 0.5,
      };
    }

    const hits = this.scene.multiPick(
      pointerX,
      pointerY,
      pickPredicate,
      this.scene.activeCamera
    );

    if (hits?.length) {
      hits.sort((a, b) => (a.distance ?? Infinity) - (b.distance ?? Infinity));
      const textureHits = hits.filter(hit => hit.pickedMesh && isTexturePlane(hit.pickedMesh));
      for (const hit of textureHits) {
        const result = validHit(hit);
        if (result) return result;
      }
      for (const hit of hits) {
        if (hit.pickedMesh && isTexturePlane(hit.pickedMesh)) continue;
        const result = validHit(hit);
        if (result) return result;
      }
      // No same-plane hit was available. Allow a lower walkable surface as a
      // target so players standing on an elevated floor can click the ground
      // at the bottom of a stair slope. Path validation still decides whether
      // a real route exists.
      for (const hit of hits) {
        const p = hit.pickedPoint;
        if (!p || p.y >= this.playerY - SAME_PLANE_PICK_Y_TOLERANCE) continue;
        const walkableHeights = this.chunkManager.getWalkableHeightsAt(p.x, p.z);
        if (!walkableHeights.some(height => Math.abs(p.y - height) <= 0.35)) continue;
        return {
          x: Math.floor(p.x) + 0.5,
          z: Math.floor(p.z) + 0.5,
        };
      }
    }

    const pick = this.scene.pick(
      pointerX,
      pointerY,
      pickPredicate,
      false,
      this.scene.activeCamera
    );

    const singlePickResult = pick?.hit ? validHit(pick) : null;
    if (singlePickResult) return singlePickResult;

    if (ray.direction.y === 0) return null;

    const t = (this.playerY - ray.origin.y) / ray.direction.y;
    if (t <= 0) return null;

    return {
      x: Math.floor(ray.origin.x + ray.direction.x * t) + 0.5,
      z: Math.floor(ray.origin.z + ray.direction.z * t) + 0.5,
    };
  }

  setGroundClickHandler(callback: GroundClickCallback): void {
    this.onGroundClick = callback;
  }

  setTeleportClickHandler(callback: TeleportClickCallback): void {
    this.onTeleportClick = callback;
  }

  setObjectClickHandler(callback: ObjectClickCallback): void {
    this.onObjectClick = callback;
  }

  setIndoorCheck(check: () => { indoors: boolean; playerY: number }): void {
    // Kept for API compatibility — indoor handling is now implicit via playerY
  }
}
