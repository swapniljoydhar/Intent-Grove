import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STUDY_DATA_KEY, STUDY_WEEK_MS, buildStudyExport, consentToStudy,
  getStudyStatus, recordStudyMetric, studyConfigIssues, withdrawFromStudy
} from './shared/study.js';
import { STUDY_CONFIG } from './shared/study-config.js';

const approvedConfig = {
  enabled: true, ethicsApproved: true, retentionDays: 90, studyId: 'pilot-01', title: 'Feasibility study',
  purpose: 'Assess feasibility and participant experience.', researchLead: 'Research lead',
  ethicsReview: 'Approved by the named research-ethics committee.', contact: 'study@example.org',
  dataRecipient: 'Named study team only.', surveyProvider: 'No extension-integrated survey; separately named survey provider in the study materials.', retention: 'Delete within 90 days after analysis.',
  withdrawal: 'Use the withdrawal control in Settings.', deletion: 'Delete the local study record and contact the study team for exported copies.',
  risks: 'Possible interruption or discomfort; no browsing content is exported.',
  storageSecurity: 'Stored in Chrome local extension storage; relies on operating-system and browser-profile access controls, not app-layer encryption.',
  inclusion: 'Adults aged 18+ using a supported desktop Chromium browser in the approved country and language.',
  exclusion: 'Under 18, unable to provide informed consent, or outside approved country, language, or browser scope.',
  countries: ['Example Country'], languages: ['English']
};

function memoryStorage() {
  const values = new Map();
  return {
    async get(key) { return values.has(key) ? { [key]: structuredClone(values.get(key)) } : {}; },
    async set(items) { for (const [key, value] of Object.entries(items)) values.set(key, structuredClone(value)); },
    async remove(key) { values.delete(key); },
    values
  };
}
const fixedCrypto = { getRandomValues(bytes) { bytes.fill(0x5a); return bytes; } };

test('the ordinary extension build is off and performs no study writes', async () => {
  assert.equal(STUDY_CONFIG.enabled, false);
  const storage = memoryStorage();
  assert.equal(await recordStudyMetric(STUDY_CONFIG, 'sessionsStarted', storage, 1000), false);
  assert.equal(storage.values.size, 0);
  assert.equal((await getStudyStatus(STUDY_CONFIG, storage)).available, false);
});

test('a study cannot activate without ethics approval and every required disclosure', () => {
  assert.ok(studyConfigIssues({ ...approvedConfig, ethicsApproved: false }).some((issue) => /ethics approval/i.test(issue)));
  assert.ok(studyConfigIssues({ ...approvedConfig, contact: '' }).some((issue) => /contact/i.test(issue)));
  assert.ok(studyConfigIssues({ ...approvedConfig, languages: [{}] }).some((issue) => /languages/i.test(issue)));
  assert.ok(studyConfigIssues({ ...approvedConfig, retentionDays: 0 }).some((issue) => /retention period/i.test(issue)));
  assert.deepEqual(studyConfigIssues(approvedConfig), []);
});

test('consent must be explicit and one-time enrollment creates a random local code', async () => {
  const storage = memoryStorage();
  assert.deepEqual(await consentToStudy(approvedConfig, false, true, storage, 10, fixedCrypto), { consented: false });
  assert.equal(storage.values.size, 0);
  assert.deepEqual(await consentToStudy(approvedConfig, true, false, storage, 10, fixedCrypto), { consented: false });
  const result = await consentToStudy(approvedConfig, true, true, storage, 10, fixedCrypto);
  assert.equal(result.consented, true);
  assert.equal(result.studyCode, '5a'.repeat(12));
  assert.equal((await consentToStudy(approvedConfig, true, true, storage, 20, fixedCrypto)).studyCode, result.studyCode);
  assert.equal((await storage.get(STUDY_DATA_KEY))[STUDY_DATA_KEY].expiresAt, 10 + 90 * 24 * 60 * 60 * 1000);
});

test('concurrent metrics are serialized into coarse relative-week counters', async () => {
  const storage = memoryStorage();
  await consentToStudy(approvedConfig, true, true, storage, 1000, fixedCrypto);
  await Promise.all(Array.from({ length: 25 }, () => recordStudyMetric(approvedConfig, 'choiceCardsShown', storage, 2000)));
  await recordStudyMetric(approvedConfig, 'sessionsStarted', storage, 1000 + STUDY_WEEK_MS);
  const record = (await storage.get(STUDY_DATA_KEY))[STUDY_DATA_KEY];
  assert.equal(record.weeks[1].choiceCardsShown, 25);
  assert.equal(record.weeks[2].sessionsStarted, 1);
  assert.equal(await recordStudyMetric(approvedConfig, 'pageTitles', storage, 2000), false);
});

test('the reviewed export contains only the allow-listed study code, id, relative weeks, and counts', async () => {
  const storage = memoryStorage();
  await consentToStudy(approvedConfig, true, true, storage, 1000, fixedCrypto);
  await recordStudyMetric(approvedConfig, 'sessionsStarted', storage, 1500);
  const payload = await buildStudyExport(approvedConfig, storage, 2000);
  assert.equal(payload.studyId, approvedConfig.studyId);
  assert.equal(payload.weeks[0].week, 1);
  const text = JSON.stringify(payload);
  for (const forbidden of ['startedAt', 'timestamp', 'url', 'title', 'domain', 'mission', 'note', 'tabId', 'depth']) {
    assert.equal(text.includes(`"${forbidden}"`), false, `export must not contain ${forbidden}`);
  }
  assert.equal(await buildStudyExport(STUDY_CONFIG, storage), null);
});

test('withdrawal deletes the separate study namespace', async () => {
  const storage = memoryStorage();
  await consentToStudy(approvedConfig, true, true, storage, 1000, fixedCrypto);
  await withdrawFromStudy(storage);
  assert.equal((await storage.get(STUDY_DATA_KEY))[STUDY_DATA_KEY], undefined);
  assert.equal(await buildStudyExport(approvedConfig, storage), null);
});

test('retention expiry automatically deletes the local record and stops counts and export', async () => {
  const storage = memoryStorage();
  const start = 1000;
  const expiry = start + approvedConfig.retentionDays * 24 * 60 * 60 * 1000;
  await consentToStudy(approvedConfig, true, true, storage, start, fixedCrypto);
  assert.equal(await recordStudyMetric(approvedConfig, 'sessionsStarted', storage, expiry), false);
  assert.equal((await getStudyStatus(approvedConfig, storage, expiry)).consented, false);
  assert.equal((await storage.get(STUDY_DATA_KEY))[STUDY_DATA_KEY], undefined);
  assert.equal(await buildStudyExport(approvedConfig, storage, expiry), null);
});
