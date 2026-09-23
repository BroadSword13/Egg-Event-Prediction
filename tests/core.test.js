'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
[
  'src/config.js',
  'data/seed-events.js',
  'src/utils.js',
  'src/clock.js',
  'src/store.js',
  'src/wasmegg.js',
  'src/model.js'
].forEach(file => require(path.join(root, file)));

const app = globalThis.EggEventLab;
const { config, utils, store, wasmegg, model } = app;

function timestamp(dateString) {
  return Date.parse(`${dateString}T12:00:00Z`) / 1000;
}

test('release is v0.6 and matches VERSION', () => {
  assert.equal(config.APP_VERSION, '0.6');
  assert.equal(require('node:fs').readFileSync(path.join(root, 'VERSION'), 'utf8').trim(), '0.6');
});

test('date helpers preserve calendar-day arithmetic', () => {
  assert.equal(utils.addDays('2026-09-10', 7), '2026-09-17');
  assert.equal(utils.diffDays('2026-09-01', '2026-09-10'), 9);
});

test('forecast reference advances with the Pacific event day but never moves backward', () => {
  assert.equal(utils.advanceForecastReference('2026-09-10', '2026-09-11'), '2026-09-11');
  assert.equal(utils.advanceForecastReference('', '2026-09-11'), '2026-09-11');
  assert.equal(utils.advanceForecastReference('2026-09-12', '2026-09-11'), '2026-09-12');
});


test('Pacific event day rolls over at 9 AM and local display dates adjust internationally', () => {
  assert.equal(utils.eventDateForInstant(new Date('2026-09-10T15:59:59Z')), '2026-09-09');
  assert.equal(utils.eventDateForInstant(new Date('2026-09-10T16:00:00Z')), '2026-09-10');
  assert.equal(utils.eventInstantForDate('2026-09-10').toISOString(), '2026-09-10T16:00:00.000Z');
  assert.equal(utils.eventInstantForDate('2026-12-10').toISOString(), '2026-12-10T17:00:00.000Z');
  assert.equal(utils.eventDisplayDateIso('2026-09-10', 'America/New_York'), '2026-09-10');
  assert.equal(utils.eventDisplayDateIso('2026-09-10', 'Asia/Tokyo'), '2026-09-11');
  assert.equal(utils.modelDateForDisplayDate('2026-09-11', 'Asia/Tokyo'), '2026-09-10');
});

test('Egg Day is excluded from model history', () => {
  assert.equal(store.getAllEventDates('drone_pink').includes('2026-07-14'), true);
  assert.equal(store.modelDates('drone_pink').includes('2026-07-14'), false);
});

test('known event conflicts are enforced without inventing extra conflicts', () => {
  assert.equal(model.conflicts('housing_blue', 'shipping_blue'), true);
  assert.equal(model.conflicts('housing_blue', 'drone_green'), true);
  assert.equal(model.conflicts('housing_blue', 'housing_pink'), true);
  assert.equal(model.conflicts('drone_green', 'drone_pink'), true);
  assert.equal(model.conflicts('housing_blue', 'blocker_gifts'), true);
  assert.equal(model.conflicts('housing_pink', 'blocker_ultra_gifts'), true);
  assert.equal(model.conflicts('drone_pink', 'blocker_ultra_fueling'), true);

  assert.equal(model.conflicts('housing_pink', 'drone_green'), false);
  assert.equal(model.conflicts('housing_blue', 'blocker_ultra_gifts'), false);
  assert.equal(model.conflicts('housing_pink', 'blocker_gifts'), false);
  assert.equal(model.conflicts('blocker_gifts', 'blocker_fueling'), true);
  assert.equal(model.conflicts('blocker_ultra_gifts', 'blocker_ultra_fueling'), false);
  assert.equal(model.conflicts('blocker_gifts', 'blocker_ultra_gifts'), true);
  assert.equal(model.conflicts('blocker_gifts', 'blocker_ultra_fueling'), false);
});

