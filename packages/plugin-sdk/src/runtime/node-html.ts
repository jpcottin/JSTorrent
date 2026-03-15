import type { SearchPluginHtmlNode } from '../types.js'

let DOMParserImpl: typeof globalThis.DOMParser | undefined

async function getDOMParser(): Promise<typeof globalThis.DOMParser> {
  if (DOMParserImpl) return DOMParserImpl

  if (typeof globalThis.DOMParser !== 'undefined') {
    DOMParserImpl = globalThis.DOMParser
    return DOMParserImpl
  }

  const { Window } = await import('happy-dom')
  const window = new Window()
  DOMParserImpl = window.DOMParser as unknown as typeof globalThis.DOMParser
  return DOMParserImpl
}

function wrapElement(element: Element | Document): SearchPluginHtmlNode {
  return {
    text() {
      return element.textContent || ''
    },
    html() {
      return 'innerHTML' in element ? (element as Element).innerHTML : ''
    },
    attr(name: string) {
      if ('getAttribute' in element) {
        const value = element.getAttribute(name)
        return value == null ? undefined : value
      }
      return undefined
    },
    query(selector: string) {
      if (!('querySelector' in element)) return null
      const node = element.querySelector(selector)
      return node ? wrapElement(node) : null
    },
    queryAll(selector: string) {
      if (!('querySelectorAll' in element)) return []
      return Array.from(element.querySelectorAll(selector)).map(wrapElement)
    },
  }
}

let initPromise: Promise<typeof globalThis.DOMParser> | undefined

export function initParseHtml(): Promise<void> {
  if (!initPromise) {
    initPromise = getDOMParser()
  }
  return initPromise.then(() => {})
}

export function parseHtml(html: string): SearchPluginHtmlNode {
  if (!DOMParserImpl) {
    throw new Error(
      'parseHtml is not initialized. Call `await initParseHtml()` before using parseHtml.',
    )
  }
  const document = new DOMParserImpl().parseFromString(html, 'text/html')
  return wrapElement(document)
}
