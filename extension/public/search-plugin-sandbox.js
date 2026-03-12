(function () {
  const CHANNEL_FLAG = '__jstSearchPluginSandbox'
  let nextFetchRequestId = 1
  const pendingFetches = new Map()

  function postMessageToParent(payload) {
    window.parent.postMessage(
      {
        [CHANNEL_FLAG]: true,
        ...payload,
      },
      '*',
    )
  }

  function wrapElement(element) {
    return {
      text() {
        return element.textContent || ''
      },
      html() {
        return 'innerHTML' in element ? element.innerHTML : ''
      },
      attr(name) {
        if ('getAttribute' in element) {
          const value = element.getAttribute(name)
          return value == null ? undefined : value
        }
        return undefined
      },
      query(selector) {
        if (!('querySelector' in element)) return null
        const node = element.querySelector(selector)
        return node ? wrapElement(node) : null
      },
      queryAll(selector) {
        if (!('querySelectorAll' in element)) return []
        return Array.from(element.querySelectorAll(selector)).map(wrapElement)
      },
    }
  }

  function parseHtml(html) {
    const document = new DOMParser().parseFromString(html, 'text/html')
    return wrapElement(document)
  }

  function transformModuleSource(source) {
    const exportedNames = []
    let transformed = source

    transformed = transformed.replace(/export\s+const\s+([A-Za-z_$][\w$]*)\s*=/g, (_, name) => {
      exportedNames.push(name)
      return `const ${name} =`
    })

    transformed = transformed.replace(
      /export\s+(async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g,
      (_, asyncKeyword, name) => {
        exportedNames.push(name)
        return `${asyncKeyword || ''}function ${name}(`
      },
    )

    if (/\bexport\s+default\b/.test(transformed)) {
      throw new Error('export default is not supported yet')
    }

    if (/\bexport\s+/.test(transformed)) {
      throw new Error('Unsupported export syntax in plugin source')
    }

    const exportLines = exportedNames
      .map((name) => `exports.${name} = typeof ${name} !== 'undefined' ? ${name} : undefined;`)
      .join('\n')

    return `${transformed}\n${exportLines}\nreturn exports;`
  }

  function buildFailureResult(phase, error, durationMs, logs, requests) {
    return {
      trace: {
        ok: false,
        durationMs,
        results: [],
        logs,
        requests,
        error: {
          phase,
          name: error && error.name ? error.name : 'Error',
          message: error && error.message ? error.message : String(error),
          stack: error && error.stack ? String(error.stack) : undefined,
        },
      },
    }
  }

  function loadModule(source) {
    const transformed = transformModuleSource(source)
    return new Function('exports', transformed)(Object.create(null))
  }

  function inspectSource(source) {
    const module = loadModule(source)
    const manifest = module && typeof module.manifest === 'object' ? module.manifest : undefined
    if (!manifest || typeof manifest.name !== 'string' || !Array.isArray(manifest.hosts)) {
      throw new Error('Plugin manifest must export `name` and `hosts`')
    }
    if (!module || typeof module.search !== 'function') {
      throw new Error('Plugin must export a `search(ctx, input)` function')
    }
    return { manifest }
  }

  function requestHostFetch(requestId, fetchInput) {
    return new Promise((resolve, reject) => {
      const fetchRequestId = nextFetchRequestId++
      pendingFetches.set(fetchRequestId, { resolve, reject })
      postMessageToParent({
        type: 'fetch-request',
        requestId,
        fetchRequestId,
        input: fetchInput,
      })
    })
  }

  async function executeDraft(requestId, source, input) {
    const startTime = performance.now()
    const results = []
    const logs = []
    const requests = []

    function log(level, message) {
      logs.push({
        level,
        message,
      })
    }

    async function fetchText(fetchInput) {
      const method = fetchInput.method || 'GET'
      const requestStart = performance.now()
      const requestTrace = {
        url: fetchInput.url,
        method,
      }
      requests.push(requestTrace)

      try {
        const response = await requestHostFetch(requestId, fetchInput)
        requestTrace.status = response.statusCode
        requestTrace.durationMs = Math.round(performance.now() - requestStart)
        requestTrace.bytes = response.bytes
        requestTrace.remoteAddress = response.remoteAddress

        if (response.statusCode >= 400) {
          requestTrace.error = `HTTP ${response.statusCode}`
          throw new Error(`Request failed for ${fetchInput.url}: HTTP ${response.statusCode}`)
        }

        return response.bodyText
      } catch (error) {
        requestTrace.durationMs = Math.round(performance.now() - requestStart)
        requestTrace.error = error && error.message ? error.message : String(error)
        throw error
      }
    }

    const ctx = {
      encode(value) {
        return encodeURIComponent(value)
      },
      fetchText,
      async fetchJson(fetchInput) {
        return JSON.parse(await fetchText(fetchInput))
      },
      parseHtml,
      emitResult(result) {
        results.push(result)
      },
      log,
    }

    let module
    try {
      module = loadModule(source)
    } catch (error) {
      return buildFailureResult(
        'load',
        error,
        Math.round(performance.now() - startTime),
        logs,
        requests,
      )
    }

    const manifest = module && typeof module.manifest === 'object' ? module.manifest : undefined
    if (!manifest || typeof manifest.name !== 'string' || !Array.isArray(manifest.hosts)) {
      return buildFailureResult(
        'manifest',
        new Error('Plugin manifest must export `name` and `hosts`'),
        Math.round(performance.now() - startTime),
        logs,
        requests,
      )
    }

    if (!module || typeof module.search !== 'function') {
      return buildFailureResult(
        'manifest',
        new Error('Plugin must export a `search(ctx, input)` function'),
        Math.round(performance.now() - startTime),
        logs,
        requests,
      )
    }

    try {
      await module.search(ctx, input)
      return {
        manifest,
        trace: {
          ok: true,
          durationMs: Math.round(performance.now() - startTime),
          results,
          logs,
          requests,
        },
      }
    } catch (error) {
      return {
        manifest,
        ...buildFailureResult(
          'search',
          error,
          Math.round(performance.now() - startTime),
          logs,
          requests,
        ),
      }
    }
  }

  window.addEventListener('message', async (event) => {
    const data = event.data
    if (!data || data[CHANNEL_FLAG] !== true) return

    if (data.type === 'fetch-response') {
      const pending = pendingFetches.get(data.fetchRequestId)
      if (!pending) return
      pendingFetches.delete(data.fetchRequestId)

      if (data.error) {
        pending.reject(new Error(data.error.message || 'Host fetch failed'))
      } else {
        pending.resolve(data.response)
      }
      return
    }

    if (data.type === 'run-draft') {
      const result = await executeDraft(data.requestId, data.source, data.input)
      postMessageToParent({
        type: 'run-result',
        requestId: data.requestId,
        result,
      })
      return
    }

    if (data.type === 'inspect-source') {
      try {
        const inspection = inspectSource(data.source)
        postMessageToParent({
          type: 'inspect-result',
          requestId: data.requestId,
          inspection,
        })
      } catch (error) {
        postMessageToParent({
          type: 'inspect-result',
          requestId: data.requestId,
          error: {
            name: error && error.name ? error.name : 'Error',
            message: error && error.message ? error.message : String(error),
            stack: error && error.stack ? String(error.stack) : undefined,
          },
        })
      }
    }
  })

  postMessageToParent({ type: 'ready' })
})()