test('Wasmegg mappings cover all tracked event types', () => {
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'hab-sale', ultra: false }), 'housing_blue');
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'hab-sale', ultra: true }), 'housing_pink');
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'mission-capacity', multiplier: 2, ultra: false }), 'capacity_purple');
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'gift-boost', multiplier: 2, ultra: false }), 'blocker_gifts');
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'gift-boost', multiplier: 2, ultra: true }), 'blocker_ultra_gifts');
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'boost-duration', multiplier: 2, ultra: true }), 'blocker_ultra_boost_duration');
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'shell-sale', multiplier: 0.85, ultra: true }), 'blocker_ultra_shells');
  assert.equal(wasmegg.mapWasmeggEvent({ type: 'mission-fuel', multiplier: 3, ultra: true }), 'blocker_ultra_fueling');
});

test('Wasmegg normalization starts at 2024-01-01 and excludes July 14 from model events', () => {
  const rows = [
    { type: 'hab-sale', ultra: false, startTimestamp: timestamp('2023-12-31') },
    { type: 'hab-sale', ultra: false, startTimestamp: timestamp('2024-01-02') },
    { type: 'drone-boost', ultra: true, startTimestamp: timestamp('2026-07-14') },
    { type: 'drone-boost', ultra: true, startTimestamp: timestamp('2026-07-15') },
    { type: 'gift-boost', multiplier: 2, ultra: true, startTimestamp: timestamp('2026-07-15') }
  ];
  const normalized = wasmegg.normalizeWasmeggData(rows, '2026-07-15');

  assert.deepEqual(normalized.events.housing_blue, ['2024-01-02']);
  assert.deepEqual(normalized.events.drone_pink, ['2026-07-15']);
  assert.deepEqual(normalized.events.blocker_ultra_gifts, ['2026-07-15']);
  assert.deepEqual(normalized.confirmedDays['2026-07-14'], []);
  assert.deepEqual(normalized.confirmedDays['2026-07-15'].sort(), ['blocker_ultra_gifts', 'drone_pink'].sort());
});

test('rolling recency bands use the configured under-1, 1-2, and 2+ year weights', () => {
  assert.equal(store.recencyWeight('2026-01-01', '2026-09-10'), 3);
  assert.equal(store.recencyWeight('2025-01-01', '2026-09-10'), 2);
  assert.equal(store.recencyWeight('2024-01-01', '2026-09-10'), 0.5);
});


test('former competition rotations are first-class daily forecast events', () => {
  const added = [
    'blocker_boost_duration', 'blocker_gifts', 'blocker_shells', 'blocker_fueling',
    'blocker_ultra_boost_duration', 'blocker_ultra_gifts', 'blocker_ultra_shells', 'blocker_ultra_fueling'
  ];
  for (const id of added) {
    assert.equal(config.MAIN_ORDER.includes(id), true, `${id} should be in the main daily forecast`);
    assert.equal(config.ORDER.includes(id), true, `${id} should be a tracked event`);
    assert.equal(config.DEFAULT_UI.forecastEvents.includes(id), false, `${id} should be opt-in in Next X Days`);
    assert.equal(config.EVENTS[id].modelOnly, undefined, `${id} should not be marked model-only`);
  }
  for (const id of config.CORE_DAILY_ORDER) {
    assert.equal(config.DEFAULT_UI.forecastEvents.includes(id), true, `${id} should remain selected by default`);
  }
  assert.equal(config.MAIN_ORDER.length, 14);
  assert.equal(config.ORDER.length, 16);
  assert.equal(config.MODEL_ORDER.length, 16);
});


test('legacy local overrides preserve previously remote-only daily events during migration', () => {
  const migrated = store.migrateLegacyOverrides(
    { '2026-09-08': ['shipping_pink'] },
    { '2026-09-08': ['blocker_gifts', 'shipping_pink'] },
    true
  );
  assert.deepEqual(migrated['2026-09-08'].sort(), ['blocker_gifts', 'shipping_pink'].sort());

  const alreadyUnified = store.migrateLegacyOverrides(
    { '2026-09-08': ['shipping_pink'] },
    { '2026-09-08': ['blocker_gifts', 'shipping_pink'] },
    false
  );
  assert.deepEqual(alreadyUnified['2026-09-08'], ['shipping_pink']);
});

