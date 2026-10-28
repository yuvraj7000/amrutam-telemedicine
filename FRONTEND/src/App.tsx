import { useEffect, useMemo, useState } from 'react';
import type { FormEvent, ReactNode } from 'react';
import {
  ApiError,
  apiRequest,
  asRecord,
  dateAfter,
  displayDate,
  getRows,
  today,
  toDateTimeInput,
} from './api';

type Role = 'PATIENT' | 'DOCTOR' | 'ADMIN';
type User = {
  id: string;
  email: string;
  role: Role;
  phone?: string;
  status?: string;
  mfaEnabled?: boolean;
  profile?: Record<string, unknown>;
};
type Session = { accessToken: string; refreshToken: string; expiresIn?: number };
type Doctor = Record<string, unknown> & { id: string; displayName?: string };
type Slot = Record<string, unknown> & { id: string; start: string; end: string };
type Visit = Record<string, unknown> & { id: string; status?: string };
type Section =
  'home' | 'doctors' | 'appointments' | 'availability' | 'account' | 'admin' | 'system';
type AuthMode = 'login' | 'register';

const SESSION_KEY = 'amrutam.session';
const API_URL_KEY = 'amrutam.apiUrl';
const API_DEFAULT = 'http://localhost:3000';

function readSession(): Session | null {
  try {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (!stored) return null;
    const value = JSON.parse(stored) as Partial<Session>;
    return typeof value.accessToken === 'string' && typeof value.refreshToken === 'string'
      ? {
          accessToken: value.accessToken,
          refreshToken: value.refreshToken,
          expiresIn: value.expiresIn,
        }
      : null;
  } catch {
    return null;
  }
}

function jsonString(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="card-heading">
        <h2>{title}</h2>
        {description && <p>{description}</p>}
      </div>
      {children}
    </section>
  );
}

function JsonOutput({ value, label = 'API response' }: { value: unknown; label?: string }) {
  return (
    <details className="json-output">
      <summary>{label}</summary>
      <pre>{jsonString(value)}</pre>
    </details>
  );
}

function Field({
  label,
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & { label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
    </label>
  );
}

function TextArea({
  label,
  ...props
}: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea {...props} />
    </label>
  );
}

function SelectField({
  label,
  children,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select {...props}>{children}</select>
    </label>
  );
}

