# BRE MGU Apps: instrucțiuni pentru Claude

Proiectul lui Fabian (GitHub `brefabu`, BUN Technologies): aplicații proprii pentru unitatea BMW iDrive 7 (MGU), publicate ca sursă pentru [MGU Store](https://github.com/robertnisipeanu/mgu-store). Scopul: **o aplicație principală, BRE Hub (`bre_hub`)**, care unifică și reface cu un design natural aplicațiile din comunitate. Prima funcție nouă e **Easy Entry** pentru scaune. Planul e în `docs/09-plan-unificare.md`.

## Limbă

- Cu Fabian vorbești **în română**. Documentația din `docs/` e în română.
- Codul, comentariile, mesajele de commit și log-urile sunt **în engleză**.
- Textele din interfață trec prin `apps/bre_hub/bre_text.js` (RO și EN), niciodată scrise direct în pagini.

## Structura

```
apps/bre_hub/        aplicația principală (fișiere plate: build-ul ia doar .js-urile de pe primul nivel)
  main.js            shell: pagini, tab-uri, bucla de desen, setări
  bre_design.js      design system: tokenuri și componente (docs/08)
  bre_text.js        texte RO/EN; fără diacritice până refacem fonturile
  page_*.js          paginile/modulele
  seats_backend.js   backend-urile de scaune (doar demo acum) și mașina de stări Easy Entry (docs/07)
kit/                 copia NESCHIMBATĂ a kitului idrive7-apps (MIT; renderd și emu GPL-3.0); vezi kit/SOURCE.json
patches/kit/         singurele noastre modificări la kit (de exemplu fonturi cu diacritice), notate în kit/PATCHES.md
tools/update-kit.sh  aduce kitul din upstream și aplică patches/kit/
tests/               teste fără mașină și fără kit (node tests/<fișier>.js)
docs/                tot ce știm despre platformă, ecosistem, licențe, design, plan, siguranță
mgu-repo.json        manifestul de sursă pentru MGU Store (docs/04)
```

## Comenzi

```sh
node tests/test_seats_backend.js && node tests/smoke_pages.js   # înainte de fiecare commit
python3 kit/tools/build.py bre_hub                               # build; cere oap-sdk/ extras din unitate (docs/03)
node kit/tools/emu.js bre_hub                                    # emulatorul: http://localhost:8077 (cere și el oap-sdk/)
python3 kit/tools/build.py --preview-only bre_hub                # fără SDK: doar previzualizare offline
node kit/tools/preview.js dist/bre_hub out wait=8                # capturi PNG ale paginilor
sh tools/update-kit.sh [commit]                                  # actualizare kit, apoi testele și emulatorul
```

## Reguli

**Platformă (docs/01, 03)**
- Aplicațiile rulează pe **Node 8**: fără `?.`, `??`, object spread, `catch {}` fără variabilă, `Array.prototype.flat`, `Object.fromEntries`; fără pachete npm.
- Fișiere **plate** în folderul aplicației; modulele se cer cu `require('./nume')`, kitul cu `require('./kit/<modul>')`.
- Id-uri cu prefixul **`bre_`**, `loggingId` unic (`BRE1`, `BRE2` ...), `mguHmi` declarat.
- **Nu modifica `kit/`.** O schimbare inevitabilă intră în `patches/kit/` și în `kit/PATCHES.md`.
- Nu intră în git: `oap-sdk/`, `dist/`, `*.mgu`, `reference/`, nimic ce identifică mașina (VIN, chei, provisioning).

**Licențe (docs/02)**
- Cod copiat **doar din proiecte MIT**, cu sursa, commit-ul și licența în capul fișierului și un `NOTICE` în folderul aplicației.
- Din **IterioDev/car-apps** (PolyForm Strict), **eroobeeroo**, **WoodyCode23** (PolyForm Noncommercial) și repo-urile **fără licență** (aurelmarius, selcip) nu copiem nimic; doar învățăm.
- Codul GPL (mgu-render, cluster-render) se folosește ca serviciu separat, nu se copiază în aplicațiile noastre.

**Siguranță (docs/07, 10): nenegociabile**
- Orice scrie în mașină sau mișcă ceva pornește **dezarmat** și se armează explicit din setări.
- Mișcare automată doar **parcat**; viteza > 0 oprește tot. Comenzile de mișcare sunt **„om mort”** (se reînnoiesc, altfel se opresc), au **limită de timp** și se opresc fără progres.
- **Butoanele fizice ale mașinii au prioritate.** Fără ștergere de erori, scrieri de coding sau flash din aplicațiile BRE.
- **Întreabă-l pe Fabian înainte** de orice cod care trimite comenzi de scriere spre mașină (UDS `2E`/`2F`/`31`, setter SOME/IP) și înainte de primul test pe mașină al unei astfel de funcții.

**Design (docs/08)**
- Doar tokenurile și componentele din `bre_design.js`. O culoare sau o mărime nouă intră întâi acolo.
- Doar mărimile de font coapte în atlase. Pagina are 1600 × 520; grila are 4 coloane de 376, cu 16 între ele și 24 margine.
- Orice acțiune se poate face și cu butonul iDrive; în mers, doar informații de o privire.

**Cum lucrăm**
- Pași mici: o schimbare, testele, emulatorul, apoi commit. Arată-i lui Fabian capturi înainte de schimbări mari de design.
- Când afli ceva nou despre platformă sau despre mașină, scrie-l în `docs/`: documentația e memoria proiectului.
- Mașina de test: **BMW 530i G30** (de confirmat pe unitate: iDrive 7 / MGU, versiunea de firmware, ce opțiuni de scaun are).
