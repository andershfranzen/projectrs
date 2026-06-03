/**
 * Lightweight optimizer for skinned NPC GLBs.
 *
 * Usage:
 *   bun tools/optimize-npc-glb.ts <file-or-glob> [--keep-animations=A,B] [--single-sided] [--quantize-colors] [--dry-run] [--no-backup]
 *
 * This intentionally avoids mesh simplification, meshopt, Draco, or position
 * quantization. Those can change compatibility or deformation; this script is
 * for low-risk cleanup after Blender export.
 */
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import { dedup, prune, quantize } from '@gltf-transform/functions'
import { Glob } from 'bun'
import { constants as fsConstants } from 'node:fs'
import { copyFile, rename, stat, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

type Opts = {
  dryRun: boolean
  noBackup: boolean
  singleSided: boolean
  quantizeColors: boolean
  keepAnimations: Set<string> | null
}

function usage(): never {
  console.error('Usage: bun tools/optimize-npc-glb.ts <file-or-glob> [--keep-animations=A,B] [--single-sided] [--quantize-colors] [--dry-run] [--no-backup]')
  process.exit(1)
}

function parseArgs(argv: string[]): { pattern: string; opts: Opts } {
  let pattern: string | undefined
  const opts: Opts = {
    dryRun: false,
    noBackup: false,
    singleSided: false,
    quantizeColors: false,
    keepAnimations: null,
  }

  for (const arg of argv) {
    if (arg === '--dry-run') opts.dryRun = true
    else if (arg === '--no-backup') opts.noBackup = true
    else if (arg === '--single-sided') opts.singleSided = true
    else if (arg === '--quantize-colors') opts.quantizeColors = true
    else if (arg.startsWith('--keep-animations=')) {
      const names = arg.slice('--keep-animations='.length)
        .split(',')
        .map((name) => name.trim())
        .filter(Boolean)
      opts.keepAnimations = new Set(names)
    } else if (!pattern) {
      pattern = arg
    } else {
      usage()
    }
  }

  if (!pattern) usage()
  return { pattern, opts }
}

function fmtKB(bytes: number): string {
  return `${(bytes / 1024).toFixed(1)}KB`
}

async function collectFiles(pattern: string): Promise<string[]> {
  const glob = new Glob(pattern)
  const files: string[] = []
  for await (const path of glob.scan({ cwd: process.cwd(), absolute: true })) {
    if (path.endsWith('.glb')) files.push(path)
  }

  if (files.length === 0) {
    try {
      const s = await stat(pattern)
      if (s.isFile() && pattern.endsWith('.glb')) files.push(resolve(pattern))
    } catch {}
  }

  return files.sort()
}

async function tryBackup(filePath: string): Promise<void> {
  try {
    await copyFile(filePath, `${filePath}.npc-opt.bak`, fsConstants.COPYFILE_EXCL)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }
}

async function optimizeOne(io: NodeIO, filePath: string, opts: Opts): Promise<{ before: number; after: number; changed: boolean }> {
  const before = Bun.file(filePath).size
  const doc = await io.read(filePath)
  const root = doc.getRoot()
  let changed = false

  if (opts.keepAnimations) {
    for (const anim of root.listAnimations()) {
      if (opts.keepAnimations.has(anim.getName())) continue
      console.log(`    drop animation '${anim.getName()}'`)
      anim.dispose()
      changed = true
    }
  }

  if (opts.singleSided) {
    for (const mat of root.listMaterials()) {
      if (!mat.getDoubleSided()) continue
      console.log(`    single-sided material '${mat.getName() || '(unnamed)'}'`)
      mat.setDoubleSided(false)
      changed = true
    }
  }

  await doc.transform(dedup(), prune())

  if (opts.quantizeColors) {
    await doc.transform(quantize({ pattern: /^COLOR_\d+$/i, quantizeColor: 8 }))
    await doc.transform(prune())
    changed = true
  }

  if (!changed) {
    console.log('    no changes')
    return { before, after: before, changed: false }
  }

  if (opts.dryRun) {
    console.log('    dry-run, not writing')
    return { before, after: before, changed: false }
  }

  if (!opts.noBackup) await tryBackup(filePath)
  const tmp = `${filePath}.tmp`
  const bin = await io.writeBinary(doc)
  await writeFile(tmp, bin)
  await rename(tmp, filePath)

  return { before, after: Bun.file(filePath).size, changed: true }
}

async function main(): Promise<void> {
  const { pattern, opts } = parseArgs(process.argv.slice(2))
  const files = await collectFiles(pattern)
  if (files.length === 0) {
    console.error(`No .glb files matched: ${pattern}`)
    process.exit(1)
  }

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS)
  let totalBefore = 0
  let totalAfter = 0
  let changedCount = 0

  for (const file of files) {
    console.log(`=> ${file.replace(`${process.cwd()}/`, '')}`)
    const result = await optimizeOne(io, file, opts)
    totalBefore += result.before
    totalAfter += result.after
    if (result.changed) changedCount++
    console.log(`    ${fmtKB(result.before)} -> ${fmtKB(result.after)}`)
  }

  console.log(`Optimized ${changedCount}/${files.length}: ${fmtKB(totalBefore)} -> ${fmtKB(totalAfter)}`)
}

main()
