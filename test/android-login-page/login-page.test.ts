import { describe, it, expect, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { JSDOM, VirtualConsole } from 'jsdom'

/**
 * Behavioural tests for the Android login page (android/app/src/main/assets/login.html).
 *
 * The page is parsed and its inline scripts executed by jsdom with a stubbed
 * ClawBenchNative installed before parsing, so what runs here is the real markup and
 * the real handlers rather than a copy of them.
 */

const LOGIN_HTML = resolve(__dirname, '../../android/app/src/main/assets/login.html')

interface NativeCalls {
  startTailcat: Array<[string, number, string]>
  reconnectTailcat: string[]
  stopTailcat: number
  removeTailcatServer: number
  saveServer: Array<[string, string]>
  connectToServer: Array<[string, string]>
}

interface Harness {
  dom: JSDOM
  doc: Document
  win: Window & typeof globalThis
  calls: NativeCalls
}

let harness: Harness | null = null

afterEach(() => {
  harness?.dom.window.close()
  harness = null
})

async function loadLoginPage(
  state: Record<string, unknown> = {},
  options: { savedServers?: string; password?: string } = {},
): Promise<Harness> {
  const html = readFileSync(LOGIN_HTML, 'utf8')
  const calls: NativeCalls = {
    startTailcat: [],
    reconnectTailcat: [],
    stopTailcat: 0,
    removeTailcatServer: 0,
    saveServer: [],
    connectToServer: [],
  }

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    // The page's CSS is real but irrelevant here; keep the console quiet.
    virtualConsole: new VirtualConsole(),
    beforeParse(window) {
      const w = window as unknown as Record<string, unknown>
      w.ClawBenchNative = {
        getLanguage: () => 'zh',
        getTheme: () => 'github-dark',
        setTheme: () => {},
        getAppVersion: () => '1.2.3',
        getServerList: () => options.savedServers ?? '[]',
        removeServer: () => {},
        getPassword: () => options.password ?? '',
        getTailcatState: () =>
          JSON.stringify({
            transport: 'http',
            running: false,
            serverPort: 0,
            localPort: 0,
            hasAddress: false,
            ...state,
          }),
        saveServer: (url: string, password: string) => calls.saveServer.push([url, password]),
        connectToServer: (url: string, password: string) =>
          calls.connectToServer.push([url, password]),
        startTailcat: (address: string, serverPort: number, password: string) =>
          calls.startTailcat.push([address, serverPort, password]),
        reconnectTailcat: (password: string) => calls.reconnectTailcat.push(password),
        stopTailcat: () => {
          calls.stopTailcat += 1
        },
        removeTailcatServer: () => {
          calls.removeTailcatServer += 1
        },
      }
    },
  })

  const win = dom.window as unknown as Window & typeof globalThis
  await settle(dom)
  harness = { dom, doc: dom.window.document, win, calls }
  return harness
}

/** Waits for the page's DOMContentLoaded work to finish. */
async function settle(dom: JSDOM): Promise<void> {
  for (let i = 0; i < 100 && dom.window.document.readyState !== 'complete'; i++) {
    await new Promise((r) => setTimeout(r, 1))
  }
  await new Promise((r) => setTimeout(r, 0))
}

function submit(form: HTMLElement, win: Window): void {
  form.dispatchEvent(new win.Event('submit', { bubbles: true, cancelable: true }))
}

function setInput(doc: Document, id: string, value: string): void {
  const input = doc.getElementById(id) as HTMLInputElement
  input.value = value
}

