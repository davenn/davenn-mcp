import { getGlucoseHistory } from "./dexcomShare.js";

// Dexcom's Share API only serves a rolling window and keeps no history of its
// own, so readings are pushed to davenn.com where they're stored for good.
//
// Each run asks for exactly the gap between what's already stored and now, so
// steady state costs a couple of readings while an outage backfills itself.
// Ingest is idempotent, so the deliberate overlap costs nothing.
const MIN_WINDOW_MINUTES = 10;
const MARGIN_MINUTES = 10;

// Share caps every response at 288 records server-side — asking for more is
// ignored — and it delivers some readings twice, so roughly 14 hours is the
// furthest back any request can reach. There is no offset parameter, so a gap
// older than this is unrecoverable and asking for a wider window is pointless.
const MAX_WINDOW_MINUTES = 14 * 60;

// The sensor emits on a 5-minute cadence with a stable phase, so rather than
// sampling blindly we aim each poll just after the next reading is due. That
// holds the request count at roughly one per reading while cutting detection
// lag to the buffer below, instead of trading one against the other.
const CADENCE_MS = 5 * 60 * 1000;
const PUBLISH_LAG_MS = 25 * 1000;   // grace for Share to publish the reading
const RETRY_MS = 30 * 1000;         // first re-check when a reading is late
const FALLBACK_MS = 60 * 1000;      // no phase known yet (cold start, empty store)
const MIN_DELAY_MS = 2 * 1000;

let inFlight = false;
let lastResult = null;

// Newest reading the store confirms it holds. Snapped to the 5-minute grid by
// ingest, which is right for sizing the window but wrong for scheduling.
let latestStored = null;

// Newest reading as Dexcom actually timestamped it. This is what carries the
// phase, so it — not the snapped value — is what the schedule derives from.
let latestObserved = null;

export function getLastSyncResult() {
  return lastResult;
}

// Exported so the scheduling can be tested directly; pure, given the clock.
export function nextDelayMs(observed, misses, now) {
  if (!observed) return FALLBACK_MS;
  const due = observed.getTime() + CADENCE_MS + PUBLISH_LAG_MS;
  const delay = due - now;
  if (delay > MIN_DELAY_MS) return delay;
  // The reading we expected hasn't appeared. Check back sooner than the cadence,
  // but back off toward it so a long sensor outage doesn't spin on the API.
  return Math.min(RETRY_MS * Math.pow(2, Math.max(misses - 1, 0)), CADENCE_MS);
}

function windowMinutes() {
  if (!latestStored) return MAX_WINDOW_MINUTES;
  const gap = (Date.now() - latestStored.getTime()) / 60000;
  const wanted = Math.ceil(gap) + MARGIN_MINUTES;
  return Math.min(Math.max(wanted, MIN_WINDOW_MINUTES), MAX_WINDOW_MINUTES);
}

async function postIngest(readings) {
  const endpoint = process.env.BG_INGEST_URL;
  const secret = process.env.BG_INGEST_SECRET;
  if (!endpoint || !secret) {
    throw new Error("BG_INGEST_URL and BG_INGEST_SECRET must be set.");
  }

  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Admin-Secret": secret },
    body: JSON.stringify({ readings }),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Ingest returned ${res.status}: ${text.slice(0, 200)}`);
  }

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = null;
  }

  // The store is the authority on what it holds; trusting it rather than a
  // local counter is what makes a restart mid-gap size its window correctly.
  if (body?.latest_stored) {
    const parsed = new Date(body.latest_stored);
    if (!Number.isNaN(parsed.getTime())) latestStored = parsed;
  }

  return body;
}

export async function syncGlucose() {
  // A slow Dexcom call plus a cron-triggered run can otherwise overlap and
  // push the same window twice concurrently.
  if (inFlight) {
    return { skipped: true, reason: "a sync is already running" };
  }
  inFlight = true;

  try {
    // Cold start: ask the store what it already has, so the first window after
    // a restart is sized to the real gap instead of a guess. An empty batch is
    // a no-op write that comes back with the timestamp we need.
    if (!latestStored) {
      await postIngest([]);
    }

    const minutes = windowMinutes();
    const readings = await getGlucoseHistory({ hours: minutes / 60 });
    const payload = readings
      .filter((r) => r.utcTimestamp instanceof Date && Number.isFinite(r.mgdl))
      .map((r) => ({
        at: r.utcTimestamp.toISOString(),
        mgdl: r.mgdl,
        trend: r.trend ?? null,
      }));

    // Readings arrive oldest-first, so the last one carries the current phase.
    if (payload.length) {
      const newest = new Date(payload[payload.length - 1].at);
      if (!Number.isNaN(newest.getTime()) && (!latestObserved || newest > latestObserved)) {
        latestObserved = newest;
      }
    }

    if (payload.length === 0) {
      lastResult = {
        at: new Date().toISOString(),
        window_minutes: minutes,
        sent: 0,
        note: "no readings available",
      };
      return lastResult;
    }

    const body = await postIngest(payload);

    lastResult = {
      at: new Date().toISOString(),
      window_minutes: minutes,
      sent: payload.length,
      stored: body?.stored ?? null,
      rejected: body?.skipped ?? null,
      latest_stored: latestStored ? latestStored.toISOString() : null,
      latest_observed: latestObserved ? latestObserved.toISOString() : null,
    };
    return lastResult;
  } catch (err) {
    lastResult = { at: new Date().toISOString(), error: err.message };
    throw err;
  } finally {
    inFlight = false;
  }
}

export function startGlucosePolling() {
  if (!process.env.BG_INGEST_URL || !process.env.BG_INGEST_SECRET) {
    console.log("Glucose polling disabled (BG_INGEST_URL / BG_INGEST_SECRET not set).");
    return;
  }

  // Setting BG_POLL_MINUTES pins a fixed interval and opts out of phase-locking;
  // leaving it unset is the default and follows the sensor.
  const override = Number(process.env.BG_POLL_MINUTES);
  const fixedMs = override > 0 ? Math.max(override, 0.5) * 60000 : null;

  let misses = 0;

  const tick = () => {
    const before = latestObserved ? latestObserved.getTime() : 0;

    syncGlucose()
      .then((result) => {
        if (!result.skipped) console.log("Glucose sync:", JSON.stringify(result));
      })
      // A failed sync must never take the MCP server down with it. latestStored
      // is left untouched on failure, so the next run widens to cover the gap.
      .catch((err) => console.error("Glucose sync failed:", err.message))
      .then(() => {
        const after = latestObserved ? latestObserved.getTime() : 0;
        misses = after > before ? 0 : misses + 1;
        const delay = fixedMs ?? nextDelayMs(latestObserved, misses, Date.now());
        setTimeout(tick, Math.max(delay, MIN_DELAY_MS));
      });
  };

  tick();
  console.log(
    fixedMs
      ? `Glucose polling every ${fixedMs / 60000} min (fixed).`
      : "Glucose polling locked to the sensor's 5-minute cadence.",
  );
}
