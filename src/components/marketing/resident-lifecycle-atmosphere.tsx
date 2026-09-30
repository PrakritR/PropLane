"use client";

import "./resident-lifecycle-atmosphere.css";
import { useEffect, useRef } from "react";

type Particle = {
  x: number;
  y: number;
  radius: number;
  opacity: number;
  drift: number;
  phase: number;
  tone: number;
};

type Ripple = { x: number; y: number; startedAt: number };

const tones = ["#6a90bd", "#99b8d9", "#c7d7e8", "#4c769f"];
const frameInterval = 1000 / 30;

function randomGenerator(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function makeParticles(width: number, height: number): Particle[] {
  const random = randomGenerator(4791 + Math.round(width / 8) * 31 + Math.round(height / 8));
  const count = Math.min(2600, Math.max(520, Math.round((width * height) / 380)));
  const particles: Particle[] = [];

  for (let index = 0; index < count; index += 1) {
    const layer = random();
    const side = random() < 0.52 ? 0 : 1;
    const bank = layer < 0.22 ? random() : Math.pow(random(), 1.8);
    const x = (side === 0 ? bank * 0.68 : 1 - bank * 0.68) * width;
    const normalizedX = x / width;
    const wave = Math.sin(normalizedX * Math.PI * 3.2 + 0.45) * 0.045;
    const horizon = layer < 0.22 ? 0.42 : layer < 0.64 ? 0.55 : 0.69;
    const spread = layer < 0.22 ? 0.15 : layer < 0.64 ? 0.20 : 0.24;
    const y = (horizon + wave + random() * spread) * height;
    const opacity = 0.18 + random() * 0.42;
    particles.push({
      x,
      y,
      radius: layer < 0.22 ? 0.5 + random() * 0.7 : 0.75 + random() * 1.2,
      opacity,
      drift: 0.6 + random() * 2.3,
      phase: random() * Math.PI * 2,
      tone: Math.floor(random() * tones.length),
    });
  }
  return particles;
}

export function ResidentLifecycleAtmosphere() {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { alpha: true });
    if (!container || !canvas || !context) return;
    const hero = container.parentElement;

    const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    let particles: Particle[] = [];
    let width = 0;
    let height = 0;
    let visible = true;
    let frame = 0;
    let lastFrame = 0;
    let pointerX = 0.5;
    let pointerY = 0.5;
    let pointerTargetX = 0.5;
    let pointerTargetY = 0.5;
    let pointerStrength = 0;
    let pointerTargetStrength = 0;
    let ripple: Ripple | null = null;
    let touchStart: { x: number; y: number; moved: boolean } | null = null;

    const onPointerMove = (event: PointerEvent) => {
      if (motionQuery.matches) return;
      if (event.pointerType === "touch" && touchStart) {
        const dx = event.clientX - (container.getBoundingClientRect().left + touchStart.x);
        const dy = event.clientY - (container.getBoundingClientRect().top + touchStart.y);
        if (Math.hypot(dx, dy) > 12) touchStart.moved = true;
      }
      const rect = container.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      pointerTargetX = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      pointerTargetY = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      pointerTargetStrength = 1;
    };
    const onPointerLeave = () => {
      pointerTargetStrength = 0;
    };
    const onPointerDown = (event: PointerEvent) => {
      if (motionQuery.matches || event.button !== 0) return;
      const rect = container.getBoundingClientRect();
      const x = event.clientX - rect.left;
      const y = event.clientY - rect.top;
      if (event.pointerType === "touch") {
        touchStart = { x, y, moved: false };
        return;
      }
      ripple = { x, y, startedAt: performance.now() };
      pointerTargetX = x / Math.max(width, 1);
      pointerTargetY = y / Math.max(height, 1);
      pointerTargetStrength = 1;
      syncPlayback();
    };
    const onPointerEnd = (event: PointerEvent) => {
      if (event.type === "pointercancel") {
        touchStart = null;
        pointerTargetStrength = 0;
        return;
      }
      if (event.pointerType !== "touch" || !touchStart) return;
      if (!touchStart.moved) {
        ripple = { x: touchStart.x, y: touchStart.y, startedAt: performance.now() };
        pointerTargetX = touchStart.x / Math.max(width, 1);
        pointerTargetY = touchStart.y / Math.max(height, 1);
        pointerTargetStrength = 1;
        syncPlayback();
      }
      touchStart = null;
      pointerTargetStrength = 0;
    };

    const draw = (time: number) => {
      context.clearRect(0, 0, width, height);
      const pointerPixelX = pointerX * width;
      const pointerPixelY = pointerY * height;
      const influenceRadius = Math.min(width, height) * 0.42;
      const rippleAge = ripple ? time - ripple.startedAt : Infinity;
      const rippleProgress = rippleAge / 920;
      if (ripple && rippleAge > 920) ripple = null;

      // Fine, gently flowing contours give the whole hero a continuous water-like field.
      const lineCount = Math.max(22, Math.min(42, Math.round(height / 17)));
      const steps = Math.max(48, Math.min(96, Math.round(width / 15)));
      context.lineWidth = 0.7;
      for (let line = 0; line < lineCount; line += 1) {
        const baseY = (line / (lineCount - 1)) * height;
        const phase = line * 0.43;
        context.beginPath();
        for (let step = 0; step <= steps; step += 1) {
          const x = (step / steps) * width;
          const nx = x / Math.max(width, 1);
          const wave = Math.sin(nx * 8.5 + phase + time * 0.00017) * 10
            + Math.sin(nx * 17 - phase * 0.7 + time * 0.00011) * 3.5;
          const dx = x - pointerPixelX;
          const dy = baseY + wave - pointerPixelY;
          const distance = Math.hypot(dx, dy);
          const hover = motionQuery.matches
            ? 0
            : pointerStrength * Math.exp(-((distance / influenceRadius) ** 2) * 1.7);
          const curl = hover * (-dy / (distance + 1)) * 42;
          let tapWave = 0;
          if (!motionQuery.matches && ripple && rippleProgress >= 0 && rippleProgress <= 1) {
            const radius = rippleProgress * Math.max(width, height) * 0.72;
            const rippleDistance = Math.hypot(x - ripple.x, baseY + wave - ripple.y);
            const ring = Math.exp(-(((rippleDistance - radius) / 34) ** 2));
            tapWave = Math.sin((rippleDistance - radius) * 0.12) * ring * 23 * (1 - rippleProgress);
          }
          const y = baseY + wave + curl + tapWave;
          if (step === 0) context.moveTo(x, y);
          else context.lineTo(x, y);
        }
        const glow = 0.09 + ((line * 17) % 7) * 0.012;
        context.strokeStyle = `rgba(49, 105, 157, ${glow})`;
        context.stroke();
      }

      // A clear expanding ring makes a tap or click register across the surface.
      if (!motionQuery.matches && ripple && rippleProgress >= 0 && rippleProgress <= 1) {
        const radius = rippleProgress * Math.max(width, height) * 0.72;
        const alpha = Math.sin(Math.PI * rippleProgress) * 0.58;
        context.beginPath();
        context.arc(ripple.x, ripple.y, radius, 0, Math.PI * 2);
        context.strokeStyle = `rgba(39, 105, 166, ${alpha})`;
        context.lineWidth = Math.max(1, 2.2 * (1 - rippleProgress * 0.55));
        context.stroke();
        context.beginPath();
        context.arc(ripple.x, ripple.y, Math.max(0, radius - 7), 0, Math.PI * 2);
        context.strokeStyle = `rgba(109, 157, 196, ${alpha * 0.5})`;
        context.lineWidth = 1;
        context.stroke();
      }

      for (const particle of particles) {
        const displacement = motionQuery.matches
          ? 0
          : Math.sin(time * 0.00027 + particle.phase) * particle.drift;
        const dx = particle.x - pointerPixelX;
        const dy = particle.y - pointerPixelY;
        const distance = Math.sqrt(dx * dx + dy * dy);
        const influence = motionQuery.matches
          ? 0
          : pointerStrength * Math.exp(-((distance / influenceRadius) ** 2) * 2.2);
        const currentX = influence * (-dy / (distance + 1) * 48 + Math.sin(time * 0.0007 + particle.phase) * 7);
        const currentY = influence * (dx / (distance + 1) * 48 + Math.cos(time * 0.0006 + particle.phase) * 7);
        context.globalAlpha = particle.opacity;
        context.fillStyle = tones[particle.tone];
        context.fillRect(
          particle.x + displacement + currentX,
          particle.y + currentY,
          particle.radius,
          particle.radius,
        );
      }
      context.globalAlpha = 1;
    };

    const animate = (time: number) => {
      frame = window.requestAnimationFrame(animate);
      if (time - lastFrame < frameInterval) return;
      lastFrame = time;
      pointerX += (pointerTargetX - pointerX) * 0.12;
      pointerY += (pointerTargetY - pointerY) * 0.12;
      pointerStrength += (pointerTargetStrength - pointerStrength) * 0.1;
      draw(time);
    };

    const syncPlayback = () => {
      window.cancelAnimationFrame(frame);
      frame = 0;
      if (!visible || document.hidden || !width || !height) return;
      if (motionQuery.matches) {
        ripple = null;
        pointerStrength = 0;
        pointerTargetStrength = 0;
        draw(0);
        return;
      }
      lastFrame = 0;
      frame = window.requestAnimationFrame(animate);
    };

    const resize = () => {
      const rect = container.getBoundingClientRect();
      width = Math.max(0, Math.round(rect.width));
      height = Math.max(0, Math.round(rect.height));
      if (!width || !height) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      particles = makeParticles(width, height);
      draw(0);
      syncPlayback();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const intersectionObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      syncPlayback();
    }, { threshold: 0.01 });
    intersectionObserver.observe(container);
    document.addEventListener("visibilitychange", syncPlayback);
    motionQuery.addEventListener("change", syncPlayback);
    hero?.addEventListener("pointermove", onPointerMove, { passive: true });
    hero?.addEventListener("pointerleave", onPointerLeave, { passive: true });
    hero?.addEventListener("pointerdown", onPointerDown, { passive: true });
    hero?.addEventListener("pointerup", onPointerEnd, { passive: true });
    hero?.addEventListener("pointercancel", onPointerEnd, { passive: true });
    resize();

    return () => {
      window.cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      intersectionObserver.disconnect();
      document.removeEventListener("visibilitychange", syncPlayback);
      motionQuery.removeEventListener("change", syncPlayback);
      hero?.removeEventListener("pointermove", onPointerMove);
      hero?.removeEventListener("pointerleave", onPointerLeave);
      hero?.removeEventListener("pointerdown", onPointerDown);
      hero?.removeEventListener("pointerup", onPointerEnd);
      hero?.removeEventListener("pointercancel", onPointerEnd);
    };
  }, []);

  return (
    <div className="rlp-atmosphere" ref={containerRef} aria-hidden="true">
      <canvas ref={canvasRef} />
    </div>
  );
}