describe('login page — connection mode switch', () => {
  it('starts in plain-address mode', async () => {
    const { doc } = await loadLoginPage()

    const http = doc.querySelector('input[name="addTransport"][value="http"]') as HTMLInputElement
    const tailcat = doc.querySelector('input[name="addTransport"][value="tailcat"]') as HTMLInputElement
    expect(http.checked).toBe(true)
    expect(tailcat.checked).toBe(false)

    expect(doc.getElementById('protocolGroup')!.style.display).not.toBe('none')
    expect(doc.getElementById('addHostRow')!.classList.contains('tailcat-mode')).toBe(false)
    expect(doc.getElementById('addHostLabel')!.textContent).toBe('服务器地址')
    expect(doc.getElementById('tailcatHint')!.style.display).toBe('none')
  })

  it('switching to Tailcat relabels the field and hides the protocol choice', async () => {
    const { doc } = await loadLoginPage()

    const tailcat = doc.querySelector('input[name="addTransport"][value="tailcat"]') as HTMLInputElement
    tailcat.checked = true
    tailcat.dispatchEvent(new doc.defaultView!.Event('change', { bubbles: true }))

    expect(doc.getElementById('protocolGroup')!.style.display).toBe('none')
    expect(doc.getElementById('addHostRow')!.classList.contains('tailcat-mode')).toBe(true)
    expect(doc.getElementById('addHostLabel')!.textContent).toBe('Tailcat 地址')
    expect(doc.getElementById('addHost')!.getAttribute('placeholder')).toBe('tc…')
    expect(doc.getElementById('tailcatHint')!.style.display).toBe('block')
  })

  it('switching back restores the plain-address labels', async () => {
    const { doc } = await loadLoginPage()
    const win = doc.defaultView!

    const tailcat = doc.querySelector('input[name="addTransport"][value="tailcat"]') as HTMLInputElement
    tailcat.checked = true
    tailcat.dispatchEvent(new win.Event('change', { bubbles: true }))

    const http = doc.querySelector('input[name="addTransport"][value="http"]') as HTMLInputElement
    http.checked = true
    http.dispatchEvent(new win.Event('change', { bubbles: true }))

    expect(doc.getElementById('addHostLabel')!.textContent).toBe('服务器地址')
    expect(doc.getElementById('addHost')!.getAttribute('placeholder')).toBe('192.168.1.100')
    expect(doc.getElementById('protocolGroup')!.style.display).not.toBe('none')
  })
})

describe('login page — Tailcat submit', () => {
  it('hands the address, port and password to native without saving a URL', async () => {
    const { doc, win, calls } = await loadLoginPage()

    const tailcat = doc.querySelector('input[name="addTransport"][value="tailcat"]') as HTMLInputElement
    tailcat.checked = true
    tailcat.dispatchEvent(new win.Event('change', { bubbles: true }))

    setInput(doc, 'addHost', '  tcAwoRGB8mLTQ7QklQV15lbHN6  ')
    setInput(doc, 'addPort', '20000')
    setInput(doc, 'addPassword', 'hunter2')
    submit(doc.getElementById('addServerForm')!, win)

    expect(calls.startTailcat).toEqual([['tcAwoRGB8mLTQ7QklQV15lbHN6', 20000, 'hunter2']])
    // A Tailcat address is not a URL: it must never reach the HTTP path.
    expect(calls.saveServer).toEqual([])
    expect(calls.connectToServer).toEqual([])
  })

  it('defaults the port to 20000 when the field is cleared', async () => {
    const { doc, win, calls } = await loadLoginPage()

    const tailcat = doc.querySelector('input[name="addTransport"][value="tailcat"]') as HTMLInputElement
    tailcat.checked = true
    tailcat.dispatchEvent(new win.Event('change', { bubbles: true }))

    setInput(doc, 'addHost', 'tcAAAA')
    setInput(doc, 'addPort', '')
    submit(doc.getElementById('addServerForm')!, win)

    expect(calls.startTailcat).toEqual([['tcAAAA', 20000, '']])
  })

  it('rejects an empty address before reaching native', async () => {
    const { doc, win, calls } = await loadLoginPage()

    const tailcat = doc.querySelector('input[name="addTransport"][value="tailcat"]') as HTMLInputElement
    tailcat.checked = true
    tailcat.dispatchEvent(new win.Event('change', { bubbles: true }))

    setInput(doc, 'addHost', '   ')
    setInput(doc, 'addPort', '20000')
    submit(doc.getElementById('addServerForm')!, win)

    expect(calls.startTailcat).toEqual([])
    expect(doc.getElementById('addErrorMsg')!.classList.contains('visible')).toBe(true)
    expect(doc.getElementById('addErrorText')!.textContent).toBe('请输入 Tailcat 地址')
  })

  it('rejects an out-of-range port before reaching native', async () => {
    const { doc, win, calls } = await loadLoginPage()

    const tailcat = doc.querySelector('input[name="addTransport"][value="tailcat"]') as HTMLInputElement
    tailcat.checked = true
    tailcat.dispatchEvent(new win.Event('change', { bubbles: true }))

    setInput(doc, 'addHost', 'tcAAAA')
    setInput(doc, 'addPort', '70000')
    submit(doc.getElementById('addServerForm')!, win)

    expect(calls.startTailcat).toEqual([])
    expect(doc.getElementById('addErrorText')!.textContent).toBe('请输入有效的端口（1-65535）')
  })
})

