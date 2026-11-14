# bre_hub: BRE Hub ("My car")

The main app (docs/09). One page, laid out like iDrive 7's My Vehicle: a list on the left that folds away, the
car on the right with a hot spot on the driver's seat and one at the tailpipe. Files are flat on purpose:
kit/tools/build.py packs only this folder's top-level .js files (docs/03). This README and NOTICE are not packed.

| File | What it is |
| --- | --- |
| `app.json` | id, signals, screen, settings |
| `main.js` | the shell: shared `app` state, render loop, settings, the car's signals |
| `bre_design.js` | the design system: tokens and components (docs/08) |
| `bre_text.js` | English (default) and Romanian texts; no diacritics drawn until the fonts are re-baked |
| `page_home.js` | the page: the lists (main, seat, exhaust, driving modes, paint) and the car |
| `car_art.js` | the car, drawn from the side (used when no photograph is packed); paints |
| `car_picture.js` | the car's photograph, one per paint: cells drawn once into a cached layer; only the paint shown is loaded |
| `car_photos.js`, `car_photo_<id>.js` | the photographs, made by `node tools/car_photo.js reference/colours.json`. Stock renders, not ours: see THIRD_PARTY.md |
| `car_ident.js` | which car it is: the setting, or the VIN's type key read from the DME (read only; table not yet confirmed on a car) |
| `seats_backend.js` | seat backends (`demo` only) and Seat Easy Access: back to 75 % of the rail and fully down (docs/07). Not the DEMO switch: that one (the kit's `demo` setting, Off by default) only picks the car's own signals or a simulated drive |
| `dme_link.js` | the only file that writes to the car: three reads and the exhaust flap's three `2F 60FD` requests |
| `seat_link.js` | the seat probe, read only: `22 D700 / D702 / D704 / D708 / D712` from the driver's seat module (0x6D), its axes, positions (Hall counters), motors and switches; the measured travel and the learned counter directions in `bre_seat_travel.json` |
| `seat_drive.js` | the only file that writes to the seat module: `10 03` (extended session) before a move, `2E D708` for fore / aft and height (PLUS / MINUS / STOP), `3E 00` while it runs, `10 01` (default session) when it ends. Moves one axis at a time and stops on arrival, the wrong way, no progress, a time limit, a seat switch, not parked or Stop; STOP always ends a move. Only with Seat Easy Access on "Armed" |
| `exhaust.js` | the exhaust flap: Open / Closed / Auto / by driving mode, held every 15 s, Closed handed back above a set engine speed. Ships disarmed (simulated) |
| `NOTICE` | source and licence of the code adapted from idrive7-apps Engine Config (MIT) |

Tests, from the repository root: `node tests/test_seats_backend.js`, `node tests/test_exhaust.js`,
`node tests/test_seat_link.js`, `node tests/test_seat_drive.js` and `node tests/smoke_pages.js`.

Before the first test on a car: the exhaust flap stays Disarmed until its command was checked on that car
(docs/06, docs/10). Armed, it writes only when the DME answers the flap's identifiers.
