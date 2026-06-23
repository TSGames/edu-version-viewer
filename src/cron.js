// Minimal, dependency-free 5-field cron parser + scheduler.
// Fields: minute hour day-of-month month day-of-week
// Supports: *  a  a-b  a-b/n  */n  a,b,c (and combinations)

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'dom', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'dow', min: 0, max: 6 }, // 0 = Sunday
];

function parseField(expr, min, max) {
  const allowed = new Set();
  for (const part of expr.split(',')) {
    let range = part;
    let step = 1;

    const slash = part.split('/');
    if (slash.length === 2) {
      range = slash[0];
      step = Number(slash[1]);
      if (!Number.isInteger(step) || step < 1) {
        throw new Error('Invalid step in cron field: ' + part);
      }
    } else if (slash.length > 2) {
      throw new Error('Invalid cron field: ' + part);
    }

    let lo;
    let hi;
    if (range === '*') {
      lo = min;
      hi = max;
    } else if (range.includes('-')) {
      const [a, b] = range.split('-');
      lo = Number(a);
      hi = Number(b);
    } else {
      lo = Number(range);
      hi = Number(range);
    }

    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error('Invalid cron field: ' + part);
    }
    for (let v = lo; v <= hi; v += step) {
      allowed.add(v);
    }
  }
  return allowed;
}

export function parseCron(expr) {
  if (typeof expr !== 'string') throw new Error('Cron expression must be a string');
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('Cron expression must have 5 fields, got ' + parts.length);
  }
  const sets = FIELDS.map((f, i) => parseField(parts[i], f.min, f.max));
  return {
    minute: sets[0],
    hour: sets[1],
    dom: sets[2],
    month: sets[3],
    dow: sets[4],
  };
}

// Standard cron semantics: when both DOM and DOW are restricted (not '*'),
// a match on either is enough. We approximate by treating '*' fields as wildcard.
export function matches(parsed, date, parts) {
  const minute = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  if (!parsed.minute.has(minute)) return false;
  if (!parsed.hour.has(hour)) return false;
  if (!parsed.month.has(month)) return false;

  const domRestricted = parts ? parts[2] !== '*' : parsed.dom.size !== 31;
  const dowRestricted = parts ? parts[4] !== '*' : parsed.dow.size !== 7;

  const domOk = parsed.dom.has(dom);
  const dowOk = parsed.dow.has(dow);

  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  if (dowRestricted) return dowOk;
  return true;
}

// Start a scheduler that calls `onTick` whenever the cron matches.
// Returns a stop() function.
export function scheduleCron(expr, onTick) {
  const parts = expr.trim().split(/\s+/);
  const parsed = parseCron(expr);
  let timer = null;
  let stopped = false;

  function tick() {
    if (stopped) return;
    const now = new Date();
    if (matches(parsed, now, parts)) {
      Promise.resolve()
        .then(onTick)
        .catch((err) => console.error('[cron] tick failed:', err.message));
    }
    scheduleNext();
  }

  // Align checks to the top of each minute so we evaluate once per minute.
  function scheduleNext() {
    const now = new Date();
    const msToNextMinute =
      (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 5; // small guard
    timer = setTimeout(tick, msToNextMinute);
  }

  scheduleNext();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
