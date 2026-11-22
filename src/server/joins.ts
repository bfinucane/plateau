/**
 * Validation for a dataset's attribute-join selection.
 *
 * The join editor talks to `/api/datasets/:id/joins`, which must not trust the
 * browser: the route is reachable directly and a bad selection would otherwise
 * register and fail on every sheet. This module owns the checks shared by
 * registration and the post-connect edit path.
 */

import {
  PROTOCOL_VERSION,
  type Capabilities,
  type EngineTransport,
  type JoinRequest,
} from '../core/protocol.js';

export class JoinSelectionError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(
    message: string,
    code = 'invalid_argument',
    status = 400,
  ) {
    super(message);
    this.name = 'JoinSelectionError';
    this.code = code;
    this.status = status;
  }
}

export interface RawJoinSelection {
  cube?: string;
  using?: string;
  attributes?: string[];
}

export interface PrimaryCatalogShape {
  columns: { name: string }[];
}

/**
 * Validates and normalises a join selection.
 *
 * One join per primary dimension. An empty selection clears the joins; a
 * selected cube with no attributes is ignored. The engine is the final
 * authority, but these checks catch the mistakes a user can actually make
 * before a query is attempted.
 */
export async function prepareJoins(
  transport: EngineTransport,
  primary: string,
  primaryCatalog: PrimaryCatalogShape,
  rawJoins: RawJoinSelection[],
  capabilities: Capabilities,
): Promise<JoinRequest[]> {
  if (rawJoins.length === 0) return [];
  if (!capabilities.supportsJoin) {
    throw new JoinSelectionError(
      'This engine does not support joins, so attributes cannot be attached.',
      'unsupported_join',
    );
  }

  const maxJoins = capabilities.maxJoins ?? 1;
  if (rawJoins.length > maxJoins) {
    throw new JoinSelectionError(
      `This engine accepts at most ${maxJoins} attribute join(s), but ${rawJoins.length} were selected.`,
      'unsupported_join',
    );
  }

  const primaryNames = new Set(primaryCatalog.columns.map((column) => column.name));
  const seenKeys = new Set<string>();
  const seenCubes = new Set<string>();
  /**
   * Attribute member name -> the attribute cubes that select it.
   *
   * A member name may repeat across attribute cubes: identity is `(cube, member)`,
   * so `MonthAttr.name_zh` and `CountryAttr.name_zh` are different fields. The
   * output column names would collide, though, which is what the optional wire
   * `aliases` exist to fix. On an engine without `supportsJoinAlias` the collision
   * cannot be resolved, so it stays a refusal.
   */
  const attributeOwners = new Map<string, string[]>();
  const aliasesSupported = capabilities.supportsJoinAlias === true;
  const joins: JoinRequest[] = [];

  for (const raw of rawJoins) {
    const cube = raw.cube?.trim();
    if (!cube) throw new JoinSelectionError('Every join needs an attribute cube.');
    if (seenCubes.has(cube.toLowerCase())) {
      throw new JoinSelectionError(`"${cube}" is selected more than once.`, 'invalid_join');
    }
    seenCubes.add(cube.toLowerCase());

    const joinedCatalog = await transport.describe(cube);
    if (!joinedCatalog.isAttributeTable || !joinedCatalog.measureDimension) {
      throw new JoinSelectionError(
        `"${cube}" is not an attribute table; joins may only attach attribute cubes.`,
        'invalid_join',
      );
    }

    let using = raw.using?.trim();
    if (!using) {
      const shared = joinedCatalog.columns
        .map((column) => column.name)
        .filter((name) => primaryNames.has(name));
      if (shared.length !== 1) {
        throw new JoinSelectionError(
          `Cannot infer how to join "${cube}": it shares ${shared.length} dimension(s) with ${primary}. Choose a key.`,
          'invalid_join_key',
        );
      }
      using = shared[0];
    }
    if (!primaryNames.has(using)) {
      throw new JoinSelectionError(
        `"${using}" is not a dimension of ${primary}, so it cannot be a join key.`,
        'invalid_join_key',
      );
    }
    if (!joinedCatalog.columns.some((column) => column.name === using)) {
      throw new JoinSelectionError(
        `"${using}" is not a conformed dimension: it must exist in both ${primary} and ${cube}.`,
        'invalid_join_key',
      );
    }
    if (seenKeys.has(using.toLowerCase())) {
      throw new JoinSelectionError(
        `More than one join uses "${using}". Use one attribute cube per dimension.`,
        'invalid_join_key',
      );
    }
    seenKeys.add(using.toLowerCase());

    const attributes = [
      ...new Set(
        (Array.isArray(raw.attributes) ? raw.attributes : [])
          .map((name) => name.trim())
          .filter(Boolean),
      ),
    ];
    if (attributes.length === 0) continue;

    let members: string[] = [];
    try {
      const domain = await transport.query({
        dataset: cube,
        protocolVersion: PROTOCOL_VERSION,
        groupBy: [],
        measures: [],
        filters: [],
        domainFor: [joinedCatalog.measureDimension],
      });
      members = (domain.domain[joinedCatalog.measureDimension] ?? []).map(String);
    } catch {
      throw new JoinSelectionError(`Could not read the attributes of "${cube}".`, 'invalid_join');
    }

    for (const attribute of attributes) {
      if (!members.includes(attribute)) {
        throw new JoinSelectionError(
          `"${attribute}" is not an attribute of "${cube}".`,
          'invalid_attribute',
        );
      }
      if (primaryNames.has(attribute) && !aliasesSupported) {
        throw new JoinSelectionError(
          `Attribute "${attribute}" collides with a column of ${primary}, and this engine does not support join output aliases (capabilities.supportsJoinAlias).`,
          'invalid_attribute',
        );
      }
      const owners = attributeOwners.get(attribute) ?? [];
      owners.push(cube);
      attributeOwners.set(attribute, owners);
    }

    joins.push({ cube, using, attributes });
  }

  const duplicateMembers = [...attributeOwners].filter(
    ([, cubes]) => new Set(cubes).size > 1,
  );
  if (duplicateMembers.length > 0 && !aliasesSupported) {
    const named = duplicateMembers
      .map(([attribute, cubes]) => `"${attribute}" (${cubes.join(', ')})`)
      .join('; ');
    throw new JoinSelectionError(
      `Attribute ${named} is selected from more than one attribute cube, so the output ` +
        'columns would collide. This engine does not support join output aliases ' +
        '(capabilities.supportsJoinAlias): rename one attribute in the model, or use an ' +
        'engine that supports aliases.',
      'unsupported_join',
    );
  }

  return joins;
}
