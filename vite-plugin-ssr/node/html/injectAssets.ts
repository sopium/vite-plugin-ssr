import { assert, assertUsage, castProp, hasProp, higherFirst, normalizePath, slice } from '../../shared/utils'
import { getPreloadUrls } from '../getPreloadTags'
import { getSsrEnv } from '../ssrEnv'
import { getViteManifest, ViteManifest } from '../getViteManifest'
import { prependBaseUrl } from '../baseUrlHandling'
import { isAbsolute } from 'path'
import { inferMediaType, MediaType } from './inferMediaType'
import { AllPageFiles } from '../../shared/getPageFiles'
import { serializePageContextClientSide } from '../serializePageContextClientSide'
import { sanitizeJson } from './injectAssets/sanitizeJson'

export { injectAssets__public }
export { injectAssets }
export { injectAssetsBeforeRender }
export { injectAssetsAfterRender }
export type { PageContextInjectAssets }
export { getPageAssets }
export { PageAssets }

type PageAssets = PageAsset[]
type PageAsset = {
  src: string
  assetType: 'script' | 'style' | 'preload'
  mediaType: null | NonNullable<MediaType>['mediaType']
  preloadType: null | NonNullable<MediaType>['preloadType']
}

async function getPageAssets(
  pageContext: {
    _allPageFiles: AllPageFiles
  },
  dependencies: string[],
  pageClientFilePath: string,
  isPreRendering: boolean
): Promise<PageAsset[]> {
  assert(dependencies.every((filePath) => isAbsolute(filePath)))

  const { isProduction = false } = getSsrEnv()
  let clientManifest: null | ViteManifest = null
  let serverManifest: null | ViteManifest = null
  if (isPreRendering || isProduction) {
    const manifests = retrieveViteManifest(isPreRendering)
    clientManifest = manifests.clientManifest
    serverManifest = manifests.serverManifest
  }

  const preloadAssets: string[] = await getPreloadUrls(pageContext, dependencies, clientManifest, serverManifest)

  let pageAssets: PageAsset[] = preloadAssets.map((src) => {
    const { mediaType = null, preloadType = null } = inferMediaType(src) || {}
    const assetType = mediaType === 'text/css' ? 'style' : 'preload'
    return {
      src,
      assetType,
      mediaType,
      preloadType
    }
  })

  const scriptSrc = !isProduction ? pageClientFilePath : resolveScriptSrc(pageClientFilePath, clientManifest!)
  pageAssets.push({
    src: scriptSrc,
    assetType: 'script',
    mediaType: 'text/javascript',
    preloadType: null
  })

  pageAssets = pageAssets.map((pageAsset) => {
    pageAsset.src = prependBaseUrl(normalizePath(pageAsset.src))
    return pageAsset
  })

  sortPageAssetsForHttpPush(pageAssets)

  return pageAssets
}

function sortPageAssetsForHttpPush(pageAssets: PageAsset[]) {
  pageAssets.sort(
    higherFirst(({ assetType, preloadType }) => {
      let priority = 0

      // CSS has highest priority
      if (assetType === 'style') return priority
      priority--
      if (preloadType === 'style') return priority
      priority--

      // Visual assets have high priority
      if (preloadType === 'font') return priority
      priority--
      if (preloadType === 'image') return priority
      priority--

      // JavaScript has lowest priority
      if (preloadType === 'script') return priority - 1
      if (assetType === 'script') return priority - 2

      return priority
    })
  )
}

function retrieveViteManifest(isPreRendering: boolean): { clientManifest: ViteManifest; serverManifest: ViteManifest } {
  const { clientManifest, serverManifest, clientManifestPath, serverManifestPath } = getViteManifest()
  const userOperation = isPreRendering
    ? 'running `$ vite-plugin-ssr prerender`'
    : 'running the server with `isProduction: true`'
  assertUsage(
    clientManifest && serverManifest,
    'You are ' +
      userOperation +
      " but you didn't build your app yet: make sure to run `$ vite build && vite build --ssr` before. (Following build manifest is missing: `" +
      clientManifestPath +
      '` and/or `' +
      serverManifestPath +
      '`.)'
  )
  return { clientManifest, serverManifest }
}

