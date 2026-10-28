/**
 * Real-engine smoke test: the wire contract, against whatever engine is running.
 *
 * The unit and browser suites use stubs and the in-process engine, so an engine that
 * silently changes shape — a renamed capability, an aggregation that stops being
 * advertised, a filter that stops filtering, division by zero returning 0 — can pass
 * every check Plateau owns and still break every real connection. This script is the
 * cheap counterweight: read-only requests, no writes, no fixtures, run it against the
 * live engine after any engine change.
 *
 * It deliberately SKIPS rather than fails when the engine requires authentication and
 * no credentials were supplied (set PLATEAU_ENGINE_USER / PLATEAU_ENGINE_PASSWORD to
 * run the protected checks). A skip is not a pass; the summary says so.
 *
 * Run:  node scripts/verify-engine.mjs [engineUrl]
 * Exit: 0 all checks passed (skips allowed), 1 a wire check failed, 2 engine unreachable.
 */

const ENGINE_URL = (process.argv[2] ?? process.env.PLATEAU_ENGINE_URL ?? 'http://127.0.0.1:8080').replace(
  /\/+$/,
  '',
);
const USER = process.env.PLATEAU_ENGINE_USER;
const PASSWORD = process.env.PLATEAU_ENGINE_PASSWORD;
const PROTOCOL_VERSION = 1;

let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function check(name, ok, detail = '') {
  if (ok) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ''}`);
  }
}

function skip(name, reason) {
  skipped++;
  console.log(`  SKIP  ${name} -- ${reason}`);
}

function section(title) {
  console.log(`\n${title}`);
}

let token = null;

async function request(path, init = {}) {
  const headers = { ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${ENGINE_URL}${path}`, { ...init, headers });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: response.status, body };
}

const query = (dataset, body) =>
  request(`/v1/${encodeURIComponent(dataset)}/query`, {
    method: 'POST',
    body: JSON.stringify({
      dataset,
      protocolVersion: PROTOCOL_VERSION,
      groupBy: [],
      measures: [],
      filters: [],
      ...body,
    }),
  });

/** The protocol's column kind; older catalog shapes called it `suggestedKind`. */
const kindOf = (column) => column.kind ?? column.suggestedKind;

function dimOf(catalog) {
  return catalog.columns.find(
    (column) =>
      kindOf(column) === 'dimension' &&
      (column.dataType === 'string' || column.dataType === 'boolean'),
  );
}

function measureOf(catalog) {
  return catalog.columns.find(
    (column) => kindOf(column) === 'measure' && column.dataType === 'number',
  );
}