test('display labels use in-game event terminology without changing internal ids', () => {
  assert.equal(config.EVENTS.housing_blue.label, 'Non-Ultra Hab Sale');
  assert.equal(config.EVENTS.shipping_blue.label, 'Non-Ultra Vehicle Sale');
  assert.equal(config.EVENTS.drone_green.label, 'Non-Ultra Generous Drones');
  assert.equal(config.EVENTS.blocker_boost_duration.label, 'Non-Ultra Boost Time+');
  assert.equal(config.EVENTS.blocker_gifts.label, 'Non-Ultra Generous Gifts');
  assert.equal(config.EVENTS.blocker_shells.label, 'Non-Ultra Shell Sale');
  assert.equal(config.EVENTS.blocker_fueling.label, 'Non-Ultra Mission Fuel Boost');
  assert.equal(config.EVENTS.capacity_purple.label, 'Non-Ultra Mission Capacity Boost');
});

test('double capacity is separated from the main forecast and restricted to Sundays', () => {
  assert.deepEqual(config.CAPACITY_ORDER, ['capacity_purple', 'capacity_pink']);
  assert.equal(config.MAIN_ORDER.includes('capacity_purple'), false);
  assert.equal(config.MAIN_ORDER.includes('capacity_pink'), false);
  assert.equal(model.allowedWeekday('capacity_purple', '2026-09-13'), true);
  assert.equal(model.allowedWeekday('capacity_pink', '2026-09-13'), false);
  assert.equal(model.allowedWeekday('capacity_pink', '2026-09-20'), true);
  assert.equal(model.allowedWeekday('capacity_purple', '2026-09-14'), false);
  assert.equal(model.allowedWeekday('capacity_pink', '2026-09-14'), false);
});


test('Non-Ultra double capacity can coexist with the regular Sunday Non-Ultra event', () => {
  assert.equal(model.conflicts('capacity_purple', 'housing_blue'), false);
  assert.equal(model.conflicts('capacity_purple', 'blocker_gifts'), false);

  const sunday = '2026-09-20';
  const fixed = model.fixedNonUltraEvent(sunday);
  assert.ok(fixed, 'Sunday should still have its fixed regular Non-Ultra event');

  const forecast = model.simulateForecast('2026-09-19', 1)[sunday];
  assert.ok(forecast.capacity_purple > 0, 'Non-Ultra capacity should retain an independent Sunday probability');
});


test('Non-Ultra capacity next-date card uses the independent Sunday capacity model', () => {
  model.invalidateNextHitCache();
  const next = model.getNextHitForecast('2026-09-10').capacity_purple;
  assert.equal(next.date, '2026-09-20');
  assert.equal(next.gap, 28);
  assert.ok(next.probability > 0.5, `Sep 20 should be the strongest first-hit date, got ${next.probability}`);
});

test('double capacity defaults to four Sundays and supports a configurable week count', () => {
  assert.equal(config.DEFAULT_UI.capacityWeeks, 4);
  assert.deepEqual(model.capacitySundayDates('2026-09-10', 4), [
    '2026-09-13', '2026-09-20', '2026-09-27', '2026-10-04'
  ]);
  assert.deepEqual(model.capacitySundayDates('2026-09-13', 2), [
    '2026-09-20', '2026-09-27'
  ]);
});

test('fixed Non-Ultra Friday through Monday schedule is exposed for tomorrow cards', () => {
  assert.equal(model.fixedNonUltraEvent('2026-09-11').label, 'Research Sale');
  assert.equal(model.fixedNonUltraEvent('2026-09-12').label, 'Prestige Boost');
  assert.equal(model.fixedNonUltraEvent('2026-09-13').label, 'Epic Research Sale');
  assert.equal(model.fixedNonUltraEvent('2026-09-14').label, 'Cash Boost');
  assert.equal(model.fixedNonUltraEvent('2026-09-20').label, 'Crafting Sale');
  assert.equal(model.fixedNonUltraEvent('2026-07-14'), null);
  assert.equal(model.fixedNonUltraEvent('2026-09-15'), null);
});

test('Ultra daily events can occur outside Tue-Thu when the cadence day is eligible', () => {
  assert.equal(model.allowedWeekday('blocker_ultra_gifts', '2026-09-12'), true);
  assert.equal(model.allowedWeekday('housing_pink', '2026-09-14'), true);
  assert.equal(model.allowedWeekday('blocker_gifts', '2026-09-11'), false);
});

test('daily forecast exposes all daily event probabilities for tomorrow recommendations', () => {
  const forecast = model.simulateForecast('2026-09-10', 1);
  assert.ok(Object.prototype.hasOwnProperty.call(forecast['2026-09-11'], 'blocker_ultra_gifts'));
  assert.ok(Object.prototype.hasOwnProperty.call(forecast['2026-09-11'], 'housing_pink'));
});

