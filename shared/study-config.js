// Production/default build: no active study, participant enrollment, or research collection.
// A separately reviewed study build must replace this configuration with approved,
// plain-language disclosures before the consent UI can enable enrollment.
export const STUDY_CONFIG = Object.freeze({
  enabled: false,
  ethicsApproved: false,
  retentionDays: 0,
  studyId: '',
  title: '',
  purpose: '',
  researchLead: '',
  ethicsReview: '',
  contact: '',
  dataRecipient: '',
  surveyProvider: '',
  retention: '',
  withdrawal: '',
  deletion: '',
  risks: '',
  storageSecurity: '',
  inclusion: '',
  exclusion: '',
  countries: [],
  languages: []
});
