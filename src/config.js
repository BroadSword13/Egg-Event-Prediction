(function (root) {
  'use strict';

  const APP_VERSION = '0.2';
  const EXPORT_SCHEMA_VERSION = 6;
  const STORAGE_KEY = 'egg-event-lab-v1';
  const DAY = 86400000;
  const SIM_RUNS = 3000;
  const NEXT_HIT_RUNS = 1200;
  const NEXT_DATE_HORIZON = 400;
  const MAIN_NEXT_DATE_HORIZON = 90;
  const TODAY_SEED = '2026-09-10';
  const WASMEGG_EVENTS_URL = 'https://raw.githubusercontent.com/wasmegg-carpet/egg/refs/heads/main/periodicals/data/events.json';
  const REMOTE_DATA_START = '2024-01-01';
  const REMOTE_SCHEMA_VERSION = 3;
  const ANNIVERSARY_MM_DD = '07-14';
  const MODEL_TIME_ZONE = 'America/Los_Angeles';
  const EVENT_START_HOUR = 9;
  const ULTRA_CADENCE_START = '2026-05-04';
  const ULTRA_CADENCE_INTERVAL_DAYS = 2;

  const EVENTS = {
    housing_blue: { label: 'Non-Ultra Housing', short: 'Non-Ultra House', family: 'housing', tier: 'non-ultra', color: 'blue', icon: '🏠', minGap: 7, maxGap: 16, weekdayObserved: true, coverageStart: REMOTE_DATA_START },
    housing_pink: { label: 'Ultra Housing', short: 'Ultra House', family: 'housing', tier: 'ultra', color: 'pink', icon: '🏠', coverageStart: REMOTE_DATA_START },
    shipping_blue: { label: 'Non-Ultra Shipping', short: 'Non-Ultra Ship', family: 'shipping', tier: 'non-ultra', color: 'blue', icon: '🚚', minGap: 6, maxGap: 16, weekdayObserved: true, coverageStart: REMOTE_DATA_START },
    shipping_pink: { label: 'Ultra Shipping', short: 'Ultra Ship', family: 'shipping', tier: 'ultra', color: 'pink', icon: '🚚', coverageStart: REMOTE_DATA_START },
    drone_green: { label: 'Non-Ultra Drones', short: 'Non-Ultra Drone', family: 'drone', tier: 'non-ultra', color: 'green', icon: '🚁', minGap: 7, maxGap: 16, weekdayObserved: true, coverageStart: REMOTE_DATA_START },
    drone_pink: { label: 'Ultra Drones', short: 'Ultra Drone', family: 'drone', tier: 'ultra', color: 'pink', icon: '🚁', coverageStart: REMOTE_DATA_START },
    capacity_purple: { label: 'Non-Ultra 2× Capacity', short: 'Non-Ultra 2×', family: 'capacity', tier: 'non-ultra', color: 'purple', icon: '🚀', sundayOnly: true, coverageStart: REMOTE_DATA_START },
    capacity_pink: { label: 'Ultra 2× Capacity', short: 'Ultra 2×', family: 'capacity', tier: 'ultra', color: 'orange', icon: '🚀', sundayOnly: true, coverageStart: REMOTE_DATA_START, sparse: true },
    blocker_boost_duration: { label: 'Non-Ultra 2× Boost Duration', short: '2× Boost Time', family: 'boost-duration', tier: 'non-ultra', color: 'teal', icon: '⏱️', weekdayObserved: true, coverageStart: REMOTE_DATA_START },
    blocker_gifts: { label: 'Non-Ultra 2× Gifts', short: '2× Gifts', family: 'gifts', tier: 'non-ultra', color: 'gold', icon: '🎁', weekdayObserved: true, coverageStart: REMOTE_DATA_START },
    blocker_shells: { label: 'Non-Ultra 15% Off Shells', short: '15% Shells', family: 'shells', tier: 'non-ultra', color: 'slate', icon: '🎨', weekdayObserved: true, coverageStart: REMOTE_DATA_START },
    blocker_fueling: { label: 'Non-Ultra 3× Fueling', short: '3× Fueling', family: 'fueling', tier: 'non-ultra', color: 'amber', icon: '⛽', weekdayObserved: true, coverageStart: REMOTE_DATA_START },
    blocker_ultra_boost_duration: { label: 'Ultra 2× Boost Duration', short: 'Ultra 2× Boost Time', family: 'boost-duration', tier: 'ultra', color: 'pink', icon: '⏱️', coverageStart: REMOTE_DATA_START },
    blocker_ultra_gifts: { label: 'Ultra 2× Gifts', short: 'Ultra 2× Gifts', family: 'gifts', tier: 'ultra', color: 'pink', icon: '🎁', coverageStart: REMOTE_DATA_START },
    blocker_ultra_shells: { label: 'Ultra 15% Off Shells', short: 'Ultra 15% Shells', family: 'shells', tier: 'ultra', color: 'pink', icon: '🎨', coverageStart: REMOTE_DATA_START },
    blocker_ultra_fueling: { label: 'Ultra 3× Fueling', short: 'Ultra 3× Fueling', family: 'fueling', tier: 'ultra', color: 'pink', icon: '⛽', coverageStart: REMOTE_DATA_START }
  };

  const CORE_DAILY_ORDER = [
    'housing_blue', 'housing_pink', 'shipping_blue', 'shipping_pink',
    'drone_green', 'drone_pink'
  ];
  const NON_ULTRA_BLOCKER_ORDER = ['blocker_boost_duration', 'blocker_gifts', 'blocker_shells', 'blocker_fueling'];
  const ULTRA_BLOCKER_ORDER = ['blocker_ultra_boost_duration', 'blocker_ultra_gifts', 'blocker_ultra_shells', 'blocker_ultra_fueling'];
  const BLOCKER_ORDER = [...NON_ULTRA_BLOCKER_ORDER, ...ULTRA_BLOCKER_ORDER];
  const MAIN_ORDER = [...CORE_DAILY_ORDER, ...BLOCKER_ORDER];
  const CAPACITY_ORDER = ['capacity_purple', 'capacity_pink'];
  const ORDER = [...MAIN_ORDER, ...CAPACITY_ORDER];
  const MODEL_ORDER = [...ORDER];
  const NON_ULTRA_CORE = new Set(['housing_blue', 'shipping_blue', 'drone_green']);
  const ULTRA_CORE = new Set(['housing_pink', 'shipping_pink', 'drone_pink']);
  const NON_ULTRA_MIDWEEK_POOL = new Set([...NON_ULTRA_CORE, ...NON_ULTRA_BLOCKER_ORDER]);
  const ULTRA_MIDWEEK_POOL = new Set([...ULTRA_CORE, ...ULTRA_BLOCKER_ORDER]);
  const ULTRA_DAILY_POOL = new Set([...ULTRA_CORE, ...ULTRA_BLOCKER_ORDER]);
  const ULTRA_CADENCE_POOL = new Set([...ULTRA_DAILY_POOL, 'capacity_pink']);
  const SUNDAY_ROTATION_ANCHOR = '2026-09-06';

  const DEFAULT_SETTINGS = {
    cap16: true,
    weekdayPattern: true,
    pink5: true,
    weights: { under1: 3, oneToTwo: 2, twoPlus: 0.5 }
  };
  const DEFAULT_UI = {
    unifiedDailyEvents: true,
    forecastSelectionVersion: 2,
    forecastDays: 7,
    forecastEvents: [...CORE_DAILY_ORDER],
    capacityWeeks: 4,
    capacityEvents: [...CAPACITY_ORDER]
  };
  const DEFAULT_REMOTE = {
    autoSync: true,
    events: null,
    confirmedDays: null,
    latestDate: null,
    syncedAt: null,
    lastError: null,
    source: WASMEGG_EVENTS_URL,
    rangeStart: REMOTE_DATA_START,
    schemaVersion: REMOTE_SCHEMA_VERSION
  };

  root.EggEventLab ||= {};
  root.EggEventLab.config = {
    APP_VERSION,
    EXPORT_SCHEMA_VERSION,
    STORAGE_KEY,
    DAY,
    SIM_RUNS,
    NEXT_HIT_RUNS,
    NEXT_DATE_HORIZON,
    MAIN_NEXT_DATE_HORIZON,
    TODAY_SEED,
    WASMEGG_EVENTS_URL,
    REMOTE_DATA_START,
    REMOTE_SCHEMA_VERSION,
    ANNIVERSARY_MM_DD,
    MODEL_TIME_ZONE,
    EVENT_START_HOUR,
    ULTRA_CADENCE_START,
    ULTRA_CADENCE_INTERVAL_DAYS,
    EVENTS,
    ORDER,
    MAIN_ORDER,
    CORE_DAILY_ORDER,
    CAPACITY_ORDER,
    NON_ULTRA_BLOCKER_ORDER,
    ULTRA_BLOCKER_ORDER,
    BLOCKER_ORDER,
    MODEL_ORDER,
    NON_ULTRA_CORE,
    ULTRA_CORE,
    NON_ULTRA_MIDWEEK_POOL,
    ULTRA_MIDWEEK_POOL,
    ULTRA_DAILY_POOL,
    ULTRA_CADENCE_POOL,
    SUNDAY_ROTATION_ANCHOR,
    DEFAULT_SETTINGS,
    DEFAULT_UI,
    DEFAULT_REMOTE
  };
})(typeof window !== 'undefined' ? window : globalThis);
