/**
 * The query engine: turns a visualization specification into a materialized
 * result table.
 *
 * Execution has two phases, mirroring how Tableau thinks about a view:
 *
 *  1. Row level of detail  - filters prune rows, then rows are grouped by the
 *     dimension columns (plus any discrete fields the layout implies).
 *  2. Aggregate level of detail - each group's measures are computed, and any
 *     measure-scoped filters / top-N limits are applied to whole groups.
 *
 * The result is a plain columnar table compatible with DataTable, so the
 * renderer, the data preview, and the exported CSV all consume one shape.
 */

import type { Aggregation, CellValue, ColumnSchema, DataTable } from './types.js';
import { aggregateMany } from './aggregations.js';
import { matchesFilter, type Filter } from './filters.js';
import {
  AGGREGATE_FUNCTIONS,
  aggregateColumnName,
  aggregateKeyOf,
  collectAggregateSlots,
  collectBareFields,
  containsLod,
  dateTrunc,
  evaluateExpression,
  formulaAst,
  lodFormulaKey,
  normalizeAggregate,
  type AggregateSlot,
  type AstNode,
  type LodField,
} from './expression.js';
import { computeLodsForFormula, type LodSpec } from './lod.js';import { buildTableFromRows, findColumn } from './table.js';

/** A field reference inside a query. */
export interface QueryFieldRef {
  name: string;
  /**
   * How the field is used:
   *  - dimension : grouped by, one output row per distinct combination
   *  - measure   : aggregated
   */
  kind: 'dimension' | 'measure';
  /** Aggregation to apply when kind is 'measure'. Defaults to SUM/COUNT. */
  aggregation?: Aggregation;
  /**
   * Date granularity trimming, e.g. 'month' collapses a date dimension to the
   * first of each month. Applies only to temporal columns.
   */
  datePart?: 'year' | 'quarter' | 'month' | 'week' | 'day';
}

export interface SortSpec {
  /** Name of the output column to sort by. */
  field: string;
  direction: 'asc' | 'desc';
}

export interface QuerySpec {
  /** Output column order. When omitted, dimensions lead then measures. */
  fields: QueryFieldRef[];
  filters?: Filter[];
  sort?: SortSpec;
  limit?: number;
  /** Offset for paging the result table. */
  offset?: number;
  /** When false, skip the summary/statistics block. */
  includeSummary?: boolean;
}

export interface QueryResult {
  table: DataTable;
  /** Names of dimension columns, in order. */
  dimensionNames: string[];
  /** Names of measure columns, in order, with the label shown in tooltips. */
  measureNames: string[];
  measureLabels: string[];
  /** Wall-clock execution time in milliseconds. */
  elapsedMs: number;
  /** Distinct values per dimension, used to build filter controls. */
  domain: Record<string, CellValue[]>;
  /** True when a limit truncated the output. */
  truncated: boolean;
}

/** An aggregate the engine must compute, possibly as an input to a formula. */
interface PlannedAggregate {
  aggregation: Aggregation;
  field: string;
  /** Synthetic column name; unique per (aggregation, field). */
  key: string;
}

interface PlannedDimension {
  /** Field being grouped. */
  field: string;
  /** Output column name. */
  outName: string;
  /** Column index in the source table; -1 when the field is calculated. */
  sourceIndex: number;
  /** Optional date truncation. */
  datePart?: QueryFieldRef['datePart'];
  /** True when the underlying field is calculated. */
  calculated: boolean;
  /** Parsed formula for calculated fields. */
  ast?: AstNode;
  /** True when a calculated field needs aggregates of its own. */
  needsAggregates: boolean;
  /** Schema of the source column, used to type the output column. */
  sourceSchema: ColumnSchema | null;
  resolveDataType(): ColumnSchema['dataType'];
  resolveLogicalType(): ColumnSchema['logicalType'];
  resolveSemanticType(): ColumnSchema['semanticType'];
}

interface PlannedMeasure {
  outName: string;
  /** Either an aggregate over a column, or a formula evaluated per group. */
  formula?: AstNode;
  aggregate?: PlannedAggregate;
  /** For ATTR-style display of the aggregation used. */
  label: string;
}

