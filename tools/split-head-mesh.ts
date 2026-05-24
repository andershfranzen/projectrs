/**
 * Split the character GLB's Skin mesh into HeadSkin + BodySkin
 * based on bone weights (Head/Neck bones).
 *
 * Usage: bun tools/split-head-mesh.ts
 */
import { NodeIO } from '@gltf-transform/core';
import { resolve } from 'path';

const CHARACTER_GLB = resolve(import.meta.dir, '../client/public/Character models/main character.glb');
const HEAD_BONES = ['mixamorig:Head', 'mixamorig:Neck'];
const WEIGHT_THRESHOLD = 0.3;

async function main() {
  const io = new NodeIO();
  const doc = await io.read(CHARACTER_GLB);
  const root = doc.getRoot();

  // Find the skin to get joint list
  const skin = root.listSkins()[0];
  if (!skin) throw new Error('No skin found');
  const joints = skin.listJoints();
  const headBoneIndices = new Set<number>();
  joints.forEach((j, i) => {
    if (HEAD_BONES.includes(j.getName())) headBoneIndices.add(i);
  });
  console.log(`Head bone indices: ${[...headBoneIndices].join(', ')}`);

  // Find the Skin mesh node (the one with "Skin" material or the largest primitive)
  let skinNode: any = null;
  let skinPrim: any = null;
  for (const node of root.listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    for (const prim of mesh.listPrimitives()) {
      const mat = prim.getMaterial();
      if (mat?.getName()?.includes('Skin')) {
        skinNode = node;
        skinPrim = prim;
        break;
      }
    }
    if (skinPrim) break;
  }

  if (!skinPrim) throw new Error('No Skin primitive found');
  console.log(`Found Skin primitive with material: ${skinPrim.getMaterial()?.getName()}`);

  // Get vertex data
  const posAccessor = skinPrim.getAttribute('POSITION');
  const jointsAccessor = skinPrim.getAttribute('JOINTS_0');
  const weightsAccessor = skinPrim.getAttribute('WEIGHTS_0');
  const indicesAccessor = skinPrim.getIndices();

  if (!posAccessor || !jointsAccessor || !weightsAccessor || !indicesAccessor) {
    throw new Error('Missing required attributes');
  }

  const vertCount = posAccessor.getCount();
  const indexCount = indicesAccessor.getCount();
  console.log(`Vertices: ${vertCount}, Triangles: ${indexCount / 3}`);

  // Classify each vertex as head or body
  const isHeadVertex = new Uint8Array(vertCount);
  for (let v = 0; v < vertCount; v++) {
    const j = jointsAccessor.getElement(v, [0, 0, 0, 0]);
    const w = weightsAccessor.getElement(v, [0, 0, 0, 0]);
    for (let i = 0; i < 4; i++) {
      if (headBoneIndices.has(j[i]) && w[i] > WEIGHT_THRESHOLD) {
        isHeadVertex[v] = 1;
        break;
      }
    }
  }

  const headVertCount = isHeadVertex.reduce((a, b) => a + b, 0);
  console.log(`Head vertices: ${headVertCount}, Body vertices: ${vertCount - headVertCount}`);

  // Classify triangles: a triangle is "head" if ALL 3 vertices are head
  const headTriIndices: number[] = [];
  const bodyTriIndices: number[] = [];
  for (let t = 0; t < indexCount; t += 3) {
    const i0 = indicesAccessor.getScalar(t);
    const i1 = indicesAccessor.getScalar(t + 1);
    const i2 = indicesAccessor.getScalar(t + 2);
    if (isHeadVertex[i0] && isHeadVertex[i1] && isHeadVertex[i2]) {
      headTriIndices.push(i0, i1, i2);
    } else {
      bodyTriIndices.push(i0, i1, i2);
    }
  }
  console.log(`Head triangles: ${headTriIndices.length / 3}, Body triangles: ${bodyTriIndices.length / 3}`);

  // Build remapped vertex buffers for head and body
  function buildSubmesh(triIndices: number[]) {
    const oldToNew = new Map<number, number>();
    const newIndices: number[] = [];
    let nextIdx = 0;

    for (const oldIdx of triIndices) {
      if (!oldToNew.has(oldIdx)) {
        oldToNew.set(oldIdx, nextIdx++);
      }
      newIndices.push(oldToNew.get(oldIdx)!);
    }

    const newVertCount = oldToNew.size;
    const sortedOld = [...oldToNew.entries()].sort((a, b) => a[1] - b[1]).map(e => e[0]);

    // Copy attributes for the remapped vertices
    const attrs: Record<string, { data: number[]; elementSize: number }> = {};
    for (const sem of skinPrim.listSemantics()) {
      const acc = skinPrim.getAttribute(sem);
      if (!acc) continue;
      const elSize = acc.getElementSize();
      const data: number[] = [];
      const tmp = new Array(elSize);
      for (const oldIdx of sortedOld) {
        acc.getElement(oldIdx, tmp);
        data.push(...tmp);
      }
      attrs[sem] = { data, elementSize: elSize };
    }

    return { newIndices, newVertCount, attrs };
  }

  const headData = buildSubmesh(headTriIndices);
  const bodyData = buildSubmesh(bodyTriIndices);

  console.log(`Head submesh: ${headData.newVertCount} verts, ${headData.newIndices.length / 3} tris`);
  console.log(`Body submesh: ${bodyData.newVertCount} verts, ${bodyData.newIndices.length / 3} tris`);

  // Replace the original Skin primitive with body-only, add a new HeadSkin primitive
  const mesh = skinNode.getMesh()!;

  // Helper to create accessor from data
  function makeAccessor(name: string, data: number[], elementSize: number, componentType: 'f32' | 'u8' | 'u16') {
    const acc = doc.createAccessor(name);
    if (componentType === 'u8') {
      acc.setArray(new Uint8Array(data));
    } else if (componentType === 'u16') {
      acc.setArray(new Uint16Array(data));
    } else {
      acc.setArray(new Float32Array(data));
    }
    acc.setType(elementSize === 1 ? 'SCALAR' : elementSize === 2 ? 'VEC2' : elementSize === 3 ? 'VEC3' : 'VEC4');
    return acc;
  }

  function getComponentType(semantic: string): 'f32' | 'u8' | 'u16' {
    if (semantic === 'JOINTS_0') return 'u8';
    return 'f32';
  }

  // Update the existing Skin primitive to be body-only
  for (const sem of Object.keys(bodyData.attrs)) {
    const { data, elementSize } = bodyData.attrs[sem];
    skinPrim.setAttribute(sem, makeAccessor(`body_${sem}`, data, elementSize, getComponentType(sem)));
  }
  skinPrim.setIndices(makeAccessor('body_indices', bodyData.newIndices, 1, 'u16'));

  // Create new HeadSkin primitive
  const headPrim = doc.createPrimitive();
  headPrim.setMaterial(skinPrim.getMaterial());
  for (const sem of Object.keys(headData.attrs)) {
    const { data, elementSize } = headData.attrs[sem];
    headPrim.setAttribute(sem, makeAccessor(`head_${sem}`, data, elementSize, getComponentType(sem)));
  }
  headPrim.setIndices(makeAccessor('head_indices', headData.newIndices, 1, 'u16'));
  mesh.addPrimitive(headPrim);

  // The new primitive will become a new child mesh node named based on the parent
  // We need to identify it at runtime. Let's create a separate mesh node for it.
  // Actually, gltf primitives on the same mesh become sub-meshes in Babylon.
  // Better to create a separate node so we can show/hide independently.

  // Remove the head primitive from the main mesh and put it on a new node
  mesh.removePrimitive(headPrim);

  const headMesh = doc.createMesh('HeadSkin');
  headMesh.addPrimitive(headPrim);

  const headNode = doc.createNode('HeadSkin');
  headNode.setMesh(headMesh);
  headNode.setSkin(skin);

  // Add as sibling of the main character node (under Armature)
  const armatureNode = skinNode.listParents().find((p: any) => p.getName?.() === 'Armature');
  if (armatureNode?.addChild) {
    armatureNode.addChild(headNode);
  } else {
    // Fallback: add to the scene
    const scene = root.listScenes()[0];
    for (const child of scene.listChildren()) {
      if (child.getName() === 'Armature') {
        child.addChild(headNode);
        break;
      }
    }
  }

  // Write back
  const outPath = CHARACTER_GLB;
  await io.write(outPath, doc);
  console.log(`\nWrote: ${outPath}`);
  console.log('Done! HeadSkin node added as sibling to "main character" under Armature.');
}

main().catch(e => { console.error(e); process.exit(1); });
