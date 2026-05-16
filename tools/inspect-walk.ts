import { NodeIO } from '@gltf-transform/core';

const path = '/home/nick/projectnova-master/client/public/Character models/new animations/walk.glb';
const io = new NodeIO();
const doc = await io.read(path);
const root = doc.getRoot();

const skins = root.listSkins();
const anims = root.listAnimations();

console.log(`File: ${path}`);
console.log(`Skins: ${skins.length}, Animations: ${anims.length}`);
for (const s of skins) {
  console.log(`  skin "${s.getName()}" joints=${s.listJoints().length}`);
}

for (const a of anims) {
  console.log(`\nAnimation: "${a.getName()}"`);
  const channels = a.listChannels();
  const samplers = a.listSamplers();
  console.log(`  channels: ${channels.length}, samplers: ${samplers.length}`);

  // Determine duration by max input time
  let maxT = 0;
  let minT = Infinity;
  let totalKeys = 0;
  const perBone: Record<string, { paths: Set<string>; keys: number; tStart: number; tEnd: number }> = {};

  for (const c of channels) {
    const tn = c.getTargetNode();
    const path = c.getTargetPath();
    const sampler = c.getSampler();
    if (!tn || !sampler) continue;
    const input = sampler.getInput();
    if (!input) continue;
    const arr = input.getArray() as Float32Array | null;
    if (!arr || arr.length === 0) continue;
    const tA = arr[0];
    const tB = arr[arr.length - 1];
    if (tA < minT) minT = tA;
    if (tB > maxT) maxT = tB;
    totalKeys += arr.length;
    const name = tn.getName() || '(unnamed)';
    if (!perBone[name]) perBone[name] = { paths: new Set(), keys: 0, tStart: Infinity, tEnd: 0 };
    perBone[name].paths.add(path || '?');
    perBone[name].keys += arr.length;
    if (tA < perBone[name].tStart) perBone[name].tStart = tA;
    if (tB > perBone[name].tEnd) perBone[name].tEnd = tB;
  }

  console.log(`  time range: ${minT.toFixed(3)}s -> ${maxT.toFixed(3)}s (duration ${(maxT - minT).toFixed(3)}s)`);
  console.log(`  total keyframes: ${totalKeys}`);
  console.log(`  bones animated: ${Object.keys(perBone).length}`);

  // Highlight bones with very few keys (suspicious — might be only 1-2 keys = static/missing motion)
  const sparse = Object.entries(perBone).filter(([_, v]) => v.keys < 6);
  if (sparse.length) {
    console.log(`  bones with <6 keyframes (suspicious / static):`);
    for (const [n, v] of sparse) console.log(`    ${n}: ${v.keys} keys, paths=${[...v.paths].join(',')}`);
  }

  // Show top bones
  const sorted = Object.entries(perBone).sort((a, b) => b[1].keys - a[1].keys);
  console.log(`  top 10 bones by key count:`);
  for (const [n, v] of sorted.slice(0, 10)) {
    console.log(`    ${n}: ${v.keys} keys, paths=${[...v.paths].join(',')}, t=[${v.tStart.toFixed(2)},${v.tEnd.toFixed(2)}]`);
  }
}

// Loop check: compare first and last keyframe values per channel
for (const a of anims) {
  console.log(`\nLoop seam check for "${a.getName()}":`);
  const channels = a.listChannels();
  let loopable = 0;
  let nonLoop = 0;
  const offenders: { bone: string; path: string; delta: number }[] = [];
  for (const c of channels) {
    const sampler = c.getSampler();
    const tn = c.getTargetNode();
    if (!sampler || !tn) continue;
    const input = sampler.getInput();
    const output = sampler.getOutput();
    if (!input || !output) continue;
    const inA = input.getArray() as Float32Array | null;
    const outA = output.getArray() as Float32Array | null;
    if (!inA || !outA || inA.length < 2) continue;
    const stride = outA.length / inA.length; // components per keyframe
    let delta = 0;
    for (let i = 0; i < stride; i++) {
      const first = outA[i];
      const last = outA[(inA.length - 1) * stride + i];
      delta += Math.abs(first - last);
    }
    if (delta < 0.001) loopable++;
    else {
      nonLoop++;
      offenders.push({ bone: tn.getName() || '?', path: c.getTargetPath() || '?', delta });
    }
  }
  console.log(`  channels with matching first/last (clean loop): ${loopable}`);
  console.log(`  channels with mismatch (seam jump): ${nonLoop}`);
  if (offenders.length) {
    offenders.sort((a, b) => b.delta - a.delta);
    console.log(`  top 10 seam offenders (largest first/last delta):`);
    for (const o of offenders.slice(0, 10)) {
      console.log(`    ${o.bone}.${o.path} delta=${o.delta.toFixed(4)}`);
    }
  }
}
