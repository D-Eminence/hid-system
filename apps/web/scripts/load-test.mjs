#!/usr/bin/env node

import { Agent as HttpAgent, request as httpRequest } from 'node:http'
import { Agent as HttpsAgent, request as httpsRequest } from 'node:https'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'

const DEFAULT_PATHS = ['/', '/patient', '/hospital/auth', '/eminence/login']
const httpAgent = new HttpAgent({ keepAlive: true })
const httpsAgent = new HttpsAgent({ keepAlive: true })

function parseNumber(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function parseArgs(argv) {
  const args = {
    base: 'https://healthidentitydirectory.com',
    concurrency: 50,
    durationSeconds: 30,
    paths: [...DEFAULT_PATHS],
    timeoutMs: 15000,
    warmupSeconds: 5,
  }

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index]
    const next = argv[index + 1]

    if ((current === '--base' || current === '-b') && next) {
      args.base = next
      index += 1
      continue
    }

    if ((current === '--concurrency' || current === '-c') && next) {
      args.concurrency = parseNumber(next, args.concurrency)
      index += 1
      continue
    }

    if ((current === '--duration' || current === '-d') && next) {
      args.durationSeconds = parseNumber(next, args.durationSeconds)
      index += 1
      continue
    }

    if ((current === '--warmup' || current === '-w') && next) {
      args.warmupSeconds = parseNumber(next, args.warmupSeconds)
      index += 1
      continue
    }

    if ((current === '--timeout' || current === '-t') && next) {
      args.timeoutMs = parseNumber(next, args.timeoutMs)
      index += 1
      continue
    }

    if (current === '--path' && next) {
      args.paths.push(next)
      index += 1
      continue
    }

    if (current === '--paths' && next) {
      args.paths = next
        .split(',')
        .map(value => value.trim())
        .filter(Boolean)
      index += 1
    }
  }

  if (args.paths.length === 0) {
    args.paths = [...DEFAULT_PATHS]
  }

  return args
}

function createRouteStats() {
  return {
    durations: [],
    errorReasons: new Map(),
    errors: 0,
    ok: 0,
    statuses: new Map(),
    timeouts: 0,
  }
}

function normalizeBase(base) {
  return base.replace(/\/+$/, '')
}

function percentile(sortedDurations, ratio) {
  if (sortedDurations.length === 0) return 0
  const index = Math.min(sortedDurations.length - 1, Math.max(0, Math.ceil(sortedDurations.length * ratio) - 1))
  return sortedDurations[index]
}

function summarize(stats) {
  const durations = [...stats.durations].sort((left, right) => left - right)
  const total = stats.ok + stats.errors
  const sum = durations.reduce((value, current) => value + current, 0)
  const average = durations.length > 0 ? sum / durations.length : 0

  return {
    avgMs: average,
    errorRate: total === 0 ? 0 : (stats.errors / total) * 100,
    errorReasons: [...stats.errorReasons.entries()].sort(([left], [right]) => left.localeCompare(right)),
    ok: stats.ok,
    p50Ms: percentile(durations, 0.5),
    p95Ms: percentile(durations, 0.95),
    p99Ms: percentile(durations, 0.99),
    statuses: [...stats.statuses.entries()].sort(([left], [right]) => left - right),
    timeouts: stats.timeouts,
    total,
  }
}

function printSummary(label, stats) {
  const summary = summarize(stats)
  console.log(`\n${label}`)
  console.log(`  requests: ${summary.total}`)
  console.log(`  ok: ${summary.ok}`)
  console.log(`  errors: ${stats.errors}`)
  console.log(`  timeouts: ${summary.timeouts}`)
  console.log(`  error rate: ${summary.errorRate.toFixed(2)}%`)
  console.log(`  avg: ${summary.avgMs.toFixed(1)}ms`)
  console.log(`  p50: ${summary.p50Ms.toFixed(1)}ms`)
  console.log(`  p95: ${summary.p95Ms.toFixed(1)}ms`)
  console.log(`  p99: ${summary.p99Ms.toFixed(1)}ms`)
  if (summary.statuses.length > 0) {
    console.log(`  statuses: ${summary.statuses.map(([code, count]) => `${code}=${count}`).join(', ')}`)
  }
  if (summary.errorReasons.length > 0) {
    console.log(`  error reasons: ${summary.errorReasons.map(([reason, count]) => `${reason}=${count}`).join(', ')}`)
  }
}