/** A group of row indices sharing the same dimension values. */
interface Group {
  key: string;
  rows: number[];
  dimensionValues: CellValue[];
}

function aggregateKey(aggregation: Aggregation, field: string): string {
  return aggregateKeyOf(aggregation, field);
}

/** Renders a group key that cannot collide across types. */
function groupKey(values: CellValue[]): string {
  let key = '';
  for (const value of values) {
    if (value === null) {
      key += '\u0000';
    } else if (value instanceof Date) {
      key += `d${value.getTime()}`;
    } else if (typeof value === 'number') {
      key += `n${value}`;
    } else if (typeof value === 'boolean') {
      key += `b${value ? 1 : 0}`;
    } else {
      key += `s${value}`;
    }
    key += '\u0001';
  }
  return key;
}

/**
 * Compiles a QuerySpec against a table, working out which aggregates and
 * dimensions are actually required.
 */
class QueryPlanner {
  readonly aggregates = new Map<string, PlannedAggregate>();
  readonly dimensions: PlannedDimension[] = [];
  readonly measures: PlannedMeasure[] = [];
  readonly syntheticColumns: ColumnSchema[] = [];
  private table: DataTable;

  constructor(table: DataTable) {
    this.table = table;
  }

  private schemaFor(field: string): ColumnSchema | null {
    const index = findColumn(this.table, field);
    return index === -1 ? null : this.table.schema[index];
  }

  /** Registers an aggregate so it is computed exactly once. */
  private addAggregate(aggregation: Aggregation, field: string): PlannedAggregate {
    const key = aggregateKey(aggregation, field);
    const existing = this.aggregates.get(key);
    if (existing) return existing;
    const planned: PlannedAggregate = { aggregation, field, key };
    this.aggregates.set(key, planned);
    return planned;
  }

  private addDimension(field: string, datePart?: QueryFieldRef['datePart']): PlannedDimension {
    const existing = this.dimensions.find((d) => d.field === field && d.datePart === datePart);
    if (existing) return existing;

    const index = findColumn(this.table, field);
    const schema = index === -1 ? null : this.table.schema[index];
    const calculated = Boolean(schema?.isCalculated && schema.formula);

    const dimension: PlannedDimension = {
      field,
      outName: field,
      sourceIndex: index,
      datePart,
      calculated,
      ast: calculated && schema?.formula ? formulaAst(schema.formula) : undefined,
      needsAggregates: false,
      sourceSchema: schema,
      resolveDataType() {
        if (datePart) return 'date';
        if (!schema) return 'string';
        // A calculated field is typed by inference on its values.
        if (schema.isCalculated) return schema.dataType === 'number' ? 'number' : 'string';
        return schema.dataType;
      },
      resolveLogicalType() {
        if (datePart) return 'date';
        if (!schema) return 'string';
        if (schema.isCalculated) return schema.dataType === 'number' ? 'real' : 'string';
        return schema.logicalType;
      },
      resolveSemanticType() {
        if (datePart) return 'temporal';
        return schema?.semanticType ?? 'nominal';
      },
    };
    this.dimensions.push(dimension);
    return dimension;
  }

  /** Plans a field that the query spec declares as a measure. */
  planMeasure(ref: QueryFieldRef): PlannedMeasure {
    const schema = this.schemaFor(ref.name);

    // A calculated field may itself contain aggregates.
    if (schema?.isCalculated && schema.formula) {
      const ast = formulaAst(schema.formula);
      const outName = ref.aggregation
        ? `${ref.aggregation}(${ref.name})`
        : ref.name;

      // Extract aggregate slots from the formula and register each one.
      const slots: AggregateSlot[] = [];
      collectSlots(ast, slots);
      for (const slot of slots) this.addAggregate(slot.aggregation, slot.field);

      // Bare fields inside an aggregate-bearing formula become dimensions.
      if (slots.length > 0) {
        for (const bare of collectBare(ast)) this.addDimension(bare);
      }

      const measure: PlannedMeasure = {
        outName,
        formula: ast,
        label: ref.name,
      };
      this.measures.push(measure);
      return measure;
    }

    const aggregation: Aggregation =
      ref.aggregation ?? (schema?.kind === 'measure' ? 'SUM' : 'COUNT');
    const planned = this.addAggregate(aggregation, ref.name);
    const outName = aggregateColumnName(aggregation, ref.name);

    const measure: PlannedMeasure = {
      outName,
      aggregate: planned,
      label: `${aggregation}(${ref.name})`,
    };
    this.measures.push(measure);
    return measure;
  }

