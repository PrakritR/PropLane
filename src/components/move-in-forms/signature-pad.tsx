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
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.4;
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = "#0b1b3a";
  }, []);

  useEffect(() => {
    prepare();
    const wrap = wrapRef.current;
    if (!wrap || typeof ResizeObserver === "undefined") return;
    let width = wrap.clientWidth;
    const observer = new ResizeObserver(() => {
      // A width change wipes the bitmap; only redo it when the pad is still blank.
      if (Math.abs(wrap.clientWidth - width) < 2) return;
      width = wrap.clientWidth;
      if (!drawing.current) {
        prepare();
        setHasInk(false);
      }
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
    // A tap leaves a dot, so a signature can start with one.
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.2, 0, Math.PI * 2);
    ctx.fillStyle = "#0b1b3a";
    ctx.fill();
    setHasInk(true);
    setFailed(false);
  };

  const onMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current) return;
    const ctx = canvasRef.current?.getContext("2d");
    const from = last.current;
    if (!ctx || !from) return;
    const to = point(event);
    const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.quadraticCurveTo(from.x, from.y, mid.x, mid.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    last.current = to;
  };

  const onUp = () => {
    drawing.current = false;
    last.current = null;
  };

  const clear = () => {
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
