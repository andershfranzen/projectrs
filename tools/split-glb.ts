/**
 * Split a multi-asset GLB into one .gltf per top-level scene node, with all
 * textures deduped into a shared `textures/` folder referenced by URI.
 *
 * Babylon's glTF loader dedupes textures by URL at scene load, so two separate
 * assets that originally shared a texture will share one WebGL texture at
 * runtime — critical for keeping VRAM bounded in an MMO scene.
 *
 * Usage: bun tools/split-glb.ts <input.glb> <output-dir>
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { prune, dedup } from '@gltf-transform/functions'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'

function sanitize(name: string, fallback: string): string {
  const cleaned = (name || '').trim().replace(/[^a-zA-Z0-9_\- ]+/g, '').replace(/\s+/g, '_')
  return cleaned || fallback
}

function extForMimeType(mime: string): string {
  if (mime === 'image/jpeg') return 'jpg'
  if (mime === 'image/webp') return 'webp'
  if (mime === 'image/ktx2') return 'ktx2'
  return 'png'
}

function textureFilename(data: Uint8Array, mime: string): string {
  const hash = createHash('md5').update(data).digest('hex').slice(0, 16)
  return `${hash}.${extForMimeType(mime)}`
}

async function main() {
  const [inputArg, outDirArg] = process.argv.slice(2)
  if (!inputArg || !outDirArg) {
    console.error('Usage: bun tools/split-glb.ts <input.glb> <output-dir>')
    process.exit(1)
  }

  const input = resolve(inputArg)
  const outDir = resolve(outDirArg)
  const sharedTexDir = resolve(outDir, 'textures')

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)

  // --- Pre-pass: write every unique texture to shared folder ---
  const srcDocPre = await io.read(input)

  // Refuse skinned meshes — prune() strips skin bindings and turns characters
  // into scattered vertex planes. Characters need a different pipeline.
  const skins = srcDocPre.getRoot().listSkins()
  if (skins.length > 0) {
    console.error(
      `Refusing to split: ${input} has ${skins.length} skin(s). ` +
      `prune() would break the skeleton binding. ` +
      `Skinned/animated GLBs need a different pipeline.`
    )
    process.exit(1)
  }

  await mkdir(sharedTexDir, { recursive: true })

  const srcTextures = srcDocPre.getRoot().listTextures()
  const writtenFiles = new Set<string>()
  let sharedTotalBytes = 0
  for (const tex of srcTextures) {
    const img = tex.getImage()
    if (!img) continue
    const mime = tex.getMimeType() || 'image/png'
    const fname = textureFilename(img, mime)
    if (writtenFiles.has(fname)) continue
    writtenFiles.add(fname)
    await writeFile(resolve(sharedTexDir, fname), img)
    sharedTotalBytes += img.byteLength
  }
  console.log(
    `Shared textures: ${writtenFiles.size} unique (${srcTextures.length} refs) — ${(sharedTotalBytes / 1024 / 1024).toFixed(1)} MB`
  )

  // --- Main pass: one .gltf per top-level node ---
  const srcDoc = await io.read(input)
  const srcScene = srcDoc.getRoot().getDefaultScene() || srcDoc.getRoot().listScenes()[0]
  if (!srcScene) {
    console.error('No scenes in GLB')
    process.exit(1)
  }
  const topNodes = srcScene.listChildren()
  console.log(`Top-level nodes: ${topNodes.length}`)

  const usedNames = new Set<string>()
  let index = 0
  let splitTotalBytes = 0

  for (const node of topNodes) {
    index++
    const rawName = node.getName()
    let name = sanitize(rawName, `node_${index}`)
    let unique = name
    let suffix = 2
    while (usedNames.has(unique)) unique = `${name}_${suffix++}`
    usedNames.add(unique)

    // Fresh doc per split — simpler & safer than mutating one shared doc.
    const doc = await io.read(input)
    const scene = doc.getRoot().getDefaultScene() || doc.getRoot().listScenes()[0]
    if (!scene) continue

    const freshTop = scene.listChildren()
    const keep = freshTop[index - 1]
    if (!keep) continue

    // Dispose siblings — this cascades: removes them from the scene AND
    // orphans any children they held, so prune can reach everything unreachable.
    for (const sibling of freshTop) {
      if (sibling !== keep) sibling.dispose()
    }
    for (const s of doc.getRoot().listScenes()) {
      if (s !== scene) s.dispose()
    }

    // Run prune twice to reach fixed-point: pass 1 removes orphan parents,
    // pass 2 removes their newly-orphaned children/meshes/materials.
    await doc.transform(prune(), prune(), dedup())

    // Replace each remaining texture's embedded image with a URI reference
    // to the shared textures folder.
    for (const tex of doc.getRoot().listTextures()) {
      const img = tex.getImage()
      if (!img) continue
      const mime = tex.getMimeType() || 'image/png'
      const fname = textureFilename(img, mime)
      tex.setURI(`textures/${fname}`)
      // Clear embedded bytes so the writer emits only the URI reference.
      tex.setImage(new Uint8Array(0))
    }

    const outPath = resolve(outDir, `${unique}.gltf`)
    // Give each split its own buffer name so 169 gltfs don't all overwrite
    // the same `buffer.bin`.
    for (const buffer of doc.getRoot().listBuffers()) {
      buffer.setURI(`${unique}.bin`)
    }
    // Write in-memory, then emit .gltf + .bin only. Skip image resources
    // so gltf-transform doesn't clobber our shared textures with empty
    // placeholders (the textures have setImage(empty) to force URI
    // serialization, but the writer would also emit those empty bytes).
    const jsonDoc = await io.writeJSON(doc)
    await writeFile(outPath, JSON.stringify(jsonDoc.json))
    for (const [uri, data] of Object.entries(jsonDoc.resources || {})) {
      const lower = uri.toLowerCase()
      if (lower.endsWith('.png') || lower.endsWith('.jpg') ||
          lower.endsWith('.jpeg') || lower.endsWith('.webp') ||
          lower.endsWith('.ktx2')) continue
      const resourcePath = resolve(dirname(outPath), uri)
      await mkdir(dirname(resourcePath), { recursive: true })
      await writeFile(resourcePath, data)
    }

    try {
      const { statSync } = await import('node:fs')
      splitTotalBytes += statSync(outPath).size
      const binPath = outPath.replace(/\.gltf$/, '.bin')
      try { splitTotalBytes += statSync(binPath).size } catch {}
    } catch {}

    console.log(`  [${index}/${topNodes.length}] ${rawName || '(unnamed)'} -> ${unique}.gltf`)
  }

  console.log(
    `\nDone. Wrote ${index} files (${(splitTotalBytes / 1024 / 1024).toFixed(1)} MB geometry) + ${writtenFiles.size} shared textures (${(sharedTotalBytes / 1024 / 1024).toFixed(1)} MB) to ${outDir}`
  )
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
