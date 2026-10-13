/**
 * Aggregation functions.
 *
 * Each function receives the raw cell values of one field for one group and
 * returns a scalar. Nulls are ignored except by COUNT/COUNTD, which use them to
 * decide presence. Statistics use the sample (n-1) denominator, matching
 * Tableau's STDEV/VAR behaviour.
 */

import type { Aggregation, CellValue } from './types.js';

export function numericOf(value: CellValue): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') {
    const cleaned = value.trim().replace(/,/g, '');
    if (cleaned === '') return null;
    const num = Number(cleaned);
    return Number.isFinite(num) ? num : null;
  }
  return null;
}

/** Counts non-null values. */
export function sum(values: CellValue[]): number | null {
  let total = 0;
  let seen = false;
  for (const value of values) {
    const num = numericOf(value);
    if (num === null) continue;
    total += num;
    seen = true;
  }
  return seen ? total : null;
}

export function average(values: CellValue[]): number | null {
  let total = 0;
  let count = 0;
  for (const value of values) {
    const num = numericOf(value);
    if (num === null) continue;
    total += num;
    count++;
  }
  return count === 0 ? null : total / count;
}

/** Linear-interpolation percentile, matching the common "inclusive" method. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0];
  const rank = (sorted.length - 1) * p;
  const low = Math.floor(rank);
  const high = Math.ceil(rank);
  if (low === high) return sorted[low];
  const weight = rank - low;
  return sorted[low] * (1 - weight) + sorted[high] * weight;
}

export function median(values: CellValue[]): number | null {
  const nums: number[] = [];
  for (const value of values) {
    const num = numericOf(value);
    if (num !== null) nums.push(num);
  }
  nums.sort((a, b) => a - b);
  return percentile(nums, 0.5);
}

export function variance(values: CellValue[], sample = true): number | null {
  const nums: number[] = [];
  for (const value of values) {
    const num = numericOf(value);
    if (num !== null) nums.push(num);
  }
  const n = nums.length;
  if (n === 0 || (sample && n < 2)) return null;
  const mean = nums.reduce((acc, v) => acc + v, 0) / n;
  const sumSq = nums.reduce((acc, v) => acc + (v - mean) ** 2, 0);
  return sumSq / (sample ? n - 1 : n);
}

export function stddev(values: CellValue[], sample = true): number | null {
  const v = variance(values, sample);
  return v === null ? null : Math.sqrt(v);
}

/** MIN/MAX preserve the original value type so dates stay dates. */
export function minValue(values: CellValue[]): CellValue {
  let best: CellValue = null;
  let bestKey: number | string | null = null;
  for (const value of values) {
    if (value === null) continue;
    const key = value instanceof Date ? value.getTime() : typeof value === 'string' ? value : numericOf(value);
    if (key === null) continue;
    if (bestKey === null || compareKeys(key, bestKey) < 0) {
      bestKey = key;
      best = value;
    }
  }
  return best;
}

export function maxValue(values: CellValue[]): CellValue {
  let best: CellValue = null;
  let bestKey: number | string | null = null;
  for (const value of values) {
    if (value === null) continue;
    const key = value instanceof Date ? value.getTime() : typeof value === 'string' ? value : numericOf(value);
    if (key === null) continue;
    if (bestKey === null || compareKeys(key, bestKey) > 0) {
      bestKey = key;
      best = value;
    }
  }
  return best;
}

function compareKeys(a: number | string, b: number | string): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  return String(a).localeCompare(String(b));
}

export function count(values: CellValue[]): number {
  let n = 0;
  for (const value of values) {
    if (value !== null) n++;
  }
  return n;
}

/** Distinct non-null value count. Dates collapse to the day. */
export function countDistinct(values: CellValue[]): number {
  const seen = new Set<string | number | boolean>();
  for (const value of values) {
    if (value === null) continue;
    if (value instanceof Date) {
      seen.add(value.toISOString().slice(0, 10));
    } else {
      seen.add(value);
    }
  }
  return seen.size;
}

/** ATTR returns the value if the group is constant, otherwise '*'. */
export function attribute(values: CellValue[]): CellValue {
  let first: CellValue = null;
  let hasFirst = false;
  for (const value of values) {
    if (value === null) continue;
    if (!hasFirst) {
      first = value;
      hasFirst = true;
      continue;
    }
    const a = first instanceof Date ? first.getTime() : first;
    const b = value instanceof Date ? value.getTime() : value;
    if (a !== b) return '*';
  }
  return first;
}

