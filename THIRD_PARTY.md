# Cod și resurse de la terți

| Ce | De unde | Licență | Unde e la noi |
| --- | --- | --- | --- |
| Kitul pentru aplicații MGU (runtime, build, emulator, unelte) | [cauliflowermossgrape/idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), commit-ul din `kit/SOURCE.json` | MIT, Copyright (c) 2026 cauliflowermossgrape (`kit/LICENSE.idrive7-apps`) | `kit/` |
| Rendererul GPU mgu-render (sursă și binar prebuilt) | idrive7-apps `kit/renderd`, bazat pe [robertnisipeanu/mgu-store](https://github.com/robertnisipeanu/mgu-store) | GPL-3.0-or-later, Copyright (C) 2026 Robert Nisipeanu și IterioDev (`kit/renderd/LICENSE`); părțile preluate din primul renderer și controller gate-ul sunt MIT | `kit/renderd/` |
| Motorul de desen al emulatorului (WebAssembly) | idrive7-apps `kit/emu` | GPL-3.0-or-later pentru build-ul motorului | `kit/emu/` |
| Clapeta de evacuare: legătura cu DME-ul și logica (ținere la 15 s, protecția la turație, modul de condus) | idrive7-apps `apps/live_adjustments` (Engine Config), commit `8d860de5818a2da11d3a3750aab36866cecf6bde` | MIT, Copyright (c) 2026 cauliflowermossgrape (`apps/bre_hub/NOTICE`) | `apps/bre_hub/dme_link.js`, `apps/bre_hub/exhaust.js` (adaptate) |
| Imaginea ca celule desenate o dată într-un strat (tehnica și codul de desen) | idrive7-apps `apps/live_adjustments/muffler_img.js`, același commit | MIT, Copyright (c) 2026 cauliflowermossgrape (`apps/bre_hub/NOTICE`) | `apps/bre_hub/car_picture.js` (adaptat) |
| Pozele mașinii, câte una pe culoare | randări de stoc ale BMW Seria 5 (G30 LCI) din profil, de pe static.tcimg.net (TrueCar); lista exactă mai jos | **drepturile aparțin autorilor; nu sunt sub licența noastră.** Fabian a hotărât pe 14.11.2026 să fie incluse în repo-ul public, ca aplicația să le aibă pe mașină | `apps/bre_hub/car_photo_<id>.js`, `car_photos.js` (convertite cu `tools/car_photo.js`) |
| Atlase de fonturi | familia Ubuntu (Ubuntu Font Licence 1.0); Barlow și Noto Sans SC (SIL OFL 1.1, `kit/runtime/fonts/OFL-*.txt`) | vezi coloana anterioară | `kit/runtime/fonts/` |

Aplicațiile din `apps/` sunt ale noastre. Ele încarcă runtime-ul MIT al kitului, care e copiat în pachet la build. Codul GPL (rendererul) rulează separat, ca serviciu, și nu e copiat în aplicații.

**Nu sunt în repo și nu intră niciodată:** SDK-ul BMW (`oap-sdk`), pachetele care îl conțin (`dist/`, `*.mgu`), catalogul SOME/IP al unității, date care identifică o mașină. Regulile despre ce putem prelua din alte proiecte sunt în [docs/02-ecosistem-si-licente.md](docs/02-ecosistem-si-licente.md).

**Pozele mașinii, sursele** (convertite cu `node tools/car_photo.js reference/colours.json`; numele culorilor sunt estimarea noastră după aspect):

- Mineral Grey (`car_photo_mineral.js`): https://static.tcimg.net/vehicles/primary/48a074fc054b2285/2023-BMW-5_Series-gray-full_color-driver_side_profile.png
- Bernina Grey (`car_photo_bernina.js`): https://static.tcimg.net/vehicles/primary/1e17871e8a626b1b/2021-BMW-5_Series-gray-full_color-driver_side_profile.png
- Glacier Silver (`car_photo_glacier.js`): https://static.tcimg.net/vehicles/primary/3d32ffec174fdbfd/2021-BMW-5_Series-silver-full_color-driver_side_profile.png
- Alpine White (`car_photo_alpine.js`): https://static.tcimg.net/vehicles/primary/b80e43b13018498b/2021-BMW-5_Series-white-full_color-driver_side_profile.png
- Carbon Black (`car_photo_carbon.js`): https://static.tcimg.net/vehicles/primary/cef192815b46e1d6/2022-BMW-5_Series-gray-full_color-driver_side_profile.png
- Brooklyn Grey (`car_photo_brooklyn.js`): https://static.tcimg.net/vehicles/primary/ef6484ae3d35d87a/2023-BMW-5_Series-gray-full_color-driver_side_profile.png
