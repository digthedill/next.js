import type {
  Endpoint,
  Route,
  TurbopackResult,
  WrittenEndpoint,
  Issue,
  StyledString,
} from '../../build/swc'
import type { Socket } from 'net'
import type { OutputState } from '../../build/output/store'
import type { BuildManifest } from '../get-page-files'
import type { PagesManifest } from '../../build/webpack/plugins/pages-manifest-plugin'
import type { AppBuildManifest } from '../../build/webpack/plugins/app-build-manifest-plugin'
import type {
  CompilationError,
  HMR_ACTION_TYPES,
  NextJsHotReloaderInterface,
  ReloadPageAction,
  SyncAction,
  TurbopackConnectedAction,
} from './hot-reloader-types'

import ws from 'next/dist/compiled/ws'
import { createDefineEnv } from '../../build/swc'
import { join, posix } from 'path'
import * as Log from '../../build/output/log'
import {
  getVersionInfo,
  matchNextPageBundleRequest,
} from './hot-reloader-webpack'
import { isInterceptionRouteRewrite } from '../../lib/generate-interception-routes-rewrites'
import { store as consoleStore } from '../../build/output/store'

import {
  APP_BUILD_MANIFEST,
  APP_PATHS_MANIFEST,
  BUILD_MANIFEST,
  MIDDLEWARE_MANIFEST,
  NEXT_FONT_MANIFEST,
  PAGES_MANIFEST,
  SERVER_REFERENCE_MANIFEST,
  REACT_LOADABLE_MANIFEST,
  MIDDLEWARE_REACT_LOADABLE_MANIFEST,
  MIDDLEWARE_BUILD_MANIFEST,
  INTERCEPTION_ROUTE_REWRITE_MANIFEST,
  BLOCKED_PAGES,
} from '../../shared/lib/constants'
import { getOverlayMiddleware } from 'next/dist/compiled/@next/react-dev-overlay/dist/middleware-turbopack'
import { mkdir, readFile, writeFile } from 'fs/promises'
import { PageNotFoundError } from '../../shared/lib/utils'
import {
  type ClientBuildManifest,
  normalizeRewritesForBuildManifest,
  srcEmptySsgManifest,
} from '../../build/webpack/plugins/build-manifest-plugin'
import { HMR_ACTIONS_SENT_TO_BROWSER } from './hot-reloader-types'
import type { Update as TurbopackUpdate } from '../../build/swc'
import { debounce } from '../utils'
import {
  deleteAppClientCache,
  deleteCache,
} from '../../build/webpack/plugins/nextjs-require-cache-hot-reloader'
import {
  clearModuleContext,
  clearAllModuleContexts,
} from '../lib/render-server'
import type { ActionManifest } from '../../build/webpack/plugins/flight-client-entry-plugin'
import { denormalizePagePath } from '../../shared/lib/page-path/denormalize-page-path'
import type { LoadableManifest } from '../load-components'
import { bold, green, magenta, red } from '../../lib/picocolors'
import { writeFileAtomic } from '../../lib/fs/write-atomic'
import { trace } from '../../trace'
import type { VersionInfo } from './parse-version-info'
import type { NextFontManifest } from '../../build/webpack/plugins/next-font-manifest-plugin'
import {
  MAGIC_IDENTIFIER_REGEX,
  decodeMagicIdentifier,
} from '../../shared/lib/magic-identifier'
import {
  getTurbopackJsConfig,
  mergeActionManifests,
  mergeAppBuildManifests,
  mergeBuildManifests,
  mergeFontManifests,
  mergeLoadableManifests,
  mergeMiddlewareManifests,
  mergePagesManifests,
  type TurbopackMiddlewareManifest,
} from './turbopack-utils'
import {
  propagateServerField,
  type ServerFields,
  type SetupOpts,
} from '../lib/router-utils/setup-dev-bundler'
import getAssetPathFromRoute from '../../shared/lib/router/utils/get-asset-path-from-route'
import { findPagePathData } from './on-demand-entry-handler'
import type { RouteDefinition } from '../future/route-definitions/route-definition'

const MILLISECONDS_IN_NANOSECOND = 1_000_000
const wsServer = new ws.Server({ noServer: true })
const isTestMode = !!(
  process.env.NEXT_TEST_MODE ||
  process.env.__NEXT_TEST_MODE ||
  process.env.DEBUG
)

class ModuleBuildError extends Error {}

function issueKey(issue: Issue): string {
  return [
    issue.severity,
    issue.filePath,
    JSON.stringify(issue.title),
    JSON.stringify(issue.description),
  ].join('-')
}

function formatIssue(issue: Issue) {
  const { filePath, title, description, source } = issue
  let { documentationLink } = issue
  let formattedTitle = renderStyledStringToErrorAnsi(title).replace(
    /\n/g,
    '\n    '
  )

  // TODO: Use error codes to identify these
  // TODO: Generalize adapting Turbopack errors to Next.js errors
  if (formattedTitle.includes('Module not found')) {
    // For compatiblity with webpack
    // TODO: include columns in webpack errors.
    documentationLink = 'https://nextjs.org/docs/messages/module-not-found'
  }

  let formattedFilePath = filePath
    .replace('[project]/', './')
    .replaceAll('/./', '/')
    .replace('\\\\?\\', '')

  let message

  if (source && source.range) {
    const { start } = source.range
    message = `${formattedFilePath}:${start.line + 1}:${
      start.column + 1
    }\n${formattedTitle}`
  } else if (formattedFilePath) {
    message = `${formattedFilePath}\n${formattedTitle}`
  } else {
    message = formattedTitle
  }
  message += '\n'

  if (source?.range && source.source.content) {
    const { start, end } = source.range
    const { codeFrameColumns } = require('next/dist/compiled/babel/code-frame')

    message +=
      codeFrameColumns(
        source.source.content,
        {
          start: {
            line: start.line + 1,
            column: start.column + 1,
          },
          end: {
            line: end.line + 1,
            column: end.column + 1,
          },
        },
        { forceColor: true }
      ).trim() + '\n\n'
  }

  if (description) {
    message += renderStyledStringToErrorAnsi(description) + '\n\n'
  }

  // TODO: make it possible to enable this for debugging, but not in tests.
  // if (detail) {
  //   message += renderStyledStringToErrorAnsi(detail) + '\n\n'
  // }

  // TODO: Include a trace from the issue.

  if (documentationLink) {
    message += documentationLink + '\n\n'
  }

  return message
}

