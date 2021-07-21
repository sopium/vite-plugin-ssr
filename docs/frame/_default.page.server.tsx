import ReactDOMServer from 'react-dom/server'
import React from 'react'
import logo from './icons/vite-plugin-ssr.svg'
import { html } from 'vite-plugin-ssr'
import { PageLayout } from './PageLayout'
import { Heading, headings as headings_, parse } from '../headings'
import { assert, jsxToTextContent } from '../utils'
import type { HeadingExtracted } from '../vite.config/vite-plugin-mdx-export-headings'

type ReactComponent = () => JSX.Element
declare global {
  interface ImportMeta {
    glob: (path: string) => Record<string, () => Promise<{ default: ReactComponent }>>
    globEager: (path: string) => Record<string, { default: ReactComponent }>
  }
}

export { render }

type PageExports = {
  headings?: HeadingExtracted[]
  noHeading?: true
  pageTitle?: string
}
type PageContext = {
  url: string
  Page: ReactComponent
  PageContent: ReactComponent
  headings: Heading[]
  pageExports: PageExports
}
function render(pageContext: PageContext) {
  const headings = clone(headings_)
  const activeHeading = findActiveHeading(headings, pageContext)
  addSubHeadings(headings, pageContext, activeHeading)
  const { Page } = pageContext
  const { title, desc, isLandingPage, pageTitle } = getMetaData(activeHeading, pageContext)
  const page = (
    <PageLayout headings={headings} activeHeading={activeHeading} isLandingPage={isLandingPage} pageTitle={pageTitle}>
      <Page />
    </PageLayout>
  )
  const pageHtml = ReactDOMServer.renderToString(page)
  return html`<!DOCTYPE html>
    <html>
      <head>
        <link rel="icon" href="${logo}" />
        <title>${title}</title>
        ${desc}
        <meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no" />
      </head>
      <body>
        <div id="page-view">${html.dangerouslySkipEscape(pageHtml)}</div>
      </body>
    </html>`
}

function getMetaData(activeHeading: Heading | null, pageContext: { url: string; pageExports: PageExports }) {
  const { url, pageExports } = pageContext
  const isLandingPage = url === '/'

  let title: string
  let pageTitle: string | JSX.Element | null
  if (pageExports.pageTitle) {
    title = pageExports.pageTitle
    pageTitle = title
  } else if (!activeHeading) {
    title = url.slice(1)
    assert(!title.startsWith('/'))
    pageTitle = null
  } else {
    title = activeHeading.titleDocument || jsxToTextContent(activeHeading.title)
    pageTitle = activeHeading.title
  }

  if (!isLandingPage) {
    title += ' | vite-plugin-ssr'
  }

  if (isLandingPage) {
    pageTitle = null
  }

  const desc = isLandingPage
    ? html.dangerouslySkipEscape(
        '<meta name="description" content="Like Next.js / Nuxt but as do-one-thing-do-it-well Vite plugin." />'
      )
    : ''
  return { title, desc, isLandingPage, pageTitle }
}

function findActiveHeading(
  headings: Heading[],
  pageContext: { url: string; pageExports: PageExports }
): Heading | null {
  let activeHeading: Heading | null = null
  assert(pageContext.url)
  headings.forEach((heading) => {
    if (heading.url === pageContext.url) {
      activeHeading = heading
      assert(heading.level === 2)
      heading.isActive = true
    }
  })
  const debugInfo = {
    msg: 'Heading not found for url: ' + pageContext.url,
    urls: headings.map((h) => h.url),
    url: pageContext.url
  }
  assert(activeHeading || pageContext.pageExports.noHeading === true, debugInfo)
  return activeHeading
}

function addSubHeadings(headings: Heading[], pageContext: { pageExports: PageExports }, activeHeading: Heading | null) {
  if (activeHeading === null) return
  const activeHeadingIdx = headings.indexOf(activeHeading)
  assert(activeHeadingIdx >= 0)
  const pageHeadings = pageContext.pageExports.headings || []
  pageHeadings.forEach((pageHeading, i) => {
    const title = parse(pageHeading.title)
    const url = '#' + pageHeading.id
    const heading: Heading = {
      url,
      title,
      level: 3
    }
    headings.splice(activeHeadingIdx + 1 + i, 0, heading)
  })
}

function clone(headings: Heading[]): Heading[] {
  return headings.map((h) => ({ ...h }))
}