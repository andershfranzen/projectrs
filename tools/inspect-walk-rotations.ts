import { NodeIO } from '@gltf-transform/core';

const path = '/home/nick/projectnova-master/client/public/Character models/new animations/walk.glb';
const io = new NodeIO();
const doc = await io.read(path);
const anim = doc.getRoot().listAnimations()[0];

const watch = ['mixamorig:Hips', 'mixamorig:Spine', 'mixamorig:LeftUpLeg', 'mixamorig:RightUpLeg',
               'mixamorig:LeftLeg', 'mixamorig:RightLeg', 'mixamorig:LeftArm', 'mixamorig:RightArm',
               'mixamorig:LeftFoot', 'mixamorig:RightFoot'];

console.log('Rotation amplitudes (max angular deviation from quaternion average, per bone):\n');
for (const c of anim.listChannels()) {
  if (c.getTargetPath() !== 'rotation') continue;
  const tn = c.getTargetNode();
  if (!tn) continue;
  const name = tn.getName();
  if (!watch.includes(name)) continue;
  const out = c.getSampler()?.getOutput()?.getArray() as Float32Array | null;
  if (!out) continue;
  // Iterate quaternion samples (xyzw stride 4)
  // Convert each to euler-ish: extract approximate axis-angle deviation from the first
  const first = [out[0], out[1], out[2], out[3]];
  let maxDot = 1;
  let minDot = 1;
  for (let i = 0; i < out.length; i += 4) {
    const dot = Math.abs(first[0]*out[i] + first[1]*out[i+1] + first[2]*out[i+2] + first[3]*out[i+3]);
    if (dot < minDot) minDot = dot;
  }
  // Angular deviation = 2 * acos(|dot|) gives max angle from first sample
  const maxAngleRad = 2 * Math.acos(Math.min(1, minDot));
  const maxAngleDeg = maxAngleRad * 180 / Math.PI;
  console.log(`  ${name.padEnd(28)} max angular swing from first frame: ${maxAngleDeg.toFixed(1)}°`);
}
