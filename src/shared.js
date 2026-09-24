(function (root) {
  'use strict';
  const app = root.EggEventLab;
  // Read the source branch directly: data updates do not require a site deployment.
  const SOURCE = 'https://raw.githubusercontent.com/BroadSword13/Egg-Event-Prediction/main/data/shared/official.json';
  let data = null, error = null, loading = null;
  async function refresh() {
    if (loading) return loading;
    loading = (async () => {
      try {
        const response = await fetch(`${SOURCE}?t=${Date.now()}`, {cache:'no-store',signal:AbortSignal.timeout(15000)});
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const value = await response.json();
        if (value.schemaVersion !== 1 || !value.predictions || !value.outcomes) throw new Error('Invalid shared data');
        data = value; error = null;
      } catch (e) { error = e.message; }
    })();
    try { await loading; } finally { loading = null; }
  }
  function prediction(date) {
    const item = data?.predictions?.[date];
    return item && app.accuracy.normalize({[date]:item})[date] ? item : null;
  }
  function summary(days) {
    const archive = Object.fromEntries(Object.entries(data?.predictions || {}).filter(([,p])=>p.status==='eligible'));
    const confirmed = Object.fromEntries(Object.entries(data?.outcomes || {}).filter(([,o])=>o.status==='complete').map(([d,o])=>[d,o.ids]));
    return app.accuracy.summarize(days,{archive,confirmed,today:app.clock.currentEventDate()});
  }
  function status() {
    if (!data) return error ? 'Shared results unavailable. Retrying automatically.' : 'Loading shared results…';
    if (!data.updatedAt) return 'Awaiting the first GitHub workflow run.';
    const stale = app.clock.now() - new Date(data.updatedAt) > 3*3600000;
    const today = app.clock.currentEventDate();
    const result = data.outcomes?.[today];
    const p = data.predictions?.[today];
    const message = !p ? 'No saved public forecast for today; today is unscored.' : p.status !== 'eligible' ? 'Today’s forecast had incomplete input history and is excluded from the score.' : result?.status !== 'complete' ? 'Awaiting settled results for today.' : 'Today’s results are scored.';
    return `${message} Last shared update: ${new Date(data.updatedAt).toLocaleString()}.${stale || error ? ' Shared updates are delayed; showing the last available data.' : ''}`;
  }
  app.shared = {refresh,prediction,summary,status, updatedAt: () => data?.updatedAt || null};
})(typeof window !== 'undefined' ? window : globalThis);
