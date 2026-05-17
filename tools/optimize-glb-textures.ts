/**
 * Resize + re-encode textures embedded in GLBs.
 *
 * Usage:
 *   bun tools/optimize-glb-textures.ts <glob> [--max=512] [--quality=85] [--dry-run] [--no-backup]
 *
 * Examples:
 *   bun tools/optimize-glb-textures.ts 'client/public/assets/modular-assets/limestone-modular/*.glb'
 *   bun tools/optimize-glb-textures.ts 'client/public/assets/models/desert well.glb' --max=512
 *
 * Defaults: cap textures at 512x512, encode baseColor as WebP q=85, write `<file>.bak`
 * once per file (skipped if a .bak already exists — re-runs are idempotent).
 *
 * Skinned GLBs are skipped (logged): the script is meant for bulk runs that
 * include character/armor folders, so failing the whole batch on one skinned
 * file is the wrong default. Characters need a different pipeline.
 */
import { Document, NodeIO, type Texture } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { Glob } from 'bun'
import { constants as fsConstants } from 'node:fs'
import { copyFile, rename, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import sharp from 'sharp'

const MIME_PNG = 'image/png'
const MIME_WEBP = 'image/webp'

type Opts = {
  max: number
  quality: number
  dryRun: boolean
  noBackup: boolean
}

function parseArgs(argv: string[]): { pattern: string; opts: Opts } {
  let pattern: string | undefined
  const opts: Opts = { max: 512, quality: 85, dryRun: false, noBackup: false }
  for (const a of argv) {
    if (a.startsWith('--max=')) opts.max = parseInt(a.slice(6), 10)
    else if (a.startsWith('--quality=')) opts.quality = parseInt(a.slice(10), 10)
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--no-backup') opts.noBackup = true
    else if (!pattern) pattern = a
  }
  if (!pattern) {
    console.error('Usage: bun tools/optimize-glb-textures.ts <glob> [--max=512] [--quality=85] [--dry-run] [--no-backup]')
    process.exit(1)
  }
  return { pattern, opts }
}

function fmtMB(b: number): string { return (b / 1024 / 1024).toFixed(2) + 'MB' }

function collectDataTextures(doc: Document): Set<Texture> {
  const out = new Set<Texture>()
  for (const mat of doc.getRoot().listMaterials()) {
    const n = mat.getNormalTexture(); if (n) out.add(n)
    const o = mat.getOcclusionTexture(); if (o) out.add(o)
    const mr = mat.getMetallicRoughnessTexture(); if (mr) out.add(mr)
  }
  return out
}

async function tryBackup(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, filePath + '.bak', fsConstants.COPYFILE_EXCL)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

async function optimizeOne(io: NodeIO, filePath: string, opts: Opts): Promise<{ before: number; after: number; changed: boolean }> {
  const before = Bun.file(filePath).size

  const doc = await io.read(filePath)

  if (doc.getRoot().listSkins().length > 0) {
    console.log(`  SKIP (skinned): ${filePath}`)
    return { before, after: before, changed: false }
  }

  const dataTextures = collectDataTextures(doc)
  let touched = 0

  for (const tex of doc.getRoot().listTextures()) {
    const img = tex.getImage()
    if (!img) continue
    const size = tex.getSize()
    if (!size) continue
    const [w, h] = size

    const scale = Math.min(1, opts.max / Math.max(w, h))
    const targetW = Math.max(1, Math.round(w * scale))
    const targetH = Math.max(1, Math.round(h * scale))
    const needsResize = scale < 1

    const beforeMime = tex.getMimeType()
    const isData = dataTextures.has(tex)
    const targetMime = isData ? MIME_PNG : MIME_WEBP

    if (!needsResize && beforeMime === targetMime) continue

    let pipeline = sharp(img)
    if (needsResize) pipeline = pipeline.resize(targetW, targetH, { kernel: 'lanczos3' })
    const buf = isData
      ? await pipeline.png({ compressionLevel: 9, palette: false }).toBuffer()
      : await pipeline.webp({ quality: opts.quality, effort: 6 }).toBuffer()

    if (!needsResize && buf.length >= img.byteLength) continue

    tex.setImage(new Uint8Array(buf))
    tex.setMimeType(targetMime)
    touched++
    console.log(
      `    tex '${tex.getName() || '(unnamed)'}': ${w}x${h} ${beforeMime} ${fmtMB(img.byteLength)} -> ${targetW}x${targetH} ${targetMime} ${fmtMB(buf.length)}`
    )
  }

  if (touched === 0) {
    console.log(`  no changes: ${filePath}`)
    return { before, after: before, changed: false }
  }

  if (opts.dryRun) {
    console.log(`  [dry-run] would rewrite ${filePath} (${touched} textures changed)`)
    return { before, after: before, changed: false }
  }

  if (!opts.noBackup) await tryBackup(filePath)

  // writeBinary lets us pick our own tmp filename — NodeIO.write switches
  // format on URI suffix, so writing to '<file>.glb.tmp' would emit glTF JSON.
  const tmp = filePath + '.tmp'
  const bin = await io.writeBinary(doc)
  await writeFile(tmp, bin)
  await rename(tmp, filePath)

  const after = Bun.file(filePath).size
  return { before, after, changed: true }
}

async function main() {
  const { pattern, opts } = parseArgs(process.argv.slice(2))

  const glob = new Glob(pattern)
  const files: string[] = []
  for await (const p of glob.scan({ cwd: process.cwd(), absolute: true })) {
    if (p.endsWith('.glb')) files.push(p)
  }

  if (files.length === 0) {
    try {
      const s = await stat(pattern)
      if (s.isFile() && pattern.endsWith('.glb')) files.push(resolve(pattern))
    } catch {}
  }

  if (files.length === 0) {
    console.error(`No .glb files matched: ${pattern}`)
    process.exit(1)
  }

  console.log(`Optimizing ${files.length} GLB(s): max=${opts.max}px, quality=${opts.quality}, dry=${opts.dryRun}`)

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  let totalBefore = 0
  let totalAfter = 0
  let changed = 0
  for (const f of files) {
    console.log(`\n=> ${f.replace(process.cwd() + '/', '')}`)
    try {
      const r = await optimizeOne(io, f, opts)
      totalBefore += r.before
      totalAfter += r.after
      if (r.changed) changed++
      console.log(`  ${fmtMB(r.before)} -> ${fmtMB(r.after)} (${(((r.before - r.after) / r.before) * 100).toFixed(1)}% smaller)`)
    } catch (e) {
      console.error(`  ERROR: ${(e as Error).message}`)
    }
  }

  console.log(`\nTotals: ${fmtMB(totalBefore)} -> ${fmtMB(totalAfter)} across ${files.length} files (${changed} changed)`)
  if (totalBefore > 0) {
    console.log(`Saved ${fmtMB(totalBefore - totalAfter)} (${(((totalBefore - totalAfter) / totalBefore) * 100).toFixed(1)}%)`)
  }
}

main()
