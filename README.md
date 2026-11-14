# BRE MGU Apps

Aplicații proprii pentru unitatea BMW iDrive 7 (MGU), instalate prin [MGU Store](https://github.com/robertnisipeanu/mgu-store). Proiectul începe cu **BRE Hub**, o singură aplicație care unifică și reface cu un design natural aplicațiile din comunitate. Prima funcție nouă e **Easy Entry**: scaunul șoferului se dă înapoi la coborâre și revine la urcare.

> Neoficial, fără legătură cu BMW AG. Modifici propria unitate pe riscul tău. Citește [docs/10-testare-si-siguranta.md](docs/10-testare-si-siguranta.md) înainte de orice test în mașină.

## Ce e în repo

| | |
| --- | --- |
| [`apps/bre_hub/`](apps/bre_hub) | BRE Hub: Acasă, Scaune (Easy Entry în modul demo), Motor; design system și texte RO/EN |
| [`docs/`](docs/README.md) | tot ce știm despre platformă, ecosistem, licențe, design, plan și siguranță |
| [`kit/`](kit/SOURCE.json) | kitul din [idrive7-apps](https://github.com/cauliflowermossgrape/idrive7-apps), neschimbat: runtime, build, emulator |
| [`tests/`](tests) | teste care rulează fără mașină și fără kit |
| [`KICKOFF.md`](KICKOFF.md) | promptul de start pentru Claude Code |
| [`CLAUDE.md`](CLAUDE.md) | regulile proiectului pentru Claude |

## Pornire rapidă

Ai nevoie de Python 3.6+ și Node.js 14+. Pentru emulator și pachete, și de SDK-ul BMW extras din unitatea ta ([docs/03](docs/03-cum-se-face-o-aplicatie.md)).

```sh
node tests/test_seats_backend.js && node tests/smoke_pages.js
python3 kit/tools/build.py bre_hub && node kit/tools/emu.js bre_hub     # http://localhost:8077
```

Pe Windows, emulatorul rulează în container, cu sau fără SDK: `docker compose up --build`, apoi http://localhost:8077 ([docs/03](docs/03-cum-se-face-o-aplicatie.md#emulatorul-pe-windows-în-container)).

## În mașină

Store → Settings → **Add source** → `brefabu/mgu-apps` → **branch (main)** (sau **Tags** pentru versiuni testate). Pentru repo privat, adaugă un token în Settings → Accounts ([docs/04](docs/04-publicare-in-store.md)).

## Licențe

Codul de la terți și licențele lui sunt în [THIRD_PARTY.md](THIRD_PARTY.md). SDK-ul BMW nu e și nu va fi în repo.
