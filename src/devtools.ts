import { existsSync } from 'node:fs'
import type { Resolver } from '@nuxt/kit'
import type { ViteDevServer } from 'vite'

const DEVTOOLS_UI_ROUTE = '/__nuxt-email-renderer'
const DEVTOOLS_UI_LOCAL_PORT = 3300

export function setupDevToolsUI(nuxt: unknown, resolver: Resolver) {
  const clientPath = resolver.resolve('./client')
  const isProductionBuild = existsSync(clientPath)
  const addHook = (nuxt as { hook: unknown }).hook as (
    name: string,
    callback: (...args: unknown[]) => void | Promise<void>,
  ) => void

  // Serve production-built client (used when package is published)
  if (isProductionBuild) {
    addHook('vite:serverCreated', async (server) => {
      if (!server || typeof server !== 'object') {
        return
      }
      const viteServer = server as ViteDevServer
      const sirv = await import('sirv').then(r => r.default || r)
      viteServer.middlewares.use(
        DEVTOOLS_UI_ROUTE,
        sirv(clientPath, { dev: true, single: true }),
      )
    })
  }
  // In local development, start a separate Nuxt Server and proxy to serve the client
  else {
    addHook('vite:extendConfig', (config) => {
      if (!config || typeof config !== 'object') {
        return
      }
      const writableConfig = config as {
        server?: {
          proxy?: Record<string, {
            target: string
            changeOrigin: boolean
            followRedirects: boolean
            rewrite: (path: string) => string
          }>
        }
      }

      writableConfig.server ||= {}
      writableConfig.server.proxy ||= {}
      writableConfig.server.proxy[DEVTOOLS_UI_ROUTE] = {
        target: 'http://localhost:' + DEVTOOLS_UI_LOCAL_PORT + DEVTOOLS_UI_ROUTE,
        changeOrigin: true,
        followRedirects: true,
        rewrite: path => path.replace(DEVTOOLS_UI_ROUTE, ''),
      }
    })
  }

  addHook('devtools:customTabs', (tabs) => {
    if (!Array.isArray(tabs)) {
      return
    }
    tabs.push({
      // unique identifier
      name: 'nuxt-email-renderer',
      // title to display in the tab
      title: 'Nuxt Email Renderer',
      // any icon from Iconify, or a URL to an image
      icon: 'twemoji:incoming-envelope',
      // iframe view
      view: {
        type: 'iframe',
        src: DEVTOOLS_UI_ROUTE,
      },
    })
  })
}
