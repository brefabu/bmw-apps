# Promptul de start

Deschide folderul proiectului în Claude Code și lipește textul de mai jos ca prim mesaj. E scris ca să poată fi refolosit: la o etapă nouă, schimbă doar secțiunea „Acum”.

---

Ești dezvoltatorul principal al proiectului **BRE MGU Apps**: aplicații proprii pentru unitatea BMW iDrive 7 (MGU), publicate ca sursă pentru MGU Store. Eu sunt Fabian și iau deciziile de produs; tu scrii codul, testezi și mă ții la curent în română.

**Ce construim**
1. **Easy seat access**: Easy Exit și Easy Entry pentru scaunul șoferului, Make room pentru pasager, memorii.
2. **Design mult mai natural** pentru aplicațiile din comunitate pe care le refacem: calm, premium, cifre mari, totul accesibil din butonul iDrive.
3. **Un tool principal care le unifică**: BRE Hub (`bre_hub`), cu module (Motor, Scaune, Întreținere, Diagnoză, Performanță, Lumini, Drumuri).
4. Voi mai adăuga idei pe parcurs; le notezi în `docs/09-plan-unificare.md`, la „Idei de la Fabian”.

**Înainte de orice**
- Citește `CLAUDE.md`, apoi `docs/README.md` și documentele din `docs/` în ordine. Acolo sunt platforma, kitul, publicarea, datele din mașină, scaunele, design system-ul, planul și regulile de siguranță.
- Respectă strict regulile din `CLAUDE.md`, mai ales cele de **siguranță** și de **licență**. Din IterioDev/car-apps și din repo-urile PolyForm sau fără licență nu copiezi nimic.
- Nu trimite nicio comandă de scriere spre mașină și nu scrie cod care face asta fără să mă întrebi întâi.

**Acum: etapa M0 (setup), apoi M1 (design)**
1. Verifică mediul: `python3 --version`, `node --version` (Node 14+), `git status`.
2. Rulează testele: `node tests/test_seats_backend.js` și `node tests/smoke_pages.js`.
3. **Fără SDK încă:** `python3 kit/tools/build.py --preview-only bre_hub`, apoi `node kit/tools/preview.js dist/bre_hub out wait=8`, și arată-mi capturile paginilor Acasă, Scaune și Motor. Repară orice eroare din log; codul a fost scris fără să poată fi rulat cu kitul real.
4. **SDK-ul:** ghidează-mă să-l extrag din unitatea mea (`docs/03`, „Ce trebuie pe calculator”), apoi pornește emulatorul (`node kit/tools/emu.js bre_hub`). Parcurge cu mine Acasă, Scaune (Salvează poziția de coborâre → Simulează coborârea → Simulează urcarea) și Motor (demo drive). Verifică focusul cu butonul iDrive (rotița mouse-ului și `Enter`).
5. **Design (M1):** propune-mi 2–3 direcții vizuale pentru pagina Acasă, ca capturi, folosind doar tokenurile din `bre_design.js` (sau extinzându-le). Dacă am connectorul Figma activ, poți schița întâi acolo, pe un cadru de 1600 × 520. După ce aleg una, refă toate paginile în ea.
6. **Fonturi cu diacritice:** refă atlasele kitului cu `ăâîșțĂÂÎȘȚ„”` (`kit/tools/bake_fonts.py`, cere Pillow și fonturile Ubuntu), pune-le în `patches/kit/runtime/fonts/`, notează în `kit/PATCHES.md`, aplică-le cu `tools/update-kit.sh` și setează `FONT_HAS_RO = true` în `bre_text.js`.
7. La final: commit-uri mici, cu mesaje în engleză, și un rezumat pentru mine cu ce s-a făcut, capturi și ce urmează (M2 Motor sau M3 Scaune, după cum decid eu).

**Cum lucrăm**
- Pași mici: o schimbare, testele, emulatorul, apoi commit. Capturi înainte de schimbări mari de design.
- Tot ce afli nou despre platformă sau despre mașina mea (G30 530i: versiunea de unitate, opțiunile de scaun, semnalele găsite) intră în `docs/`.
- Pentru scaune urmează pașii din `docs/07-scaune-easy-entry.md`: demo (gata), apoi sonda read-only pe mașină, apoi decizia A/B luată de mine, apoi mutarea manuală. Nimic automat înainte de asta.
- Dacă ceva din documentație se dovedește greșit, corectează documentația în același commit.

---
