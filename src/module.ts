import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import {
  logger,
  defineNuxtModule,
  createResolver,
  addServerHandler,
  addTypeTemplate,
  addServerImports,
  hasNuxtModule,
} from '@nuxt/kit'
import { existsSync } from 'node:fs'
import { defu } from 'defu'
import vue from '@vitejs/plugin-vue'
import { setupDevToolsUI } from './devtools'
import {
  generateTemplateMapping,
  generateVirtualModule,
} from './runtime/server/utils/virtual-templates'

export interface ModuleOptions {
  /**
   * Folder where email templates are stored. Can be either an absolute path or relative to the project root.
   *
   * @default /emails
   */
  emailsDir: string
  /**
   * Enable Nuxt Devtools integration
   *
   * @default true
   */
  devtools: boolean
}

const LOGGER_PREFIX = 'Nuxt Email Renderer:'
const DEFAULT_EMAILS_DIR = '/emails'

interface NuxtI18nOptions {
  defaultLocale?: string
  locale?: string
  locales?: unknown[]
  vueI18n?: string | Record<string, unknown>
}

interface NitroConfigLike {
  virtual?: Record<string, string>
  alias?: Record<string, string>
  rollupConfig?: {
    plugins?: unknown[]
    external?: string[] | unknown[]
  }
  devStorage?: Record<string, {
    driver: string
    base: string
  }>
}

type LayerInfo = {
  cwd: string
}

