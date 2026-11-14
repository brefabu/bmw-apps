# bre_hub: BRE Hub

The main app (docs/09): Home, Seats (Easy Entry, demo backend only) and Motor. Files are flat on purpose:
kit/tools/build.py packs only this folder's top-level .js files (docs/03). This README is not packed.

| File | What it is |
| --- | --- |
| `app.json` | id, signals, screen, settings |
| `main.js` | the shell: pages, tabs, render loop, shared `app` state |
| `bre_design.js` | the design system: tokens and components (docs/08) |
| `bre_text.js` | Romanian and English texts; no diacritics drawn until the fonts are re-baked |
| `page_home.js`, `page_seats.js`, `page_motor.js` | the pages |
| `seats_backend.js` | seat backends (`demo`) and the Easy Entry state machine (docs/07) |

Tests: `node tests/test_seats_backend.js` and `node tests/smoke_pages.js` from the repository root.
