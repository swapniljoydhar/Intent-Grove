export const STUDY_DATA_KEY = 'intentGroveStudyData';
export const STUDY_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
export const STUDY_METRICS = Object.freeze([
  'sessionsStarted', 'choiceCardsShown', 'choiceCardsDismissed', 'choiceCardsActedOn',
  'reflectionNotesShown', 'reflectionNotesReviewed', 'reflectionNotesDismissed'
]);

const REQUIRED_DISCLOSURES = Object.freeze([
  'studyId', 'title', 'purpose', 'researchLead', 'ethicsReview', 'contact',
  'dataRecipient', 'surveyProvider', 'retention', 'withdrawal', 'deletion', 'risks',
  'storageSecurity', 'inclusion', 'exclusion', 'countries', 'languages'
]);
let writeQueue = Promise.resolve();
function serializeWrite(operation) {
  const result = writeQueue.then(operation, operation);
  writeQueue = result.catch(() => {});
  return result;
}

export function studyConfigIssues(config) {
  if (!config || config.enabled !== true) return ['Study collection is disabled in this build.'];
  if (config.ethicsApproved !== true) return ['Applicable research-ethics approval is not recorded for this build.'];
  if (!Number.isInteger(config.retentionDays) || config.retentionDays < 1 || config.retentionDays > 3650) {
    return ['A local-data retention period between 1 and 3650 days is required.'];
  }
  const missing = REQUIRED_DISCLOSURES.filter((key) => {
    const value = config[key];
    if (Array.isArray(value)) return value.length === 0 || value.some((item) => typeof item !== 'string' || !item.trim());
    return typeof value !== 'string' || !value.trim() || value.length > 3000;
  });
  return missing.map((key) => `Missing or invalid study disclosure: ${key}.`);
}

function randomStudyCode(cryptoApi = globalThis.crypto) {
  if (!cryptoApi?.getRandomValues) throw new Error('secure_random_unavailable');
  const bytes = new Uint8Array(12);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function validStoredRecord(record) {
  return Boolean(record && record.consented === true && typeof record.studyCode === 'string'
    && Number.isFinite(record.startedAt) && Number.isFinite(record.expiresAt)
    && record.expiresAt > record.startedAt && record.weeks && typeof record.weeks === 'object');
}

async function readRecord(storage, now = Date.now()) {
  const stored = (await storage.get(STUDY_DATA_KEY))?.[STUDY_DATA_KEY];
  if (!validStoredRecord(stored)) {
    if (stored) await storage.remove(STUDY_DATA_KEY);
    return null;
  }
  if (now >= stored.expiresAt) {
    await storage.remove(STUDY_DATA_KEY);
    return null;
  }
  return stored;
}

export async function getStudyStatus(config, storage, now = Date.now()) {
  const issues = studyConfigIssues(config);
  const record = await readRecord(storage, now);
  return {
    available: issues.length === 0,
    unavailableReason: issues[0] || '',
    disclosures: issues.length === 0 ? { ...Object.fromEntries(REQUIRED_DISCLOSURES.map((key) => [key, config[key]])), retentionDays: config.retentionDays } : null,
    consented: Boolean(record),
    studyCode: record?.studyCode || ''
  };
}

export function consentToStudy(config, confirmed, eligible, storage, now = Date.now(), cryptoApi = globalThis.crypto) {
  return serializeWrite(async () => {
    if (studyConfigIssues(config).length || confirmed !== true || eligible !== true) return { consented: false };
    const prior = await readRecord(storage, now);
    if (prior) return { consented: true, studyCode: prior.studyCode };
    const record = {
      consented: true,
      studyCode: randomStudyCode(cryptoApi),
      startedAt: now,
      expiresAt: now + config.retentionDays * 24 * 60 * 60 * 1000,
      weeks: {}
    };
    await storage.set({ [STUDY_DATA_KEY]: record });
    return { consented: true, studyCode: record.studyCode };
  });
}

export function recordStudyMetric(config, metric, storage, now = Date.now()) {
  return serializeWrite(async () => {
    if (studyConfigIssues(config).length || !STUDY_METRICS.includes(metric)) return false;
    const stored = await readRecord(storage, now);
    if (!stored) return false;
    const week = Math.floor(Math.max(0, now - stored.startedAt) / STUDY_WEEK_MS) + 1;
    const weeks = { ...stored.weeks };
    const bucket = { ...(weeks[week] || {}) };
    bucket[metric] = Math.min(1000000, (Number.isInteger(bucket[metric]) ? bucket[metric] : 0) + 1);
    weeks[week] = bucket;
    await storage.set({ [STUDY_DATA_KEY]: { ...stored, weeks } });
    return true;
  });
}

export function buildStudyExport(config, storage, now = Date.now()) {
  return serializeWrite(async () => {
    if (studyConfigIssues(config).length) return null;
    const stored = await readRecord(storage, now);
    if (!stored) return null;
    const weeks = Object.entries(stored.weeks).map(([week, values]) => ({
      week: Math.max(1, Number.parseInt(week, 10) || 1),
      ...Object.fromEntries(STUDY_METRICS.map((metric) => [metric, Math.max(0, Math.min(1000000, Number.isInteger(values?.[metric]) ? values[metric] : 0))]))
    })).sort((a, b) => a.week - b.week);
    return { schemaVersion: 1, studyId: config.studyId, studyCode: stored.studyCode, weeks };
  });
}

export function withdrawFromStudy(storage) {
  return serializeWrite(async () => {
    await storage.remove(STUDY_DATA_KEY);
    return true;
  });
}
