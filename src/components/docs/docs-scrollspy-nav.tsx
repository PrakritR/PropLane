"use client";

import { useEffect, useMemo, useState } from "react";

export type DocsNavLink = {
  id: string;
  label: string;
};

export type DocsNavGroup = {
  group: string;
  links: DocsNavLink[];
};

type SectionPosition = {
  id: string;
  top: number;
};

type ActiveSectionInput = {
  sections: SectionPosition[];
  viewportHeight: number;
  documentHeight: number;
  scrollY: number;
};

/**
 * Selects the section that has crossed the reading marker. The final section
 * wins at the end of the document, even when it is too short to reach that
 * marker on its own.
 */
export function resolveDocsActiveSection({
  sections,
  viewportHeight,
  documentHeight,
  scrollY,
}: ActiveSectionInput): string | undefined {
  if (sections.length === 0) return undefined;

  const finalSection = sections.at(-1)!;
  if (documentHeight > 0 && scrollY + viewportHeight >= documentHeight - 1) {
    return finalSection.id;
  }

  const readingMarker = Math.max(0, viewportHeight * 0.3);
  let activeId = sections[0].id;

  for (const section of sections) {
    if (section.top > readingMarker) break;
    activeId = section.id;
  }

  return activeId;
}

/** Returns a known section id from a location hash, never an untrusted id. */
export function docsActiveIdFromHash(hash: string, sectionIds: readonly string[]): string | undefined {
  let id = "";
  if (hash.startsWith("#")) {
    try {
      id = decodeURIComponent(hash.slice(1));
    } catch {
      return undefined;
    }
  }
  return sectionIds.includes(id) ? id : undefined;
}

export function DocsScrollspyNav({ groups, ariaLabel = "Docs sections", dataAttrPrefix = "docs-scrollspy" }: {
  groups: DocsNavGroup[];
  ariaLabel?: string;
  /** Lets each docs route retain distinct analytics and test locators. */
  dataAttrPrefix?: string;
}) {
  const sectionIds = useMemo(() => groups.flatMap((group) => group.links.map((link) => link.id)), [groups]);
  const [activeId, setActiveId] = useState(sectionIds[0]);

  useEffect(() => {
    const selectFromViewport = () => {
      const sections = sectionIds.flatMap((id) => {
        const element = document.getElementById(id);
        return element ? [{ id, top: element.getBoundingClientRect().top }] : [];
      });
      const nextId = resolveDocsActiveSection({
        sections,
        viewportHeight: window.innerHeight,
        documentHeight: document.documentElement.scrollHeight,
        scrollY: window.scrollY,
      });
      if (nextId) setActiveId(nextId);
    };

    const selectFromHash = () => {
      const hashId = docsActiveIdFromHash(window.location.hash, sectionIds);
      if (hashId) {
        setActiveId(hashId);
      } else {
        selectFromViewport();
      }
    };

    let frame: number | undefined;
    const onScroll = () => {
      if (frame !== undefined) return;
      frame = window.requestAnimationFrame(() => {
        frame = undefined;
        selectFromViewport();
      });
    };

    selectFromHash();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    window.addEventListener("hashchange", selectFromHash);

    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      window.removeEventListener("hashchange", selectFromHash);
    };
  }, [sectionIds]);

  return (
    <nav
      aria-label={ariaLabel}
      className="rounded-xl border border-border bg-card p-4 lg:sticky lg:top-24 lg:h-fit lg:max-h-[calc(100dvh-7rem)] lg:overflow-y-auto lg:overscroll-contain lg:rounded-none lg:border-0 lg:bg-transparent lg:px-1 lg:pb-1 lg:pt-0"
    >
      <div className="mb-3 px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60 lg:hidden">
        On this page
      </div>
      {groups.map((group) => (
        <div key={group.group} className="mb-5 last:mb-0">
          <div className="px-2 text-[11px] font-medium uppercase tracking-[0.08em] text-muted/60">
            {group.group}
          </div>
          <ul className="mt-1.5 space-y-0.5 border-l border-border lg:pl-0">
            {group.links.map((link) => {
              const isActive = link.id === activeId;
              return (
                <li key={link.id}>
                  <a
                    href={`#${link.id}`}
                    aria-current={isActive ? "location" : undefined}
                    data-attr={`${dataAttrPrefix}-${link.id}`}
                    onClick={() => setActiveId(link.id)}
                    className={`-ml-px flex min-h-10 items-center border-l px-3 py-2 text-[13px] transition-colors focus-visible:relative focus-visible:z-10 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                      isActive
                        ? "border-primary bg-primary/10 font-medium text-primary"
                        : "border-transparent text-muted hover:border-primary hover:text-foreground"
                    }`}
                  >
                    {link.label}
                  </a>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
