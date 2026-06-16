import { defineConfig } from 'vite';
import { resolve } from 'path';

// Babylon.js fetches missing shader includes (*.fx) via HTTP as a fallback.
// Vite's SPA fallback returns index.html (200) for any unknown path, which
// Babylon then splices into the shader source → `<!DOCTYPE html>` triggers a
// `<` GLSL syntax error and all PBR materials fail to compile. Intercept
// shader-include requests with a real 404 so Babylon falls back to its
// bundled shader store instead of treating HTML as shader code.
const shaderFallback404 = {
  name: 'shader-fallback-404',
  configureServer(server: any) {
    server.middlewares.use((req: any, res: any, next: any) => {
      const url = req.url || '';
      if (/\.(fx|glsl|vert|frag)(\?|$)/.test(url)) {
        res.statusCode = 404;
        res.end();
        return;
      }
      next();
    });
  },
};

export default defineConfig(({ command, mode }) => {
  const isProductionBuild = command === 'build' && mode === 'production';

  return {
    plugins: [shaderFallback404],
    resolve: {
      alias: {
        '@projectrs/shared': resolve(__dirname, '../shared'),
      },
    },
    optimizeDeps: {
      exclude: ['@babylonjs/core', '@babylonjs/gui', '@babylonjs/loaders'],
    },
    esbuild: {
      drop: isProductionBuild ? ['console', 'debugger'] : [],
      legalComments: 'none',
    },
    build: {
      outDir: 'dist',
      sourcemap: false,
      // Anything above the bundler's default 500 KB warning. Babylon's core
      // bundle by itself is ~1.5 MB after minification — we already split it
      // out via manualChunks so it caches independently of game code, but
      // there's no point spamming the build log about it.
      chunkSizeWarningLimit: 2000,
      rollupOptions: {
        output: {
          // Hand-grouped vendor chunks so a code change in the game doesn't
          // bust Babylon's cache, and so the (large) glTF loader is its own
          // chunk that can be fetched in parallel with the engine.
          manualChunks(id: string) {
            if (id.replace(/\\/g, '/').endsWith('/client/src/ui/AdminPanel.ts')) return 'admin-panel';
            if (id.includes('node_modules/@babylonjs/loaders')) return 'babylon-loaders';
            if (id.includes('node_modules/@babylonjs/gui')) return 'babylon-gui';
            if (id.includes('node_modules/@babylonjs/core')) return 'babylon-core';
          },
        },
      },
    },
    server: {
      proxy: {
        '/api': {
          target: 'http://localhost:4000',
        },
        '/maps': {
          target: 'http://localhost:4000',
        },
        '/data': {
          target: 'http://localhost:4000',
        },
        '/assets': {
          target: 'http://localhost:4000',
        },
      },
    },
  };
});