test('main forecast starts after the reference day and today can reset a rotation counter', () => {
  const forecast = model.simulateForecast('2026-09-10', 3);
  assert.deepEqual(Object.keys(forecast), ['2026-09-11', '2026-09-12', '2026-09-13']);
  assert.equal(store.lastEventOnOrBefore('housing_pink', '2026-09-10'), '2026-09-10');
  assert.equal(store.lastEventOnOrBefore('drone_green', '2026-09-10'), '2026-09-10');
  assert.deepEqual(store.historicalGaps('drone_green', '2026-09-11').at(-1), { gap: 9, endDate: '2026-09-10' });
});


test('seed audit flags seeded dates that are absent from Wasmegg while allowing an incomplete fallback subset', () => {
  const remoteEvents = Object.fromEntries(config.MODEL_ORDER.map(id => [id, []]));
  remoteEvents.capacity_purple = ['2025-04-20', '2025-05-18', '2025-07-13'];
  remoteEvents.shipping_pink = ['2026-07-22'];
  remoteEvents.housing_blue = ['2024-01-02', '2024-05-09'];

  const seed = Object.fromEntries(config.MODEL_ORDER.map(id => [id, []]));
  seed.capacity_purple = ['2025-04-20', '2025-05-18', '2025-07-13'];
  seed.shipping_pink = ['2026-07-22'];
  seed.housing_blue = ['2024-05-09'];
  seed.drone_pink = ['2026-07-14'];

  const audit = wasmegg.auditSeedAgainstRemote(remoteEvents, seed);
  assert.equal(audit.ok, true);
  assert.deepEqual(audit.seedOnly, {});
  assert.deepEqual(audit.remoteOnly.housing_blue, ['2024-01-02']);

  seed.capacity_purple.push('2025-05-25');
  const badAudit = wasmegg.auditSeedAgainstRemote(remoteEvents, seed);
  assert.equal(badAudit.ok, false);
  assert.deepEqual(badAudit.seedOnly.capacity_purple, ['2025-05-25']);
});

test('regular Ultra events follow the every-other-day cadence from May 4, 2026', () => {
  assert.equal(config.ULTRA_CADENCE_START, '2026-05-04');
  assert.equal(model.isUltraCadenceDate('2026-09-10'), true);
  assert.equal(model.isUltraCadenceDate('2026-09-11'), false);
  assert.equal(model.isUltraCadenceDate('2026-09-12'), true);
  assert.equal(model.isUltraCadenceDate('2026-09-13'), false);
  assert.equal(model.allowedWeekday('housing_pink', '2026-09-11'), false);
  assert.equal(model.allowedWeekday('blocker_ultra_gifts', '2026-09-12'), true);
  assert.equal(model.allowedWeekday('capacity_pink', '2026-09-13'), false);
  assert.equal(model.allowedWeekday('capacity_pink', '2026-09-20'), true);
});

test('Ultra gap training ignores post-cadence gaps that do not align to two-day slots', () => {
  for (const id of config.ULTRA_CADENCE_POOL) {
    const gaps = store.historicalGaps(id, '2026-09-11');
    for (const row of gaps) {
      if (row.endDate >= config.ULTRA_CADENCE_START) {
        assert.equal(row.gap % config.ULTRA_CADENCE_INTERVAL_DAYS, 0, `${id} retained misaligned gap ${row.gap} ending ${row.endDate}`);
      }
    }
  }
});

test('off-cadence future days have zero regular Ultra forecast probability', () => {
  const forecast = model.simulateForecast('2026-09-10', 2);
  for (const id of config.ULTRA_DAILY_POOL) {
    assert.equal(forecast['2026-09-11'][id], 0, `${id} should be blocked on Sep 11`);
  }
});


test('eligible Ultra cadence days allocate exactly one Ultra event', () => {
  const forecast = model.simulateForecast('2026-09-10', 2);
  const saturday = forecast['2026-09-12'];
  const ultraTotal = [...config.ULTRA_DAILY_POOL].reduce((sum, id) => sum + saturday[id], 0);
  assert.ok(Math.abs(ultraTotal - 1) < 1e-9, `Saturday Ultra probabilities should total 100%, got ${ultraTotal}`);
  assert.equal(saturday.capacity_pink, 0);
});