  /** Plans a field declared as a dimension. */
  planDimension(ref: QueryFieldRef): PlannedDimension {
    return this.addDimension(ref.name, ref.datePart);
  }

  /**
   * Registers a calculated field used as a dimension. Formulas containing
   * aggregates are promoted to measures, because grouping by an aggregate is
   * not meaningful.
   */
  isAggregateFormula(field: string): boolean {
    const schema = this.schemaFor(field);
    if (!schema?.isCalculated || !schema.formula) return false;
    const slots: AggregateSlot[] = [];
    collectSlots(formulaAst(schema.formula), slots);
    return slots.length > 0;
  }

  buildFields(spec: QuerySpec) {
    for (const ref of spec.fields) {
      if (ref.kind === 'measure' || this.isAggregateFormula(ref.name)) {
        this.planMeasure(ref);
      } else {
        this.planDimension(ref);
      }
    }
  }
}

/** Thin wrappers so the planner reads cleanly at the call sites. */
function collectSlots(ast: AstNode, out: AggregateSlot[]): AggregateSlot[] {
  return collectAggregateSlots(ast, out);
}

function collectBare(ast: AstNode): Set<string> {
  return collectBareFields(ast);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Reads a dimension's value for a row, applying date truncation. */
function dimensionValue(
  table: DataTable,
  dimension: PlannedDimension,
  row: number,
  groupDimensions: PlannedDimension[],
  aggregateValues: Map<string, CellValue>,
  lodFields?: Map<string, LodField>,
): CellValue {
  let value: CellValue;

  if (dimension.calculated && dimension.ast) {
    value = evaluateExpression(dimension.ast, {
      table,
      row,
      resolveAggregate: (aggregation, field) => aggregateValues.get(aggregateKey(aggregation, field)),
      lodFields,
    });
  } else {
    const column = dimension.sourceIndex === -1 ? null : table.columns[dimension.sourceIndex];
    value = column ? column[row] ?? null : null;
  }

  if (value instanceof Date && dimension.datePart) {
    return dateTrunc(dimension.datePart, value);
  }
  return value;
}

/** Resolves a field reference for one row, evaluating calculated fields. */
function fieldValueForRow(
  table: DataTable,
  field: string,
  row: number,
  lodFields: Map<string, LodField>,
): CellValue {
  const index = findColumn(table, field);
  if (index === -1) return null;

  const schema = table.schema[index];
  if (schema.isCalculated && schema.formula) {
    const ast = formulaAst(schema.formula);

    // A field whose formula IS a level-of-detail expression has no stored
    // values: the correct ones depend on the view's dimensions and filters, so
    // they are computed per query and looked up by canonical identity.
    if (ast.type === 'lod') {
      const lod = lodFields.get(lodFormulaKey(ast));
      return lod ? lod.values[row] ?? null : null;
    }

    try {
      const value = evaluateExpression(ast, { table, row, lodFields });
      if (value !== null && value !== undefined) return value;
    } catch {
      // Fall through to the stored column.
    }
    return table.columns[index][row] ?? null;
  }
  return table.columns[index][row] ?? null;
}

/**
 * Evaluates a measure's formula for one group.
 *
 * A formula containing a level-of-detail expression cannot be reduced to a
 * single view-level aggregation, because the LOD's value legitimately varies
 * between rows inside one group (that is precisely what makes it a different
 * level of detail). For example:
 *
 *     SUM([Sales]) / SUM({ FIXED [Region] : SUM([Sales]) })
 *
 * The denominator is a per-row value, so the whole expression is evaluated on
 * every row of the group and the results are summed. Aggregates encountered
 * while walking the formula are computed over the group's rows on demand, which
 * keeps `SUM(x) / SUM(y)`-style ratios exact while still allowing an LOD to
 * appear inside the aggregate.
 *
 * A formula that IS a bare LOD needs no reduction at all: the LOD is already an
 * aggregate over the correct rows, so its value is read directly.
 */
function evaluateMeasureFormula(
  measure: PlannedMeasure,
  groupRows: number[],
  table: DataTable,
  aggregateValues: Map<string, CellValue>,
  lodFields: Map<string, LodField>,
): CellValue {
  const formula = measure.formula;
  if (!formula) return null;

  // A bare LOD is an aggregate over its own rows, but a view group can span
  // several LOD values -- a FIXED-per-region LOD inside a Category group, or an
  // INCLUDE that is finer than the view. The reduction used is implicit:
  //
  //   - if the LOD is constant across the group, return that constant. This is
  //     the case when the view is grouped by the LOD's own dimensions
  //     (SUM([RegionTotal]) grouped by Region is just the region total).
  //   - otherwise sum the per-row values, which is what an implicit SUM means.
  //
  // A formula that wraps the LOD in an explicit aggregate (MAX([RegionTotal]))
  // does not take this path; it is evaluated with the declared aggregation.
  if (formula.type === 'lod') {
    const field = lodFields.get(lodFormulaKey(formula));
    if (!field) return null;

    let uniform = true;
    const first = field.values[groupRows[0]] ?? null;
    let sum = 0;
    let sawNumber = false;
    let fallback: CellValue = null;

    for (const row of groupRows) {
      const value = field.values[row] ?? null;
      if (value !== first) uniform = false;
      if (typeof value === 'number' && Number.isFinite(value)) {
        sum += value;
        sawNumber = true;
      } else if (value !== null && fallback === null) {
        fallback = value;
      }
    }

    if (uniform) return first;
    if (sawNumber) return sum;
    return fallback;
  }

  // A formula with no LOD anywhere is the ordinary case: evaluate it once
  // against the pre-computed view-level aggregates. This must be checked before
  // the LOD handling below, because a formula naming an LOD-bearing field looks
  // LOD-free at the top level.
  if (!containsLod(formula)) {
    // A single aggregate over a level-of-detail field still has to be computed
    // over the group's rows, because the view-level aggregate slots only cover
    // the fields the query explicitly selected.
    const directSlots = collectAggregateSlots(formula);
    if (formula.type === 'call' && directSlots.length === 1) {
      const only = directSlots[0];
      const slice: CellValue[] = new Array(groupRows.length);
      for (let i = 0; i < groupRows.length; i++) {
        slice[i] = fieldValueForRow(table, only.field, groupRows[i], lodFields);
      }
      return aggregateMany([only.aggregation], slice)[0];
    }

    try {
      return evaluateExpression(formula, {
        table,
        row: groupRows[0] ?? 0,
        resolveAggregate: (aggregation, field) =>
          aggregateValues.get(aggregateKey(aggregation, field)),
        lodFields,
      });
    } catch {
      return null;
    }
  }

  // --- LOD-bearing formula: evaluate per row, then reduce -----------------
  //
  // An explicit aggregate wrapping the LOD (MAX({ FIXED ... : SUM(x) })) must
  // honour its declared function, so a single-slot aggregate is computed
  // directly over the per-row LOD values instead of being summed.
  const explicitSlots = collectAggregateSlots(formula);
  if (formula.type === 'call' && explicitSlots.length === 1) {
    const only = explicitSlots[0];
    const slice: CellValue[] = new Array(groupRows.length);
    for (let i = 0; i < groupRows.length; i++) {
      slice[i] = fieldValueForRow(table, only.field, groupRows[i], lodFields);
    }
    return aggregateMany([only.aggregation], slice)[0];
  }

  /** Aggregates computed on demand over this group's rows. */
  const localAggregates = new Map<string, CellValue>();

  const resolveAggregate = (aggregation: Aggregation, field: string): CellValue | undefined => {
    const key = aggregateKey(aggregation, field);
    if (localAggregates.has(key)) return localAggregates.get(key);

    // Reuse the view-level value when the caller already computed it.
    if (aggregateValues.has(key)) {
      const value = aggregateValues.get(key);
      localAggregates.set(key, value ?? null);
      return value;
    }

    // A calculated column is read row-wise and then aggregated; this is what
    // makes MAX([RegionTotal]) see the level-of-detail values rather than the
    // empty placeholder the store registers.
    const slice: CellValue[] = new Array(groupRows.length);
    for (let i = 0; i < groupRows.length; i++) {
      slice[i] = fieldValueForRow(table, field, groupRows[i], lodFields);
    }
    const value = aggregateMany([aggregation], slice)[0];
    localAggregates.set(key, value);
    return value;
  };

  const context = { table, resolveAggregate, lodFields };

  const collected: CellValue[] = [];

  for (const row of groupRows) {
    let value: CellValue;
    try {
      value = evaluateExpression(formula, { ...context, row });
    } catch {
      value = null;
    }
    collected.push(value);
  }

  // Default reduction is SUM: an LOD-bearing measure expression is additive
  // unless the formula explicitly asks for something else.
  return reducePerRowValues(collected, topLevelReducer(formula));
}

/**
 * Reads the aggregate function a formula asks for, when the whole formula is a
 * single call such as MAX({ FIXED ... : SUM(x) }). Returns null for a compound
 * expression, in which case the caller sums.
 */
function topLevelReducer(formula: AstNode): Aggregation | null {
  if (formula.type !== 'call') return null;
  const upper = formula.name.toUpperCase();
  if (!AGGREGATE_FUNCTIONS.has(upper)) return null;
  return normalizeAggregate(upper) as Aggregation;
}

/** Applies a reduction to per-row values, defaulting to an additive sum. */
function reducePerRowValues(values: CellValue[], reducer: Aggregation | null): CellValue {
  const kind = reducer === null || reducer === 'SUM' || reducer === 'ATTR' ? 'SUM' : reducer;

  if (kind === 'SUM') {
    let total = 0;
    let sawNumber = false;
    for (const value of values) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        total += value;
        sawNumber = true;
      }
    }
    if (sawNumber) return total;
    // Non-numeric results cannot be summed; report the first non-null value,
    // which is what an attribute aggregation would produce.
    for (const value of values) {
      if (value !== null) return value;
    }
    return null;
  }

  return aggregateMany([kind], values)[0];
}

