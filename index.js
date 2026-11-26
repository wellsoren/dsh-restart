import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { promisify } from 'node:util'
const run = promisify(execFile)
const SHOW_TIMEOUT_MS = 5000

// 主管本进程的 unit 从 cgroup 派生：systemd 系统服务为 0::/system.slice/<name>.service。
// 派生不出 .service（docker / 用户会话 scope / 非 systemd）→ null → 按「非 systemd 托管」处理。
function deriveUnit() {
  try {
    const paths = readFileSync('/proc/self/cgroup', 'utf8').split('\n')
      .map(line => line.slice(line.lastIndexOf(':') + 1)).filter(Boolean)
    const path = paths.find(p => p.endsWith('.service'))
    return path === undefined ? null : path.slice(path.lastIndexOf('/') + 1)
  } catch { return null }
}
const UNIT = deriveUnit()

// Cordis 4 没有「可选 inject」：任一 inject 服务缺席，整个插件静默不加载。
// 可选宿主值（hmr / agents / appExit）一律用 ctx.get() 读取。
export const name = 'dsh-restart'
export const inject = ['commands']

// systemctl show 的多属性 --value 输出顺序与 -p 顺序无关（systemd 252 实测），
// 所以不带 --value、按 key=value 解析；execFile 加超时，dbus 卡住时不会无限等待。
async function show(props) {
  const { stdout } = await run('systemctl', ['show', ...props.map(p => ['-p', p]).flat(), UNIT], { timeout: SHOW_TIMEOUT_MS })
  return Object.fromEntries(stdout.trim().split('\n').map(line => {
    const i = line.indexOf('=')
    return [line.slice(0, i), line.slice(i + 1)]
  }))
}

// 契约探测：{ kind:'ok', restart } | { kind:'absent' } | { kind:'unavailable', detail }
async function probe() {
  if (UNIT === null) return { kind: 'unavailable', detail: '本进程不在任何 systemd .service 的 cgroup 里' }
  try {
    const props = await show(['LoadState', 'Restart'])
    if (props.LoadState !== 'loaded') return { kind: 'absent' }
    return { kind: 'ok', restart: props.Restart }
  } catch (error) {
    return { kind: 'unavailable', detail: error?.killed ? 'systemctl 超时' : String(error?.code ?? error?.message ?? error) }
  }
}

// agents.list() 含子代理，所以文案说「代理」而不是「回合」——一个回合带两个子代理会显示 3。
function running(ctx) {
  return (ctx.get('agents')?.list() ?? []).filter(agent => agent.status === 'running')
}

function ready(found) {
  return found.kind === 'ok' && found.restart === 'always'
}

// 首行是给客户端判定用的固定判词（§5.3 VERDICT），第二行起是给人看的说明
const VERDICT = { ok: '可以重启', busy: '有代理正在运行', blocked: '无法重启' }

// 菜单行的短说明：一行以内，长命令留给 /restart 与 /restart status
function shortReason(found) {
  if (found.kind === 'absent') return `unit ${UNIT} 不存在或未加载`
  if (found.kind === 'unavailable') return `systemctl 不可用：${found.detail}`
  return `Restart=${found.restart}，未启用；/restart status 查看修复命令`
}

function contractHelp(found) {
  if (found.kind === 'absent') return `unit ${UNIT} 不存在或未加载（LoadState 不是 loaded）。`
  if (found.kind === 'unavailable') return `无法执行 systemctl（${found.detail}），本机可能不是 systemd 托管。`
  return `当前 unit 的 Restart=${found.restart}，退出后不会自动拉起。\n`
    + `请先执行：sudo mkdir -p /etc/systemd/system/${UNIT}.d && `
    + `printf '[Service]\\nRestart=always\\nRestartSec=2\\n' | sudo tee /etc/systemd/system/${UNIT}.d/10-restart.conf && `
    + `sudo systemctl daemon-reload && sudo systemctl restart ${UNIT}`
}

async function status(ctx) {
  const found = await probe()
  const restart = found.kind === 'ok' ? found.restart : found.kind === 'absent' ? '（unit 不存在）' : '（systemctl 不可用）'
  const info = UNIT === null ? '（非 systemd 托管）'
    : await show(['MainPID', 'ActiveEnterTimestamp'])
      .then(props => `MainPID=${props.MainPID}，启动于 ${props.ActiveEnterTimestamp}`)
      .catch(() => '（读取失败）')
  return `unit=${UNIT} Restart=${restart}；运行中代理=${running(ctx).length}\n${info}`
}

