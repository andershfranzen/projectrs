import { defineConfig } from 'vite'
import { resolve } from 'path'

export default defineConfig({
  // Editor reuses CharacterEntity from the client package to render NPC
  // appearance previews. Aliased so `import '@client/rendering/CharacterEntity'`
  // resolves without copying or publishing the file.
  resolve: {
    alias: {
      '@client': resolve(__dirname, '../client/src'),
    },
  },
  server: {
    proxy: {
      '/api': 'http://localhost:4000',
      '/data': 'http://localhost:4000',
      '/assets': 'http://localhost:4000',
      '/worldsave': 'http://localhost:4000',
      // Character GLB + Mixamo animations live in client/public; proxy to the
      // client's vite dev server (:5173) so the editor's appearance preview
      // can load them without a symlink. Cross-platform safe.
      '/Character models': 'http://localhost:5173',
    }
  }
})
