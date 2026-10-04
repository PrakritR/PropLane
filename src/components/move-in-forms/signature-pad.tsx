"use client";

/**
 * A finger-or-mouse signature pad that exports a PNG. No dependency: one canvas, pointer
 * events, and smoothed quadratic strokes. The caller decides what "adopt" does with the blob
 * (the resident flow uploads it as the signature answer).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

const PAD_HEIGHT = 168;

type Point = { x: number; y: number };

function drawDot(ctx: CanvasRenderingContext2D, p: Point) {
  // A tap leaves a dot, so a signature can start with one.
  ctx.beginPath();
  ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
  ctx.fillStyle = "#0b1b3a";
  ctx.fill();
}

function drawSegment(ctx: CanvasRenderingContext2D, from: Point, to: Point) {
  const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  ctx.beginPath();
  ctx.moveTo(from.x, from.y);
  ctx.quadraticCurveTo(from.x, from.y, mid.x, mid.y);
  ctx.lineTo(to.x, to.y);
  ctx.stroke();
}

/**
 * Moves stored strokes from one pad width to another. Both axes take the same factor, so the
 * signature keeps its proportions rather than its bounding box; the factor is capped so a wider
 * pad never pushes the ink past the fixed height, which would crop it on the way back out.
 */
function rescaleStrokes(strokes: Point[][], from: number, to: number): void {
  if (from <= 0 || to <= 0 || from === to || strokes.length === 0) return;
  let tallest = 0;
  for (const stroke of strokes) for (const point of stroke) tallest = Math.max(tallest, point.y);
  const scale = tallest > 0 ? Math.min(to / from, PAD_HEIGHT / tallest) : to / from;
  if (!Number.isFinite(scale) || scale === 1) return;
  for (const stroke of strokes) {
    for (let i = 0; i < stroke.length; i++) stroke[i] = { x: stroke[i]!.x * scale, y: stroke[i]!.y * scale };
  }
}

function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise((resolve) => {
    try {
      canvas.toBlob((blob) => resolve(blob), "image/png");
    } catch {
      resolve(null);
    }
  });
}

export function SignaturePad({
  onAdopt,
  disabled = false,
  busy = false,
  adoptLabel = "Use this signature",
  dataAttr,
}: {
  /** Receives the drawn signature as a PNG. May reject; the pad stays drawn so the signer can retry. */
  onAdopt: (png: Blob) => void | Promise<void>;
  disabled?: boolean;
  busy?: boolean;
  adoptLabel?: string;
  dataAttr?: string;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<Point | null>(null);
  // Every stroke drawn so far, in the CSS pixels of the width the pad currently has, so a resize
  // redraws the whole signature at the new size instead of clipping whatever fell outside it.
  const strokes = useRef<Point[][]>([]);
  const padWidth = useRef(0);
  const [hasInk, setHasInk] = useState(false);
  const [failed, setFailed] = useState(false);

  const prepare = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.max(Math.floor(wrap.clientWidth), 240);
    canvas.width = Math.floor(width * ratio);
    canvas.height = Math.floor(PAD_HEIGHT * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${PAD_HEIGHT}px`;
    rescaleStrokes(strokes.current, padWidth.current, width);
    padWidth.current = width;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1b3a";
    // Redraw what was already signed (empty after a Clear, so a blank pad stays blank).
    for (const stroke of strokes.current) {
      const first = stroke[0];
      if (!first) continue;
      drawDot(ctx, first);
      for (let i = 1; i < stroke.length; i++) drawSegment(ctx, stroke[i - 1]!, stroke[i]!);
    }
  }, []);

  useEffect(() => {
    prepare();
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    let width = wrap.clientWidth;
    const observer = new ResizeObserver(() => {
      // A width change wipes the bitmap, so redraw the stored strokes; never mid-stroke.
      if (Math.abs(wrap.clientWidth - width) < 2) return;
      width = wrap.clientWidth;
      if (!drawing.current) prepare();
    });
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [prepare]);

  const point = (event: React.PointerEvent<HTMLCanvasElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const onDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled || busy) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    drawing.current = true;
    const p = point(event);
    last.current = p;
    const ctx = canvasRef.current?.getContext("2d");
    if (!ctx) return;
    drawDot(ctx, p);
    strokes.current.push([p]);
    setHasInk(true);
    setFailed(false);
  };

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const from = last.current;
    if (!ctx || !from) return;
    const to = point(event);
    drawSegment(ctx, from, to);
    strokes.current[strokes.current.length - 1]?.push(to);
    last.current = to;
  };

  const onUp = () => {
    drawing.current = false;
    last.current = null;
  };

  const clear = () => {
    strokes.current = [];
    prepare();
    setHasInk(false);
    setFailed(false);
  };

  const adopt = async () => {
    const canvas = canvasRef.current;
    if (!canvas || !hasInk) return;
    const png = await canvasToPngBlob(canvas);
    if (!png) {
      setFailed(true);
      return;
    }
    try {
      await onAdopt(png);
    } catch {
      setFailed(true);
    }
  };

  return (
    <div className="space-y-2" data-attr={dataAttr}>
      <div
        ref={wrapRef}
        className="relative overflow-hidden rounded-xl border border-dashed border-border bg-card transition-colors duration-(--motion-base) focus-within:border-primary/50"
      >
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Signature pad. Draw your signature with a finger or mouse."
          className="block touch-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={onUp}
        />
        {!hasInk ? (
          <span className="pointer-events-none absolute inset-0 grid place-items-center text-sm font-medium text-muted">
            Sign here
          </span>
        ) : null}
      </div>
      {failed ? <p className="text-sm text-red-600">Could not save the signature. Try again.</p> : null}
      <div className="flex items-center justify-between gap-2">
        <Button type="button" variant="ghost" className="rounded-full" onClick={clear} disabled={!hasInk || busy || disabled}>
          Clear
        </Button>
        <Button
          type="button"
          variant="primary"
          className="rounded-full"
          onClick={() => void adopt()}
          disabled={!hasInk || disabled}
          loading={busy}
          data-attr={dataAttr ? `${dataAttr}-adopt` : undefined}
        >
          {adoptLabel}
        </Button>
      </div>
    </div>
  );
}