function App() {
  const [baseUrl, setBaseUrl] = useState(() => localStorage.getItem(API_URL_KEY) || API_DEFAULT);
  const [session, setSession] = useState<Session | null>(readSession);
  const [user, setUser] = useState<User | null>(null);
  const [profileLoading, setProfileLoading] = useState(() => Boolean(readSession()));
  const [section, setSection] = useState<Section>('home');
  const [authMode, setAuthMode] = useState<AuthMode>('login');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [lastResult, setLastResult] = useState<unknown>(null);
  const [apiStatus, setApiStatus] = useState<'checking' | 'online' | 'offline'>('checking');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [registerRole, setRegisterRole] = useState<'PATIENT' | 'DOCTOR'>('PATIENT');
  const [mfaChallenge, setMfaChallenge] = useState('');
  const [mfaMode, setMfaMode] = useState<'login' | 'enroll' | 'account' | null>(null);
  const [mfaContextToken, setMfaContextToken] = useState('');
  const [mfaSetup, setMfaSetup] = useState<Record<string, unknown> | null>(null);
  const [mfaCode, setMfaCode] = useState('');
  const [backupCode, setBackupCode] = useState('');
  const [useBackupCode, setUseBackupCode] = useState(false);
  const [backupCodes, setBackupCodes] = useState<string[]>([]);

  const [profile, setProfile] = useState<Record<string, unknown>>({});
  const [profilePhone, setProfilePhone] = useState('');
  const [doctorSearch, setDoctorSearch] = useState({
    q: '',
    specialization: '',
    language: '',
    mode: '',
    minFee: '',
    maxFee: '',
    minRating: '',
    sort: 'rating',
  });
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [doctorSearchSubmitted, setDoctorSearchSubmitted] = useState(false);
  const [doctorNextCursor, setDoctorNextCursor] = useState('');
  const [selectedDoctor, setSelectedDoctor] = useState<Doctor | null>(null);
  const [doctorSlots, setDoctorSlots] = useState<Slot[]>([]);
  const [availabilityFrom, setAvailabilityFrom] = useState(today());
  const [availabilityTo, setAvailabilityTo] = useState(dateAfter(7));
  const [bookingMode, setBookingMode] = useState('VIDEO');
  const [bookingReason, setBookingReason] = useState('');

  const [visits, setVisits] = useState<Visit[]>([]);
  const [selectedVisit, setSelectedVisit] = useState<Record<string, unknown> | null>(null);
  const [visitId, setVisitId] = useState('');
  const [visitReason, setVisitReason] = useState('');
  const [visitNotes, setVisitNotes] = useState('');
  const [visitStatusFilter, setVisitStatusFilter] = useState('');
  const [prescriptionJson, setPrescriptionJson] = useState(
    jsonString({
      diagnosis: '',
      medications: [{ name: '', dosage: '', frequency: '', durationDays: 5, instructions: '' }],
      advice: '',
    }),
  );
  const [prescriptionId, setPrescriptionId] = useState('');
  const [prescriptionData, setPrescriptionData] = useState<unknown>(null);

  const [slotStart, setSlotStart] = useState(() =>
    toDateTimeInput(new Date(Date.now() + 86_400_000)),
  );
  const [slotEnd, setSlotEnd] = useState(() =>
    toDateTimeInput(new Date(Date.now() + 86_400_000 + 30 * 60_000)),
  );
  const [slotFrom, setSlotFrom] = useState(() => toDateTimeInput(new Date()));
  const [slotTo, setSlotTo] = useState(() =>
    toDateTimeInput(new Date(Date.now() + 7 * 86_400_000)),
  );
  const [slotStatus, setSlotStatus] = useState('AVAILABLE');
  const [mySlots, setMySlots] = useState<Slot[]>([]);
  const [useRecurrence, setUseRecurrence] = useState(false);
  const [recurrence, setRecurrence] = useState({
    from: today(),
    to: dateAfter(7),
    daysOfWeek: '1,2,3,4,5',
    start: '09:00',
    end: '17:00',
    slotMinutes: '30',
    timezone: 'Asia/Kolkata',
  });

  const [doctorIdInput, setDoctorIdInput] = useState('');
  const [verificationStatus, setVerificationStatus] = useState<'VERIFIED' | 'REJECTED'>('VERIFIED');
  const [verificationNote, setVerificationNote] = useState('');
  const [adminDateFrom, setAdminDateFrom] = useState(dateAfter(-7));
  const [adminDateTo, setAdminDateTo] = useState(today());
  const [analyticsMetric, setAnalyticsMetric] = useState('consultations');
  const [analyticsGranularity, setAnalyticsGranularity] = useState('day');
  const [topDoctorMetric, setTopDoctorMetric] = useState('consultations');
  const [auditShard, setAuditShard] = useState('0');
  const [auditCursor, setAuditCursor] = useState('');
  const [auditFilter, setAuditFilter] = useState({
    actorId: '',
    action: '',
    resourceType: '',
    resourceId: '',
    outcome: '',
  });
  const [refundPaymentId, setRefundPaymentId] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundAmount, setRefundAmount] = useState('');
  const [metricsToken, setMetricsToken] = useState('');
  const [webhookBody, setWebhookBody] = useState(
    jsonString({
      id: 'evt_local_test',
      type: 'payment.succeeded',
      data: { paymentId: '', amountMinor: 0 },
    }),
  );
  const [webhookSignature, setWebhookSignature] = useState('');

  const api = <T,>(
    path: string,
    method = 'GET',
    body?: unknown,
    options: { token?: string; headers?: Record<string, string>; rawBody?: boolean } = {},
  ) =>
    apiRequest<T>(baseUrl, path, {
      method,
      body,
      token: options.token === undefined ? session?.accessToken : options.token,
      headers: options.headers,
      rawBody: options.rawBody,
    });

  const run = async <T,>(action: () => Promise<T>, success: string): Promise<T | undefined> => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const value = await action();
      setLastResult(value);
      setNotice(success);
      return value;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'The request failed.');
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const updateSession = (value: Session | null) => {
    setSession(value);
    if (value) sessionStorage.setItem(SESSION_KEY, JSON.stringify(value));
    else {
      sessionStorage.removeItem(SESSION_KEY);
      setUser(null);
      setProfileLoading(false);
    }
  };

  const loadProfile = async (token = session?.accessToken) => {
    if (!token) return;
    const result = await apiRequest<User>(baseUrl, '/api/v1/users/me', { token });
    setUser(result);
    setProfile(result.profile ?? {});
    setProfilePhone(result.phone ?? '');
  };

  const establishSession = async (tokens: Record<string, unknown>) => {
    if (typeof tokens.accessToken !== 'string' || typeof tokens.refreshToken !== 'string') {
      throw new Error('The API did not return a complete session. Please try signing in again.');
    }
    const nextSession: Session = {
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      ...(typeof tokens.expiresIn === 'number' ? { expiresIn: tokens.expiresIn } : {}),
    };
    updateSession(nextSession);
    setProfileLoading(true);
    try {
      await loadProfile(nextSession.accessToken);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Could not load your account.');
      setProfileLoading(false);
      return;
    }
    setProfileLoading(false);
    setSection('home');
    setMfaMode(null);
    setMfaContextToken('');
    setMfaChallenge('');
    setMfaSetup(null);
    setMfaCode('');
    setBackupCode('');
    setAuthMode('login');
  };

  useEffect(() => {
    let active = true;
    apiRequest(baseUrl, '/health/live')
      .then(() => {
        if (active) setApiStatus('online');
      })
      .catch(() => {
        if (active) setApiStatus('offline');
      });
    return () => {
      active = false;
    };
  }, [baseUrl]);

  useEffect(() => {
    if (!session?.accessToken || user) return;
    let active = true;
    setProfileLoading(true);
    apiRequest<User>(baseUrl, '/api/v1/users/me', { token: session.accessToken })
      .then((value) => {
        if (!active) return;
        setUser(value);
        setProfile(value.profile ?? {});
        setProfilePhone(value.phone ?? '');
      })
      .catch((reason: unknown) => {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 401) updateSession(null);
        setError(reason instanceof Error ? reason.message : 'Could not load your account.');
      })
      .finally(() => {
        if (active) setProfileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [baseUrl, session?.accessToken, user]);

  const submit = (event: FormEvent<HTMLFormElement>, action: () => void | Promise<void>) => {
    event.preventDefault();
    void action();
  };

  const startMfaSetup = async (token: string, mode: 'enroll' | 'account') => {
    setMfaMode(mode);
    setMfaContextToken(token);
    const value = await run(
      () =>
        apiRequest<Record<string, unknown>>(baseUrl, '/api/v1/auth/mfa/setup', {
          method: 'POST',
          token,
        }),
      'Scan the QR code in an authenticator app, then enter its six-digit code.',
    );
    if (value) setMfaSetup(value);
  };

  const register = async () => {
    const body: Record<string, unknown> = {
      email,
      password,
      fullName,
      ...(phone ? { phone } : {}),
      role: registerRole,
    };
    if (registerRole === 'DOCTOR') {
      body.doctor = {
        licenseNumber: (document.getElementById('licenseNumber') as HTMLInputElement).value,
        specializations: (document.getElementById('specializations') as HTMLInputElement).value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        languages: (document.getElementById('languages') as HTMLInputElement).value
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean),
        consultationFeeMinor: Number(
          (document.getElementById('consultationFee') as HTMLInputElement).value,
        ),
        yearsExperience: Number(
          (document.getElementById('yearsExperience') as HTMLInputElement).value,
        ),
        bio: (document.getElementById('doctorBio') as HTMLTextAreaElement).value,
      };
    }
    const result = await run(
      () => api<Record<string, unknown>>('/api/v1/auth/register', 'POST', body, { token: '' }),
      'Account created. Sign in with your new credentials.',
    );
    if (result) {
      setAuthMode('login');
    }
  };

  const login = async () => {
    const result = await run(
      () => api<Record<string, unknown>>('/api/v1/auth/login', 'POST', { email, password }),
      'Signed in.',
    );
    if (!result) return;
    if (result.mfaRequired === true && typeof result.mfaToken === 'string') {
      setMfaMode('login');
      setMfaChallenge(result.mfaToken);
      setNotice('Enter your authenticator code or a one-time backup code.');
      return;
    }
    if (result.mfaEnrollmentRequired === true && typeof result.setupToken === 'string') {
      await startMfaSetup(result.setupToken, 'enroll');
      return;
    }
    await establishSession(result);
  };

  const verifyLoginMfa = async () => {
    const result = await run(
      () =>
        api<Record<string, unknown>>(
          '/api/v1/auth/mfa/verify',
          'POST',
          useBackupCode
            ? { mfaToken: mfaChallenge, backupCode }
            : { mfaToken: mfaChallenge, code: mfaCode },
          { token: '' },
        ),
      'MFA verified.',
    );
    if (result) await establishSession(result);
  };

  const enableMfa = async () => {
    const result = await run(
      () =>
        api<Record<string, unknown>>(
          '/api/v1/auth/mfa/enable',
          'POST',
          { code: mfaCode },
          { token: mfaContextToken },
        ),
      'Multi-factor authentication enabled. Save these backup codes securely.',
    );
    if (!result) return;
    if (Array.isArray(result.backupCodes))
      setBackupCodes(result.backupCodes.filter((item): item is string => typeof item === 'string'));
    if (typeof result.accessToken === 'string') await establishSession(result);
    else {
      setMfaMode(null);
      setMfaSetup(null);
      setMfaCode('');
      await loadProfile();
    }
  };

  const doLogout = async (all = false) => {
    if (!session) return;
    const result = await run(
      () =>
        all
          ? api('/api/v1/auth/logout-all', 'POST')
          : api('/api/v1/auth/logout', 'POST', { refreshToken: session.refreshToken }),
      all ? 'All sessions have been signed out.' : 'Signed out.',
    );
    if (result !== undefined) {
      updateSession(null);
      setSection('home');
    }
  };

  const refreshSession = async () => {
    if (!session) return;
    const result = await run(
      () =>
        api<Record<string, unknown>>(
          '/api/v1/auth/refresh',
          'POST',
          { refreshToken: session.refreshToken },
          { token: '' },
        ),
      'Session refreshed.',
    );
    if (
      !result ||
      typeof result.accessToken !== 'string' ||
      typeof result.refreshToken !== 'string'
    )
      return;
    const next: Session = {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      ...(typeof result.expiresIn === 'number' ? { expiresIn: result.expiresIn } : {}),
    };
    updateSession(next);
  };

  const searchDoctors = async (
    event?: FormEvent<HTMLFormElement>,
    cursor?: string,
    append = false,
  ) => {
    event?.preventDefault();
    const query = new URLSearchParams({ sort: doctorSearch.sort, limit: '50' });
    if (doctorSearch.q) query.set('q', doctorSearch.q);
    if (doctorSearch.specialization) query.set('specialization', doctorSearch.specialization);
    if (doctorSearch.language) query.set('language', doctorSearch.language);
    if (doctorSearch.mode) query.set('mode', doctorSearch.mode);
    if (doctorSearch.minFee) query.set('minFee', doctorSearch.minFee);
    if (doctorSearch.maxFee) query.set('maxFee', doctorSearch.maxFee);
    if (doctorSearch.minRating) query.set('minRating', doctorSearch.minRating);
    if (cursor) query.set('cursor', cursor);
    if (user?.role === 'ADMIN') query.set('includeUnverified', 'true');
    const result = await run(
      () => api<Record<string, unknown>>(`/api/v1/doctors?${query.toString()}`),
      'Doctor search complete.',
    );
    if (result) {
      setDoctors((current) =>
        append ? [...current, ...(getRows(result) as Doctor[])] : (getRows(result) as Doctor[]),
      );
      if (!append) setDoctorSearchSubmitted(true);
      const nextCursor = asRecord(result.meta).nextCursor;
      setDoctorNextCursor(typeof nextCursor === 'string' ? nextCursor : '');
    }
  };

  const openDoctor = async (id: string) => {
    const result = await run(
      () => api<Doctor>(`/api/v1/doctors/${encodeURIComponent(id)}`),
      'Doctor profile loaded.',
    );
    if (!result) return;
    setSelectedDoctor(result);
    setDoctorIdInput(id);
    const slots = await run(
      () =>
        api<Record<string, unknown>>(
          `/api/v1/availability/${encodeURIComponent(id)}/availability?from=${availabilityFrom}&to=${availabilityTo}`,
        ),
      'Available appointment times loaded.',
    );
    if (slots) setDoctorSlots(getRows(slots, 'slots') as Slot[]);
  };

  const bookSlot = async (slot: Slot) => {
    const result = await run(
      () =>
        api<Record<string, unknown>>(
          '/api/v1/consultations',
          'POST',
          {
            slotId: slot.id,
            mode: bookingMode,
            ...(bookingReason ? { reason: bookingReason } : {}),
          },
          { headers: { 'Idempotency-Key': crypto.randomUUID() } },
        ),
      'Appointment request created. Complete payment while the slot is held.',
    );
    if (result) {
      setSelectedVisit(result);
      if (typeof result.id === 'string') setVisitId(result.id);
      await loadVisits();
      setSection('appointments');
    }
  };

  const loadDoctorAvailability = async () => {
    if (!selectedDoctor?.id) return;
    const result = await run(
      () =>
        api<Record<string, unknown>>(
          `/api/v1/availability/${encodeURIComponent(selectedDoctor.id)}/availability?from=${availabilityFrom}&to=${availabilityTo}`,
        ),
      'Available appointment times loaded.',
    );
    if (result) setDoctorSlots(getRows(result, 'slots') as Slot[]);
  };

  const loadVisits = async () => {
    const query = new URLSearchParams({ limit: '50' });
    if (visitStatusFilter) query.set('status', visitStatusFilter);
    const result = await run(
      () => api<Record<string, unknown>>(`/api/v1/consultations?${query.toString()}`),
      'Appointments loaded.',
    );
    if (result) setVisits(getRows(result) as Visit[]);
  };

  const openVisit = async (id: string) => {
    const result = await run(
      () => api<Record<string, unknown>>(`/api/v1/consultations/${encodeURIComponent(id)}`),
      'Appointment details loaded.',
    );
    if (result) {
      setSelectedVisit(result);
      setVisitId(id);
      const payment = asRecord(result.payment);
      if (typeof payment.id === 'string') setRefundPaymentId(payment.id);
    }
  };

  const visitAction = async (action: 'cancel' | 'start' | 'complete' | 'no-show') => {
    if (!visitId) return;
    const body =
      action === 'cancel'
        ? { reason: visitReason }
        : action === 'complete'
          ? { notes: visitNotes }
          : undefined;
    const result = await run(
      () =>
        api<Record<string, unknown>>(
          `/api/v1/consultations/${encodeURIComponent(visitId)}/${action}`,
          'POST',
          body,
          action === 'cancel' ? { headers: { 'Idempotency-Key': crypto.randomUUID() } } : {},
        ),
      `Appointment ${action === 'no-show' ? 'marked as no-show' : `${action}ed`}.`,
    );
    if (result) {
      await openVisit(visitId);
      await loadVisits();
    }
  };

  const loadMySlots = async () => {
    const query = new URLSearchParams({
      from: new Date(slotFrom).toISOString(),
      to: new Date(slotTo).toISOString(),
    });
    if (slotStatus) query.set('status', slotStatus);
    const result = await run(
      () => api<Record<string, unknown>>(`/api/v1/availability/me/slots?${query.toString()}`),
      'Your availability loaded.',
    );
    if (result) setMySlots(getRows(result) as Slot[]);
  };

  const createSlots = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body = useRecurrence
      ? {
          recurrence: {
            from: recurrence.from,
            to: recurrence.to,
            daysOfWeek: recurrence.daysOfWeek.split(',').map(Number).filter(Number.isInteger),
            dailyWindows: [{ start: recurrence.start, end: recurrence.end }],
            slotMinutes: Number(recurrence.slotMinutes),
            timezone: recurrence.timezone,
          },
        }
      : {
          slots: [
            { start: new Date(slotStart).toISOString(), end: new Date(slotEnd).toISOString() },
          ],
        };
    const result = await run(
      () =>
        api<Record<string, unknown>>('/api/v1/availability/me/slots', 'POST', body, {
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        }),
      'Availability saved.',
    );
    if (result) await loadMySlots();
  };

  const savePhone = async () => {
    const result = await run(
      () => api<User>('/api/v1/users/me', 'PATCH', profilePhone ? { phone: profilePhone } : {}),
      'Phone number updated.',
    );
    if (result) {
      setUser(result);
      setProfilePhone(result.phone ?? '');
    }
  };

  const saveProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body: Record<string, unknown> = {
      fullName: String(form.get('fullName') ?? ''),
      gender: String(form.get('gender') ?? 'UNDISCLOSED'),
      locale: String(form.get('locale') ?? 'en-IN'),
      timezone: String(form.get('timezone') ?? 'Asia/Kolkata'),
    };
    for (const key of ['dateOfBirth', 'address', 'emergencyContact']) {
      const value = String(form.get(key) ?? '');
      if (value) body[key] = value;
    }
    const result = await run(
      () => api<User>('/api/v1/users/me/profile', 'PUT', body),
      'Profile updated.',
    );
    if (result) {
      setUser(result);
      setProfile(result.profile ?? {});
    }
  };

  const updateDoctorProfile = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const body = {
      specializations: String(form.get('specializations') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      languages: String(form.get('languages') ?? '')
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean),
      bio: String(form.get('bio') ?? ''),
      yearsExperience: Number(form.get('yearsExperience')),
      consultationFeeMinor: Number(form.get('consultationFeeMinor')),
      modes: form.getAll('modes').map(String),
      isAccepting: form.get('isAccepting') === 'on',
    };
    await run(() => api('/api/v1/doctors/me', 'PUT', body), 'Doctor profile updated.');
  };

  const createPrescription = async () => {
    if (!visitId) return;
    let body: unknown;
    try {
      body = JSON.parse(prescriptionJson) as unknown;
    } catch {
      setError('Prescription must be valid JSON.');
      return;
    }
    const result = await run(
      () =>
        api<Record<string, unknown>>(
          `/api/v1/consultations/${encodeURIComponent(visitId)}/prescriptions`,
          'POST',
          body,
        ),
      'Prescription issued.',
    );
    if (result && typeof result.id === 'string') setPrescriptionId(result.id);
  };

  const loadPrescriptions = async () => {
    if (!visitId) return;
    const result = await run(
      () => api(`/api/v1/consultations/${encodeURIComponent(visitId)}/prescriptions`),
      'Prescription list loaded.',
    );
    if (result) setPrescriptionData(result);
  };

  const loadPrescription = async () => {
    if (!prescriptionId) return;
    const result = await run(
      () => api(`/api/v1/prescriptions/${encodeURIComponent(prescriptionId)}`),
      'Prescription details loaded.',
    );
    if (result) setPrescriptionData(result);
  };

  const simulatePayment = async (outcome: 'succeeded' | 'failed') => {
    const paymentId = String(asRecord(selectedVisit?.payment).id ?? '');
    if (!paymentId) {
      setError('Open an appointment that has a payment before simulating a payment result.');
      return;
    }
    await run(
      () =>
        api(`/api/v1/dev/payments/${encodeURIComponent(paymentId)}/simulate`, 'POST', { outcome }),
      `Payment ${outcome} event submitted.`,
    );
    await openVisit(visitId);
  };

  const loadPayment = async () => {
    if (!refundPaymentId) return;
    const result = await run(
      () => api(`/api/v1/payments/${encodeURIComponent(refundPaymentId)}`),
      'Payment details loaded.',
    );
    if (result) setLastResult(result);
  };

  const submitRefund = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const body: Record<string, unknown> = { reason: refundReason };
    if (refundAmount) body.amountMinor = Number(refundAmount);
    await run(
      () =>
        api(`/api/v1/payments/${encodeURIComponent(refundPaymentId)}/refund`, 'POST', body, {
          headers: { 'Idempotency-Key': crypto.randomUUID() },
        }),
      'Refund request accepted for processing.',
    );
  };

  const verifyDoctor = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = await run<Record<string, unknown>>(
      () =>
        api<Record<string, unknown>>(
          `/api/v1/admin/doctors/${encodeURIComponent(doctorIdInput)}/verification`,
          'PATCH',
          {
            status: verificationStatus,
            ...(verificationNote ? { note: verificationNote } : {}),
          },
        ),
      `Doctor marked ${verificationStatus.toLowerCase()}.`,
    );
    if (!result) return;
    setDoctors((current) =>
      current.map((doctor) =>
        doctor.id === doctorIdInput
          ? { ...doctor, verificationStatus: result.verificationStatus }
          : doctor,
      ),
    );
    setSelectedDoctor((current) =>
      current?.id === doctorIdInput
        ? { ...current, verificationStatus: result.verificationStatus }
        : current,
    );
  };

  const adminRange = () =>
    `from=${encodeURIComponent(adminDateFrom)}&to=${encodeURIComponent(adminDateTo)}`;

  const loadAnalytics = async (kind: 'overview' | 'timeseries' | 'top-doctors') => {
    const path =
      kind === 'overview'
        ? `/api/v1/admin/analytics/overview?${adminRange()}`
        : kind === 'timeseries'
          ? `/api/v1/admin/analytics/timeseries?${adminRange()}&metric=${analyticsMetric}&granularity=${analyticsGranularity}`
          : `/api/v1/admin/analytics/top-doctors?${adminRange()}&by=${topDoctorMetric}&limit=10`;
    await run(() => api(path), `${kind === 'top-doctors' ? 'Top doctors' : kind} report loaded.`);
  };

  const loadAudit = async (verify = false) => {
    const path = verify
      ? `/api/v1/admin/audit-logs/verify?shard=${encodeURIComponent(auditShard)}&${adminRange()}`
      : `/api/v1/admin/audit-logs?${adminRange()}&limit=50${auditCursor ? `&cursor=${encodeURIComponent(auditCursor)}` : ''}${auditFilter.actorId ? `&actorId=${encodeURIComponent(auditFilter.actorId)}` : ''}${auditFilter.action ? `&action=${encodeURIComponent(auditFilter.action)}` : ''}${auditFilter.resourceType ? `&resourceType=${encodeURIComponent(auditFilter.resourceType)}` : ''}${auditFilter.resourceId ? `&resourceId=${encodeURIComponent(auditFilter.resourceId)}` : ''}${auditFilter.outcome ? `&outcome=${encodeURIComponent(auditFilter.outcome)}` : ''}`;
    const result = await run(
      () => api<Record<string, unknown>>(path),
      verify ? 'Audit hash-chain verification complete.' : 'Audit entries loaded.',
    );
    if (!verify && result && typeof result.nextCursor === 'string')
      setAuditCursor(result.nextCursor);
  };

  const runWebhook = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    try {
      JSON.parse(webhookBody);
    } catch {
      setError('Webhook body must be valid JSON.');
      return;
    }
    await run(
      () =>
        api('/api/v1/payments/webhook', 'POST', webhookBody, {
          token: '',
          rawBody: true,
          headers: {
            'Content-Type': 'application/json',
            ...(webhookSignature ? { 'X-Signature': webhookSignature } : {}),
          },
        }),
      'Webhook accepted.',
    );
  };

  const navItems = useMemo(() => {
    const items: { id: Section; label: string }[] = [
      { id: 'home', label: 'Overview' },
      { id: 'doctors', label: user?.role === 'ADMIN' ? 'Doctors' : 'Find a doctor' },
      { id: 'appointments', label: 'Appointments' },
      { id: 'account', label: 'My account' },
      { id: 'system', label: 'API status' },
    ];
    if (user?.role === 'DOCTOR') items.splice(3, 0, { id: 'availability', label: 'Availability' });
    if (user?.role === 'ADMIN') items.splice(3, 0, { id: 'admin', label: 'Administration' });
    return items;
  }, [user?.role]);

  const setApiBaseUrl = (value: string) => {
    setBaseUrl(value);
    localStorage.setItem(API_URL_KEY, value);
    setApiStatus('checking');
  };

  if (session && !user && profileLoading) {
    return (
      <div className="loading-page">
        <span className="brand-mark">A</span>
        <p>Loading your secure account…</p>
      </div>
    );
  }

  if (!session || !user) {
    return (
      <div className="auth-page">
        <header className="topbar auth-topbar">
          <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
            <span className="brand-mark">A</span>
            <span>
              amrutam <small>care portal</small>
            </span>
          </a>
          <div className="connection-control">
            <span className={`status-dot ${apiStatus}`} />
            <span>
              {apiStatus === 'online'
                ? 'API connected'
                : apiStatus === 'offline'
                  ? 'API unavailable'
                  : 'Connecting'}
            </span>
            <input
              aria-label="Backend API URL"
              value={baseUrl}
              onChange={(event) => setApiBaseUrl(event.target.value)}
            />
          </div>
        </header>
        <main className="auth-layout">
          <section className="welcome-panel">
            <span className="eyebrow">CARE, CONNECTED</span>
            <h1>Better care starts with a conversation.</h1>
            <p>
              Find trusted doctors, manage appointments, and keep your care journey in one place.
            </p>
            <div className="welcome-points">
              <span>
                <b>01</b> Find verified specialists
              </span>
              <span>
                <b>02</b> Book a convenient time
              </span>
              <span>
                <b>03</b> Stay connected through every visit
              </span>
            </div>
            <div className="welcome-note">
              For local setup, start the backend and worker, then seed demo accounts or create a new
              account.
            </div>
          </section>
          <section className="auth-card">
            {mfaMode ? (
              <div className="auth-form">
                <span className="eyebrow">
                  {mfaMode === 'login' ? 'SECURE SIGN IN' : 'ACCOUNT SECURITY'}
                </span>
                <h2>{mfaMode === 'login' ? 'Verify it’s you' : 'Set up authenticator'}</h2>
                <p className="muted">
                  {mfaMode === 'login'
                    ? 'Enter a current six-digit code or use an unused backup code.'
                    : 'Scan this QR code using an authenticator app. Doctors and administrators must enable MFA to sign in.'}
                </p>
                {mfaMode !== 'login' && mfaSetup && (
                  <div className="qr-card">
                    {typeof mfaSetup.qrDataUrl === 'string' && (
                      <img src={mfaSetup.qrDataUrl} alt="Authenticator setup QR code" />
                    )}
                    <p>Manual setup key</p>
                    <code>{String(mfaSetup.secret ?? '')}</code>
                    <a href={String(mfaSetup.otpauthUrl ?? '#')}>Open authenticator app</a>
                  </div>
                )}
                {mfaMode === 'login' && (
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={useBackupCode}
                      onChange={(event) => setUseBackupCode(event.target.checked)}
                    />
                    Use a backup code
                  </label>
                )}
                <form
                  onSubmit={(event) =>
                    submit(event, mfaMode === 'login' ? verifyLoginMfa : enableMfa)
                  }
                >
                  {mfaMode === 'login' && useBackupCode ? (
                    <Field
                      label="Backup code"
                      value={backupCode}
                      onChange={(event) => setBackupCode(event.target.value)}
                      autoComplete="one-time-code"
                      required
                    />
                  ) : (
                    <Field
                      label="Six-digit authenticator code"
                      inputMode="numeric"
                      autoComplete="one-time-code"
                      maxLength={6}
                      value={mfaCode}
                      onChange={(event) => setMfaCode(event.target.value)}
                      required
                    />
                  )}
                  <button className="button primary wide" disabled={busy}>
                    {busy
                      ? 'Please wait…'
                      : mfaMode === 'login'
                        ? 'Verify and sign in'
                        : 'Enable MFA'}
                  </button>
                </form>
                {mfaMode === 'login' && (
                  <button
                    className="text-button"
                    onClick={() => {
                      setMfaMode(null);
                      setMfaChallenge('');
                    }}
                  >
                    Back to sign in
                  </button>
                )}
              </div>
            ) : (
              <>
                <div className="auth-tabs">
                  <button
                    className={authMode === 'login' ? 'active' : ''}
                    onClick={() => setAuthMode('login')}
                  >
                    Sign in
                  </button>
                  <button
                    className={authMode === 'register' ? 'active' : ''}
                    onClick={() => setAuthMode('register')}
                  >
                    Create account
                  </button>
                </div>
                {authMode === 'login' && (
                  <div className="auth-form">
                    <span className="eyebrow">WELCOME BACK</span>
                    <h2>Sign in to your account</h2>
                    <p className="muted">Use your registered email and password.</p>
                    <form onSubmit={(event) => submit(event, login)}>
                      <Field
                        label="Email address"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                      />
                      <Field
                        label="Password"
                        type="password"
                        autoComplete="current-password"
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                      <button className="button primary wide" disabled={busy}>
                        {busy ? 'Signing in…' : 'Sign in'}
                      </button>
                    </form>
                  </div>
                )}
                {authMode === 'register' && (
                  <div className="auth-form">
                    <span className="eyebrow">GET STARTED</span>
                    <h2>Create your account</h2>
                    <p className="muted">Create a patient or doctor account to get started.</p>
                    <form onSubmit={(event) => submit(event, register)}>
                      <SelectField
                        label="I am registering as"
                        value={registerRole}
                        onChange={(event) =>
                          setRegisterRole(event.target.value as 'PATIENT' | 'DOCTOR')
                        }
                      >
                        <option value="PATIENT">Patient</option>
                        <option value="DOCTOR">Doctor</option>
                      </SelectField>
                      <Field
                        label="Full name"
                        autoComplete="name"
                        value={fullName}
                        onChange={(event) => setFullName(event.target.value)}
                        required
                      />
                      <Field
                        label="Email address"
                        type="email"
                        autoComplete="email"
                        value={email}
                        onChange={(event) => setEmail(event.target.value)}
                        required
                      />
                      <Field
                        label="Phone (optional)"
                        type="tel"
                        autoComplete="tel"
                        value={phone}
                        onChange={(event) => setPhone(event.target.value)}
                      />
                      <Field
                        label="Password (at least 12 characters)"
                        type="password"
                        autoComplete="new-password"
                        minLength={12}
                        value={password}
                        onChange={(event) => setPassword(event.target.value)}
                        required
                      />
                      {registerRole === 'DOCTOR' && (
                        <div className="nested-form">
                          <Field id="licenseNumber" label="Medical license number" required />
                          <Field
                            id="specializations"
                            label="Specializations (comma-separated)"
                            placeholder="general-medicine, cardiology"
                            required
                          />
                          <Field
                            id="languages"
                            label="Languages (comma-separated)"
                            placeholder="en, hi"
                            required
                          />
                          <div className="form-grid">
                            <Field
                              id="consultationFee"
                              label="Consultation fee (minor currency units)"
                              type="number"
                              min="0"
                              defaultValue="50000"
                              required
                            />
                            <Field
                              id="yearsExperience"
                              label="Years of experience"
                              type="number"
                              min="0"
                              max="70"
                              defaultValue="1"
                              required
                            />
                          </div>
                          <TextArea id="doctorBio" label="Professional bio (optional)" rows={3} />
                        </div>
                      )}
                      <button className="button primary wide" disabled={busy}>
                        {busy ? 'Creating account…' : 'Create account'}
                      </button>
                    </form>
                  </div>
                )}
              </>
            )}
            {error && (
              <div className="message error" role="alert">
                {error}
              </div>
            )}
            {notice && (
              <div className="message success" role="status">
                {notice}
              </div>
            )}
            {backupCodes.length > 0 && (
              <div className="message warning">
                <strong>Save these backup codes now.</strong>
                <div className="backup-codes">
                  {backupCodes.map((code) => (
                    <code key={code}>{code}</code>
                  ))}
                </div>
                <button className="text-button" onClick={() => setBackupCodes([])}>
                  I saved them
                </button>
              </div>
            )}
          </section>
        </main>
      </div>
    );
  }

  const sectionTitle: Record<Section, string> = {
    home: 'Your care overview',
    doctors: user.role === 'ADMIN' ? 'Doctor directory' : 'Find a doctor',
    appointments: 'Appointments and visits',
    availability: 'Manage your availability',
    account: 'Account and security',
    admin: 'Administration',
    system: 'API status and tools',
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <a
          className="brand"
          href="#"
          onClick={(event) => {
            event.preventDefault();
            setSection('home');
          }}
        >
          <span className="brand-mark">A</span>
          <span>
            amrutam <small>care portal</small>
          </span>
        </a>
        <div className="connection-control">
          <span className={`status-dot ${apiStatus}`} />
          <span>
            {apiStatus === 'online'
              ? 'API connected'
              : apiStatus === 'offline'
                ? 'API unavailable'
                : 'Checking API'}
          </span>
          <input
            aria-label="Backend API URL"
            value={baseUrl}
            onChange={(event) => setApiBaseUrl(event.target.value)}
          />
        </div>
        <div className="user-menu">
          <span className="avatar">
            {(user.profile?.fullName as string | undefined)?.slice(0, 1) ||
              user.email.slice(0, 1).toUpperCase()}
          </span>
          <span className="user-details">
            <strong>{String(user.profile?.fullName ?? user.email)}</strong>
            <small>{user.role}</small>
          </span>
          <button
            className="button secondary small"
            disabled={busy}
            onClick={() => void doLogout()}
          >
            Sign out
          </button>
        </div>
      </header>
      <div className="layout">
        <aside className="sidebar">
          <div className="sidebar-label">WORKSPACE</div>
          <nav aria-label="Main navigation">
            {navItems.map((item) => (
              <button
                key={item.id}
                className={`nav-item ${section === item.id ? 'selected' : ''}`}
                onClick={() => setSection(item.id)}
              >
                <span className="nav-indicator" />
                {item.label}
              </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <span className="eyebrow">AMRUTAM HEALTH</span>
            <p>Care that keeps you moving forward.</p>
            <a href={`${baseUrl.replace(/\/+$/, '')}/docs`} target="_blank" rel="noreferrer">
              API documentation ↗
            </a>
          </div>
        </aside>
        <main className="main-content">
          <div className="page-heading">
            <div>
              <span className="eyebrow">{user.role} PORTAL</span>
              <h1>{sectionTitle[section]}</h1>
            </div>
            <span className={`connection-pill ${apiStatus}`}>
              <i />
              {apiStatus === 'online'
                ? 'Services online'
                : apiStatus === 'offline'
                  ? 'API unavailable'
                  : 'Checking API'}
            </span>
          </div>
          {error && (
            <div className="message error" role="alert">
              {error}
              <button onClick={() => setError('')} aria-label="Dismiss error">
                ×
              </button>
            </div>
          )}
          {notice && (
            <div className="message success" role="status">
              {notice}
              <button onClick={() => setNotice('')} aria-label="Dismiss message">
                ×
              </button>
            </div>
          )}
          {backupCodes.length > 0 && (
            <div className="message warning">
              <strong>Save your MFA backup codes now. They will not be shown again.</strong>
              <div className="backup-codes">
                {backupCodes.map((code) => (
                  <code key={code}>{code}</code>
                ))}
              </div>
              <button className="text-button" onClick={() => setBackupCodes([])}>
                I saved them
              </button>
            </div>
          )}

          {section === 'home' && (
            <div className="content-grid">
              <Card
                title={`Hello, ${String(user.profile?.fullName ?? 'there')}`}
                description="Your care, appointments, and account at a glance."
              >
                <div className="summary-grid">
                  <div className="summary-tile">
                    <span>Account</span>
                    <strong>{user.status ?? 'ACTIVE'}</strong>
                  </div>
                  <div className="summary-tile">
                    <span>Email</span>
                    <strong>{user.email}</strong>
                  </div>
                  <div className="summary-tile">
                    <span>Multi-factor auth</span>
                    <strong>
                      {user.mfaEnabled
                        ? 'Enabled'
                        : user.role === 'PATIENT'
                          ? 'Optional'
                          : 'Required'}
                    </strong>
                  </div>
                </div>
                <div className="quick-actions">
                  {user.role !== 'ADMIN' && (
                    <button
                      className="button primary"
                      onClick={() =>
                        setSection(user.role === 'DOCTOR' ? 'availability' : 'doctors')
                      }
                    >
                      {user.role === 'DOCTOR' ? 'Manage availability' : 'Find a doctor'}
                    </button>
                  )}
                  <button
                    className="button secondary"
                    onClick={() => {
                      setSection('appointments');
                      void loadVisits();
                    }}
                  >
                    View appointments
                  </button>
                  <button className="button secondary" onClick={() => setSection('account')}>
                    Manage account
                  </button>
                </div>
              </Card>
              <Card
                title="Getting started"
                description="Choose the actions available to your account role."
              >
                <ul className="check-list">
                  {user.role === 'PATIENT' && (
                    <>
                      <li>Search verified doctors by specialty, visit mode, or fee.</li>
                      <li>
                        Choose an available slot and complete the mock payment in development.
                      </li>
                      <li>Review your consultation details and prescriptions.</li>
                    </>
                  )}
                  {user.role === 'DOCTOR' && (
                    <>
                      <li>Keep your professional profile and accepting status up to date.</li>
                      <li>Publish availability for patients to book.</li>
                      <li>Manage visits and issue encrypted prescriptions.</li>
                      <li>Complete MFA setup to protect your account.</li>
                    </>
                  )}
                  {user.role === 'ADMIN' && (
                    <>
                      <li>Review doctor profiles and update verification status.</li>
                      <li>Review audit integrity and operational analytics.</li>
                      <li>Monitor refunds and service health.</li>
                    </>
                  )}
                </ul>
              </Card>
              <Card
                title="Recent appointments"
                description="Load your latest appointments to see their current status."
              >
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void loadVisits()}
                >
                  Load appointments
                </button>
                {visits.length > 0 && (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Doctor / patient</th>
                          <th>Scheduled</th>
                          <th>Status</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {visits.slice(0, 5).map((visit) => (
                          <tr key={visit.id}>
                            <td>
                              {String(
                                asRecord(visit.doctor).displayName ??
                                  asRecord(visit.patient).fullName ??
                                  'Consultation',
                              )}
                            </td>
                            <td>{displayDate(visit.scheduledStart)}</td>
                            <td>
                              <span className="status-tag">{String(visit.status ?? '—')}</span>
                            </td>
                            <td>
                              <button
                                className="text-button"
                                onClick={() => {
                                  void openVisit(visit.id);
                                  setSection('appointments');
                                }}
                              >
                                Open
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )}

          {section === 'doctors' && (
            <div className="content-grid">
              <Card
                title="Search the directory"
                description={
                  user.role === 'ADMIN'
                    ? 'Include unverified profiles to review doctor onboarding.'
                    : 'Search verified doctors and explore available appointment times.'
                }
              >
                <form className="form-grid" onSubmit={(event) => void searchDoctors(event)}>
                  <Field
                    label="Name or keyword"
                    value={doctorSearch.q}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, q: event.target.value })
                    }
                    placeholder="e.g. Sharma"
                  />
                  <Field
                    label="Specialization"
                    value={doctorSearch.specialization}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, specialization: event.target.value })
                    }
                    placeholder="e.g. general-medicine"
                  />
                  <Field
                    label="Language"
                    value={doctorSearch.language}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, language: event.target.value })
                    }
                    placeholder="e.g. en"
                  />
                  <SelectField
                    label="Consultation mode"
                    value={doctorSearch.mode}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, mode: event.target.value })
                    }
                  >
                    <option value="">Any mode</option>
                    <option value="VIDEO">Video</option>
                    <option value="AUDIO">Audio</option>
                    <option value="CHAT">Chat</option>
                  </SelectField>
                  <SelectField
                    label="Sort by"
                    value={doctorSearch.sort}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, sort: event.target.value })
                    }
                  >
                    <option value="rating">Rating</option>
                    <option value="fee_asc">Lowest fee</option>
                    <option value="fee_desc">Highest fee</option>
                    <option value="experience">Experience</option>
                    <option value="next_available">Next available</option>
                  </SelectField>
                  <Field
                    label="Minimum fee (minor units)"
                    type="number"
                    min="0"
                    value={doctorSearch.minFee}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, minFee: event.target.value })
                    }
                  />
                  <Field
                    label="Maximum fee (minor units)"
                    type="number"
                    min="0"
                    value={doctorSearch.maxFee}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, maxFee: event.target.value })
                    }
                  />
                  <Field
                    label="Minimum rating"
                    type="number"
                    min="0"
                    max="5"
                    step="0.1"
                    value={doctorSearch.minRating}
                    onChange={(event) =>
                      setDoctorSearch({ ...doctorSearch, minRating: event.target.value })
                    }
                  />
                  <div className="form-actions">
                    <button className="button primary" disabled={busy}>
                      Search doctors
                    </button>
                  </div>
                </form>
              </Card>
              <Card title={`Doctors${doctors.length ? ` (${doctors.length})` : ''}`}>
                {doctors.length === 0 ? (
                  <p className="empty-state">
                    {doctorSearchSubmitted
                      ? 'No doctors match these filters. Only verified doctors who are accepting patients appear here. Try broadening your search; newly registered doctor profiles need admin verification first.'
                      : 'Search to see matching doctors.'}
                  </p>
                ) : (
                  <div className="doctor-grid">
                    {doctors.map((doctor) => (
                      <article className="doctor-card" key={doctor.id}>
                        <div className="doctor-initial">
                          {String(doctor.displayName ?? 'D').slice(0, 1)}
                        </div>
                        <div className="doctor-main">
                          <h3>{String(doctor.displayName ?? 'Doctor')}</h3>
                          <p>
                            {Array.isArray(doctor.specializations)
                              ? doctor.specializations.join(' · ')
                              : 'Specialist'}
                          </p>
                          <div className="doctor-meta">
                            <span>{String(doctor.yearsExperience ?? 0)} yrs experience</span>
                            <span>
                              {String(doctor.consultationFeeMinor ?? '—')}{' '}
                              {String(doctor.currency ?? '')}
                            </span>
                            <span>{String(doctor.ratingAvg ?? '—')} ★</span>
                            {user.role === 'ADMIN' && (
                              <span>
                                Verification: {String(doctor.verificationStatus ?? '—')}
                              </span>
                            )}
                          </div>
                          <button
                            className="text-button"
                            onClick={() => void openDoctor(doctor.id)}
                          >
                            {user.role === 'ADMIN'
                              ? 'Review doctor profile →'
                              : 'Profile & availability →'}
                          </button>
                          {user.role === 'ADMIN' &&
                            doctor.verificationStatus !== 'VERIFIED' && (
                              <button
                                className="button secondary"
                                onClick={() => {
                                  setDoctorIdInput(doctor.id);
                                  setVerificationStatus('VERIFIED');
                                  setSection('admin');
                                }}
                              >
                                Review this doctor
                              </button>
                            )}
                        </div>
                      </article>
                    ))}
                  </div>
                )}
                {doctorNextCursor && (
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void searchDoctors(undefined, doctorNextCursor, true)}
                  >
                    Load more doctors
                  </button>
                )}
              </Card>
              {selectedDoctor && (
                <Card
                  title={String(selectedDoctor.displayName ?? 'Doctor profile')}
                  description={String(selectedDoctor.bio ?? '')}
                >
                  <div className="summary-grid">
                    <div className="summary-tile">
                      <span>Specialties</span>
                      <strong>
                        {Array.isArray(selectedDoctor.specializations)
                          ? selectedDoctor.specializations.join(', ')
                          : '—'}
                      </strong>
                    </div>
                    <div className="summary-tile">
                      <span>Modes</span>
                      <strong>
                        {Array.isArray(selectedDoctor.modes)
                          ? selectedDoctor.modes.join(', ')
                          : '—'}
                      </strong>
                    </div>
                    <div className="summary-tile">
                      <span>Languages</span>
                      <strong>
                        {Array.isArray(selectedDoctor.languages)
                          ? selectedDoctor.languages.join(', ')
                          : '—'}
                      </strong>
                    </div>
                    {user.role === 'ADMIN' && (
                      <div className="summary-tile">
                        <span>Verification</span>
                        <strong>{String(selectedDoctor.verificationStatus ?? '—')}</strong>
                      </div>
                    )}
                  </div>
                  <div className="form-grid compact-grid">
                    <Field
                      label="Available from"
                      type="date"
                      value={availabilityFrom}
                      onChange={(event) => setAvailabilityFrom(event.target.value)}
                    />
                    <Field
                      label="Available through"
                      type="date"
                      value={availabilityTo}
                      onChange={(event) => setAvailabilityTo(event.target.value)}
                    />
                    <div className="form-actions">
                      <button
                        className="button secondary"
                        onClick={() => void loadDoctorAvailability()}
                      >
                        Refresh available slots
                      </button>
                    </div>
                  </div>
                  {doctorSlots.length === 0 ? (
                    <p className="empty-state">
                      No available times are loaded for this date range.
                    </p>
                  ) : (
                    <>
                      <div className="form-grid compact-grid">
                        <SelectField
                          label="Visit mode"
                          value={bookingMode}
                          onChange={(event) => setBookingMode(event.target.value)}
                        >
                          <option value="VIDEO">Video</option>
                          <option value="AUDIO">Audio</option>
                          <option value="CHAT">Chat</option>
                        </SelectField>
                        <Field
                          label="Reason for visit (optional)"
                          value={bookingReason}
                          onChange={(event) => setBookingReason(event.target.value)}
                        />
                      </div>
                      <div className="slot-grid">
                        {doctorSlots.map((slot) => (
                          <div className="slot-card" key={slot.id}>
                            <span>{displayDate(slot.start)}</span>
                            <button
                              className="button primary small"
                              disabled={busy || user.role !== 'PATIENT'}
                              onClick={() => void bookSlot(slot)}
                            >
                              {user.role === 'PATIENT' ? 'Book this time' : 'Patient booking only'}
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  )}
                  <JsonOutput value={selectedDoctor} label="Full doctor profile response" />
                </Card>
              )}
              {user.role === 'DOCTOR' && (
                <Card
                  title="Professional profile"
                  description="Update specialties, languages, consultation modes, and acceptance status."
                >
                  <form className="form-grid" onSubmit={(event) => void updateDoctorProfile(event)}>
                    <Field
                      name="specializations"
                      label="Specializations (comma-separated)"
                      defaultValue={
                        Array.isArray(profile.specializations)
                          ? profile.specializations.join(', ')
                          : ''
                      }
                      required
                    />
                    <Field
                      name="languages"
                      label="Languages (comma-separated)"
                      defaultValue={
                        Array.isArray(profile.languages) ? profile.languages.join(', ') : ''
                      }
                      required
                    />
                    <Field
                      name="yearsExperience"
                      label="Years of experience"
                      type="number"
                      min="0"
                      max="70"
                      defaultValue={String(profile.yearsExperience ?? 0)}
                      required
                    />
                    <Field
                      name="consultationFeeMinor"
                      label="Consultation fee (minor units)"
                      type="number"
                      min="0"
                      defaultValue={String(profile.consultationFeeMinor ?? 0)}
                      required
                    />
                    <TextArea
                      name="bio"
                      label="Professional bio"
                      rows={3}
                      defaultValue={String(profile.bio ?? '')}
                    />
                    <fieldset className="field">
                      <legend>Consultation modes</legend>
                      <label className="checkbox-field">
                        <input name="modes" type="checkbox" value="VIDEO" defaultChecked />
                        Video
                      </label>
                      <label className="checkbox-field">
                        <input name="modes" type="checkbox" value="AUDIO" />
                        Audio
                      </label>
                      <label className="checkbox-field">
                        <input name="modes" type="checkbox" value="CHAT" defaultChecked />
                        Chat
                      </label>
                    </fieldset>
                    <label className="checkbox-field">
                      <input name="isAccepting" type="checkbox" defaultChecked />
                      Accepting new appointments
                    </label>
                    <div className="form-actions">
                      <button className="button primary" disabled={busy}>
                        Save doctor profile
                      </button>
                    </div>
                  </form>
                </Card>
              )}
            </div>
          )}

          {section === 'availability' && user.role === 'DOCTOR' && (
            <div className="content-grid">
              <Card
                title="Create availability"
                description="Publish a single appointment slot or create a repeating schedule (up to 31 days)."
              >
                <div className="toggle-row">
                  <label className="checkbox-field">
                    <input
                      type="checkbox"
                      checked={useRecurrence}
                      onChange={(event) => setUseRecurrence(event.target.checked)}
                    />
                    Create a recurring schedule
                  </label>
                </div>
                <form className="form-grid" onSubmit={(event) => void createSlots(event)}>
                  {useRecurrence ? (
                    <>
                      <Field
                        label="Start date"
                        type="date"
                        value={recurrence.from}
                        onChange={(event) =>
                          setRecurrence({ ...recurrence, from: event.target.value })
                        }
                        required
                      />
                      <Field
                        label="End date"
                        type="date"
                        value={recurrence.to}
                        onChange={(event) =>
                          setRecurrence({ ...recurrence, to: event.target.value })
                        }
                        required
                      />
                      <Field
                        label="Days of week (0 Sunday … 6 Saturday)"
                        value={recurrence.daysOfWeek}
                        onChange={(event) =>
                          setRecurrence({ ...recurrence, daysOfWeek: event.target.value })
                        }
                        required
                      />
                      <Field
                        label="Daily start time"
                        type="time"
                        value={recurrence.start}
                        onChange={(event) =>
                          setRecurrence({ ...recurrence, start: event.target.value })
                        }
                        required
                      />
                      <Field
                        label="Daily end time"
                        type="time"
                        value={recurrence.end}
                        onChange={(event) =>
                          setRecurrence({ ...recurrence, end: event.target.value })
                        }
                        required
                      />
                      <Field
                        label="Slot length (minutes)"
                        type="number"
                        min="5"
                        max="240"
                        value={recurrence.slotMinutes}
                        onChange={(event) =>
                          setRecurrence({ ...recurrence, slotMinutes: event.target.value })
                        }
                        required
                      />
                      <Field
                        label="Timezone"
                        value={recurrence.timezone}
                        onChange={(event) =>
                          setRecurrence({ ...recurrence, timezone: event.target.value })
                        }
                        required
                      />
                    </>
                  ) : (
                    <>
                      <Field
                        label="Slot starts"
                        type="datetime-local"
                        value={slotStart}
                        onChange={(event) => setSlotStart(event.target.value)}
                        required
                      />
                      <Field
                        label="Slot ends"
                        type="datetime-local"
                        value={slotEnd}
                        onChange={(event) => setSlotEnd(event.target.value)}
                        required
                      />
                    </>
                  )}
                  <div className="form-actions">
                    <button className="button primary" disabled={busy}>
                      Save availability
                    </button>
                  </div>
                </form>
              </Card>
              <Card title="Your slots">
                <div className="form-grid compact-grid">
                  <Field
                    label="From"
                    type="datetime-local"
                    value={slotFrom}
                    onChange={(event) => setSlotFrom(event.target.value)}
                  />
                  <Field
                    label="To"
                    type="datetime-local"
                    value={slotTo}
                    onChange={(event) => setSlotTo(event.target.value)}
                  />
                  <SelectField
                    label="Status"
                    value={slotStatus}
                    onChange={(event) => setSlotStatus(event.target.value)}
                  >
                    <option value="">Any status</option>
                    <option value="AVAILABLE">Available</option>
                    <option value="HELD">Held</option>
                    <option value="BOOKED">Booked</option>
                    <option value="CANCELLED">Cancelled</option>
                  </SelectField>
                  <div className="form-actions">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void loadMySlots()}
                    >
                      Load slots
                    </button>
                  </div>
                </div>
                {mySlots.length === 0 ? (
                  <p className="empty-state">Load slots to manage your schedule.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Starts</th>
                          <th>Ends</th>
                          <th>Status</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {mySlots.map((slot) => (
                          <tr key={slot.id}>
                            <td>{displayDate(slot.start)}</td>
                            <td>{displayDate(slot.end)}</td>
                            <td>{String(slot.status ?? '—')}</td>
                            <td>
                              <button
                                className="text-button danger-text"
                                disabled={busy || slot.status !== 'AVAILABLE'}
                                onClick={() =>
                                  void run(
                                    () =>
                                      api(
                                        `/api/v1/availability/me/slots/${encodeURIComponent(slot.id)}`,
                                        'DELETE',
                                      ),
                                    'Availability slot deleted.',
                                  )
                                }
                              >
                                Delete
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          )}

          {section === 'appointments' && (
            <div className="content-grid">
              <Card
                title="Your appointments"
                description="Patients and doctors can review consultation status and open visit details."
              >
                <div className="form-inline">
                  <SelectField
                    label="Status"
                    value={visitStatusFilter}
                    onChange={(event) => setVisitStatusFilter(event.target.value)}
                  >
                    <option value="">All statuses</option>
                    <option value="PENDING_PAYMENT">Pending payment</option>
                    <option value="CONFIRMED">Confirmed</option>
                    <option value="IN_PROGRESS">In progress</option>
                    <option value="COMPLETED">Completed</option>
                    <option value="CANCELLED">Cancelled</option>
                    <option value="EXPIRED">Expired</option>
                    <option value="NO_SHOW">No show</option>
                  </SelectField>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void loadVisits()}
                  >
                    Refresh
                  </button>
                </div>
                {visits.length === 0 ? (
                  <p className="empty-state">No appointments loaded yet.</p>
                ) : (
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>{user.role === 'DOCTOR' ? 'Patient' : 'Doctor'}</th>
                          <th>Date and time</th>
                          <th>Visit mode</th>
                          <th>Status</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {visits.map((visit) => (
                          <tr key={visit.id}>
                            <td>
                              {String(
                                asRecord(user.role === 'DOCTOR' ? visit.patient : visit.doctor)
                                  .fullName ??
                                  asRecord(visit.doctor).displayName ??
                                  '—',
                              )}
                            </td>
                            <td>{displayDate(visit.scheduledStart)}</td>
                            <td>{String(visit.mode ?? '—')}</td>
                            <td>
                              <span className="status-tag">{String(visit.status ?? '—')}</span>
                            </td>
                            <td>
                              <button
                                className="text-button"
                                onClick={() => void openVisit(visit.id)}
                              >
                                View details
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
              {selectedVisit && (
                <Card title="Appointment details">
                  <div className="summary-grid">
                    <div className="summary-tile">
                      <span>Appointment</span>
                      <strong className="id-value">{String(selectedVisit.id ?? visitId)}</strong>
                    </div>
                    <div className="summary-tile">
                      <span>Status</span>
                      <strong>{String(selectedVisit.status ?? '—')}</strong>
                    </div>
                    <div className="summary-tile">
                      <span>Scheduled</span>
                      <strong>{displayDate(selectedVisit.scheduledStart)}</strong>
                    </div>
                    <div className="summary-tile">
                      <span>Payment</span>
                      <strong>{String(asRecord(selectedVisit.payment).status ?? '—')}</strong>
                    </div>
                  </div>
                  {typeof selectedVisit.meetingUrl === 'string' && (
                    <a
                      className="button primary"
                      href={selectedVisit.meetingUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Join consultation
                    </a>
                  )}
                  <div className="action-panel">
                    {user.role === 'PATIENT' && (
                      <>
                        <Field
                          label="Cancellation reason"
                          value={visitReason}
                          onChange={(event) => setVisitReason(event.target.value)}
                        />
                        <button
                          className="button secondary"
                          disabled={busy || !visitReason}
                          onClick={() => void visitAction('cancel')}
                        >
                          Cancel appointment
                        </button>
                      </>
                    )}
                    {user.role === 'DOCTOR' && (
                      <>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void visitAction('start')}
                        >
                          Start visit
                        </button>
                        <Field
                          label="Completion notes"
                          value={visitNotes}
                          onChange={(event) => setVisitNotes(event.target.value)}
                        />
                        <button
                          className="button primary"
                          disabled={busy || !visitNotes}
                          onClick={() => void visitAction('complete')}
                        >
                          Complete visit
                        </button>
                        <button
                          className="button secondary"
                          disabled={busy}
                          onClick={() => void visitAction('no-show')}
                        >
                          Mark no-show
                        </button>
                      </>
                    )}
                  </div>
                  <div className="action-panel">
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void simulatePayment('succeeded')}
                    >
                      Simulate payment success (development)
                    </button>
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void simulatePayment('failed')}
                    >
                      Simulate payment failure (development)
                    </button>
                    {typeof asRecord(selectedVisit.payment).id === 'string' && (
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => {
                          setRefundPaymentId(String(asRecord(selectedVisit.payment).id));
                          void loadPayment();
                        }}
                      >
                        Check payment status
                      </button>
                    )}
                  </div>
                  <div className="form-grid">
                    <TextArea
                      label="Prescription JSON"
                      rows={10}
                      value={prescriptionJson}
                      onChange={(event) => setPrescriptionJson(event.target.value)}
                    />
                    {user.role === 'DOCTOR' && (
                      <button
                        className="button primary"
                        disabled={busy}
                        onClick={() => void createPrescription()}
                      >
                        Issue prescription
                      </button>
                    )}
                    <div className="form-inline">
                      <button
                        className="button secondary"
                        disabled={busy}
                        onClick={() => void loadPrescriptions()}
                      >
                        List prescriptions
                      </button>
                      <Field
                        label="Prescription ID"
                        value={prescriptionId}
                        onChange={(event) => setPrescriptionId(event.target.value)}
                      />
                      <button
                        className="button secondary"
                        disabled={busy || !prescriptionId}
                        onClick={() => void loadPrescription()}
                      >
                        Open prescription
                      </button>
                    </div>
                    {prescriptionData !== null && (
                      <JsonOutput value={prescriptionData} label="Prescription response" />
                    )}
                  </div>
                  <JsonOutput value={selectedVisit} label="Full appointment response" />
                </Card>
              )}
            </div>
          )}

          {section === 'account' && (
            <div className="content-grid">
              <Card
                title="Personal information"
                description="Your profile is only visible to authorized members of your care team."
              >
                <div className="form-grid compact-grid">
                  <Field label="Email address" type="email" value={user.email} readOnly />
                  <Field
                    label="Phone"
                    type="tel"
                    value={profilePhone}
                    onChange={(event) => setProfilePhone(event.target.value)}
                  />
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void savePhone()}
                  >
                    Update phone
                  </button>
                </div>
                <form className="form-grid" onSubmit={(event) => void saveProfile(event)}>
                  <Field
                    name="fullName"
                    label="Full name"
                    defaultValue={String(profile.fullName ?? '')}
                    required
                  />
                  <SelectField
                    name="gender"
                    label="Gender"
                    defaultValue={String(profile.gender ?? 'UNDISCLOSED')}
                  >
                    <option value="MALE">Male</option>
                    <option value="FEMALE">Female</option>
                    <option value="OTHER">Other</option>
                    <option value="UNDISCLOSED">Prefer not to say</option>
                  </SelectField>
                  <Field
                    name="dateOfBirth"
                    label="Date of birth"
                    type="date"
                    defaultValue={String(profile.dateOfBirth ?? '')}
                  />
                  <Field
                    name="locale"
                    label="Locale"
                    defaultValue={String(profile.locale ?? 'en-IN')}
                  />
                  <Field
                    name="timezone"
                    label="Timezone"
                    defaultValue={String(profile.timezone ?? 'Asia/Kolkata')}
                  />
                  <TextArea
                    name="address"
                    label="Address"
                    rows={2}
                    defaultValue={String(profile.address ?? '')}
                  />
                  <TextArea
                    name="emergencyContact"
                    label="Emergency contact"
                    rows={2}
                    defaultValue={String(profile.emergencyContact ?? '')}
                  />
                  <div className="form-actions">
                    <button className="button primary" disabled={busy}>
                      Save personal profile
                    </button>
                  </div>
                </form>
                <JsonOutput value={user} label="Current account response" />
              </Card>
              <Card title="Password security">
                <form
                  className="form-grid"
                  onSubmit={(event) =>
                    submit(event, async () => {
                      const form = new FormData(event.currentTarget);
                      const result = await run(
                        () =>
                          api('/api/v1/auth/password/change', 'POST', {
                            currentPassword: String(form.get('currentPassword') ?? ''),
                            newPassword: String(form.get('newPassword') ?? ''),
                          }),
                        'Password changed. Sign in again with your new password.',
                      );
                      if (result !== undefined) updateSession(null);
                    })
                  }
                >
                  <Field
                    name="currentPassword"
                    label="Current password"
                    type="password"
                    autoComplete="current-password"
                    required
                  />
                  <Field
                    name="newPassword"
                    label="New password (12+ characters)"
                    type="password"
                    minLength={12}
                    autoComplete="new-password"
                    required
                  />
                  <div className="form-actions">
                    <button className="button secondary" disabled={busy}>
                      Change password
                    </button>
                  </div>
                </form>
              </Card>
              <Card
                title="Multi-factor authentication"
                description={
                  user.role === 'DOCTOR' || user.role === 'ADMIN'
                    ? 'MFA is required for doctor and administrator accounts.'
                    : 'Add an authenticator app for additional account protection.'
                }
              >
                <p className="security-state">
                  Status: <strong>{user.mfaEnabled ? 'Enabled' : 'Not enabled'}</strong>
                </p>
                {!user.mfaEnabled && !mfaSetup && (
                  <button
                    className="button primary"
                    disabled={busy}
                    onClick={() => void startMfaSetup(session.accessToken, 'account')}
                  >
                    Set up authenticator
                  </button>
                )}
                {mfaSetup && mfaMode === 'account' && (
                  <div className="qr-card inline-qr">
                    {typeof mfaSetup.qrDataUrl === 'string' && (
                      <img src={mfaSetup.qrDataUrl} alt="Authenticator setup QR code" />
                    )}
                    <p>Manual setup key</p>
                    <code>{String(mfaSetup.secret ?? '')}</code>
                    <form className="form-inline" onSubmit={(event) => submit(event, enableMfa)}>
                      <Field
                        label="Six-digit code"
                        inputMode="numeric"
                        maxLength={6}
                        value={mfaCode}
                        onChange={(event) => setMfaCode(event.target.value)}
                        required
                      />
                      <button className="button primary" disabled={busy}>
                        Enable MFA
                      </button>
                    </form>
                  </div>
                )}
                {user.mfaEnabled && user.role === 'PATIENT' && (
                  <form
                    className="form-inline"
                    onSubmit={(event) =>
                      submit(event, async () => {
                        const form = new FormData(event.currentTarget);
                        await run(
                          () =>
                            api('/api/v1/auth/mfa/disable', 'POST', {
                              password: String(form.get('password') ?? ''),
                              code: String(form.get('code') ?? ''),
                            }),
                          'MFA disabled.',
                        );
                        await loadProfile();
                      })
                    }
                  >
                    <Field name="password" label="Password" type="password" required />
                    <Field
                      name="code"
                      label="Authenticator code"
                      inputMode="numeric"
                      maxLength={6}
                      required
                    />
                    <button className="button secondary" disabled={busy}>
                      Disable MFA
                    </button>
                  </form>
                )}
                {user.role !== 'PATIENT' && (
                  <p className="muted">
                    MFA cannot be disabled for doctor or administrator accounts.
                  </p>
                )}
              </Card>
              <Card title="Sessions">
                <p className="muted">
                  Access tokens expire. Refresh this session or sign out this device / all devices.
                </p>
                <div className="action-panel">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void refreshSession()}
                  >
                    Refresh session
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void doLogout()}
                  >
                    Sign out this session
                  </button>
                  <button
                    className="button danger"
                    disabled={busy}
                    onClick={() => void doLogout(true)}
                  >
                    Sign out all sessions
                  </button>
                </div>
              </Card>
            </div>
          )}

          {section === 'admin' && user.role === 'ADMIN' && (
            <div className="content-grid">
              <Card
                title="Doctor verification"
                description="Search unverified profiles from the Doctors page, then review and update a doctor's verification status here."
              >
                <form className="form-grid" onSubmit={(event) => void verifyDoctor(event)}>
                  <Field
                    label="Doctor profile ID"
                    value={doctorIdInput}
                    onChange={(event) => setDoctorIdInput(event.target.value)}
                    required
                  />
                  <SelectField
                    label="Decision"
                    value={verificationStatus}
                    onChange={(event) =>
                      setVerificationStatus(event.target.value as 'VERIFIED' | 'REJECTED')
                    }
                  >
                    <option value="VERIFIED">Verify</option>
                    <option value="REJECTED">Reject</option>
                  </SelectField>
                  <TextArea
                    label="Review note (optional)"
                    rows={3}
                    value={verificationNote}
                    onChange={(event) => setVerificationNote(event.target.value)}
                  />
                  <button className="button primary" disabled={busy}>
                    Submit review
                  </button>
                </form>
              </Card>
              <Card
                title="Analytics"
                description="Choose a reporting window. Date ranges are inclusive."
              >
                <div className="form-grid compact-grid">
                  <Field
                    label="From"
                    type="date"
                    value={adminDateFrom}
                    onChange={(event) => setAdminDateFrom(event.target.value)}
                  />
                  <Field
                    label="To"
                    type="date"
                    value={adminDateTo}
                    onChange={(event) => setAdminDateTo(event.target.value)}
                  />
                </div>
                <div className="action-panel">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void loadAnalytics('overview')}
                  >
                    Overview
                  </button>
                  <SelectField
                    label="Time-series metric"
                    value={analyticsMetric}
                    onChange={(event) => setAnalyticsMetric(event.target.value)}
                  >
                    <option value="consultations">Consultations</option>
                    <option value="revenue">Revenue</option>
                    <option value="cancellations">Cancellations</option>
                  </SelectField>
                  <SelectField
                    label="Granularity"
                    value={analyticsGranularity}
                    onChange={(event) => setAnalyticsGranularity(event.target.value)}
                  >
                    <option value="day">Daily</option>
                    <option value="week">Weekly</option>
                  </SelectField>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void loadAnalytics('timeseries')}
                  >
                    Time series
                  </button>
                  <SelectField
                    label="Rank doctors by"
                    value={topDoctorMetric}
                    onChange={(event) => setTopDoctorMetric(event.target.value)}
                  >
                    <option value="consultations">Consultations</option>
                    <option value="revenue">Revenue</option>
                    <option value="rating">Rating</option>
                  </SelectField>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void loadAnalytics('top-doctors')}
                  >
                    Top doctors
                  </button>
                </div>
              </Card>
              <Card
                title="Audit log"
                description="Query audit entries for a maximum 31-day range, or verify a monthly shard's hash chain."
              >
                <div className="form-grid compact-grid">
                  <Field
                    label="From"
                    type="date"
                    value={adminDateFrom}
                    onChange={(event) => setAdminDateFrom(event.target.value)}
                  />
                  <Field
                    label="To"
                    type="date"
                    value={adminDateTo}
                    onChange={(event) => setAdminDateTo(event.target.value)}
                  />
                  <Field
                    label="Actor ID (optional)"
                    value={auditFilter.actorId}
                    onChange={(event) =>
                      setAuditFilter({ ...auditFilter, actorId: event.target.value })
                    }
                  />
                  <Field
                    label="Action (optional)"
                    value={auditFilter.action}
                    onChange={(event) =>
                      setAuditFilter({ ...auditFilter, action: event.target.value })
                    }
                  />
                  <Field
                    label="Resource type (optional)"
                    value={auditFilter.resourceType}
                    onChange={(event) =>
                      setAuditFilter({ ...auditFilter, resourceType: event.target.value })
                    }
                  />
                  <Field
                    label="Resource ID (optional)"
                    value={auditFilter.resourceId}
                    onChange={(event) =>
                      setAuditFilter({ ...auditFilter, resourceId: event.target.value })
                    }
                  />
                  <SelectField
                    label="Outcome"
                    value={auditFilter.outcome}
                    onChange={(event) =>
                      setAuditFilter({ ...auditFilter, outcome: event.target.value })
                    }
                  >
                    <option value="">Any outcome</option>
                    <option value="SUCCESS">Success</option>
                    <option value="DENIED">Denied</option>
                    <option value="FAILURE">Failure</option>
                  </SelectField>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => {
                      setAuditCursor('');
                      void loadAudit();
                    }}
                  >
                    Search audit logs
                  </button>
                  <Field
                    label="Shard (0–15)"
                    type="number"
                    min="0"
                    max="15"
                    value={auditShard}
                    onChange={(event) => setAuditShard(event.target.value)}
                  />
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() => void loadAudit(true)}
                  >
                    Verify hash chain
                  </button>
                  {auditCursor && (
                    <button
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void loadAudit()}
                    >
                      Load next page
                    </button>
                  )}
                </div>
              </Card>
              <Card
                title="Payment refunds"
                description="Refunds are accepted into the backend's asynchronous processing workflow."
              >
                <form className="form-grid" onSubmit={(event) => void submitRefund(event)}>
                  <Field
                    label="Payment ID"
                    value={refundPaymentId}
                    onChange={(event) => setRefundPaymentId(event.target.value)}
                    required
                  />
                  <Field
                    label="Refund amount (minor units, optional)"
                    type="number"
                    min="1"
                    value={refundAmount}
                    onChange={(event) => setRefundAmount(event.target.value)}
                  />
                  <Field
                    label="Reason"
                    value={refundReason}
                    onChange={(event) => setRefundReason(event.target.value)}
                    required
                  />
                  <div className="form-actions">
                    <button
                      type="button"
                      className="button secondary"
                      disabled={busy}
                      onClick={() => void loadPayment()}
                    >
                      Get payment details
                    </button>
                    <button className="button primary" disabled={busy}>
                      Request refund
                    </button>
                  </div>
                </form>
              </Card>
            </div>
          )}

          {section === 'system' && (
            <div className="content-grid">
              <Card
                title="Service health"
                description="Readiness checks cover the API's PostgreSQL and Redis connections."
              >
                <div className="action-panel">
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api('/health/live', 'GET', undefined, { token: '' }),
                        'Liveness check complete.',
                      )
                    }
                  >
                    Check liveness
                  </button>
                  <button
                    className="button secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => api('/health/ready', 'GET', undefined, { token: '' }),
                        'Readiness check complete.',
                      )
                    }
                  >
                    Check readiness
                  </button>
                  <a
                    className="button secondary"
                    href={`${baseUrl.replace(/\/+$/, '')}/openapi.json`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open OpenAPI JSON ↗
                  </a>
                  <a
                    className="button secondary"
                    href={`${baseUrl.replace(/\/+$/, '')}/docs`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open Swagger UI ↗
                  </a>
                </div>
                <div className="form-inline">
                  <Field
                    label="Metrics bearer token"
                    type="password"
                    value={metricsToken}
                    onChange={(event) => setMetricsToken(event.target.value)}
                  />
                  <button
                    className="button secondary"
                    disabled={busy || !metricsToken}
                    onClick={() =>
                      void run(
                        () => api('/metrics', 'GET', undefined, { token: metricsToken }),
                        'Metrics loaded.',
                      )
                    }
                  >
                    Load metrics
                  </button>
                </div>
              </Card>
              <Card
                title="Payment provider webhook"
                description="Webhook events are normally sent by the payment provider. For local testing, paste the exact raw event and its server-generated X-Signature; do not put production signing secrets in a browser."
              >
                <form className="form-grid" onSubmit={(event) => void runWebhook(event)}>
                  <TextArea
                    label="Raw webhook JSON body"
                    rows={8}
                    value={webhookBody}
                    onChange={(event) => setWebhookBody(event.target.value)}
                  />
                  <Field
                    label="X-Signature (t=timestamp,v1=64-character-hex-signature)"
                    value={webhookSignature}
                    onChange={(event) => setWebhookSignature(event.target.value)}
                    autoComplete="off"
                  />
                  <button className="button secondary" disabled={busy}>
                    Send signed webhook
                  </button>
                </form>
              </Card>
              <Card title="Session activity">
                <p className="muted">
                  Access tokens remain in this browser tab's session storage and are removed when
                  you sign out. No passwords, MFA codes, or health details are saved in the UI.
                </p>
                <button
                  className="button secondary"
                  disabled={busy}
                  onClick={() => void doLogout(true)}
                >
                  Sign out all sessions
                </button>
              </Card>
            </div>
          )}
          {lastResult !== null && (
            <div className="last-response">
              <JsonOutput value={lastResult} />
            </div>
          )}
          <footer className="page-footer">
            <span>Amrutam Care Portal</span>
            <span>Secure access · {user.role.toLowerCase()} account</span>
          </footer>
        </main>
      </div>
    </div>
  );
}

export default App;
