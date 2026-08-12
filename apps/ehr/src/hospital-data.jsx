import React from 'react';

/* hospital-data.jsx - clinical records: patient record, allergies, drugs, lab tests, break-glass contract */

// ---- PATIENT RECORD ----
const PATIENT = { hid: '', fullName: '', status: 'unknown', address: '', photo: null };

// ---- ALLERGIES ----
const ALLERGIES = [];

// ---- MEDICATION HISTORY ----
const MEDICATIONS = [];

// ---- VITALS HISTORY ----
const VITALS_HISTORY = [];

// ---- LAB RESULTS ----
const LAB_RESULTS = [];

// ---- ENCOUNTER HISTORY ----
const ENCOUNTERS = [];

// ---- IMMUNISATION RECORD ----
const IMMUNISATIONS = [];

// ---- DIAGNOSES (problem list) ----
const PROBLEM_LIST = [];

// ---- DRUG CATALOGUE (for prescribing) ----
const DRUG_CATALOGUE = [];

// ---- LAB TEST CATALOGUE ----
const LAB_TEST_CATALOGUE = [];

// ---- AUDIT LOG ----
const AUDIT_LOG = [];

// ---- BREAK-GLASS CONTRACT ----
const BREAK_GLASS_CONTRACT = {
  fourPartContract: [
    'Requires a stated reason',
    'Notifies the patient',
    'Auto-expires (max 4 hours)',
    'Admin-reviewable audit trail',
  ],
  allowedRoles: ['Physician', 'Surgeon', 'Consultant', 'Medical Officer'],
  notAllowed: ['Pharmacist', 'Lab Scientist', 'Finance', 'Reception'],
  maxDurationMinutes: 240,
};



export { PATIENT, ALLERGIES, MEDICATIONS, VITALS_HISTORY, LAB_RESULTS, ENCOUNTERS, IMMUNISATIONS, PROBLEM_LIST, DRUG_CATALOGUE, LAB_TEST_CATALOGUE, AUDIT_LOG, BREAK_GLASS_CONTRACT };