/** Executes a query against a table. */
export function executeQuery(table: DataTable, spec: QuerySpec): QueryResult {  const startedAt = Date.now();

  if (table.rowCount === 0) {
    const empty = emptyResult(table, spec, startedAt);
    return empty;
  }

  const planner = new QueryPlanner(table);
  planner.buildFields(spec);

  const rowFilters = (spec.filters ?? []).filter((f) => f.scope === 'dimension');
  const measureFilters = (spec.filters ?? []).filter((f) => f.scope === 'measure');

  // --- Phase 1: prune rows -------------------------------------------------
  const survivingRows: number[] = [];
  for (let row = 0; row < table.rowCount; row++) {
    let keep = true;
    for (const filter of rowFilters) {
      const index = findColumn(table, filter.field);
      let value: CellValue = null;
      if (index !== -1) {
        const schema = table.schema[index];
        if (schema.isCalculated && schema.formula) {
          value = evaluateExpression(formulaAst(schema.formula), { table, row });
        } else {
          value = table.columns[index][row] ?? null;
        }
      }
      if (!matchesFilter(filter, value)) {
        keep = false;
        break;
      }
    }
    if (keep) survivingRows.push(row);
  }

  // --- Phase 2: level-of-detail expressions --------------------------------
  //
  // LOD values are pre-computed per row before grouping, because they are
  // deliberately independent of the view's grouping. Filter ordering follows
  // Tableau: FIXED sees every source row, while INCLUDE and EXCLUDE see only the
  // rows that survived the dimension filters.
  const allRows: number[] = new Array(table.rowCount);
  for (let row = 0; row < table.rowCount; row++) allRows[row] = row;

  const viewDimensions = planner.dimensions.map((d) => d.field);

  /** Everything an aggregate-bearing formula might reference. */
  const relevantFormulas: AstNode[] = [
    ...planner.measures.map((m) => m.formula).filter((f): f is AstNode => Boolean(f)),
    ...planner.dimensions.map((d) => d.ast).filter((f): f is AstNode => Boolean(f)),
  ];

  const rowSelector = (spec: LodSpec) =>
    spec === 'FIXED' ? allRows : survivingRows;

  // Follow references into other calculated fields, so a formula that names an
  // LOD-bearing field (MAX([RegionTotal])) still triggers that LOD.
  const lodFields = new Map<string, LodField>();
  for (const ast of relevantFormulas) {
    for (const [key, field] of computeLodsForFormula(ast, table, viewDimensions, rowSelector)) {
      if (!lodFields.has(key)) lodFields.set(key, field);
    }
  }

  // --- Phase 3: group -----------------------------------------------------
  const dimensionList = planner.dimensions;
  const groups = new Map<string, Group>();

  if (dimensionList.length === 0) {
    // No dimensions: the whole table is a single group (a grand total).
    groups.set('\u0002', { key: '\u0002', rows: survivingRows, dimensionValues: [] });
  } else {
    // Aggregates used only inside calculated DIMENSIONS still need computing.
    const dimensionAggregates = new Map<string, PlannedAggregate>();
    for (const dimension of dimensionList) {
      if (!dimension.ast) continue;
      const slots: AggregateSlot[] = [];
      collectSlots(dimension.ast, slots);
      for (const slot of slots) {
        const planned = { aggregation: slot.aggregation, field: slot.field, key: aggregateKey(slot.aggregation, slot.field) };
        dimensionAggregates.set(planned.key, planned);
        dimension.needsAggregates = true;
      }
    }

    if (dimensionAggregates.size > 0) {
      // Group by the bare (non-calculated) dimensions first, compute the
      // aggregates each calculated dimension needs, then evaluate every
      // dimension per row against those group values.
      const provisional = new Map<string, number[]>();
      for (const row of survivingRows) {
        const values: CellValue[] = [];
        for (const dimension of dimensionList) {
          if (dimension.ast) continue;
          values.push(dimensionValue(table, dimension, row, dimensionList, new Map(), lodFields));
        }
        const key = groupKey(values);
        const bucket = provisional.get(key);
        if (bucket) bucket.push(row);
        else provisional.set(key, [row]);
      }

      for (const rows of provisional.values()) {
        const aggValues = new Map<string, CellValue>();
        for (const planned of dimensionAggregates.values()) {
          const index = findColumn(table, planned.field);
          if (index === -1) continue;
          const column = table.columns[index];
          const slice = rows.map((r) => column[r] ?? null);
          aggValues.set(planned.key, aggregateMany([planned.aggregation], slice)[0]);
        }
        // Now evaluate every dimension (bare and calculated) per row.
        for (const row of rows) {
          const values = dimensionList.map((dimension) =>
            dimensionValue(table, dimension, row, dimensionList, aggValues, lodFields),
          );
          const key = groupKey(values);
          const existing = groups.get(key);
          if (existing) existing.rows.push(row);
          else groups.set(key, { key, rows: [row], dimensionValues: values });
        }
      }
    } else {
      for (const row of survivingRows) {
        const values = dimensionList.map((dimension) =>
          dimensionValue(table, dimension, row, dimensionList, new Map(), lodFields),
        );
        const key = groupKey(values);
        const existing = groups.get(key);
        if (existing) existing.rows.push(row);
        else groups.set(key, { key, rows: [row], dimensionValues: values });
      }
    }
  }

  // --- Phase 4: compute measures per group --------------------------------
  const aggregateList = [...planner.aggregates.values()];

  interface ResultRow {
    dimensions: CellValue[];
    measures: CellValue[];
    /** Raw aggregate values keyed by (aggregation, field), for measure filters. */
    aggregateValues: Map<string, CellValue>;
  }

  const resultRows: ResultRow[] = [];

  for (const group of groups.values()) {
    const aggregateValues = new Map<string, CellValue>();

    for (const planned of aggregateList) {
      // `fieldValueForRow` rather than a raw column read: a calculated field is
      // evaluated on demand, which is what lets an aggregate over a
      // level-of-detail column (SUM([RegionTotal])) see real values instead of
      // the empty placeholder the store registers.
      if (findColumn(table, planned.field) === -1) {
        aggregateValues.set(planned.key, null);
        continue;
      }
      const slice: CellValue[] = new Array(group.rows.length);
      for (let i = 0; i < group.rows.length; i++) {
        slice[i] = fieldValueForRow(table, planned.field, group.rows[i], lodFields);
      }
      aggregateValues.set(planned.key, aggregateMany([planned.aggregation], slice)[0]);
    }

    const measureValues: CellValue[] = [];
    for (const measure of planner.measures) {
      if (measure.formula) {
        // Evaluate the formula for this group. Level-of-detail nodes resolve
        // per row through `lodFields`, so an LOD-bearing formula is reduced
        // across the group's rows rather than read once.
        measureValues.push(
          evaluateMeasureFormula(measure, group.rows, table, aggregateValues, lodFields),
        );
      } else if (measure.aggregate) {
        measureValues.push(aggregateValues.get(measure.aggregate.key) ?? null);
      } else {
        measureValues.push(null);
      }
    }

    resultRows.push({ dimensions: group.dimensionValues, measures: measureValues, aggregateValues });
  }

  // --- Phase 4: measure filters (evaluated on aggregated values) ----------
  let filteredRows = resultRows;
  if (measureFilters.length > 0) {
    filteredRows = resultRows.filter((row) => {
      for (const filter of measureFilters) {
        // A measure filter applies to a field; find a matching planned aggregate.
        const match = planner.measures.find(
          (measure) =>
            measure.aggregate?.field === filter.field ||
            measure.outName === filter.field ||
            measure.label === filter.field,
        );
        let value: CellValue = null;
        if (match?.aggregate) {
          value = row.aggregateValues.get(match.aggregate.key) ?? null;
        } else if (match) {
          const position = planner.measures.indexOf(match);
          value = row.measures[position] ?? null;
        }
        if (!matchesFilter(filter, value)) return false;
      }
      return true;
    });
  }

  // --- Phase 5: top/bottom N filters -------------------------------------
  for (const filter of measureFilters) {
    if (filter.operator !== 'top' && filter.operator !== 'bottom') continue;
    const limit = filter.limit ?? 10;
    const position = planner.measures.findIndex(
      (measure) => measure.aggregate?.field === filter.field || measure.outName === filter.field,
    );
    const measurePosition = position === -1 ? 0 : position;
    const descending = filter.operator === 'top';
    filteredRows = [...filteredRows]
      .sort((a, b) => {
        const av = Number(a.measures[measurePosition] ?? 0);
        const bv = Number(b.measures[measurePosition] ?? 0);
        return descending ? bv - av : av - bv;
      })
      .slice(0, limit);
  }

  // --- Phase 6: sort ------------------------------------------------------
  const dimensionNames = dimensionList.map((d) => d.outName);
  const measureNames = planner.measures.map((m) => m.outName);
  const measureLabels = planner.measures.map((m) => m.label);

  if (spec.sort) {
    const dimensionPosition = dimensionNames.indexOf(spec.sort.field);
    const measurePosition = measureNames.indexOf(spec.sort.field);
    const direction = spec.sort.direction === 'asc' ? 1 : -1;

    filteredRows = [...filteredRows].sort((a, b) => {
      let av: CellValue;
      let bv: CellValue;
      if (dimensionPosition !== -1) {
        av = a.dimensions[dimensionPosition];
        bv = b.dimensions[dimensionPosition];
      } else if (measurePosition !== -1) {
        av = a.measures[measurePosition];
        bv = b.measures[measurePosition];
      } else {
        return 0;
      }
      return compareCells(av, bv) * direction;
    });
  }

  const truncated = filteredRows.length > (spec.limit ?? Infinity);
  const limited = spec.limit !== undefined ? filteredRows.slice(0, spec.limit) : filteredRows;

  // --- Phase 7: materialize output ---------------------------------------
  const resultTable = materialize(planner, limited, dimensionNames, measureNames);

  return {
    table: resultTable,
    dimensionNames,
    measureNames,
    measureLabels,
    elapsedMs: Date.now() - startedAt,
    domain: buildDomain(limited, dimensionNames),
    truncated,
  };
}

