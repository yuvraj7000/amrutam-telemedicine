/* global __ENV, __VU, __ITER, open */
import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { execution } from 'k6/execution';

const apiBaseUrl = (__ENV.API_BASE_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');

export const options = {
  scenarios: {
    writes: {
      executor: 'constant-arrival-rate',
      rate: 50,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 100,
      maxVUs: 300,
      exec: 'book',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:writes}': ['p(95)<500'],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
  },
};

function splitList(value, name) {
  const values = (value || '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (values.length === 0) {
    throw new Error(`Set ${name} to a comma-separated list of pre-seeded values.`);
  }
  return values;
}

const patientTokens = __ENV.PATIENT_ACCESS_TOKENS_FILE
  ? new SharedArray('patient access tokens', () => {
      const parsed = JSON.parse(open(__ENV.PATIENT_ACCESS_TOKENS_FILE));
      if (!Array.isArray(parsed))
        throw new Error('PATIENT_ACCESS_TOKENS_FILE must contain a JSON array.');
      return parsed;
    })
  : splitList(__ENV.PATIENT_ACCESS_TOKENS, 'PATIENT_ACCESS_TOKENS');

function utcDate(date) {
  return date.toISOString().slice(0, 10);
}

export function setup() {
  const doctorIds = splitList(__ENV.DOCTOR_IDS, 'DOCTOR_IDS');
  if (
    patientTokens.length < 10_000 ||
    patientTokens.some((token) => typeof token !== 'string' || !token)
  ) {
    throw new Error(
      'The 30k-booking profile needs at least 10,000 fresh patient access tokens (maximum three pending bookings each).',
    );
  }
  return { doctorIds };
}

export function book(data) {
  const iteration = execution.scenario.iterationInTest;
  const token = patientTokens[iteration % patientTokens.length];
  const doctorId = data.doctorIds[(__VU + __ITER - 2) % data.doctorIds.length];
  const from = new Date();
  const to = new Date(from.getTime() + 30 * 24 * 60 * 60 * 1000);
  const lookup = http.get(
    `${apiBaseUrl}/availability/${doctorId}/availability?from=${utcDate(from)}&to=${utcDate(to)}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/json',
      },
      tags: { operation: 'slot_lookup' },
    },
  );
  const lookupOk = check(lookup, {
    'availability lookup returns 200': (result) => result.status === 200,
  });
  if (!lookupOk) return;

  let availability;
  try {
    availability = lookup.json();
  } catch {
    check(null, { 'availability response is valid JSON': () => false });
    return;
  }
  const slots = availability && Array.isArray(availability.slots) ? availability.slots : [];
  if (slots.length === 0) {
    check(lookup, { 'pre-seeded availability has slots': () => false });
    return;
  }

  const slot = slots[Math.floor(Math.random() * slots.length)];
  const response = http.post(
    `${apiBaseUrl}/consultations`,
    JSON.stringify({ slotId: slot.id, mode: 'VIDEO' }),
    {
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'Idempotency-Key': `load-book-${__VU}-${__ITER}-${Date.now()}`,
      },
      responseCallback: http.expectedStatuses(201, 409),
      tags: { operation: 'consultation_booking' },
    },
  );
  check(response, {
    'booking succeeds or reports an expected slot race': (result) =>
      result.status === 201 || result.status === 409,
  });
}

export default function (data) {
  book(data);
}
