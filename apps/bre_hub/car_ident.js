'use strict';
/**
 * car_ident.js - which car this is, for the picture on the first page.
 *
 * The "carModel" setting names it, or (Auto) it is read from the car: the VIN as the DME has it (22 F190,
 * read only, dme_link.js), of which only the type key is used - characters 4 to 7, which name the model and
 * engine and say nothing about the one car. The VIN itself is never logged and never saved (docs/10, rule 7);
 * the model found is kept in data/bre_car.json, so the next start draws it at once.
 *
 * TYPE_KEYS is the table of type keys we know. It is short on purpose and NOT YET CONFIRMED ON A CAR: the
 * G30 530i keys are from public parts catalogues, from memory. A key that is not in it is logged once
 * ("type key XXXX"), so it can be added; the picture then stays the default model's.
 */
const fs = require('fs');
const path = require('path');

const MODELS = {
    g30: { id: 'g30', name: 'BMW 5 Series', code: 'G30', body: 'Sedan', shape: 'sedan' },
};
const DEFAULT_MODEL = 'g30';          // the project's test car (CLAUDE.md)

// VIN characters 4-7 -> model. To be confirmed on the car (see the top of this file).
const TYPE_KEYS = {
    JA51: 'g30', JA52: 'g30', JA53: 'g30',      // 530i (pre-LCI)
};

/** The type key of a VIN (characters 4 to 7), or null. */
function typeKey(vin) {
    const s = String(vin || '').toUpperCase();
    return /^[A-HJ-NPR-Z0-9]{17}$/.test(s) ? s.slice(3, 7) : null;
}

class CarIdent {
    /** o.link: DmeLink or null; o.settings; o.log; o.dataDir */
    constructor(o) {
        this.link = o.link || null; this.settings = o.settings; this.log = o.log;
        this.file = path.join(o.dataDir || '.', 'bre_car.json');
        this.detected = null;         // a MODELS id read from the car
        this.unknownKey = null;       // a type key that is not in the table
        this.asked = false;
        try {
            const m = JSON.parse(fs.readFileSync(this.file, 'utf8')).model;
            if (MODELS[m]) this.detected = m;
        } catch (e) { /* not yet */ }
    }

    /** Read the car once the diagnostic link is up (read only). Resolves true when a model was found. */
    async detect() {
        if (this.asked || !this.link || !this.link.available) return false;
        this.asked = true;
        let key = null;
        try { key = typeKey(await this.link.readVin()); } catch (e) { key = null; }
        if (!key) { this.asked = false; return false; }          // no answer yet (the DME asleep): ask again later
        const model = TYPE_KEYS[key] || null;
        if (!model) {
            this.unknownKey = key;
            if (this.log) this.log.info('car: type key ' + key + ' is not in the table (car_ident.js); drawing the default model');
            return false;
        }
        if (this.log) this.log.info('car: type key ' + key + ' -> ' + MODELS[model].code);
        if (model !== this.detected) {
            this.detected = model;
            try { fs.writeFileSync(this.file, JSON.stringify({ model: model })); } catch (e) { if (this.log) this.log.warn('car: save failed ' + e); }
        }
        return true;
    }

    /** The model to draw: the setting's, else the car's own, else the default. source: 'setting' | 'car' | 'default'. */
    model() {
        const s = this.settings.get('carModel');
        if (s && s !== 'auto' && MODELS[s]) return Object.assign({ source: 'setting' }, MODELS[s]);
        if (this.detected) return Object.assign({ source: 'car' }, MODELS[this.detected]);
        return Object.assign({ source: 'default' }, MODELS[DEFAULT_MODEL]);
    }
}

module.exports = { CarIdent, MODELS, TYPE_KEYS, DEFAULT_MODEL, typeKey };
