'use strict';

/**
 * templates.js — tiny dependency-free renderer for the qris-checkout folder.
 *
 * The browser checkout pages live as plain HTML template files in
 * qris-checkout/ (layout, checkout, plan-card, qris, done, expired) so the
 * payment UI is editable without touching route logic. No view-engine
 * dependency: the pages must render even when node_modules is minimal and
 * load fast on mobile data in ID and MY.
 *
 * Placeholder syntax (safe by default):
 *   {{key}}    → HTML-escaped value (esc()) — use for ANY dynamic text.
 *   {{{key}}}  → raw value — ONLY for pre-built trusted fragments (body,
 *                planCards) or URLs already encoded with encodeURIComponent.
 *
 * Files are read lazily once and cached in memory; edits require a process
 * restart (fine for a deployed payment service).
 */

const fs = require('fs');
const path = require('path');

const TPL_DIR = path.join(__dirname, '..', 'qris-checkout');

/** Minimal HTML escaping — every {{key}} interpolation passes through this. */
function esc(v) {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const cache = new Map();

function load(name) {
  if (!cache.has(name)) {
    cache.set(name, fs.readFileSync(path.join(TPL_DIR, `${name}.html`), 'utf8'));
  }
  return cache.get(name);
}

/** Render a template from qris-checkout/ with the given variables. */
function render(name, vars = {}) {
  return load(name).replace(
    /\{\{\{\s*([A-Za-z0-9_.]+)\s*\}\}\}|\{\{\s*([A-Za-z0-9_.]+)\s*\}\}/g,
    (match, rawKey, key) => {
      const k = rawKey || key;
      if (!(k in vars) || vars[k] == null) return '';
      const value = String(vars[k]);
      return rawKey ? value : esc(value);
    },
  );
}

module.exports = { render, esc };
