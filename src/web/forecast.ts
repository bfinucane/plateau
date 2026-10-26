/**
 * Forecasting: a straight-line projection over the values already on screen.
 *
 * Deliberately small and honest. Plateau asks the engine for history, then fits a
 * least-squares line to the displayed aggregate series and extends the time axis by N
 * periods. Nothing is sent to the engine, no source data beyond the chart is used, and
 * no seasonality is modelled — so the UI must call it a trend projection, not a
 * statistical forecast. Nulls (an absent group) are skipped, never treated as zero.
 */

export type ForecastDatePart = 'year' | 'quarter' | 'month' | 'week' | 'day';

export interface ForecastFit {
  /** Values projected for the next `periods` positions. */
  forecast: number[];
  /** Least-squares slope, for the tooltip/caption if ever needed. */
  slope: number;
  /** Number of historical points the model was fitted on. */
  points: number;
}

/** A least-squares fit of value against position, ignoring absent values. */
export function fitLinear(
  values: (number | null)[],
): { slope: number; intercept: number; residualStd: number; points: number } | null {
  const points: { x: number; y: number }[] = [];
  values.forEach((value, index) => {
    if (value !== null && Number.isFinite(value)) points.push({ x: index, y: value });
  });
  // Two points define a line, but a projection from two points hides that it is not a
  // trend; require three, the same threshold a reader would apply to "trend".
  if (points.length < 3) return null;

  const n = points.length;
  const meanX = points.reduce((sum, point) => sum + point.x, 0) / n;
  const meanY = points.reduce((sum, point) => sum + point.y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (const point of points) {
    sxx += (point.x - meanX) ** 2;
    sxy += (point.x - meanX) * (point.y - meanY);
  }
  if (sxx === 0) return null;
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  let residualSum = 0;
  for (const point of points) {
    const predicted = intercept + slope * point.x;
    residualSum += (point.y - predicted) ** 2;
  }
  return { slope, intercept, residualStd: Math.sqrt(residualSum / n), points: n };
}

/**
 * Projects the next `periods` positions.
 *
 * Returns `null` rather than a fake answer when there is too little history or the
 * request is nonsense — the caller shows nothing instead of a confident straight line
 * through two points.
 */
export function forecastValues(
  values: (number | null)[],
  periods: number,
): ForecastFit | null {
  if (!Number.isInteger(periods) || periods < 1 || periods > 60) return null;
  const fit = fitLinear(values);
  if (!fit) return null;
  const lastIndex = values.length - 1;
  const forecast = Array.from({ length: periods }, (_, step) =>
    fit.intercept + fit.slope * (lastIndex + 1 + step),
  );
  return { forecast, slope: fit.slope, points: fit.points };
}

/** The period a temporal axis is stepping by, when it is known. */
export function isForecastDatePart(value: unknown): value is ForecastDatePart {
  return (
    value === 'year' ||
    value === 'quarter' ||
    value === 'month' ||
    value === 'week' ||
    value === 'day'
  );
}

interface IsoDate {
  year: number;
  month: number; // 1-12
  day: number;
}

function parseIsoDate(text: string): IsoDate | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { year, month, day };
}

/** Two-digit padded ISO date at UTC midnight, so time zones cannot shift a period. */
function isoDate({ year, month, day }: IsoDate): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** The start of the period `steps` periods after `date`'s own period. */
function addPeriods(date: IsoDate, datePart: ForecastDatePart, steps: number): IsoDate {
  switch (datePart) {
    case 'day':
      return utcFromDays(dayNumber(date) + steps);
    case 'week':
      return utcFromDays(dayNumber(date) + steps * 7);
    case 'month': {
      const total = date.year * 12 + (date.month - 1) + steps;
      return { year: Math.floor(total / 12), month: (total % 12) + 1, day: 1 };
    }
    case 'quarter': {
      const quarter = Math.floor((date.month - 1) / 3);
      const total = date.year * 4 + quarter + steps;
      return { year: Math.floor(total / 4), month: (total % 4) * 3 + 1, day: 1 };
    }
    case 'year':
      return { year: date.year + steps, month: 1, day: 1 };
  }
}

/** Days since 1970-01-01 for a calendar date (UTC). */
function dayNumber(date: IsoDate): number {
  return Math.floor(Date.UTC(date.year, date.month - 1, date.day) / 86_400_000);
}

function utcFromDays(days: number): IsoDate {
  const date = new Date(days * 86_400_000);
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

/**
 * ISO labels for the next `periods` periods after the last observed one.
 *
 * Anchored to the START of each period (the 1st of the month/quarter, Jan 1 for a
 * year), which is how the engine returns truncated dates. Returns an empty array when
 * the last label is not an ISO date — the caller then draws no forecast rather than
 * inventing labels.
 */
export function nextTemporalLabels(
  lastLabel: string,
  datePart: ForecastDatePart,
  periods: number,
): string[] {
  if (!Number.isInteger(periods) || periods < 1) return [];
  const parsed = parseIsoDate(lastLabel);
  if (!parsed) return [];
  return Array.from({ length: periods }, (_, step) =>
    isoDate(addPeriods(parsed, datePart, step + 1)),
  );
}
