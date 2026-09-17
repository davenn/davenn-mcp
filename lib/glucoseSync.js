import { getGlucoseHistory } from "./dexcomShare.js";

// Dexcom's Share API only serves a rolling window and keeps no history of its
// own, so readings are pushed to davenn.com where they're stored for good.
//
// Each run asks for exactly the gap between what's already stored and now, so
// steady state costs two readings while an outage backfills itself. Ingest is
// idempotent, so the deliberate overlap costs nothing.
const MIN_WINDOW_MINUTES = 10;
const MARGIN_MINUTES = 10;

// Share caps every response at 288 records server-side — asking for more is
// ignored — and it delivers some readings twice, so roughly 14 hours is the
// furthest back any request can reach. There is no offset parameter, so a gap
// older than this is unrecoverable and asking for a wider window is pointless.
const MAX_WINDOW_MINUTES = 14 * 60;

let inFlight = false;
let lastResult = null;

// Newest reading known to be stored. Seeded from the ingest response, so a
// restart re-learns it rather than guessing.
let latestStored = null;

export function getLastSyncResult() {
  return lastResult;
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

  const minutes = Number(process.env.BG_POLL_MINUTES) || 5;

  const run = () => {
    syncGlucose()
      .then((result) => {
        if (!result.skipped) console.log("Glucose sync:", JSON.stringify(result));
      })
      // A failed sync must never take the MCP server down with it. latestStored
      // is left untouched on failure, so the next run widens to cover the gap.
      .catch((err) => console.error("Glucose sync failed:", err.message));
  };

  run();
  setInterval(run, minutes * 60 * 1000);
  console.log(`Glucose polling every ${minutes} min.`);
}