test('Tuesday-Thursday Non-Ultra pool allocates exactly one event', () => {
  const forecast = model.simulateForecast('2026-09-10', 6);
  const tuesday = forecast['2026-09-15'];
  const nonUltraTotal = [...config.NON_ULTRA_MIDWEEK_POOL].reduce((sum, id) => sum + tuesday[id], 0);
  assert.ok(Math.abs(nonUltraTotal - 1) < 1e-9, `Tuesday Non-Ultra probabilities should total 100%, got ${nonUltraTotal}`);

  const wednesday = forecast['2026-09-16'];
  const wednesdayTotal = [...config.NON_ULTRA_MIDWEEK_POOL].reduce((sum, id) => sum + wednesday[id], 0);
  assert.ok(Math.abs(wednesdayTotal - 1) < 1e-9, `Wednesday Non-Ultra probabilities should total 100%, got ${wednesdayTotal}`);

  const friday = forecast['2026-09-11'];
  const fridayTotal = [...config.NON_ULTRA_MIDWEEK_POOL].reduce((sum, id) => sum + friday[id], 0);
  assert.equal(fridayTotal, 0);
});

test('Tue-Thu guaranteed Ultra and Non-Ultra slots remain compatible', () => {
  const forecast = model.simulateForecast('2026-09-14', 2);
  const tuesday = forecast['2026-09-15'];
  const nonUltraTotal = [...config.NON_ULTRA_MIDWEEK_POOL].reduce((sum, id) => sum + tuesday[id], 0);
  assert.ok(Math.abs(nonUltraTotal - 1) < 1e-9);

  if (model.isUltraCadenceDate('2026-09-15')) {
    const ultraTotal = [...config.ULTRA_DAILY_POOL].reduce((sum, id) => sum + tuesday[id], 0);
    assert.ok(Math.abs(ultraTotal - 1) < 1e-9);
  }
});


test('Next X Days probabilities stay identical when the forecast horizon is extended', () => {
  model.invalidateNextHitCache();
  const sevenDays = model.simulateForecast('2026-09-10', 7);
  const thirtyDays = model.simulateForecast('2026-09-10', 30);

  for (const date of Object.keys(sevenDays)) {
    assert.deepEqual(
      sevenDays[date],
      thirtyDays[date],
      `${date} changed when extending the forecast horizon`
    );
  }
});

test('Double Capacity probabilities stay identical when the week horizon is extended', () => {
  model.invalidateNextHitCache();
  const fourWeeks = model.simulateCapacityForecast('2026-09-10', 4);
  const twelveWeeks = model.simulateCapacityForecast('2026-09-10', 12);

  for (const date of Object.keys(fourWeeks)) {
    assert.deepEqual(
      fourWeeks[date],
      twelveWeeks[date],
      `${date} changed when extending the Double Capacity horizon`
    );
  }
});


test('forecast display skips dates where every selected event is zero', () => {
  const probabilities = {
    '2026-09-11': { housing_blue: 0, shipping_blue: 0 },
    '2026-09-12': { housing_blue: 0, shipping_blue: 0 },
    '2026-09-13': { housing_blue: 0.2, shipping_blue: 0 },
    '2026-09-14': { housing_blue: 0, shipping_blue: 0 },
    '2026-09-15': { housing_blue: 0.4, shipping_blue: 0.6 },
    '2026-09-16': { housing_blue: 0.5, shipping_blue: 0.5 }
  };
  assert.deepEqual(
    utils.forecastDisplayDates(probabilities, ['housing_blue', 'shipping_blue'], 2),
    { dates: ['2026-09-13', '2026-09-15'], skipped: 3 }
  );
});

test('calendar prediction overlay defaults are enabled with a 25% threshold', () => {
  assert.equal(config.DEFAULT_UI.calendarShowConfirmed, true);
  assert.equal(config.DEFAULT_UI.calendarShowPredictions, true);
  assert.equal(config.DEFAULT_UI.calendarShowNonUltra, true);
  assert.equal(config.DEFAULT_UI.calendarShowUltra, true);
  assert.equal(config.DEFAULT_UI.calendarMinProbability, 25);
});

