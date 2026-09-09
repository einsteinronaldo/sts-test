/* ══════════════════════════════════════════════════════════════════
 *  ADDRESS AUTOCOMPLETE — Google Places API (New)
 *  Shared by index.html and paineis-solares-lp.html.
 *  Sets window.__addrState (Map<inputId, state>) and
 *  window.buildFormattedAddress(state) used by createPayload().
 * ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  /* Per-input state keyed by element id */
  window.__addrState = new Map();

  var placesLib   = null;
  var mapsReady   = false;
  var mapsLoading = false;
  var mapsQueue   = [];

  /* ── Fetch API key from server ────────────────────────────────── */
  async function fetchApiKey() {
    try {
      var r = await fetch('/api/maps-config');
      if (!r.ok) return null;
      var d = await r.json();
      return d.googleMapsApiKey || null;
    } catch (e) {
      console.warn('[Places] /api/maps-config error:', e);
      return null;
    }
  }

  /* ── Load Google Maps JS API ─────────────────────────────────── */
  function loadMapsScript(apiKey) {
    return new Promise(function (resolve, reject) {
      if (window.google && window.google.maps) { resolve(); return; }
      var cb  = '__gmPlacesInit_' + Date.now();
      window[cb] = function () { delete window[cb]; resolve(); };
      var s   = document.createElement('script');
      s.async = true;
      s.src   = 'https://maps.googleapis.com/maps/api/js' +
                '?key='      + encodeURIComponent(apiKey) +
                '&callback=' + cb +
                '&loading=async&v=weekly';
      s.onerror = function () { delete window[cb]; reject(new Error('Maps load failed')); };
      document.head.appendChild(s);
    });
  }

  async function ensureMaps(apiKey) {
    if (mapsReady)   return true;
    if (mapsLoading) return new Promise(function (res) { mapsQueue.push(res); });
    mapsLoading = true;
    try {
      await loadMapsScript(apiKey);
      var lib = await google.maps.importLibrary('places');
      placesLib = {
        AutocompleteSuggestion:   lib.AutocompleteSuggestion,
        AutocompleteSessionToken: lib.AutocompleteSessionToken,
      };
      mapsReady   = true;
      mapsLoading = false;
      mapsQueue.forEach(function (cb) { cb(true); });
      mapsQueue = [];
      return true;
    } catch (e) {
      console.warn('[Places] Maps load error:', e);
      mapsLoading = false;
      mapsQueue.forEach(function (cb) { cb(false); });
      mapsQueue = [];
      return false;
    }
  }

  /* ── Helpers ─────────────────────────────────────────────────── */
  function esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function getComp(components, types) {
    if (!components) return '';
    var found = components.find(function (c) {
      return c.types && types.some(function (t) { return c.types.indexOf(t) !== -1; });
    });
    return found ? (found.longText || '') : '';
  }

  /* ── Normalize Portuguese postal code: XXXX-XXX or 7 digits ──── */
  function normalizePostal(s) {
    var raw = String(s || '').trim();
    if (/^\d{4}-\d{3}$/.test(raw)) return raw;
    var digits = raw.replace(/\D/g, '');
    if (digits.length === 7) return digits.slice(0, 4) + '-' + digits.slice(4);
    return null;
  }

  /* ── Extract postal code embedded in freeform text ──────────── */
  function extractPostalFromText(text) {
    var s = String(text || '');
    var m = s.match(/\b(\d{4}-\d{3})\b/);
    if (m) return m[1];
    var m2 = s.match(/\b(\d{7})\b/);
    if (m2) return m2[1].slice(0, 4) + '-' + m2[1].slice(4);
    return null;
  }

  /* ── Build formatted address — deduplicates components case-insensitively */
  window.buildFormattedAddress = function (st) {
    if (!st) return '';
    var parts = [];
    var seen  = {};

    function add(val) {
      if (!val || !val.trim()) return;
      var k = val.trim().toLowerCase();
      if (!seen[k]) { seen[k] = true; parts.push(val.trim()); }
    }

    /* Street + number on one line */
    var streetLine = [st.street, st.number]
      .filter(function (s) { return s && s.trim(); })
      .join(' ');
    if (streetLine) { parts.push(streetLine); seen[streetLine.toLowerCase()] = true; }

    /* Postal code + locality on one line */
    if (st.postalCode && st.locality && st.locality.trim()) {
      var localLine = st.postalCode + ' ' + st.locality.trim();
      parts.push(localLine);
      seen[st.locality.trim().toLowerCase()] = true;
    } else if (st.postalCode) {
      parts.push(st.postalCode);
    } else if (st.locality) {
      add(st.locality);
    }

    /* Municipality — skipped if same as locality or district */
    add(st.municipality);

    /* District — skipped if same as locality or municipality */
    add(st.district);

    /* Country always last */
    if (st.country && st.country.trim()) parts.push(st.country.trim());

    return parts.join(', ');
  };

  function emptyState(id) {
    return {
      id: id, source: 'manual', input: '', formatted: '',
      street: '', number: '', postalCode: '', locality: '',
      municipality: '', district: '', country: '',
      lat: null, lng: null, placeId: '',
    };
  }

  function clearGoogleFields(st) {
    st.source = 'manual'; st.formatted = ''; st.street = ''; st.number = '';
    st.postalCode = ''; st.locality = ''; st.municipality = '';
    st.district = ''; st.country = ''; st.lat = null; st.lng = null; st.placeId = '';
  }

  /* ── Dropdown positioning (position:fixed → viewport coords) ─── */
  function reposition(dropdown, input) {
    var r = input.getBoundingClientRect();
    dropdown.style.top   = (r.bottom + 4) + 'px';
    dropdown.style.left  = r.left + 'px';
    dropdown.style.width = r.width + 'px';
  }

  /* ── Pin icon ──────────────────────────────────────────────── */
  var PIN = '<svg class="address-sugg-icon" width="13" height="13" viewBox="0 0 24 24"' +
    ' fill="none" stroke="#E8380A" stroke-width="2.5" stroke-linecap="round"' +
    ' stroke-linejoin="round" aria-hidden="true">' +
    '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/>' +
    '<circle cx="12" cy="10" r="3"/></svg>';

  /* ── Field initialiser ──────────────────────────────────────── */
  function initField(inputId, dropdownId, manualBtnId, hintId,
                     extrasId, extraNumWrapId, extraPostWrapId,
                     extraNumInputId, extraPostInputId,
                     addrErrorId, manualFieldsId,
                     manualNumberInputId, manualPostalInputId, manualDistrictId) {

    var input          = document.getElementById(inputId);
    var dropdown       = document.getElementById(dropdownId);
    var manualBtn      = document.getElementById(manualBtnId);
    var hintEl         = document.getElementById(hintId);
    var extrasEl       = document.getElementById(extrasId);
    var extraNumWrap   = document.getElementById(extraNumWrapId);
    var extraPostWrap  = document.getElementById(extraPostWrapId);
    var extraNumInput  = document.getElementById(extraNumInputId);
    var extraPostInput = document.getElementById(extraPostInputId);
    var addrErrorEl    = document.getElementById(addrErrorId);
    var manualFieldsEl = document.getElementById(manualFieldsId);
    var manualNumberEl = document.getElementById(manualNumberInputId);
    var manualPostalEl = document.getElementById(manualPostalInputId);
    var manualDistEl   = document.getElementById(manualDistrictId);

    if (!input || !dropdown) return;

    /* Move dropdown to <body> — escapes transform/backdrop-filter containment */
    if (dropdown.parentElement !== document.body) {
      document.body.appendChild(dropdown);
    }

    var st       = emptyState(inputId);
    window.__addrState.set(inputId, st);

    var token          = null;
    var debounce       = null;
    var activeIdx      = -1;
    var isManual       = false;
    var googleSelected = false;

    /* ── Inline error ──── */
    function showAddrError(msg) {
      if (addrErrorEl) { addrErrorEl.textContent = msg; addrErrorEl.style.display = 'block'; }
    }
    function hideAddrError() {
      if (addrErrorEl) { addrErrorEl.textContent = ''; addrErrorEl.style.display = 'none'; }
    }

    /* ── Post-Google extra fields (number / postal missing from response) ── */
    function showExtras() {
      if (!extrasEl) return;
      var needNum  = !st.number;
      var needPost = !st.postalCode;
      if (extraNumWrap)  extraNumWrap.style.display  = needNum  ? '' : 'none';
      if (extraPostWrap) extraPostWrap.style.display = needPost ? '' : 'none';
      extrasEl.classList.toggle('is-visible', needNum || needPost);
    }

    function hideExtras() {
      if (!extrasEl) return;
      extrasEl.classList.remove('is-visible');
      if (extraNumWrap)  extraNumWrap.style.display  = 'none';
      if (extraPostWrap) extraPostWrap.style.display = 'none';
      if (extraNumInput)  extraNumInput.value  = '';
      if (extraPostInput) extraPostInput.value = '';
    }

    /* Wire extra field inputs (post-Google selection) */
    if (extraNumInput) {
      extraNumInput.addEventListener('input', function () {
        st.number = extraNumInput.value.trim();
        hideAddrError();
      });
    }
    if (extraPostInput) {
      extraPostInput.addEventListener('input', function () {
        st.postalCode = extraPostInput.value.trim();
        hideAddrError();
      });
      extraPostInput.addEventListener('blur', function () {
        var norm = normalizePostal(extraPostInput.value);
        if (norm) { extraPostInput.value = norm; st.postalCode = norm; }
      });
    }

    /* Wire manual mode inputs */
    if (manualNumberEl) {
      manualNumberEl.addEventListener('input', function () {
        st.number = manualNumberEl.value.trim();
        hideAddrError();
      });
    }
    if (manualPostalEl) {
      manualPostalEl.addEventListener('input', function () {
        st.postalCode = manualPostalEl.value.trim();
        hideAddrError();
      });
      manualPostalEl.addEventListener('blur', function () {
        var norm = normalizePostal(manualPostalEl.value);
        if (norm) { manualPostalEl.value = norm; st.postalCode = norm; }
      });
    }
    if (manualDistEl) {
      manualDistEl.addEventListener('change', function () {
        st.district = manualDistEl.value;
        hideAddrError();
      });
    }

    /* ── Validation — called from submitLead ── */
    st.validate = function () {
      if (!googleSelected && !isManual) {
        return { ok: false, error: 'Selecione uma das moradas sugeridas ou introduza a morada manualmente.' };
      }
      if (googleSelected) {
        if (extraNumWrap && extraNumWrap.style.display !== 'none') {
          if (!st.number || !st.number.trim()) {
            return { ok: false, error: 'Introduza o número da porta.' };
          }
        }
        if (extraPostWrap && extraPostWrap.style.display !== 'none') {
          var np1 = normalizePostal(st.postalCode);
          if (!np1) {
            return { ok: false, error: 'Introduza um código postal válido (ex.: 4450-123).' };
          }
          st.postalCode = np1;
          if (extraPostInput) extraPostInput.value = np1;
        }
        return { ok: true, error: '' };
      }
      /* Manual mode */
      if (!st.street || !st.street.trim()) return { ok: false, error: 'Introduza a rua ou avenida.' };
      if (!st.number || !st.number.trim()) return { ok: false, error: 'Introduza o número da porta.' };
      var np2 = normalizePostal(st.postalCode);
      if (!np2) return { ok: false, error: 'Introduza um código postal válido (ex.: 4450-123).' };
      st.postalCode = np2;
      if (manualPostalEl) manualPostalEl.value = np2;
      if (!st.district) return { ok: false, error: 'Selecione o distrito.' };
      return { ok: true, error: '' };
    };

    /* ── Enter manual mode ── */
    function enterManual() {
      isManual       = true;
      googleSelected = false;
      clearGoogleFields(st);
      closeDropdown();
      hideExtras();
      hideAddrError();
      if (hintEl) hintEl.style.display = 'none';
      /* Repurpose main input as the street/rua field */
      input.setAttribute('placeholder', 'Rua / Avenida / Travessa');
      input.setAttribute('autocomplete', 'street-address');
      input.removeAttribute('role');
      input.setAttribute('aria-autocomplete', 'none');
      input.setAttribute('aria-expanded', 'false');
      st.street = input.value.trim();
      st.source = 'manual';
      if (manualFieldsEl) manualFieldsEl.style.display = 'flex';
    }

    if (manualBtn) {
      manualBtn.addEventListener('click', function () {
        enterManual();
        input.focus();
      });
    }

    /* ── Open / close dropdown ── */
    function openDropdown() {
      dropdown.removeAttribute('hidden');
      reposition(dropdown, input);
      input.setAttribute('aria-expanded', 'true');
    }

    function closeDropdown() {
      dropdown.setAttribute('hidden', '');
      dropdown.innerHTML = '';
      input.setAttribute('aria-expanded', 'false');
      activeIdx = -1;
    }

    /* ── Reposition on scroll / resize ── */
    window.addEventListener('scroll', function (e) {
      if (!dropdown.hasAttribute('hidden') && !dropdown.contains(e.target)) {
        reposition(dropdown, input);
      }
    }, { passive: true, capture: true });
    window.addEventListener('resize', function () {
      if (!dropdown.hasAttribute('hidden')) reposition(dropdown, input);
    }, { passive: true });

    /* ── Close on outside click / touch ── */
    document.addEventListener('mousedown', function (e) {
      if (!dropdown.hasAttribute('hidden') &&
          !dropdown.contains(e.target) && e.target !== input) {
        closeDropdown();
      }
    });
    document.addEventListener('touchstart', function (e) {
      if (!dropdown.hasAttribute('hidden') &&
          !dropdown.contains(e.target) && e.target !== input) {
        closeDropdown();
      }
    }, { passive: true });

    /* ── Render suggestions ── */
    function render(suggestions) {
      dropdown.innerHTML = '';
      activeIdx = -1;

      if (!suggestions.length) {
        var empty = document.createElement('li');
        empty.className = 'address-status';
        empty.textContent = 'Sem resultados. Tente outra morada.';
        dropdown.appendChild(empty);
        openDropdown();
        return;
      }

      suggestions.forEach(function (sugg) {
        var pred     = sugg.placePrediction;
        var mainText = (pred.mainText      && pred.mainText.text)      || '';
        var secText  = (pred.secondaryText && pred.secondaryText.text) || '';

        var li  = document.createElement('li');
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', 'false');

        var btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'address-sugg';
        btn.setAttribute('tabindex', '-1');
        btn.innerHTML =
          PIN +
          '<span class="address-sugg-text">' +
            '<span class="address-sugg-main">' + esc(mainText) + '</span>' +
            (secText ? '<span class="address-sugg-sec">' + esc(secText) + '</span>' : '') +
          '</span>';

        btn.addEventListener('mousedown', function (e) { e.preventDefault(); selectSuggestion(pred); });
        btn.addEventListener('touchend',  function (e) { e.preventDefault(); selectSuggestion(pred); });

        li.appendChild(btn);
        dropdown.appendChild(li);
      });

      openDropdown();
    }

    /* ── Select a suggestion ── */
    async function selectSuggestion(pred) {
      closeDropdown();
      hideAddrError();

      /* Capture pre-typed postal code before overwriting input */
      var preTypedPostal = extractPostalFromText(input.value);

      var fullText = (pred.text && pred.text.text) ||
                     ((pred.mainText      ? pred.mainText.text      : '') +
                      (pred.secondaryText ? ', ' + pred.secondaryText.text : ''));
      input.value = fullText;
      st.input    = fullText;

      try {
        var place = pred.toPlace();
        await place.fetchFields({
          fields: ['formattedAddress', 'addressComponents', 'location', 'id']
        });

        var comps = place.addressComponents || [];
        st.source       = 'google_autocomplete';
        st.formatted    = place.formattedAddress || fullText;
        st.street       = getComp(comps, ['route']);
        st.number       = getComp(comps, ['street_number']);
        st.postalCode   = getComp(comps, ['postal_code']);
        st.locality     = getComp(comps, ['locality', 'postal_town', 'administrative_area_level_3']);
        st.municipality = getComp(comps, ['administrative_area_level_2']);
        st.district     = getComp(comps, ['administrative_area_level_1']);
        st.country      = getComp(comps, ['country']);
        st.lat          = place.location ? place.location.lat() : null;
        st.lng          = place.location ? place.location.lng() : null;
        st.placeId      = place.id || '';

        /* Preserve pre-typed postal code if Google didn't return one */
        if (!st.postalCode && preTypedPostal) {
          st.postalCode = preTypedPostal;
        }

        input.value = st.formatted;
        st.input    = st.formatted;
        googleSelected = true;

        /* Refresh session token — billing session ends after fetchFields */
        token = new placesLib.AutocompleteSessionToken();

        /* Show extra fields for any missing components */
        showExtras();

      } catch (e) {
        console.warn('[Places] fetchFields error:', e);
        st.source = 'manual';
        hideExtras();
      }
    }

    /* ── Keyboard navigation ── */
    function setActive(items) {
      items.forEach(function (btn, i) {
        btn.parentElement.setAttribute('aria-selected', i === activeIdx ? 'true' : 'false');
      });
      if (activeIdx >= 0 && items[activeIdx]) {
        items[activeIdx].scrollIntoView({ block: 'nearest' });
      }
    }

    input.addEventListener('keydown', function (e) {
      if (isManual) return;
      var items = Array.from(dropdown.querySelectorAll('button.address-sugg'));
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        activeIdx = Math.min(activeIdx + 1, items.length - 1);
        setActive(items);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        activeIdx = Math.max(activeIdx - 1, -1);
        setActive(items);
      } else if (e.key === 'Enter') {
        if (activeIdx >= 0 && items[activeIdx]) {
          e.preventDefault();
          items[activeIdx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        } else if (!dropdown.hasAttribute('hidden')) {
          e.preventDefault(); /* dropdown open but nothing selected — block submit */
        }
        /* If dropdown is closed: allow submit; address validation will catch it */
      } else if (e.key === 'Escape') {
        closeDropdown();
      }
    });

    /* ── Input event ── */
    input.addEventListener('input', function () {
      hideAddrError();

      if (isManual) {
        st.street = input.value.trim();
        return;
      }

      if (googleSelected) {
        clearGoogleFields(st);
        googleSelected = false;
        hideExtras();
      }
      st.input = input.value;

      if (!mapsReady) return;

      clearTimeout(debounce);
      var q = input.value.trim();

      if (q.length < 3) { closeDropdown(); return; }

      dropdown.innerHTML = '<li class="address-status">A pesquisar…</li>';
      openDropdown();

      debounce = setTimeout(function () { fetchSuggestions(q); }, 320);
    });

    /* Delay close on blur so mousedown on a suggestion fires first */
    input.addEventListener('blur', function () {
      if (!isManual) setTimeout(closeDropdown, 180);
    });

    /* ── Fetch suggestions ── */
    async function fetchSuggestions(q) {
      if (!placesLib) return;
      if (!token) token = new placesLib.AutocompleteSessionToken();

      try {
        var result = await placesLib.AutocompleteSuggestion.fetchAutocompleteSuggestions({
          input:               q,
          sessionToken:        token,
          includedRegionCodes: ['pt'],
          language:            'pt',
        });
        if (input.value.trim() !== q) return;
        render(result.suggestions || []);
      } catch (e) {
        console.error('[Places] suggestions error:', e.message || e);
        closeDropdown();
      }
    }
  }

  /* ── Bootstrap ───────────────────────────────────────────────── */
  async function init() {
    /* Always initialise fields — manual mode and validation work even without Maps */
    initField('morada',       'morada-dropdown',       'morada-manual-btn',       'morada-hint',
              'morada-extras',       'morada-extra-number',       'morada-extra-postal',
              'morada-number-input', 'morada-postal-input',
              'morada-addr-error',   'morada-manual-fields',
              'morada-manual-number', 'morada-manual-postal', 'morada-manual-district');
    initField('popup-morada', 'popup-morada-dropdown', 'popup-morada-manual-btn', 'popup-morada-hint',
              'popup-morada-extras', 'popup-morada-extra-number', 'popup-morada-extra-postal',
              'popup-morada-number-input', 'popup-morada-postal-input',
              'popup-morada-addr-error', 'popup-morada-manual-fields',
              'popup-morada-manual-number', 'popup-morada-manual-postal', 'popup-morada-manual-district');

    /* Load Maps for autocomplete (manual mode works regardless) */
    var apiKey = await fetchApiKey();
    if (!apiKey) { console.warn('[Places] No API key — autocomplete disabled.'); return; }
    await ensureMaps(apiKey);
  }

  document.readyState === 'loading'
    ? document.addEventListener('DOMContentLoaded', init)
    : init();
})();