async function injectAssets__public(htmlString: string, pageContext: Record<string, unknown>): Promise<string> {
  assertUsage(
    typeof htmlString === 'string',
    '[injectAssets(htmlString, pageContext)]: Argument `htmlString` should be a string.'
  )
  assertUsage(pageContext, '[injectAssets(htmlString, pageContext)]: Argument `pageContext` is missing.')
  const errMsg = (body: string) =>
    '[injectAssets(htmlString, pageContext)]: ' +
    body +
    '. Make sure that `pageContext` is the object that `vite-plugin-ssr` provided to your `render(pageContext)` hook.'
  assertUsage(hasProp(pageContext, 'urlNormalized', 'string'), errMsg('`pageContext.urlNormalized` should be a string'))
  assertUsage(hasProp(pageContext, '_pageId', 'string'), errMsg('`pageContext._pageId` should be a string'))
  assertUsage(hasProp(pageContext, '_getPageAssets'), errMsg('`pageContext._getPageAssets` is missing'))
  assertUsage(hasProp(pageContext, '_passToClient', 'string[]'), errMsg('`pageContext._passToClient` is missing'))
  assertUsage(hasProp(pageContext, '_pageClientPath', 'string'), errMsg('`pageContext._pageClientPath` is missing'))
  castProp<() => Promise<PageAssets>, typeof pageContext, '_getPageAssets'>(pageContext, '_getPageAssets')
  pageContext._getPageAssets
  htmlString = await injectAssets(htmlString, pageContext)
  return htmlString
}

type PageContextInjectAssets = {
  urlNormalized: string
  _getPageAssets: () => Promise<PageAssets>
  _pageId: string
  _pageClientPath: string
  _passToClient: string[]
}
async function injectAssets(htmlString: string, pageContext: PageContextInjectAssets): Promise<string> {
  htmlString = await injectAssetsBeforeRender(htmlString, pageContext)
  htmlString = await injectAssetsAfterRender(htmlString, pageContext)
  return htmlString
}

async function injectAssetsBeforeRender(htmlString: string, pageContext: PageContextInjectAssets) {
  assert(htmlString)
  assert(typeof htmlString === 'string')

  // Ensure existence of `<head>` (Vite's `transformIndexHtml()` is buggy when `<head>` is missing)
  htmlString = ensureHeadTagExistence(htmlString)

  // Inject Vite transformations
  const { urlNormalized } = pageContext
  assert(typeof urlNormalized === 'string')
  htmlString = await applyViteHtmlTransform(htmlString, urlNormalized)

  const pageAssets = await pageContext._getPageAssets()

  // Inject script
  const scripts = pageAssets.filter(({ assetType }) => assetType === 'script')
  assert(scripts.length === 1)
  const script = scripts[0]
  assert(script)
  htmlString = injectScript(htmlString, script)

  // Inject preload links
  const preloadAssets = pageAssets.filter(({ assetType }) => assetType === 'preload' || assetType === 'style')
  const linkTags = preloadAssets.map((pageAsset) => {
    const isEsModule = pageAsset.preloadType === 'script'
    return inferAssetTag(pageAsset, isEsModule)
  })
  htmlString = injectLinkTags(htmlString, linkTags)

  return htmlString
}

async function injectAssetsAfterRender(htmlString: string, pageContext: PageContextInjectAssets) {
  // Inject pageContext__client
  assertUsage(
    !injectPageInfoAlreadyDone(htmlString),
    'Assets are being injected twice into your HTML. Make sure to remove your superfluous `injectAssets()` call (`vite-plugin-ssr` already automatically calls `injectAssets()`).'
  )
  htmlString = injectPageInfo(htmlString, pageContext)
  return htmlString
}

async function applyViteHtmlTransform(htmlString: string, urlNormalized: string): Promise<string> {
  const ssrEnv = getSsrEnv()
  if (ssrEnv.isProduction) {
    return htmlString
  }
  htmlString = await ssrEnv.viteDevServer.transformIndexHtml(urlNormalized, htmlString)
  return htmlString
}

function resolveScriptSrc(filePath: string, clientManifest: ViteManifest): string {
  assert(filePath.startsWith('/'))
  assert(getSsrEnv().isProduction)
  const manifestKey = filePath.slice(1)
  const manifestVal = clientManifest[manifestKey]
  assert(manifestVal)
  assert(manifestVal.isEntry)
  let { file } = manifestVal
  assert(!file.startsWith('/'))
  return '/' + file
}

const pageInfoInjectionBegin = '<script id="vite-plugin-ssr_pageContext" type="application/json">'
function injectPageInfo(htmlString: string, pageContext: { _pageId: string; _passToClient: string[] }): string {
  const pageContextSerialized = sanitizeJson(serializePageContextClientSide(pageContext))
  const injection = `${pageInfoInjectionBegin}${pageContextSerialized}</script>`
  return injectEnd(htmlString, injection)
}
function injectPageInfoAlreadyDone(htmlString: string) {
  return htmlString.includes(pageInfoInjectionBegin)
}

