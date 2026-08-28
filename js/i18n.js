/**
 * Bilingual text. Czech is the default; English is one click away and the
 * switch never reloads the page.
 *
 * Any element carrying data-i18n gets its text replaced; data-i18n-title,
 * data-i18n-aria and data-i18n-placeholder fill the matching attributes. The
 * same helper resolves {cs: ..., en: ...} blocks that sit inside the physics
 * config files, so planet names and experiment prose translate too.
 */

export function createI18n(localizationMap, initialLanguage = 'cs') {
  let language = localizationMap.has(initialLanguage) ? initialLanguage : 'cs';
  const listeners = new Set();

  function dictionary() {
    return localizationMap.get(language) ?? {};
  }

  /** Walk a dotted key path through the dictionary. */
  function lookup(key, dict) {
    let node = dict;
    for (const part of key.split('.')) {
      if (node == null || typeof node !== 'object') return undefined;
      node = node[part];
    }
    return typeof node === 'string' ? node : undefined;
  }

  /**
   * Translate a key, substituting {placeholders}. Falls back to the other
   * language, then to the key itself, so a missing string is visible rather
   * than silently blank.
   */
  function t(key, params) {
    let text = lookup(key, dictionary());
    if (text === undefined) {
      for (const [, dict] of localizationMap) {
        text = lookup(key, dict);
        if (text !== undefined) break;
      }
    }
    if (text === undefined) return key;
    if (!params) return text;
    return text.replace(/\{(\w+)\}/g, (match, name) =>
      Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match);
  }

  /** Resolve a {cs, en} block from a config file. */
  function localized(value, fallback = '') {
    if (value == null) return fallback;
    if (typeof value === 'string') return value;
    return value[language] ?? value.cs ?? value.en ?? fallback;
  }

  function setLanguage(next) {
    if (!localizationMap.has(next) || next === language) return;
    language = next;
    if (typeof document !== 'undefined') {
      document.documentElement.lang = language;
      applyTo(document);
    }
    listeners.forEach((fn) => fn(language));
  }

  function getLanguage() { return language; }

  function onChange(fn) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** Refresh every translatable node under `root`. */
  function applyTo(root = document) {
    root.querySelectorAll('[data-i18n]').forEach((el) => {
      el.textContent = t(el.getAttribute('data-i18n'));
    });
    root.querySelectorAll('[data-i18n-title]').forEach((el) => {
      el.title = t(el.getAttribute('data-i18n-title'));
    });
    root.querySelectorAll('[data-i18n-aria]').forEach((el) => {
      el.setAttribute('aria-label', t(el.getAttribute('data-i18n-aria')));
    });
  }

  /** Number formatting that follows the active language. */
  function formatNumber(value, options = {}) {
    const locale = language === 'cs' ? 'cs-CZ' : 'en-GB';
    return new Intl.NumberFormat(locale, options).format(value);
  }

  return { t, localized, setLanguage, getLanguage, onChange, applyTo, formatNumber,
    availableLanguages: Array.from(localizationMap.keys()) };
}