async function timedFetch(url, timeoutMs) {
  const startedAt = performance.now()

  return new Promise(resolve => {
    const target = new URL(url)
    const requestImpl = target.protocol === 'https:' ? httpsRequest : httpRequest
    const request = requestImpl(target, {
      agent: target.protocol === 'https:' ? httpsAgent : httpAgent,
      headers: {
        'cache-control': 'no-cache',
      },
      method: 'GET',
    }, response => {
      response.on('data', () => undefined)
      response.on('end', () => {
        resolve({
          durationMs: performance.now() - startedAt,
          errorReason: null,
          ok: Boolean(response.statusCode && response.statusCode >= 200 && response.statusCode < 400),
          status: response.statusCode ?? 0,
          timedOut: false,
        })
      })
    })

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Request timed out'))
    })

    request.on('error', error => {
      resolve({
        durationMs: performance.now() - startedAt,
        errorReason: error instanceof Error ? (error.code ?? error.message) : 'UNKNOWN_ERROR',
        ok: false,
        status: 0,
        timedOut: error instanceof Error && error.message.toLowerCase().includes('timed out'),
      })
    })

    request.end()
  })
}

async function runPhase({ base, concurrency, durationSeconds, paths, timeoutMs }) {
  const normalizedBase = normalizeBase(base)
  const deadline = Date.now() + durationSeconds * 1000
  const perPathStats = new Map(paths.map(path => [path, createRouteStats()]))
  const totalStats = createRouteStats()

  const workers = Array.from({ length: concurrency }, (_, workerIndex) => (async () => {
    let iteration = workerIndex

    while (Date.now() < deadline) {
      const path = paths[iteration % paths.length]
      const url = `${normalizedBase}${path.startsWith('/') ? path : `/${path}`}`
      const result = await timedFetch(url, timeoutMs)
      const stats = perPathStats.get(path)

      if (!stats) {
        iteration += 1
        continue
      }

      stats.durations.push(result.durationMs)
      totalStats.durations.push(result.durationMs)

      if (result.ok) {
        stats.ok += 1
        totalStats.ok += 1
      } else {
        stats.errors += 1
        totalStats.errors += 1
        if (result.errorReason) {
          stats.errorReasons.set(result.errorReason, (stats.errorReasons.get(result.errorReason) ?? 0) + 1)
          totalStats.errorReasons.set(result.errorReason, (totalStats.errorReasons.get(result.errorReason) ?? 0) + 1)
        }
      }

      if (result.timedOut) {
        stats.timeouts += 1
        totalStats.timeouts += 1
      }

      const currentStatusCount = stats.statuses.get(result.status) ?? 0
      stats.statuses.set(result.status, currentStatusCount + 1)
      totalStats.statuses.set(result.status, (totalStats.statuses.get(result.status) ?? 0) + 1)
      iteration += 1
    }
  })())

  await Promise.all(workers)

  return {
    perPathStats,
    totalStats,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))

  console.log('HID load test')
  console.log(`  base: ${args.base}`)
  console.log(`  concurrency: ${args.concurrency}`)
  console.log(`  warmup: ${args.warmupSeconds}s`)
  console.log(`  duration: ${args.durationSeconds}s`)
  console.log(`  timeout: ${args.timeoutMs}ms`)
  console.log(`  paths: ${args.paths.join(', ')}`)

  if (args.warmupSeconds > 0) {
    console.log('\nWarmup phase...')
    await runPhase({
      base: args.base,
      concurrency: Math.max(1, Math.min(args.concurrency, 10)),
      durationSeconds: args.warmupSeconds,
      paths: args.paths,
      timeoutMs: args.timeoutMs,
    })
    await delay(250)
  }

  console.log('\nMeasured phase...')
  const result = await runPhase({
    base: args.base,
    concurrency: args.concurrency,
    durationSeconds: args.durationSeconds,
    paths: args.paths,
    timeoutMs: args.timeoutMs,
  })

  printSummary('Overall', result.totalStats)

  for (const path of args.paths) {
    const stats = result.perPathStats.get(path)
    if (!stats) continue
    printSummary(`Route ${path}`, stats)
  }
}

await main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
