# Authoring Gear in Blender — RS2 Style

A practical step-by-step for making rigid equipment (weapons, helmets, shields, boots, etc.) that fits both the **RuneScape 2 visual style** and the **EvilQuest runtime pipeline**. Skinned/deforming armor (chest plates, leg armor) is harder and not covered here — see [CLAUDE.md](../CLAUDE.md) for why.

This guide assumes Blender 4.x. All numbers below are starting points — eyeball them in-game and adjust.

---

## 1. The RS2 visual brief

What "RS2 style" actually means in concrete terms:

| Property | Value | Why |
|---|---|---|
| Polycount per item | 100–1,500 tris | Chunky, low detail. A dagger is ~150 tris, a longsword ~400, a kite shield ~200, a great helm ~500. |
| Shading | **Flat shading** or smooth + Mark Sharp on every silhouette edge | Hard facets are part of the look |
| Materials | Solid base color per face cluster — no textures except for inventory icons | RS2 era was vertex colors or single-color materials. No PBR roughness/normal maps. |
| Color palette | 3–5 colors per item, saturated mid-tones | Bronze brown, iron grey, steel light grey, mithril navy, adamant green, rune cyan, dragon red, gold, copper, silver |
| Proportions | Oversized hilts, exaggerated curves, bigger-than-realistic | Items must read at game zoom. A "realistic" sword looks like a stick on the character. |
| Edge bevel | None. Sharp 90° corners | Beveled edges look modern, not RS2 |

**Reference your eye:** open up `/Character models/main character.glb` in Blender, scale a primitive cube to 0.30m × 0.30m × 0.30m next to the character's right hand. That's roughly the size of a one-handed weapon's hilt + guard. A helmet is about 0.20m wide × 0.25m tall.

---

## 2. Blender setup

One-time:

1. **Set scene units to meters.** `Scene Properties → Units → Length: Meters, Scale: 1.0`. Default since Blender 2.8 but worth checking.
2. **Set origin handling.** When making new gear, you'll want **Object → Set Origin → Origin to 3D Cursor** ready as muscle memory; the cursor at world origin (Shift+S → Cursor to World Origin) is your attach point.
3. **Keep one reference scene open** — open `/home/nick/Downloads/mixamo armature hair rigged.blend` (the character file) in a second window. Use it to eyeball weapon size against the hand bone, helmet size against the head.
4. **Backface culling on:** Material panel → Settings → Backface Culling. Helps spot inverted normals immediately.

Per-piece:

5. Start a fresh empty .blend (or a single "gear-workshop.blend" with one piece per collection — easier to iterate).
6. Delete the default cube, set 3D cursor at world origin (`Shift+S` → Cursor to World Origin).

---

## 3. Origin & orientation conventions per slot

The runtime parents your mesh to a bone with a small offset (`EQUIP_SLOT_BONES` in `client/src/data/EquipmentConfig.ts`). For your mesh to land in the right place, **its origin needs to be at the bone's attach point, and its forward axis needs to match the bone's local axes**.

| Slot | Bone | Mesh origin should be at | Mesh "forward" (glTF +Y is up) |
|---|---|---|---|
| `weapon` (held in right hand) | `mixamorig:RightHand` | The hilt where the palm wraps. **Not** the pommel, **not** the blade tip. | Blade tip points along **+Y** in mesh-local (then bone rotates it correctly). |
| `shield` | `mixamorig:LeftForeArm` | The inner face of the shield where it touches the forearm. | Shield's "outside face" points **-Z** (away from body). |
| `head` (helmet) | `mixamorig:Head` | The bottom rim of the helmet, centered. | Top of helmet **+Y**, face-opening points **-Z**. |
| `body` (rigid chest piece) | `mixamorig:Spine2` | Sternum-level center. | Front of chest **-Z**. |
| `legs` (rigid kilt/skirt) | `mixamorig:Hips` | Hip joint center. | Front **-Z**. |
| `feet` (rigid boots, single-mesh) | `mixamorig:RightFoot` | Heel base. | Toe direction **-Z** (forward). |
| `neck` (amulet) | `mixamorig:Neck` | Top of sternum, where chain rests. | Pendant hangs **-Y** (down). |
| `cape` | `mixamorig:Spine1` | Upper back attachment point. | Cape body trails **-Y** (down) and **+Z** (back). |

