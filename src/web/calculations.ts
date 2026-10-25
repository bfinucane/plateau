/**
 * Calculation drafts: the Plateau-side half of a reserved wire concept.
 *
 * A calculation is currently a CLIENT artefact. It is authored in Plateau, pushed to
 * the engine as an AST per query, evaluated there, and forgotten. That means it is
 * not a model object: another front-end cannot see it, and a Plateau restart loses it
 * because the server keeps formulas only in memory.
 *
 * This module gives drafts a durable, explicit shape in the workbook so at least the
 * loss-on-restart is fixed honestly, and so that when the engine can store
 * calculations (see the reserved section of docs/ENGINE-PROTOCOL.md) promoting a
 * draft is a copy rather than a rewrite:
 *
 *   - `formula` here is the Plateau DIALECT SOURCE, which is what the user edits.
 *     The normative wire form is the parsed AST; it is derived when querying, so the
 *     workbook never holds a stale AST.
 *   - `origin: 'local'` is deliberate: these are drafts, not model objects. Nothing
 *     in the UI should present them as shared, and no other client can see them.
 *   - the dataset is identified by NAME (+ engine URL for remote data) rather than
 *     server id, because a restarted server re-seeds the same dataset under a new id.
 */

/** Which kind of client calculation this is. Maps to the reserved wire `kind`. */
export type WorkbookCalculationKind = 'dimension' | 'measure';

/** A calculation draft held by the workbook. */
export interface WorkbookCalculation {
  name: string;
  kind: WorkbookCalculationKind;
  /** Plateau-dialect formula source; parsed to the canonical AST when pushed. */
  formula: string;
  /** Dataset NAME the calculation belongs to (ids change on restart). */
  dataset: string;
  /** Present for a remote dataset: the engine URL it lives on. */
  engineUrl?: string;
  /** Drafts are always local until engines can store calculations. */
  origin: 'local';
}

/** The dataset identity a draft is bound to. */
export interface DatasetIdentity {
  name: string;
  engineUrl?: string;
}

/** A stable key for a draft: engine + dataset + name, case-insensitive. */
export function calculationKey(calculation: WorkbookCalculation): string {
  return [
    calculation.engineUrl?.trim().replace(/\/+$/, '').toLowerCase() ?? '',
    calculation.dataset.trim().toLowerCase(),
    calculation.name.trim().toLowerCase(),
  ].join('\u0000');
}

/** True when a draft belongs to the given dataset. */
export function calculationMatchesDataset(
  calculation: WorkbookCalculation,
  dataset: DatasetIdentity,
): boolean {
  if (calculation.dataset.trim().toLowerCase() !== dataset.name.trim().toLowerCase()) {
    return false;
  }
  // A draft from an engine only belongs to that engine. A LOCAL draft (no engine URL)
  // belongs to the dataset of the same name, which is how a re-seeded sample matches.
  const draftEngine = calculation.engineUrl?.trim().replace(/\/+$/, '').toLowerCase();
  if (!draftEngine) return !dataset.engineUrl;
  return draftEngine === (dataset.engineUrl ?? '').trim().replace(/\/+$/, '').toLowerCase();
}

/** Adds or replaces a draft, keeping one entry per identity. */
export function upsertCalculation(
  calculations: WorkbookCalculation[],
  calculation: WorkbookCalculation,
): WorkbookCalculation[] {
  const key = calculationKey(calculation);
  const without = calculations.filter((existing) => calculationKey(existing) !== key);
  return [...without, calculation];
}

/** Removes one draft by identity. */
export function removeCalculation(
  calculations: WorkbookCalculation[],
  calculation: Pick<WorkbookCalculation, 'name' | 'dataset' | 'engineUrl'>,
): WorkbookCalculation[] {
  const identity = {
    name: calculation.name,
    dataset: calculation.dataset,
    engineUrl: calculation.engineUrl,
    kind: 'measure' as const,
    formula: '',
    origin: 'local' as const,
  };
  const key = calculationKey(identity);
  return calculations.filter((existing) => calculationKey(existing) !== key);
}

/**
 * Which drafts still need registering on the server.
 *
 * A server restart loses its in-memory calculated fields, so the workbook is the
 * source of truth for DRAFTS: anything the server does not already have is created
 * again. Names compare case-insensitively because the engine's field resolution is
 * case-insensitive.
 */
export function planCalculationSync(
  drafts: WorkbookCalculation[],
  registeredNames: string[],
): WorkbookCalculation[] {
  const registered = new Set(registeredNames.map((name) => name.trim().toLowerCase()));
  const seen = new Set<string>();
  const missing: WorkbookCalculation[] = [];
  for (const draft of drafts) {
    const key = calculationKey(draft);
    if (seen.has(key)) continue;
    seen.add(key);
    if (registered.has(draft.name.trim().toLowerCase())) continue;
    missing.push(draft);
  }
  return missing;
}
