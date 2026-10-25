/**
 * Calculation drafts: identity, dataset binding and re-registration planning.
 *
 * These are the rules that decide whether a draft belongs to the dataset in front of
 * the user and whether the server still needs it. Getting them wrong is silent data
 * loss (a draft never restored) or a wrong-dataset write (a formula registered against
 * an unrelated cube), so they are pinned here rather than left to the sync effect.
 *
 * The dataset is identified by NAME (+ engine URL), not id: a restarted Plateau server
 * re-seeds its datasets under new ids, and the workbook has to survive that.
 */

import {
  calculationKey,
  calculationMatchesDataset,
  planCalculationSync,
  removeCalculation,
  upsertCalculation,
  type WorkbookCalculation,
} from '../calculations.js';

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

const localDraft = (name: string, formula = 'SUM([Sales])'): WorkbookCalculation => ({
  name,
  kind: 'measure',
  formula,
  dataset: 'Sample - Superstore',
  origin: 'local',
});

const remoteDraft = (name: string, engineUrl = 'http://127.0.0.1:8080'): WorkbookCalculation => ({
  name,
  kind: 'measure',
  formula: 'SUM([value])',
  dataset: 'Sales',
  engineUrl,
  origin: 'local',
});

// --------------------------------------------------------------------- key ---

section('Identity is engine + dataset + name, case-insensitively');

{
  check('the same draft has the same key',
    calculationKey(localDraft('Margin')) === calculationKey(localDraft('margin')));
  check('a different name is a different draft',
    calculationKey(localDraft('Margin')) !== calculationKey(localDraft('Profit')));
  check('a different dataset is a different draft',
    calculationKey(localDraft('Margin')) !==
      calculationKey({ ...localDraft('Margin'), dataset: 'Other' }));
  check('a trailing slash on an engine URL does not change identity',
    calculationKey(remoteDraft('M', 'http://e:8091/')) ===
      calculationKey(remoteDraft('M', 'http://e:8091')));
  check('engine and local drafts of the same name are distinct',
    calculationKey(remoteDraft('M')) !== calculationKey(localDraft('M')));
}

// --------------------------------------------------------- dataset binding ---

section('A draft is bound to one dataset');

{
  const dataset = { name: 'Sample - Superstore' };
  check('a local draft belongs to the local dataset of the same name',
    calculationMatchesDataset(localDraft('Margin'), dataset));
  check('dataset names compare case-insensitively',
    calculationMatchesDataset(localDraft('Margin'), { name: 'sample - superstore' }));
  check('a differently named dataset does not match',
    !calculationMatchesDataset(localDraft('Margin'), { name: 'Other' }));
  check('a local draft does not match a REMOTE dataset of the same name',
    !calculationMatchesDataset(localDraft('Sales'), {
      name: 'Sales',
      engineUrl: 'http://127.0.0.1:8080',
    }));
  check('a remote draft belongs to its engine',
    calculationMatchesDataset(remoteDraft('M'), {
      name: 'Sales',
      engineUrl: 'http://127.0.0.1:8080/',
    }));
  check('a remote draft does not belong to a different engine',
    !calculationMatchesDataset(remoteDraft('M'), {
      name: 'Sales',
      engineUrl: 'http://127.0.0.1:8091',
    }));
  check('a remote draft does not belong to a local dataset',
    !calculationMatchesDataset(remoteDraft('M'), { name: 'Sales' }));
}

// ------------------------------------------------------------- upsert/remove ---

section('The list keeps one entry per identity');

{
  const once = upsertCalculation([], localDraft('Margin'));
  check('adding creates one entry', once.length === 1);
  const twice = upsertCalculation(once, localDraft('Margin', 'SUM([Profit])'));
  check('adding the same identity replaces it', twice.length === 1,
    JSON.stringify(twice));
  check('the replacement keeps the new formula', twice[0].formula === 'SUM([Profit])');
  check('other drafts are untouched',
    upsertCalculation([...once, localDraft('Profit')], localDraft('Margin')).length === 2);

  const removed = removeCalculation(
    [localDraft('Margin'), localDraft('Profit')],
    { name: 'MARGIN', dataset: 'Sample - Superstore' },
  );
  check('removal is case-insensitive and leaves the rest',
    removed.length === 1 && removed[0].name === 'Profit', JSON.stringify(removed));
  check('removing an unknown draft is a no-op',
    removeCalculation(once, { name: 'Nope', dataset: 'Sample - Superstore' }).length === 1);
}

// ------------------------------------------------------------------ sync plan ---

section('Only drafts the server lacks are registered again');

{
  const drafts = [localDraft('Margin'), localDraft('Profit'), localDraft('Margin')];
  const missing = planCalculationSync(drafts, ['Profit']);
  check('registered names are skipped', missing.every((draft) => draft.name !== 'Profit'),
    JSON.stringify(missing.map((draft) => draft.name)));
  check('the missing draft is returned once', missing.length === 1 &&
    missing[0].name === 'Margin', JSON.stringify(missing.map((draft) => draft.name)));
  check('names compare case-insensitively',
    planCalculationSync([localDraft('Margin')], ['mArGiN']).length === 0);
  check('an empty server list means everything is missing',
    planCalculationSync(drafts, []).length === 2);
  check('no drafts is no work', planCalculationSync([], []).length === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exitCode = 1;