/** Dispatches a named aggregation. */
export function aggregate(name: Aggregation, values: CellValue[]): CellValue {
  switch (name) {
    case 'SUM':
      return sum(values);
    case 'AVG':
      return average(values);
    case 'MEDIAN':
      return median(values);
    case 'MIN':
      return minValue(values);
    case 'MAX':
      return maxValue(values);
    case 'COUNT':
      return count(values);
    case 'COUNTD':
      return countDistinct(values);
    case 'STDEV':
      return stddev(values, true);
    case 'VAR':
      return variance(values, true);
    case 'ATTR':
      return attribute(values);
    default:
      return null;
  }
}

/**
 * Aggregates many small groups efficiently.
 *
 * Rather than re-scanning a group's values once per aggregation, this walks each
 * group's values exactly once and accumulates every requested statistic in a
 * single pass. This matters because a chart with 5000 marks and several
 * measures would otherwise rescan the same slices repeatedly.
 */
export interface MultiAggregateResult {
  /** One entry per requested aggregation, in the same order. */
  values: CellValue[];
}

export function aggregateMany(names: Aggregation[], values: CellValue[]): CellValue[] {
  const wants = (name: Aggregation) => names.includes(name);

  let sumTotal = 0;
  let sumSeen = false;
  let numericCount = 0;
  let nonNullCount = 0;
  let minNum = Infinity;
  let maxNum = -Infinity;
  let minCell: CellValue = null;
  let maxCell: CellValue = null;
  let minKey: number | string | null = null;
  let maxKey: number | string | null = null;
  const distinct = new Set<string | number | boolean>();
  const nums: number[] = [];
  let attrFirst: CellValue = null;
  let attrHasFirst = false;
  let attrIsConstant = true;

  const needNumbers =
    wants('SUM') ||
    wants('AVG') ||
    wants('MEDIAN') ||
    wants('STDEV') ||
    wants('VAR');

  for (const value of values) {
    if (value === null) continue;
    nonNullCount++;

    const num = numericOf(value);
    if (num !== null) {
      numericCount++;
      sumTotal += num;
      sumSeen = true;
      if (needNumbers) nums.push(num);
    }

    if (wants('MIN') || wants('MAX')) {
      const key = value instanceof Date ? value.getTime() : typeof value === 'string' ? value : num;
      if (key !== null) {
        if (minKey === null || compareKeys(key, minKey) < 0) {
          minKey = key;
          minCell = value;
        }
        if (maxKey === null || compareKeys(key, maxKey) > 0) {
          maxKey = key;
          maxCell = value;
        }
      }
    }

    if (wants('COUNTD')) {
      distinct.add(value instanceof Date ? value.toISOString().slice(0, 10) : value);
    }

    if (wants('ATTR')) {
      if (!attrHasFirst) {
        attrFirst = value;
        attrHasFirst = true;
      } else if (attrIsConstant) {
        const a = attrFirst instanceof Date ? attrFirst.getTime() : attrFirst;
        const b = value instanceof Date ? value.getTime() : value;
        if (a !== b) attrIsConstant = false;
      }
    }
  }

  if (needNumbers) nums.sort((a, b) => a - b);

  return names.map((name) => {
    switch (name) {
      case 'SUM':
        return sumSeen ? sumTotal : null;
      case 'AVG':
        return numericCount === 0 ? null : sumTotal / numericCount;
      case 'MEDIAN':
        return percentile(nums, 0.5);
      case 'MIN':
        return minCell;
      case 'MAX':
        return maxCell;
      case 'COUNT':
        return nonNullCount;
      case 'COUNTD':
        return distinct.size;
      case 'STDEV': {
        if (numericCount < 2) return null;
        const mean = nums.reduce((acc, v) => acc + v, 0) / nums.length;
        const sumSq = nums.reduce((acc, v) => acc + (v - mean) ** 2, 0);
        return Math.sqrt(sumSq / (nums.length - 1));
      }
      case 'VAR': {
        if (numericCount < 2) return null;
        const mean = nums.reduce((acc, v) => acc + v, 0) / nums.length;
        const sumSq = nums.reduce((acc, v) => acc + (v - mean) ** 2, 0);
        return sumSq / (nums.length - 1);
      }
      case 'ATTR':
        return attrHasFirst && attrIsConstant ? attrFirst : attrHasFirst ? '*' : null;
      default:
        return null;
    }
  });
}