/** Orders values consistently for sorting and display. */
export function compareCells(a: CellValue, b: CellValue): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1; // nulls last
  if (b === null) return -1;

  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === 'number' && typeof b === 'number') return a - b;

  const na = typeof a === 'number' ? a : Number(a);
  const nb = typeof b === 'number' ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;

  return String(a).localeCompare(String(b));
}

/** Builds the output DataTable, preserving value types. */
function materialize(
  planner: QueryPlanner,
  rows: { dimensions: CellValue[]; measures: CellValue[] }[],
  dimensionNames: string[],
  measureNames: string[],
): DataTable {
  const header = [...dimensionNames, ...measureNames];
  const rawRows: string[][] = rows.map((row) => [
    ...row.dimensions.map(cellToRaw),
    ...row.measures.map(cellToRaw),
  ]);

  const overrides: Record<string, Partial<Pick<ColumnSchema, 'dataType' | 'kind' | 'logicalType' | 'semanticType'>>> = {};

  planner.dimensions.forEach((dimension, i) => {
    const name = dimensionNames[i];
    overrides[name] = {
      dataType: dimension.datePart ? 'date' : dimension.resolveDataType(),
      logicalType: dimension.datePart ? 'date' : dimension.resolveLogicalType(),
      semanticType: dimension.resolveSemanticType(),
      kind: 'dimension',
    };
  });

  planner.measures.forEach((measure, i) => {
    overrides[measureNames[i]] = {
      dataType: 'number',
      logicalType: 'real',
      semanticType: 'quantitative',
      kind: 'measure',
    };
  });

  const built = buildTableFromRows(header, rawRows, { name: 'result', columnOverrides: overrides });

  // Restore Date objects and booleans that the string round-trip would lose.
  planner.dimensions.forEach((dimension, c) => {
    const wantsDate = dimension.datePart !== undefined || dimension.resolveDataType() === 'date';
    const wantsBoolean = dimension.resolveDataType() === 'boolean';
    if (!wantsDate && !wantsBoolean) return;
    const column = built.columns[c];
    for (let r = 0; r < rows.length; r++) {
      const original = rows[r].dimensions[c];
      if (original instanceof Date || typeof original === 'boolean') column[r] = original;
    }
  });

  return built;
}

