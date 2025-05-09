import { useEffect, useRef } from 'react';
import {
  Engine,
  Scene,
  ArcRotateCamera,
  Vector3,
  HemisphericLight,
  MeshBuilder,
  StandardMaterial,
  Color3,
} from '@babylonjs/core';

export default function Game() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize BabylonJS
    const engine = new Engine(canvasRef.current, true);
    const scene = new Scene(engine);

    // Create camera
    const camera = new ArcRotateCamera(
      'camera',
      0,
      Math.PI / 3,
      10,
      Vector3.Zero(),
      scene
    );
    camera.attachControl(canvasRef.current, true);

    // Create light
    const light = new HemisphericLight(
      'light',
      new Vector3(0, 1, 0),
      scene
    );

    // Create ground
    const ground = MeshBuilder.CreateGround(
      'ground',
      { width: 20, height: 20 },
      scene
    );
    const groundMaterial = new StandardMaterial('groundMaterial', scene);
    groundMaterial.diffuseColor = new Color3(0.2, 0.5, 0.2);
    ground.material = groundMaterial;

    // Handle window resize
    const handleResize = () => {
      engine.resize();
    };
    window.addEventListener('resize', handleResize);

    // Start render loop
    engine.runRenderLoop(() => {
      scene.render();
    });

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
      engine.dispose();
    };
  }, []);

  return (
    <div className="w-full h-screen">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ outline: 'none' }}
      />
    </div>
  );
} 