**Quick verification trick:** in Blender, before exporting, parent your mesh to an Empty at world origin. Rotate the empty to simulate the bone. Does the gear move correctly? If yes, origin/orientation are right.

---

## 4. Materials and color

Our runtime converts every gear material from PBR → flat StandardMaterial. So:

- **Use Principled BSDF** with only the **Base Color** input set. Don't bother with metallic, roughness, normal maps — they're stripped.
- **One material per visible color region.** A sword might have: `metal_blade`, `metal_guard`, `wrap_grip`, `pommel_jewel`. Five materials max for a complex piece, two or three is plenty for most.
- **Material naming convention** if you want to integrate with the runtime recolor system:

| Material name | Recolored by |
|---|---|
| `Skin` | `skinColor` slot |
| `Hair_1` | `hairColor` slot |
| `Shirt`, `shirt openings`, `mat_4550` | `shirtColor` slot |
| `pants` | `pantsColor` slot |
| `socks` | `shoesColor` slot |
| `belt` | `beltColor` slot |
| anything else | static, color baked in |

For metal-tier weapons (bronze, iron, steel, mithril, etc.) the runtime can tint via `TOOL_TIER_METAL_COLOR` in `EquipmentConfig.ts` — see line 22 onward. If your sword's main metal material is named `Metal` and the item ID is in that map, the runtime tints it per metal tier automatically.

**RS2 base color palette** (Principled BSDF Base Color values, linear RGB):

| Metal tier | Base Color (R, G, B) |
|---|---|
| Bronze | (0.45, 0.28, 0.12) — warm brown |
| Iron | (0.48, 0.48, 0.50) — neutral grey |
| Steel | (0.75, 0.78, 0.82) — bright silver |
| Mithril | (0.12, 0.22, 0.40) — dark navy |
| Adamant | (0.10, 0.40, 0.20) — forest green |
| Rune | (0.20, 0.55, 0.65) — cyan-teal |
| Dragon | (0.55, 0.10, 0.10) — deep crimson |
| Gold | (0.95, 0.78, 0.30) — sunny gold |
| Wood (handles) | (0.30, 0.18, 0.10) — dark walnut |
| Leather (wraps) | (0.18, 0.12, 0.08) — deep leather |

Remember: the runtime applies a 1.3× boost and 0.55× emissive on top, so colors will *appear* brighter in-game than in Blender's viewport.

**Shading:** select all faces → `Object → Shade Flat`. Don't bother with Auto Smooth unless you want a subtle smoothing on a curved hilt.

---

## 5. Per-piece recipes

### A one-handed sword

Target: ~400 triangles, 4 materials.

1. Add cube → scale to 0.02 × 0.02 × 0.30m (the blade core)
2. Edit Mode → flatten the top face into a point (move tip vertices to center)
3. Add a thin cube at the bottom for the **guard**: 0.10 × 0.04 × 0.04m
4. Add a stretched cube for the **grip**: 0.025 × 0.025 × 0.10m
5. Add a UV sphere (8 segments, 6 rings) for the **pommel** at the bottom
6. Assign 4 materials by face selection: `Metal_blade`, `Metal_guard`, `Wrap_grip` (leather), `Pommel`
7. **Set origin at the grip** (where the hand goes): select grip mesh in Edit Mode → Snap Cursor to Selected → Object Mode → Object → Set Origin → Origin to 3D Cursor
8. Rotate so blade points along +Y in object-local space
9. Export as GLB

Polycount budget: blade ~50 tris, guard ~12, grip ~24, pommel ~80 → ~170 tris. Fine.

### A great helm (full enclosed)

Target: ~600 triangles, 1–2 materials.