export default defineNuxtModule<ModuleOptions>({
  meta: {
    name: 'nuxt-email-renderer',
    configKey: 'nuxtEmailRenderer',
  },
  // Default configuration options of the Nuxt module
  defaults() {
    return {
      emailsDir: DEFAULT_EMAILS_DIR,
      devtools: true,
    }
  },
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)
    const { resolve } = resolver
    const addNuxtHook = nuxt.hooks.hook as unknown as (
      name: string,
      callback: (...args: unknown[]) => void | Promise<void>,
    ) => void
    const nuxtOptions = nuxt.options as typeof nuxt.options & {
      nitro: Record<string, unknown>
    }

    // Configure Nitro
    nuxtOptions.nitro ||= {}

    // Configure esbuild for TypeScript support
    const nitroEsbuild = ((nuxtOptions.nitro.esbuild as Record<string, unknown>) || {})
    nuxtOptions.nitro.esbuild = nitroEsbuild
    const nitroEsbuildOptions = ((nitroEsbuild.options as Record<string, unknown>) || {})
    nitroEsbuild.options = nitroEsbuildOptions
    nitroEsbuildOptions.target = nitroEsbuildOptions.target || 'es2020'

    nuxt.options.runtimeConfig.public.nuxtEmailRenderer = defu(
      nuxt.options.runtimeConfig.public.nuxtEmailRenderer as ModuleOptions,
      options,
    )

    // Check if @nuxtjs/i18n module is installed and configure i18n support
    addNuxtHook('nitro:config', async () => {
      if (!hasNuxtModule('@nuxtjs/i18n')) {
        return
      }

      const i18nOptions = (nuxt.options as { i18n?: NuxtI18nOptions }).i18n
      if (!i18nOptions) {
        return
      }

      const publicI18n = getObject(
        nuxt.options.runtimeConfig.public.i18n,
      )

      let messages: Record<string, unknown> = {}
      if (typeof i18nOptions.vueI18n === 'string') {
        try {
          const configPath = resolvePath(nuxt.options.rootDir, i18nOptions.vueI18n)
          const { pathToFileURL } = await import('node:url')
          const configModule = await import(pathToFileURL(configPath).href)
          const configResult
            = typeof configModule.default === 'function'
              ? configModule.default()
              : configModule.default
          messages = getObject(getObject(configResult).messages)
          logger.success(
            `${LOGGER_PREFIX} Loaded i18n messages for ${Object.keys(messages).length} locale(s)`,
          )
        }
        catch (error) {
          logger.warn(
            `${LOGGER_PREFIX} Could not load i18n messages from config file: ${error}`,
          )
        }
      }
      else if (isObject(i18nOptions.vueI18n)) {
        messages = getObject(i18nOptions.vueI18n.messages)
      }

      const defaultLocale = i18nOptions.defaultLocale || i18nOptions.locale || 'en'
      nuxt.options.runtimeConfig.public.i18n = defu(publicI18n, {
        defaultLocale,
        locales: i18nOptions.locales || [],
        messages,
        vueI18n: isObject(i18nOptions.vueI18n) ? i18nOptions.vueI18n : {},
      })

      logger.info(
        `${LOGGER_PREFIX} i18n support enabled with default locale: ${defaultLocale}`,
      )
    })

    const templatesDir = resolveTemplatesDir(
      nuxt.options.rootDir,
      nuxt.options._layers,
      options.emailsDir,
    )
    const runtimeEmailConfig
      = nuxt.options.runtimeConfig.public.nuxtEmailRenderer as ModuleOptions
    runtimeEmailConfig.emailsDir = templatesDir

    // Inline runtime in Nitro bundle
    // Let Nuxt/Nitro handle Vue dependencies to avoid conflicts with other modules
    nuxtOptions.nitro.externals = defu(
      typeof nuxtOptions.nitro.externals === 'object'
        ? nuxtOptions.nitro.externals
        : {},
      {
        inline: [resolve('./runtime')],
      },
    )

    addServerImports([
      {
        name: 'renderEmailComponent',
        from: resolver.resolve('runtime/server/utils/render'),
      },
    ])

    // Generate virtual module containing all email templates
    addNuxtHook('nitro:config', async (nitroConfig) => {
      const nitroConfigTyped = nitroConfig as NitroConfigLike
      try {
        // Scan templates directory and generate virtual module
        const templateMapping = await generateTemplateMapping(templatesDir)
        const virtualModuleContent = generateVirtualModule(templateMapping)

        // Add virtual module to Nitro
        nitroConfigTyped.virtual = nitroConfigTyped.virtual || {}
        nitroConfigTyped.virtual['#email-templates'] = virtualModuleContent

        // Create alias for the virtual module
        nitroConfigTyped.alias = nitroConfigTyped.alias || {}
        nitroConfigTyped.alias['#email-templates'] = 'virtual:#email-templates'

        // Configure Vue plugin for Nitro server build
        // We need Vue compilation for email templates in the server bundle
        nitroConfigTyped.rollupConfig = nitroConfigTyped.rollupConfig || {}
        nitroConfigTyped.rollupConfig.plugins
          = nitroConfigTyped.rollupConfig.plugins || []

        // Mark vue-i18n as external to avoid build errors when it's not installed
        // It's dynamically imported only when needed
        nitroConfigTyped.rollupConfig.external
          = nitroConfigTyped.rollupConfig.external || []
        if (Array.isArray(nitroConfigTyped.rollupConfig.external)) {
          nitroConfigTyped.rollupConfig.external.push('vue-i18n')
        }

        // Add Vue plugin with strict include pattern
        // Use array format to be very explicit about what to include
        const vuePlugin = vue({
          include: '**/*.vue', // Only .vue files, nothing else
          isProduction: !nuxt.options.dev,
          script: {
            defineModel: true,
            propsDestructure: true,
          },
          template: {
            compilerOptions: {
              // Preserve whitespace for email client compatibility
              whitespace: 'preserve',
            },
          },
        })

        if (Array.isArray(nitroConfigTyped.rollupConfig.plugins)) {
          nitroConfigTyped.rollupConfig.plugins.unshift(vuePlugin as never)
        }
        else {
          nitroConfigTyped.rollupConfig.plugins = [vuePlugin as never]
        }

        logger.success(
          `${LOGGER_PREFIX} Generated virtual module with ${
            Object.keys(templateMapping).length
          } email template(s)`,
        )
      }
      catch (error) {
        logger.error(
          `${LOGGER_PREFIX} Failed to generate virtual module`,
          error,
        )
      }
    })

    // Enable HMR for email templates in development mode
    if (nuxt.options.dev) {
      // Watch templates directory for changes
      nuxt.options.watch = nuxt.options.watch || []
      nuxt.options.watch.push(`${templatesDir}/**/*.vue`)

      addNuxtHook('builder:watch', async (event, path) => {
        if (typeof event !== 'string' || typeof path !== 'string') {
          return
        }
        if (path.startsWith(templatesDir) && path.endsWith('.vue')) {
          logger.info(`${LOGGER_PREFIX} Template ${event} - ${path}`)
          logger.info(`${LOGGER_PREFIX} Server will restart to apply changes`)
        }
      })

      // Configure Nitro dev storage for the templates directory
      addNuxtHook('nitro:config', (nitroConfig) => {
        const nitroConfigTyped = nitroConfig as NitroConfigLike
        nitroConfigTyped.devStorage = nitroConfigTyped.devStorage || {}
        nitroConfigTyped.devStorage['emails'] = {
          driver: 'fs',
          base: templatesDir,
        }
      })
    }

    // Add templates directory as Nitro server asset
    nuxtOptions.nitro.serverAssets = (nuxtOptions.nitro.serverAssets as Array<Record<string, unknown>>) || []
    ;(nuxtOptions.nitro.serverAssets as Array<Record<string, unknown>>).push({
      baseName: 'emails',
      dir: templatesDir,
    })

    // Add server handlers for DevTools integration (development only)
    // These endpoints are only registered when the consuming app is in development mode
    // In production, developers should use the renderEmailComponent function directly
    if (nuxt.options.dev) {
      logger.info(`${LOGGER_PREFIX} Registering dev-only API endpoints`)

      addServerHandler({
        route: '/api/emails/render',
        handler: resolve('./runtime/server/api/emails/render.post'),
      })

      addServerHandler({
        route: '/api/emails/source',
        handler: resolve('./runtime/server/api/emails/source.post'),
      })

      addServerHandler({
        route: '/api/emails',
        handler: resolve('./runtime/server/api/emails/index.get'),
      })
    }

    // Add email component type declarations for auto-completion in email templates
    // Note: We use generic Component types instead of importing actual component files
    // to avoid bundling server-only components (and their heavy dependencies like shiki, marked)
    // into the client bundle.
    addTypeTemplate({
      filename: 'types/nuxt-email-renderer-components.d.ts',
      getContents: async () => {
        // Dynamically import the emailComponents to get the component list
        const { emailComponents } = await import('./runtime/components/index')
        const componentNames = Object.keys(emailComponents)

        // Generate type declarations for each component
        // Use DefineComponent generic type instead of importing actual files
        const generateComponentTypes = (names: string[]) => {
          return names
            .map((name) => {
              return `    ${name}: import('vue').DefineComponent<{}, {}, any>`
            })
            .join('\n')
        }

        const componentTypes = generateComponentTypes(componentNames)

        return `
// Auto-generated email component types for nuxt-email-renderer
// This file is automatically generated based on the components in emailComponents.
// Do not edit this file manually - it will be regenerated on every build.
// To add new components, add them to src/runtime/components/index.ts
//
// Note: These components use generic Vue component types to prevent bundling
// server-only dependencies (shiki, marked) into the client bundle.
// Email components are only used server-side for email rendering.
declare module '@vue/runtime-core' {
  export interface GlobalComponents {
${componentTypes}
  }
}

declare module 'vue' {
  export interface GlobalComponents {
${componentTypes}
  }
}

export {}
`
      },
    })

    if (options.devtools) setupDevToolsUI(nuxt, resolver)
  },
})

function resolveTemplatesDir(
  rootDir: string,
  layers: readonly LayerInfo[],
  configuredDir: string,
): string {
  const configuredPath = resolveConfiguredEmailsDir(rootDir, configuredDir)
  if (configuredDir !== DEFAULT_EMAILS_DIR) {
    return configuredPath
  }

  const autoDetectedDir = detectLayerEmailsDir(layers)
  return autoDetectedDir || configuredPath
}

function resolveConfiguredEmailsDir(rootDir: string, dir: string): string {
  if (dir === DEFAULT_EMAILS_DIR) {
    return join(rootDir, 'emails')
  }
  if (isAbsolute(dir)) {
    return dir
  }
  return resolvePath(rootDir, dir)
}

function detectLayerEmailsDir(layers: readonly LayerInfo[]): string | undefined {
  for (const layer of layers) {
    const appEmailsPath = join(layer.cwd, 'app', 'emails')
    if (existsSync(appEmailsPath)) {
      return appEmailsPath
    }

    const rootEmailsPath = join(layer.cwd, 'emails')
    if (existsSync(rootEmailsPath)) {
      return rootEmailsPath
    }
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function getObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {}
}
