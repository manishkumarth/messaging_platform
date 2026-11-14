/** Minimal in-process counters, exposed as JSON on GET /metrics. */
export function createMetrics() {
  const counters = new Map();

  return {
    inc(name, labels = {}, by = 1) {
      const key = name + '|' + JSON.stringify(Object.entries(labels).sort());
      const current = counters.get(key);
      if (current) current.value += by;
      else counters.set(key, { name, labels, value: by });
    },
    snapshot() {
      return [...counters.values()].sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}