type Issues = Map<string, Map<string, Issue>>

function processIssues(
  issues: Issues,
  name: string,
  result: TurbopackResult,
  throwIssue = false
) {
  const newIssues = new Map<string, Issue>()
  issues.set(name, newIssues)

  const relevantIssues = new Set()

  for (const issue of result.issues) {
    if (issue.severity !== 'error' && issue.severity !== 'fatal') continue
    const key = issueKey(issue)
    const formatted = formatIssue(issue)
    newIssues.set(key, issue)

    // We show errors in node_modules to the console, but don't throw for them
    if (/(^|\/)node_modules(\/|$)/.test(issue.filePath)) continue
    relevantIssues.add(formatted)
  }

  if (relevantIssues.size && throwIssue) {
    throw new ModuleBuildError([...relevantIssues].join('\n\n'))
  }
}

export async function createHotReloaderTurbopack(
  opts: SetupOpts,
  serverFields: ServerFields,
  distDir: string
): Promise<NextJsHotReloaderInterface> {
  const { nextConfig, dir } = opts

  const { loadBindings } =
    require('../../build/swc') as typeof import('../../build/swc')

  let bindings = await loadBindings()

  // For the debugging purpose, check if createNext or equivalent next instance setup in test cases
  // works correctly. Normally `run-test` hides output so only will be visible when `--debug` flag is used.
  if (process.env.TURBOPACK && isTestMode) {
    require('console').log('Creating turbopack project', {
      dir,
      testMode: isTestMode,
    })
  }

  const hasRewrites =
    opts.fsChecker.rewrites.afterFiles.length > 0 ||
    opts.fsChecker.rewrites.beforeFiles.length > 0 ||
    opts.fsChecker.rewrites.fallback.length > 0

  const hotReloaderSpan = trace('hot-reloader', undefined, {
    version: process.env.__NEXT_VERSION as string,
  })
  // Ensure the hotReloaderSpan is flushed immediately as it's the parentSpan for all processing
  // of the current `next dev` invocation.
  hotReloaderSpan.stop()

  const project = await bindings.turbo.createProject({
    projectPath: dir,
    rootPath: opts.nextConfig.experimental.outputFileTracingRoot || dir,
    nextConfig: opts.nextConfig,
    jsConfig: await getTurbopackJsConfig(dir, nextConfig),
    watch: true,
    env: process.env as Record<string, string>,
    defineEnv: createDefineEnv({
      isTurbopack: true,
      allowedRevalidateHeaderKeys: undefined,
      clientRouterFilters: undefined,
      config: nextConfig,
      dev: true,
      distDir,
      fetchCacheKeyPrefix: undefined,
      hasRewrites,
      middlewareMatchers: undefined,
      previewModeId: undefined,
    }),
    serverAddr: `127.0.0.1:${opts.port}`,
  })
  const iter = project.entrypointsSubscribe()

  // pathname -> route
  const curEntries: Map<string, Route> = new Map()
  // originalName / page -> route
  const curAppEntries: Map<string, Route> = new Map()

  const changeSubscriptions: Map<
    string,
    Promise<AsyncIterator<any>>
  > = new Map()
  let prevMiddleware: boolean | undefined = undefined
  const globalEntries: {
    app: Endpoint | undefined
    document: Endpoint | undefined
    error: Endpoint | undefined
  } = {
    app: undefined,
    document: undefined,
    error: undefined,
  }
  let currentEntriesHandlingResolve: ((value?: unknown) => void) | undefined
  let currentEntriesHandling = new Promise(
    (resolve) => (currentEntriesHandlingResolve = resolve)
  )
  const hmrPayloads = new Map<string, HMR_ACTION_TYPES>()
  const turbopackUpdates: TurbopackUpdate[] = []

  const issues: Issues = new Map()
  const serverPathState = new Map<string, string>()

  async function handleRequireCacheClearing(
    id: string,
    result: TurbopackResult<WrittenEndpoint>
  ): Promise<TurbopackResult<WrittenEndpoint>> {
    // Figure out if the server files have changed
    let hasChange = false
    for (const { path, contentHash } of result.serverPaths) {
      // We ignore source maps
      if (path.endsWith('.map')) continue
      const key = `${id}:${path}`
      const localHash = serverPathState.get(key)
      const globalHash = serverPathState.get(path)
      if (
        (localHash && localHash !== contentHash) ||
        (globalHash && globalHash !== contentHash)
      ) {
        hasChange = true
        serverPathState.set(key, contentHash)
        serverPathState.set(path, contentHash)
      } else {
        if (!localHash) {
          serverPathState.set(key, contentHash)
        }
        if (!globalHash) {
          serverPathState.set(path, contentHash)
        }
      }
    }

    if (!hasChange) {
      return result
    }

    const hasAppPaths = result.serverPaths.some(({ path: p }) =>
      p.startsWith('server/app')
    )

    if (hasAppPaths) {
      deleteAppClientCache()
    }

    const serverPaths = result.serverPaths.map(({ path: p }) =>
      join(distDir, p)
    )

    for (const file of serverPaths) {
      clearModuleContext(file)
      deleteCache(file)
    }

    return result
  }

  const buildingIds = new Set()
  const readyIds = new Set()

  function startBuilding(
    id: string,
    requestUrl: string | undefined,
    forceRebuild: boolean = false
  ) {
    if (!forceRebuild && readyIds.has(id)) {
      return () => {}
    }
    if (buildingIds.size === 0) {
      consoleStore.setState(
        {
          loading: true,
          trigger: id,
          url: requestUrl,
        } as OutputState,
        true
      )
    }
    buildingIds.add(id)
    return function finishBuilding() {
      if (buildingIds.size === 0) {
        return
      }
      readyIds.add(id)
      buildingIds.delete(id)
      if (buildingIds.size === 0) {
        consoleStore.setState(
          {
            loading: false,
          } as OutputState,
          true
        )
      }
    }
  }

  let hmrEventHappened = false
  let hmrHash = 0
  const sendEnqueuedMessages = () => {
    for (const [, issueMap] of issues) {
      if (issueMap.size > 0) {
        // During compilation errors we want to delay the HMR events until errors are fixed
        return
      }
    }
    for (const payload of hmrPayloads.values()) {
      hotReloader.send(payload)
    }
    hmrPayloads.clear()
    if (turbopackUpdates.length > 0) {
      hotReloader.send({
        action: HMR_ACTIONS_SENT_TO_BROWSER.TURBOPACK_MESSAGE,
        data: turbopackUpdates,
      })
      turbopackUpdates.length = 0
    }
  }
  const sendEnqueuedMessagesDebounce = debounce(sendEnqueuedMessages, 2)

  function sendHmr(key: string, id: string, payload: HMR_ACTION_TYPES) {
    hmrPayloads.set(`${key}:${id}`, payload)
    hmrEventHappened = true
    sendEnqueuedMessagesDebounce()
  }

  function sendTurbopackMessage(payload: TurbopackUpdate) {
    turbopackUpdates.push(payload)
    hmrEventHappened = true
    sendEnqueuedMessagesDebounce()
  }

  async function loadPartialManifest<T>(
    name:
      | typeof MIDDLEWARE_MANIFEST
      | typeof BUILD_MANIFEST
      | typeof APP_BUILD_MANIFEST
      | typeof PAGES_MANIFEST
      | typeof APP_PATHS_MANIFEST
      | `${typeof SERVER_REFERENCE_MANIFEST}.json`
      | `${typeof NEXT_FONT_MANIFEST}.json`
      | typeof REACT_LOADABLE_MANIFEST,
    pageName: string,
    type: 'pages' | 'app' | 'middleware' | 'instrumentation' = 'pages'
  ): Promise<T> {
    const manifestPath = posix.join(
      distDir,
      `server`,
      type,
      type === 'middleware' || type === 'instrumentation'
        ? ''
        : type === 'app'
        ? pageName
        : getAssetPathFromRoute(pageName),
      name
    )
    return JSON.parse(await readFile(posix.join(manifestPath), 'utf-8')) as T
  }

  const buildManifests = new Map<string, BuildManifest>()
  const appBuildManifests = new Map<string, AppBuildManifest>()
  const pagesManifests = new Map<string, PagesManifest>()
  const appPathsManifests = new Map<string, PagesManifest>()
  const middlewareManifests = new Map<string, TurbopackMiddlewareManifest>()
  const actionManifests = new Map<string, ActionManifest>()
  const fontManifests = new Map<string, NextFontManifest>()
  const loadableManifests = new Map<string, LoadableManifest>()
  const clientToHmrSubscription = new Map<ws, Map<string, AsyncIterator<any>>>()
  const clients = new Set<ws>()

  async function loadMiddlewareManifest(
    pageName: string,
    type: 'pages' | 'app' | 'middleware' | 'instrumentation'
  ): Promise<void> {
    middlewareManifests.set(
      pageName,
      await loadPartialManifest(MIDDLEWARE_MANIFEST, pageName, type)
    )
  }

  async function loadBuildManifest(
    pageName: string,
    type: 'app' | 'pages' = 'pages'
  ): Promise<void> {
    buildManifests.set(
      pageName,
      await loadPartialManifest(BUILD_MANIFEST, pageName, type)
    )
  }

  async function loadAppBuildManifest(pageName: string): Promise<void> {
    appBuildManifests.set(
      pageName,
      await loadPartialManifest(APP_BUILD_MANIFEST, pageName, 'app')
    )
  }

  async function loadPagesManifest(pageName: string): Promise<void> {
    pagesManifests.set(
      pageName,
      await loadPartialManifest(PAGES_MANIFEST, pageName)
    )
  }

  async function loadAppPathManifest(pageName: string): Promise<void> {
    appPathsManifests.set(
      pageName,
      await loadPartialManifest(APP_PATHS_MANIFEST, pageName, 'app')
    )
  }

  async function loadActionManifest(pageName: string): Promise<void> {
    actionManifests.set(
      pageName,
      await loadPartialManifest(
        `${SERVER_REFERENCE_MANIFEST}.json`,
        pageName,
        'app'
      )
    )
  }

  async function loadFontManifest(
    pageName: string,
    type: 'app' | 'pages' = 'pages'
  ): Promise<void> {
    fontManifests.set(
      pageName,
      await loadPartialManifest(`${NEXT_FONT_MANIFEST}.json`, pageName, type)
    )
  }

  async function loadLoadableManifest(
    pageName: string,
    type: 'app' | 'pages' = 'pages'
  ): Promise<void> {
    loadableManifests.set(
      pageName,
      await loadPartialManifest(REACT_LOADABLE_MANIFEST, pageName, type)
    )
  }

  async function changeSubscription(
    page: string,
    type: 'client' | 'server',
    includeIssues: boolean,
    endpoint: Endpoint | undefined,
    makePayload: (
      page: string,
      change: TurbopackResult
    ) => Promise<HMR_ACTION_TYPES> | HMR_ACTION_TYPES | void
  ) {
    const key = `${page} (${type})`
    if (!endpoint || changeSubscriptions.has(key)) return

    const changedPromise = endpoint[`${type}Changed`](includeIssues)
    changeSubscriptions.set(key, changedPromise)
    const changed = await changedPromise

    for await (const change of changed) {
      processIssues(issues, page, change)
      const payload = await makePayload(page, change)
      if (payload) {
        sendHmr('endpoint-change', key, payload)
      }
    }
  }

  async function clearChangeSubscription(
    page: string,
    type: 'server' | 'client'
  ) {
    const key = `${page} (${type})`
    const subscription = await changeSubscriptions.get(key)
    if (subscription) {
      subscription.return?.()
      changeSubscriptions.delete(key)
    }
    issues.delete(key)
  }

  async function writeBuildManifest(
    rewrites: SetupOpts['fsChecker']['rewrites']
  ): Promise<void> {
    const buildManifest = mergeBuildManifests(buildManifests.values())
    const buildManifestPath = join(distDir, BUILD_MANIFEST)
    const middlewareBuildManifestPath = join(
      distDir,
      'server',
      `${MIDDLEWARE_BUILD_MANIFEST}.js`
    )
    const interceptionRewriteManifestPath = join(
      distDir,
      'server',
      `${INTERCEPTION_ROUTE_REWRITE_MANIFEST}.js`
    )
    deleteCache(buildManifestPath)
    deleteCache(middlewareBuildManifestPath)
    deleteCache(interceptionRewriteManifestPath)
    await writeFileAtomic(
      buildManifestPath,
      JSON.stringify(buildManifest, null, 2)
    )
    await writeFileAtomic(
      middlewareBuildManifestPath,
      `self.__BUILD_MANIFEST=${JSON.stringify(buildManifest)};`
    )

    const interceptionRewrites = JSON.stringify(
      rewrites.beforeFiles.filter(isInterceptionRouteRewrite)
    )

    await writeFileAtomic(
      interceptionRewriteManifestPath,
      `self.__INTERCEPTION_ROUTE_REWRITE_MANIFEST=${JSON.stringify(
        interceptionRewrites
      )};`
    )

    const content: ClientBuildManifest = {
      __rewrites: rewrites
        ? (normalizeRewritesForBuildManifest(rewrites) as any)
        : { afterFiles: [], beforeFiles: [], fallback: [] },
      ...Object.fromEntries(
        [...curEntries.keys()].map((pathname) => [
          pathname,
          `static/chunks/pages${pathname === '/' ? '/index' : pathname}.js`,
        ])
      ),
      sortedPages: [...curEntries.keys()],
    }
    const buildManifestJs = `self.__BUILD_MANIFEST = ${JSON.stringify(
      content
    )};self.__BUILD_MANIFEST_CB && self.__BUILD_MANIFEST_CB()`
    await writeFileAtomic(
      join(distDir, 'static', 'development', '_buildManifest.js'),
      buildManifestJs
    )
    await writeFileAtomic(
      join(distDir, 'static', 'development', '_ssgManifest.js'),
      srcEmptySsgManifest
    )
  }

  async function writeFallbackBuildManifest(): Promise<void> {
    const fallbackBuildManifest = mergeBuildManifests(
      [buildManifests.get('_app'), buildManifests.get('_error')].filter(
        Boolean
      ) as BuildManifest[]
    )
    const fallbackBuildManifestPath = join(
      distDir,
      `fallback-${BUILD_MANIFEST}`
    )
    deleteCache(fallbackBuildManifestPath)
    await writeFileAtomic(
      fallbackBuildManifestPath,
      JSON.stringify(fallbackBuildManifest, null, 2)
    )
  }

  async function writeAppBuildManifest(): Promise<void> {
    const appBuildManifest = mergeAppBuildManifests(appBuildManifests.values())
    const appBuildManifestPath = join(distDir, APP_BUILD_MANIFEST)
    deleteCache(appBuildManifestPath)
    await writeFileAtomic(
      appBuildManifestPath,
      JSON.stringify(appBuildManifest, null, 2)
    )
  }

  async function writePagesManifest(): Promise<void> {
    const pagesManifest = mergePagesManifests(pagesManifests.values())
    const pagesManifestPath = join(distDir, 'server', PAGES_MANIFEST)
    deleteCache(pagesManifestPath)
    await writeFileAtomic(
      pagesManifestPath,
      JSON.stringify(pagesManifest, null, 2)
    )
  }

  async function writeAppPathsManifest(): Promise<void> {
    const appPathsManifest = mergePagesManifests(appPathsManifests.values())
    const appPathsManifestPath = join(distDir, 'server', APP_PATHS_MANIFEST)
    deleteCache(appPathsManifestPath)
    await writeFileAtomic(
      appPathsManifestPath,
      JSON.stringify(appPathsManifest, null, 2)
    )
  }

  async function writeMiddlewareManifest(): Promise<void> {
    const middlewareManifest = mergeMiddlewareManifests(
      middlewareManifests.values()
    )
    const middlewareManifestPath = join(distDir, 'server', MIDDLEWARE_MANIFEST)
    deleteCache(middlewareManifestPath)
    await writeFileAtomic(
      middlewareManifestPath,
      JSON.stringify(middlewareManifest, null, 2)
    )
  }

  async function writeActionManifest(): Promise<void> {
    const actionManifest = await mergeActionManifests(actionManifests.values())
    const actionManifestJsonPath = join(
      distDir,
      'server',
      `${SERVER_REFERENCE_MANIFEST}.json`
    )
    const actionManifestJsPath = join(
      distDir,
      'server',
      `${SERVER_REFERENCE_MANIFEST}.js`
    )
    const json = JSON.stringify(actionManifest, null, 2)
    deleteCache(actionManifestJsonPath)
    deleteCache(actionManifestJsPath)
    await writeFile(actionManifestJsonPath, json, 'utf-8')
    await writeFile(
      actionManifestJsPath,
      `self.__RSC_SERVER_MANIFEST=${JSON.stringify(json)}`,
      'utf-8'
    )
  }

  async function writeFontManifest(): Promise<void> {
    const fontManifest = mergeFontManifests(fontManifests.values())
    const json = JSON.stringify(fontManifest, null, 2)

    const fontManifestJsonPath = join(
      distDir,
      'server',
      `${NEXT_FONT_MANIFEST}.json`
    )
    const fontManifestJsPath = join(
      distDir,
      'server',
      `${NEXT_FONT_MANIFEST}.js`
    )
    deleteCache(fontManifestJsonPath)
    deleteCache(fontManifestJsPath)
    await writeFileAtomic(fontManifestJsonPath, json)
    await writeFileAtomic(
      fontManifestJsPath,
      `self.__NEXT_FONT_MANIFEST=${JSON.stringify(json)}`
    )
  }

  async function writeLoadableManifest(): Promise<void> {
    const loadableManifest = mergeLoadableManifests(loadableManifests.values())
    const loadableManifestPath = join(distDir, REACT_LOADABLE_MANIFEST)
    const middlewareloadableManifestPath = join(
      distDir,
      'server',
      `${MIDDLEWARE_REACT_LOADABLE_MANIFEST}.js`
    )

    const json = JSON.stringify(loadableManifest, null, 2)

    deleteCache(loadableManifestPath)
    deleteCache(middlewareloadableManifestPath)
    await writeFileAtomic(loadableManifestPath, json)
    await writeFileAtomic(
      middlewareloadableManifestPath,
      `self.__REACT_LOADABLE_MANIFEST=${JSON.stringify(json)}`
    )
  }

  async function writeManifests(): Promise<void> {
    await writeBuildManifest(opts.fsChecker.rewrites)
    await writeAppBuildManifest()
    await writePagesManifest()
    await writeAppPathsManifest()
    await writeMiddlewareManifest()
    await writeActionManifest()
    await writeFontManifest()
    await writeLoadableManifest()
    await writeFallbackBuildManifest()
  }

  async function subscribeToHmrEvents(id: string, client: ws) {
    let mapping = clientToHmrSubscription.get(client)
    if (mapping === undefined) {
      mapping = new Map()
      clientToHmrSubscription.set(client, mapping)
    }
    if (mapping.has(id)) return

    const subscription = project!.hmrEvents(id)
    mapping.set(id, subscription)

    // The subscription will always emit once, which is the initial
    // computation. This is not a change, so swallow it.
    try {
      await subscription.next()

      for await (const data of subscription) {
        processIssues(issues, id, data)
        if (data.type !== 'issues') {
          sendTurbopackMessage(data)
        }
      }
    } catch (e) {
      // The client might be using an HMR session from a previous server, tell them
      // to fully reload the page to resolve the issue. We can't use
      // `hotReloader.send` since that would force very connected client to
      // reload, only this client is out of date.
      const reloadAction: ReloadPageAction = {
        action: HMR_ACTIONS_SENT_TO_BROWSER.RELOAD_PAGE,
      }
      client.send(JSON.stringify(reloadAction))
      client.close()
      return
    }
  }

  function unsubscribeToHmrEvents(id: string, client: ws) {
    const mapping = clientToHmrSubscription.get(client)
    const subscription = mapping?.get(id)
    subscription?.return!()
  }

  try {
    async function handleEntries() {
      for await (const entrypoints of iter) {
        if (!currentEntriesHandlingResolve) {
          currentEntriesHandling = new Promise(
            // eslint-disable-next-line no-loop-func
            (resolve) => (currentEntriesHandlingResolve = resolve)
          )
        }
        globalEntries.app = entrypoints.pagesAppEndpoint
        globalEntries.document = entrypoints.pagesDocumentEndpoint
        globalEntries.error = entrypoints.pagesErrorEndpoint

        curEntries.clear()
        curAppEntries.clear()

        for (const [pathname, route] of entrypoints.routes) {
          switch (route.type) {
            case 'page':
            case 'page-api':
              curEntries.set(pathname, route)
              break
            case 'app-page': {
              curEntries.set(pathname, route)
              // ideally we wouldn't put the whole route in here
              route.pages.forEach((page) => {
                curAppEntries.set(page.originalName, route)
              })
              break
            }
            case 'app-route': {
              curEntries.set(pathname, route)
              curAppEntries.set(route.originalName, route)
              break
            }
            default:
              Log.info(`skipping ${pathname} (${route.type})`)
              break
          }
        }

        for (const [pathname, subscriptionPromise] of changeSubscriptions) {
          const rawPathname = pathname.replace(/ \((?:client|server)\)$/, '')

          if (rawPathname === '') {
            // middleware is handled below
            continue
          }

          if (!curEntries.has(rawPathname) && !curAppEntries.has(rawPathname)) {
            const subscription = await subscriptionPromise
            await subscription.return?.()
            changeSubscriptions.delete(pathname)
          }
        }

        for (const [page] of issues) {
          if (!curEntries.has(page)) {
            issues.delete(page)
          }
        }

        const { middleware, instrumentation } = entrypoints
        // We check for explicit true/false, since it's initialized to
        // undefined during the first loop (middlewareChanges event is
        // unnecessary during the first serve)
        if (prevMiddleware === true && !middleware) {
          // Went from middleware to no middleware
          await clearChangeSubscription('middleware', 'server')
          sendHmr('entrypoint-change', 'middleware', {
            event: HMR_ACTIONS_SENT_TO_BROWSER.MIDDLEWARE_CHANGES,
          })
        } else if (prevMiddleware === false && middleware) {
          // Went from no middleware to middleware
          sendHmr('endpoint-change', 'middleware', {
            event: HMR_ACTIONS_SENT_TO_BROWSER.MIDDLEWARE_CHANGES,
          })
        }
        if (
          opts.nextConfig.experimental.instrumentationHook &&
          instrumentation
        ) {
          const processInstrumentation = async (
            displayName: string,
            name: string,
            prop: 'nodeJs' | 'edge'
          ) => {
            const writtenEndpoint = await handleRequireCacheClearing(
              displayName,
              await instrumentation[prop].writeToDisk()
            )
            processIssues(issues, name, writtenEndpoint)
          }
          await processInstrumentation(
            'instrumentation (node.js)',
            'instrumentation.nodeJs',
            'nodeJs'
          )
          await processInstrumentation(
            'instrumentation (edge)',
            'instrumentation.edge',
            'edge'
          )
          await loadMiddlewareManifest('instrumentation', 'instrumentation')
          await writeManifests()

          serverFields.actualInstrumentationHookFile = '/instrumentation'
          await propagateServerField(
            opts,
            'actualInstrumentationHookFile',
            serverFields.actualInstrumentationHookFile
          )
        } else {
          serverFields.actualInstrumentationHookFile = undefined
          await propagateServerField(
            opts,
            'actualInstrumentationHookFile',
            serverFields.actualInstrumentationHookFile
          )
        }
        if (middleware) {
          const processMiddleware = async () => {
            const writtenEndpoint = await handleRequireCacheClearing(
              'middleware',
              await middleware.endpoint.writeToDisk()
            )
            processIssues(issues, 'middleware', writtenEndpoint)
            await loadMiddlewareManifest('middleware', 'middleware')
            serverFields.middleware = {
              match: null as any,
              page: '/',
              matchers:
                middlewareManifests.get('middleware')?.middleware['/'].matchers,
            }
          }
          await processMiddleware()

          changeSubscription(
            'middleware',
            'server',
            false,
            middleware.endpoint,
            async () => {
              const finishBuilding = startBuilding(
                'middleware',
                undefined,
                true
              )
              await processMiddleware()
              await propagateServerField(
                opts,
                'actualMiddlewareFile',
                serverFields.actualMiddlewareFile
              )
              await propagateServerField(
                opts,
                'middleware',
                serverFields.middleware
              )
              await writeManifests()

              finishBuilding()
              return { event: HMR_ACTIONS_SENT_TO_BROWSER.MIDDLEWARE_CHANGES }
            }
          )
          prevMiddleware = true
        } else {
          middlewareManifests.delete('middleware')
          serverFields.actualMiddlewareFile = undefined
          serverFields.middleware = undefined
          prevMiddleware = false
        }
        await propagateServerField(
          opts,
          'actualMiddlewareFile',
          serverFields.actualMiddlewareFile
        )
        await propagateServerField(opts, 'middleware', serverFields.middleware)

        currentEntriesHandlingResolve!()
        currentEntriesHandlingResolve = undefined
      }
    }

    handleEntries().catch((err) => {
      console.error(err)
      process.exit(1)
    })
  } catch (e) {
    console.error(e)
  }

  // Write empty manifests
  await mkdir(join(distDir, 'server'), { recursive: true })
  await mkdir(join(distDir, 'static/development'), { recursive: true })
  await writeFile(
    join(distDir, 'package.json'),
    JSON.stringify(
      {
        type: 'commonjs',
      },
      null,
      2
    )
  )
  await currentEntriesHandling
  await writeManifests()

  const overlayMiddleware = getOverlayMiddleware(project)
  const versionInfo: VersionInfo = await getVersionInfo(
    isTestMode || opts.telemetry.isEnabled
  )

  async function handleRouteType(
    page: string,
    pathname: string,
    route: Route,
    requestUrl: string | undefined
  ) {
    let finishBuilding: (() => void) | undefined = undefined

    try {
      switch (route.type) {
        case 'page': {
          finishBuilding = startBuilding(pathname, requestUrl)
          try {
            if (globalEntries.app) {
              const writtenEndpoint = await handleRequireCacheClearing(
                '_app',
                await globalEntries.app.writeToDisk()
              )
              processIssues(issues, '_app', writtenEndpoint)
            }
            await loadBuildManifest('_app')
            await loadPagesManifest('_app')

            if (globalEntries.document) {
              const writtenEndpoint = await handleRequireCacheClearing(
                '_document',
                await globalEntries.document.writeToDisk()
              )
              processIssues(issues, '_document', writtenEndpoint)
            }
            await loadPagesManifest('_document')

            const writtenEndpoint = await handleRequireCacheClearing(
              page,
              await route.htmlEndpoint.writeToDisk()
            )

            const type = writtenEndpoint?.type

            await loadBuildManifest(page)
            await loadPagesManifest(page)
            if (type === 'edge') {
              await loadMiddlewareManifest(page, 'pages')
            } else {
              middlewareManifests.delete(page)
            }
            await loadFontManifest(page, 'pages')
            await loadLoadableManifest(page, 'pages')

            await writeManifests()

            processIssues(issues, page, writtenEndpoint)
          } finally {
            changeSubscription(
              page,
              'server',
              false,
              route.dataEndpoint,
              (pageName) => {
                // Report the next compilation again
                readyIds.delete(page)
                return {
                  event: HMR_ACTIONS_SENT_TO_BROWSER.SERVER_ONLY_CHANGES,
                  pages: [pageName],
                }
              }
            )
            changeSubscription(
              page,
              'client',
              false,
              route.htmlEndpoint,
              () => {
                return {
                  event: HMR_ACTIONS_SENT_TO_BROWSER.CLIENT_CHANGES,
                }
              }
            )
            if (globalEntries.document) {
              changeSubscription(
                '_document',
                'server',
                false,
                globalEntries.document,
                () => {
                  return { action: HMR_ACTIONS_SENT_TO_BROWSER.RELOAD_PAGE }
                }
              )
            }
          }

          break
        }
        case 'page-api': {
          finishBuilding = startBuilding(pathname, requestUrl)
          const writtenEndpoint = await handleRequireCacheClearing(
            page,
            await route.endpoint.writeToDisk()
          )

          const type = writtenEndpoint?.type

          await loadPagesManifest(page)
          if (type === 'edge') {
            await loadMiddlewareManifest(page, 'pages')
          } else {
            middlewareManifests.delete(page)
          }
          await loadLoadableManifest(page, 'pages')

          await writeManifests()

          processIssues(issues, page, writtenEndpoint)

          break
        }
        case 'app-page': {
          const pageRoute =
            route.pages.find((p) => p.originalName === page) ?? route.pages[0]

          finishBuilding = startBuilding(pathname, requestUrl)
          const writtenEndpoint = await handleRequireCacheClearing(
            page,
            await pageRoute.htmlEndpoint.writeToDisk()
          )

          changeSubscription(
            page,
            'server',
            true,
            pageRoute.rscEndpoint,
            (_page, change) => {
              if (change.issues.some((issue) => issue.severity === 'error')) {
                // Ignore any updates that has errors
                // There will be another update without errors eventually
                return
              }
              // Report the next compilation again
              readyIds.delete(page)
              return {
                action: HMR_ACTIONS_SENT_TO_BROWSER.SERVER_COMPONENT_CHANGES,
              }
            }
          )

          const type = writtenEndpoint?.type

          if (type === 'edge') {
            await loadMiddlewareManifest(page, 'app')
          } else {
            middlewareManifests.delete(page)
          }

          await loadAppBuildManifest(page)
          await loadBuildManifest(page, 'app')
          await loadAppPathManifest(page)
          await loadActionManifest(page)
          await loadFontManifest(page, 'app')
          await writeManifests()

          processIssues(issues, page, writtenEndpoint, true)

          break
        }
        case 'app-route': {
          finishBuilding = startBuilding(pathname, requestUrl)
          const writtenEndpoint = await handleRequireCacheClearing(
            page,
            await route.endpoint.writeToDisk()
          )

          const type = writtenEndpoint?.type

          await loadAppPathManifest(page)
          if (type === 'edge') {
            await loadMiddlewareManifest(page, 'app')
          } else {
            middlewareManifests.delete(page)
          }

          await writeManifests()

          processIssues(issues, page, writtenEndpoint, true)

          break
        }
        default: {
          throw new Error(
            `unknown route type ${(route as any).type} for ${page}`
          )
        }
      }
    } finally {
      if (finishBuilding) finishBuilding()
    }
  }

  const hotReloader: NextJsHotReloaderInterface = {
    turbopackProject: project,
    activeWebpackConfigs: undefined,
    serverStats: null,
    edgeServerStats: null,
    async run(req, res, _parsedUrl) {
      // intercept page chunks request and ensure them with turbopack
      if (req.url?.startsWith('/_next/static/chunks/pages/')) {
        const params = matchNextPageBundleRequest(req.url)

        if (params) {
          const decodedPagePath = `/${params.path
            .map((param: string) => decodeURIComponent(param))
            .join('/')}`

          const denormalizedPagePath = denormalizePagePath(decodedPagePath)

          await hotReloader
            .ensurePage({
              page: denormalizedPagePath,
              clientOnly: false,
              definition: undefined,
              url: req.url,
            })
            .catch(console.error)
        }
      }

      await overlayMiddleware(req, res)

      // Request was not finished.
      return { finished: undefined }
    },

    // TODO: Figure out if socket type can match the NextJsHotReloaderInterface
    onHMR(req, socket: Socket, head) {
      wsServer.handleUpgrade(req, socket, head, (client) => {
        clients.add(client)
        client.on('close', () => clients.delete(client))

        client.addEventListener('message', ({ data }) => {
          const parsedData = JSON.parse(
            typeof data !== 'string' ? data.toString() : data
          )

          // Next.js messages
          switch (parsedData.event) {
            case 'ping':
              // Ping doesn't need additional handling in Turbopack.
              break
            case 'span-end': {
              hotReloaderSpan.manualTraceChild(
                parsedData.spanName,
                msToNs(parsedData.startTime),
                msToNs(parsedData.endTime),
                parsedData.attributes
              )
              break
            }
            case 'client-hmr-latency': // { id, startTime, endTime, page, updatedModules, isPageHidden }
              hotReloaderSpan.manualTraceChild(
                parsedData.event,
                msToNs(parsedData.startTime),
                msToNs(parsedData.endTime),
                {
                  updatedModules: parsedData.updatedModules,
                  page: parsedData.page,
                  isPageHidden: parsedData.isPageHidden,
                }
              )
              break
            case 'client-error': // { errorCount, clientId }
            case 'client-warning': // { warningCount, clientId }
            case 'client-success': // { clientId }
            case 'server-component-reload-page': // { clientId }
            case 'client-reload-page': // { clientId }
            case 'client-removed-page': // { page }
            case 'client-full-reload': // { stackTrace, hadRuntimeError }
            case 'client-added-page':
              // TODO
              break

            default:
              // Might be a Turbopack message...
              if (!parsedData.type) {
                throw new Error(`unrecognized HMR message "${data}"`)
              }
          }

          // Turbopack messages
          switch (parsedData.type) {
            case 'turbopack-subscribe':
              subscribeToHmrEvents(parsedData.path, client)
              break

            case 'turbopack-unsubscribe':
              unsubscribeToHmrEvents(parsedData.path, client)
              break

            default:
              if (!parsedData.event) {
                throw new Error(`unrecognized Turbopack HMR message "${data}"`)
              }
          }
        })

        const turbopackConnected: TurbopackConnectedAction = {
          action: HMR_ACTIONS_SENT_TO_BROWSER.TURBOPACK_CONNECTED,
        }
        client.send(JSON.stringify(turbopackConnected))

        const errors = []
        for (const pageIssues of issues.values()) {
          for (const issue of pageIssues.values()) {
            errors.push({
              message: formatIssue(issue),
            })
          }
        }

        const sync: SyncAction = {
          action: HMR_ACTIONS_SENT_TO_BROWSER.SYNC,
          errors,
          warnings: [],
          hash: '',
          versionInfo,
        }

        this.send(sync)
      })
    },

    send(action) {
      const payload = JSON.stringify(action)
      for (const client of clients) {
        client.send(payload)
      }
    },

    setHmrServerError(_error) {
      // Not implemented yet.
    },
    clearHmrServerError() {
      // Not implemented yet.
    },
    async start() {},
    async stop() {
      // Not implemented yet.
    },
    async getCompilationErrors(page) {
      const thisPageIssues = issues.get(page)
      if (thisPageIssues !== undefined && thisPageIssues.size > 0) {
        // If there is an error related to the requesting page we display it instead of the first error
        return [...thisPageIssues.values()].map(
          (issue) => new Error(formatIssue(issue))
        )
      }

      // Otherwise, return all errors across pages
      const errors = []
      for (const pageIssues of issues.values()) {
        for (const issue of pageIssues.values()) {
          errors.push(new Error(formatIssue(issue)))
        }
      }
      return errors
    },
    async invalidate({
      // .env files or tsconfig/jsconfig change
      reloadAfterInvalidation,
    }) {
      if (reloadAfterInvalidation) {
        await clearAllModuleContexts()
        this.send({
          action: HMR_ACTIONS_SENT_TO_BROWSER.SERVER_COMPONENT_CHANGES,
        })
      }
    },
    async buildFallbackError() {
      // Not implemented yet.
    },
    async ensurePage({
      page: inputPage,
      // Unused parameters
      // clientOnly,
      // appPaths,
      definition,
      isApp,
      url: requestUrl,
    }) {
      if (inputPage !== '/_error' && BLOCKED_PAGES.indexOf(inputPage) !== -1) {
        return
      }

      let routeDef: Pick<RouteDefinition, 'filename' | 'bundlePath' | 'page'> =
        definition ??
        (await findPagePathData(
          dir,
          inputPage,
          nextConfig.pageExtensions,
          opts.pagesDir,
          opts.appDir
        ))

      const page = routeDef.page
      const pathname = definition?.pathname ?? inputPage

      if (page === '/_error') {
        let finishBuilding = startBuilding(pathname, requestUrl)
        try {
          if (globalEntries.app) {
            const writtenEndpoint = await handleRequireCacheClearing(
              '_app',
              await globalEntries.app.writeToDisk()
            )
            processIssues(issues, '_app', writtenEndpoint)
          }
          await loadBuildManifest('_app')
          await loadPagesManifest('_app')
          await loadFontManifest('_app')

          if (globalEntries.document) {
            const writtenEndpoint = await handleRequireCacheClearing(
              '_document',
              await globalEntries.document.writeToDisk()
            )
            changeSubscription(
              '_document',
              'server',
              false,
              globalEntries.document,
              () => {
                return { action: HMR_ACTIONS_SENT_TO_BROWSER.RELOAD_PAGE }
              }
            )
            processIssues(issues, '_document', writtenEndpoint)
          }
          await loadPagesManifest('_document')

          if (globalEntries.error) {
            const writtenEndpoint = await handleRequireCacheClearing(
              '_error',
              await globalEntries.error.writeToDisk()
            )
            processIssues(issues, page, writtenEndpoint)
          }
          await loadBuildManifest('_error')
          await loadPagesManifest('_error')
          await loadFontManifest('_error')

          await writeManifests()
        } finally {
          finishBuilding()
        }
        return
      }

      await currentEntriesHandling
      const route = definition?.pathname
        ? curEntries.get(definition!.pathname)
        : isApp
        ? curAppEntries.get(page)
        : curEntries.get(page)

      if (!route) {
        // TODO: why is this entry missing in turbopack?
        if (page === '/_app') return
        if (page === '/_document') return
        if (page === '/middleware') return
        if (page === '/src/middleware') return
        if (page === '/instrumentation') return
        if (page === '/src/instrumentation') return

        throw new PageNotFoundError(`route not found ${page}`)
      }

      // We don't throw on ensureOpts.isApp === true for page-api
      // since this can happen when app pages make
      // api requests to page API routes.
      if (isApp && route.type === 'page') {
        throw new Error(`mis-matched route type: isApp && page for ${page}`)
      }

      await handleRouteType(page, pathname, route, requestUrl)
    },
  }

  ;(async function () {
    for await (const updateMessage of project.updateInfoSubscribe(30)) {
      switch (updateMessage.updateType) {
        case 'start': {
          hotReloader.send({ action: HMR_ACTIONS_SENT_TO_BROWSER.BUILDING })
          break
        }
        case 'end': {
          sendEnqueuedMessages()

          const errors = new Map<string, CompilationError>()
          for (const [, issueMap] of issues) {
            for (const [key, issue] of issueMap) {
              if (errors.has(key)) continue

              const message = formatIssue(issue)

              errors.set(key, {
                message,
                details: issue.detail
                  ? renderStyledStringToErrorAnsi(issue.detail)
                  : undefined,
              })
            }
          }

          hotReloader.send({
            action: HMR_ACTIONS_SENT_TO_BROWSER.BUILT,
            hash: String(++hmrHash),
            errors: [...errors.values()],
            warnings: [],
          })

          if (hmrEventHappened) {
            const time = updateMessage.value.duration
            const timeMessage =
              time > 2000 ? `${Math.round(time / 100) / 10}s` : `${time}ms`
            Log.event(`Compiled in ${timeMessage}`)
            hmrEventHappened = false
          }
          break
        }
        default:
      }
    }
  })().catch(() => {})

  return hotReloader
}

function renderStyledStringToErrorAnsi(string: StyledString): string {
  function decodeMagicIdentifiers(str: string): string {
    return str.replaceAll(MAGIC_IDENTIFIER_REGEX, (ident) => {
      try {
        return magenta(`{${decodeMagicIdentifier(ident)}}`)
      } catch (e) {
        return magenta(`{${ident} (decoding failed: ${e})}`)
      }
    })
  }

  switch (string.type) {
    case 'text':
      return decodeMagicIdentifiers(string.value)
    case 'strong':
      return bold(red(decodeMagicIdentifiers(string.value)))
    case 'code':
      return green(decodeMagicIdentifiers(string.value))
    case 'line':
      return string.value.map(renderStyledStringToErrorAnsi).join('')
    case 'stack':
      return string.value.map(renderStyledStringToErrorAnsi).join('\n')
    default:
      throw new Error('Unknown StyledString type', string)
  }
}

function msToNs(ms: number): bigint {
  return BigInt(Math.floor(ms)) * BigInt(MILLISECONDS_IN_NANOSECOND)
}