test('calendar prediction picks include fixed weekly events and thresholded likely events', () => {
  const saturday = model.calendarPredictionPicks('2026-09-12', {
    drone_pink: 0.62,
    shipping_pink: 0.22,
    capacity_purple: 0
  }, 0.25);
  assert.equal(saturday.some(row => row.fixed && row.label === 'Prestige Boost'), true);
  assert.equal(saturday.some(row => row.id === 'drone_pink' && row.probability === 0.62), true);
  assert.equal(saturday.some(row => row.id === 'shipping_pink'), false);

  const sunday = model.calendarPredictionPicks('2026-09-20', {
    capacity_purple: 0.53,
    capacity_pink: 0.31
  }, 0.25);
  assert.equal(sunday.some(row => row.fixed && row.label === 'Crafting Sale'), true);
  assert.equal(sunday.some(row => row.id === 'capacity_purple' && row.probability === 0.53), true);
  assert.equal(sunday.some(row => row.id === 'capacity_pink' && row.probability === 0.31), true);
});

test('named forecast sections below Today and Tomorrow are collapsible', () => {
  const html = require('node:fs').readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(html, /<details class="collapsible-section primary-collapsible" open>[\s\S]*?<h1 id="forecastWindowTitle">Next 7 days<\/h1>/);
  assert.match(html, /<details class="collapsible-section" open>[\s\S]*?<h1>Most likely next date<\/h1>/);
  assert.match(html, /<details class="collapsible-section capacity-forecast-section" open>[\s\S]*?<h1>Mission Capacity Boost forecast<\/h1>/);
  assert.match(html, /<details class="card collapsible-card" open>[\s\S]*?<h2>Daily event status<\/h2>/);
  assert.match(html, /<details class="card collapsible-card" open>[\s\S]*?<h2>Record a day<\/h2>/);
});

test('unconfirmed future predictions do not create a certain reset on the following day', () => {
  const original = structuredClone(store.getState());
  try {
    const next = structuredClone(original);
    delete next.overrides['2026-09-15'];
    store.replaceState(next);
    model.invalidateNextHitCache();

    const forecast = model.simulateForecast('2026-09-14', 2);
    assert.ok(forecast['2026-09-15'].shipping_blue > 0 && forecast['2026-09-15'].shipping_blue < 1,
      'an unconfirmed Sep 15 Shipping prediction must remain probabilistic');
    assert.ok(forecast['2026-09-16'].shipping_blue > 0,
      'Sep 16 Shipping must retain a chance when Sep 15 Shipping was not confirmed');
    assert.equal(model.isHardBlocked('blocker_gifts', '2026-09-15', null), false,
      'missing fallback history is unknown, not a hard impossibility');
  } finally {
    store.replaceState(original);
    model.invalidateNextHitCache();
  }
});

test('confirmation on the reference day resets a rotation and preserves hard minimum gaps', () => {
  const original = structuredClone(store.getState());
  try {
    const next = structuredClone(original);
    next.overrides = { ...next.overrides, '2026-09-15': ['shipping_blue'] };
    store.replaceState(next);
    model.invalidateNextHitCache();

    const forecast = model.simulateForecast('2026-09-15', 1);
    assert.equal(forecast['2026-09-16'].shipping_blue, 0, 'Non-Ultra Shipping must be impossible one day after it hit');
    assert.equal(model.isHardBlocked('shipping_blue', '2026-09-16', '2026-09-15'), true);
  } finally {
    store.replaceState(original);
    model.invalidateNextHitCache();
  }
});

test('a missed Non-Ultra deadline stays possible without excluding other events', () => {
  const original = store.clone(store.getState());
  try {
    const next = store.clone(original);
    next.settings.cap16 = true; // An old saved setting must not restore the rule.
    next.overrides['2026-09-15'] = ['housing_blue'];
    next.overrides['2026-09-16'] = ['blocker_boost_duration', 'shipping_pink'];
    store.replaceState(next);
    model.invalidateNextHitCache();
    const forecast = model.simulateForecast('2026-09-16', 6);
    assert.ok(forecast['2026-09-17'].shipping_blue > 0 && forecast['2026-09-17'].shipping_blue < 1);
    assert.ok(forecast['2026-09-17'].drone_green > 0);
    assert.ok(forecast['2026-09-22'].shipping_blue > 0,
      'passing the former deadline must not make Vehicle Sale impossible');
    assert.equal(model.isHardBlocked('shipping_blue', '2026-09-22', '2026-09-03'), false);
  } finally { store.replaceState(original); model.invalidateNextHitCache(); }
});

