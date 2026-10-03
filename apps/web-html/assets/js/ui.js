import { icon } from './icons.js';

/** The Godamo mark: a godown roof with a stack of saffron boxes. Uses currentColor for the roof. */
export function logoMark(className = '') {
  return `<svg viewBox="0 0 120 120" class="logo-mark ${className}" aria-hidden="true" focusable="false">
    <path d="M12 52 L60 18 L108 52" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M24 60 V101 M96 60 V101 M18 101 H102" fill="none" stroke="currentColor" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>
    <g fill="#F28C28">
      <rect x="34" y="78" width="16" height="16" rx="2"/><rect x="52" y="78" width="16" height="16" rx="2"/>
      <rect x="70" y="78" width="16" height="16" rx="2"/><rect x="43" y="60" width="16" height="16" rx="2"/>
      <rect x="61" y="60" width="16" height="16" rx="2"/><rect x="52" y="42" width="16" height="16" rx="2"/>
    </g>
  </svg>`;
}

/** Mark + lowercase "godamo" wordmark. Colour follows the parent (currentColor). */
export function logo({ markClass = '', wordmark = true } = {}) {
  return `<span class="logo">${logoMark(markClass)}${
    wordmark ? '<span class="logo-word">godamo</span>' : '<span class="sr-only">Godamo</span>'
  }</span>`;
}

let toastHost;
/** Small message in the top-right corner that goes away by itself. */
export function toast(message, { type = 'info', ms = 4000 } = {}) {
  if (!toastHost) {
    toastHost = document.createElement('section');
    toastHost.className = 'toasts';
    toastHost.setAttribute('aria-live', 'polite');
    toastHost.setAttribute('aria-label', 'Notifications');
    document.body.append(toastHost);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.setAttribute('role', 'status');
  el.textContent = message;
  toastHost.append(el);
  setTimeout(() => el.remove(), ms);
}

/**
 * Opens a modal dialog built from `html`. Escape, the close button and a
 * click outside close it; focus moves into it and back afterwards.
 * Returns { root, close }.
 */
export function openDialog(html, { label, onClose } = {}) {
  const opener = document.activeElement;
  const overlay = document.createElement('div');
  overlay.className = 'overlay';
  const box = document.createElement('div');
  box.className = 'dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  if (label) box.setAttribute('aria-labelledby', label);
  box.innerHTML = `${html}<button type="button" class="dialog-close" data-close>${icon('X')}<span class="sr-only">Close</span></button>`;

  const close = () => {
    overlay.remove();
    box.remove();
    document.removeEventListener('keydown', onKey);
    onClose?.();
    opener?.focus?.();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
    if (e.key === 'Tab') trapFocus(box, e);
  };
  overlay.addEventListener('click', close);
  box.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) close();
  });
  document.addEventListener('keydown', onKey);
  document.body.append(overlay, box);
  box.querySelector('input, button:not([data-close])')?.focus();
  return { root: box, close };
}

/** Keeps Tab / Shift+Tab inside `container`. */
export function trapFocus(container, e) {
  const items = [...container.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')];
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}
