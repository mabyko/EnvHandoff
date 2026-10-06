import { defineWranglerConfig } from 'wrangler/experimental-config'

export default defineWranglerConfig({
  sendMetrics: false,
  types: { generate: false },
  assetsDirectory: '../web/dist',
})
