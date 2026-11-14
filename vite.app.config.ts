// Build of the UI that ships inside the desktop app (dist-app). Only the code and a few small
// files are bundled; catalog, LUTs, gallery and samples stay on the server (3 GB+).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { defineConfig, type Plugin } from 'vite'

const BUNDLED_PUBLIC = ['favicon.svg', 'fonts']
/** Data server for the packaged app. The dev server serves public/ itself, so it uses same-origin paths. */
const SERVER = 'https://sosang.film-lab-jc.workers.dev'

function bundledPublic(): Plugin {
  const files = (path: string): string[] => {
    const full = join('public', path)
    try {
      return readdirSync(full, { withFileTypes: true }).flatMap(e => files(join(path, e.name)))
    } catch {
      return [path]
    }
  }
  return {
    name: 'sosang-bundled-public',
    apply: 'build',
    generateBundle() {
      for (const file of BUNDLED_PUBLIC.flatMap(files)) {
        this.emitFile({ type: 'asset', fileName: file, source: readFileSync(join('public', file)) })
      }
    },
  }
}

export default defineConfig(({ command }) => ({
  // The dev server may serve all of public/; the app build copies only BUNDLED_PUBLIC.
  publicDir: command === 'serve' ? 'public' : false,
  build: { outDir: 'dist-app', emptyOutDir: true },
  server: { host: '127.0.0.1', port: 5174, strictPort: true },
  define: { __SOSANG_SERVER__: JSON.stringify(command === 'serve' ? '' : SERVER) },
  plugins: [bundledPublic()],
}))