/** Serialises a cell for the string round-trip used by buildTableFromRows. */
function cellToRaw(value: CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

/** Collects distinct dimension values so the UI can build filter controls. */
function buildDomain(
  sourceRows: { dimensions: CellValue[] }[],
  dimensionNames: string[],
): Record<string, CellValue[]> {
  const domain: Record<string, CellValue[]> = {};
  dimensionNames.forEach((name, i) => {
    const seen = new Map<string, CellValue>();
    for (const row of sourceRows) {
      const value = row.dimensions[i];
      if (value === null) continue;
      const key = value instanceof Date ? `d${value.getTime()}` : String(value);
      if (!seen.has(key)) seen.set(key, value);
      if (seen.size >= 500) break;
    }
    domain[name] = [...seen.values()];
  });
  return domain;
}

function emptyResult(table: DataTable, spec: QuerySpec, startedAt: number): QueryResult {
  const dimensionNames = spec.fields.filter((f) => f.kind === 'dimension').map((f) => f.name);
  const measureNames = spec.fields.filter((f) => f.kind === 'measure').map((f) => f.name);
  return {
    table: buildTableFromRows([...dimensionNames, ...measureNames], []),
    dimensionNames,
    measureNames,
    measureLabels: measureNames,
    elapsedMs: Date.now() - startedAt,
    domain: {},
    truncated: false,
  };
}

export { formulaAst };
