import { icon } from './icons.js';
import { landingPath, safeNextPath } from './navigation.js';

const REMEMBER_KEY = 'godamo.companyCode';

const form = document.getElementById('login-form');
const errorBox = document.getElementById('login-error');
const company = document.getElementById('company');
const phone = document.getElementById('phone');
const password = document.getElementById('password');
const remember = document.getElementById('remember');
const toggle = document.getElementById('toggle-password');
const submit = document.getElementById('submit');

const SUBMIT_IDLE = `${icon('LogIn')} Log in`;
const SUBMIT_BUSY = `${icon('Loader2', 'spin')} Logging in…`;
submit.innerHTML = SUBMIT_IDLE;
toggle.innerHTML = icon('Eye');

/** Field checks; returns { field: message } for every problem. */
function check(values) {
  const errors = {};
  if (values.companyCode.length < 2) errors.companyCode = 'Enter your company code';
  else if (values.companyCode.length > 20) errors.companyCode = 'Company code is too long';
  else if (!/^[A-Z0-9_-]+$/.test(values.companyCode)) errors.companyCode = 'Use letters and numbers only';
  if (!/^9[78]\d{8}$/.test(values.phone)) {
    errors.phone = 'Enter a 10-digit mobile number starting with 97 or 98';
  }
  if (!values.password) errors.password = 'Enter your password';
  return errors;
}

const fields = { companyCode: company, phone, password };
const errorIds = { companyCode: 'company-err', phone: 'phone-err', password: 'password-err' };

function showFieldErrors(errors) {
  for (const [name, input] of Object.entries(fields)) {
    const el = document.getElementById(errorIds[name]);
    const message = errors[name];
    el.hidden = !message;
    el.textContent = message ?? '';
    input.setAttribute('aria-invalid', message ? 'true' : 'false');
    if (message) input.setAttribute('aria-describedby', errorIds[name]);
    else input.removeAttribute('aria-describedby');
  }
}

function showError(message) {
  errorBox.hidden = !message;
  errorBox.innerHTML = message ? `${icon('AlertCircle')}<span></span>` : '';
  if (message) {
    errorBox.querySelector('span').textContent = message;
    form.setAttribute('aria-describedby', 'login-error');
  } else {
    form.removeAttribute('aria-describedby');
  }
}

// Only the company code is ever remembered (never the phone or password).
let saved = null;
try {
  saved = window.localStorage.getItem(REMEMBER_KEY);
} catch {
  // storage blocked: ignore
}
if (saved) {
  company.value = saved;
  remember.checked = true;
  phone.focus();
} else {
  company.focus();
}

company.addEventListener('input', () => {
  const at = company.selectionStart;
  company.value = company.value.toUpperCase();
  company.setSelectionRange(at, at);
});

toggle.addEventListener('click', () => {
  const show = password.type === 'password';
  password.type = show ? 'text' : 'password';
  toggle.innerHTML = icon(show ? 'EyeOff' : 'Eye');
  toggle.setAttribute('aria-label', show ? 'Hide password' : 'Show password');
  toggle.setAttribute('aria-pressed', String(show));
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const values = {
    companyCode: company.value.trim(),
    phone: phone.value.trim(),
    password: password.value,
  };
  const errors = check(values);
  showFieldErrors(errors);
  const firstBad = Object.keys(fields).find((k) => errors[k]);
  if (firstBad) {
    fields[firstBad].focus();
    return;
  }
  showError(null);

  try {
    if (remember.checked) window.localStorage.setItem(REMEMBER_KEY, values.companyCode);
    else window.localStorage.removeItem(REMEMBER_KEY);
  } catch {
    // storage blocked: ignore
  }

  submit.disabled = true;
  submit.innerHTML = SUBMIT_BUSY;
  const fail = (message) => {
    showError(message);
    password.value = '';
    password.focus();
    submit.disabled = false;
    submit.innerHTML = SUBMIT_IDLE;
  };

  let res;
  try {
    res = await fetch('/web-auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(values),
    });
  } catch {
    showError('Cannot reach Godamo. Check your internet connection and try again.');
    submit.disabled = false;
    submit.innerHTML = SUBMIT_IDLE;
    return;
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.user) {
    if (res.status === 429) return fail('Too many attempts. Please wait a minute and try again.');
    return fail(data.message ?? 'Login failed. Please try again.');
  }
  const next = safeNextPath(new URLSearchParams(window.location.search).get('next'));
  // Full navigation so the app starts with the new session cookies.
  window.location.assign(next ?? landingPath(data.user.role));
});
