/**
 * Release math for a bottom sheet dragged downward (Apple "momentum and projection").
 *
 * A fixed pixel threshold treats a hard flick and a lazy nudge the same. Instead the
 * release velocity is measured over the last few pointer samples and projected forward
 * with the same deceleration rate UIScrollView uses (0.998 per ms); the sheet dismisses
 * when that resting point lies past half its height. A slow drag that is already past
 * half way dismisses too (its projection is at least its current offset), and a slow
 * release near the top settles back.
 */

export type DragSample = { t: number; y: number };

/** Samples kept for the velocity estimate: enough to smooth jitter, short enough to be "now". */
export const SHEET_SAMPLE_COUNT = 4;
/** UIScrollView.DecelerationRate.normal. */
export const SHEET_DECELERATION = 0.998;

/** Append a sample, keeping only the most recent {@link SHEET_SAMPLE_COUNT}. */
export function pushDragSample(samples: DragSample[], sample: DragSample): DragSample[] {
  const next = [...samples, sample];
  return next.length > SHEET_SAMPLE_COUNT ? next.slice(next.length - SHEET_SAMPLE_COUNT) : next;
}

/** Downward velocity in px/s across the retained samples (0 when there is no usable span). */
export function releaseVelocity(samples: DragSample[]): number {
  if (samples.length < 2) return 0;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const dt = last.t - first.t;
  if (dt <= 0) return 0;
  return ((last.y - first.y) / dt) * 1000;
}

/** Where the sheet would come to rest if left to decelerate from `y` at `velocity` px/s. */
export function projectSheetOffset(y: number, velocity: number): number {
  return y + ((velocity / 1000) * SHEET_DECELERATION) / (1 - SHEET_DECELERATION);
}

export type SheetRelease = {
  dismiss: boolean;
  velocity: number;
  projected: number;
};

/** Decide dismiss vs settle for a release at offset `y` of a sheet `height` px tall. */
export function resolveSheetRelease({
  samples,
  y,
  height,
}: {
  samples: DragSample[];
  y: number;
  height: number;
}): SheetRelease {
  const velocity = releaseVelocity(samples);
  const projected = projectSheetOffset(y, velocity);
  return { dismiss: height > 0 && projected > height / 2, velocity, projected };
}

/** Scrim opacity tied to the drag: fully dimmed at rest, clear once the sheet has left. */
export function scrimOpacityForOffset(y: number, height: number): number {
  if (height <= 0) return 1;
  return Math.min(1, Math.max(0, 1 - y / height));
}
