window.__ModuleLoader__.load({
  id: '@local/dsh-restart',
  factory(require) {
    const React = require('react')
    const { MenuItemButton, StateDot, IconCordisPluginOutlineRegular, IconRefreshOutlineRegular,
      IconWarningTriangleOutlineRegular, IconWarningOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const en = { restart: 'Restart DSH', reload: 'Reload plugins', armed: 'Click again to restart', within: 'Valid for {seconds}s',
      confirm: 'Confirm: interrupt and restart', restarting: 'Restarting…', reloading: 'Reloading…', needSession: 'Open a session first',
      failed: 'Failed', noResult: 'The command returned no result', blocked: 'Cannot restart' }
    const zh = { restart: '重启 DSH', reload: '重载插件', armed: '再次点击以重启', within: '{seconds} 秒内有效',
      confirm: '确认中断并重启', restarting: '正在重启…', reloading: '正在重载…', needSession: '打开一个会话后可用',
      failed: '操作失败', noResult: '命令没有返回结果', blocked: '无法重启' }
    const NS = 'dshRestart'

    // 宿主 restart check 的首行判词（§5.2 VERDICT）：宿主文案固定中文，客户端以此判定，不随界面语言变
    const VERDICT = { ok: '可以重启', busy: '有代理正在运行', blocked: '无法重启' }

    const h = React.createElement
    const TONE = { idle: '--dsw-alias-label-secondary', warn: '--dsw-alias-state-warn-primary', error: '--dsw-alias-state-error-primary' }
    const ICON = { idle: IconRefreshOutlineRegular, warn: IconWarningTriangleOutlineRegular, error: IconWarningOutlineRegular }

    function Label({ tone, title, detail }) {
      return h('span', { style: { display: 'flex', flexDirection: 'column', gap: 2 } },
        h('span', null, title),
        detail != null && h('span', {
          style: { fontSize: 12, lineHeight: 1.35, color: `var(${TONE[tone] ?? TONE.idle})`, whiteSpace: 'pre-wrap' },
        }, detail))
    }
    // 图标：primitives 没有「旋转的 loading 图标」——IconLoadingOutlineRegular 是静态字形。
    // 真正会转的是 StateDot state='ongoing'（svg 弧线 + 宿主 keyframes，stroke 用 currentColor），
    // 包一层 span 把它撑到 16px 并继承行的颜色。
    const iconFor = (tone, Glyph) => h('span', {
      style: { display: 'inline-flex', color: `var(${TONE[tone] ?? TONE.idle})` },
    }, h(Glyph, { size: 16 }))
    const spinner = () => h('span', { style: { display: 'inline-flex', color: 'var(--dsw-alias-label-secondary)' } },
      h(StateDot, { state: 'ongoing', size: 16 }))

    // restart check / reload 的结果：首行 + 其余行；默认标题由调用方按 locale 给
    const split = (text, fallback) => {
      const [title, ...rest] = String(text ?? '').split('\n')
      return { title: title || fallback, detail: rest.join('\n') || null }
    }

    function RestartMenu({ useSessions, onDismiss, t, api }) {
      // 主视图里正在展示的会话；没有会话时两行禁用
      const sessionId = useSessions(state => Object.values(state.byId)
        .find(s => (s.retainedBy.mainView ?? 0) > 0)?.id)
      const [armed, setArmed] = React.useState(null)        // 重启行武装态 { tone, title, detail }（3s 复位）
      const [left, setLeft] = React.useState(3)             // 空闲武装的剩余秒数：3 → 2 → 1
      const [failed, setFailed] = React.useState(null)      // 重启行错误态（契约未就绪 / 执行失败）
      const [note, setNote] = React.useState(null)          // 重启行瞬时文案：正在重启…
      const [reloadRow, setReloadRow] = React.useState(null) // 重载行状态，与重启行互不串扰
      const [busy, setBusy] = React.useState(false)         // 请求在途：两行禁用，顺便消掉双击
      const armTimer = React.useRef(null)
      const leftTimer = React.useRef(null)
      const reloadTimer = React.useRef(null)
      const restarting = React.useRef(false)                // 已发出重启：等 connection/reset 收起菜单
      React.useEffect(() => () => {
        clearTimeout(armTimer.current); clearInterval(leftTimer.current); clearTimeout(reloadTimer.current)
      }, [])
      // 进程重启后浏览器会建立新的连接代际（connection/reset）：菜单自动收起。
      // 只在确实发出过重启命令后生效，普通断线重连不关菜单。
      React.useEffect(() => api.on('connection/reset', () => {
        if (!restarting.current) return
        restarting.current = false
        onDismiss()
      }), [])

      // 直接调 RPC 时行文本必须带前导 `/`（宿主 parseCommand 的正则要求），附件传空数组
      const execute = async (line) => {
        try {
          const r = await api.remote.commands.execute(sessionId, line, [])
          if (r?.ok === false) return { kind: 'error', text: r.error?.message ?? t('failed') }
          return r?.value?.result ?? { kind: 'error', text: t('noResult') }
        } catch (error) {
          return { kind: 'error', text: String(error?.message ?? error) }
        }
      }

      // 武装：先清上一个定时器与倒计时再设新的，重复首击不会提前复位（REVIEW-3 §2.5）
      const arm = (state) => {
        clearTimeout(armTimer.current)
        clearInterval(leftTimer.current)
        setArmed(state)
        setLeft(3)
        if (state.tone === 'idle') {
          leftTimer.current = setInterval(() => {
            setLeft(n => (n <= 1 ? n : n - 1))   // 停在 1，3s 到点由 armTimer 复位
          }, 1000)
        }
        armTimer.current = setTimeout(() => {
          clearInterval(leftTimer.current)
          setArmed(null)
        }, 3000)
      }
      const disarm = () => {
        clearTimeout(armTimer.current)
        clearInterval(leftTimer.current)
        setArmed(null)
      }

      const restart = async () => {
        if (busy) return
        setBusy(true)
        try {
          if (armed !== null) {
            // 二击：只有看过「N 个代理正在运行」警示的武装才有 now 权限；
            // 空闲武装仍走 /restart，由宿主重新检查，3s 内新起的代理不会被静默打断（REVIEW-3 §2.1）。
            const forced = armed.tone === 'warn'
            disarm()
            setNote(t('restarting'))
            const result = await execute(forced ? '/restart now' : '/restart')
            if (result.kind === 'error') {
              setNote(null)
              const { title, detail } = split(result.text, t('blocked'))
              if (title === VERDICT.busy) arm({ tone: 'warn', title: t('confirm'), detail })
              else setFailed({ tone: 'error', title, detail })
            } else {
              restarting.current = true                   // 进程即将退出；等 connection/reset 收起菜单
            }
            return
          }
          const result = await execute('/restart check')     // 首击（或失败后重试）：只检查，不执行
          const { title, detail } = split(result.text, t('blocked'))
          if (result.kind === 'error') { setFailed({ tone: 'error', title, detail }); return }
          setFailed(null)
          if (title === VERDICT.busy) arm({ tone: 'warn', title: t('confirm'), detail })
          else arm({ tone: 'idle', title: t('armed'), detail: null })
        } finally {
          setBusy(false)
        }
      }

      const reload = async () => {
        if (busy) return
        setBusy(true)
        try {
          setReloadRow({ tone: 'loading', title: t('reloading') })
          const result = await execute('/reload')            // 与 /reload 共用同一 Host handler
          const row = split(result.text, t('failed'))
          setReloadRow(result.kind === 'error'
            ? { tone: 'error', ...row }
            : { tone: row.detail ? 'warn' : 'idle', ...row })
          reloadTimer.current = setTimeout(onDismiss, 1500)   // 行内文字保留 1.5s 再收起
        } finally {
          setBusy(false)
        }
      }

      const armedDetail = armed === null ? null
        : armed.tone === 'idle' ? t('within', { seconds: left })
          : armed.detail ?? null
      const row = note != null
        ? { tone: 'loading', title: note }
        : armed !== null ? { tone: armed.tone, title: armed.title, detail: armedDetail }
          : failed ?? { tone: 'idle', title: t('restart') }
      const disabled = sessionId === undefined || busy
      const disabledReason = sessionId === undefined ? t('needSession') : undefined

      return h(React.Fragment, null,
        h(MenuItemButton, {
          separatorBefore: true,
          icon: reloadRow?.tone === 'loading' ? spinner()
            : h('span', { style: { display: 'inline-flex', color: `var(${TONE[reloadRow?.tone] ?? TONE.idle})` } },
              h(IconCordisPluginOutlineRegular, { size: 16 })),
          disabled, disabledReason, onSelect: reload,
        }, reloadRow == null ? t('reload') : h(Label, reloadRow)),
        h(MenuItemButton, {
          icon: row.tone === 'loading' ? spinner() : iconFor(row.tone, ICON[row.tone] ?? ICON.idle),
          disabled, disabledReason, onSelect: restart,
        }, h(Label, row)),
      )
    }

    return {
      inject: ['slots', 'remote', 'remote.commands', 'commandUi', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { zh, en }))
        ctx.effect(() => ctx.commandUi.register({
          name: 'restart status',
          description: () => '查看重启契约、MainPID 与运行中代理数',
          available: () => true,
          ui: {
            kind: 'action',
            run: (session) => {
              void ctx.remote.commands.execute(session.sessionId, '/restart status', [])
                .then((result) => { if (!result.ok) console.warn('dsh-restart: /restart status failed', result.error) })
            },
          },
        }), 'dsh-restart: command menu row')
        ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register(
          { name: 'sidebar.panellist.actions', id: 'dsh-restart', order: 1000, locale: NS },
          props => h(RestartMenu, { ...props, api: ctx }),
        ))
      },
    }
  },
})
