/**
 * Engine authentication: login, bearer tokens, and the 401 signal.
 *
 * Three things are load-bearing and worth pinning:
 *
 *   1. **Capabilities is public.** It is how a client discovers `authRequired`, so
 *      it must work without a token — a protected capabilities route would hide the
 *      answer exactly when it matters.
 *   2. **The token is attached per request, not per transport.** A dataset
 *      registered before a re-login must start sending the new token without being
 *      rebuilt; that only works if the transport asks a provider each time.
 *   3. **A dead session is forgotten, not retried.** An expired token must produce
 *      one honest 401, not a loop.
 *
 * No real socket is mocked here: the tests run against a loopback HTTP server with a
 * token check, because the parts that matter (header shape, 401 decoding) only exist
 * over the wire.
 */

import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ProtocolError } from '../../core/protocol.js';
import { HttpEngineTransport } from '../httpTransport.js';
import {
  dropSession,
  isAuthenticated,
  loginToEngine,
  resetEngineSessions,
  sessionInfo,
  tokenFor,
} from '../engineAuth.js';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n${title}`);
}

async function rejected(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
}

const VALID_USER = 'alice';
const VALID_PASSWORD = 'correct horse';
const TOKEN = 'a'.repeat(64);
/** Sent as `expiresAt`; well in the future. */
const FUTURE = Math.floor(Date.now() / 1000) + 3600;

interface Recorded {
  method: string;
  url: string;
  authorization: string | undefined;
}

/** A minimal engine that enforces a bearer token on everything but login/capabilities. */
function startAuthEngine(): Promise<{
  server: Server;
  port: number;
  recorded: Recorded[];
  /** Simulates expiry/revocation: every token becomes invalid. */
  revoke: () => void;
}> {
  const recorded: Recorded[] = [];
  let revoked = false;
  const capabilities = {
    protocolVersion: 1,
    aggregations: ['SUM', 'AVG', 'COUNT'],
    countDistinctExact: false,
    filterOperators: ['in', 'equals', 'notEquals'],
    supportsLod: false,
    supportsJoin: true,
    expressionFunctions: ['ZN', 'IFNULL'],
    supportsInlineDomain: true,
    maxRows: 100000,
    authRequired: true,
  };
  const catalog = {
    dataset: 'sales',
    rowCount: 3,
    columns: [
      { name: 'Region', dataType: 'string', cardinality: 3, suggestedKind: 'dimension' },
      { name: 'Sales', dataType: 'number', cardinality: 3, suggestedKind: 'measure' },
    ],
  };

  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      recorded.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
      });
      res.setHeader('Content-Type', 'application/json');

      const url = req.url ?? '';
      if (url === '/v1/capabilities') {
        res.writeHead(200).end(JSON.stringify(capabilities));
        return;
      }
      if (url === '/v1/login') {
        let body: { user?: string; password?: string } = {};
        try {
          body = JSON.parse(raw || '{}');
        } catch {
          body = {};
        }
        if (body.user === VALID_USER && body.password === VALID_PASSWORD) {
          res.writeHead(200).end(
            JSON.stringify({
              token: TOKEN,
              user: VALID_USER,
              roles: ['reader'],
              expiresAt: FUTURE,
            }),
          );
        } else {
          res.writeHead(401).end(
            JSON.stringify({ error: 'Invalid user name or password.', code: 'unauthorized' }),
          );
        }
        return;
      }

      if (req.headers.authorization !== `Bearer ${TOKEN}` || revoked) {
        res.writeHead(401).end(
          JSON.stringify({
            error: 'Authentication required. POST /v1/login to obtain a bearer token.',
            code: 'unauthorized',
          }),
        );
        return;
      }

      if (url === '/v1/datasets') {
        res.writeHead(200).end(JSON.stringify({ datasets: ['sales'] }));
        return;
      }
      if (url === '/v1/sales') {
        res.writeHead(200).end(JSON.stringify(catalog));
        return;
      }
      res.writeHead(200).end(JSON.stringify(catalog));
    });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        server,
        port: (server.address() as AddressInfo).port,
        recorded,
        revoke: () => {
          revoked = true;
        },
      });
    });
  });
}

async function main(): Promise<void> {
  resetEngineSessions();

  // ------------------------------------------------------ public capabilities ---
  section('Capabilities is public, so a client can discover that auth is needed');
  {
    const { server, port, recorded } = await startAuthEngine();
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      const capabilities = await transport.capabilities();
      check('capabilities answers without a token', capabilities.authRequired === true,
        JSON.stringify(capabilities));
      const request = recorded.find((entry) => entry.url === '/v1/capabilities');
      check('the capabilities request carried no Authorization header',
        request?.authorization === undefined, String(request?.authorization));
    } finally {
      server.close();
    }
  }

  // ---------------------------------------------------- protected until login ---
  section('Protected routes 401 until this process logs in');
  {
    const { server, port, recorded } = await startAuthEngine();
    const transport = new HttpEngineTransport({ baseUrl: `http://127.0.0.1:${port}` });
    try {
      const error = await rejected(() => transport.listDatasets?.());
      check('a protected call is refused with a typed unauthorized',
        error instanceof ProtocolError && error.code === 'unauthorized',
        `${(error as ProtocolError)?.code}: ${error?.message}`);
      const request = recorded.find((entry) => entry.url === '/v1/datasets');
      check('and it carried no token', request?.authorization === undefined);

      check('this process has no session yet', !isAuthenticated(`http://127.0.0.1:${port}`));
      check('tokenFor is undefined without a session',
        tokenFor(`http://127.0.0.1:${port}`) === undefined);
    } finally {
      server.close();
    }
  }

  // -------------------------------------------------------------- login ---
  section('Logging in stores the token server-side and nothing else');
  {
    const { server, port } = await startAuthEngine();
    const url = `http://127.0.0.1:${port}`;
    try {
      const info = await loginToEngine(url, VALID_USER, VALID_PASSWORD);
      check('login reports the user', info.user === VALID_USER, info.user);
      check('and the roles', JSON.stringify(info.roles) === JSON.stringify(['reader']),
        JSON.stringify(info.roles));
      check('and the expiry in SECONDS', info.expiresAt === FUTURE, String(info.expiresAt));
      check('the token is NOT part of the returned info', !('token' in info),
        JSON.stringify(Object.keys(info)));
      check('but the process holds it',
        tokenFor(url) === TOKEN, String(tokenFor(url)?.slice(0, 4)));
      check('and the session reads as live',
        sessionInfo(url)?.user === VALID_USER, JSON.stringify(sessionInfo(url)));

      /*
       * The transport was created BEFORE the login: the token must be resolved per
       * request, or a registered dataset would keep failing after a re-login.
       */
      const transport = new HttpEngineTransport({ baseUrl: url, getToken: () => tokenFor(url) });
      const names = await transport.listDatasets();
      check('a transport built before login now sends the token', JSON.stringify(names) ===
        JSON.stringify(['sales']), JSON.stringify(names));
      const catalog = await transport.describe('sales');
      check('and protected describe works', catalog.rowCount === 3, String(catalog.rowCount));
    } finally {
      server.close();
    }
  }

  section('A wrong password and an unknown user are refused identically');
  {
    const { server, port, recorded } = await startAuthEngine();
    const url = `http://127.0.0.1:${port}`;
    try {
      const wrongPassword = await rejected(() => loginToEngine(url, VALID_USER, 'nope'));
      const unknownUser = await rejected(() => loginToEngine(url, 'bob', VALID_PASSWORD));
      check('a wrong password is a typed unauthorized',
        wrongPassword instanceof ProtocolError && wrongPassword.code === 'unauthorized',
        `${(wrongPassword as ProtocolError)?.code}: ${wrongPassword?.message}`);
      check('an unknown user is too',
        unknownUser instanceof ProtocolError && unknownUser.code === 'unauthorized');
      check('the two messages are identical',
        wrongPassword?.message === unknownUser?.message,
        `${wrongPassword?.message} / ${unknownUser?.message}`);
      check('the engine text is passed through unchanged',
        wrongPassword?.message === 'Invalid user name or password.', wrongPassword?.message);
      check('a failed login leaves no session', !isAuthenticated(url));
      check('the login requests carried no Authorization header',
        recorded.filter((entry) => entry.url === '/v1/login').every((entry) =>
          entry.authorization === undefined));
    } finally {
      server.close();
    }
  }

  section('A 401 drops the session, even when the expiry has not passed');
  {
    // An engine restart or a revoke invalidates the token without changing expiresAt.
    const { server, port, revoke } = await startAuthEngine();
    const url = `http://127.0.0.1:${port}`;
    try {
      await loginToEngine(url, VALID_USER, VALID_PASSWORD);
      check('a session exists before the refusal', isAuthenticated(url));

      const transport = new HttpEngineTransport({
        baseUrl: url,
        getToken: () => tokenFor(url),
        onUnauthorized: () => dropSession(url),
      });
      revoke();

      const error = await rejected(() => transport.describe('sales'));
      check('the refused request is a typed unauthorized',
        error instanceof ProtocolError && error.code === 'unauthorized',
        `${(error as ProtocolError)?.code}: ${error?.message}`);
      check('and the dead token was dropped', !isAuthenticated(url));
      check('so the session endpoint will stop claiming a sign-in',
        sessionInfo(url) === null, JSON.stringify(sessionInfo(url)));
    } finally {
      server.close();
    }
  }

  section('Logout forgets the session, and a dead token is not held');
  {
    const { server, port } = await startAuthEngine();
    const url = `http://127.0.0.1:${port}`;
    try {
      await loginToEngine(url, VALID_USER, VALID_PASSWORD);
      check('a session exists', isAuthenticated(url));
      dropSession(url);
      check('dropping it clears the token', tokenFor(url) === undefined);
      check('and the session info', sessionInfo(url) === null);

      const transport = new HttpEngineTransport({ baseUrl: url, getToken: () => tokenFor(url) });
      const error = await rejected(() => transport.listDatasets());
      check('the next protected call is refused again',
        error instanceof ProtocolError && error.code === 'unauthorized',
        `${(error as ProtocolError)?.code}: ${error?.message}`);
    } finally {
      server.close();
    }
  }

  section('A login without a usable token is an engine failure, not a session');
  {
    // The same loopback server, but the login route lies about its token.
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      if ((req.url ?? '') === '/v1/capabilities') {
        res.writeHead(200).end(JSON.stringify({ protocolVersion: 1, authRequired: true }));
        return;
      }
      res.writeHead(200).end(JSON.stringify({ user: 'alice', roles: ['reader'], expiresAt: FUTURE }));
    });
    const port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port));
    });
    const url = `http://127.0.0.1:${port}`;
    try {
      const error = await rejected(() => loginToEngine(url, VALID_USER, VALID_PASSWORD));
      check('a 200 without a token is refused', error instanceof ProtocolError,
        String(error));
      check('and no session is stored', !isAuthenticated(url));
    } finally {
      server.close();
    }
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  if (failed > 0) process.exitCode = 1;
}

await main();
