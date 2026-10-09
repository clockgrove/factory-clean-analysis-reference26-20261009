// Personal metadata only: this store never changes an incident or a query.
export const triageStorageKey = 'incident-explorer.triage.v1';
const services = ['Accounts', 'Billing', 'Search', 'Uploads', 'Notifications', 'Integrations'];
const severities = ['critical', 'high', 'medium', 'low'];
const statuses = ['open', 'in_progress', 'resolved'];
const snapshotKeys = ['id', 'title', 'service', 'severity', 'status', 'openedAt', 'note'];
const text = value => typeof value === 'string';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
function timestamp(value) {
  return text(value) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value).toISOString() === value.replace(/Z$/, value.includes('.') ? 'Z' : '.000Z');
}
function recognition(value) {
  return record(value) && text(value.id) && /^INC-\d{6}$/.test(value.id)
    && text(value.title) && services.includes(value.service)
    && severities.includes(value.severity) && statuses.includes(value.status)
    && timestamp(value.openedAt);
}
export function isCompleteIncident(value) {
  return recognition(value) && text(value.description) && text(value.team)
    && ['AMER', 'EMEA', 'APAC'].includes(value.region)
    && Array.isArray(value.tags) && value.tags.every(text)
    && (value.status === 'resolved'
      ? timestamp(value.resolvedAt) && Date.parse(value.resolvedAt) >= Date.parse(value.openedAt)
      : value.resolvedAt === null);
}
function validStored(value) {
  return recognition(value) && text(value.note) && value.note.length <= 1000
    && Object.keys(value).length === snapshotKeys.length
    && snapshotKeys.every(key => Object.hasOwn(value, key));
}
function snapshot(detail) {
  return Object.fromEntries(snapshotKeys.map(key => [key, key === 'note' ? '' : detail[key]]));
}
export function createTriage(storage) {
  let entries = [], readLimit = '', writeLimit = '';
  try {
    const raw = storage.getItem(triageStorageKey);
    if (raw !== null) {
      const stored = JSON.parse(raw);
      if (!Array.isArray(stored) || !stored.every(validStored)
        || new Set(stored.map(entry => entry.id)).size !== stored.length) {
        throw new SyntaxError('Invalid triage entries');
      }
      entries = stored.map(entry => ({...entry}));
    }
  } catch (error) {
    readLimit = error instanceof SyntaxError
      ? 'Stored triage could not be understood. Your list starts empty; you can still use triage during this visit.'
      : 'Triage could not be read from browser storage. You can still use triage during this visit.';
  }
  function persist() {
    try {
      storage.setItem(triageStorageKey, JSON.stringify(entries));
      writeLimit = '';
    } catch {
      writeLimit = 'Triage changes are kept for this visit, but browser storage could not save them. They may be lost after reload.';
    }
  }
  return {
    get entries() { return entries.map(entry => ({...entry})); },
    get limitation() { return [readLimit, writeLimit].filter(Boolean).join(' '); },
    add(detail) {
      if (!isCompleteIncident(detail) || entries.some(entry => entry.id === detail.id)) return false;
      entries = [...entries, snapshot(detail)]; persist(); return true;
    },
    edit(id, note) {
      if (!text(note) || note.length > 1000 || !entries.some(entry => entry.id === id)) return false;
      entries = entries.map(entry => entry.id === id ? {...entry, note} : entry);
      persist(); return true;
    },
    remove(id) {
      if (!entries.some(entry => entry.id === id)) return false;
      entries = entries.filter(entry => entry.id !== id); persist(); return true;
    }
  };
}
