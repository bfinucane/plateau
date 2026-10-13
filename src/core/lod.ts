/**
 * Level-of-detail (LOD) expression execution.
 *
 * An LOD computes an aggregate at its *own* grouping and then attaches the
 * result to every source row, so the value is available to the view regardless
 * of how the view itself is grouped. This is the feature that makes
 * "this mark's share of a higher-level total" expressible as a plain formula.
 *
 * ## The three kinds
 *
 *   { FIXED   [Region] : SUM([Sales]) }  group by exactly Region
 *   { INCLUDE [Customer] : SUM([Sales]) }  view dimensions + Customer
 *   { EXCLUDE [Category] : SUM([Sales]) }  view dimensions - Category
 *
 * ## Filter ordering (the part that surprises people)
 *
 * Tableau evaluates LOD expressions partway through the filter pipeline. This
 * module reproduces the consequence that matters in practice:
 *
 *   - **FIXED** is computed over *all* source rows, before dimension filters
 *     run. A FIXED value therefore does **not** respond to a dimension filter.
 *   - **INCLUDE** and **EXCLUDE** are computed over rows that survived the
 *     dimension filters, so they **do** respond to them.
 *
 * Measure filters are applied after aggregation, so no LOD kind sees them.
 * `computeLodValues` takes the row set explicitly so the caller can honour this
 * distinction per spec.
 */

import type { Aggregation, CellValue, ColumnSchema, DataTable } from './types.js';
import { aggregateMany } from './aggregations.js';
import {
  aggregateKeyOf,
  collectAggregateSlots,
  collectFieldReferences,
  collectLodNodes,
  evaluateExpression,
  formulaAst,
  lodFormulaKey,
  type AggregateSlot,
  type AstNode,
  type LodField,
} from './expression.js';
import { findColumn } from './table.js';

export type LodNode = Extract<AstNode, { type: 'lod' }>;
export type LodSpec = LodNode['spec'];

/** Groups of rows, keyed by their dimension values. */
interface LodGroup {
  rows: number[];
}

/** Serialises dimension values into a collision-safe group key. */
function groupKey(values: CellValue[]): string {
  let key = '';
  for (const value of values) {
    if (value === null) key += '\u0000';
    else if (value instanceof Date) key += `d${value.getTime()}`;
    else if (typeof value === 'number') key += `n${value}`;
    else if (typeof value === 'boolean') key += `b${value ? 1 : 0}`;
    else key += `s${value}`;
    key += '\u0001';
  }
  return key;
}

/** Reads a dimension's per-row value, evaluating calculated fields if needed. */
function dimensionValue(table: DataTable, field: string, row: number): CellValue {
  const index = findColumn(table, field);
  if (index === -1) return null;

  const schema = table.schema[index];
  if (schema.isCalculated && schema.formula) {
    try {
      return evaluateExpression(formulaAst(schema.formula), { table, row });
    } catch {
      return null;
    }
  }
  return table.columns[index][row] ?? null;
}

/**
 * Resolves which dimensions an LOD groups by.
 *
 * INCLUDE and EXCLUDE are relative to the view's dimensions, which is why the
 * caller has to supply them. EXCLUDE removes its dimensions from the view's set;
 * when it names none, it groups by the view's dimensions unchanged.
 */
export function resolveLodDimensions(
  node: LodNode,
  viewDimensions: string[],
): string[] {
  const lower = (values: string[]) =>
    values.map((v) => v.trim().toLowerCase());

  const lodDimensions = lower(node.dimensions);
  const viewLower = lower(viewDimensions);

  switch (node.spec) {
    case 'FIXED':
      // Exactly these, ignoring the view entirely.
      return lodDimensions;

    case 'INCLUDE': {
      // The view's dimensions plus these.
      const merged = [...viewLower];
      for (const dimension of lodDimensions) {
        if (!merged.includes(dimension)) merged.push(dimension);
      }
      return merged;
    }

    case 'EXCLUDE': {
      // The view's dimensions minus these.
      if (lodDimensions.length === 0) return viewLower;
      return viewLower.filter((dimension) => !lodDimensions.includes(dimension));
    }

    default:
      return lodDimensions;
  }
}

