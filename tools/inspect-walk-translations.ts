import { NodeIO } from '@gltf-transform/core';

const path = '/home/nick/projectnova-master/client/public/Character models/new animations/walk.glb';
const io = new NodeIO();
const doc = await io.read(path);
const root = doc.getRoot();

const anim = root.listAnimations()[0];
console.log(`\nTranslation tracks (animated bones with translation channel):`);
for (const c of anim.listChannels()) {
  if (c.getTargetPath() !== 'translation') continue;
  const tn = c.getTargetNode();
  if (!tn) continue;
  const sampler = c.getSampler();
  const out = sampler?.getOutput()?.getArray() as Float32Array | null;
  if (!out) continue;
  // Compute amplitude (max - min) per axis
  let xMin = Infinity, xMax = -Infinity, yMin = Infinity, yMax = -Infinity, zMin = Infinity, zMax = -Infinity;
  for (let i = 0; i < out.length; i += 3) {
    if (out[i] < xMin) xMin = out[i]; if (out[i] > xMax) xMax = out[i];
    if (out[i+1] < yMin) yMin = out[i+1]; if (out[i+1] > yMax) yMax = out[i+1];
    if (out[i+2] < zMin) zMin = out[i+2]; if (out[i+2] > zMax) zMax = out[i+2];
  }
  const amp = { x: xMax - xMin, y: yMax - yMin, z: zMax - zMin };
  if (amp.x > 0.001 || amp.y > 0.001 || amp.z > 0.001) {
    console.log(`  ${tn.getName()}: amp=(${amp.x.toFixed(3)}, ${amp.y.toFixed(3)}, ${amp.z.toFixed(3)})`);
  }
}
