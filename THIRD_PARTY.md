# Cod și resurse de la terți

| Ce | De unde | Licență | Unde e la noi |
| --- | --- | --- | --- |
| Kitul pentru aplicații MGU (runtime, build, emulator, unelte) | [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), commit-ul din `kit/SOURCE.json` | MIT, Copyright (c) 2026 cauliflowermossgrape (`kit/LICENSE.idrive7-apps`) | `kit/` |
| Rendererul GPU mgu-render (sursă și binar prebuilt) | idrive7-apps `kit/renderd`, bazat pe [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) | GPL-3.0-or-later, Copyright (C) 2026 Robert Nisipeanu și IterioDev (`kit/renderd/LICENSE`); părțile preluate din primul renderer și controller gate-ul sunt MIT | `kit/renderd/` |
| Motorul de desen al emulatorului (WebAssembly) | idrive7-apps `kit/emu` | GPL-3.0-or-later pentru build-ul motorului | `kit/emu/` |
| Clapeta de evacuare: legătura cu DME-ul și logica (ținere la 15 s, protecția la turație, modul de condus) | idrive7-apps `apps/live_adjustments` (Engine Config), commit `8d860de5818a2da11d3a3750aab36866cecf6bde` | MIT, Copyright (c) 2026 cauliflowermossgrape (`apps/bre_hub/NOTICE`) | `apps/bre_hub/dme_link.js`, `apps/bre_hub/exhaust.js` (adaptate) |
| Atlase de fonturi | familia Ubuntu (Ubuntu Font Licence 1.0); Barlow și Noto Sans SC (SIL OFL 1.1, `kit/runtime/fonts/OFL-*.txt`) | vezi coloana anterioară | `kit/runtime/fonts/` |

Aplicațiile din `apps/` sunt ale noastre. Ele încarcă runtime-ul MIT al kitului, care e copiat în pachet la build. Codul GPL (rendererul) rulează separat, ca serviciu, și nu e copiat în aplicații.

**Nu sunt în repo și nu intră niciodată:** SDK-ul BMW (`oap-sdk`), pachetele care îl conțin (`dist/`, `*.mgu`), catalogul SOME/IP al unității, date care identifică o mașină. Regulile despre ce putem prelua din alte proiecte sunt în [docs/02-ecosistem-si-licente.md](docs/02-ecosistem-si-licente.md).