1. Add cube → scale to 0.18 × 0.18 × 0.22m
2. Loop cut horizontally at the eye-slit height (~70% up from base)
3. Inset the front face → extrude inward to make the visor slit
4. Optionally bevel the top edge slightly for a domed look (shade flat keeps it angular regardless)
5. Add a small cylinder cross at the top for a knight crest (optional)
6. Material: `Metal_helm` (using metal-tier color from above)
7. **Set origin at the bottom rim center** (this is what attaches to the head bone): select bottom face → Snap Cursor → Set Origin to Cursor
8. Verify front of helmet points in -Z (Babylon's "forward" is negative Z)
9. Export

### A kite shield

Target: ~150 triangles, 2 materials.

1. Add a plane → subdivide ×2 → shape into shield silhouette by editing verts
2. Solidify modifier (thickness 0.02m) for thickness
3. Apply solidify
4. Optional: add a center boss (small cylinder) and a rim (extruded edge loop)
5. Materials: `Wood_shield` for face, `Metal_rim` for edges/boss, optional `Heraldry` for an emblem
6. **Set origin at the inner-face center** (touches the forearm)
7. Front of shield faces -Z
8. Export

### A bow

Target: ~250 triangles, 2 materials.

1. Add a curve (bezier) → shape into bow profile
2. Set bevel depth (~0.012m) to give it volume
3. Convert to mesh: Object → Convert → Mesh
4. Add a thin grip cylinder in the middle
5. Add an Empty + edge between bow tips (the string) — keep as a separate mesh, set material to a near-black `Bowstring`
6. Materials: `Wood_bow`, `Bowstring`, optional `Wrap_grip`
7. Set origin at the grip
8. Export

### Boots (rigid, single mesh)

Target: ~300 triangles, 2 materials.

Note: boots are typically rendered as one rigid mesh that follows the right foot bone. Both feet visually wear "the same" mesh because we mirror onto the left side via bone parenting (see `EQUIP_SLOT_BONES.feet`). RS2 traditionally just used the body mesh's foot geometry recolored — you can ship a *single* boot if it looks decent on both sides.

1. Add cube → shape into a foot silhouette (Edit Mode boxy modeling)
2. Loop cut + scale to make the toe taper, ankle cuff
3. Materials: `Boot_leather`, optional `Boot_sole`
4. Set origin at the heel (where the ankle bone connects)
5. Forward (toe direction) = -Z
6. Export — ship as `feet/<itemId>.glb`

---

## 6. Export workflow (every piece, every time)

The exact `bpy.ops.export_scene.gltf(...)` settings matter. Here's the recipe:

```
File → Export → glTF 2.0 (.glb/.gltf)

Format: glTF Binary (.glb)
Selected Objects: ON  (only export what you intend)
Animation: OFF        (gear is rigid)
Skinning: OFF         (rigid gear has no armature)
Apply Modifiers: ON
+Y Up: ON
Tangents: OFF         (we don't use them)
Compression: OFF      (causes issues, stay simple)
```

Filename: `<itemId>.glb` (matches `server/data/items.json` `id` field). Place at `client/public/assets/equipment/<slot>/<itemId>.glb`.

After export:

```bash
bun tools/check-glb.ts client/public/assets/equipment/weapon/220.glb
```

You should see `COMPATIBLE` with no warnings. If you see WARN, read the message and fix in Blender. If INCOMPATIBLE, the message tells you what's broken.

---

## 7. Wiring into the game

1. Add to `server/data/items.json`:

```json
{
  "id": 220,
  "name": "Iron Longsword",
  "description": "A standard iron longsword.",
  "stackable": false,
  "equippable": true,
  "equipSlot": "weapon",
  "weaponStyle": "sword",
  "stabAttack": 7,
  "slashAttack": 10,
  "meleeStrength": 11,
  "value": 50
}
```

2. Restart the server (`bun --watch` doesn't reload data files):
```bash
pkill -f "bun.*server/src/main.ts"; bun run dev:server &
```

3. In-game: `/give 220` then equip.

### 7a. Fit it with `/geardebug` — don't re-export from Blender

If the item sits visually wrong (rotated 90° off, slightly off-center, too big, hovering above the hand), **do not** re-export from Blender to fix placement. Use the in-game `/geardebug` panel instead:

1. With the item equipped, type `/geardebug` in chat. A sidebar with sliders appears.
2. Drag **position X/Y/Z**, **rotation X/Y/Z**, and **scale** sliders. The gear updates live as you drag.
3. Use the animation buttons (idle / walk / attack / chop / mine) to verify the gear stays sensible across motion.
4. Click **Save**. The dialed-in values are written to `server/data/gear-overrides.json` keyed by item ID. The runtime hot-reloads overrides on next equip.

A typical override entry the panel writes looks like:

```json
"220": {
  "localPosition": { "x": -0.12, "y": 0.05, "z": 0.0 },
  "localRotation": { "x": -1.5, "y": 0.0, "z": -1.6 },
  "scale": 0.85
}
```

You can hand-edit this file too, but `/geardebug` is faster — slider drag = ~1s feedback loop, vs Blender re-export = ~30–60s.

### When you DO still need to re-export from Blender

`/geardebug` only adjusts a single global transform. Re-export is needed when:

- The **mesh origin** is in the wrong place at the model level (you want the helmet origin at the bottom rim, but it's at the helmet's geometric center). Origin moves are best baked into the mesh.
- The **geometry itself** is wrong (sword too long, helmet shape wrong).
- **Materials** are wrong (missing texture, wrong color, multi-texture shader graph).
- **Normals or weights** are broken.

Rule of thumb: if a single item is fine on its own but doesn't fit *this character*, use `/geardebug`. If the issue would persist on any character, fix in Blender.

---

## 8. Inventory icons

The item also needs a 64×64 PNG icon. Pipeline:

1. In Blender, set up an orthographic camera centered on the item, transparent background.
2. Render at 256×256, downscale to 64×64 with nearest-neighbor (preserves pixel-art aesthetic).
3. Save to `client/public/sprites/<icon-name>.png`.
4. Reference in items.json with `"sprite": "icon-name.png"`.

Alternatively (faster), open the GLB in a viewer, screenshot, crop, downscale.

---

## 9. Common pitfalls

| Problem | Cause | Fix |
|---|---|---|
| Item appears 100× larger than expected | Forgot to apply object scale, or imported FBX with cm-scale | Object → Apply → Scale before export, OR set Scale to 0.01 in object panel and apply |
| Item attached but in wrong position | Mesh origin is at world origin, not the attach point | Edit Mode → select attach vert → Snap Cursor to Selected → Object → Set Origin → Origin to 3D Cursor |
| Item rotates with the bone but pointing the wrong direction | Forward axis mismatch | In object mode, rotate item until it points correctly relative to the world-axis arrows, then Apply Rotation |
| Sword renders all dark | Normals inverted | Edit Mode → select all → Mesh → Normals → Recalculate Outside |
| Helmet looks completely solid blue/red/etc., no detail | You're using a multi-texture Polytope-style material | Replace with simple Principled BSDF + Base Color only |
| Item flickers / z-fighting | Two faces at exact same position | Edit Mode → Mesh → Clean Up → Merge by Distance |
| Item feels too "small" in-game | Authored at realistic proportions | RS2 items should be ~30–50% LARGER than realistic. Iterate. |

---

## 10. Workflow tips

- **Iterate fast:** keep the dev server running. Re-export GLB → hard-refresh browser → equip the item. ~10 second feedback loop.
- **Build a kit first:** make a shared "metal_steel" material once, link it across pieces (in the material slot, click the chain icon) so all your steel weapons share one color. Update one, all update.
- **Use proportional editing** (`O` key) for organic shapes like cape folds, leather wraps. Stay topologically simple.
- **Reference real RS2 items** for silhouette inspiration — runescape.wiki has clean orthographic renders of every weapon and armor piece. Don't trace, but do match the recognizable shape.
- **Save Blender source files** at `tools/blender/<itemname>.blend` (untracked — add to .gitignore if you start using it). The .glb is the shippable artifact.

---

## What this doesn't cover

- **Skinned armor** (chest plates with deformation) — see [CLAUDE.md § Equipment / gear](../CLAUDE.md). Hard problem; we parked the Polysplit attempt for good reason.
- **Animated equipment** (banner-style flapping cape) — would need vertex animation or a mini skeleton; not built yet.
- **Particle effects** (glowing rune sword) — would need Babylon's particle system wired to the gear node; not built yet.

For the OSRS-style game we're shipping, rigid gear + per-tier color tinting covers ~90% of what players see. Skinned armor is the polish-pass goal.
