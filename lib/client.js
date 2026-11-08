/**
 * dsh-plugin-speech — browser half.
 *
 * One bundle for both speech components of the Web GUI:
 *  - read-aloud (`tts`): a Listen control on each finalized assistant reply,
 *    autoplay, a seekable player with sentence highlighting, and the
 *    experimental multi-voice cast;
 *  - dictation (`stt`): a composer microphone, a live waveform bar, and a
 *    dictation panel that inserts the transcript at the captured caret.
 *
 * Both halves post their events to one shared `/audio/log` route, register one
 * locale namespace each, and switch independently: `/audio/status` says which
 * components are on, and only those slots are registered. A failed probe mounts
 * both halves, because a probe failure must never hide UI.
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
    /** Internal cancellation sentinel: a stop is not an error. */
    const STOP = Symbol('tts stop')
    /** Routes owned by the read-aloud half. */
    const TTS_ROUTES = { info: '/tts/info', speak: '/tts/speak', cast: '/tts/cast' }
    /** Routes owned by the dictation half. */
    const STT_ROUTES = { info: '/stt/info', transcribe: '/stt/transcribe' }
    /** Routes shared by both halves. */
    const AUDIO_ROUTES = { status: '/audio/status', log: '/audio/log', echo: '/audio/echo' }
    /** Persisted browser preferences. */
    const TTS_SETTINGS_KEY = 'dsh.tts.settings.v1'
    const STT_SETTINGS_KEY = 'dsh.stt.settings.v1'
    /** Longest sentence group sent in one synthesis request, in characters. */
    const CHUNK_CHARS = 380
    /** Stand-in for a decimal point while sentences are being split. */
    const DECIMAL = '\u0001'
    /** Rate the transcription endpoints expect. */
    const SAMPLE_RATE = 16000
    /** Most waveform columns kept in the recording bar; the bar shows as many as fit. */
    const WAVE_BARS = 520
    /** Level sampling period; the wave repaints at the same cadence. */
    const LEVEL_INTERVAL_MS = 80
    /** Fixed sentence the component round-trip speaks and transcribes. */
    const ECHO_SAMPLE = 'The quick brown fox jumps over the lazy dog.'

    /**
     * Read-aloud preferences: a null field means "follow the Host default from
     * `/tts/info`" — the server, model, and voice are chosen here, never
     * assumed by the code.
     */
    const TTS_SETTINGS = {
      key: TTS_SETTINGS_KEY,
      fallback: { autoplay: true, highlight: true, server: null, model: null, voice: null, speed: null },
      restore (parsed, fallback) {
        return {
          autoplay: typeof parsed.autoplay === 'boolean' ? parsed.autoplay : fallback.autoplay,
          highlight: typeof parsed.highlight === 'boolean' ? parsed.highlight : fallback.highlight,
          server: typeof parsed.server === 'string' ? parsed.server : null,
          model: typeof parsed.model === 'string' ? parsed.model : null,
          voice: typeof parsed.voice === 'string' ? parsed.voice : null,
          speed: typeof parsed.speed === 'number' ? parsed.speed : null,
        }
      },
    }

    /** Dictation preferences. */
    const STT_SETTINGS = {
      key: STT_SETTINGS_KEY,
      fallback: { server: null, model: null, language: 'auto' },
      restore (parsed, fallback) {
        return {
          server: typeof parsed.server === 'string' ? parsed.server : null,
          model: typeof parsed.model === 'string' ? parsed.model : null,
          language: typeof parsed.language === 'string' ? parsed.language : 'auto',
        }
      },
    }

    /* ------------------------------------------------------------------ locale */

    /** Simplified Chinese dictionary. */
    const ttsZh = {
      'action.listen': '朗读这条回复',
      'action.stop': '停止朗读',
      'trigger': '朗读',
      'panel.aria': '朗读设置',
      'panel.title': '朗读回复',
      'autoplay': '自动朗读新回复',
      'highlight': '朗读时高亮当前句',
      'caption.loading': '准备朗读…',
      'caption.stop': '停止朗读',
      'player.prev': '上一句',
      'player.next': '下一句',
      'player.pause': '暂停',
      'player.resume': '继续',
      'player.seek': '播放进度',
      'player.replay': '重读这一句',
      'player.dismiss': '关闭',
      'player.speed': '点击切换语速',
      'player.close': '停止并关闭',
      'status.failed': '朗读失败',
      'status.hint.default': '这个语音服务没有响应，请检查语音设置。',
      'status.hint.network': '与语音服务的连接中断了，请再试一次。',
      'status.hint.server': '这个语音服务拒绝了请求，请检查语音设置。',
      'server': '服务',
      'model': '模型',
      'voice': '声音',
      'speed': '语速',
      'cast': '多角色朗读（实验）',
      'castVoice': '当前声音',
      'castHint': '让模型用多角色写作，并按段落切换声音；会向模型注入一条后台说明。',
      'readLast': '朗读最后一条回复',
      'status.ready': '语音服务就绪',
      'status.loading': '正在连接语音服务…',
      'status.offline': '无法读取语音服务配置。',
      'status.none': '未找到 TTS 模型 — 请先在模型提供方中添加语音服务。',
      'status.blocked': '浏览器拦截了自动播放 — 请点击回复上的朗读按钮。',
      'status.empty': '这条回复没有可朗读的文本。',
      'status.playing': '正在朗读 {index}/{total}',
      'hint': '由本地 audio.cpp 合成，音频不离开本机。',
      'demo.title': '组件',
      'demo.unavailable': '无法读取组件状态。',
      'demo.roundtrip': '往返测试',
      'demo.running': '正在测试…',
      'demo.transcript': '听到的内容',
      'demo.timings': '语音 {speak} 毫秒 · 转写 {transcribe} 毫秒',
    }

    /** English dictionary. */
    const ttsEn = {
      'action.listen': 'Listen to this reply',
      'action.stop': 'Stop reading',
      'trigger': 'Listen',
      'panel.aria': 'Read-aloud settings',
      'panel.title': 'Read replies aloud',
      'autoplay': 'Read new replies aloud',
      'highlight': 'Highlight the sentence being read',
      'caption.loading': 'Preparing speech…',
      'caption.stop': 'Stop reading',
      'player.prev': 'Previous sentence',
      'player.next': 'Next sentence',
      'player.pause': 'Pause',
      'player.resume': 'Resume',
      'player.seek': 'Playback position',
      'player.replay': 'Replay this sentence',
      'player.dismiss': 'Dismiss',
      'player.speed': 'Click to change the speaking rate',
      'player.close': 'Stop and close',
      'status.failed': 'Playback failed',
      'status.hint.default': 'The speech provider did not answer — check the speech settings.',
      'status.hint.network': 'The connection to the speech provider dropped — try again.',
      'status.hint.server': 'The speech provider refused the request — check the speech settings.',
      'server': 'Server',
      'model': 'Model',
      'voice': 'Voice',
      'speed': 'Speed',
      'cast': 'Multiple voices (experimental)',
      'castVoice': 'Voice on this part',
      'castHint': 'Asks the model to write with a small cast, then reads each part in its own voice. Adds a background note to the model; needs a model with several voices.',
      'readLast': 'Read the last reply',
      'status.ready': 'Speech server ready',
      'status.loading': 'Connecting to the speech service…',
      'status.offline': 'Could not read the speech configuration.',
      'status.none': 'No TTS model found — add a speech server as a model provider.',
      'status.blocked': 'The browser blocked autoplay — press Listen on a reply.',
      'status.empty': 'This reply has no readable text.',
      'status.playing': 'Reading {index}/{total}',
      'hint': 'Synthesized by the local audio.cpp server; audio never leaves the machine.',
      'demo.title': 'Components',
      'demo.unavailable': 'Component status is unavailable.',
      'demo.roundtrip': 'Round-trip test',
      'demo.running': 'Testing…',
      'demo.transcript': 'Heard',
      'demo.timings': 'Speech {speak} ms · transcription {transcribe} ms',
    }

    const sttZh = {
      'trigger': '听写',
      'trigger.start': '开始听写',
      'trigger.stop': '停止并转写',
      'panel.aria': '听写设置',
      'panel.title': '语音输入',
      'recording': '正在录音 {time}',
      'working': '正在转写…',
      'stop': '停止',
      'cancel': '取消',
      'server': '服务',
      'model': '模型',
      'language': '语言',
      'status.ready': '使用 {server} / {model}',
      'status.none': '没有可用的转写服务 — 请先配置一个模型提供方。',
      'status.denied': '麦克风权限被拒绝。',
      'status.insecure': '麦克风需要安全上下文（回环地址或 HTTPS）。',
      'status.empty': '没有识别到语音。',
      'hint': '录音在浏览器内完成，音频发送到本地模型服务。',
    }

    const sttEn = {
      'trigger': 'Dictate',
      'trigger.start': 'Start dictating',
      'trigger.stop': 'Stop and transcribe',
      'panel.aria': 'Dictation settings',
      'panel.title': 'Voice input',
      'recording': 'Listening {time}',
      'working': 'Transcribing…',
      'stop': 'Stop',
      'cancel': 'Cancel',
      'server': 'Server',
      'model': 'Model',
      'language': 'Language',
      'status.ready': 'Using {server} / {model}',
      'status.none': 'No transcription provider — configure one as a model provider.',
      'status.denied': 'Microphone permission was refused.',
      'status.insecure': 'The microphone needs a secure origin (loopback or HTTPS).',
      'status.empty': 'Nothing was recognised.',
      'hint': 'Recording happens in the page; the audio goes to your local model server.',
    }

    /** Locale namespace owned by the bundle-level surfaces (configuration pages). */
    const AUDIO_NS = 'audio'

    const audioZh = {
      'config.loading': '正在读取配置…',
      'config.saved': '已保存。',
      'config.refused': 'Host 拒绝了这次修改。',
      'config.unavailable': '该组件已停用 — 配置不可用。',
      'config.reset': '重置',
      'config.auto': '首个可用项',
      'config.voiceCatalog': '语音目录路径',
      'config.voiceCatalog.help': '每行一个引擎 server.json 的路径。',
      'config.discoveryTtlMs': '发现结果有效期（毫秒）',
      'config.discoveryTtlMs.help': '发现结果在这一时间内复用，不重新探测。',
      'config.logLimit': '日志条数上限',
      'config.logLimit.help': '共享事件日志保留的条数。',
      'config.server': '服务',
      'config.server.help': '留空表示使用首个发现的服务。',
      'config.model': '模型',
      'config.model.help': '留空表示使用首个发现的模型。',
      'config.voice': '声音',
      'config.voice.help': '留空表示使用引擎默认声音。',
      'config.speed': '语速',
      'config.speed.help': '请求未指定语速时使用的值。',
      'config.maxChars': '单次字符上限',
      'config.maxChars.help': '一次合成请求接受的最长文本。',
      'config.language': '语言',
      'config.language.help': '留空或 auto 交给模型自行判断。',
      'config.maxAudioBytes': '录音字节上限',
      'config.maxAudioBytes.help': '接受的最大录音大小。',
      'config.sample': '示例句子',
      'config.sample.help': '往返测试未提供文本时朗读的句子。',
    }

    const audioEn = {
      'config.loading': 'Reading the configuration…',
      'config.saved': 'Saved.',
      'config.refused': 'The Host refused the change.',
      'config.unavailable': 'This component is switched off — its configuration is unavailable.',
      'config.reset': 'Reset',
      'config.auto': 'First discovered',
      'config.voiceCatalog': 'Voice catalog paths',
      'config.voiceCatalog.help': 'One path to an engine server.json per line.',
      'config.discoveryTtlMs': 'Discovery TTL (ms)',
      'config.discoveryTtlMs.help': 'A discovery result is reused for this long before the engines are probed again.',
      'config.logLimit': 'Log entries kept',
      'config.logLimit.help': 'Entries retained in the shared event log.',
      'config.server': 'Server',
      'config.server.help': 'Empty uses the first discovered server.',
      'config.model': 'Model',
      'config.model.help': 'Empty uses the first discovered model.',
      'config.voice': 'Voice',
      'config.voice.help': 'Empty uses the engine default.',
      'config.speed': 'Speed',
      'config.speed.help': 'Speaking rate used when a request names none.',
      'config.maxChars': 'Max characters',
      'config.maxChars.help': 'Longest text one synthesis request accepts.',
      'config.language': 'Language',
      'config.language.help': 'Empty or auto lets the model detect it.',
      'config.maxAudioBytes': 'Max recording bytes',
      'config.maxAudioBytes.help': 'Largest accepted recording.',
      'config.sample': 'Sample sentence',
      'config.sample.help': 'Spoken by the round-trip test when no text is given.',
    }

    /* --------------------------------------------------------------------- css */

    /** Styles for the read-aloud half. */
    const TTS_STYLES = [
      '.dsh-tts-action{width:calc(28px + var(--dsh-content-font-delta,0px));height:calc(28px + var(--dsh-content-font-delta,0px));border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);cursor:pointer;background:0 0;border:none;justify-content:center;align-items:center;padding:6px;display:inline-flex}',
      '.dsh-tts-action svg{width:calc(15px + var(--dsh-content-font-delta,0px));height:calc(15px + var(--dsh-content-font-delta,0px))}',
      '.dsh-tts-action:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-action[data-active]{color:var(--dsw-alias-state-business-primary)}',
      '.dsh-tts-trigger{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:4px;padding:0 4px 0 8px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.dsh-tts-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-tts-trigger[data-on]{color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-trigger svg{width:14px;height:14px}',
      '.dsh-tts-trigger-label{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dsh-tts-panel{position:fixed;z-index:90;width:352px;max-height:min(72vh,560px);overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);box-shadow:0 12px 40px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);font-size:13px;text-align:left}',
      '.dsh-tts-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-tts-field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-tts-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-tts-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:148px;overflow-y:auto;padding-right:2px}',
      '.dsh-tts-chip{box-sizing:border-box;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);height:26px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;padding:0 9px}',
      '.dsh-tts-chip:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-tts-chip[data-active]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-tts-read{border-radius:var(--dsw-radius-sm);height:30px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-tts-read:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-tts-status{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.dsh-tts-status[data-tone=warn]{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-tts-footer{display:flex;align-items:center;justify-content:space-between;gap:10px}',
      '.dsh-tts-player{display:flex;flex-direction:column;gap:6px;padding:5px 12px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;box-sizing:border-box;width:100%;max-width:var(--dsh-composer-card-max-width,952px);margin-inline:auto;flex:none}',
      '.dsh-tts-player-row{display:flex;align-items:center;gap:6px;min-width:0}',
      '.dsh-tts-failed{gap:8px;border-color:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 45%, transparent);background:color-mix(in srgb, var(--dsw-alias-state-error-primary,#e5484d) 10%, var(--dsw-alias-bg-layer-1))}',
      '.dsh-tts-failed-label{flex:none;font-weight:500;color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsh-tts-failed-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-close{width:22px;height:22px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;background:0 0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}',
      '.dsh-tts-close:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-close svg{width:12px;height:12px}',
      '.dsh-tts-pbtn{width:24px;height:24px;flex:none;display:inline-flex;align-items:center;justify-content:center;border:none;background:0 0;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-secondary);cursor:pointer;padding:0}',
      '.dsh-tts-pbtn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-pbtn svg{width:14px;height:14px}',
      '.dsh-tts-seek{flex:1;min-width:64px;height:14px;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-tts-voice{flex:none;max-width:96px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-tertiary);font-size:11px}',
      '.dsh-tts-rate{flex:none;border:.5px solid var(--dsw-alias-border-l4);background:0 0;border-radius:var(--dsw-radius-sm);padding:1px 2px 1px 4px;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer;appearance:none;-webkit-appearance:none}',
      '.dsh-tts-rate:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-tts-time{flex:none;border:none;background:0 0;padding:2px 4px;border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-caption);font:inherit;font-size:11px;font-variant-numeric:tabular-nums;cursor:pointer}',
      '.dsh-tts-time:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '::highlight(dsh-tts-reading){background-color:rgba(106,166,255,.30);color:inherit}',
      '[data-dsh-tts-reading]{background-color:rgba(106,166,255,.22);border-radius:3px;box-shadow:0 0 0 1px rgba(106,166,255,.35)}',
    ].join('')

    /** Styles for the dictation half. */
    const STT_STYLES = [
      '.dsh-stt-group{display:inline-flex;align-items:center;gap:0}',
      '.dsh-stt-caret{border-radius:var(--dsw-radius-sm);height:28px;width:18px;display:inline-flex;align-items:center;justify-content:center;padding:0;border:none;background:0 0;color:var(--dsw-alias-label-caption);cursor:pointer}',
      '.dsh-stt-caret:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.dsh-stt-caret svg{width:12px;height:12px}',
      '.dsh-stt-trigger{border-radius:var(--dsw-radius-sm);height:28px;color:var(--dsw-alias-label-secondary);cursor:pointer;background:0 0;border:none;outline:none;align-items:center;gap:6px;padding:0 6px;font-size:13px;font-weight:500;line-height:20px;display:inline-flex}',
      '.dsh-stt-trigger:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-stt-trigger svg{width:14px;height:14px}',
      '.dsh-stt-trigger[data-recording]{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.dsh-stt-dot{width:7px;height:7px;border-radius:50%;background:currentColor;display:inline-block;animation:dsh-stt-pulse 1s ease-in-out infinite}',
      '@keyframes dsh-stt-pulse{0%,100%{opacity:1}50%{opacity:.25}}',
      '.dsh-stt-panel{position:fixed;z-index:90;width:352px;max-height:min(72vh,560px);overflow-y:auto;box-sizing:border-box;display:flex;flex-direction:column;gap:12px;padding:14px;border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-layer-1);border:.5px solid var(--dsw-alias-border-l4);box-shadow:0 12px 40px rgba(0,0,0,.32);color:var(--dsw-alias-label-primary);font-size:13px;text-align:left}',
      '.dsh-stt-title{font-size:13px;font-weight:500;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-stt-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-stt-field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-stt-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}',
      '.dsh-stt-chips{display:flex;flex-wrap:wrap;gap:6px;max-height:148px;overflow-y:auto;padding-right:2px}',
      '.dsh-stt-chip{box-sizing:border-box;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-sm);height:26px;color:var(--dsw-alias-label-primary);font:inherit;font-size:12px;line-height:18px;cursor:pointer;background:0 0;padding:0 9px}',
      '.dsh-stt-chip:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-stt-chip[data-active]{border-color:var(--dsw-alias-button-primary-fill);background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-stt-action{border-radius:var(--dsw-radius-sm);height:30px;border:.5px solid var(--dsw-alias-border-l4);color:var(--dsw-alias-label-primary);background:0 0;font:inherit;font-size:12px;cursor:pointer}',
      '.dsh-stt-action:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dsh-stt-status{color:var(--dsw-alias-label-caption);font-size:11px;line-height:16px;overflow-wrap:anywhere}',
      '.dsh-stt-status[data-tone=warn]{color:var(--dsw-alias-label-tertiary)}',
      '.dsh-stt-bar{display:flex;align-items:center;gap:10px;box-sizing:border-box;width:calc(100% - 2 * var(--dsh-composer-side-clearance, 16px));max-width:var(--dsh-composer-card-max-width,952px);margin-inline:auto;padding:6px 10px;border-radius:999px;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 12%, transparent);color:var(--dsw-alias-label-secondary);font-size:12px;line-height:17px;flex:none}',
      '.dsh-stt-bar-spin{width:12px;height:12px;flex:none;border-radius:50%;border:2px solid var(--dsw-alias-border-l3);border-top-color:var(--dsw-alias-state-business-primary);animation:dsh-stt-spin .8s linear infinite}',
      '@keyframes dsh-stt-spin{to{transform:rotate(360deg)}}',
      '.dsh-stt-bar-label{flex:1;color:var(--dsw-alias-label-secondary);padding-left:2px}',
      '.dsh-stt-wave-host{flex:1;min-width:0;display:flex;align-items:center}',
      '.dsh-stt-wave{display:flex;align-items:center;gap:2px;flex:1;min-width:0;height:24px;overflow:hidden}',
      '.dsh-stt-wave-bar{flex:0 0 2px;min-height:2px;border-radius:999px;background:var(--dsw-alias-state-business-primary);transition:height .09s ease-out}',
      '.dsh-stt-time{flex:none;color:var(--dsw-alias-label-caption);font-variant-numeric:tabular-nums;font-size:11px;padding:0 4px}',
      '.dsh-stt-round{width:26px;height:26px;flex:none;display:inline-flex;align-items:center;justify-content:center;padding:0;border-radius:50%;border:none;background:color-mix(in srgb, var(--dsw-alias-state-business-primary) 22%, transparent);color:var(--dsw-alias-state-business-primary);cursor:pointer}',
      '.dsh-stt-round:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dsh-stt-round svg{width:13px;height:13px}',
      '.dsh-stt-round[data-primary]{background:var(--dsw-alias-button-primary-fill);color:var(--dsw-alias-label-primary-foreground)}',
      '.dsh-stt-round[data-primary]:hover{filter:brightness(1.08)}',
    ].join('')

    /** Styles for the shared component inventory demo in the read-aloud panel. */
    const AUDIO_STYLES = [
      '.dsh-tts-components{display:flex;flex-wrap:wrap;gap:6px 12px}',
      '.dsh-tts-component{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary)}',
      '.dsh-tts-dot{width:7px;height:7px;flex:none;border-radius:50%;background:var(--dsw-alias-state-business-primary);display:inline-block}',
      '.dsh-tts-component-name{white-space:nowrap}',
      '.dsh-tts-demo-transcript{overflow-wrap:anywhere}',
    ].join('')

    /** Styles for the bundle's configuration pages on the Plugins screen. */
    const CONFIG_STYLES = [
      '.dsh-audio-config{display:flex;flex-direction:column;gap:14px}',
      '.dsh-audio-config-field{display:flex;flex-direction:column;gap:6px}',
      '.dsh-audio-config-head{display:flex;align-items:center;justify-content:space-between;gap:12px}',
      '.dsh-audio-config-label{font-size:13px;line-height:20px;color:var(--dsw-alias-label-primary)}',
      '.dsh-audio-config-help{margin:0;font-size:11.5px;line-height:17px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.dsh-audio-config-input{box-sizing:border-box;width:100%;min-height:32px;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;padding:4px 10px;outline:none}',
      '.dsh-audio-config-input:focus{border-color:var(--dsw-alias-state-business-primary)}',
      'textarea.dsh-audio-config-input{min-height:64px;resize:vertical;font-family:var(--sw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:12px}',
      '.dsh-audio-config-reset{flex:none;border:none;background:0 0;color:var(--dsw-alias-label-secondary);cursor:pointer;font-size:11.5px;line-height:16px;padding:0}',
      '.dsh-audio-config-reset:hover{color:var(--dsw-alias-label-primary);text-decoration:underline}',
      '.dsh-audio-config-note{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere}',
      '.dsh-audio-config-note[data-tone=warn]{color:var(--dsw-alias-label-secondary)}',
    ].join('')

    /** One stylesheet for both halves: the class prefixes keep them apart. */
    const STYLES = TTS_STYLES + STT_STYLES + AUDIO_STYLES + CONFIG_STYLES

    /** Inject the plugin stylesheet once per page. */
    function installCss () {
      const id = 'dsh-plugin-speech/audio.css'
      if (typeof document === 'undefined') return
      if (document.querySelector(`style[data-plugin-css="${id}"]`) !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-plugin-speech'
      tag.dataset.pluginCss = id
      tag.textContent = STYLES
      document.head.appendChild(tag)
    }

    /* ------------------------------------------------------------------- store */

    /**
     * Minimal observable store (`getSnapshot`/`subscribe`), the shape the slot
     * system's injected hooks read.
     * @param initial - first value.
     * @returns A snapshot store with `set` and `update`.
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

    /* ---------------------------------------------------------------- settings */

    /**
     * Browser preferences persisted in localStorage, restored through the
     * half's own field spec.
     * @param spec - `{ key, fallback, restore(parsed, fallback) }`; defaults to
     *   the read-aloud preferences.
     * @returns A store with `save(patch)`.
     */
    function createSettingsStore (spec = TTS_SETTINGS) {
      const fallback = spec.fallback
      let initial = fallback
      try {
        const raw = window.localStorage.getItem(spec.key)
        const parsed = raw === null ? null : JSON.parse(raw)
        if (parsed !== null && typeof parsed === 'object') initial = spec.restore(parsed, fallback)
      } catch {
        /* storage unavailable: session-only preferences */
      }
      const store = createStore(initial)
      return {
        ...store,
        getSnapshot: store.getSnapshot,
        subscribe: store.subscribe,
        save (patch) {
          store.update(patch)
          try {
            window.localStorage.setItem(spec.key, JSON.stringify(store.getSnapshot()))
          } catch {
            /* ignore quota/denied storage */
          }
        },
      }
    }

    /* ----------------------------------------------------------------- logging */

    /**
     * Event reporter for one half: repeat-suppressed, console-echoed, and posted
     * to the shared `/audio/log` route with its `component` tag.
     * @param component - `'tts'` or `'stt'`.
     * @returns `(level, event, detail) => void`.
     */
    function createReporter (component) {
      /** Repeat suppression for noisy events, keyed by event and first detail. */
      const recent = new Map()
      return (level, event, detail) => {
        const key = `${event}|${JSON.stringify(detail ?? {}).slice(0, 96)}`
        const now = Date.now()
        const seen = recent.get(key)
        if (seen !== undefined && now - seen < 5000) return
        recent.set(key, now)
        if (recent.size > 64) recent.clear()
        if (level === 'error') console.warn(`[${component}]`, event, detail)
        else console.debug(`[${component}]`, event, detail)
        void fetch(AUDIO_ROUTES.log, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ component, level, event, detail }),
        }).catch(() => {})
      }
    }

    /* -------------------------------------------------------------- components */

    /** Subscriber hook over one injected observable. */
    function useValue (useSnapshot) {
      return useSnapshot((value) => value)
    }

    /** Format seconds as `m:ss`. */
    function clockOf (seconds) {
      const whole = Math.max(0, Math.round(Number(seconds) || 0))
      return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`
    }

    /* -------------------------------------------------------------- selection */

    /**
     * Resolve the server, model, and voice a preference set means against the
     * Host's discovery result: the stored choice, else the Host default, else the
     * first offered row.
     * @param preferences - settings snapshot.
     * @param discovered - `/tts/info` value, or null before it loads.
     * @returns The resolved selection plus the rosters the panel offers.
     */
    function selectionOf (preferences, discovered) {
      const servers = Array.isArray(discovered?.servers) ? discovered.servers : []
      const defaults = discovered?.defaults ?? {}
      const server = servers.find((row) => row.id === preferences.server) ??
        servers.find((row) => row.id === defaults.server) ??
        servers[0] ?? null
      /* The speech direction lists model records, the transcription direction
         bare ids; normalize once so both halves read the same shape. */
      const models = (Array.isArray(server?.models) ? server.models : [])
        .map((model) => (typeof model === 'string' ? { id: model, label: model, voices: [] } : model))
      const model = models.find((row) => row.id === preferences.model) ??
        models.find((row) => row.id === defaults.model) ??
        models[0] ?? null
      const voices = Array.isArray(model?.voices) ? model.voices : []
      const byName = (value) => {
        if (value === undefined || value === null) return undefined
        const wanted = String(value).toLowerCase()
        return voices.find((row) => String(row.label ?? '').toLowerCase() === wanted)
      }
      const voice = voices.find((row) => row.id === preferences.voice) ??
        byName(preferences.voice) ??
        voices.find((row) => row.id === defaults.voice) ??
        voices.find((row) => row.default === true) ??
        voices[0] ?? null
      const speeds = Array.isArray(discovered?.speeds) && discovered.speeds.length > 0 ? discovered.speeds : [0.75, 1, 1.25, 1.5, 2]
      const speed = typeof preferences.speed === 'number' ? preferences.speed : defaults.speed ?? 1
      return { server, model, voice, speed, servers, models, voices, speeds }
    }

    /* ------------------------------------------------------------ host config */

    /**
     * Fetch the Host's speech configuration and engine status.
     * @param store - configuration store to publish into.
     * @returns Completion; failures land in the store.
     */
    async function refreshInfo (store, refresh = false) {
      const previous = store.getSnapshot()
      if (previous.status !== 'ready') store.set({ ...previous, status: 'loading', error: null })
      try {
        const response = await fetch(refresh ? `${TTS_ROUTES.info}?refresh=1` : TTS_ROUTES.info, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`/tts/info answered ${response.status}`)
        const value = await response.json()
        store.set({ status: 'ready', value, error: null })
      } catch (error) {
        store.set({ status: 'error', value: previous.value, error: String(error?.message ?? error) })
      }
    }

    /* -------------------------------------------------------------------- text */

    /**
     * Turn rendered markdown into speakable prose: drop code, keep words, drop
     * markup and bare URLs.
     * @param markdown - reply text as stored in the Session log.
     * @returns Prose with collapsed whitespace.
     */
    function cleanForSpeech (markdown) {
      let text = String(markdown)
      /* Symbol and numeral forms the engines read badly. Kokoro renders `12.5`
         as "twelve, five" — a pause, not a decimal — so the point is spelled. */
      text = text.replace(/(\d)\s*\.\s*(\d)/g, '$1 point $2')
      text = text.replace(/(\d)\s*[×x]\s*/g, '$1 times ')
      text = text.replace(/(\d)\s*%/g, '$1 percent')
      text = text.replace(/(\d)\s*°/g, '$1 degrees')
      text = text.replace(/```[\s\S]*?```/g, ' ')
      text = text.replace(/~~~[\s\S]*?~~~/g, ' ')
      text = text.replace(/`([^`]*)`/g, '$1')
      text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      text = text.replace(/<(https?:\/\/[^>\s]+)>/g, ' ')
      text = text.replace(/\bhttps?:\/\/\S+/g, ' ')
      text = text.replace(/<[^>\n]+>/g, ' ')
      text = text.replace(/^\s*\|?[\s:|-]{4,}\|?\s*$/gm, ' ')
      text = text.replace(/^\s{0,3}#{1,6}\s+/gm, '')
      text = text.replace(/^\s{0,3}>\s?/gm, '')
      text = text.replace(/^\s{0,3}[-*+]\s+/gm, '')
      text = text.replace(/^\s{0,3}\d+[.)]\s+/gm, '')
      text = text.replace(/^\s*([-*_])\1{2,}\s*$/gm, ' ')
      text = text.replace(/\*\*/g, '')
      text = text.replace(/__/g, '')
      text = text.replace(/(^|[\s(])\*([^*\n]+)\*/g, '$1$2')
      text = text.replace(/(^|[\s(])_([^_\n]+)_/g, '$1$2')
      text = text.replace(/~~([^~]+)~~/g, '$1')
      text = text.replace(/[ \t]*\|[ \t]*/g, ', ')
      return text.replace(/\r/g, '\n').replace(/\s+/g, ' ').trim()
    }

    /**
     * Split prose into sentence groups of at most `max` characters.
     * @param text - cleaned prose.
     * @param max - character budget per group.
     * @returns Groups in reading order; empty when there is nothing to say.
     */
    function splitChunks (text, max = CHUNK_CHARS) {
      const prose = String(text).trim()
      if (prose === '') return []
      /* A decimal point is not a sentence end: `12.5` must stay `12.5`, or the
         engine says "twelve" and then "five" as a new sentence. */
      const guarded = prose.replace(/(\d)\.(\d)/g, (_, before, after) => `${before}${DECIMAL}${after}`)
      const sentences = (guarded.match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g) ?? [guarded])
        .map((sentence) => sentence.split(DECIMAL).join('.'))
      const chunks = []
      let buffer = ''
      const flush = () => {
        const value = buffer.trim()
        if (value !== '') chunks.push(value)
        buffer = ''
      }
      for (const sentence of sentences) {
        const piece = sentence.trim()
        if (piece === '') continue
        if (piece.length > max) {
          flush()
          for (const line of hardSplit(piece, max)) chunks.push(line)
          continue
        }
        if (buffer === '') buffer = piece
        else if (buffer.length + 1 + piece.length <= max) buffer = `${buffer} ${piece}`
        else {
          flush()
          buffer = piece
        }
      }
      flush()
      return chunks
    }

    /**
     * Break one over-long sentence at commas, then at spaces.
     * @param sentence - sentence longer than the budget.
     * @param max - character budget.
     * @returns Pieces within the budget.
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

    /** Normalize one event-window entry to its Session event. */
    function eventOf (entry) {
      return entry !== null && typeof entry === 'object' && 'event' in entry ? entry.event : entry
    }

    /** Read the durable event window of one Session, or an empty list. */
    function windowOf (ctx, sessionId) {
      try {
        const binding = ctx.sessions.binding(sessionId)
        if (binding === undefined || binding === null) return null
        return binding.eventSource.getSnapshot()
      } catch {
        return null
      }
    }

    /** Join the visible text blocks of one assistant message. */
    function messageProse (event) {
      const content = event?.data?.message?.content
      if (!Array.isArray(content)) return ''
      const parts = []
      for (const block of content) {
        if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
      }
      return cleanForSpeech(parts.join('\n'))
    }

    /**
     * Read one finalized assistant message as speakable prose.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session owning the message.
     * @param messageId - durable message identity from the action slot.
     * @returns Prose, or an empty string when the message is not in the loaded window.
     */
    function readAssistantText (ctx, sessionId, messageId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return ''
      for (const entry of window.entries) {
        const event = eventOf(entry)
        if (event?.type !== 'assistant/message') continue
        if (event.data?.message?.id !== messageId) continue
        return messageProse(event)
      }
      return ''
    }

    /**
     * The raw markdown of one assistant message, before any cleanup.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session owning the message.
     * @param messageId - durable message identity.
     * @returns Raw text, or an empty string.
     */
    function readAssistantRaw (ctx, sessionId, messageId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return ''
      for (const entry of window.entries) {
        const event = eventOf(entry)
        if (event?.type !== 'assistant/message') continue
        if (event.data?.message?.id !== messageId) continue
        const content = event.data?.message?.content
        if (!Array.isArray(content)) return ''
        return content
          .filter((block) => block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
      }
      return ''
    }

    /**
     * Split one reply into cast segments: headings and `Name:` labels start a
     * new segment, and a reply with neither falls back to its paragraphs.
     * @param raw - markdown of the reply.
     * @returns Segments with the key that decides their voice.
     */
    function castSegments (raw) {
      const lines = String(raw).split(/\r?\n/)
      const segments = []
      let current = { key: null, lines: [] }
      const flush = () => {
        const body = current.lines.join('\n').trim()
        if (body !== '') segments.push({ key: current.key, text: body })
        current = { key: null, lines: [] }
      }
      for (const line of lines) {
        const heading = /^\s{0,3}#{1,6}\s+(.+)$/.exec(line)
        const speaker = /^\s{0,3}(?:\*\*|__)?([A-Z][\w .'-]{0,23})(?:\*\*|__)?\s*:\s+(.+)$/.exec(line)
        if (heading !== null) {
          flush()
          current = { key: heading[1].trim().slice(0, 40), lines: [heading[1]] }
          continue
        }
        if (speaker !== null) {
          flush()
          current = { key: speaker[1].trim(), lines: [speaker[2]] }
          continue
        }
        current.lines.push(line)
      }
      flush()
      return segments.filter((segment) => cleanForSpeech(segment.text) !== '')
    }

    /**
     * Turn a reply into a cast plan: one entry per sentence group, each naming the
     * voice that reads it. A speaker keeps its voice; speakers rotate the roster.
     * @param raw - markdown of the reply.
     * @param voices - voice roster of the selected model.
     * @returns Chunks with their voice, and the speaker → voice map.
     */
    function buildCast (raw, voices, preferredVoiceId = null) {
      const segments = castSegments(raw)
      if (segments.length < 2 || voices.length < 2) return { chunks: null, cast: [] }
      /* The narrator speaks first and keeps the voice from the settings. */
      const ordered = preferredVoiceId === null
        ? voices
        : [...voices.filter((voice) => voice.id === preferredVoiceId), ...voices.filter((voice) => voice.id !== preferredVoiceId)]
      const assigned = new Map()
      const cast = []
      const chunks = []
      for (let index = 0; index < segments.length; index++) {
        const segment = segments[index]
        const key = segment.key ?? `part ${index + 1}`
        let voice = assigned.get(key)
        if (voice === undefined) {
          voice = ordered[assigned.size % ordered.length]
          assigned.set(key, voice)
          cast.push({ key, voice: voice.id, label: voice.label ?? voice.id })
        }
        for (const text of splitChunks(cleanForSpeech(segment.text))) {
          chunks.push({ text, voice: voice.id, voiceLabel: voice.label ?? voice.id })
        }
      }
      return chunks.length > 0 ? { chunks, cast } : { chunks: null, cast: [] }
    }

    /**
     * The newest assistant message with visible text and its prose.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session to read.
     * @returns Message identity plus prose, or null.
     */
    function findLastAssistant (ctx, sessionId) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return null
      for (let index = window.entries.length - 1; index >= 0; index--) {
        const event = eventOf(window.entries[index])
        if (event?.type !== 'assistant/message') continue
        if (event.data?.interrupted === true) continue
        const text = messageProse(event)
        if (text === '') continue
        const id = event.data?.message?.id
        if (typeof id !== 'string') continue
        return { id, text }
      }
      return null
    }

    /**
     * The assistant message that closed one completed Turn.
     * @param ctx - client context carrying `sessions`.
     * @param sessionId - Session to read.
     * @param turn - turn number from the `turn/end` event.
     * @returns Message identity plus prose, or null when the turn said nothing.
     */
    function findTurnAnswer (ctx, sessionId, turn) {
      const window = windowOf(ctx, sessionId)
      if (window === null) return null
      for (let index = window.entries.length - 1; index >= 0; index--) {
        const event = eventOf(window.entries[index])
        if (event?.type === 'turn/start') {
          if (event.data?.turn === turn) break
          continue
        }
        if (event?.type !== 'assistant/message') continue
        if (event.data?.turn !== turn) continue
        if (event.data?.interrupted === true) continue
        const text = messageProse(event)
        if (text === '') continue
        const id = event.data?.message?.id
        if (typeof id !== 'string') continue
        return { id, text }
      }
      return null
    }

    /* -------------------------------------------------------------- highlight */

    /** Name of the CSS custom highlight painting the spoken sentence. */
    const HIGHLIGHT_NAME = 'dsh-tts-reading'

    /** Elements whose text must never be searched for spoken prose. */
    const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'INPUT', 'PRE'])

    /**
     * Collect the visible text of one or more subtrees as one whitespace-normalized
     * string, together with the node/offset each character came from.
     * @param roots - nodes to read, in reading order.
     * @returns Flattened text and its position map.
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
          if (parent.closest('.dsh-tts-panel') !== null) continue
          if (parent.closest('[data-dsh-tts-ignore]') !== null) continue
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
     * Collapse whitespace the way {@link flattenText} does.
     * @param value - raw prose.
     * @returns Single-spaced, trimmed text.
     */
    function normalizeForSearch (value) {
      return String(value).replace(/\s+/g, ' ').trim()
    }

    /**
     * Read a subtree as word tokens with their exact DOM positions.
     * @param roots - subtrees to read, in reading order.
     * @returns Tokens in reading order, each with its word and node span.
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
          if (parent.closest('.dsh-tts-panel') !== null) continue
          if (parent.closest('[data-dsh-tts-ignore]') !== null) continue
          const value = node.nodeValue ?? ''
          for (const match of value.matchAll(/[\p{L}\p{N}]+/gu)) {
            tokens.push({
              word: match[0].toLowerCase(),
              node,
              start: match.index,
              end: match.index + match[0].length,
            })
          }
        }
      }
      return tokens
    }

    /**
     * Find one sentence by its words, ignoring punctuation, markup and spacing.
     * The run is matched with a bounded gap: the transcript renders words the
     * engine never says (bare URLs, image alt text, a table's chrome), so a
     * contiguous subsequence would fail on exactly the sentences that contain
     * them.
     * @param roots - subtrees to search.
     * @param sentence - prose the engine is about to say.
     * @param preferLast - pick the newest match.
     * @returns A DOM range covering the words, or null.
     */
    function findWordRange (roots, sentence, preferLast) {
      const wanted = String(sentence).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      if (wanted.length === 0) return null
      const tokens = tokenize(roots)
      if (tokens.length < wanted.length) return null
      /* Walk every place the first word appears and match the rest with a bounded
         gap, then keep the tightest span: the closest transcription of the
         sentence is the one that covers the fewest words it does not share. */
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
        found.push({ first: start, last, span })
      }
      if (found.length === 0) return null
      const chosen = preferLast ? found[found.length - 1] : found[0]
      const first = tokens[chosen.first]
      const last = tokens[chosen.last]
      /* Keep the sentence's own punctuation inside the paint. */
      const tail = last.node.nodeValue ?? ''
      let end = last.end
      while (end < tail.length && /[.,;:!?…"'”’»)\]]/.test(tail[end])) end++
      const range = document.createRange()
      range.setStart(first.node, first.start)
      range.setEnd(last.node, end)
      return range
    }

    /**
     * Match by anchors: the first and last few words of the chunk, with anything
     * in between. Cleaning rewrites what the engine says (`12.5` becomes
     * `12 point 5`, `×` becomes `times`), so the middle of a sentence can diverge
     * from the DOM while its edges still line up.
     * @param roots - subtrees to search.
     * @param sentence - prose the engine is about to say.
     * @param preferLast - pick the newest match.
     * @returns A DOM range covering the anchors, or null.
     */
    function findAnchorRange (roots, sentence, preferLast) {
      const wanted = String(sentence).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      if (wanted.length < 6) return null
      const tokens = tokenize(roots)
      if (tokens.length < 6) return null
      const head = wanted.slice(0, 3)
      const tail = wanted.slice(-3)
      const sequences = (sequence) => {
        const found = []
        for (let index = 0; index + sequence.length <= tokens.length; index++) {
          let matched = 0
          while (matched < sequence.length && tokens[index + matched].word === sequence[matched]) matched++
          if (matched === sequence.length) found.push(index)
        }
        return found
      }
      const heads = sequences(head)
      const tails = sequences(tail)
      if (heads.length === 0 || tails.length === 0) return null
      const limit = wanted.length * 2 + 24
      let best = null
      for (const from of heads) {
        for (const to of tails) {
          if (to < from + head.length) continue
          const span = to + tail.length - from
          if (span > limit) continue
          if (best === null || span < best.span) best = { from, to, span }
        }
      }
      if (best === null) return null
      const first = tokens[best.from]
      const last = tokens[best.to + tail.length - 1]
      const text = last.node.nodeValue ?? ''
      let end = last.end
      while (end < text.length && /[.,;:!?…"'”’»)\]]/.test(text[end])) end++
      const range = document.createRange()
      range.setStart(first.node, first.start)
      range.setEnd(last.node, end)
      return preferLast ? range : range
    }

    /**
     * Locate one spoken sentence in the rendered transcript.
     * @param roots - subtrees to search, in reading order.
     * @param sentence - prose the engine is about to say.
     * @param preferLast - pick the newest match instead of the first.
     * @returns A DOM range covering the sentence, or null when it is not rendered.
     */
    function findTextRange (roots, sentence, preferLast = false) {
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
     * in the message that is actually being read.
     * @param element - clicked action element.
     * @returns The turn's rows in reading order, or null when the shape is unknown.
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
     * Describe why a chunk could not be placed: how big the search space was and
     * whether its first words appear there at all.
     * @param roots - subtrees that were searched.
     * @param sentence - the chunk that failed.
     * @returns Counts a reader can act on.
     */
    function diagnose (roots, sentence) {
      const tokens = tokenize(roots)
      const wanted = String(sentence).toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
      const head = wanted.slice(0, 3)
      const headFound = tokens.some((_, index) => head.every((word, offset) => tokens[index + offset]?.word === word))
      const tail = wanted.slice(-3)
      const tailFound = tokens.some((_, index) => tail.every((word, offset) => tokens[index + offset]?.word === word))
      return {
        domTokens: tokens.length,
        wantedTokens: wanted.length,
        headFound,
        tailFound,
        domStart: tokens.slice(0, 10).map((token) => token.word).join(' '),
      }
    }

    /**
     * Paint the sentence being read, and keep it in view.
     * Uses the CSS Custom Highlight API when the browser has it, so the
     * transcript's DOM is never mutated underneath React.
     * @returns Highlighter with `show`, `clear`, and `dispose`.
     */
    function createHighlighter (report) {
      let painted = null

      /** Remove whatever is painted. */
      function clear () {
        if (painted === null) return
        if (painted.kind === 'highlight') {
          window.CSS?.highlights?.delete(HIGHLIGHT_NAME)
        } else {
          painted.element.removeAttribute('data-dsh-tts-reading')
        }
        painted = null
      }

      /**
       * Bring the sentence into view when reading has scrolled it off screen.
       * @param range - painted range.
       */
      function keepVisible (range) {
        if (typeof range.getBoundingClientRect !== 'function') return
        const rect = range.getBoundingClientRect()
        if (rect.height === 0 && rect.width === 0) return
        if (rect.top >= 56 && rect.bottom <= window.innerHeight - 8) return
        const element = range.startContainer.parentElement
        if (element !== null) element.scrollIntoView({ block: 'center', behavior: 'smooth' })
      }

      /**
       * Highlight one sentence.
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
        let range = findTextRange(roots, sentence, known.length === 0)
        let reason = null
        if (range === null) {
          range = findAnchorRange(roots, sentence, known.length === 0)
          reason = range === null ? 'no-anchors' : null
        }
        if (range === null) {
          report?.({
            reason: reason ?? 'no-range',
            sentence,
            scopeRows: known.length,
            roots: known.length > 0 ? 'turn' : 'document',
            ...diagnose(roots, sentence),
          })
          /* The message is known but the sentence is not where we looked (an
             unmounted row, or a chunk the DOM splits oddly): mark the message
             itself so the reader still sees where the voice is. */
          const fallback = known.at(-1)
          if (fallback !== undefined && fallback !== null) {
            fallback.setAttribute('data-dsh-tts-reading', '')
            painted = { kind: 'attribute', element: fallback }
          }
          return
        }
        const registry = window.CSS?.highlights
        if (typeof window.Highlight === 'function' && registry !== undefined && registry !== null) {
          registry.set(HIGHLIGHT_NAME, new window.Highlight(range))
          painted = { kind: 'highlight' }
        } else {
          /* Fallback: mark the nearest block. React re-renders that element only
             when the message behind it changes. */
          const element = range.startContainer.parentElement
          if (element === null) return
          element.setAttribute('data-dsh-tts-reading', '')
          painted = { kind: 'attribute', element }
        }
        keepVisible(range)
      }

      return { show, clear, dispose: clear }
    }

    /**
     * Halve one chunk at a word boundary near its middle.
     * @param chunk - the chunk to split, with its voice.
     * @returns Two chunks, in reading order.
     */
    function splitChunk (chunk) {
      const text = chunk.text
      const middle = Math.floor(text.length / 2)
      let at = text.lastIndexOf(' ', middle)
      if (at < text.length * 0.25) at = text.indexOf(' ', middle)
      if (at <= 0 || at >= text.length - 1) at = middle
      return [
        { ...chunk, text: text.slice(0, at).trim() },
        { ...chunk, text: text.slice(at).trim() },
      ]
    }

    /* ------------------------------------------------------------------ engine */

    /**
     * One page-wide speech engine: it owns the audio element, the request
     * pipeline, and a timeline of the reply so playback can be scrubbed, skipped
     * chapter by chapter, and replayed from any sentence.
     * @param settings - preference store (voice, rate, highlight).
     * @param info - Host configuration store (defaults, servers).
     * @param highlighter - paints the sentence being spoken.
     * @returns Engine with `speak`, `pause`, `resume`, `seek`, `skip`, `replay`, `stop`, `fail`.
     */
    function createEngine (settings, info, highlighter, report) {
      const IDLE = { status: 'idle', messageId: null, chunk: 0, total: 0, sentence: null, voice: null, error: null, autoplay: false, position: 0, duration: 0 }
      const state = createStore({ ...IDLE })
      let generation = 0
      let audio = null
      let cancelPlay = null
      const controllers = new Set()
      const urls = new Set()
      /** Current reply: its chunks and the timing learned for each of them. */
      let run = null

      /** Seconds the engine is expected to take for one chunk before it is measured. */
      function estimate (text, speed) {
        return Math.max(0.6, text.length / (18 * speed))
      }

      /** Absolute start of every chunk, from the durations known so far. */
      function starts () {
        if (run === null) return []
        if (run.starts !== undefined) return run.starts
        const offsets = []
        let at = 0
        for (const seconds of run.durations) {
          offsets.push(at)
          at += seconds
        }
        run.starts = offsets
        return offsets
      }

      /** Total length of the reply in seconds. */
      function total () {
        return (run?.durations ?? []).reduce((sum, seconds) => sum + seconds, 0)
      }

      /** Republish the timeline after a chunk's real duration becomes known. */
      function publishDuration () {
        /* A measured duration invalidates the derived offsets. */
        if (run !== null) run.starts = undefined
        const snapshot = state.getSnapshot()
        state.set({ ...snapshot, duration: total() })
      }

      /** Absolute playhead in seconds. */
      function position () {
        const snapshot = state.getSnapshot()
        if (run === null) return 0
        if (audio !== null && Number.isFinite(audio.currentTime)) {
          return (starts()[snapshot.chunk] ?? 0) + audio.currentTime
        }
        return snapshot.position
      }

      /** Stop sound, requests and paint, keeping the loaded reply. */
      function stopPlayback () {
        generation += 1
        const element = audio
        const cancel = cancelPlay
        audio = null
        cancelPlay = null
        if (cancel !== null) cancel(STOP)
        if (element !== null) {
          element.onended = null
          element.onerror = null
          try { element.pause() } catch { /* detached element */ }
          try {
            element.removeAttribute('src')
            element.load()
          } catch { /* ignore */ }
        }
        for (const controller of controllers) {
          try { controller.abort() } catch { /* already settled */ }
        }
        controllers.clear()
        for (const url of urls) URL.revokeObjectURL(url)
        urls.clear()
        if (highlighter !== undefined && highlighter !== null) highlighter.clear()
      }

      /** Stop everything and forget the reply. */
      function stop () {
        stopPlayback()
        run = null
        state.set({ ...IDLE })
      }

      /**
       * A model that can actually speak on the selected server, when the chosen
       * one cannot: a provider that lists voices names its speech models, and
       * otherwise the model id has to look like one.
       * @returns The alternative model, or null when the selection already speaks.
       */
      function fallbackModel () {
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        if (selection.server === null || selection.model === null) return null
        if ((selection.model.voices?.length ?? 0) > 0) return null
        const voiceful = selection.server.models.find((row) => (row.voices?.length ?? 0) > 0)
        if (voiceful !== undefined) return voiceful
        return selection.server.models.find((row) => /(audio|omni|tts|speech|kokoro|whisper)/i.test(row.id)) ?? null
      }

      /** Publish one failure without pretending audio is still playing. */
      function fail (code, message = null) {
        stop()
        if (code !== 'empty') {
          const detail = { code, message: message === null ? null : String(message).slice(0, 240) }
          if (code === 'blocked') report?.('warn', 'autoplay-blocked', detail)
          else if (code === 'server') report?.('error', 'speech-server-error', detail)
          else if (code === 'network') report?.('error', 'speak-network-error', { ...detail, online: navigator.onLine })
          else report?.('error', 'playback-failed', detail)
        }
        /* Keep the error on screen: the player renders it instead of vanishing. */
        state.set({ ...IDLE, status: 'failed', error: { code, message } })
      }

      /** Clear a reported failure. */
      function dismiss () {
        state.set({ ...IDLE })
      }

      /**
       * Apply a speaking rate to whatever is playing right now.
       * @param rate - playback rate, 1 = the engine's own speed.
       */
      function setRate (rate) {
        if (audio === null) return
        try {
          audio.playbackRate = Math.min(4, Math.max(0.25, Number(rate) || 1))
        } catch { /* element already released */ }
      }

      /** POST one chunk and return an object URL for its audio. */
      function requestChunk (chunk) {
        const controller = new AbortController()
        controllers.add(controller)
        const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
        const body = { text: chunk.text }
        if (selection.server !== null) body.server = selection.server.id
        if (selection.model !== null) body.model = selection.model.id
        /* A cast chunk names its own voice; otherwise the selected voice speaks. */
        const voice = chunk.voice ?? selection.voice?.id ?? null
        if (voice !== null) body.voice = voice
        return fetch(TTS_ROUTES.speak, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        }).catch((error) => {
          /* A stopped run aborts its own requests; anything else never reached
             the Host, which is a different failure from the engine refusing. */
          if (controller.signal.aborted) throw STOP
          const wrapped = new Error(String(error?.message ?? error))
          wrapped.code = 'network'
          throw wrapped
        }).then(async (response) => {
          if (!response.ok) {
            let message = `speech request failed (${response.status})`
            try {
              const payload = await response.json()
              if (typeof payload?.error?.message === 'string') message = payload.error.message
            } catch { /* non-JSON failure body */ }
            const error = new Error(message)
            /* Kokoro refuses phoneme strings over 510 symbols: the chunk is too
               dense, not too long, so splitting it is the answer. */
            error.code = /exceeds \d+ symbols|phoneme string/i.test(message) ? 'too-long' : 'server'
            throw error
          }
          const blob = await response.blob()
          if (blob.size === 0) {
            const error = new Error('the speech server returned no audio')
            error.code = 'server'
            throw error
          }
          const url = URL.createObjectURL(blob)
          urls.add(url)
          return url
        }).finally(() => { controllers.delete(controller) })
      }

      /**
       * Play one object URL, optionally from an offset inside it.
       * @param url - object URL of the chunk's audio.
       * @param offset - seconds to skip into the chunk.
       * @param index - chunk index, used for duration learning and the playhead.
       * @returns Resolves at the end of the chunk; rejects on error or stop.
       */
      function play (url, offset, index) {
        return new Promise((resolve, reject) => {
          const element = new Audio(url)
          /* Rate is a playback property: changing it never re-synthesizes and
             never restarts the sentence. */
          const rate = selectionOf(settings.getSnapshot(), info.getSnapshot().value).speed
          try {
            element.preservesPitch = true
            element.playbackRate = rate
          } catch { /* older element */ }
          audio = element
          let settled = false
          const finish = (settle, value) => {
            if (settled) return
            settled = true
            cancelPlay = null
            element.onended = null
            element.onerror = null
            if (audio === element) audio = null
                settle(value)
          }
          element.onloadedmetadata = () => {
            if (run !== null && index < run.durations.length && Number.isFinite(element.duration) && element.duration > 0) {
              run.durations[index] = element.duration
              publishDuration()
            }
            if (offset > 0) {
              try { element.currentTime = Math.min(offset, Math.max(0, (element.duration || offset) - 0.05)) } catch { /* ignore */ }
            }
          }
          element.ontimeupdate = () => {
            if (run === null || audio !== element) return
            const snapshot = state.getSnapshot()
            const at = (starts()[index] ?? 0) + element.currentTime
            if (Math.abs(at - snapshot.position) < 0.15) return
            state.set({ ...snapshot, position: at })
          }
          element.onended = () => finish(resolve)
          element.onerror = () => {
            const error = new Error('audio playback failed')
            error.code = 'playback'
            finish(reject, error)
          }
          cancelPlay = () => finish(reject, STOP)
          element.play().then(() => {}, (error) => finish(reject, error))
        })
      }

      /**
       * Read the reply from one chunk onward.
       * @param startIndex - first chunk to speak.
       * @param startOffset - seconds to skip into that chunk.
       * @returns Completion once the reply is read through or abandoned.
       */
      async function loop (startIndex, startOffset) {
        if (run === null) return
        const current = generation
        const reply = run
        state.set({ ...state.getSnapshot(), status: 'loading', chunk: startIndex, sentence: reply.chunks[startIndex]?.text ?? null, voice: reply.chunks[startIndex]?.voiceLabel ?? null, duration: total() })
        let ahead = null
        const retried = new Set()
        try {
          let index = startIndex
          while (index < reply.chunks.length) {
            const pending = ahead === null ? requestChunk(reply.chunks[index]) : ahead
            ahead = index + 1 < reply.chunks.length ? requestChunk(reply.chunks[index + 1]) : null
            if (ahead !== null) ahead.catch(() => {})
            let url
            try {
              url = await pending
            } catch (error) {
              /* Too dense for the engine: split in place and retry the same spot,
                 so the rest of the reply keeps its timing and its place. */
              const chunk = reply.chunks[index]
              if (error?.code === 'network' && !retried.has(index)) {
                /* The connection dropped before the Host answered: ask again. */
                retried.add(index)
                ahead = null
                report?.('warn', 'chunk-retry', { code: error.code, chars: chunk?.text.length ?? 0, online: navigator.onLine })
                continue
              }
              if (error?.code === 'too-long' && chunk !== undefined && chunk.text.length > 24) {
                const halves = splitChunk(chunk)
                reply.chunks.splice(index, 1, ...halves)
                reply.durations.splice(index, 1, ...halves.map((half) => estimate(half.text, reply.rate)))
                reply.starts = undefined
                ahead = null
                report?.('warn', 'chunk-split', { chars: chunk.text.length, into: halves.map((half) => half.text.length) })
                state.set({ ...state.getSnapshot(), total: reply.chunks.length, duration: total() })
                continue
              }
              throw error
            }
            if (current !== generation) return
            const offset = index === startIndex ? startOffset : 0
            const chunk = reply.chunks[index]
            state.set({ ...state.getSnapshot(), status: 'playing', chunk: index, sentence: chunk.text, voice: chunk.voiceLabel ?? null })
            if (settings.getSnapshot().highlight !== false && highlighter !== undefined && highlighter !== null) {
              highlighter.show(chunk.text, reply.scope)
            }
            await play(url, offset, index)
            if (current !== generation) return
            index += 1
          }
          if (current !== generation) return
          if (highlighter !== undefined && highlighter !== null) highlighter.clear()
          run = null
          state.set({ ...IDLE })
        } catch (error) {
          if (current !== generation || error === STOP) return
          if (error?.name === 'NotAllowedError') {
            fail('blocked')
          } else if (error?.code === 'server' && reply.allowFallback) {
            /* The chosen model refused: try one that can speak, once, then keep
               that choice so the next Listen does not pay for the failure. */
            const alternative = fallbackModel()
            if (alternative === null) {
              fail('server', String(error.message))
              return
            }
            report?.('warn', 'selection-fallback', { from: run?.model ?? null, to: alternative.id })
            settings.save({ model: alternative.id, voice: null })
            await speak(reply.messageId, reply.input, {
              scope: reply.scope,
              autoplay: reply.autoplay,
              allowFallback: false,
            })
          } else if (error?.code === 'server') {
            fail('server', String(error.message))
          } else if (error?.code === 'network') {
            fail('network', String(error.message))
          } else {
            fail('playback', String(error?.message ?? error))
          }
        } finally {
          /* Only this run's own URLs: a newer run (or stop) owns the set after a generation change. */
          if (current === generation) {
            for (const url of urls) URL.revokeObjectURL(url)
            urls.clear()
          }
        }
      }

      /**
       * Restart playback at one chunk and offset.
       * @param index - chunk to start at.
       * @param offset - seconds into that chunk.
       */
      function seekTo (index, offset) {
        if (run === null) return
        const bounded = Math.min(Math.max(0, index), run.chunks.length - 1)
        stopPlayback()
        state.set({ ...state.getSnapshot(), position: (starts()[bounded] ?? 0) + Math.max(0, offset) })
        void loop(bounded, Math.max(0, offset))
      }

      /**
       * Say one reply from the beginning, replacing whatever was playing.
       * @param messageId - durable message identity the controls key off.
       * @param text - prose to read.
       * @param options - `autoplay` marks unsolicited speech; `scope` bounds the highlight.
       * @returns Completion once the reply is read through or abandoned.
       */
      async function speak (messageId, input, options) {
        stop()
        const plan = typeof input === 'string'
          ? splitChunks(input).map((text) => ({ text, voice: null, voiceLabel: null }))
          : input.map((chunk) => ({ text: chunk.text, voice: chunk.voice ?? null, voiceLabel: chunk.voiceLabel ?? null }))
        if (plan.length === 0) {
          fail('empty')
          return
        }
        const rate = (() => {
          const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
          return selection.speed || 1
        })()
        run = {
          messageId,
          input,
          chunks: plan,
          rate,
          scope: options?.scope ?? null,
          allowFallback: options?.allowFallback !== false,
          autoplay: options?.autoplay === true,
          starts: undefined,
          durations: plan.map((chunk) => estimate(chunk.text, rate)),
        }
        state.set({
          ...IDLE,
          status: 'loading',
          messageId,
          chunk: 0,
          total: plan.length,
          sentence: plan[0].text,
          voice: plan[0].voiceLabel ?? null,
          autoplay: options?.autoplay === true,
          duration: total(),
        })
        await loop(0, 0)
      }

      /** Pause at the playhead, keeping the reply loaded. */
      function pause () {
        const snapshot = state.getSnapshot()
        if (run === null || (snapshot.status !== 'playing' && snapshot.status !== 'loading')) return
        const at = position()
        stopPlayback()
        state.set({ ...state.getSnapshot(), status: 'paused', position: at })
      }

      /** Resume from the paused playhead. */
      function resume () {
        const snapshot = state.getSnapshot()
        if (run === null || snapshot.status !== 'paused') return
        const offsets = starts()
        const index = Math.min(snapshot.chunk, run.chunks.length - 1)
        seekTo(index, Math.max(0, snapshot.position - (offsets[index] ?? 0)))
      }

      /**
       * Jump to an absolute position in the reply.
       * @param seconds - target playhead.
       */
      function seek (seconds) {
        if (run === null) return
        const target = Math.min(Math.max(0, Number(seconds) || 0), Math.max(0, total() - 0.05))
        const offsets = starts()
        let index = 0
        for (let at = 0; at < offsets.length; at++) if (offsets[at] <= target) index = at
        seekTo(index, target - (offsets[index] ?? 0))
      }

      /**
       * Move by whole chapters.
       * @param delta - chapters to move; negative goes back.
       */
      function skip (delta) {
        if (run === null) return
        const snapshot = state.getSnapshot()
        seekTo(snapshot.chunk + delta, 0)
      }

      /** Replay the chapter being read, from its start. */
      function replay () {
        if (run === null) return
        seekTo(state.getSnapshot().chunk, 0)
      }

      return { state, speak, pause, resume, seek, skip, replay, stop, fail, dismiss, setRate, dispose: stop }
    }

    /* ----------------------------------------------------------------- watcher */

    /**
     * Follow each open Session's event window and read newly completed turns.
     * @param ctx - client context carrying `sessions`.
     * @param engine - speech engine.
     * @param settings - preference store read at every turn end.
     * @returns Watcher with `bind(sessionId)` and `dispose()`.
     */
    function createWatcher (ctx, engine, settings, planFor) {
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

      /**
       * Start watching one Session once, waiting briefly for its binding.
       * @param sessionId - Session to read aloud.
       */
      function bind (sessionId) {
        if (typeof sessionId !== 'string' || bound.has(sessionId)) return
        const slot = { cancelled: false, unsubscribe: null }
        bound.set(sessionId, slot)
        let attempts = 0
        const attach = () => {
          if (slot.cancelled) return
          let binding
          try {
            binding = ctx.sessions.binding(sessionId)
          } catch {
            binding = undefined
          }
          if (binding === undefined || binding === null) {
            if (attempts++ < 40) window.setTimeout(attach, 250)
            return
          }
          let highest = highestSeq(binding)
          slot.unsubscribe = binding.eventSource.subscribe(() => {
            const snapshot = binding.eventSource.getSnapshot()
            if (snapshot.change !== null && snapshot.change !== undefined && snapshot.change.kind === 'replace') {
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
            if (!settings.getSnapshot().autoplay) return
            for (const event of fresh) {
              if (event.type !== 'turn/end') continue
              if (event.data?.reason?.kind !== 'completed') continue
              const found = findTurnAnswer(ctx, sessionId, event.data.turn)
              if (found === null) continue
              const plan = planFor(sessionId, found.id)
              if (plan === null) continue
              engine.speak(found.id, plan, { autoplay: true })
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

    /* -------------------------------------------------------------- components */

    /**
     * Per-message Listen control in the finalized assistant action row.
     * @param props - composed slot props.
     * @returns The play/stop button.
     */
    function ListenAction ({ messageId, sessionId, read, stop, useTtsState, t }) {
      /* Two scalars, not the whole engine state: a message button must not
         re-render on every playhead tick of an unrelated reply. */
      const status = useTtsState((value) => value.status)
      const playingId = useTtsState((value) => value.messageId)
      const active = playingId === messageId && (status === 'playing' || status === 'loading' || status === 'paused')
      const label = active ? t('action.stop') : t('action.listen')
      const Icon = active ? primitives.IconStopFillRegular : primitives.IconPlayOutlineRegular
      return h('button', {
        type: 'button',
        className: 'dsh-tts-action',
        'aria-label': label,
        title: label,
        'data-active': active ? '' : undefined,
        onClick: (event) => {
          if (active) stop()
          else read(sessionId, messageId, event.currentTarget)
        },
      }, h(Icon, {}))
    }

    /**
     * A voice's tags as one line, for a tooltip.
     * @param voice - tagged voice row.
     * @returns Text such as `female · en-us`, or null.
     */
    function voiceTags (voice) {
      const parts = [voice?.gender, voice?.language, voice?.category].filter((part) => typeof part === 'string' && part !== '')
      return parts.length > 0 ? parts.join(' · ') : null
    }

    /**
     * The player under the composer: chapter stepping, play/pause, a seek bar over
     * the whole reply, and the sentence now being read.
     * @param props - composed slot props.
     * @returns The player, or null when nothing is loaded.
     */
    function ReadingCaption ({ useTtsState, useTtsSettings, useTtsInfo, t, pause, resume, seek, skip, replay, dismiss, stop, changeRate }) {
      const state = useValue(useTtsState)
      const settings = useValue(useTtsSettings)
      const info = useValue(useTtsInfo)
      const [drag, setDrag] = React.useState(null)
      const active = state.status === 'playing' || state.status === 'loading' || state.status === 'paused'
      const failed = state.status === 'failed' && state.error !== null
      React.useEffect(() => { setDrag(null) }, [state.status])

      /* A failure clears itself after a while, so it cannot sit there forever. */
      React.useEffect(() => {
        if (!failed) return undefined
        const timer = window.setTimeout(() => dismiss(), 12000)
        return () => window.clearTimeout(timer)
      }, [failed, state.error?.message, dismiss])

      if (failed) {
        return h('div', {
          className: 'dsh-tts-player dsh-tts-failed',
          'data-dsh-tts-ignore': '',
          role: 'status',
          'aria-live': 'polite',
        }, [
          h('span', { key: 'label', className: 'dsh-tts-failed-label' }, t('status.failed')),
          h('span', { key: 'text', className: 'dsh-tts-failed-text', title: state.error.message ?? '' },
            state.error.message === null || state.error.message === undefined
              ? t(`status.hint.${state.error.code ?? 'default'}`)
              : String(state.error.message)),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-tts-close',
            'aria-label': t('player.dismiss'),
            title: t('player.dismiss'),
            onClick: () => dismiss(),
          }, h(primitives.IconCloseOutlineRegular, {})),
        ])
      }
      if (!active) return null

      const playing = state.status === 'playing' || state.status === 'loading'
      const duration = Math.max(0.1, state.duration)
      const value = drag ?? Math.min(state.position, duration)
      const button = (key, Icon, label, onClick) => h('button', {
        key,
        type: 'button',
        className: 'dsh-tts-pbtn',
        'aria-label': label,
        title: label,
        onClick,
      }, h(Icon, {}))
      const commit = () => {
        if (drag === null) return
        const target = drag
        setDrag(null)
        seek(target)
      }

      const selection = selectionOf(settings, info.value)
      const rates = selection.speeds
      const rate = selection.speed

      return h('div', {
        className: 'dsh-tts-player',
        'data-dsh-tts-ignore': '',
        title: state.sentence ?? t('caption.loading'),
      }, [
        h('div', { key: 'row', className: 'dsh-tts-player-row' }, [
          button('prev', primitives.IconChevronLeftOutlineRegular, t('player.prev'), () => skip(-1)),
          button('toggle', playing ? primitives.IconPauseOutlineRegular : primitives.IconPlayOutlineRegular,
            playing ? t('player.pause') : t('player.resume'), () => { if (playing) pause(); else resume() }),
          button('next', primitives.IconChevronRightOutlineRegular, t('player.next'), () => skip(1)),
          h('input', {
            key: 'seek',
            className: 'dsh-tts-seek',
            type: 'range',
            min: 0,
            max: duration,
            step: 0.1,
            value,
            'aria-label': t('player.seek'),
            onInput: (event) => setDrag(Number(event.target.value)),
            onPointerUp: commit,
            onKeyUp: commit,
            onBlur: commit,
          }),
          state.voice !== null && state.voice !== undefined
            ? h('span', { key: 'voice', className: 'dsh-tts-voice', title: t('castVoice') }, state.voice)
            : null,
          h('select', {
            key: 'rate',
            className: 'dsh-tts-rate',
            title: t('player.speed'),
            'aria-label': t('player.speed'),
            value: String(rate),
            onChange: (event) => changeRate(Number(event.target.value)),
          }, rates.map((value) => h('option', { key: value, value: String(value) }, `${value}×`))),
          h('button', {
            key: 'time',
            type: 'button',
            className: 'dsh-tts-time',
            title: t('player.replay'),
            onClick: () => replay(),
          }, `${clockOf(value)} / ${clockOf(state.duration)}`),
          h('button', {
            key: 'close',
            type: 'button',
            className: 'dsh-tts-close',
            'aria-label': t('player.close'),
            title: t('player.close'),
            onClick: () => stop(),
          }, h(primitives.IconCloseOutlineRegular, {})),
        ]),
      ])
    }

    /**
     * Composer control: the Listen trigger and its settings panel.
     * @param props - composed slot props.
     * @returns The trigger plus, while open, the portalled panel.
     */
    /* ------------------------------------------------------------------ panels */

    /** Panel width per control, so the anchor maths lives in one place. */
    const PANEL_WIDTH = { tts: 304, stt: 352 }

    /**
     * Open/close chrome shared by both composer controls: place the panel above
     * its trigger, keep it placed while the page resizes or scrolls, and dismiss
     * it on an outside pointer or Escape.
     * @param open - whether the panel is open.
     * @param setOpen - the control's open-state setter.
     * @param width - panel width, used to keep the panel inside the viewport.
     * @returns The trigger and panel refs, the computed position, and the dialog id.
     */
    function usePanel (open, setOpen, width) {
      const [position, setPosition] = React.useState(null)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const panelId = React.useId()

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
        return () => {
          window.removeEventListener('resize', place)
          window.removeEventListener('scroll', place, true)
        }
      }, [open, width])

      React.useEffect(() => {
        if (!open) return undefined
        const onPointerDown = (event) => {
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return
          if (triggerRef.current !== null && triggerRef.current.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open, setOpen])

      return { position, triggerRef, panelRef, panelId }
    }

    /**
     * The dialog both controls mount above the composer.
     * @param props - panel ref, dialog id, class, accessible label, position, children.
     * @returns The portal.
     */
    function Panel ({ panelRef, panelId, className, label, style, children }) {
      return createPortal(h('div', {
        ref: panelRef,
        id: panelId,
        className,
        style,
        role: 'dialog',
        'aria-label': label,
      }, children), document.body)
    }

    /**
     * One labelled field of a panel.
     * @param props - class prefix, label, optional tooltip and extra class, children.
     * @returns The field element.
     */
    function Field ({ prefix, label, title, className, children }) {
      return h('div', { className: className === undefined ? `${prefix}-field` : `${prefix}-field ${className}` }, [
        h('span', {
          key: 'label',
          className: `${prefix}-label`,
          ...(title === undefined ? {} : { title }),
        }, label),
        children,
      ])
    }

    /**
     * A single-choice chip row: the panel's server, model, voice and language pickers.
     * @param props - class prefix, items, label and active accessors, optional tooltip, picker.
     * @returns The chip row.
     */
    function Chips ({ prefix, items, labelOf, titleOf, activeOf, onPick }) {
      return h('div', { className: `${prefix}-chips` }, items.map((item) => {
        const id = typeof item === 'string' ? item : item.id
        const label = labelOf(item)
        return h('button', {
          key: id,
          type: 'button',
          className: `${prefix}-chip`,
          title: titleOf === undefined ? label : titleOf(item),
          'aria-pressed': id === activeOf(),
          'data-active': id === activeOf() ? '' : undefined,
          onClick: () => onPick(id),
        }, label)
      }))
    }

    /**
     * One switch row of a panel.
     * @param props - class prefix, label, optional tooltip, checked state, change handler.
     * @returns The row element.
     */
    function SwitchRow ({ prefix, label, title, checked, onChange }) {
      return h('div', { className: `${prefix}-row` }, [
        h('span', {
          key: 'label',
          className: `${prefix}-label`,
          ...(title === undefined ? {} : { title }),
        }, label),
        h(primitives.Switch, { key: 'switch', checked, label, onChange }),
      ])
    }

    function ReadControl (props) {
      const { t, readLast, watch, updateSettings, refresh, roundTrip, useTtsState, useTtsSettings, useTtsInfo, useAudioStatus } = props
      const sessionId = props.sessionId
      const state = useValue(useTtsState)
      const settings = useValue(useTtsSettings)
      const info = useValue(useTtsInfo)
      const audio = useValue(useAudioStatus)
      const [open, setOpen] = React.useState(false)
      const [trial, setTrial] = React.useState(null)
      const { position, triggerRef, panelRef, panelId } = usePanel(open, setOpen, PANEL_WIDTH.tts)

      /* Injected callbacks are recreated per composition; effects must not depend on their identity. */
      const watchRef = React.useRef(watch)
      const refreshRef = React.useRef(refresh)
      watchRef.current = watch
      refreshRef.current = refresh

      React.useEffect(() => {
        if (typeof sessionId === 'string') watchRef.current(sessionId)
      }, [sessionId])

      /* Opening the panel re-probes the engines: the list is what it is for. */
      React.useEffect(() => {
        if (!open) return undefined
        refreshRef.current()
        return undefined
      }, [open])

      const selection = selectionOf(settings, info.value)
      const { servers, models, voices } = selection

      const status = (() => {
        if (state.error !== null) {
          if (state.error.code === 'blocked') return { tone: 'warn', text: t('status.blocked') }
          if (state.error.code === 'empty') return { tone: 'warn', text: t('status.empty') }
          if (state.error.code === 'server') return { tone: 'warn', text: state.error.message }
          return { tone: 'warn', text: t('status.empty') }
        }
        if (state.status === 'playing' || state.status === 'loading') {
          return { tone: null, text: t('status.playing', { index: Math.max(1, state.chunk + 1), total: state.total }) }
        }
        if (info.status === 'loading') return { tone: null, text: t('status.loading') }
        if (info.status === 'error') return { tone: 'warn', text: t('status.offline') }
        if (servers.length === 0) return { tone: 'warn', text: t('status.none') }
        return { tone: null, text: t('status.ready') }
      })()

      const panel = open && position !== null
        ? h(Panel, { key: 'panel', panelRef, panelId, className: 'dsh-tts-panel', label: t('panel.aria'), style: position }, [
          h('div', { key: 'title', className: 'dsh-tts-title' }, t('panel.title')),
          h(SwitchRow, {
            key: 'autoplay',
            prefix: 'dsh-tts',
            label: t('autoplay'),
            checked: settings.autoplay,
            onChange: (value) => updateSettings({ autoplay: value }),
          }),
          h(SwitchRow, {
            key: 'cast',
            prefix: 'dsh-tts',
            label: t('cast'),
            title: t('castHint'),
            checked: settings.cast === true,
            onChange: (value) => updateSettings({ cast: value }),
          }),
          h(Field, { key: 'demo', prefix: 'dsh-tts', label: t('demo.title'), className: 'dsh-tts-demo' }, [
            audio.value === null
              ? h('span', { key: 'unavailable', className: 'dsh-tts-status' }, t('demo.unavailable'))
              : h('div', { key: 'list', className: 'dsh-tts-components' },
                (Array.isArray(audio.value.components) ? audio.value.components : []).map((component, index) =>
                  h('div', {
                    key: typeof component?.id === 'string' ? component.id : `component-${index}`,
                    className: 'dsh-tts-component',
                  }, [
                    h('span', { key: 'dot', className: 'dsh-tts-dot', 'data-state': 'on', 'aria-hidden': true }),
                    h('span', { key: 'name', className: 'dsh-tts-component-name' }, String(component?.title ?? component?.id ?? '')),
                  ]))),
            h('button', {
              key: 'echo',
              type: 'button',
              className: 'dsh-tts-read',
              disabled: trial?.running === true,
              onClick: () => {
                setTrial({ running: true })
                void roundTrip().then((result) => setTrial(result))
              },
            }, trial?.running === true ? t('demo.running') : t('demo.roundtrip')),
            trial === null || trial.running === true
              ? null
              : h('div', { key: 'result', className: 'dsh-tts-status', 'data-tone': trial.ok === true ? undefined : 'warn' },
                trial.ok === true
                  ? [
                      h('span', { key: 'heard', className: 'dsh-tts-demo-transcript' }, `${t('demo.transcript')}: ${trial.transcript}`),
                      h('span', { key: 'timing', className: 'dsh-tts-demo-timing' }, ` ${t('demo.timings', { speak: trial.speakMs ?? 0, transcribe: trial.transcribeMs ?? 0 })}`),
                    ]
                  : String(trial.error ?? '')),
          ]),
          h(SwitchRow, {
            key: 'highlight',
            prefix: 'dsh-tts',
            label: t('highlight'),
            checked: settings.highlight !== false,
            onChange: (value) => updateSettings({ highlight: value }),
          }),
          servers.length > 1
            ? h(Field, { key: 'servers', prefix: 'dsh-tts', label: t('server') },
              h(Chips, {
                prefix: 'dsh-tts',
                items: servers,
                labelOf: (server) => server.name ?? server.id,
                activeOf: () => selection.server?.id,
                onPick: (id) => updateSettings({ server: id, model: null, voice: null }),
              }))
            : null,
          models.length > 1
            ? h(Field, { key: 'models', prefix: 'dsh-tts', label: t('model') },
              h(Chips, {
                prefix: 'dsh-tts',
                items: models,
                labelOf: (model) => model.label ?? model.id,
                activeOf: () => selection.model?.id,
                onPick: (id) => updateSettings({ model: id, voice: null }),
              }))
            : null,
          voices.length > 0
            ? h(Field, { key: 'voices', prefix: 'dsh-tts', label: t('voice') },
              h(Chips, {
                prefix: 'dsh-tts',
                items: voices,
                labelOf: (voice) => voice.label ?? voice.id,
                titleOf: voiceTags,
                activeOf: () => selection.voice?.id,
                onPick: (id) => updateSettings({ voice: id }),
              }))
            : null,
          h('button', {
            key: 'read',
            type: 'button',
            className: 'dsh-tts-read',
            onClick: () => readLast(sessionId),
          }, t('readLast')),
          h('div', { key: 'footer', className: 'dsh-tts-footer' }, [
            h('span', { key: 'status', className: 'dsh-tts-status', 'data-tone': status.tone ?? undefined }, status.text),
          ]),
          h('div', { key: 'hint', className: 'dsh-tts-status' }, t('hint')),
        ])
        : null

      return h(React.Fragment, null, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-tts-trigger',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? panelId : undefined,
          'data-on': settings.autoplay ? '' : undefined,
          title: t('trigger'),
          onClick: () => setOpen(!open),
        }, [
          h(primitives.IconPlayOutlineRegular, { key: 'icon' }),
          h('span', { key: 'label', className: 'dsh-tts-trigger-label' }, t('trigger')),
          h(primitives.IconChevronDownOutlineRegular, { key: 'chevron' }),
        ]),
        panel,
      ])
    }

    /* ------------------------------------------------------------------- audio */



    /**
     * Resample mono samples in the page, so the provider receives exactly 16 kHz.
     * @param samples - source samples.
     * @param from - source rate.
     * @param to - target rate.
     * @returns Resampled samples.
     */
    async function resample (samples, from, to) {
      if (from === to) return samples
      const length = Math.max(1, Math.round(samples.length * to / from))
      const offline = new OfflineAudioContext(1, length, to)
      const buffer = offline.createBuffer(1, samples.length, from)
      buffer.copyToChannel(samples, 0)
      const source = offline.createBufferSource()
      source.buffer = buffer
      source.connect(offline.destination)
      source.start()
      const rendered = await offline.startRendering()
      return rendered.getChannelData(0)
    }

    /**
     * Wrap mono samples as a 16-bit PCM WAV blob.
     * @param samples - mono samples in [-1, 1].
     * @param rate - sample rate.
     * @returns WAV blob.
     */
    function wavBlob (samples, rate) {
      const bytes = new ArrayBuffer(44 + samples.length * 2)
      const view = new DataView(bytes)
      const write = (offset, text) => {
        for (let index = 0; index < text.length; index++) view.setUint8(offset + index, text.charCodeAt(index))
      }
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
      for (let index = 0; index < samples.length; index++, offset += 2) {
        const sample = Math.max(-1, Math.min(1, samples[index]))
        view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true)
      }
      return new Blob([bytes], { type: 'audio/wav' })
    }

    /**
     * Decode one recorded clip into 16 kHz mono WAV.
     * @param blob - whatever MediaRecorder produced.
     * @returns WAV blob ready for the Host.
     */
    async function toWav (blob) {
      const context = new AudioContext()
      let decoded
      try {
        decoded = await context.decodeAudioData(await blob.arrayBuffer())
      } finally {
        void context.close().catch(() => {})
      }
      const mono = new Float32Array(decoded.length)
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const data = decoded.getChannelData(channel)
        for (let index = 0; index < data.length; index++) mono[index] += data[index] / decoded.numberOfChannels
      }
      const resampled = await resample(mono, decoded.sampleRate, SAMPLE_RATE)
      return wavBlob(resampled, SAMPLE_RATE)
    }

    /* ----------------------------------------------------------------- recorder */

    /* --------------------------------------------------------------- waveform */

    /**
     * Level history shared with the wave without going through React: a fixed
     * ring buffer, written by the microphone loop and read by the paint loop.
     * @param size - capacity in samples.
     * @returns Ring with `push`, `at`, and `reset`.
     */
    function createWave (size) {
      const values = new Float32Array(size)
      let written = 0
      return {
        size,
        /** Append one smoothed level, overwriting the oldest. */
        push (value) {
          values[written % size] = value
          written += 1
        },
        /**
         * Read one column, oldest first.
         * @param index - column position, 0 = oldest visible.
         * @param columns - columns currently drawn.
         * @returns Level in [0, 1]; 0 before enough samples exist.
         */
        at (index, columns) {
          const position = written - columns + index
          if (position < 0) return 0
          return values[position % size]
        },
        /** Forget the history. */
        reset () {
          values.fill(0)
          written = 0
        },
      }
    }

    /* ----------------------------------------------------------------- recorder */

    /**
     * One page-wide microphone: it owns the stream, the recorder, the level
     * history, and the request pipeline, so the composer control and the bar
     * share a single source of truth. Only coarse state (phase, elapsed, error)
     * rides the React store; levels go through {@link createWave} so a recording
     * never re-renders the transcript UI.
     * @param settings - preference store (language).
     * @param info - provider state.
     * @returns Recorder with `start`, `stop`, `cancel`, `state`, `wave`, and `dispose`.
     */
    function createRecorder (settings, info, report) {
      const state = createStore({ phase: 'idle', elapsed: 0, error: null })
      const wave = createWave(WAVE_BARS)
      let stream = null
      let recorder = null
      let chunks = []
      let actions = null
      let span = null
      let draft = ''
      let target = null
      let commit = true
      let startedAt = 0
      let elapsedTimer = null
      let levelTimer = null
      let audioContext = null
      let analyser = null
      let buffer = null
      let smoothed = 0

      /** Publish a patch onto the current state. */
      function publish (patch) {
        const current = state.getSnapshot()
        let changed = false
        for (const [key, value] of Object.entries(patch)) {
          if (current[key] !== value) {
            changed = true
            break
          }
        }
        if (!changed) return
        state.set({ ...current, ...patch })
      }

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
        if (actions === null) return
        const payload = (draft ?? '').trim() === '' || (draft ?? '').endsWith(' ') ? text : ` ${text}`
        if (actions.insertText(payload, span) === false) {
          actions.insertText(payload, actions.captureInsertion())
        }
      }

      /** Transcribe the finished clip and insert its text. */
      async function finish (mime) {
        const blob = new Blob(chunks, { type: mime === '' ? 'audio/webm' : mime })
        const captured = { actions, span, draft, target, commit }
        chunks = []
        teardown()
        wave.reset()
        if (!captured.commit) {
          publish({ phase: 'idle', elapsed: 0 })
          return
        }
        if (blob.size === 0) {
          publish({ phase: 'idle', elapsed: 0, error: 'empty' })
          return
        }
        publish({ phase: 'working' })
        const startedAt = Date.now()
        try {
          const wav = await toWav(blob)
          const ms = Date.now() - startedAt
          const target = captured.target
          const model = target?.model
          const query = new URLSearchParams({ language: target?.language ?? 'auto' })
          if (target?.server) query.set('server', target.server.id)
          if (model) query.set('model', typeof model === 'string' ? model : model.id)
          const response = await fetch(`${STT_ROUTES.transcribe}?${query.toString()}`, {
            method: 'POST',
            headers: { 'content-type': 'audio/wav' },
            body: wav,
          })
          const payload = await response.json().catch(() => null)
          if (!response.ok) throw new Error(payload?.error?.message ?? `transcription failed (${response.status})`)
          const text = typeof payload?.text === 'string' ? payload.text.trim() : ''
          actions = captured.actions
          span = captured.span
          draft = captured.draft
          if (text === '') {
            report?.('warn', 'transcribed-empty', { bytes: wav.size })
            publish({ phase: 'idle', elapsed: 0, error: 'empty' })
          } else {
            report?.('info', 'transcribed', { chars: text.length, bytes: wav.size, ms })
            insert(text)
            publish({ phase: 'idle', elapsed: 0, error: null })
          }
        } catch (error) {
          report?.('error', 'transcription-failed', { message: String(error?.message ?? error).slice(0, 240) })
          publish({ phase: 'idle', elapsed: 0, error: String(error?.message ?? error) })
        }
      }

      /**
       * Open the microphone and start recording.
       * @param options - draft actions, the resolved provider, and the current draft.
       */
      async function start (options) {
        if (state.getSnapshot().phase !== 'idle') return
        publish({ error: null })
        if (navigator.mediaDevices?.getUserMedia === undefined) {
          report?.('warn', 'insecure-origin', { reason: 'getUserMedia is unavailable' })
          publish({ error: 'insecure' })
          return
        }
        let media
        try {
          media = await navigator.mediaDevices.getUserMedia({ audio: true })
        } catch (error) {
          const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError'
          report?.(denied ? 'warn' : 'error', denied ? 'microphone-denied' : 'microphone-failed', {
            name: String(error?.name ?? 'Error'),
            message: String(error?.message ?? error).slice(0, 240),
          })
          publish({ error: denied ? 'denied' : String(error?.message ?? error) })
          return
        }
        stream = media
        try {
          audioContext = new AudioContext()
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
          for (const track of media.getTracks?.() ?? []) {
            try { track.stop() } catch { /* already stopped */ }
          }
          stream = null
          if (audioContext !== null) void audioContext.close().catch(() => {})
          audioContext = null
          report?.('error', 'recorder-failed', { message: String(error?.message ?? error).slice(0, 240) })
          publish({ error: String(error?.message ?? error) })
          return
        }
        chunks = []
        element.ondataavailable = (event) => {
          if (event.data.size > 0) chunks.push(event.data)
        }
        element.onstop = () => { void finish(element.mimeType) }
        recorder = element
        actions = options?.actions ?? null
        target = options?.selection ?? null
        draft = options?.draft ?? ''
        span = actions?.captureInsertion?.() ?? null
        commit = true
        startedAt = Date.now()
        smoothed = 0
        wave.reset()
        try {
          element.start()
        } catch (error) {
          teardown()
          wave.reset()
          report?.('error', 'recorder-failed', { message: String(error?.message ?? error).slice(0, 240) })
          publish({ phase: 'idle', elapsed: 0, error: String(error?.message ?? error) })
          return
        }
        publish({ phase: 'recording', elapsed: 0 })
        elapsedTimer = window.setInterval(() => publish({ elapsed: (Date.now() - startedAt) / 1000 }), 250)
        if (analyser !== null && buffer !== null) {
          levelTimer = window.setInterval(() => {
            if (analyser === null || buffer === null) return
            analyser.getFloatTimeDomainData(buffer)
            let sum = 0
            for (let index = 0; index < buffer.length; index++) sum += buffer[index] * buffer[index]
            const level = Math.min(1, Math.max(0, Math.sqrt(sum / buffer.length) * 6))
            /* Smooth towards the sample so single frames do not flicker. */
            smoothed += (level - smoothed) * 0.45
            wave.push(smoothed)
          }, LEVEL_INTERVAL_MS)
        }
      }

      /** Stop and transcribe. */
      function stop () {
        if (recorder === null) return
        commit = true
        if (recorder.state !== 'inactive') recorder.stop()
        else void finish(recorder.mimeType)
      }

      /** Stop and discard. */
      function cancel () {
        if (recorder === null) return
        commit = false
        if (recorder.state !== 'inactive') recorder.stop()
        else {
          teardown()
          wave.reset()
          publish({ phase: 'idle', elapsed: 0 })
        }
      }

      return { state, wave, start, stop, cancel, dispose: () => { commit = false; stop() } }
    }

    /* -------------------------------------------------------------- components */

    /**
     * The waveform itself: a stable set of two-pixel columns whose heights are
     * written directly, so a recording never re-renders React. It repaints at the
     * sampling cadence (not per frame) and only writes heights that changed.
     * @param props - `columns` to draw, the shared `wave`, and whether it is live.
     * @returns The wave row.
     */
    function Wave ({ columns, wave, live }) {
      const rowRef = React.useRef(null)

      React.useEffect(() => {
        const row = rowRef.current
        if (row === null || !live) return undefined
        let timer = null
        let painted = false
        const paint = () => {
          timer = window.setTimeout(paint, LEVEL_INTERVAL_MS)
          if (document.visibilityState === 'hidden') return
          const bars = row.children
          const count = bars.length
          for (let index = 0; index < count; index++) {
            const height = `${Math.round(6 + Math.min(1, Math.max(0, wave.at(index, count))) * 94)}%`
            const bar = bars[index]
            if (bar.style.height !== height) bar.style.height = height
          }
          painted = true
        }
        paint()
        return () => {
          if (timer !== null) window.clearTimeout(timer)
          if (painted) for (const bar of row.children) bar.style.height = ''
        }
      }, [live, wave, columns])

      return h('div', { ref: rowRef, className: 'dsh-stt-wave', 'aria-hidden': true },
        Array.from({ length: columns }, (_, index) => h('span', { key: index, className: 'dsh-stt-wave-bar' })))
    }

    /**
     * The bar above the composer: cancel, a live waveform of the last few
     * seconds, the elapsed time, and a confirm button that transcribes.
     * @param props - composed slot props.
     * @returns The bar, or null when nothing is running.
     */
    function ListeningBar ({ useSttRecorder, t, wave, stop, cancel }) {
      const state = useValue(useSttRecorder)
      const [columns, setColumns] = React.useState(120)
      const waveRef = React.useRef(null)
      const live = state.phase === 'recording'

      /* One column per ~4px, measured whenever the bar appears or the row resizes. */
      React.useEffect(() => {
        const element = waveRef.current
        if (element === null) return undefined
        const measure = () => {
          const width = element.clientWidth
          if (width > 0) setColumns(Math.max(24, Math.min(WAVE_BARS, Math.floor((width + 2) / 4))))
        }
        measure()
        if (typeof ResizeObserver !== 'function') return undefined
        const observer = new ResizeObserver(measure)
        observer.observe(element)
        return () => observer.disconnect()
      }, [state.phase])

      /* The wave subtree survives elapsed ticks: same element, same props. */
      const waveNode = React.useMemo(
        () => h(Wave, { columns, wave, live }),
        [columns, wave, live],
      )

      if (state.phase === 'idle') return null
      return h('div', {
        className: 'dsh-stt-bar',
        'data-phase': state.phase,
        'data-dsh-tts-ignore': '',
        role: 'status',
        'aria-live': 'polite',
      }, [
        live
          ? h('button', {
            key: 'cancel',
            type: 'button',
            className: 'dsh-stt-round',
            'aria-label': t('cancel'),
            title: t('cancel'),
            onClick: cancel,
          }, h(primitives.IconCloseOutlineRegular, {}))
          : null,
        h('div', { key: 'wave-host', ref: waveRef, className: 'dsh-stt-wave-host' },
          live ? waveNode : h('span', { className: 'dsh-stt-bar-label' }, t('working'))),
        live ? h('span', { key: 'time', className: 'dsh-stt-time' }, clockOf(state.elapsed)) : null,
        live
          ? h('button', {
            key: 'stop',
            type: 'button',
            className: 'dsh-stt-round',
            'data-primary': '',
            'aria-label': t('stop'),
            title: t('trigger.stop'),
            onClick: stop,
          }, h(primitives.IconCheckOutlineRegular, {}))
          : h('span', { key: 'spin', className: 'dsh-stt-bar-spin', 'aria-hidden': true }),
      ])
    }

    /**
     * Composer microphone: opens the recorder, and hosts provider/model choices.
     * @param props - composed slot props.
     * @returns The trigger plus, while open, the dictation panel.
     */
    function DictateControl (props) {
      const { t, inputActions, useInput, useSttRecorder, updateSettings, useSttSettings, refresh, useSttInfo, start, stop } = props
      const recorder = useValue(useSttRecorder)
      const settings = useValue(useSttSettings)
      const info = useValue(useSttInfo)
      const draft = useInput((state) => state.draft)
      const [open, setOpen] = React.useState(false)
      const { position, triggerRef, panelRef, panelId } = usePanel(open, setOpen, PANEL_WIDTH.stt)
      const selection = selectionOf(settings, info)
      const language = settings.language ?? 'auto'
      const liveRef = React.useRef({ selection, language, draft, inputActions, info })
      liveRef.current = { selection, language, draft, inputActions, info }
      const refreshRef = React.useRef(refresh)
      refreshRef.current = refresh

      /* Opening the panel re-probes the providers: the list is what it is for. */
      React.useEffect(() => {
        if (open) refreshRef.current()
      }, [open])

      /* A failed take has no bar to report in, so open the panel for it. */
      React.useEffect(() => {
        if (recorder.error !== null && recorder.error !== undefined) setOpen(true)
      }, [recorder.error])

      const errorText = (() => {
        const error = recorder.error
        if (error === null || error === undefined) return null
        if (error === 'denied') return t('status.denied')
        if (error === 'insecure') return t('status.insecure')
        if (error === 'empty') return t('status.empty')
        return String(error)
      })()

      const summary = selection.server !== null && selection.model !== null
        ? t('status.ready', { server: selection.server.name ?? selection.server.id, model: selection.model.id })
        : t('status.none')

      const panel = open && position !== null
        ? h(Panel, { key: 'panel', panelRef, panelId, className: 'dsh-stt-panel', label: t('panel.aria'), style: position }, [
          h('div', { key: 'title', className: 'dsh-stt-title' }, t('panel.title')),
          h('div', { key: 'state', className: 'dsh-stt-label' }, summary),
          selection.servers.length > 1
            ? h(Field, { key: 'servers', prefix: 'dsh-stt', label: t('server') },
              h(Chips, {
                prefix: 'dsh-stt',
                items: selection.servers,
                labelOf: (server) => server.name ?? server.id,
                activeOf: () => selection.server?.id,
                onPick: (id) => updateSettings({ server: id, model: null }),
              }))
            : null,
          selection.models.length > 0
            ? h(Field, { key: 'models', prefix: 'dsh-stt', label: t('model') },
              h(Chips, {
                prefix: 'dsh-stt',
                items: selection.models,
                labelOf: (model) => model.id,
                activeOf: () => selection.model?.id,
                onPick: (id) => updateSettings({ model: id }),
              }))
            : null,
          h(Field, { key: 'language', prefix: 'dsh-stt', label: t('language') },
            h(Chips, {
              prefix: 'dsh-stt',
              items: info.languages ?? ['auto'],
              labelOf: (code) => code,
              activeOf: () => language,
              onPick: (code) => updateSettings({ language: code }),
            })),
          h('div', { key: 'status', className: 'dsh-stt-status', 'data-tone': errorText === null ? undefined : 'warn' },
            errorText ?? summary),
          h('div', { key: 'hint', className: 'dsh-stt-status' }, t('hint')),
        ])
        : null

      const recording = recorder.phase === 'recording'
      return h('div', { key: 'group', className: 'dsh-stt-group' }, [
        h('button', {
          key: 'trigger',
          ref: triggerRef,
          type: 'button',
          className: 'dsh-stt-trigger',
          'data-recording': recording ? '' : undefined,
          title: recording ? t('trigger.stop') : t('trigger.start'),
          onClick: () => {
            if (recording) {
              stop()
              return
            }
            const live = liveRef.current
            if (live.selection.server === null || live.selection.model === null) {
              setOpen(true)
              return
            }
            /* The recorder owns the request, so the language hint rides with the
               resolved target instead of being read off it later. */
            void start({ actions: live.inputActions, selection: { ...live.selection, language: live.language }, draft: live.draft })
          },
        }, [
          recording
            ? h('span', { key: 'dot', className: 'dsh-stt-dot' })
            : h(primitives.IconMicrophoneOutlineRegular, { key: 'icon' }),
          h('span', { key: 'label' }, recording ? clockOf(recorder.elapsed) : t('trigger')),
        ]),
        h('button', {
          key: 'caret',
          type: 'button',
          className: 'dsh-stt-caret',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-controls': open ? panelId : undefined,
          'aria-label': t('panel.title'),
          title: t('panel.title'),
          onClick: () => setOpen(!open),
        }, h(primitives.IconChevronDownOutlineRegular, {})),
        panel,
      ])
    }

    /* ------------------------------------------------------------ configuration */

    /** The installed package name, which keys a Host row's configuration page. */
    const PKG_ID = 'dsh-plugin-speech'

    /**
     * The Host rows this bundle declares, each with the config fields its page
     * edits: `roster` marks the pages whose selects are filled from discovery.
     */
    const CONFIG_PAGES = [
      {
        rowId: 'audio-core',
        fields: [
          { name: 'voiceCatalog', kind: 'paths', label: 'config.voiceCatalog', help: 'config.voiceCatalog.help' },
          { name: 'discoveryTtlMs', kind: 'number', label: 'config.discoveryTtlMs', help: 'config.discoveryTtlMs.help' },
          { name: 'logLimit', kind: 'number', label: 'config.logLimit', help: 'config.logLimit.help' },
        ],
      },
      {
        rowId: 'audio-tts',
        roster: 'tts',
        fields: [
          { name: 'server', kind: 'servers', label: 'config.server', help: 'config.server.help' },
          { name: 'model', kind: 'models', label: 'config.model', help: 'config.model.help' },
          { name: 'voice', kind: 'voices', label: 'config.voice', help: 'config.voice.help' },
          { name: 'speed', kind: 'number', label: 'config.speed', help: 'config.speed.help' },
          { name: 'maxChars', kind: 'number', label: 'config.maxChars', help: 'config.maxChars.help' },
        ],
      },
      {
        rowId: 'audio-stt',
        roster: 'stt',
        fields: [
          { name: 'server', kind: 'servers', label: 'config.server', help: 'config.server.help' },
          { name: 'model', kind: 'models', label: 'config.model', help: 'config.model.help' },
          { name: 'language', kind: 'languages', label: 'config.language', help: 'config.language.help' },
          { name: 'maxAudioBytes', kind: 'number', label: 'config.maxAudioBytes', help: 'config.maxAudioBytes.help' },
        ],
      },
      {
        rowId: 'audio-status',
        fields: [
          { name: 'sample', kind: 'text', label: 'config.sample', help: 'config.sample.help' },
        ],
      },
    ]

    /**
     * The roster one configuration page offers: every server, model, voice, or
     * language hint the Host reports, fetched while the page is mounted.
     * @param roster - `tts`, `stt`, or undefined for a free-text page.
     * @returns The discovered configuration, or null before it answers.
     */
    function useRoster (roster) {
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        if (roster === undefined) return undefined
        let live = true
        const url = roster === 'tts' ? `${TTS_ROUTES.info}?refresh=1` : STT_ROUTES.info
        void fetch(url, { headers: { accept: 'application/json' } })
          .then((response) => response.json())
          .then((value) => { if (live) setData(value) })
          .catch(() => {})
        return () => { live = false }
      }, [roster])
      return data
    }

    /**
     * The choices one select of a configuration page offers.
     * @param field - the field being rendered.
     * @param data - the roster the page fetched.
     * @returns `{ value, label }` rows in discovery order, deduplicated.
     */
    function choicesOf (field, data) {
      if (data === null || data === undefined) return []
      const servers = Array.isArray(data.servers) ? data.servers : []
      const rows = (() => {
        if (field.kind === 'languages') {
          return (Array.isArray(data.languages) ? data.languages : ['auto']).map((code) => ({ value: code, label: code }))
        }
        if (field.kind === 'servers') {
          return servers.map((server) => ({ value: server.id, label: server.name ?? server.id }))
        }
        const models = servers.flatMap((server) => (Array.isArray(server.models) ? server.models : [])
          .map((model) => ({ server, model })))
        if (field.kind === 'models') {
          return models.map(({ server, model }) => ({
            value: typeof model === 'string' ? model : model.id,
            label: `${server.name ?? server.id} · ${typeof model === 'string' ? model : model.label ?? model.id}`,
          }))
        }
        return models.flatMap(({ model }) => (Array.isArray(model?.voices) ? model.voices : [])
          .map((voice) => ({ value: voice.id, label: `${model.id} · ${voice.label ?? voice.id}` })))
      })()
      const seen = new Set()
      return rows.filter((row) => {
        if (seen.has(row.value)) return false
        seen.add(row.value)
        return true
      })
    }

    /**
     * One control of a configuration page: it writes on commit, not per keystroke.
     * @param props - the field, its effective value, whether the user layer set it,
     *   the discovered choices, the write and clear actions, and the t reader.
     * @returns The field row.
     */
    function ConfigField ({ field, value, overridden, choices, write, clear, t }) {
      const id = `dsh-audio-${field.name}`
      const className = 'dsh-audio-config-input'
      const commit = (next) => {
        if (next === value || (value === undefined && next === '')) return
        void write(field.name, next)
      }
      let control
      if (field.kind === 'servers' || field.kind === 'models' || field.kind === 'voices' || field.kind === 'languages') {
        control = h('select', {
          key: 'control',
          id,
          className,
          value: typeof value === 'string' ? value : '',
          onChange: (event) => {
            const next = event.target.value
            if (next === '') void clear(field.name)
            else void write(field.name, next)
          },
        }, [
          h('option', { key: 'auto', value: '' }, t('config.auto')),
          ...choices.map((choice) => h('option', { key: choice.value, value: choice.value }, choice.label)),
        ])
      } else if (field.kind === 'paths') {
        control = h('textarea', {
          key: 'control',
          id,
          className,
          rows: 3,
          defaultValue: Array.isArray(value) ? value.join('\n') : '',
          onBlur: (event) => commit(event.target.value.split('\n').map((line) => line.trim()).filter((line) => line !== '')),
        })
      } else if (field.kind === 'number') {
        control = h('input', {
          key: 'control',
          id,
          className,
          type: 'number',
          defaultValue: typeof value === 'number' ? String(value) : '',
          onBlur: (event) => {
            const next = Number.parseFloat(event.target.value)
            if (Number.isFinite(next)) commit(next)
          },
        })
      } else {
        control = h('input', {
          key: 'control',
          id,
          className,
          type: 'text',
          defaultValue: typeof value === 'string' ? value : '',
          onBlur: (event) => commit(event.target.value.trim()),
        })
      }
      return h('div', { className: 'dsh-audio-config-field' }, [
        h('div', { key: 'head', className: 'dsh-audio-config-head' }, [
          h('label', { key: 'label', className: 'dsh-audio-config-label', htmlFor: id }, t(field.label)),
          overridden ? h('button', {
            key: 'reset',
            type: 'button',
            className: 'dsh-audio-config-reset',
            onClick: () => void clear(field.name),
          }, t('config.reset')) : null,
        ]),
        control,
        h('p', { key: 'help', className: 'dsh-audio-config-help' }, t(field.help)),
      ])
    }

    /**
     * One Host row's configuration page on the Plugins screen: the fields that
     * row's schema publishes, written back through the settings form the page
     * owner supplies.
     * @param props - the slot view, the owner-supplied form, the row page spec, and the t reader.
     * @returns The form, its status, or a note when the row is not served.
     */
    function RowConfigPage (props) {
      const { t, view, form, page } = props
      const roster = useRoster(page.roster)
      const [note, setNote] = React.useState(null)
      if (view === 'summary') return null
      if (form === undefined) return h('p', { className: 'dsh-audio-config-note', 'data-tone': 'warn' }, t('config.unavailable'))
      if (form.state.status === 'loading') return h('p', { className: 'dsh-audio-config-note' }, t('config.loading'))
      if (form.state.status === 'unavailable') return h('p', { className: 'dsh-audio-config-note', 'data-tone': 'warn' }, t('config.unavailable'))

      /**
       * Queue one write and report how the Host answered.
       * @param ops - the settings path operations to apply.
       * @returns Completion after the answer.
       */
      const send = async (ops) => {
        try {
          setNote((await form.mutate(ops)) ? 'config.saved' : 'config.refused')
        } catch (error) {
          setNote(String(error?.message ?? error))
        }
      }
      const write = (name, next) => send([{ op: 'set', path: [name], value: next }])
      const clear = (name) => send([{ op: 'unset', path: [name] }])

      const value = form.state.value ?? {}
      const user = form.state.user ?? {}
      return h('div', { className: 'dsh-audio-config' }, [
        ...page.fields.map((field) => h(ConfigField, {
          key: field.name,
          field,
          value: value[field.name],
          overridden: Object.hasOwn(user, field.name),
          choices: choicesOf(field, roster),
          write,
          clear,
          t,
        })),
        h('p', { key: 'note', className: 'dsh-audio-config-note', 'data-tone': note === 'config.refused' || (note !== null && !note.startsWith('config.')) ? 'warn' : undefined },
          note === null ? null : (note.startsWith('config.') ? t(note) : note)),
      ])
    }


    /* ------------------------------------------------------------------ plugin */

    /** Required client services: slot registry, dictionaries, Session log access. */
    const inject = ['slots', 'locale', 'sessions']

    /**
     * Read the shared status route once.
     * @param store - status store to publish into.
     * @returns The status value, or null when the probe failed (a 404 included).
     */
    async function probeStatus (store) {
      try {
        const response = await fetch(AUDIO_ROUTES.status, { headers: { accept: 'application/json' } })
        if (!response.ok) throw new Error(`/audio/status answered ${response.status}`)
        const value = await response.json()
        store.set({ state: 'ready', value, error: null })
        return value
      } catch (error) {
        store.set({ state: 'error', value: null, error: String(error?.message ?? error) })
        return null
      }
    }

    /**
     * Mount the speech components the host says are on.
     * @param ctx - client root context.
     */
    function apply (ctx) {
      installCss()
      /* Both dictionaries belong to this one module, even when a half is off. */
      ctx.effect(() => ctx.locale.register(TTS_NS, { en: ttsEn, zh: ttsZh }), 'dsh-plugin-speech: tts dictionaries')
      ctx.effect(() => ctx.locale.register(STT_NS, { en: sttEn, zh: sttZh }), 'dsh-plugin-speech: stt dictionaries')
      ctx.effect(() => ctx.locale.register(AUDIO_NS, { en: audioEn, zh: audioZh }), 'dsh-plugin-speech: configuration dictionaries')
      /* One configuration page per Host row, keyed the way the Plugins screen
         dispatches it: `<package>#<row id>`. The page lives beside the row it
         configures and is offered whether or not the component is switched on. */
      for (const page of CONFIG_PAGES) {
        ctx.slots.inject('plugins.row.config', () => ctx.slots.register({
          name: 'plugins.row.config',
          key: `${PKG_ID}#${page.rowId}`,
          locale: AUDIO_NS,
          inject: () => ({ page }),
        }, RowConfigPage), `dsh-plugin-speech: ${page.rowId} configuration page`)
      }

      const audioStatus = createStore({ state: 'loading', value: null, error: null })

      /** Mount the read-aloud half: engine, watcher, and its three slots. */
      function mountTts () {
        const settings = createSettingsStore(TTS_SETTINGS)
        const info = createStore({ status: 'loading', value: null, error: null })
        const report = createReporter('tts')
        const reportMiss = (entry) => report('warn', 'highlight-miss', {
          reason: entry?.reason ?? 'unknown',
          scopeRows: entry?.scopeRows ?? 0,
          roots: entry?.roots ?? 'unknown',
          sentence: String(entry?.sentence ?? '').slice(0, 240),
          domTokens: entry?.domTokens ?? 0,
          wantedTokens: entry?.wantedTokens ?? 0,
          headFound: entry?.headFound ?? false,
          tailFound: entry?.tailFound ?? false,
          domStart: String(entry?.domStart ?? '').slice(0, 80),
        })
        const highlighter = createHighlighter(reportMiss)
        const engine = createEngine(settings, info, highlighter, report)

        /**
         * What one reply should sound like: plain prose, or a cast plan when the
         * experimental multi-voice mode is on and the reply has something to split.
         * @param sessionId - Session owning the message.
         * @param messageId - durable message identity.
         * @returns Prose, a chunk plan, or null when there is nothing to read.
         */
        const planFor = (sessionId, messageId) => {
          const text = readAssistantText(ctx, sessionId, messageId)
          if (text === '') return null
          if (settings.getSnapshot().cast !== true) return text
          const raw = readAssistantRaw(ctx, sessionId, messageId)
          const selection = selectionOf(settings.getSnapshot(), info.getSnapshot().value)
          const voices = Array.isArray(selection.model?.voices) ? selection.model.voices : []
          const built = buildCast(raw, voices, selection.voice?.id ?? null)
          if (built.chunks === null) {
            report('debug', 'cast-unavailable', { voices: voices.length })
            return text
          }
          report('debug', 'cast', { cast: built.cast })
          return built.chunks
        }

        /* Created after the planner so it can reuse it for autoplay. */
        const watcher = createWatcher(ctx, engine, settings, (sessionId, messageId) => planFor(sessionId, messageId))

        /** Read one message of one Session, highlighting inside its rendered turn. */
        const read = (sessionId, messageId, element) => {
          const plan = planFor(sessionId, messageId)
          if (plan === null) {
            engine.fail('empty')
            return
          }
          engine.speak(messageId, plan, { scope: renderingScope(element) })
        }

        /** Read whatever the Session answered last. */
        const readLast = (sessionId) => {
          const found = findLastAssistant(ctx, sessionId)
          const plan = found === null ? null : planFor(sessionId, found.id)
          if (plan === null) {
            engine.fail('empty')
            return
          }
          engine.speak(found.id, plan)
        }

        /**
         * Speak and transcribe one fixed sentence through the shared route, so
         * the panel can show the components answering together.
         * @returns The transcript with its timings, or the failure message.
         */
        const roundTrip = async () => {
          try {
            const response = await fetch(AUDIO_ROUTES.echo, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ text: ECHO_SAMPLE }),
            })
            const payload = await response.json().catch(() => null)
            if (!response.ok) throw new Error(payload?.error?.message ?? `/audio/echo answered ${response.status}`)
            report('info', 'round-trip', { server: payload?.server ?? null, bytes: payload?.bytes ?? 0 })
            return {
              ok: true,
              transcript: typeof payload?.transcript === 'string' ? payload.transcript : '',
              speakMs: typeof payload?.speakMs === 'number' ? payload.speakMs : null,
              transcribeMs: typeof payload?.transcribeMs === 'number' ? payload.transcribeMs : null,
              server: payload?.server ?? null,
            }
          } catch (error) {
            report('error', 'round-trip-failed', { message: String(error?.message ?? error).slice(0, 240) })
            return { ok: false, error: String(error?.message ?? error) }
          }
        }

        ctx.effect(() => () => {
          watcher.dispose()
          engine.dispose()
          highlighter.dispose()
        }, 'dsh-plugin-speech: speech lifetime')
        /* A page load is a hard refresh: probe the providers again instead of
           serving whatever the Host cached before it restarted. */
        void refreshInfo(info, true)
        /* Tell the Host whether the experiment is on: it owns the prompt section. */
        const syncCast = (enabled) => {
          void fetch(TTS_ROUTES.cast, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ enabled: enabled === true }),
          }).catch(() => {})
        }
        syncCast(settings.getSnapshot().cast === true)

        const ttsState = { getSnapshot: engine.state.getSnapshot, subscribe: engine.state.subscribe }
        const ttsSettings = { getSnapshot: settings.getSnapshot, subscribe: settings.subscribe }
        const ttsInfo = { getSnapshot: info.getSnapshot, subscribe: info.subscribe }

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
          name: 'conversation.chat.assistant-actions',
          id: 'tts-listen',
          order: 5,
          locale: TTS_NS,
          inject: () => ({ hooks: { ttsState }, read, stop: () => engine.stop() }),
        }, ListenAction), 'dsh-plugin-speech: reply action')

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'tts-read-aloud',
          order: 60,
          locale: TTS_NS,
          inject: () => ({
            hooks: { ttsState, ttsSettings, ttsInfo, audioStatus },
            readLast,
            watch: (sessionId) => watcher.bind(sessionId),
            updateSettings: (patch) => {
              settings.save(patch)
              if ('cast' in patch) syncCast(patch.cast)
            },
            refresh: () => refreshInfo(info),
            roundTrip,
          }),
        }, ReadControl), 'dsh-plugin-speech: composer control')

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'tts-caption',
          order: 40,
          locale: TTS_NS,
          inject: () => ({
            hooks: { ttsState, ttsSettings, ttsInfo },
            changeRate: (value) => {
              settings.save({ speed: value })
              engine.setRate(value)
            },
            pause: () => engine.pause(),
            resume: () => engine.resume(),
            stop: () => engine.stop(),
            dismiss: () => engine.dismiss(),
            seek: (seconds) => engine.seek(seconds),
            skip: (delta) => engine.skip(delta),
            replay: () => engine.replay(),
          }),
        }, ReadingCaption), 'dsh-plugin-speech: reading caption')
      }

      /** Mount the dictation half: recorder and its two slots. */
      function mountStt () {
        const settings = createSettingsStore(STT_SETTINGS)
        const info = createStore({ servers: [], defaults: { server: null, model: null }, languages: ['auto'] })
        const report = createReporter('stt')
        const recorder = createRecorder(settings, info, report)

        /**
         * Read provider state from the Host.
         * @param force - ask the Host to re-probe its providers, not serve its cache.
         */
        const refresh = async (force = false) => {
          try {
            const response = await fetch(force ? `${STT_ROUTES.info}?refresh=1` : STT_ROUTES.info, { headers: { accept: 'application/json' } })
            if (!response.ok) throw new Error(`/stt/info answered ${response.status}`)
            info.set(await response.json())
          } catch (error) {
            info.set({ ...info.getSnapshot(), error: String(error?.message ?? error) })
          }
        }

        ctx.effect(() => () => recorder.dispose(), 'dsh-plugin-speech: microphone lifetime')
        /* A page load is a hard refresh: probe the providers again. */
        void refresh(true)

        const sttInfo = { getSnapshot: info.getSnapshot, subscribe: info.subscribe }
        const sttSettings = { getSnapshot: settings.getSnapshot, subscribe: settings.subscribe }
        const sttRecorder = { getSnapshot: recorder.state.getSnapshot, subscribe: recorder.state.subscribe }

        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
          name: 'conversation.input.dock',
          id: 'stt-listening',
          order: 30,
          locale: STT_NS,
          inject: () => ({
            hooks: { sttRecorder },
            wave: recorder.wave,
            stop: () => recorder.stop(),
            cancel: () => recorder.cancel(),
          }),
        }, ListeningBar), 'dsh-plugin-speech: listening bar')

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'stt-dictate',
          order: 55,
          locale: STT_NS,
          inject: () => ({
            hooks: { sttInfo, sttSettings, sttRecorder },
            updateSettings: (patch) => settings.save(patch),
            refresh,
            start: (options) => recorder.start(options),
            stop: () => recorder.stop(),
          }),
        }, DictateControl), 'dsh-plugin-speech: dictation control')
      }

      void (async () => {
        /* Registering late is fine: these inject callbacks may run after the
           await. When the probe fails, mount both halves rather than hide UI. */
        const value = await probeStatus(audioStatus)
        const listed = Array.isArray(value?.components)
          ? new Set(value.components.map((component) => component?.id).filter((id) => typeof id === 'string'))
          : null
        if (listed === null || listed.has('tts')) mountTts()
        if (listed === null || listed.has('stt')) mountStt()
      })()
    }

    exports.apply = apply
    exports.inject = inject
    exports.__internals = {
      apply,
      PKG: PKG_ID,
      configPages: CONFIG_PAGES,
      RowConfigPage,
      dictionaries: { en: ttsEn, zh: ttsZh },
      audioDictionaries: { en: audioEn, zh: audioZh },
      cleanForSpeech,
      createEngine,
      createHighlighter,
      createSettingsStore,
      createStore,
      buildCast,
      castSegments,
      findAnchorRange,
      findLastAssistant,
      readAssistantRaw,
      findTextRange,
      findTurnAnswer,
      readAssistantText,
      splitChunks,
      clockOf,
      createRecorder,
      toWav,
      wavBlob,
    }
    return module.exports
  },
})