async function main() {
  console.log(`Engine smoke test: ${ENGINE_URL}`);

  // ------------------------------------------------------------ reachability ---
  section('Reachability and public capabilities');
  let capabilities;
  try {
    const response = await request('/v1/capabilities');
    capabilities = response.body;
    check('the engine answers GET /v1/capabilities', response.status === 200,
      `status ${response.status}`);
  } catch (error) {
    console.log(`\n  Engine unreachable: ${error.message}`);
    console.log('\n0 passed, 0 failed, 0 skipped (unreachable)');
    process.exitCode = 2;
    return;
  }

  check('it reports a numeric protocolVersion',
    typeof capabilities?.protocolVersion === 'number',
    JSON.stringify(capabilities?.protocolVersion));
  check('the protocol version is one this client speaks',
    capabilities?.protocolVersion === PROTOCOL_VERSION,
    `engine ${capabilities?.protocolVersion}, client ${PROTOCOL_VERSION}`);
  check('aggregations are advertised',
    Array.isArray(capabilities?.aggregations) && capabilities.aggregations.length > 0,
    JSON.stringify(capabilities?.aggregations));
  check('SUM is among the advertised aggregations',
    Array.isArray(capabilities?.aggregations) &&
      capabilities.aggregations.map((a) => String(a).toUpperCase()).includes('SUM'),
    JSON.stringify(capabilities?.aggregations));
  check('filter operators are advertised',
    Array.isArray(capabilities?.filterOperators) && capabilities.filterOperators.length > 0,
    JSON.stringify(capabilities?.filterOperators));
  check('a positive row cap is advertised',
    typeof capabilities?.maxRows === 'number' && capabilities.maxRows > 0,
    JSON.stringify(capabilities?.maxRows));
  check('expressionFunctions is a list (possibly empty)',
    Array.isArray(capabilities?.expressionFunctions),
    JSON.stringify(capabilities?.expressionFunctions));
  console.log(
    `  engine: protocol ${capabilities?.protocolVersion}, ` +
      `${capabilities?.aggregations?.length ?? 0} aggregations, ` +
      `${capabilities?.filterOperators?.length ?? 0} filter operators, ` +
      `maxRows ${capabilities?.maxRows}`,
  );

  // ------------------------------------------------------------ authentication ---
  const authRequired = capabilities?.authRequired === true;
  console.log(`  authRequired: ${authRequired}`);

  if (authRequired) {
    section('Authentication');
    const anonymous = await request('/v1/datasets');
    check('protected routes answer 401 without a token', anonymous.status === 401,
      `status ${anonymous.status}`);
    check('the 401 body carries code "unauthorized"',
      anonymous.body?.code === 'unauthorized', JSON.stringify(anonymous.body));

    if (!USER || !PASSWORD) {
      skip('login and protected checks', 'set PLATEAU_ENGINE_USER / PLATEAU_ENGINE_PASSWORD');
      console.log('\n' + summary());
      return;
    }

    const login = await request('/v1/login', {
      method: 'POST',
      body: JSON.stringify({ user: USER, password: PASSWORD }),
    });
    check('POST /v1/login succeeds with the supplied credentials', login.status === 200,
      `status ${login.status} ${JSON.stringify(login.body?.code ?? login.body?.error ?? '')}`);
    token = typeof login.body?.token === 'string' ? login.body.token : null;
    check('login returns a token', Boolean(token));
    check('login expiresAt is a Unix timestamp in seconds',
      typeof login.body?.expiresAt === 'number' &&
        login.body.expiresAt > 1_000_000_000 &&
        login.body.expiresAt < 10_000_000_000,
      JSON.stringify(login.body?.expiresAt));
    check('login reports roles as a list', Array.isArray(login.body?.roles),
      JSON.stringify(login.body?.roles));
    if (!token) {
      console.log('\n' + summary());
      process.exitCode = 1;
      return;
    }
  }

  // --------------------------------------------------------------- discovery ---
  section('Dataset discovery');
  const listing = await request('/v1/datasets');
  check('GET /v1/datasets succeeds', listing.status === 200, `status ${listing.status}`);
  const names = Array.isArray(listing.body?.datasets) ? listing.body.datasets : [];
  check('it lists at least one dataset', names.length > 0, JSON.stringify(names));
  const candidates = [
    ...(names.includes('Sales') ? ['Sales'] : []),
    ...names.filter((name) => name !== 'Sales' && !String(name).startsWith('#')),
  ];
  check('it lists a non-system cube to test against', candidates.length > 0,
    JSON.stringify(names));

  // ---------------------------------------------------------------- describe ---
  section('Describe');
  let dataset = null;
  let catalog = null;
  for (const name of candidates) {
    const response = await request(`/v1/${encodeURIComponent(name)}`);
    if (response.status !== 200) continue;
    const body = response.body;
    /*
     * A useful test cube has data. Some seeded cubes (CostCentre) exist to model a
     * hierarchy and carry no cells; choosing one would make every query check fail
     * for a reason that has nothing to do with the wire. A measure-less cube's
     * numeric `value` cell or a measure cube's measure dimension both count as a
     * numeric measure.
     */
    const numeric = body.columns.some((column) => column.dataType === 'number');
    if (dimOf(body) && numeric && (body.rowCount ?? 0) > 0) {
      dataset = name;
      catalog = body;
      break;
    }
  }
  check('a non-empty cube with a string dimension and a numeric measure is describable',
    Boolean(dataset),
    `tried ${JSON.stringify(candidates.slice(0, 5))}`);
  if (!dataset) {
    console.log('\n' + summary());
    process.exitCode = failed > 0 ? 1 : 0;
    return;
  }
  console.log(`  dataset: ${dataset} (${catalog.rowCount?.toLocaleString?.() ?? '?'} rows)`);

  const dimension = dimOf(catalog);
  const numericColumn = catalog.columns.find((column) => column.dataType === 'number');
  /*
   * Contract §5.3: `value` names the stored cell on a measure-less cube and expands
   * to ALL measures on a cube with a measure dimension. That makes it the one
   * generic name a smoke test can use without knowing the cube's measure members.
   * An expression AST needs a real field reference, which exists for the
   * measure-less `value` cell — so expression checks run only there.
   */
  const measureName = 'value';
  const expressionField = catalog.measureDimension ? null : 'value';
  console.log(`  dimension: ${dimension.name} (${dimension.dataType})`);
  console.log(`  measure: ${measureName} (via ${numericColumn?.name ?? '?'})`);
  console.log(`  measureDimension: ${catalog.measureDimension ?? 'none'}`);

  check('the catalog carries a row count', typeof catalog.rowCount === 'number',
    JSON.stringify(catalog.rowCount));
  check('every column declares a name, kind and dataType',
    catalog.columns.every(
      (column) =>
        typeof column.name === 'string' &&
        (kindOf(column) === 'dimension' || kindOf(column) === 'measure') &&
        typeof column.dataType === 'string',
    ),
    JSON.stringify(catalog.columns.slice(0, 3)));

  // ------------------------------------------------------------------ query ---
  section('Query');
  const base = await query(dataset, {
    groupBy: [{ name: dimension.name }],
    measures: [{ name: measureName, aggregation: 'SUM' }],
  });
  check('a grouped SUM query succeeds', base.status === 200,
    `status ${base.status} ${JSON.stringify(base.body?.code ?? base.body?.error ?? '')}`);
  const rows = Array.isArray(base.body?.rows) ? base.body.rows : [];
  check('it returns at least one group', rows.length > 0, `${rows.length} row(s)`);
  check('the header names the dimension and at least one measure column',
    Array.isArray(base.body?.columns) &&
      (base.body.columns[0] === dimension.name ||
        base.body.columns.includes(dimension.name)) &&
      base.body.columns.length >= 2,
    JSON.stringify(base.body?.columns));
  check('every row has one cell per column',
    rows.every((row) => Array.isArray(row) && row.length === (base.body?.columns?.length ?? -1)),
    `${rows[0]?.length} cells vs ${base.body?.columns?.length} columns`);
  check('SUM returns a number (or null) per group',
    rows.every((row) => {
      const value = row[row.length - 1];
      return value === null || typeof value === 'number';
    }),
    JSON.stringify(rows.slice(0, 2)));

  const dimensionIndex = base.body?.columns?.indexOf(dimension.name) ?? -1;
  const firstMember = dimensionIndex >= 0 ? rows[0]?.[dimensionIndex] : null;
  check('the dimension cell is present', firstMember !== null && firstMember !== undefined,
    JSON.stringify(firstMember));

  if (firstMember === null || firstMember === undefined) {
    skip('dimension filter check', 'the query returned no dimension cell to filter on');
  } else {
    const filtered = await query(dataset, {
      groupBy: [{ name: dimension.name }],
      measures: [{ name: measureName, aggregation: 'SUM' }],
      filters: [
        {
          field: dimension.name,
          scope: 'dimension',
          operator: 'in',
          values: [firstMember],
        },
      ],
    });
    check('a dimension `in` filter is accepted', filtered.status === 200,
      `status ${filtered.status} ${JSON.stringify(filtered.body?.code ?? '')}`);
    check('the filter actually filters every returned group',
      (filtered.body?.rows ?? []).length > 0 &&
        (filtered.body?.rows ?? []).every((row) => row[dimensionIndex] === firstMember),
      JSON.stringify((filtered.body?.rows ?? []).slice(0, 3)));
  }

  const limited = await query(dataset, {
    groupBy: [{ name: dimension.name }],
    measures: [{ name: measureName, aggregation: 'SUM' }],
    limit: 2,
  });
  check('a limit of 2 is honoured', limited.status === 200 &&
    (limited.body?.rows ?? []).length <= 2,
  `${(limited.body?.rows ?? []).length} row(s)`);

  // -------------------------------------------------------------- contract ---
  section('Contract errors and expression semantics');
  const badDataset = await request('/v1/ThisCubeDoesNotExist');
  check('an unknown cube is refused with 4xx', badDataset.status >= 400 && badDataset.status < 500,
    `status ${badDataset.status}`);
  const badField = await query(dataset, {
    groupBy: [],
    measures: [{ name: 'Definitely Not A Column', aggregation: 'SUM' }],
  });
  check('an unknown field is refused with 4xx', badField.status >= 400 && badField.status < 500,
    `status ${badField.status} ${JSON.stringify(badField.body?.code ?? '')}`);

  const sumExpression = {
    type: 'call',
    name: 'SUM',
    args: [{ type: 'field', name: expressionField ?? 'value' }],
  };

  if (!expressionField) {
    skip(
      'expression semantics',
      'the chosen cube has a measure dimension, so a field reference needs its member names',
    );
  } else {
    const expressionQuery = await query(dataset, {
      groupBy: [],
      measures: [{ name: 'wire_sum', expr: sumExpression }],
    });
    const expressionSupported =
      expressionQuery.status === 200 &&
      (expressionQuery.body?.rows ?? []).length === 1 &&
      typeof (expressionQuery.body?.rows ?? [])[0]?.[0] === 'number';
    check('a measure expression AST is evaluated by the engine', expressionSupported,
      `status ${expressionQuery.status} ${JSON.stringify(expressionQuery.body?.rows ?? expressionQuery.body ?? '')}`);

    if (expressionSupported) {
      const divided = await query(dataset, {
        groupBy: [],
        measures: [
          {
            name: 'wire_div_zero',
            expr: {
              type: 'binary',
              op: '/',
              left: sumExpression,
              right: { type: 'number', value: 0 },
            },
          },
        ],
      });
      check('division by zero is null, not zero or an error', divided.status === 200 &&
        (divided.body?.rows ?? []).some((row) => row[0] === null),
      `status ${divided.status} ${JSON.stringify(divided.body?.rows ?? divided.body?.code ?? '')}`);
    } else {
      skip('expression semantics', 'the engine did not evaluate a SUM expression');
    }
  }

  console.log('\n' + summary());
}

function summary() {
  return `${passed} passed, ${failed} failed, ${skipped} skipped`;
}

try {
  await main();
  process.exitCode = failed > 0 ? 1 : 0;
} catch (error) {
  console.error(`\nHarness error: ${error.message}`);
  process.exitCode = 2;
}