export interface LodComputationOptions {
  table: DataTable;
  node: LodNode;
  /** Dimensions on the view, needed to resolve INCLUDE and EXCLUDE. */
  viewDimensions: string[];
  /**
   * Rows to compute over. Pass every row for FIXED; pass the rows that survived
   * dimension filters for INCLUDE and EXCLUDE.
   */
  rows: number[];
}

/**
 * Computes one LOD expression, returning a value for every row in the table.
 *
 * Rows outside the supplied set receive null, which is correct: they were
 * filtered out of the view and so have no LOD value in that view's context.
 */
export function computeLodValues(options: LodComputationOptions): LodField {
  const { table, node, viewDimensions, rows } = options;

  const dimensionNames = resolveLodDimensions(node, viewDimensions);

  // Resolve dimension field names back to their canonical spelling so output is
  // stable regardless of how the user typed them.
  const resolvedDimensions = dimensionNames.map((name) => {
    const index = findColumn(table, name);
    return index === -1 ? name : table.schema[index].name;
  });

  // Collect the aggregates the LOD body needs.
  const slots: AggregateSlot[] = collectAggregateSlots(node.expression);

  const values: CellValue[] = new Array(table.rowCount).fill(null);

  // No aggregate in the body means there is nothing to compute at a different
  // level of detail; the expression is row-level and cannot be an LOD.
  if (slots.length === 0) {
    return {
      formula: lodFormulaKey(node),
      name: describeLod(node),
      values,
    };
  }

  const aggregateColumns = slots.map((slot) => {
    const index = findColumn(table, slot.field);
    return index === -1 ? null : table.columns[index];
  });

  // Group the supplied rows by the LOD's dimensions.
  const groups = new Map<string, LodGroup>();

  if (resolvedDimensions.length === 0) {
    // No grouping dimensions: the LOD is a single grand total over the row set.
    groups.set('\u0002', { rows: [...rows] });
  } else {
    for (const row of rows) {
      const key = groupKey(
        resolvedDimensions.map((dimension) => dimensionValue(table, dimension, row)),
      );
      const existing = groups.get(key);
      if (existing) existing.rows.push(row);
      else groups.set(key, { rows: [row] });
    }
  }

  // Evaluate the body once per group, then stamp the result onto each row.
  for (const group of groups.values()) {
    const aggregateValues = new Map<string, CellValue>();

    slots.forEach((slot, i) => {
      const column = aggregateColumns[i];
      let result: CellValue = null;
      if (column) {
        const slice: CellValue[] = new Array(group.rows.length);
        for (let n = 0; n < group.rows.length; n++) slice[n] = column[group.rows[n]] ?? null;
        result = aggregateMany([slot.aggregation], slice)[0];
      }
      aggregateValues.set(slot.key, result);
    });

    // Evaluate the body against the group's aggregate values. The row index is
    // arbitrary because every field inside an aggregate resolves through the
    // slot map rather than by reading a row.
    const representative = group.rows[0] ?? 0;
    let groupValue: CellValue = null;
    try {
      groupValue = evaluateExpression(node.expression, {
        table,
        row: representative,
        resolveAggregate: (_aggregation, field) => {
          for (const slot of slots) {
            if (slot.field.trim().toLowerCase() === field.trim().toLowerCase()) {
              return aggregateValues.get(slot.key);
            }
          }
          return undefined;
        },
      });
    } catch {
      groupValue = null;
    }

    for (const row of group.rows) values[row] = groupValue;
  }

  return {
    formula: lodFormulaKey(node),
    name: describeLod(node),
    values,
  };
}

/**
 * Collects the LODs a formula needs, following references into other calculated
 * fields.
 *
 * This has to be transitive. A formula such as `MAX([RegionTotal])` contains no
 * LOD textually, but `[RegionTotal]` is a calculated field whose formula is
 * `{ FIXED [Region] : SUM([Sales]) }`. If the walk stopped at the top level the
 * LOD would never be computed, and the reference would resolve to nothing.
 *
 * Returns the LOD nodes along with every calculated-field formula encountered,
 * which the caller needs so it can supply a resolver for chains of calculated
 * fields.
 */
