/**
 * dsh-plugin-speech — browser half.
 *
 * One module for both directions:
 *  - read-aloud (`tts`): a Listen control on each finalized assistant reply,
 *    autoplay for completed turns, a transport bar, and a composer panel for
 *    server/model/voice/rate;
 *  - dictation (`stt`): a composer microphone, a live level bar, and a panel for
 *    provider/model/language; the transcript is inserted where the caret was
 *    when recording began.
 *
 * The browser never reaches an engine directly: both halves call the same-origin
 * `/tts/*` and `/stt/*` routes. Each half mounts only when its route answers; a
 * probe failure (not a 404) mounts it anyway, because a slow Host must not hide
 * the UI.
 *
 * Hand-authored bundle: `window.__ModuleLoader__.load` registers one factory; the
 * factory receives the shell's baseline `require` (react, react-dom, and the
 * client primitives are baseline modules).
 */
window.__ModuleLoader__.load({
  id: 'dsh-plugin-speech',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports

    const React = require('react')
    const { createPortal } = require('react-dom')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement

    /** Locale namespaces owned by the two halves. */
    const TTS_NS = 'tts'
    const STT_NS = 'stt'
    /** Same-origin routes owned by the two halves. */
    const TTS_ROUTES = { info: '/tts/info', speak: '/tts/speak' }
    const STT_ROUTES = { info: '/stt/info', transcribe: '/stt/transcribe' }
    /** Persisted browser preferences. */
    const TTS_SETTINGS_KEY = 'dsh.speech.tts.v1'
    const STT_SETTINGS_KEY = 'dsh.speech.stt.v1'
    /** Longest text group sent in one synthesis request, in characters. */
    const CHUNK_CHARS = 380
    /** Stand-in for a decimal point while sentences are being split. */
    const DECIMAL = '\u0001'
    /** Rate the transcription endpoints expect. */
    const SAMPLE_RATE = 16000
    /** Level sampling period and most waveform columns kept. */
    const LEVEL_INTERVAL_MS = 80
    const WAVE_BARS = 120
    /** Speed choices offered when the Host reports none. */
    const FALLBACK_SPEEDS = [0.75, 1, 1.25, 1.5, 2]
    /** The browser highlight registry entry the spoken sentence is painted under. */
    const HIGHLIGHT_NAME = 'dsh-speech-reading'
    /** Elements whose text must never be searched for spoken prose. */
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'PRE'])

    /* ------------------------------------------------------------------ locale */

    const ttsEn = {
      'action.listen': 'Listen',
      'action.stop': 'Stop',
      'panel.aria': 'Read-aloud settings',
      'panel.title': 'Read replies aloud',
      'autoplay': 'Read new replies automatically',
      'highlight': 'Highlight the sentence being read',
      'server': 'Server',
      'model': 'Model',
      'voice': 'Voice',
      'speed': 'Speed',
      'readLast': 'Read the last reply',
      'status.none': 'No speech server is configured. Add an OpenAI-compatible audio provider to the profile.',
      'status.ready': 'Using {server} / {model}',
      'player.pause': 'Pause',
      'player.resume': 'Resume',
      'player.stop': 'Stop',
      'status.failed': 'Read-aloud failed',
      'status.hint.default': 'The speech server did not answer — check the speech settings.',
      'status.hint.network': 'The connection to the speech server dropped — try again.',
      'status.hint.server': 'The speech server refused the request — check the speech settings.',
      'status.hint.blocked': 'The browser blocked autoplay — press Listen on the reply.',
      'status.hint.empty': 'This reply has no readable text.',
      'status.hint.playback': 'The browser could not play the audio — try again.',
      'hint': 'Speech is synthesized by the configured model provider; the browser only receives the audio.',
    }

    const ttsZh = {
      'action.listen': '朗读',
      'action.stop': '停止',
      'panel.aria': '朗读设置',
      'panel.title': '朗读回复',
      'autoplay': '自动朗读新回复',
      'highlight': '朗读时高亮当前句',
      'server': '服务',
      'model': '模型',
      'voice': '声音',
      'speed': '语速',
      'readLast': '朗读最后一条回复',
      'status.none': '没有配置语音服务。请在配置中添加一个兼容 OpenAI 音频接口的模型提供方。',
      'status.ready': '正在使用 {server} / {model}',
      'player.pause': '暂停',
      'player.resume': '继续',
      'player.stop': '停止',
      'status.failed': '朗读失败',
      'status.hint.default': '语音服务没有响应，请检查语音设置。',
      'status.hint.network': '与语音服务的连接中断了，请再试一次。',
      'status.hint.server': '语音服务拒绝了请求，请检查语音设置。',
      'status.hint.blocked': '浏览器拦截了自动播放，请点击回复上的朗读按钮。',
      'status.hint.empty': '这条回复没有可朗读的文本。',
      'status.hint.playback': '浏览器无法播放这段音频，请再试一次。',
      'hint': '语音由配置的模型提供方合成，浏览器只接收音频。',
    }

    const sttEn = {
      'trigger': 'Dictate',
      'panel.aria': 'Dictation settings',
      'panel.title': 'Voice input',
      'server': 'Server',
      'model': 'Model',
      'language': 'Language',
      'start': 'Start dictating',
      'stop': 'Stop and transcribe',
      'cancel': 'Cancel',
      'working': 'Transcribing…',
      'status.none': 'No transcription provider — configure one as a model provider with an explicit base URL.',
      'status.ready': 'Using {server} / {model}',
      'status.denied': 'Microphone permission was refused.',
      'status.insecure': 'The microphone needs a secure origin (loopback or HTTPS).',
      'status.empty': 'Nothing was recognised.',
      'hint': 'Recording happens in the page; the audio goes to your configured provider.',
    }

    const sttZh = {
      'trigger': '听写',
      'panel.aria': '听写设置',
      'panel.title': '语音输入',
      'server': '服务',
      'model': '模型',
      'language': '语言',
      'start': '开始听写',
      'stop': '停止并转写',
      'cancel': '取消',
      'working': '正在转写…',
      'status.none': '没有可用的转写服务。请配置一个带有明确 baseURL 的模型提供方。',
      'status.ready': '正在使用 {server} / {model}',
      'status.denied': '麦克风权限被拒绝。',
      'status.insecure': '麦克风需要安全上下文（回环地址或 HTTPS）。',
      'status.empty': '没有识别到语音。',
      'hint': '录音在页面内完成，音频发送到你配置的模型提供方。',
    }

    /* ------------------------------------------------------------------- store */

    /**
     * Minimal observable store (`getSnapshot`/`subscribe`), the shape the slot
     * hooks read.
     * @param initial - first value.
     */
    function createStore (initial) {
      let value = initial
      const listeners = new Set()
      return {
        getSnapshot: () => value,
        subscribe (listener) {
          listeners.add(listener)
          return () => { listeners.delete(listener) }
        },
        set (next) {
          if (Object.is(next, value)) return
          value = next
          for (const listener of [...listeners]) listener()
        },
        update (patch) {
          this.set({ ...value, ...patch })
        },
      }
    }

    /**
     * Browser preferences, persisted in localStorage.
     * @param key - storage key.
     * @param fallback - values used before anything is stored.
     * @param restore - narrow one parsed object onto the fallback shape.
     * @returns a store with `save(patch)`.
     */
    function createSettingsStore (key, fallback, restore) {
      let initial = fallback
      try {
        const raw = window.localStorage.getItem(key)
        const parsed = raw === null ? null : JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') initial = restore(parsed, fallback)
      } catch {
        /* storage unavailable: session-only preferences */
      }
      const store = createStore(initial)
      return {
        ...store,
        save (patch) {
          store.update(patch)
          try {
            window.localStorage.setItem(key, JSON.stringify(store.getSnapshot()))
          } catch {
            /* quota/denied storage: preference lives for this page only */
          }
        },
      }
    }

    /* ------------------------------------------------------------------- http */

    /**
     * Read one JSON error body, keeping the Host's message when it has one.
     * @param response - refused fetch response.
     * @param what - fallback description.
     */
    async function errorOf (response, what) {
      let message = `${what} failed (${response.status})`
      let code = 'server'
      try {
        const payload = await response.json()
        if (typeof payload?.error?.message === 'string') message = payload.error.message
        if (typeof payload?.error?.code === 'string') code = payload.error.code
      } catch { /* non-JSON failure body */ }
      const error = new Error(message)
      error.code = response.status === 401 || response.status === 403 ? 'network' : code
      return error
    }

    /**
     * Fetch one same-origin JSON route.
     * @param url - route.
     * @param init - fetch options.
     * @returns the parsed body.
     */
    async function requestJson (url, init) {
      const response = await fetch(url, { headers: { accept: 'application/json' }, ...init })
      if (!response.ok) throw await errorOf(response, url)
      return response.json()
    }

    /* ------------------------------------------------------------------- speech */

    /**
     * Strip Markdown structure so the engine reads prose, not syntax.
     * @param text - assistant markdown.
     * @returns speakable prose.
     */
    function cleanForSpeech (text) {
      return String(text)
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`([^`]*)`/g, '$1')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/^#{1,6}\s+/gm, '')
        .replace(/^\s*[-*+]\s+/gm, '')
        .replace(/^\s*\d+\.\s+/gm, '')
        .replace(/[*_~]{1,3}([^*_~]+)[*_~]{1,3}/g, '$1')
        .replace(/\s+/g, ' ')
        .trim()
    }

    /**
     * Break one over-long sentence at commas, then at spaces.
     * @param sentence - sentence longer than the budget.
     * @param max - character budget.
     */
    function hardSplit (sentence, max) {
      const pieces = []
      const parts = sentence.split(/(?<=[,;:])\s+/)
      let buffer = ''
      const flush = () => {
        const value = buffer.trim()
        if (value !== '') pieces.push(value)
        buffer = ''
      }
      for (const part of parts) {
        if (part.length > max) {
          flush()
          let line = ''
          for (const word of part.split(/\s+/)) {
            if (line === '') line = word
            else if (line.length + 1 + word.length <= max) line = `${line} ${word}`
            else {
              pieces.push(line)
              line = word
            }
          }
          if (line !== '') pieces.push(line)
          continue
        }
        if (buffer === '') buffer = part
        else if (buffer.length + 1 + part.length <= max) buffer = `${buffer} ${part}`
        else {
          flush()
          buffer = part
        }
      }
      flush()
      return pieces
    }

    /**
     * Split prose into sentence-sized groups under the budget.
     * @param text - prose.
     * @param max - character budget per group.
     * @returns the groups.
     */
    function splitChunks (text, max = CHUNK_CHARS) {
      const prose = String(text).trim()
      if (prose === '') return []
      const guarded = prose.replace(/(\d)\.(\d)/g, (_, before, after) => `${before}${DECIMAL}${after}`)
      const sentences = guarded.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [guarded]
      const groups = []
      let buffer = ''
      const flush = () => {
        const value = buffer.trim()
        if (value !== '') groups.push(value)
        buffer = ''
      }
      for (const sentence of sentences) {
        const piece = sentence.trim()
        if (piece === '') continue
        const parts = piece.length > max ? hardSplit(piece, max) : [piece]
        for (const part of parts) {
          if (buffer === '') buffer = part
          else if (buffer.length + 1 + part.length <= max) buffer = `${buffer} ${part}`
          else {
            flush()
            buffer = part
          }
        }
      }
      flush()
      return groups.map((group) => group.replaceAll(DECIMAL, '.'))
    }

    /** RMS of one analyser frame, scaled so speech fills the bar. */
    function levelOf (buffer) {
      let sum = 0
      for (const sample of buffer) sum += sample * sample
      return Math.min(1, Math.sqrt(sum / buffer.length) * 6)
    }

    /**
     * Collapse whitespace the way {@link flattenText} does.
     * @param value - raw prose.
     * @returns single-spaced, trimmed text.
     */
    function normalizeForSearch (value) {
      return String(value).replace(/\s+/g, ' ').trim()
    }

    /**
     * Collect the visible text of one or more subtrees as one whitespace-normalized
     * string, together with the node/offset each character came from.
     * @param roots - nodes to read, in reading order.
     * @returns flattened text and its position map.
     */
    function flattenText (roots) {
      const containers = Array.isArray(roots) ? roots : [roots]
      const nodes = []
      for (const root of containers) {
        if (root === null || root === undefined || typeof root !== 'object') continue
        const walker = document.createTreeWalker(root, window.NodeFilter?.SHOW_TEXT ?? 4, null)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = node.parentElement
          if (parent === null) continue
          if (SKIP_TAGS.has(parent.tagName)) continue
          if (parent.closest('.dsh-speech-panel') !== null) continue
          if (parent.closest('[data-dsh-speech-ignore]') !== null) continue
          nodes.push(node)
        }
      }
      let text = ''
      const map = []
      for (const node of nodes) {
        const value = node.nodeValue ?? ''
        for (let offset = 0; offset < value.length; offset++) {
          const character = value[offset]
          if (/\s/.test(character)) {
            if (text.endsWith(' ')) continue
            text += ' '
            map.push({ node, offset })
            continue
          }
          text += character
          map.push({ node, offset })
        }
      }
      return { text, map }
    }

    /**
     * Read a subtree as word tokens with their exact DOM positions.
     * @param roots - subtrees to read, in reading order.
     * @returns tokens in reading order.
     */
    function tokenize (roots) {
      const containers = Array.isArray(roots) ? roots : [roots]
      const tokens = []
      for (const root of containers) {
        if (root === null || root === undefined || typeof root !== 'object') continue
        const walker = document.createTreeWalker(root, window.NodeFilter?.SHOW_TEXT ?? 4, null)
        for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
          const parent = node.parentElement
          if (parent === null) continue
          if (SKIP_TAGS.has(parent.tagName)) continue
          if (parent.closest('pre') !== null) continue
          if (parent.closest('.dsh-speech-panel') !== null) continue
          if (parent.closest('[data-dsh-speech-ignore]') !== null) continue
          const value = node.nodeValue ?? ''
          for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
            tokens.push({ word: match[0].toLowerCase(), node, start: match.index, end: match.index + match[0].length })
          }
        }
      }
      return tokens
    }

    /**
     * Match a sentence by its words, tolerating punctuation and markup between them.
     * @param roots - subtrees to search.
     * @param sentence - prose about to be spoken.
     * @param preferLast - pick the newest match.
     * @returns a DOM range covering the sentence, or null.
     */
    function findWordRange (roots, sentence, preferLast) {
      const wanted = String(sentence).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      if (wanted.length === 0) return null
      const tokens = tokenize(roots)
      if (tokens.length < wanted.length) return null
      const found = []
      let shortest = Number.POSITIVE_INFINITY
      for (let start = 0; start < tokens.length; start++) {
        if (tokens[start].word !== wanted[0]) continue
        let wantedAt = 1
        let tokenAt = start + 1
        let gap = 0
        let last = start
        while (wantedAt < wanted.length && tokenAt < tokens.length) {
          if (tokens[tokenAt].word === wanted[wantedAt]) {
            last = tokenAt
            wantedAt += 1
            tokenAt += 1
            gap = 0
            continue
          }
          gap += 1
          tokenAt += 1
          if (gap > 24) break
        }
        if (wantedAt !== wanted.length) continue
        const span = last - start
        if (span < shortest) {
          shortest = span
          found.length = 0
        }
        found.push({ first: start, last })
      }
      if (found.length === 0) return null
      const chosen = preferLast ? found[found.length - 1] : found[0]
      const first = tokens[chosen.first]
      const last = tokens[chosen.last]
      const value = last.node.nodeValue ?? ''
      let end = last.end
      while (end < value.length && /[.,;:!?…"'”’»)\]]/.test(value[end])) end++
      const range = document.createRange()
      range.setStart(first.node, first.start)
      range.setEnd(last.node, end)
      return range
    }

    /**
     * Find the rendered sentence in one or more subtrees.
     * @param roots - subtrees to search.
     * @param sentence - prose about to be spoken.
     * @param preferLast - pick the newest match.
     * @returns a DOM range covering the sentence, or null.
     */
    function findTextRange (roots, sentence, preferLast) {
      const needle = normalizeForSearch(sentence)
      if (needle === '') return null
      const { text, map } = flattenText(roots)
      let length = needle.length
      let at = preferLast ? text.lastIndexOf(needle) : text.indexOf(needle)
      if (at < 0) {
        /* Markdown cleanup can drop trailing punctuation the DOM still renders. */
        const shorter = needle.replace(/[\s.!?…,;:]+$/, '')
        if (shorter.length >= 12) {
          at = preferLast ? text.lastIndexOf(shorter) : text.indexOf(shorter)
          length = shorter.length
        }
      }
      if (at < 0) return findWordRange(roots, sentence, preferLast)
      const start = map[at]
      const end = map[at + length - 1]
      if (start === undefined || end === undefined) return findWordRange(roots, sentence, preferLast)
      const range = document.createRange()
      range.setStart(start.node, start.offset)
      range.setEnd(end.node, end.offset + 1)
      return range
    }

    /**
     * The DOM rows of the turn that owns one action button, so a highlight lands
     * in the message actually being read.
     * @param element - clicked action element.
     * @returns the turn's rows in reading order, or null when the shape is unknown.
     */
    function renderingScope (element) {
      if (element === null || element === undefined || typeof element.closest !== 'function') return null
      const row = element.closest('[data-chat-turn]')
      const container = row?.parentElement ?? null
      if (row === null || container === null) return null
      const turn = row.getAttribute('data-chat-turn')
      const rows = [...container.children].filter((child) => child.getAttribute('data-chat-turn') === turn)
      return rows.length === 0 ? null : rows
    }

    /**
     * Paint the spoken sentence in the rendered reply: the Custom Highlight API
     * when the browser has it, a data attribute on the nearest block otherwise.
     * @returns a highlighter with `show`, `clear`, and `dispose`.
     */
    function createHighlighter () {
      let painted = null

      /** Remove whatever is painted. */
      function clear () {
        if (painted === null) return
        if (painted.kind === 'highlight') {
          window.CSS?.highlights?.delete(HIGHLIGHT_NAME)
        } else {
          painted.element.removeAttribute('data-dsh-speech-reading')
        }
        painted = null
      }

      /** Bring the sentence into view when reading has scrolled it off screen. */
      function keepVisible (range) {
        if (typeof range.getBoundingClientRect !== 'function') return
        const rect = range.getBoundingClientRect()
        if (rect.height === 0 && rect.width === 0) return
        if (rect.top >= 56 && rect.bottom <= window.innerHeight - 8) return
        const element = range.startContainer.parentElement
        if (element !== null) element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }

      /**
       * Highlight one spoken sentence.
       * @param sentence - prose chunk now being spoken.
       * @param scope - rows of the message being read, when the click knew them.
       */
      function show (sentence, scope) {
        clear()
        if (typeof document === 'undefined') return
        const known = Array.isArray(scope)
          ? scope.filter((root) => root !== null && root !== undefined && document.contains(root))
          : scope !== null && scope !== undefined && document.contains(scope) ? [scope] : []
        const roots = known.length > 0 ? known : [document.body]
        const range = findTextRange(roots, sentence, known.length === 0)
        if (range === null) return
        const registry = window.CSS?.highlights
        if (typeof window.Highlight === 'function' && registry !== undefined && registry !== null) {
          registry.set(HIGHLIGHT_NAME, new window.Highlight(range))
          painted = { kind: 'highlight' }
        } else {
          const element = range.startContainer.parentElement
          if (element === null) return
          element.setAttribute('data-dsh-speech-reading', '')
          painted = { kind: 'attribute', element }
        }
        keepVisible(range)
      }

      return { show, clear, dispose: clear }
    }

    /* --------------------------------------------------------------- session */

    /** Normalize one event-window entry to its Session event. */
    function eventOf (entry) {
      return entry !== null && typeof entry === 'object' && 'event' in entry ? entry.event : entry
    }

    /** Read the durable event window of one Session, or null. */
    function windowOf (ctx, sessionId) {
      try {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined || binding === null) return null
        return binding.eventSource.getSnapshot()
      } catch {
        return null
      }
    }

    /** Join the visible prose of one assistant event. */
    function proseOf (event) {
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) return ''
      return cleanForSpeech(content
        .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
        .map((block) => block.text)
        .join('\n'))
    }

    /** Read one finalized assistant message as speakable prose. */
    function readAssistantText (ctx, sessionId, messageId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return ''
      for (const entry of window.entries) {
        const event = eventOf(entry)
        if (event?.type !== 'assistant/message' || event.data?.message?.id !== messageId) continue
        return proseOf(event)
      }
      return ''
    }

    /** Find the last finalized assistant answer in one Session. */
    function findLastAssistant (ctx, sessionId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return null
      for (let index = window.entries.length - 1; index >= 0; index--) {
        const event = eventOf(window.entries[index])
        if (event?.type !== 'assistant/message') continue
        const text = proseOf(event)
        if (text !== '') return { id: event.data.message.id, text }
      }
      return null
    }

    /** Find the last finalized assistant answer of one turn. */
    function findTurnAnswer (ctx, sessionId, turn) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return null
      for (let index = window.entries.length - 1; index >= 0; index--) {
        const event = eventOf(window.entries[index])
        if (event?.type !== 'assistant/message' || event.data?.turn !== turn) continue
        const text = proseOf(event)
        if (text !== '') return { id: event.data.message.id, text }
      }
      return null
    }

    /* ------------------------------------------------------------------ panel */

    /**
     * A trigger-anchored popover: fixed position, outside-click and Escape close,
     * focus moved into the panel while open and back to the trigger on close.
     * @param open - whether it is open.
     * @param setOpen - close request.
     * @param width - panel width in pixels.
     */
    function usePanel (open, setOpen, width) {
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const [position, setPosition] = React.useState(null)
      React.useLayoutEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const place = () => {
          const anchor = triggerRef.current
          if (anchor === null) return
          const rect = anchor.getBoundingClientRect()
          const margin = 12
          const left = Math.min(Math.max(margin, rect.left), Math.max(margin, window.innerWidth - width - margin))
          setPosition({ left, bottom: Math.max(margin, window.innerHeight - rect.top + 8) })
        }
        place()
        window.addEventListener('resize', place)
        window.addEventListener('scroll', place, true)
        const frame = window.requestAnimationFrame(() => panelRef.current?.focus?.())
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
          window.cancelAnimationFrame(frame)
        }
      }, [open, width])
      React.useEffect(() => {
        if (!open) return undefined
        const onPointer = (event) => {
          if (triggerRef.current?.contains(event.target) === true) return
          if (panelRef.current?.contains(event.target) === true) return
          setOpen(false)
        }
        const onKey = (event) => {
          if (event.key !== 'Escape') return
          event.preventDefault()
          setOpen(false)
        }
        document.addEventListener('pointerdown', onPointer, true)
        document.addEventListener('keydown', onKey)
        return () => {
          document.removeEventListener('pointerdown', onPointer, true)
          document.removeEventListener('keydown', onKey)
          triggerRef.current?.focus?.()
        }
      }, [open, setOpen])
      return { position, triggerRef, panelRef }
    }

    /**
     * The panel itself, portalled to the body so a composer cannot clip it.
     */
    function Panel ({ panelRef, position, label, children }) {
      if (position === null) return null
      return createPortal(h('div', {
        ref: panelRef,
        className: 'dsh-speech-panel',
        role: 'dialog',
        'aria-label': label,
        tabIndex: -1,
        'data-dsh-speech-ignore': '',
        style: { left: `${position.left}px`, bottom: `${position.bottom}px` },
      }, children), document.body)
    }

    /**
     * One labelled select row.
     * @param props - label text, current value, choices, and change callback.
     */
    function SelectField ({ label, value, choices, onChange }) {
      return h('label', { className: 'dsh-speech-field' }, [
        h('span', { key: 'label', className: 'dsh-speech-label' }, label),
        h('select', {
          key: 'control',
          className: 'dsh-speech-select',
          value: value === null || value === undefined ? '' : String(value),
          onChange: (event) => onChange(event.target.value === '' ? null : event.target.value),
        }, choices.map((choice) => h('option', { key: choice.value, value: choice.value }, choice.label))),
      ])
    }

    /* -------------------------------------------------------------------- tts */

    /**
     * The read-aloud engine: one reply, one chunk at a time, with a pause that
     * never restarts the sentence, a meter over the audio being played, and the
     * spoken sentence highlighted in the rendered reply.
     * @param settings - preference store.
     * @param info - discovery store.
     * @param wave - level store shared with the dictation bar.
     */
    function createEngine (settings, info, wave) {
      const IDLE = { status: 'idle', messageId: null, sentence: null, chunk: 0, total: 0, error: null, rate: 1, autoplay: false, elapsed: 0 }
      const state = createStore({ ...IDLE })
      const STOP = Symbol('tts stop')
      let run = null
      let element = null
      let controller = null
      let url = null
      let generation = 0
      let audioContext = null
      let meterStop = null
      const highlighter = createHighlighter()

      /** Resolve the browser's current effective speed. */
      function speedOf () {
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        return selection.speed || 1
      }

      /**
       * Get the shared AudioContext running. Called synchronously from the
       * click path: a context created after playback starts usually stays
       * suspended, which silences a routed element — and delays the meter until
       * the next synthesis.
       * @returns the context, or null when WebAudio is unavailable.
       */
      function ensureContext () {
        const Context = window.AudioContext ?? window.webkitAudioContext
        if (typeof Context !== 'function') return null
        try {
          if (audioContext === null) audioContext = new Context()
          if (audioContext.state === 'suspended') void audioContext.resume().catch(() => {})
          return audioContext
        } catch {
          return null
        }
      }

      /** Stop sampling the chunk that ended. */
      function stopMeter () {
        if (meterStop === null) return
        meterStop()
        meterStop = null
      }

      /** Release the current audio element and chunk request. */
      function cleanup () {
        stopMeter()
        if (controller !== null) {
          try { controller.abort() } catch { /* settled */ }
          controller = null
        }
        if (element !== null) {
          element.onended = null
          element.onerror = null
          element.ontimeupdate = null
          try { element.pause() } catch { /* detached */ }
          try {
            element.removeAttribute('src')
            element.load()
          } catch { /* ignore */ }
          element = null
        }
        if (url !== null) {
          URL.revokeObjectURL(url)
          url = null
        }
      }

      /** Stop everything and forget the reply. */
      function stop () {
        generation += 1
        cleanup()
        highlighter.clear()
        wave.set({ levels: [] })
        run = null
        state.set({ ...IDLE })
      }

      /** Publish one failure without pretending audio is still playing. */
      function fail (code, message = null) {
        generation += 1
        cleanup()
        highlighter.clear()
        wave.set({ levels: [] })
        run = null
        state.set({ ...IDLE, status: 'failed', error: { code, message: message === null ? null : String(message).slice(0, 240) } })
      }

      /**
       * Sample one playing element into the shared wave store.
       * A suspended AudioContext would silence a routed element, so metering
       * waits until the context runs and the chunk simply plays un-metered.
       */
      async function startMeter (audio, current) {
        stopMeter()
        const context = ensureContext()
        if (context === null) return
        try {
          if (context.state !== 'running') await context.resume()
          if (current !== generation || context.state !== 'running') return
          const source = context.createMediaElementSource(audio)
          const analyser = context.createAnalyser()
          analyser.fftSize = 1024
          source.connect(analyser)
          analyser.connect(context.destination)
          const buffer = new Float32Array(analyser.fftSize)
          let smoothed = 0
          const timer = window.setInterval(() => {
            if (current !== generation) return
            analyser.getFloatTimeDomainData(buffer)
            smoothed += (levelOf(buffer) - smoothed) * 0.45
            wave.set({ levels: [...wave.getSnapshot().levels, smoothed].slice(-WAVE_BARS) })
          }, LEVEL_INTERVAL_MS)
          meterStop = () => {
            window.clearInterval(timer)
            try { source.disconnect() } catch { /* detached */ }
            try { analyser.disconnect() } catch { /* detached */ }
          }
        } catch { /* metering unavailable: the audio still plays */ }
      }

      /** POST one chunk and return its object URL. */
      async function requestChunk (text) {
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        const body = { text, speed: run === null ? speedOf() : run.rate }
        if (selection.server !== null) body.server = selection.server.id
        if (selection.model !== null) body.model = selection.model.id
        if (selection.voice !== null) body.voice = selection.voice
        controller = new AbortController()
        let response
        try {
          response = await fetch(TTS_ROUTES.speak, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal,
          })
        } catch (error) {
          if (controller?.signal.aborted === true) {
            const stopped = new Error('stopped')
            stopped.code = STOP
            throw stopped
          }
          const wrapped = new Error(String(error?.message ?? error))
          wrapped.code = 'network'
          throw wrapped
        }
        if (!response.ok) throw await errorOf(response, 'speech request')
        const blob = await response.blob()
        if (blob.size === 0) {
          const error = new Error('the speech server returned no audio')
          error.code = 'server'
          throw error
        }
        url = URL.createObjectURL(blob)
        return url
      }

      /** Play one object URL to its end. */
      function playUrl (source, rate, current) {
        return new Promise((resolve, reject) => {
          const audio = new Audio(source)
          element = audio
          let settled = false
          const finish = (settle, value) => {
            if (settled) return
            settled = true
            audio.onended = null
            audio.onerror = null
            audio.ontimeupdate = null
            /* Count a finished chunk into the reply's elapsed time. */
            if (run !== null && Number.isFinite(audio.duration) && audio.duration > 0) {
              run.elapsedBase = (run.elapsedBase ?? 0) + audio.duration
            }
            stopMeter()
            if (element === audio) element = null
            settle(value)
          }
          audio.onended = () => finish(resolve)
          audio.onerror = () => {
            const error = new Error('audio playback failed')
            error.code = 'playback'
            finish(reject, error)
          }
          audio.ontimeupdate = () => {
            if (current !== generation || run === null) return
            state.update({ elapsed: (run.elapsedBase ?? 0) + audio.currentTime })
          }
          try {
            audio.preservesPitch = true
            audio.playbackRate = rate
          } catch { /* older element */ }
          audio.play().then(
            () => {
              if (current !== generation) {
                finish(reject, STOP)
                return
              }
              void startMeter(audio, current)
            },
            (error) => {
              const wrapped = new Error(String(error?.message ?? error))
              wrapped.code = error?.name === 'NotAllowedError' ? 'blocked' : 'playback'
              finish(reject, wrapped)
            },
          )
        })
      }

      /** Speak the reply from one chunk onward. */
      async function playFrom (start) {
        const current = ++generation
        const reply = run
        try {
          for (let index = start; index < reply.chunks.length; index++) {
            if (current !== generation) return
            const sentence = reply.chunks[index]
            state.set({ ...state.getSnapshot(), status: 'loading', chunk: index, sentence })
            if (url !== null) {
              URL.revokeObjectURL(url)
              url = null
            }
            const source = await requestChunk(sentence)
            if (current !== generation) return
            state.set({ ...state.getSnapshot(), status: 'playing', chunk: index, sentence })
            if (settings.getSnapshot().highlight === false) highlighter.clear()
            else highlighter.show(sentence, reply.scope)
            await playUrl(source, reply.rate, current)
            if (current !== generation) return
            if (url !== null) {
              URL.revokeObjectURL(url)
              url = null
            }
            controller = null
          }
          if (current !== generation) return
          stop()
        } catch (error) {
          if (current !== generation || error === STOP || error?.code === STOP) return
          fail(error?.code === 'blocked' ? 'blocked' : error?.code ?? 'network', error?.message ?? null)
        }
      }

      /**
       * Read one reply from the beginning, replacing whatever was playing.
       * @param messageId - durable message identity the controls key off.
       * @param text - prose to read.
       * @param options - `autoplay` marks unsolicited speech; `scope` bounds the highlight.
       */
      async function speak (messageId, text, options = {}) {
        /* Runs before any await, so a click still carries user activation. */
        ensureContext()
        stop()
        /* Never ask for more text than the Host will accept: the chunk budget is
           the smaller of the sentence-group size and the configured ceiling. */
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        const budget = Math.max(1, Math.min(CHUNK_CHARS, selection.maxChars))
        const chunks = splitChunks(text, budget)
        if (chunks.length === 0) {
          fail('empty')
          return
        }
        const rate = speedOf()
        run = { messageId, chunks, rate, scope: options.scope ?? null, elapsedBase: 0 }
        state.set({
          ...IDLE,
          status: 'loading',
          messageId,
          total: chunks.length,
          sentence: chunks[0],
          rate,
          autoplay: options.autoplay === true,
        })
        await playFrom(0)
      }

      /** Pause at the playhead, keeping the reply loaded. */
      function pause () {
        if (element === null || state.getSnapshot().status !== 'playing') return
        try { element.pause() } catch { /* detached */ }
        state.set({ ...state.getSnapshot(), status: 'paused' })
      }

      /** Resume from the pause. */
      function resume () {
        if (element === null || state.getSnapshot().status !== 'paused') return
        state.set({ ...state.getSnapshot(), status: 'playing' })
        element.play().catch((error) => fail(error?.name === 'NotAllowedError' ? 'blocked' : 'playback', error?.message ?? null))
      }

      /** Apply a speaking rate to whatever is playing right now. */
      function setRate (rate) {
        const bounded = Math.min(4, Math.max(0.25, Number(rate) || 1))
        if (run !== null) run.rate = bounded
        if (element === null) return
        try { element.playbackRate = bounded } catch { /* released */ }
        state.set({ ...state.getSnapshot(), rate: bounded })
      }

      /** Stop everything, release the meter, and close the audio context. */
      function dispose () {
        stop()
        highlighter.dispose()
        if (audioContext !== null) {
          const context = audioContext
          audioContext = null
          void context.close().catch(() => {})
        }
      }

      return { state, speak, pause, resume, stop, fail, setRate, dispose }
    }

    /**
     * Read newly completed turns aloud while autoplay is on.
     * @param ctx - client context carrying `sessions`.
     * @param engine - the speech engine.
     * @param settings - preference store read at every turn end.
     */
    function createWatcher (ctx, engine, settings) {
      const bound = new Map()

      /** Highest durable sequence currently in the window. */
      function highestSeq (binding) {
        let highest = 0
        for (const entry of binding.eventSource.getSnapshot().entries) {
          const event = eventOf(entry)
          if (typeof event?.seq === 'number' && event.seq > highest) highest = event.seq
        }
        return highest
      }

      /** Start watching one Session once. */
      function bind (sessionId) {
        if (typeof sessionId !== 'string' || bound.has(sessionId)) return
        const slot = { cancelled: false, unsubscribe: null, attempts: 0 }
        bound.set(sessionId, slot)
        const attach = () => {
          if (slot.cancelled) return
          let binding
          try {
            binding = ctx.sessions.binding(sessionId)
          } catch {
            binding = undefined
          }
          if (binding === undefined || binding === null) {
            if (slot.attempts++ < 20) window.setTimeout(attach, 250)
            return
          }
          let highest = highestSeq(binding)
          slot.unsubscribe = binding.eventSource.subscribe(() => {
            const snapshot = binding.eventSource.getSnapshot()
            if (snapshot.change?.kind === 'replace') {
              highest = highestSeq(binding)
              return
            }
            const fresh = []
            for (const entry of snapshot.entries) {
              const event = eventOf(entry)
              if (typeof event?.seq === 'number' && event.seq > highest) fresh.push(event)
            }
            if (fresh.length === 0) return
            for (const event of fresh) if (event.seq > highest) highest = event.seq
            if (settings.getSnapshot().autoplay !== true) return
            for (const event of fresh) {
              if (event.type !== 'turn/end' || event.data?.reason?.kind !== 'completed') continue
              const found = findTurnAnswer(ctx, sessionId, event.data.turn)
              if (found === null) continue
              engine.speak(found.id, found.text, { autoplay: true })
            }
          })
        }
        attach()
      }

      /** Stop watching every Session. */
      function dispose () {
        for (const slot of bound.values()) {
          slot.cancelled = true
          if (slot.unsubscribe !== null) slot.unsubscribe()
        }
        bound.clear()
      }

      return { bind, dispose }
    }

    /**
     * The effective selection for the current preferences and discovery result.
     * @param preferences - settings snapshot.
     * @param discovered - `/tts/info` value, or null before it loads.
     */
    function selectionOf (preferences, discovered) {
      const servers = Array.isArray(discovered?.servers) ? discovered.servers : []
      const defaults = discovered?.defaults ?? {}
      const server = servers.find((row) => row.id === preferences.server) ??
        servers.find((row) => row.id === defaults.server) ??
        servers[0] ?? null
      const models = Array.isArray(server?.models) ? server.models : []
      const model = models.find((row) => row.id === preferences.model) ??
        models.find((row) => row.id === defaults.model) ??
        models[0] ?? null
      const voices = Array.isArray(model?.voices) ? model.voices : []
      const voice = voices.find((id) => id === preferences.voice) ??
        (voices.includes(defaults.voice) ? defaults.voice : null) ??
        voices[0] ?? null
      const speed = typeof preferences.speed === 'number' ? preferences.speed : defaults.speed ?? 1
      const speeds = Array.isArray(discovered?.speeds) && discovered.speeds.length > 0 ? discovered.speeds : FALLBACK_SPEEDS
      return { server, model, voice, speed, speeds, maxChars: discovered?.maxChars ?? 4000 }
    }

    /** Subscribe a component to one of the injected stores. */
    function useValue (useSnapshot) {
      return useSnapshot((value) => value)
    }

    /** Per-message Listen control in the finalized assistant action row. */
    function ListenAction ({ t, messageId, sessionId, read, stop, useTtsState }) {
      const status = useTtsState((value) => value.status)
      const playingId = useTtsState((value) => value.messageId)
      const active = playingId === messageId && (status === 'playing' || status === 'loading' || status === 'paused')
      const label = active ? t('action.stop') : t('action.listen')
      const Icon = active ? primitives.IconStopFillRegular : primitives.IconPlayOutlineRegular
      return h('button', {
        type: 'button',
        className: 'dsh-speech-action',
        'aria-label': label,
        title: label,
        'data-active': active ? '' : undefined,
        onClick: (event) => { if (active) stop(); else read(sessionId, messageId, event.currentTarget) },
      }, h(Icon, {}))
    }

    /** The level bars shared by the dictation bar and the read-aloud transport. */
    function Waveform ({ levels }) {
      return h('div', { className: 'dsh-speech-wave' }, (Array.isArray(levels) ? levels : []).map((level, index) => h('i', {
        key: index,
        className: 'dsh-speech-wave-bar',
        style: { height: `${Math.max(2, Math.round(level * 22))}px` },
      })))
    }

    /** The transport bar under the composer: live waveform, pause/resume, stop. */
    function Player ({ t, useTtsState, useTtsWave, pause, resume, stop }) {
      const state = useValue(useTtsState)
      const wave = useValue(useTtsWave)
      const active = state.status === 'playing' || state.status === 'loading' || state.status === 'paused'
      const failed = state.status === 'failed' && state.error !== null
      if (!active && !failed) return null
      if (failed) {
        const message = state.error.message ?? t(`status.hint.${state.error.code ?? 'default'}`)
        return h('div', {
          className: 'dsh-speech-player dsh-speech-failed',
          role: 'status',
          'aria-live': 'polite',
          'data-dsh-speech-ignore': '',
        }, [
          h('span', { key: 'label', className: 'dsh-speech-failed-label' }, t('status.failed')),
          h('span', { key: 'text', className: 'dsh-speech-failed-text', title: message }, message),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-speech-round',
            'aria-label': t('player.stop'),
            title: t('player.stop'),
            onClick: stop,
          }, h(primitives.IconCloseOutlineRegular, {})),
        ])
      }
      const playing = state.status === 'playing' || state.status === 'loading'
      return h('div', {
        className: 'dsh-speech-player',
        title: state.sentence ?? '',
        'data-dsh-speech-ignore': '',
      }, [
        h('button', {
          key: 'toggle',
          type: 'button',
          className: 'dsh-speech-round',
          'aria-label': playing ? t('player.pause') : t('player.resume'),
          title: playing ? t('player.pause') : t('player.resume'),
          onClick: () => { if (playing) pause(); else resume() },
        }, h(playing ? primitives.IconPauseOutlineRegular : primitives.IconPlayOutlineRegular, {})),
        h(Waveform, { key: 'wave', levels: wave.levels }),
        h('span', { key: 'time', className: 'dsh-speech-time' }, `${Math.floor(state.elapsed ?? 0)}s`),
        h('button', {
          key: 'stop',
          type: 'button',
          className: 'dsh-speech-round',
          'aria-label': t('player.stop'),
          title: t('player.stop'),
          onClick: stop,
        }, h(primitives.IconStopFillRegular, {})),
      ])
    }

    /** Composer control: the Listen chip and its settings panel. */
    function ReadControl (props) {
      const { t, sessionId, readLast, watch, updateSettings, refresh, useTtsState, useTtsSettings, useTtsInfo } = props
      const settings = useValue(useTtsSettings)
      const info = useValue(useTtsInfo)
      const status = useTtsState((value) => value.status)
      const [open, setOpen] = React.useState(false)
      const { position, triggerRef, panelRef } = usePanel(open, setOpen, 352)
      const selection = selectionOf(settings, info.value)
      React.useEffect(() => {
        if (typeof sessionId === 'string') watch(sessionId)
      }, [sessionId, watch])
      React.useEffect(() => {
        if (open) refresh(false)
      }, [open, refresh])
      const active = status === 'playing' || status === 'loading' || status === 'paused'
      const choices = (rows, labelOf) => [{ value: '', label: '—' }, ...rows.map((row) => ({ value: row.id ?? row, label: labelOf(row) }))]
      const servers = Array.isArray(info.value?.servers) ? info.value.servers : []
      const models = Array.isArray(selection.server?.models) ? selection.server.models : []
      const voices = Array.isArray(selection.model?.voices) ? selection.model.voices : []
      return h('span', { className: 'dsh-speech-group' }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-speech-trigger',
          'aria-label': t('action.listen'),
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          title: t('panel.title'),
          onClick: () => setOpen(!open),
        }, [
          h(primitives.IconPlayOutlineRegular, { key: 'icon' }),
          h('span', { key: 'label', className: 'dsh-speech-trigger-label' }, t('action.listen')),
          h(primitives.IconChevronDownOutlineRegular, { key: 'chevron' }),
        ]),
        open ? h(Panel, { key: 'panel', panelRef, position, label: t('panel.aria') }, [
          h('div', { key: 'title', className: 'dsh-speech-title' }, t('panel.title')),
          h('label', { key: 'autoplay', className: 'dsh-speech-switch' }, [
            h(primitives.Switch, {
              key: 'switch',
              checked: settings.autoplay === true,
              label: t('autoplay'),
              onChange: (value) => updateSettings({ autoplay: value }),
            }),
            h('span', { key: 'text' }, t('autoplay')),
          ]),
          h('label', { key: 'highlight', className: 'dsh-speech-switch' }, [
            h(primitives.Switch, {
              key: 'switch',
              checked: settings.highlight !== false,
              label: t('highlight'),
              onChange: (value) => updateSettings({ highlight: value }),
            }),
            h('span', { key: 'text' }, t('highlight')),
          ]),
          h(SelectField, {
            key: 'server',
            label: t('server'),
            value: selection.server?.id ?? '',
            choices: choices(servers, (row) => row.name ?? row.id),
            onChange: (value) => updateSettings({ server: value, model: null, voice: null }),
          }),
          h(SelectField, {
            key: 'model',
            label: t('model'),
            value: selection.model?.id ?? '',
            choices: choices(models, (row) => row.id),
            onChange: (value) => updateSettings({ model: value, voice: null }),
          }),
          h(SelectField, {
            key: 'voice',
            label: t('voice'),
            value: selection.voice ?? '',
            choices: voices.map((id) => ({ value: id, label: id })),
            onChange: (value) => updateSettings({ voice: value }),
          }),
          h(SelectField, {
            key: 'speed',
            label: t('speed'),
            value: String(selection.speed),
            choices: selection.speeds.map((value) => ({ value: String(value), label: `${value}×` })),
            onChange: (value) => updateSettings({ speed: value === null ? null : Number(value) }),
          }),
          h('div', { key: 'actions', className: 'dsh-speech-actions' }, [
            h('button', {
              key: 'read',
              type: 'button',
              className: 'dsh-speech-action',
              disabled: active || sessionId === undefined,
              onClick: () => readLast(sessionId),
            }, t('readLast')),
            h('span', { key: 'status', className: 'dsh-speech-status' },
              selection.server === null ? t('status.none') : t('status.ready', { server: selection.server.name ?? selection.server.id, model: selection.model?.id ?? '—' })),
          ]),
          h('p', { key: 'hint', className: 'dsh-speech-hint' }, t('hint')),
        ]) : null,
      ])
    }

    /* -------------------------------------------------------------------- stt */

    /** Encode one mono Float32 buffer as a 16-bit PCM WAV. */
    function encodeWav (samples, rate = SAMPLE_RATE) {
      const buffer = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(buffer)
      const write = (offset, text) => { for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index)) }
      write(0, 'RIFF')
      view.setUint32(4, 36 + samples.length * 2, true)
      write(8, 'WAVE')
      write(12, 'fmt ')
      view.setUint32(16, 16, true)
      view.setUint16(20, 1, true)
      view.setUint16(22, 1, true)
      view.setUint32(24, rate, true)
      view.setUint32(28, rate * 2, true)
      view.setUint16(32, 2, true)
      view.setUint16(34, 16, true)
      write(36, 'data')
      view.setUint32(40, samples.length * 2, true)
      let offset = 44
      for (const sample of samples) {
        const clamped = Math.max(-1, Math.min(1, sample))
        view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true)
        offset += 2
      }
      return new Blob([buffer], { type: 'audio/wav' })
    }

    /**
     * Decode any browser recording into the 16 kHz mono WAV the providers expect.
     * @param blob - recorded audio.
     */
    async function toWav (blob) {
      const Context = window.AudioContext ?? window.webkitAudioContext
      const context = new Context()
      try {
        const data = await blob.arrayBuffer()
        const decoded = await context.decodeAudioData(data.slice(0))
        const frames = Math.max(1, Math.ceil(decoded.duration * SAMPLE_RATE))
        const offline = new OfflineAudioContext(1, frames, SAMPLE_RATE)
        const source = offline.createBufferSource()
        source.buffer = decoded
        source.connect(offline.destination)
        source.start(0)
        const rendered = await offline.startRendering()
        return encodeWav(rendered.getChannelData(0))
      } finally {
        await context.close().catch(() => {})
      }
    }

    /**
     * The microphone: one take at a time, transcoded and inserted at the caret
     * captured when recording began.
     * @param settings - preference store.
     * @param info - discovery store.
     */
    function createRecorder (settings, info) {
      const state = createStore({ phase: 'idle', elapsed: 0, error: null })
      const wave = createStore({ levels: [] })
      let stream = null
      let audioContext = null
      let analyser = null
      let buffer = null
      let recorder = null
      let chunks = []
      let elapsedTimer = null
      let levelTimer = null
      let startedAt = 0
      let actions = null
      let span = null
      let draft = ''
      let commit = false
      let starting = false
      let finishing = false
      let disposed = false
      let transcribeController = null

      /** Release the microphone, the meter, and the timers. */
      function teardown () {
        window.clearInterval(elapsedTimer)
        window.clearInterval(levelTimer)
        elapsedTimer = null
        levelTimer = null
        for (const track of stream?.getTracks?.() ?? []) {
          try { track.stop() } catch { /* already stopped */ }
        }
        stream = null
        analyser = null
        buffer = null
        if (audioContext !== null) void audioContext.close().catch(() => {})
        audioContext = null
        recorder = null
      }

      /** Put the transcript where the caret was when recording began. */
      function insert (text) {
        if (actions === null || disposed) return
        const payload = (draft ?? '').trim() === '' || (draft ?? '').endsWith(' ') ? text : ` ${text}`
        if (actions.insertText(payload, span) !== false) return
        actions.insertText(payload, actions.captureInsertion())
      }

      /** Guarded completion of one take. */
      async function finish (mime) {
        if (finishing) return
        finishing = true
        try {
          const blob = new Blob(chunks, { type: mime === '' ? 'audio/webm' : mime })
          const captured = { actions, span, draft, commit }
          chunks = []
          teardown()
          wave.set({ levels: [] })
          if (disposed || !captured.commit) {
            state.set({ phase: 'idle', elapsed: 0, error: null })
            return
          }
          if (blob.size === 0) {
            state.set({ phase: 'idle', elapsed: 0, error: 'empty' })
            return
          }
          state.set({ phase: 'working', elapsed: 0, error: null })
          transcribeController = new AbortController()
          try {
            const wav = await toWav(blob)
            const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
            const query = new URLSearchParams({ language: settings.getSnapshot().language ?? 'auto' })
            if (selection.server !== null) query.set('server', selection.server.id)
            if (selection.model !== null) query.set('model', selection.model.id)
            const response = await fetch(`${STT_ROUTES.transcribe}?${query.toString()}`, {
              method: 'POST',
              headers: { 'content-type': 'audio/wav' },
              body: wav,
              signal: transcribeController.signal,
            })
            if (!response.ok) throw await errorOf(response, 'transcription request')
            const payload = await response.json().catch(() => null)
            const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
            actions = captured.actions
            span = captured.span
            draft = captured.draft
            if (disposed) return
            if (text === '') state.set({ phase: 'idle', elapsed: 0, error: 'empty' })
            else {
              insert(text)
              state.set({ phase: 'idle', elapsed: 0, error: null })
            }
          } catch (error) {
            if (error?.name === 'AbortError' || transcribeController?.signal.aborted === true) {
              state.set({ phase: 'idle', elapsed: 0, error: null })
              return
            }
            state.set({ phase: 'idle', elapsed: 0, error: String(error?.message ?? error) })
          } finally {
            transcribeController = null
          }
        } finally {
          finishing = false
        }
      }

      /** Open the microphone and start one take. */
      async function start (options = {}) {
        if (starting || state.getSnapshot().phase !== 'idle' || disposed) return
        starting = true
        state.set({ phase: 'starting', elapsed: 0, error: null })
        try {
          if (navigator.mediaDevices?.getUserMedia === undefined) {
            state.set({ phase: 'idle', elapsed: 0, error: 'insecure' })
            return
          }
          let media
          try {
            media = await navigator.mediaDevices.getUserMedia({ audio: true })
          } catch (error) {
            const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
            state.set({ phase: 'idle', elapsed: 0, error: denied ? 'denied' : String(error?.message ?? error) })
            return
          }
          if (disposed) {
            for (const track of media.getTracks?.() ?? []) try { track.stop() } catch { /* ignore */ }
            state.set({ phase: 'idle', elapsed: 0, error: null })
            return
          }
          stream = media
          try {
            audioContext = new (window.AudioContext ?? window.webkitAudioContext)()
            analyser = audioContext.createAnalyser()
            analyser.fftSize = 1024
            audioContext.createMediaStreamSource(media).connect(analyser)
            buffer = new Float32Array(analyser.fftSize)
          } catch {
            audioContext = null
            analyser = null
          }
          let element
          try {
            element = new MediaRecorder(media)
          } catch (error) {
            teardown()
            state.set({ phase: 'idle', elapsed: 0, error: String(error?.message ?? error) })
            return
          }
          chunks = []
          element.ondataavailable = (event) => { if (event.data.size > 0) chunks.push(event.data) }
          element.onstop = () => { void finish(element.mimeType) }
          recorder = element
          actions = options.actions ?? null
          draft = options.draft ?? ''
          span = actions?.captureInsertion?.() ?? null
          commit = true
          startedAt = Date.now()
          wave.set({ levels: [] })
          try {
            element.start()
          } catch (error) {
            teardown()
            state.set({ phase: 'idle', elapsed: 0, error: String(error?.message ?? error) })
            return
          }
          state.set({ phase: 'recording', elapsed: 0, error: null })
          elapsedTimer = window.setInterval(() => state.update({ elapsed: (Date.now() - startedAt) / 1000 }), 250)
          if (analyser !== null && buffer !== null) {
            let smoothed = 0
            levelTimer = window.setInterval(() => {
              if (analyser === null || buffer === null) return
              analyser.getFloatTimeDomainData(buffer)
              smoothed += (levelOf(buffer) - smoothed) * 0.45
              const levels = [...wave.getSnapshot().levels, smoothed].slice(-WAVE_BARS)
              wave.set({ levels })
            }, LEVEL_INTERVAL_MS)
          }
        } finally {
          starting = false
        }
      }

      /** Stop and transcribe the take. */
      function stop () {
        if (recorder === null || state.getSnapshot().phase !== 'recording') return
        commit = true
        state.set({ phase: 'working', elapsed: state.getSnapshot().elapsed, error: null })
        if (recorder.state !== 'inactive') recorder.stop()
        else void finish(recorder.mimeType)
      }

      /** Stop and discard the take. */
      function cancel () {
        if (recorder === null) return
        commit = false
        state.set({ phase: 'idle', elapsed: 0, error: null })
        if (recorder.state !== 'inactive') recorder.stop()
        else {
          teardown()
          wave.set({ levels: [] })
        }
      }

      /** Release the microphone and any in-flight upload. */
      function dispose () {
        disposed = true
        commit = false
        if (transcribeController !== null) {
          try { transcribeController.abort() } catch { /* settled */ }
          transcribeController = null
        }
        if (recorder !== null && recorder.state !== 'inactive') {
          try { recorder.stop() } catch { /* already stopped */ }
        }
        teardown()
        wave.set({ levels: [] })
        state.set({ phase: 'idle', elapsed: 0, error: null })
      }

      return { state, wave, start, stop, cancel, dispose }
    }

    /** The listening bar under the composer. */
    function ListeningBar ({ t, useSttState, useSttWave, stop, cancel }) {
      const state = useValue(useSttState)
      const wave = useValue(useSttWave)
      const live = state.phase === 'recording' || state.phase === 'working'
      if (!live) return null
      const recording = state.phase === 'recording'
      const levels = Array.isArray(wave.levels) ? wave.levels : []
      return h('div', { className: 'dsh-speech-bar', role: 'status', 'aria-live': 'polite', 'data-dsh-speech-ignore': '' }, [
        recording
          ? h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dsh-speech-round',
            'aria-label': t('cancel'),
            title: t('cancel'),
            onClick: cancel,
          }, h(primitives.IconCloseOutlineRegular, {}))
          : null,
        h(Waveform, { key: 'wave', levels }),
        recording
          ? h('span', { key: 'elapsed', className: 'dsh-speech-time' }, `${Math.floor(state.elapsed)}s`)
          : h('span', { key: 'label', className: 'dsh-speech-bar-label' }, t('working')),
        recording
          ? h('button', {
            key: 'stop',
            type: 'button',
            className: 'dsh-speech-round dsh-speech-primary',
            'aria-label': t('stop'),
            title: t('stop'),
            onClick: stop,
          }, h(primitives.IconCheckOutlineRegular, {}))
          : h('span', { key: 'spin', className: 'dsh-speech-spin', 'aria-hidden': true }),
      ])
    }

    /** Composer control: the microphone chip and its settings panel. */
    function DictateControl (props) {
      const { t, inputActions, updateSettings, refresh, start, stop, useInput, useSttState, useSttSettings, useSttInfo } = props
      const state = useValue(useSttState)
      const settings = useValue(useSttSettings)
      const info = useValue(useSttInfo)
      const draft = useInput((value) => value.draft)
      const [open, setOpen] = React.useState(false)
      const { position, triggerRef, panelRef } = usePanel(open, setOpen, 352)
      const recording = state.phase === 'recording'
      const busy = recording || state.phase === 'working' || state.phase === 'starting'
      React.useEffect(() => {
        if (open) refresh(false)
      }, [open, refresh])
      const servers = Array.isArray(info.value?.servers) ? info.value.servers : []
      const defaults = info.value?.defaults ?? {}
      const server = servers.find((row) => row.id === settings.server) ??
        servers.find((row) => row.id === defaults.server) ?? servers[0] ?? null
      const models = Array.isArray(server?.models) ? server.models : []
      const model = models.find((id) => id === settings.model) ?? defaults.model ?? models[0] ?? null
      const languages = Array.isArray(info.value?.languages) ? info.value.languages : ['auto']
      const choices = (rows, labelOf) => [{ value: '', label: '—' }, ...rows.map((row) => ({ value: row.id ?? row, label: labelOf(row) }))]
      const error = state.error
      return h('span', { className: 'dsh-speech-group' }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-speech-trigger',
          'data-recording': recording ? '' : undefined,
          'aria-label': t('trigger'),
          'aria-expanded': open,
          title: recording ? t('stop') : t('start'),
          onClick: () => { if (recording) stop(); else void start({ actions: inputActions, draft }) },
        }, h(primitives.IconMicrophoneOutlineRegular, {}), h('span', null, t('trigger'))),
        h('button', {
          key: 'more',
          type: 'button',
          className: 'dsh-speech-caret',
          'aria-label': t('panel.aria'),
          'aria-expanded': open,
          title: t('panel.aria'),
          onClick: () => setOpen(!open),
        }, h(primitives.IconChevronDownOutlineRegular, {})),
        open ? h(Panel, { key: 'panel', panelRef, position, label: t('panel.aria') }, [
          h('div', { key: 'title', className: 'dsh-speech-title' }, t('panel.title')),
          h(SelectField, {
            key: 'server',
            label: t('server'),
            value: server?.id ?? '',
            choices: choices(servers, (row) => row.name ?? row.id),
            onChange: (value) => updateSettings({ server: value, model: null }),
          }),
          h(SelectField, {
            key: 'model',
            label: t('model'),
            value: model ?? '',
            choices: choices(models, (id) => id),
            onChange: (value) => updateSettings({ model: value }),
          }),
          h(SelectField, {
            key: 'language',
            label: t('language'),
            value: settings.language ?? 'auto',
            choices: languages.map((language) => ({ value: language, label: language })),
            onChange: (value) => updateSettings({ language: value ?? 'auto' }),
          }),
          h('div', { key: 'actions', className: 'dsh-speech-actions' }, [
            h('button', {
              key: 'toggle',
              type: 'button',
              className: 'dsh-speech-action',
              disabled: state.phase === 'working' || state.phase === 'starting',
              onClick: () => { if (recording) stop(); else void start({ actions: inputActions, draft }) },
            }, recording ? t('stop') : t('start')),
            h('span', { key: 'status', className: 'dsh-speech-status' }, error !== null && error !== undefined
              ? errorText(t, error)
              : server === null
                ? t('status.none')
                : t('status.ready', { server: server.name ?? server.id, model: model ?? '—' })),
          ]),
          h('p', { key: 'hint', className: 'dsh-speech-hint' }, t('hint')),
        ]) : null,
      ])
    }

    /** One error code as the localized sentence the panel shows. */
    function errorText (t, code) {
      if (code === 'denied') return t('status.denied')
      if (code === 'insecure') return t('status.insecure')
      if (code === 'empty') return t('status.empty')
      return String(code)
    }

    /* --------------------------------------------------------------------- css */

    const STYLES = [
      '.dsh-speech-group{display:inline-flex;align-items:center;gap:0}',
      '.dsh-speech-trigger{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 6px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.dsh-speech-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-speech-trigger[data-recording]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsh-speech-trigger svg{width:14px;height:14px}',
      '.dsh-speech-trigger-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px}',
      '.dsh-speech-caret{border-radius:var(--dsw-radius-sm);height:28px;width:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:0 0;color:var(--dsw-alias-label-caption);cursor:pointer}',
      '.dsh-speech-caret:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-speech-caret svg{width:12px;height:12px}',
      '.dsh-speech-panel{position:fixed;z-index:90;width:352px;max-height:min(72vh,560px);overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:10px;padding:14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);box-shadow:0 12px 40px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);font-size:13px;text-align:left}',
      '.dsh-speech-title{font-size:13px;font-weight:500;line-height:20px}',
      '.dsh-speech-field{display:flex;flex-direction:column;gap:4px}',
      '.dsh-speech-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-speech-select{box-sizing:border-box;width:100%;height:30px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;padding:0 6px}',
      '.dsh-speech-switch{display:flex;align-items:center;gap:8px;cursor:pointer;color:var(--dsw-alias-label-primary);font-size:12px}',
      '.dsh-speech-actions{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.dsh-speech-action{border-radius:var(--dsw-radius-sm);height:28px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;font-size:12px;cursor:pointer;padding:0 10px}',
      '.dsh-speech-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-speech-action:disabled{opacity:.5;cursor:default}',
      '.dsh-speech-status{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.dsh-speech-hint{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;margin:0}',
      '.dsh-speech-time{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:11px}',
      '::highlight(dsh-speech-reading){background-color:rgba(106,166,255,.22);border-radius:3px}',
      '[data-dsh-speech-reading]{background-color:rgba(106,166,255,.22);border-radius:3px;box-shadow:0 0 0 1px rgba(106,166,255,.35)}',
      '.dsh-speech-round{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:50%;border:none;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-speech-round svg{width:14px;height:14px}',
      '.dsh-speech-primary{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-speech-failed{justify-content:space-between}',
      '.dsh-speech-failed-label{flex:none;font-weight:500;color:var(--dsw-alias-label-primary)}',
      '.dsh-speech-failed-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.dsh-speech-player,.dsh-speech-bar{box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));max-width:var(--dsh-composer-card-max-width,952px);margin-inline:auto;display:flex;align-items:center;gap:10px;padding:6px 10px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px}',
      '.dsh-speech-wave{display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:24px;overflow:hidden}',
      '.dsh-speech-wave-bar{flex:0 0 2px;min-height:2px;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:height .09s ease-out}',
      '.dsh-speech-bar-label{flex:1;color:var(--dsw-alias-label-secondary);padding-left:2px}',
      '.dsh-speech-spin{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);animation:dsh-speech-spin .8s linear infinite}',
      '@keyframes dsh-speech-spin{to{transform:rotate(360deg)}}',
    ].join('\n')

    /* ------------------------------------------------------------------ plugin */

    /** Required client services: slot registry, dictionaries, Session log access. */
    const inject = ['slots', 'locale', 'sessions']

    /** Install the stylesheet once; the effect removes it with the plugin. */
    function installCss () {
      const id = 'dsh-plugin-speech/speech.css'
      if (typeof document === 'undefined') return null
      const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
      if (existing !== null) return null
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-speech'
      tag.dataset.pluginCss = id
      tag.textContent = STYLES
      document.head.appendChild(tag)
      return tag
    }

    /**
     * Probe one route: 404 means the row is off; any other outcome mounts the UI,
     * because a slow or failing Host must not hide it.
     * @param url - info route.
     * @returns 'off' or 'on'.
     */
    async function probe (url) {
      try {
        const response = await fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(3000) })
        return response.status === 404 ? 'off' : 'on'
      } catch {
        /* A timed-out or failed probe mounts the UI: a slow Host must not hide it. */
        return 'on'
      }
    }

    /**
     * Mount both halves.
     * @param ctx - client root context.
     */
    function apply (ctx) {
      let disposed = false
      ctx.effect(() => {
        const tag = installCss()
        return () => {
          disposed = true
          if (tag !== null) tag.remove()
        }
      }, 'dsh-plugin-speech: styles and lifetime')
      ctx.effect(() => ctx.locale.register(TTS_NS, { en: ttsEn, zh: ttsZh }), 'dsh-plugin-speech: tts dictionaries')
      ctx.effect(() => ctx.locale.register(STT_NS, { en: sttEn, zh: sttZh }), 'dsh-plugin-speech: stt dictionaries')

      /** Mount the read-aloud half. */
      function mountTts () {
        const settings = createSettingsStore(TTS_SETTINGS_KEY, { autoplay: true, highlight: true, server: null, model: null, voice: null, speed: null }, (parsed, fallback) => ({
          autoplay: typeof parsed.autoplay === 'boolean' ? parsed.autoplay : fallback.autoplay,
          highlight: typeof parsed.highlight === 'boolean' ? parsed.highlight : fallback.highlight,
          server: typeof parsed.server === 'string' ? parsed.server : null,
          model: typeof parsed.model === 'string' ? parsed.model : null,
          voice: typeof parsed.voice === 'string' ? parsed.voice : null,
          speed: typeof parsed.speed === 'number' ? parsed.speed : null,
        }))
        const info = createStore({ status: 'loading', value: null, error: null })
        const wave = createStore({ levels: [] })
        const engine = createEngine(settings, info, wave)
        const watcher = createWatcher(ctx, engine, settings)
        const refresh = async (force) => {
          try {
            info.set({ status: 'ready', value: await requestJson(force ? `${TTS_ROUTES.info}?refresh=1` : TTS_ROUTES.info), error: null })
          } catch (error) {
            info.set({ status: 'error', value: info.getSnapshot().value, error: String(error?.message ?? error) })
          }
        }
        const read = (sessionId, messageId, element) => {
          const text = readAssistantText(ctx, sessionId, messageId)
          if (text === '') {
            engine.fail('empty')
            return
          }
          void engine.speak(messageId, text, { scope: renderingScope(element) })
        }
        const readLast = (sessionId) => {
          const found = findLastAssistant(ctx, sessionId)
          if (found === null) {
            engine.fail('empty')
            return
          }
          void engine.speak(found.id, found.text)
        }
        const ttsState = { getSnapshot: engine.state.getSnapshot, subscribe: engine.state.subscribe }
        const ttsWave = { getSnapshot: wave.getSnapshot, subscribe: wave.subscribe }
        const ttsSettings = { getSnapshot: settings.getSnapshot, subscribe: settings.subscribe }
        const ttsInfo = { getSnapshot: info.getSnapshot, subscribe: info.subscribe }
        ctx.effect(() => () => {
          watcher.dispose()
          engine.dispose()
        }, 'dsh-plugin-speech: read-aloud lifetime')
        void refresh(true)
        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'speech-listen',
          order: 5,
          locale: TTS_NS,
          inject: () => ({ hooks: { ttsState }, read, stop: () => engine.stop() }),
        }, ListenAction), 'dsh-plugin-speech: reply action')
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'speech-read-aloud',
          order: 60,
          locale: TTS_NS,
          inject: () => ({
            hooks: { ttsState, ttsSettings, ttsInfo },
            readLast,
            watch: (sessionId) => watcher.bind(sessionId),
            updateSettings: (patch) => settings.save(patch),
            refresh,
          }),
        }, ReadControl), 'dsh-plugin-speech: read-aloud control')
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'speech-caption',
          order: 40,
          locale: TTS_NS,
          inject: () => ({
            hooks: { ttsState, ttsWave },
            pause: () => engine.pause(),
            resume: () => engine.resume(),
            stop: () => engine.stop(),
          }),
        }, Player), 'dsh-plugin-speech: transport bar')
      }

      /** Mount the dictation half. */
      function mountStt () {
        const settings = createSettingsStore(STT_SETTINGS_KEY, { server: null, model: null, language: 'auto' }, (parsed, fallback) => ({
          server: typeof parsed.server === 'string' ? parsed.server : null,
          model: typeof parsed.model === 'string' ? parsed.model : null,
          language: typeof parsed.language === 'string' ? parsed.language : 'auto',
        }))
        const info = createStore({ status: 'loading', value: null, error: null })
        const recorder = createRecorder(settings, info)
        const refresh = async (force) => {
          try {
            info.set({ status: 'ready', value: await requestJson(force ? `${STT_ROUTES.info}?refresh=1` : STT_ROUTES.info), error: null })
          } catch (error) {
            info.set({ status: 'error', value: info.getSnapshot().value, error: String(error?.message ?? error) })
          }
        }
        const sttState = { getSnapshot: recorder.state.getSnapshot, subscribe: recorder.state.subscribe }
        const sttWave = { getSnapshot: recorder.wave.getSnapshot, subscribe: recorder.wave.subscribe }
        const sttSettings = { getSnapshot: settings.getSnapshot, subscribe: settings.subscribe }
        const sttInfo = { getSnapshot: info.getSnapshot, subscribe: info.subscribe }
        ctx.effect(() => () => recorder.dispose(), 'dsh-plugin-speech: microphone lifetime')
        void refresh(true)
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'speech-listening',
          order: 30,
          locale: STT_NS,
          inject: () => ({
            hooks: { sttState, sttWave },
            stop: () => recorder.stop(),
            cancel: () => recorder.cancel(),
          }),
        }, ListeningBar), 'dsh-plugin-speech: listening bar')
        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'speech-dictate',
          order: 55,
          locale: STT_NS,
          inject: () => ({
            hooks: { sttState, sttSettings, sttInfo },
            updateSettings: (patch) => settings.save(patch),
            refresh,
            start: (options) => recorder.start(options),
            stop: () => recorder.stop(),
          }),
        }, DictateControl), 'dsh-plugin-speech: dictation control')
      }

      void (async () => {
        const [tts, stt] = await Promise.all([probe(TTS_ROUTES.info), probe(STT_ROUTES.info)])
        if (disposed) return
        if (tts !== 'off') mountTts()
        if (stt !== 'off') mountStt()
      })()
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      apply,
      cleanForSpeech,
      splitChunks,
      selectionOf,
      createSettingsStore,
      createStore,
      encodeWav,
      levelOf,
      normalizeForSearch,
      findTextRange,
      renderingScope,
      createHighlighter,
      Waveform,
      ListenAction,
      Player,
      ReadControl,
      DictateControl,
      ListeningBar,
    }
    return module.exports
  },
})
