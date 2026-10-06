import { bindings, defineConfig, exports } from 'cf/config'

export default defineConfig({
  worker: {
    name: 'envhandoff-relay',
    entrypoint: 'src/index.ts',
    compatibilityDate: '2026-09-11',
    workersDev: false,
    previewUrls: false,
    domains: ['envhandoff.mabyko.com'],
    observability: { enabled: false },
    assets: {
      notFoundHandling: 'single-page-application',
      runWorkerFirst: ['/api/*'],
    },
    exports: {
      RelayRoom: exports.durableObject({ storage: 'sqlite' }),
      RequestLimits: exports.durableObject({ storage: 'sqlite' }),
    },
    env: {
      WEB_ORIGINS: bindings.text(
        'https://envhandoff.mabyko.com,http://localhost:5173,http://127.0.0.1:5173',
      ),
      RELAY: bindings.durableObject({ worker: 'envhandoff-relay', exportName: 'RelayRoom' }),
      REQUEST_LIMITS: bindings.durableObject({
        worker: 'envhandoff-relay',
        exportName: 'RequestLimits',
      }),
    },
  },
})