describe('login page — plain address path is unchanged', () => {
  it('composes a URL and both saves and connects', async () => {
    const { doc, win, calls } = await loadLoginPage()

    setInput(doc, 'addHost', '192.168.1.10')
    setInput(doc, 'addPort', '20000')
    setInput(doc, 'addPassword', 'pw')
    submit(doc.getElementById('addServerForm')!, win)

    expect(calls.saveServer).toEqual([['https://192.168.1.10:20000', 'pw']])
    expect(calls.connectToServer).toEqual([['https://192.168.1.10:20000', 'pw']])
    expect(calls.startTailcat).toEqual([])
  })

  it('falls back to the scheme default port', async () => {
    const { doc, win, calls } = await loadLoginPage()

    setInput(doc, 'addHost', 'box.example.com')
    setInput(doc, 'addPort', '')
    submit(doc.getElementById('addServerForm')!, win)

    expect(calls.connectToServer).toEqual([['https://box.example.com:443', '']])
  })
})

describe('login page — saved Tailcat card', () => {
  it('stays hidden when no address has been saved', async () => {
    const { doc } = await loadLoginPage({ hasAddress: false })
    expect(doc.getElementById('tailcatSection')!.style.display).toBe('none')
  })

  it('shows the saved port when disconnected', async () => {
    const { doc } = await loadLoginPage({
      transport: 'tailcat',
      hasAddress: true,
      serverPort: 20000,
      running: false,
    })

    const section = doc.getElementById('tailcatSection')!
    expect(section.style.display).toBe('flex')
    expect(doc.getElementById('tailcatItemLabel')!.textContent).toBe('Tailcat · :20000')
    expect(doc.getElementById('tailcatItem')!.classList.contains('active')).toBe(false)
  })

  it('shows the loopback port while running', async () => {
    const { doc } = await loadLoginPage({
      transport: 'tailcat',
      hasAddress: true,
      serverPort: 20000,
      localPort: 54321,
      running: true,
    })

    expect(doc.getElementById('tailcatItemLabel')!.textContent)
      .toBe('Tailcat · 127.0.0.1:54321')
    expect(doc.getElementById('tailcatItem')!.classList.contains('active')).toBe(true)
  })

  it('hides the password field when a password is already saved', async () => {
    const { doc } = await loadLoginPage(
      { hasAddress: true, serverPort: 20000 },
      { password: 'saved' },
    )
    expect(doc.getElementById('tailcatPasswordGroup')!.style.display).toBe('none')
  })

  it('asks for a password when none is saved', async () => {
    const { doc } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })
    expect(doc.getElementById('tailcatPasswordGroup')!.style.display).toBe('block')
  })

  it('connect hands over the typed password and the address stays native', async () => {
    const { doc, win, calls } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })

    setInput(doc, 'tailcatPassword', 'typed')
    doc.getElementById('tailcatConnectBtn')!.dispatchEvent(new win.Event('click', { bubbles: true }))

    expect(calls.reconnectTailcat).toEqual(['typed'])
  })

  it('connect with a saved password does not require the field', async () => {
    const { doc, win, calls } = await loadLoginPage(
      { hasAddress: true, serverPort: 20000 },
      { password: 'saved' },
    )

    doc.getElementById('tailcatConnectBtn')!.dispatchEvent(new win.Event('click', { bubbles: true }))

    expect(calls.reconnectTailcat).toEqual(['saved'])
  })

  it('refuses to connect with no password at all', async () => {
    const { doc, win, calls } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })

    doc.getElementById('tailcatConnectBtn')!.dispatchEvent(new win.Event('click', { bubbles: true }))

    expect(calls.reconnectTailcat).toEqual([])
    expect(doc.getElementById('tailcatErrorText')!.textContent).toBe('请输入密码')
  })

  it('disconnect tells native to tear the tunnel down', async () => {
    const { doc, win, calls } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })

    doc.getElementById('tailcatStopBtn')!.dispatchEvent(new win.Event('click', { bubbles: true }))

    expect(calls.stopTailcat).toBe(1)
  })
})

