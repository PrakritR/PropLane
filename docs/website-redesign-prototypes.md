# Website Redesign Prototypes

These are structural explorations for the shared portal list-page archetype, using Manager Tours as the representative surface. They preserve the current Blue Steel brand and real seeded record structure. They are not implementation screenshots.

## Decision criteria

Each direction must:

- identify the page and current queue immediately;
- expose one clear primary action;
- keep search, filter, and settings available without presenting them as equal calls to action;
- place real records above the fold;
- adapt to responsive web without shrinking labels below a readable size;
- generalize to Properties, Applications, Residents, Services, Payments, Documents, and Communication;
- retain semantic links for routed destinations and accessible buttons for commands.

## Direction 01 — Adaptive command strip

![Adaptive command strip](../output/design-prototypes/tours/01-adaptive-command-strip.png)

**The roll.** A single contained command strip combines compact destination tabs, search, active-filter count, settings, and one compact primary action. On top-level portal queues, the active persistent navigation supplies the visible page identity and the semantic `h1` remains visually hidden; detail and standalone pages retain visible titles.

Best fit:

- the default list-page archetype;
- pages with three to five destinations and lightweight filtering;
- responsive conversion to a destination picker plus filter sheet.

Tradeoffs:

- requires a disciplined overflow priority algorithm;
- must avoid turning the strip into another crowded band on pages with many page-specific controls.

## Direction 02 — Split control bar

![Split control bar](../output/design-prototypes/tours/02-split-control-bar.png)

Status navigation and list commands share one horizontal baseline without a containing card. The result list behaves like a calm operational table.

Best fit:

- dense manager/admin tables;
- destinations where column comparison matters;
- pages with few filters and stable desktop layouts.

Tradeoffs:

- search and commands can compete with status navigation at intermediate widths;
- mobile requires an earlier and more explicit collapse into stacked rows.

## Direction 03 — Context sidebar

![Context sidebar](../output/design-prototypes/tours/03-context-sidebar.png)

A local sidebar makes queue state and persistent filters visible while the main pane focuses on results.

Best fit:

- advanced filtering, faceting, and high-volume queues;
- pages such as Applications, Documents, or large resident/property catalogs;
- workflows where filters remain active while users inspect many records.

Tradeoffs:

- consumes horizontal space and is unnecessary for simple three-state queues;
- must become a drawer or sheet on narrow screens;
- should be an optional high-complexity variant, not the universal default.

## Proposed synthesis after selection

The selected direction will define the default `PortalCommandBar` composition. Useful elements from the other directions can remain explicit variants rather than page-level one-offs:

- `compact`: tabs/search/actions on one strip;
- `table`: split navigation and aligned table commands;
- `faceted`: persistent desktop context sidebar with a mobile filter sheet.

The component standard will be finalized only after the default direction is locked, so implementation rules describe one coherent system rather than preserving three competing defaults.
