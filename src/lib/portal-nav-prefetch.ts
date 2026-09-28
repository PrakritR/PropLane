/** Turbopack recompiles each dynamic import in dev — skip background warming locally. */
export function portalBackgroundPrefetchEnabled(): boolean {
  return false;
}

/** Mobile tab bar: avoid route prefetch competing with the tab the user just tapped. */
export function portalMobileLinkPrefetchEnabled(): boolean {
  return false;
}

/** Desktop links may warm their destination after an explicit hover intent. */
export function portalIntentPrefetchEnabled(): boolean {
  return process.env.NODE_ENV === "production";
}