export interface LodDependencyScan {
  nodes: Map<string, LodNode>;
  /** Formula text of every calculated field referenced, transitively. */
  formulas: string[];
}

export function scanLodDependencies(ast: AstNode, table: DataTable): LodDependencyScan {
  const nodes = new Map<string, LodNode>();
  const formulas: string[] = [];
  const visitedFormulas = new Set<string>();
  const visitedFields = new Set<string>();

  const visit = (node: AstNode): void => {
    for (const lod of collectLodNodes(node).values()) {
      nodes.set(lodFormulaKey(lod), lod);
    }
    for (const reference of collectFieldReferences(node)) {
      const key = reference.trim().toLowerCase();
      if (visitedFields.has(key)) continue;
      visitedFields.add(key);

      const index = findColumn(table, reference);
      if (index === -1) continue;
      const schema = table.schema[index];
      if (!schema.isCalculated || !schema.formula) continue;
      if (visitedFormulas.has(schema.formula)) continue;
      visitedFormulas.add(schema.formula);
      formulas.push(schema.formula);

      // Recurse into the referenced field's own formula.
      try {
        visit(formulaAst(schema.formula));
      } catch {
        // An unparseable dependency contributes nothing.
      }
    }
  };

  visit(ast);
  return { nodes, formulas };
}

/**
 * Computes every LOD reachable from a formula, caching by canonical key.
 *
 * `rowSelector` decides which rows each spec may see, which is where the filter
 * ordering rule lives.
 */
export function computeLodsForFormula(
  ast: AstNode,
  table: DataTable,
  viewDimensions: string[],
  rowSelector: (spec: LodSpec) => number[],
): Map<string, LodField> {
  const result = new Map<string, LodField>();
  const { nodes } = scanLodDependencies(ast, table);

  for (const [key, node] of nodes) {
    if (result.has(key)) continue;
    result.set(
      key,
      computeLodValues({
        table,
        node,
        viewDimensions,
        rows: rowSelector(node.spec),
      }),
    );
  }

  return result;
}

/** Human-readable form, used as the generated column label. */
export function describeLod(node: LodNode): string {
  const dimensions = node.dimensions.map((d) => `[${d}]`).join(', ');
  return `{${node.spec} ${dimensions} : ${renderAst(node.expression)}}`;
}

/** Minimal AST rendering for labels. */
function renderAst(node: AstNode): string {
  switch (node.type) {
    case 'number':
      return String(node.value);
    case 'string':
      return `"${node.value}"`;
    case 'boolean':
      return node.value ? 'TRUE' : 'FALSE';
    case 'null':
      return 'NULL';
    case 'field':
      return `[${node.name}]`;
    case 'unary':
      return `${node.op}${renderAst(node.operand)}`;
    case 'binary':
      return `${renderAst(node.left)} ${node.op} ${renderAst(node.right)}`;
    case 'call':
      return `${node.name}(${node.args.map(renderAst).join(', ')})`;
    case 'if':
      return 'IF … END';
    case 'lod':
      return describeLod(node);
    default:
      return '';
  }
}

/**
 * Classifies an LOD's output type, used to label the generated column.
 * Aggregating a date column yields the date; everything else is numeric, except
 * COUNT/COUNTD which are integers.
 */
export function lodResultType(node: LodNode, table: DataTable): 'number' | 'date' | 'string' {
  const slots = collectAggregateSlots(node.expression);
  const first = slots[0];
  if (!first) return 'number';

  if (first.aggregation === 'COUNT' || first.aggregation === 'COUNTD') return 'number';

  const index = findColumn(table, first.field);
  const schema: ColumnSchema | null = index === -1 ? null : table.schema[index];
  if (!schema) return 'number';

  if (first.aggregation === 'MIN' || first.aggregation === 'MAX') {
    if (schema.dataType === 'date') return 'date';
    if (schema.dataType === 'string') return 'string';
  }
  return 'number';
}

/** Re-export so callers can key LOD values without importing expression.ts. */
export { lodFormulaKey, aggregateKeyOf };
export type { LodField };
