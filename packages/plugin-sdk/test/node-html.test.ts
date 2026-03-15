import { describe, it, expect, beforeAll } from 'vitest'
import { initParseHtml, parseHtml } from '../src/runtime/node-html'

beforeAll(async () => {
  await initParseHtml()
})

describe('parseHtml', () => {
  it('parses basic HTML and queries elements', () => {
    const doc = parseHtml('<html><body><div class="item"><span>Hello</span></div></body></html>')
    const span = doc.query('span')
    expect(span).not.toBeNull()
    expect(span!.text()).toBe('Hello')
  })

  it('queryAll returns multiple elements', () => {
    const doc = parseHtml('<ul><li>A</li><li>B</li><li>C</li></ul>')
    const items = doc.queryAll('li')
    expect(items).toHaveLength(3)
    expect(items.map((el) => el.text())).toEqual(['A', 'B', 'C'])
  })

  it('attr returns attribute value', () => {
    const doc = parseHtml('<a href="https://example.com">Link</a>')
    const link = doc.query('a')
    expect(link!.attr('href')).toBe('https://example.com')
    expect(link!.attr('missing')).toBeUndefined()
  })

  it('html returns innerHTML', () => {
    const doc = parseHtml('<div><b>bold</b></div>')
    const div = doc.query('div')
    expect(div!.html()).toContain('<b>bold</b>')
  })

  it('query returns null for no match', () => {
    const doc = parseHtml('<div>test</div>')
    expect(doc.query('.nonexistent')).toBeNull()
  })

  it('queryAll returns empty array for no match', () => {
    const doc = parseHtml('<div>test</div>')
    expect(doc.queryAll('.nonexistent')).toEqual([])
  })
})