describe('login page — removing the saved Tailcat address', () => {
  const flush = () => new Promise((r) => setTimeout(r, 0))

  it('confirms before deleting, then wipes the address natively', async () => {
    const { doc, win, calls } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })

    doc.getElementById('tailcatDeleteBtn')!.dispatchEvent(new win.Event('click', { bubbles: true }))

    // Nothing may be deleted before the user confirms: the address is a bearer
    // credential, so removal has to be deliberate.
    expect(calls.removeTailcatServer).toBe(0)
    expect(doc.getElementById('dlgOverlay')!.classList.contains('visible')).toBe(true)
    expect(doc.getElementById('dlgTitle')!.textContent).toBe('删除 Tailcat 地址')
    expect(doc.getElementById('dlgMsg')!.textContent).toBe('删除已保存的 Tailcat 地址？')

    doc.getElementById('dlgOk')!.dispatchEvent(new win.Event('click', { bubbles: true }))
    await flush()

    expect(calls.removeTailcatServer).toBe(1)
  })

  it('cancelling leaves the saved address alone', async () => {
    const { doc, win, calls } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })

    doc.getElementById('tailcatDeleteBtn')!.dispatchEvent(new win.Event('click', { bubbles: true }))
    doc.getElementById('dlgCancel')!.dispatchEvent(new win.Event('click', { bubbles: true }))
    await flush()

    expect(calls.removeTailcatServer).toBe(0)
  })

  it('labels the delete button in the page language', async () => {
    const { doc } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })
    expect(doc.getElementById('tailcatDeleteBtn')!.title).toBe('删除')
  })

  it('keeps disconnect and delete as separate actions', async () => {
    // Disconnect must not delete: losing the blob on every disconnect would force a
    // re-paste of a credential the user only wanted to pause.
    const { doc, win, calls } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })

    doc.getElementById('tailcatStopBtn')!.dispatchEvent(new win.Event('click', { bubbles: true }))
    await flush()

    expect(calls.stopTailcat).toBe(1)
    expect(calls.removeTailcatServer).toBe(0)
  })
})

describe('login page — error routing after a reconnect', () => {
  it('a failed Tailcat reconnect lands on the Tailcat card', async () => {
    const { win, doc } = await loadLoginPage({ hasAddress: true, serverPort: 20000 })

    ;(win as unknown as { onConnectError: (m: string, c: string) => void })
      .onConnectError('无法通过 Tailcat 连接，请检查地址与网络。', 'tailcat_reconnect')

    expect(doc.getElementById('tailcatErrorMsg')!.classList.contains('visible')).toBe(true)
    expect(doc.getElementById('tailcatErrorText')!.textContent)
      .toBe('无法通过 Tailcat 连接，请检查地址与网络。')
    // The plain-address form must not be blamed for a Tailcat failure.
    expect(doc.getElementById('errorMsg')!.classList.contains('visible')).toBe(false)
  })

  it('an auth error still reveals the password field on the plain form', async () => {
    const { win, doc } = await loadLoginPage(
      { hasAddress: false },
      {
        savedServers: JSON.stringify([{ url: 'https://box.example.com:20000', password: 'pw' }]),
      },
    )

    ;(win as unknown as { onConnectError: (m: string, c: string) => void })
      .onConnectError('密码错误', 'password')

    expect(doc.getElementById('errorMsg')!.classList.contains('visible')).toBe(true)
    expect(doc.getElementById('passwordGroup')!.style.display).toBe('block')
  })
})

describe('login page — startup wiring', () => {
  it('renders the app version and applies the saved theme', async () => {
    const { doc } = await loadLoginPage()
    expect(doc.getElementById('version')!.textContent).toBe('v1.2.3')
    expect(doc.documentElement.getAttribute('data-theme')).toBe('github-dark')
  })

  it('has the same keys in both languages', () => {
    // t() falls back to the key name itself, so a key present in one language and
    // missing from the other renders as "enter_tailcat_address" to the user. This
    // caught exactly that on the Tailcat strings.
    const html = readFileSync(LOGIN_HTML, 'utf8')
    const block = (name: string) => {
      const match = html.match(new RegExp(`\\b${name}\\s*:\\s*\\{([\\s\\S]*?)\\n    \\}`))
      if (!match) throw new Error(`no ${name} block`)
      return new Set([...match[1].matchAll(/^\s+([a-z_0-9]+):/gm)].map((m) => m[1]))
    }

    const en = block('en')
    const zh = block('zh')
    expect(en.size).toBeGreaterThan(20)
    expect([...en].filter((k) => !zh.has(k))).toEqual([])
    expect([...zh].filter((k) => !en.has(k))).toEqual([])
  })
})