// 退出：先让 handler 结果与 command/done 落盘（800ms），再 appExit(0)。
// dispose 成功后 appExit 只设 exitCode，事件循环没排空进程就不退出；
// 9s 兜底（unref，不阻止正常排空）覆盖这一种情况，与 DSH 自己的 5s dispose 期限互补。
// 兜底先挂再退出：不依赖 exit() 的内部实现是否同步返回。
function scheduleRestart(ctx) {
  const exit = ctx.get('appExit')
  if (exit === undefined) return false
  setTimeout(() => {
    const watchdog = setTimeout(() => process.exit(0), 9000)
    watchdog.unref()
    exit(0)
  }, 800)
  return true
}

const REASON = { 'host-module': '宿主模块', 'unmanaged-plugin': '未托管插件', 'module-comparison': '无法比对' }

function formatReload(r) {
  const parts = []
  if (r.warnings.length > 0) parts.push(`${r.warnings.length} 条警告：\n${r.warnings.join('\n')}`)
  if (r.pending.length > 0) {
    const reasons = [...new Set(r.pending.map(p => REASON[p.reason] ?? p.reason))].join('、')
    parts.push(`${r.pending.length} 个模块保持旧代码，重启进程后才生效（${reasons}）。`)
  }
  if (r.restartReason !== undefined) parts.push(`有改动需整体重启才生效（${r.restartReason}），请用 /restart。`)
  return parts.length > 0 ? parts.join('\n') : '已重新读取 profile，没有需要应用的改动。'
}

export function apply(ctx) {
  // check：菜单首击与 composer 共用。首行判词是 §5.3 VERDICT 的契约，第二行起是短说明。
  async function check() {
    const found = await probe()
    if (!ready(found)) return { kind: 'error', text: `${VERDICT.blocked}\n${shortReason(found)}` }
    const n = running(ctx).length
    if (n > 0) return { kind: 'success', text: `${VERDICT.busy}\n${n} 个代理正在运行，重启会中断它们。` }
    return { kind: 'success', text: `${VERDICT.ok}\nRestart=always，没有代理在运行。` }
  }

  // 注册即 effect：插件卸载/重载时 disposer 自动执行
  ctx.effect(() => ctx.commands.register({
    name: 'restart',
    description: '优雅重启 DSH（重启进程）',
    input: { hint: 'now | check | status' },
    handler: async (invocation) => {
      try {
        const arg = invocation.rawInput.trim()
        if (arg === 'check') return await check()
        if (arg === 'status') return { kind: 'success', text: await status(ctx) }
        // 白名单：拼错的子命令不能落到重启路径上（REVIEW-3 §2.2）
        if (arg !== '' && arg !== 'now') return { kind: 'error', text: '用法：/restart [now | check | status]' }

        const found = await probe()
        if (!ready(found)) return { kind: 'error', text: `${VERDICT.blocked}\n${contractHelp(found)}` }
        const n = running(ctx).length
        if (arg !== 'now' && n > 0) {
          // 首行判词与 check() 一致：客户端二击被拒后可把行切回确认态（REVIEW-3 §2.1）
          return { kind: 'error', text: `${VERDICT.busy}\n${n} 个代理正在运行。确认中断它们请执行 /restart now。` }
        }
        if (!scheduleRestart(ctx)) return { kind: 'error', text: '宿主未提供 appExit，无法退出进程。' }
        return { kind: 'success', text: '正在优雅重启（退出码 0）；约 11–15 秒后页面自动重连。' }
      } catch (error) {
        return { kind: 'error', text: `重启失败：${error?.message ?? error}` }
      }
    },
  }))

  ctx.effect(() => ctx.commands.register({
    name: 'reload',
    description: '重载插件与配置（不重启进程）',
    handler: async () => {
      const hmr = ctx.get('hmr')
      if (hmr === undefined) return { kind: 'error', text: '本进程未启用 HMR（无 profileContext），无法热重载。' }
      try {
        return { kind: 'success', text: formatReload(await hmr.runExclusive(() => hmr.reconcileProfile())) }
      } catch (error) {
        return { kind: 'error', text: `重载失败：${error?.message ?? error}` }
      }
    },
  }))
}
