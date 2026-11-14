'use strict';
/**
 * bre_text.js - the UI texts of BRE Hub: English (the default and the fallback) and Romanian.
 *
 * The kit's baked font atlases have no Romanian diacritics yet (docs/03, docs/08): plain() maps
 * ă â î ș ț (and „ ”) to their base letters so nothing draws wrong. Re-bake the atlases with the
 * extended charset, note it in kit/PATCHES.md, then set FONT_HAS_RO to true.
 */
const FONT_HAS_RO = false;

const BASE = { 'ă': 'a', 'â': 'a', 'î': 'i', 'ș': 's', 'ş': 's', 'ț': 't', 'ţ': 't',
    'Ă': 'A', 'Â': 'A', 'Î': 'I', 'Ș': 'S', 'Ş': 'S', 'Ț': 'T', 'Ţ': 'T', '„': '"', '”': '"' };

function plain(s) {
    const str = String(s);
    return FONT_HAS_RO ? str : str.replace(/[ăâîșşțţĂÂÎȘŞȚŢ„”]/g, (c) => BASE[c]);
}

const TEXTS = {
    en: {
        'on': 'On', 'off': 'Off',
        'menu.seat': 'Seat Easy Access', 'menu.exhaust': 'Exhaust flap', 'menu.paint': 'Paint', 'menu.settings': 'Settings',
        'chip.demo': 'Demo', 'chip.parked': 'Parked', 'chip.moving': 'Driving',
        'seats.easy': 'Easy Access', 'seats.offset': 'Move back to',
        'seats.tryOut': 'Try: get out', 'seats.tryIn': 'Try: get in', 'seats.stop': 'Stop', 'seats.reset': 'Ready again',
        'seats.parkedOnly': 'Only while parked', 'seats.demo': 'Demo: the real seat does not move',
        'state.IDLE': 'Driving position', 'state.MOVING_OUT': 'Moving back and down',
        'state.OUT': 'Exit position', 'state.MOVING_IN': 'Returning to the driving position', 'state.STOPPED': 'Stopped',
        'ee.stoppedMoved': 'Stopped: the car moved', 'ee.ready': 'Ready again',
        'ee.movingOut': 'Moving to the exit position', 'ee.atExit': 'At the exit position',
        'ee.notFinished': 'The move did not finish', 'ee.movingIn': 'Returning to the driving position',
        'ee.atDrive': 'Back in the driving position', 'ee.manual': 'Stopped by hand',
        'seats.module': 'Seat module', 'probe.module': 'Driver\'s seat module',
        'probe.found': 'Found', 'probe.notInit': 'Found, not initialised', 'probe.none': 'No answer',
        'probe.reading': 'Reading', 'probe.noLink': 'No diagnostic link',
        'axis.slv': 'Fore / aft', 'axis.shv': 'Height', 'axis.lnv': 'Backrest',
        'probe.noSensor': 'Motor, no sensor', 'probe.notFitted': 'Not fitted',
        'probe.buttons': 'Seat buttons', 'probe.pressed': 'Pressed', 'probe.released': 'Not pressed',
        'probe.resetTravel': 'Forget the measured ends', 'probe.pctBack': '{pct} % back', 'probe.pctUp': '{pct} % up',
        'probe.foot': 'Read only · move the seat end to end with its buttons', 'probe.why': 'No answer: {reason}',
        'probe.exit': 'Exit at {pct} %: fore/aft {fore}, height {height}',
        'ex.open': 'Open', 'ex.closed': 'Closed', 'ex.auto': 'Auto', 'ex.drive': 'By driving mode',
        'ex.modes': 'Driving modes', 'ex.hold': 'Hold', 'ex.holdValue': 'every 15 s',
        'group.sport': 'Sport', 'group.comfort': 'Comfort', 'group.eco': 'Eco Pro',
        'ex.simulated': 'Simulated · arm it in Settings', 'ex.armed': 'Armed', 'ex.holding': 'Armed · holding',
        'ex.noFlap': 'No electric flap found on this engine', 'ex.noLink': 'No link to the engine yet',
        'ex.rpmLost': 'No engine speed · Auto · select Closed again', 'ex.pausedNoRpm': 'No engine speed · Closed paused',
        'ex.pausedRpm': 'Closed paused above {rpm} rpm', 'ex.notTaken': 'The engine did not take it',
        'car.fromCar': 'read from the car', 'page.error': 'Page error - see the log',
    },
    ro: {
        'on': 'Pornit', 'off': 'Oprit',
        'menu.seat': 'Seat Easy Access', 'menu.exhaust': 'Clapetă evacuare', 'menu.paint': 'Culoare', 'menu.settings': 'Setări',
        'chip.demo': 'Demo', 'chip.parked': 'Parcat', 'chip.moving': 'În mers',
        'seats.easy': 'Easy Access', 'seats.offset': 'Mută în spate la',
        'seats.tryOut': 'Probă: coborâre', 'seats.tryIn': 'Probă: urcare', 'seats.stop': 'Stop', 'seats.reset': 'Pregătit din nou',
        'seats.parkedOnly': 'Doar cu mașina parcată', 'seats.demo': 'Demo: nu mișcă scaunul real',
        'state.IDLE': 'Poziție de condus', 'state.MOVING_OUT': 'Se duce în spate și în jos',
        'state.OUT': 'Poziție de coborâre', 'state.MOVING_IN': 'Revine la poziția de condus', 'state.STOPPED': 'Oprit',
        'ee.stoppedMoved': 'Oprit: mașina s-a pus în mișcare', 'ee.ready': 'Pregătit din nou',
        'ee.movingOut': 'Merge la poziția de coborâre', 'ee.atExit': 'A ajuns la poziția de coborâre',
        'ee.notFinished': 'Mișcarea nu s-a terminat', 'ee.movingIn': 'Revine la poziția de condus',
        'ee.atDrive': 'A revenit la poziția de condus', 'ee.manual': 'Oprit manual',
        'seats.module': 'Modulul scaunului', 'probe.module': 'Modulul scaunului șoferului',
        'probe.found': 'Găsit', 'probe.notInit': 'Găsit, neinițializat', 'probe.none': 'Nu răspunde',
        'probe.reading': 'Citește', 'probe.noLink': 'Fără legătură de diagnoză',
        'axis.slv': 'Față / spate', 'axis.shv': 'Înălțime', 'axis.lnv': 'Spătar',
        'probe.noSensor': 'Motor, fără senzor', 'probe.notFitted': 'Nu există',
        'probe.buttons': 'Butoanele scaunului', 'probe.pressed': 'Apăsate', 'probe.released': 'Neapăsate',
        'probe.resetTravel': 'Șterge capetele măsurate', 'probe.pctBack': '{pct} % în spate', 'probe.pctUp': '{pct} % sus',
        'probe.foot': 'Doar citire · mută scaunul cap-coadă din butoane', 'probe.why': 'Nu răspunde: {reason}',
        'probe.exit': 'Coborâre la {pct} %: față/spate {fore}, înălțime {height}',
        'ex.open': 'Deschisă', 'ex.closed': 'Închisă', 'ex.auto': 'Auto', 'ex.drive': 'După modul de condus',
        'ex.modes': 'Moduri de condus', 'ex.hold': 'Menține', 'ex.holdValue': 'la 15 s',
        'group.sport': 'Sport', 'group.comfort': 'Comfort', 'group.eco': 'Eco Pro',
        'ex.simulated': 'Simulat · armează din Setări', 'ex.armed': 'Armat', 'ex.holding': 'Armat · menține',
        'ex.noFlap': 'Motorul nu are clapetă electrică', 'ex.noLink': 'Încă fără legătură cu motorul',
        'ex.rpmLost': 'Fără turație · Auto · alege din nou Închisă', 'ex.pausedNoRpm': 'Fără turație · Închisă în pauză',
        'ex.pausedRpm': 'Închisă în pauză peste {rpm} rpm', 'ex.notTaken': 'Motorul nu a acceptat comanda',
        'car.fromCar': 'citit din mașină', 'page.error': 'Eroare pe pagină - vezi log-ul',
    },
};

let lang = 'en';

function setLanguage(l) { lang = TEXTS[l] ? l : 'en'; }

/** The text for key in the current language, {name} placeholders filled from vars, made drawable. */
function T(key, vars) {
    let s = (TEXTS[lang] && TEXTS[lang][key]) || TEXTS.en[key] || key;
    if (vars) Object.keys(vars).forEach((k) => { s = s.split('{' + k + '}').join(String(vars[k])); });
    return plain(s);
}

module.exports = { T, plain, setLanguage, FONT_HAS_RO };
