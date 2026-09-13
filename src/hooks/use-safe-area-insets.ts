"use client";

import { useEffect, useState } from "react";

export type SafeAreaInsets = {
  top: number;
  right: number;
  bottom: number;
  left: number;
  bottomNav: number;
};

export const ZERO_SAFE_AREA_INSETS: SafeAreaInsets = {
  top: 0,
  right: 0,
  bottom: 0,
  left: 0,
  bottomNav: 0,
};

function toNumber(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function insetsEqual(a: SafeAreaInsets, b: SafeAreaInsets): boolean {
  return (
    a.top === b.top &&
    a.right === b.right &&
    a.bottom === b.bottom &&
    a.left === b.left &&
    a.bottomNav === b.bottomNav
  );
}

function measure(probe: HTMLDivElement): SafeAreaInsets {
  const computed = getComputedStyle(probe);
  // `--portal-native-bottom-nav-inset` is declared on bare `:root` at every
  // width, so reading it directly would report a nonzero inset even on
  // desktop where the bar isn't rendered. Measure the real bar instead.
  const bottomNavEl = document.querySelector(".portal-native-bottom-nav");
  const bottomNav = bottomNavEl instanceof Element ? bottomNavEl.getBoundingClientRect().height : 0;
  return {
    top: toNumber(computed.paddingTop),
    right: toNumber(computed.paddingRight),
    bottom: toNumber(computed.paddingBottom),
    left: toNumber(computed.paddingLeft),
    bottomNav: Number.isNaN(bottomNav) ? 0 : bottomNav,
  };
}

export function useSafeAreaInsets(): SafeAreaInsets {
  const [insets, setInsets] = useState<SafeAreaInsets>(ZERO_SAFE_AREA_INSETS);

  useEffect(() => {
    if (typeof window === "undefined" || typeof document === "undefined") return;

    const probe = document.createElement("div");
    probe.style.position = "fixed";
    probe.style.visibility = "hidden";
    probe.style.pointerEvents = "none";
    probe.style.top = "0";
    probe.style.left = "0";
    probe.style.paddingTop = "env(safe-area-inset-top, 0px)";
    probe.style.paddingRight = "env(safe-area-inset-right, 0px)";
    probe.style.paddingBottom = "env(safe-area-inset-bottom, 0px)";
    probe.style.paddingLeft = "env(safe-area-inset-left, 0px)";
    document.body.appendChild(probe);

    const remeasure = () => {
      const next = measure(probe);
      setInsets((prev) => (insetsEqual(prev, next) ? prev : next));
    };

    remeasure();

    window.addEventListener("resize", remeasure);
    window.visualViewport?.addEventListener("resize", remeasure);

    return () => {
      window.removeEventListener("resize", remeasure);
      window.visualViewport?.removeEventListener("resize", remeasure);
      probe.remove();
    };
  }, []);

  return insets;
}
