/* global __ENV, __VU, __ITER */
import http from 'k6/http';
import { check } from 'k6';

const apiBaseUrl = (__ENV.API_BASE_URL || 'http://localhost:3000/api/v1').replace(/\/$/, '');
const searchTerms = (__ENV.SEARCH_TERMS || 'cardiology,dermatology,general medicine')
  .split(',')
  .map((term) => term.trim())
  .filter(Boolean);

export const options = {
  scenarios: {
    reads: {
      executor: 'constant-arrival-rate',
      rate: 350,
      timeUnit: '1s',
      duration: '10m',
      preAllocatedVUs: 200,
      maxVUs: 500,
      exec: 'search',
      gracefulStop: '30s',
    },
  },
  thresholds: {
    'http_req_duration{scenario:reads}': ['p(95)<200'],
    http_req_failed: ['rate<0.001'],
    checks: ['rate>0.999'],
  },
};

export function setup() {
  if (!__ENV.ACCESS_TOKEN) {
    throw new Error('Set ACCESS_TOKEN to a pre-seeded PATIENT or DOCTOR access token.');
  }
  return { token: __ENV.ACCESS_TOKEN };
}

export function search(data) {
  const term = searchTerms[(__VU + __ITER - 2) % searchTerms.length] || '';
  const query = `limit=20&sort=rating${term ? `&q=${encodeURIComponent(term)}` : ''}`;
  const response = http.get(`${apiBaseUrl}/doctors?${query}`, {
    headers: {
      Authorization: `Bearer ${data.token}`,
      Accept: 'application/json',
    },
    tags: { operation: 'doctor_search' },
  });

  check(response, {
    'doctor search returns 200': (result) => result.status === 200,
  });
}

export default search;
