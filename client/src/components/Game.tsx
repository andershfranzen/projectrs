import { useEffect, useRef } from 'react';
import { Game } from '../game/Game';

export const GameComponent = () => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const gameRef = useRef<Game | null>(null);

  useEffect(() => {
    if (!canvasRef.current) return;

    // Initialize game
    gameRef.current = new Game(canvasRef.current);

    // Cleanup
    return () => {
      if (gameRef.current) {
        gameRef.current.dispose();
      }
    };
  }, []);

  return (
    <div className="w-full h-full">
      <canvas
        ref={canvasRef}
        className="w-full h-full"
        style={{ touchAction: 'none' }}
      />
    </div>
  );
}; 