'use client';

import { useEffect, useRef } from 'react';

type StaticModelProps = {
  src: string;
  label: string;
};

export function StaticModel({ src, label }: StaticModelProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const fallbackRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    let cancelled = false;
    let cleanup: (() => void) | null = null;

    async function setup() {
      const core = await import('@babylonjs/core');
      await import('@babylonjs/loaders');
      if (cancelled || !canvas) return;

      const engine = new core.Engine(canvas, true, {
        antialias: true,
        preserveDrawingBuffer: true,
        stencil: false,
      });
      const scene = new core.Scene(engine);
      scene.clearColor = new core.Color4(0, 0, 0, 0);

      const camera = new core.ArcRotateCamera(
        'camera',
        -Math.PI / 4,
        Math.PI / 2.8,
        3.3,
        core.Vector3.Zero(),
        scene,
      );
      camera.inputs.clear();

      const light = new core.HemisphericLight('light', new core.Vector3(-0.5, 1, 0.35), scene);
      light.intensity = 1.25;
      const fill = new core.DirectionalLight('fill', new core.Vector3(0.7, -1, -0.5), scene);
      fill.intensity = 0.55;

      const coffinMaterial = new core.StandardMaterial('coffin-material', scene);
      coffinMaterial.diffuseColor = new core.Color3(0.35, 0.13, 0.1);
      coffinMaterial.emissiveColor = new core.Color3(0.16, 0.04, 0.035);
      coffinMaterial.specularColor = new core.Color3(0, 0, 0);
      const trimMaterial = new core.StandardMaterial('coffin-trim-material', scene);
      trimMaterial.diffuseColor = new core.Color3(0.78, 0.56, 0.28);
      trimMaterial.emissiveColor = new core.Color3(0.18, 0.12, 0.04);
      trimMaterial.specularColor = new core.Color3(0, 0, 0);

      const coffin = core.MeshBuilder.CreateBox('coffin', { width: 0.72, height: 1.35, depth: 0.22 }, scene);
      coffin.material = coffinMaterial;
      coffin.rotation.y = -Math.PI / 5;
      coffin.rotation.z = -0.1;
      const crossA = core.MeshBuilder.CreateBox('coffin-cross-a', { width: 0.12, height: 0.68, depth: 0.235 }, scene);
      crossA.material = trimMaterial;
      crossA.parent = coffin;
      crossA.position.z = -0.003;
      const crossB = core.MeshBuilder.CreateBox('coffin-cross-b', { width: 0.42, height: 0.1, depth: 0.24 }, scene);
      crossB.material = trimMaterial;
      crossB.parent = coffin;
      crossB.position.y = 0.08;
      crossB.position.z = -0.006;

      const slash = src.lastIndexOf('/');
      const rootUrl = src.slice(0, slash + 1);
      const fileName = src.slice(slash + 1);
      let result;
      try {
        result = await core.SceneLoader.ImportMeshAsync('', rootUrl, fileName, scene);
      } catch (error) {
        console.warn('[hiscores] static model failed to load', error);
        fallbackRef.current?.classList.add('is-visible');
        scene.dispose();
        engine.dispose();
        return;
      }
      if (cancelled) {
        scene.dispose();
        engine.dispose();
        return;
      }

      const displayMaterial = new core.StandardMaterial('display-material', scene);
      displayMaterial.diffuseColor = new core.Color3(0.56, 0.43, 0.35);
      displayMaterial.emissiveColor = new core.Color3(0.2, 0.12, 0.1);
      displayMaterial.specularColor = new core.Color3(0, 0, 0);

      const meshes = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
      for (const mesh of meshes) {
        mesh.material = displayMaterial;
        mesh.setEnabled(false);
      }
      const min = new core.Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
      const max = new core.Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
      for (const mesh of meshes) {
        const bounds = mesh.getHierarchyBoundingVectors(true);
        min.minimizeInPlace(bounds.min);
        max.maximizeInPlace(bounds.max);
      }
      const center = min.add(max).scale(0.5);
      const size = max.subtract(min);
      for (const mesh of result.meshes) {
        mesh.position.subtractInPlace(center);
      }

      const maxSize = Math.max(size.x, size.y, size.z, 0.001);
      const scale = 2.35 / maxSize;
      for (const mesh of result.meshes) {
        mesh.scaling.scaleInPlace(scale);
        mesh.rotation.y = -Math.PI / 5;
      }
      camera.radius = 2.05;
      camera.target = new core.Vector3(0, 0.1, 0);
      scene.render();

      engine.runRenderLoop(() => scene.render());
      const resize = () => engine.resize();
      window.addEventListener('resize', resize);
      cleanup = () => {
        window.removeEventListener('resize', resize);
        scene.dispose();
        engine.dispose();
      };
    }

    void setup();

    return () => {
      cancelled = true;
      cleanup?.();
    };
  }, [src]);

  return (
    <>
      <canvas ref={canvasRef} className="static-asset-canvas" aria-label={label} role="img" />
      <div ref={fallbackRef} className="static-asset-fallback" aria-hidden="true" />
    </>
  );
}
