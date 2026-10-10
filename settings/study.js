const $ = (selector) => document.querySelector(selector);
const statusEl = $('#study-status');
const detailsEl = $('#study-details');
const disclosureList = $('#study-disclosures');
const consentRow = $('#study-consent-row');
const consentCheck = $('#study-consent');
const eligibilityRow = $('#study-eligibility-row');
const eligibilityCheck = $('#study-eligible');
const enrollButton = $('#study-enroll');
const controls = $('#study-controls');
const codeEl = $('#study-code');
const previewButton = $('#study-preview');
const payloadEl = $('#study-payload');
const downloadButton = $('#study-download');
const withdrawButton = $('#study-withdraw');
const actionStatus = $('#study-action-status');
let reviewedPayload = null;

async function message(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (response?.error) throw new Error(response.error);
  return response;
}

const LABELS = {
  studyId: 'Study identifier', title: 'Study', purpose: 'Purpose', researchLead: 'Research lead',
  ethicsReview: 'Ethics review', contact: 'Study contact', dataRecipient: 'Who receives exported data', surveyProvider: 'Survey provider',
  retention: 'Retention period', withdrawal: 'How to withdraw', deletion: 'Deletion process',
  retentionDays: 'Automatic local deletion after (days)', storageSecurity: 'Local storage security',
  risks: 'Risks and privacy notes', inclusion: 'Who may participate', exclusion: 'Who cannot participate',
  countries: 'Eligible countries', languages: 'Study languages'
};

function renderDisclosures(disclosures) {
  disclosureList.replaceChildren();
  for (const [key, label] of Object.entries(LABELS)) {
    const value = disclosures?.[key];
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = label;
    dd.textContent = Array.isArray(value) ? value.join(', ') : String(value || '');
    disclosureList.append(dt, dd);
  }
}

async function loadStudyPanel() {
  try {
    const state = await message('GET_STUDY_STATUS');
    if (!state) throw new Error('study_status_unavailable');
    if (!state.available) {
      statusEl.textContent = 'Study collection is disabled in this build. No study counters are stored or transmitted off-device.';
      if (state.consented) {
        detailsEl.hidden = false;
        codeEl.textContent = `Existing local study code: ${state.studyCode}. Export is unavailable in this build; you can still withdraw and delete the local study data.`;
        controls.hidden = false;
        previewButton.hidden = true;
        withdrawButton.hidden = false;
      }
      return;
    }
    statusEl.textContent = 'A study is configured for this build. Review every disclosure below before deciding whether to participate.';
    detailsEl.hidden = false;
    renderDisclosures(state.disclosures);
    if (state.consented) {
      consentRow.hidden = true;
      eligibilityRow.hidden = true;
      enrollButton.hidden = true;
      controls.hidden = false;
      codeEl.textContent = `Your random study code is ${state.studyCode}. It is not derived from your browser profile or device.`;
    } else {
      consentRow.hidden = false;
      eligibilityRow.hidden = false;
      enrollButton.hidden = false;
      controls.hidden = true;
      consentCheck.checked = false;
      eligibilityCheck.checked = false;
      enrollButton.disabled = true;
    }
  } catch {
    statusEl.textContent = 'Study availability could not be checked. No new study counters are recorded unless a configured study and your explicit consent are both present.';
  }
}

function updateConsentButton() { enrollButton.disabled = !consentCheck.checked || !eligibilityCheck.checked; }
consentCheck.addEventListener('change', updateConsentButton);
eligibilityCheck.addEventListener('change', updateConsentButton);
enrollButton.addEventListener('click', async () => {
  if (!consentCheck.checked || !eligibilityCheck.checked) return;
  enrollButton.disabled = true;
  try {
    const result = await message('CONSENT_TO_STUDY', { confirmed: true, eligible: true });
    if (!result?.consented) throw new Error('study_consent_not_saved');
    actionStatus.textContent = 'Consent saved locally. Weekly aggregate counters can now be recorded; nothing is uploaded.';
    await loadStudyPanel();
  } catch {
    actionStatus.textContent = 'Consent could not be saved. No study counters were enabled; try again later.';
    updateConsentButton();
  }
});

previewButton.addEventListener('click', async () => {
  previewButton.disabled = true;
  try {
    reviewedPayload = await message('STUDY_EXPORT_PREVIEW');
    if (!reviewedPayload) throw new Error('study_payload_unavailable');
    payloadEl.textContent = JSON.stringify(reviewedPayload, null, 2);
    payloadEl.hidden = false;
    downloadButton.hidden = false;
    downloadButton.disabled = false;
    actionStatus.textContent = 'Review the exact JSON above. It contains only the random study code, study identifier, relative week numbers, and coarse counts.';
  } catch {
    reviewedPayload = null;
    payloadEl.textContent = '';
    payloadEl.hidden = true;
    downloadButton.hidden = true;
    actionStatus.textContent = 'The study summary is unavailable. No file was created.';
  } finally {
    previewButton.disabled = false;
  }
});

downloadButton.addEventListener('click', () => {
  if (!reviewedPayload || downloadButton.disabled) return;
  const blob = new Blob([JSON.stringify(reviewedPayload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'intent-grove-study-summary.json';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  actionStatus.textContent = 'The reviewed study summary was downloaded. It was not sent anywhere.';
});

withdrawButton.addEventListener('click', async () => {
  if (!window.confirm('Withdraw from the study and permanently delete the locally buffered study counters? This does not affect ordinary Intent Grove use.')) return;
  withdrawButton.disabled = true;
  try {
    await message('WITHDRAW_FROM_STUDY');
    reviewedPayload = null;
    payloadEl.replaceChildren();
    payloadEl.hidden = true;
    downloadButton.hidden = true;
    actionStatus.textContent = 'Study data deleted locally. No further study counters will be recorded unless you consent again in a configured study build.';
    await loadStudyPanel();
  } catch {
    withdrawButton.disabled = false;
    actionStatus.textContent = 'Study data could not be deleted. Please try again.';
  }
});

loadStudyPanel();