test('all Non-Ultra families have positive, non-certain and increasing overdue hazards', () => {
  const stats = {
    rows: [{ gap: 7, weighted: 3 }, { gap: 14, weighted: 9 }],
    exact: new Map([[7, 3], [14, 9]]),
    survivor: new Map([[7, 12], [14, 9]])
  };
  for (const id of config.MODEL_ORDER.filter(id => config.EVENTS[id].tier === 'non-ultra')) {
    const sunday = config.EVENTS[id].sundayOnly;
    const first = sunday ? '2026-09-20' : '2026-09-16';
    const later = sunday ? '2026-09-27' : '2026-09-17';
    const early = model.hazardFast(id, first, '2026-09-01', stats);
    const late = model.hazardFast(id, later, '2026-09-01', stats);
    assert.ok(early > 0 && early < 1, `${id}: missing tail must retain uncertainty`);
    assert.ok(late >= early && late < 1, `${id}: overdue chance must not drop to zero`);
    assert.ok(model.hazardFast(id, first, null, stats) > 0, `${id}: unknown history must not imply impossible`);
  }
  assert.equal(model.hazardFast('capacity_purple', '2026-09-21', '2026-08-01', stats), 0);
  assert.equal(model.hazardFast('shipping_blue', '2026-09-16', '2026-09-15', stats), 0);
});

test('old cap setting is removed from imported settings', () => {
  assert.equal('cap16' in store.normalizeSettings({ cap16: true }), false);
});

test('later remote records, manual confirmations, and sync timestamps do not repaint any forecast', () => {
  const original = store.clone(store.getState());
  try {
    const reference = '2026-09-14';
    const base = store.defaultState();
    base.remote.events = Object.fromEntries(config.MODEL_ORDER.map(id => [id, [...app.seed.SEED_EVENTS[id]]]));
    base.remote.confirmedDays = store.clone(app.seed.SEED_CONFIRMED_DAYS);
    base.remote.syncedAt = '2026-09-14T20:00:00Z';
    store.replaceState(base);
    model.invalidateNextHitCache();
    const before = model.simulateForecast(reference, 7);
    const beforeCapacity = model.simulateCapacityForecast(reference, 4);
    const beforeNext = model.getNextHitForecast(reference);
    const later = store.clone(base);
    later.remote.events.housing_blue.push('2026-09-15');
    later.remote.events.housing_pink.push('2026-09-15');
    later.remote.confirmedDays['2026-09-15'] = ['housing_blue', 'housing_pink'];
    later.remote.syncedAt = '2026-09-25T20:00:00Z';
    later.overrides['2026-09-17'] = ['shipping_blue'];
    later.overrides['2026-09-20'] = ['capacity_purple'];
    store.replaceState(later);
    model.invalidateNextHitCache();
    assert.deepEqual(model.simulateForecast(reference, 7), before);
    assert.deepEqual(model.simulateCapacityForecast(reference, 4), beforeCapacity);
    assert.deepEqual(model.getNextHitForecast(reference), beforeNext);
  } finally { store.replaceState(original); model.invalidateNextHitCache(); }
});

test('cooperative simulations match synchronous results and retain an isolated snapshot', () => {
  const original = store.clone(store.getState());
  try {
    const expected = model.simulateForecast('2026-09-14', 3);
    const iterator = model.forecastSteps('simulateForecast', ['2026-09-14', 3]);
    assert.equal(iterator.next().done, false);
    const changed = store.clone(original);
    changed.overrides['2026-09-14'] = ['shipping_blue'];
    store.replaceState(changed);
    let result;
    do { result = iterator.next(); } while (!result.done);
    assert.deepEqual(result.value, expected);
  } finally { store.replaceState(original); model.invalidateNextHitCache(); }
});

test('Non-Ultra Hab Sale can return after six days, but not five', () => {
  assert.equal(model.isHardBlocked('housing_blue', '2026-09-15', '2026-09-09'), false);
  assert.equal(model.isHardBlocked('housing_blue', '2026-09-16', '2026-09-11'), true);
});
