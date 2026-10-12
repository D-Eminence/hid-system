// Shared by the Phase 4 Stage 9 runtime verifiers of the Pharmacy, Lab, OCR
// and Outreach APIs (services/<service>/scripts/verify-*-runtime.mjs). Each
// verifier runs its service's real AppModule (guards, controllers, services,
// DatabaseService, audit) over HTTP, with every database connection starting
// as the service's runtime role, on a disposable copy of the owned synthetic
// rehearsal database. Only the other HID services are replaced, by local HTTP
// fakes. Dependency-free: each verifier passes its own service's `require`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { join } from 'node:path';

/** Refuses to run anywhere but the rehearsal's private, socket-only cluster. */
export function rehearsalDatabase() {
  const socket = process.env.PGHOST;
  assert(process.env.NODE_ENV === 'test' && socket?.startsWith('/tmp/hid-tuf-migration.')
    && process.env.PGDATABASE === 'hid_rehearsal' && process.env.PGUSER,
  'Only the owned synthetic rehearsal is supported');
  return { socket, admin: process.env.PGUSER, template: process.env.PGDATABASE };
}

const SERVICE_APPLICATION = 'hid-runtime-verifier-service';

/**
 * A copy of the rehearsal database, dropped by close(). The copy needs the
 * rehearsal database to have no other session, so the verifiers run one at a
 * time. `url(role)` connects as the admin and starts every session as `role`
 * (the libpq startup option), as a login of that role would.
 */
export async function disposableDatabase(require, label) {
  const { Client, Pool } = require('pg');
  const { socket, admin, template } = rehearsalDatabase();
  const name = `${template}_${label}_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
  assert(/^hid_[a-z0-9_]+$/.test(name));
  const maintenance = new Client({ host: socket, user: admin, database: 'postgres' });
  await maintenance.connect();
  await maintenance.query(`create database ${name} template ${template}`);
  const owner = new Pool({ host: socket, user: admin, database: name, max: 4 });
  owner.on('error', () => undefined);
  return {
    name, owner,
    url: (role) => `postgresql://${encodeURIComponent(admin)}@localhost/${name}?host=${encodeURIComponent(socket)}`
      + `&application_name=${SERVICE_APPLICATION}&options=${encodeURIComponent(`-c role=${role}`)}`,
    /**
     * Deadlocks PostgreSQL detected in the copy. Call it after the service has
     * closed: each connection flushes its statistics as it exits. A command the
     * service retried after a deadlock still counts.
     */
    deadlocks: async () => {
      for (let waited = 0; ; waited += 100) {
        const open = await owner.query(`select count(*)::int as count from pg_stat_activity
          where datname = current_database() and application_name = $1`, [SERVICE_APPLICATION]);
        if (open.rows[0].count === 0) break;
        assert(waited < 10_000, 'the service connections did not close');
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return Number((await owner.query('select deadlocks from pg_stat_database where datname = current_database()')).rows[0].deadlocks);
    },
    /** Runs fixture SQL as the owner in one transaction, triggers and foreign keys off as in the SQL suites. */
    fixture: async (build) => {
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local session_replication_role = replica');
        const result = await build(client);
        await client.query('commit');
        return result;
      } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
    },
    count: async (sql, values = []) => Number((await owner.query(sql, values)).rows[0].count),
    close: async () => {
      await owner.end();
      await maintenance.query(`drop database if exists ${name} with (force)`);
      await maintenance.end();
    },
  };
}

/** A local HTTP server standing in for other HID services; `route` returns [status, body]. */
export async function fakeService(route) {
  const calls = [];
  const server = createServer((request, response) => {
    let text = '';
    request.on('data', (chunk) => { text += chunk; });
    request.on('end', async () => {
      const call = { method: request.method, path: request.url, headers: request.headers,
        body: text ? JSON.parse(text) : undefined };
      calls.push(call);
      try {
        const [status, body] = await route(call);
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      } catch (error) {
        response.writeHead(500, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ code: 'FAKE_SERVICE_ERROR', detail: String(error) }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { url: `http://127.0.0.1:${server.address().port}`, calls,
    close: () => new Promise((resolve) => server.close(resolve)) };
}

/**
 * Loads the service's real AppModule with ts-node and serves it on 127.0.0.1
 * with its main.ts request pipeline (global prefix, cookie and JSON body
 * parsers, validation pipe, problem filter). CORS and helmet only set response
 * headers for browsers and are left out. The problem filter is wrapped to
 * record the exception behind each 5xx, matched by correlation id, so the
 * verifier can name the SQLSTATE.
 */
export async function startService({ require, service, bodyLimit = 512 * 1024 }) {
  require('ts-node').register({ project: join(service, 'tsconfig.json'), transpileOnly: true });
  require('reflect-metadata');
  const load = (path) => require(join(service, 'src', path));
  const { Test } = require('@nestjs/testing');
  const { ValidationPipe } = require('@nestjs/common');
  const { AppModule } = load('app.module.ts');
  const { DatabaseService } = load('database/database.service.ts');
  const { DomainProblem, ProblemDetailsFilter } = load('common/problem.ts');
  const { preventResponseCaching } = load('common/response-security.middleware.ts');
  const failures = new Map();
  class RecordingProblemFilter extends ProblemDetailsFilter {
    catch(exception, host) {
      const request = host.switchToHttp().getRequest();
      if (!(exception instanceof DomainProblem)) {
        failures.set(request.correlationId, { sqlstate: exception?.code, message: exception?.message });
      }
      return super.catch(exception, host);
    }
  }
  const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
  const app = module.createNestApplication({ bodyParser: false, logger: false });
  app.setGlobalPrefix('api/v1');
  app.use(preventResponseCaching);
  app.use(require('cookie-parser')());
  app.useBodyParser('json', { limit: bodyLimit, strict: true, type: ['application/json', 'application/*+json'] });
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, forbidUnknownValues: true,
    transform: true, transformOptions: { enableImplicitConversion: false }, stopAtFirstError: false,
    exceptionFactory: (errors) => new DomainProblem(400, 'VALIDATION_FAILED', 'One or more request fields are invalid.',
      errors.map((error) => ({ field: error.property, messages: Object.values(error.constraints ?? {}) }))) }));
  app.useGlobalFilters(new RecordingProblemFilter());
  await app.listen(0, '127.0.0.1');
  const database = module.get(DatabaseService);
  const base = `http://127.0.0.1:${app.getHttpServer().address().port}/api/v1`;
  /** One HTTP request; returns status, body and, for a 5xx, the SQLSTATE behind it. */
  const request = async (method, path, { headers = {}, body, correlationId = `verifier-${randomUUID()}` } = {}) => {
    const response = await fetch(`${base}${path}`, { method,
      headers: { 'content-type': 'application/json', 'x-correlation-id': correlationId, ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    const failure = failures.get(correlationId);
    return { status: response.status, body: payload, correlationId, ...(failure ?? {}) };
  };
  return { app, module, database, request, close: () => app.close() };
}

/** Asserts a response status, naming the SQLSTATE of an unexpected 5xx. */
export function expectStatus(response, status, label) {
  assert.equal(response.status, status, `${label}: expected ${status}, got ${response.status}`
    + ` ${JSON.stringify({ code: response.body?.code, sqlstate: response.sqlstate, message: response.message })}`);
  return response.body;
}