function injectScript(htmlString: string, script: PageAsset): string {
  const isEsModule = true
  const injection = inferAssetTag(script, isEsModule)
  return injectEnd(htmlString, injection)
}

function injectLinkTags(htmlString: string, linkTags: string[]): string {
  assert(linkTags.every((tag) => tag.startsWith('<') && tag.endsWith('>')))
  const injection = linkTags.join('')
  const headClose = '</head>'
  return injectAtClosingTag(htmlString, headClose, injection)
}

const headOpen = /<head[^>]*>/
function injectBegin(htmlString: string, injection: string): string {
  if (headOpen.test(htmlString)) {
    return injectAtOpeningTag(htmlString, headOpen, injection)
  }

  const htmlBegin = /<html[^>]*>/
  if (htmlBegin.test(htmlString)) {
    return injectAtOpeningTag(htmlString, htmlBegin, injection)
  }

  if (htmlString.toLowerCase().startsWith('<!doctype')) {
    const lines = htmlString.split('\n')
    return [...slice(lines, 0, 1), injection, ...slice(lines, 1, 0)].join('\n')
  } else {
    return injection + '\n' + htmlString
  }
}

function injectEnd(htmlString: string, injection: string): string {
  const bodyClose = '</body>'
  if (htmlString.includes(bodyClose)) {
    return injectAtClosingTag(htmlString, bodyClose, injection)
  }

  const htmlClose = '</html>'
  if (htmlString.includes(htmlClose)) {
    return injectAtClosingTag(htmlString, htmlClose, injection)
  }

  return htmlString + '\n' + injection
}

function injectAtOpeningTag(htmlString: string, openingTag: RegExp, injection: string): string {
  const matches = htmlString.match(openingTag)
  assert(matches && matches.length >= 1)
  const tag = matches[0]
  assert(tag)
  const htmlParts = htmlString.split(tag)
  assert(htmlParts.length >= 2)

  // Insert `injection` after first `tag`
  const before = slice(htmlParts, 0, 1)
  const after = slice(htmlParts, 1, 0).join(tag)
  return before + tag + injection + after
}

function injectAtClosingTag(htmlString: string, closingTag: string, injection: string): string {
  assert(closingTag.startsWith('</'))
  assert(closingTag.endsWith('>'))
  assert(!closingTag.includes(' '))

  const htmlParts = htmlString.split(closingTag)
  assert(htmlParts.length >= 2)

  // Insert `injection` before last `closingTag`
  const before = slice(htmlParts, 0, -1).join(closingTag)
  const after = slice(htmlParts, -1, 0)
  return before + injection + closingTag + after
}

function inferAssetTag(pageAsset: PageAsset, isEsModule: boolean): string {
  const { src, assetType, mediaType, preloadType } = pageAsset
  assert(isEsModule === false || assetType === 'script' || preloadType === 'script')
  if (assetType === 'script') {
    assert(mediaType === 'text/javascript')
    if (isEsModule) {
      return `<script type="module" src="${src}"></script>`
    } else {
      return `<script src="${src}"></script>`
    }
  }
  if (assetType === 'style') {
    // CSS has utmost priority.
    // Would there be any advantage of using a preload tag for a css file instead of loading it right away?
    return `<link rel="stylesheet" type="text/css" href="${src}">`
  }
  if (assetType === 'preload') {
    if (preloadType === 'font') {
      // `crossorigin` is needed for fonts, see https://developer.mozilla.org/en-US/docs/Web/HTML/Link_types/preload#cors-enabled_fetches
      return `<link rel="preload" as="font" crossorigin type="${mediaType}" href="${src}">`
    }
    if (preloadType === 'script') {
      assert(mediaType === 'text/javascript')
      if (isEsModule) {
        return `<link rel="modulepreload" as="script" type="${mediaType}" href="${src}">`
      } else {
        return `<link rel="preload" as="script" type="${mediaType}" href="${src}">`
      }
    }
    const attributeAs = !preloadType ? '' : ` as="${preloadType}"`
    const attributeType = !mediaType ? '' : ` type="${mediaType}"`
    return `<link rel="preload" href="${src}"${attributeAs}${attributeType}>`
  }
  assert(false)
}

function ensureHeadTagExistence(htmlString: string): string {
  if (headOpen.test(htmlString)) {
    return htmlString
  }
  htmlString = injectBegin(htmlString, '<head></head>')
  return htmlString
}
