(() => {
  'use strict';

  // ======= Stałe & stan =======
  const PASSWORD = 'MCPMDR';
  const RX = { lat: 54.546, lon: 18.5501 }; // Gdynia Oksywie
  const ACTIVE_TIMEOUT_SEC = 900;      // 15 min bez nowych danych → "zakończona"
  const VISIBILITY_WINDOW_SEC = 6 * 3600; // 6 h po zakończeniu → ukryj
  const HISTORY_LIMIT = 600;        // ok. 50 min przy 5 s
  const API_BASE = '';
  const state = {
    source: 'radiosondy',   // 'ttgo' | 'radiosondy'
    filterId: '',
    fetchTimer: null,
    map: null,
    layers: {},
    rxMarker: null,
    sondes: new Map(),      // id -> sonde object
    activeId: null,
    charts: {},
    lang: localStorage.getItem('lang') || 'pl',
    // mini-mapa w zakładce wykresów
    miniMap: null,
    miniPolyline: null,
    miniMarker: null,
    // warstwy na wykresie Skew-T (sterowane przyciskami w index.html)
    // basic  -> profil T / Td
    // thermo -> suche adiabaty + linie mieszania
    // conv   -> LCL (i w przyszłości CAPE/CIN)
    // wind   -> profil wiatru przy prawej krawędzi
    // marine -> poziom 0°C (i w przyszłości warstwa morska)
    skewtLayers: {
      basic: true,
      thermo: true,
      conv: true,
      wind: false,
      marine: false
    }
  };

  // ======= i18n =======
  const translations = {
    pl: {
      login_title: 'SYSTEM TELEMETRII RADIOSOND METEOROLOGICZNYCH',
      brand_sub: 'Dostęp chroniony hasłem',
      login_password_label: 'Hasło',
      login_button: 'Zaloguj',
      source_ttgo: 'TTGO',
      source_radiosondy: 'radiosondy.info',
      ttgo_url_label: 'URL TTGO',
      sonde_id_label: 'ID sondy',
      btn_search: 'Szukaj',
      btn_show_all: 'Wszystkie',
      charts_title: 'Dane graficzne',
      status_active: 'Aktywna',
      status_ended: 'Radiosondaż zakończył się'
    },
    en: {
      login_title: 'METEOROLOGICAL RADIOSONDE TELEMETRY SYSTEM',
      brand_sub: 'Password protected access',
      login_password_label: 'Password',
      login_button: 'Log in',
      source_ttgo: 'TTGO',
      source_radiosondy: 'radiosondy.info',
      ttgo_url_label: 'TTGO URL',
      sonde_id_label: 'Sonde ID',
      btn_search: 'Search',
      btn_show_all: 'All',
      charts_title: 'Charts',
      status_active: 'Active',
      status_ended: 'Sounding finished'
    }
  };

  function applyTranslations() {
    const t = translations[state.lang] || translations.pl;
    document.querySelectorAll('[data-i18n]').forEach(el => {
      const k = el.getAttribute('data-i18n');
      if (t[k]) el.textContent = t[k];
    });
  }

  // ======= Helpery =======
  const $ = sel => document.querySelector(sel);
  const $$ = sel => Array.from(document.querySelectorAll(sel));
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const fmt = (v, d = 0) => Number.isFinite(v) ? v.toFixed(d) : '—';


  function getChartsContainer() {
    const chartsView = document.getElementById('view-charts');
    if (!chartsView) return null;

    return (
      chartsView.querySelector('.charts-scroll') ||
      chartsView.querySelector('.charts-grid') ||
      chartsView.querySelector('.charts') ||
      document.getElementById('chart-env')?.closest('.card')?.parentElement ||
      chartsView
    );
  }

  const pickFirstFinite = (...vals) => {
    for (const v of vals) {
      if (Number.isFinite(v)) return v;
    }
    return null;
  };

  function haversine(lat1, lon1, lat2, lon2) {
    const R = 6371000;
    const toRad = x => x * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
      Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(a));
  }

  function bearing(lat1, lon1, lat2, lon2) {
    const toRad = x => x * Math.PI / 180;
    const y = Math.sin(toRad(lon2 - lon1)) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
      Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(toRad(lon2 - lon1));
    let brng = Math.atan2(y, x) * 180 / Math.PI;
    return (brng + 360) % 360;
  }

  function dewPoint(T, RH) {
    if (!Number.isFinite(T) || !Number.isFinite(RH)) return null;
    const a = 17.27, b = 237.7;
    const alpha = (a * T) / (b + T) + Math.log(clamp(RH, 0, 100) / 100);
    return (b * alpha) / (a - alpha);
  }

  function thetaK(Tc, p) {
    if (!Number.isFinite(Tc) || !Number.isFinite(p) || p <= 0) return null;
    const Tk = Tc + 273.15;
    return Tk * Math.pow(1000 / p, 0.2854);
  }

  function lclHeight(Tc, Td) {
    if (!Number.isFinite(Tc) || !Number.isFinite(Td)) return null;
    if (Tc < Td) return null;
    return 125 * (Tc - Td);
  }

  function zeroIsoHeight(history) {
    const arr = [...history].sort((a, b) => a.alt - b.alt);
    for (let i = 1; i < arr.length; i++) {
      const t1 = arr[i - 1].temp;
      const t2 = arr[i].temp;
      if (!Number.isFinite(t1) || !Number.isFinite(t2)) continue;
      if ((t1 <= 0 && t2 >= 0) || (t1 >= 0 && t2 <= 0)) {
        const z1 = arr[i - 1].alt;
        const z2 = arr[i].alt;
        const k = (0 - t1) / (t2 - t1);
        return z1 + k * (z2 - z1);
      }
    }
    return null;
  }

  // parsowanie pola Description z radiosondy.info
  function parseDescription(desc) {
    if (!desc) return {};
    const num = re => {
      const m = desc.match(re);
      return m ? parseFloat(m[1]) : null;
    };
    const out = {};
    out.verticalSpeed = num(/Clb\s*=\s*([-+]?\d+(?:\.\d+)?)\s*m\/s/i);
    out.temp = num(/t\s*=\s*([-+]?\d+(?:\.\d+)?)\s*C/i);
    out.humidity = num(/h\s*=\s*([-+]?\d+(?:\.\d+)?)\s*%/i);
    out.pressure = num(/p\s*=\s*([-+]?\d+(?:\.\d+)?)\s*hPa/i);
    out.battery = num(/(?:batt|bat|vbatt)\s*=\s*([-+]?\d+(?:\.\d+)?)\s*V/i);
    return out;
  }

  function computeStability(history) {
    const pts = history
      .filter(h => Number.isFinite(h.temp) && Number.isFinite(h.alt))
      .sort((a, b) => a.alt - b.alt);
    if (pts.length < 2) return { gamma: null, cls: null };

    const maxSeg = Math.min(pts.length - 1, 10);
    let sum = 0;
    let count = 0;

    for (let i = pts.length - maxSeg; i < pts.length; i++) {
      const a = pts[i - 1];
      const b = pts[i];
      const dz = (b.alt - a.alt) / 1000; // km
      if (dz <= 0.05) continue;
      const dT = b.temp - a.temp;
      const gamma = -dT / dz; // K/km
      if (Number.isFinite(gamma)) {
        sum += gamma;
        count++;
      }
    }
    if (!count) return { gamma: null, cls: null };

    const g = sum / count;
    let cls = null;
    if (!Number.isFinite(g)) cls = null;
    else if (g > 9.8) cls = 'silnie chwiejna';
    else if (g > 7) cls = 'chwiejna';
    else if (g > 4) cls = 'obojętna';
    else if (g > 0) cls = 'stabilna';
    else cls = 'silnie stabilna';

    return { gamma: g, cls };
  }

  // ======= Login =======
  function initLogin() {
    const overlay = $('#login-overlay');
    if (sessionStorage.getItem('mcpmdr_logged_in') === 'true') {
      overlay.classList.remove('show');
      $('#app').classList.remove('hidden');
      return;
    }
    overlay.classList.add('show');
    $('#password').addEventListener('keydown', e => {
      if (e.key === 'Enter') $('#login-btn').click();
    });
    $('#login-btn').addEventListener('click', () => {
      const pass = $('#password').value || '';
      if (pass === PASSWORD) {
        sessionStorage.setItem('mcpmdr_logged_in', 'true');
        overlay.classList.remove('show');
        setTimeout(() => overlay.remove(), 250);
        $('#app').classList.remove('hidden');
      } else {
        $('#login-error').textContent = 'Błędne hasło';
      }
    });
  }

  // ======= Mapa główna =======
  function initMap() {
    const map = L.map('map', { zoomControl: true });
    state.map = map;

    const tileOpts = {
      attribution: '© OSM contributors',
      updateWhenIdle: false,
      updateWhenZooming: false,
      keepBuffer: 3
    };

    const osm = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', tileOpts);
    const topo = L.tileLayer('https://{s}.tile.opentopomap.org/{z}/{x}/{y}.png', {
      ...tileOpts,
      attribution: '© OpenTopoMap'
    });
    const esri = L.tileLayer(
      'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
        ...tileOpts,
        attribution: '© Esri'
      }
    );

    state.layers = { osm, topo, esri };
    osm.addTo(map);
    L.control.layers(
      {
        'OpenStreetMap': osm,
        'OpenTopoMap': topo,
        'Esri World Imagery': esri
      },
      {},
      { position: 'topleft' }
    ).addTo(map);

    map.setView([RX.lat, RX.lon], 10);

    state.rxMarker = L.marker([RX.lat, RX.lon], {
      title: 'RX',
      icon: L.divIcon({
        className: 'rx-icon',
        html: '<div style="width:16px;height:16px;border-radius:50%;background:linear-gradient(180deg,#7bffb0,#3dd4ff);border:2px solid#0b1020"></div>'
      })
    }).addTo(map);
    state.rxMarker.bindTooltip('RX Gdynia Oksywie', {
      permanent: true,
      direction: 'right',
      offset: [10, 0]
    });

    const kick = () => { state.map.invalidateSize(false); };
    requestAnimationFrame(kick);
    setTimeout(kick, 250);
    setTimeout(kick, 1000);
    window.addEventListener('resize', () => setTimeout(kick, 120));
  }

  // ======= UI =======
  function initUI() {
    applyTranslations();

    // Język
    $$('.lang .btn').forEach(b => {
      b.addEventListener('click', () => {
        state.lang = b.dataset.lang;
        localStorage.setItem('lang', state.lang);
        applyTranslations();
      });
    });

    // Zakładki widoków
    $$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        $$('.tab').forEach(t => t.classList.remove('active'));
        tab.classList.add('active');
        const view = tab.dataset.view;
        if (view === 'telemetry') {
          $('#view-telemetry').classList.add('show');
          $('#view-charts').classList.remove('show');
          setTimeout(() => state.map && state.map.invalidateSize(), 120);
        } else {
          $('#view-telemetry').classList.remove('show');
          $('#view-charts').classList.add('show');
          setTimeout(resizeCharts, 100);
        }
      });
    });

    // Źródło danych
    const segTTGO = $('#seg-ttgo');
    const segR = $('#seg-radiosondy');
    function setSourceSegment(activeBtn) {
      [segTTGO, segR].forEach(b => b.classList.toggle('active', b === activeBtn));
      state.source = activeBtn.dataset.src;
      $('#ttgo-url-wrap').classList.toggle('hidden', state.source !== 'ttgo');
      $('#radiosondy-search').classList.toggle('hidden', state.source !== 'radiosondy');
      restartFetching();
    }
    segTTGO.addEventListener('click', () => setSourceSegment(segTTGO));
    segR.addEventListener('click', () => setSourceSegment(segR));

    // Szukaj / wszystkie (radiosondy.info)
    $('#btn-search').addEventListener('click', () => {
      state.filterId = ($('#sonde-id').value || '').trim();
      restartFetching();
    });
    $('#btn-show-all').addEventListener('click', () => {
      state.filterId = '';
      $('#sonde-id').value = '';
      restartFetching();
    });

    // Fullscreen wykresów / mini-mapy – ten sam przycisk włącza/wyłącza
    $$('.fullscreen-toggle').forEach(btn => {
      btn.addEventListener('click', () => {
        const card = btn.closest('.card');
        card.classList.toggle('fullscreen');
        setTimeout(resizeCharts, 60);
      });
    });

    // Zamknięcie fullscreen klawiszem ESC
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        const fs = document.querySelector('.card.fullscreen');
        if (fs) {
          fs.classList.remove('fullscreen');
          resizeCharts();
        }
      }
    });

    // Mini-mapa – oznacz kartę odpowiednimi klasami
    const miniCard = document.getElementById('mini-map')?.closest('.card');
    if (miniCard) {
      miniCard.classList.add('chart-card', 'mini-map-card');
    }

    // Raport PDF
    const btnPdf = $('#btn-pdf');
    if (btnPdf) {
      btnPdf.addEventListener('click', () => {
        generatePdfReport();
      });
    }

    // Przełączniki warstw Skew-T – dopasowane do przycisków w index.html
    $$('.skewt-toggle').forEach(btn => {
      const layer = btn.dataset.skewLayer;
      if (!layer) return;

      if (!(layer in state.skewtLayers)) {
        state.skewtLayers[layer] = btn.classList.contains('active');
      } else {
        btn.classList.toggle('active', !!state.skewtLayers[layer]);
      }

      btn.addEventListener('click', () => {
        const current = !!state.skewtLayers[layer];
        const next = !current;
        state.skewtLayers[layer] = next;
        btn.classList.toggle('active', next);

        const s = state.sondes.get(state.activeId);
        renderSkewT(s);
      });
    });

    // Początkowy widok
    $('#view-telemetry').classList.add('show');
  }

  // ======= Harmonogram pobierania =======
  function restartFetching() {
    if (state.fetchTimer) {
      clearInterval(state.fetchTimer);
      state.fetchTimer = null;
    }
    fetchOnce();
    state.fetchTimer = setInterval(fetchOnce, 5000);
  }

  async function fetchOnce() {
    if (state.source === 'radiosondy') {
      await fetchRadiosondy();
    } else {
      await fetchTTGO();
    }
    render();
  }

  // ======= TTGO (szkielet) =======
  async function fetchTTGO() {
    const url = ($('#ttgo-url').value || '').trim() || 'http://192.168.0.50/sondes.json';
    if (location.protocol === 'https:' && url.startsWith('http:')) {
      $('#status-line').textContent =
        'HTTPS strony + HTTP TTGO = mixed content (uruchom lokalnie po HTTP / użyj tunelu HTTPS).';
      return;
    }
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 30000);
      const res = await fetch(url, { signal: ctrl.signal });
      clearTimeout(t);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const data = await res.json();
      $('#status-line').textContent =
        'TTGO: odebrano dane (' + (Array.isArray(data) ? data.length : 1) + ')';
    } catch (e) {
      $('#status-line').textContent = 'TTGO: błąd pobierania: ' + e.message;
    }
  }

  // ======= radiosondy.info przez /api/radiosondy =======
  async function fetchRadiosondy() {
    const path = state.filterId
      ? `/api/radiosondy?mode=single&id=${encodeURIComponent(state.filterId)}`
      : '/api/radiosondy?mode=all';

    const q = (API_BASE || '') + path;

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log('[radiosondy] fetch try', attempt, 'URL =', q);

        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 30000);
        const res = await fetch(q, { signal: ctrl.signal, cache: 'no-store' });
        clearTimeout(t);

        console.log('[radiosondy] HTTP status =', res.status);

        if (!res.ok) {
          throw new Error('HTTP ' + res.status + ' przy zapytaniu ' + path);
        }

        const csv = await res.text();
        console.log('[radiosondy] sample CSV =', csv.slice(0, 200));

        parseAndMergeCSV(csv);

        const visibleCount = [...state.sondes.values()].filter(s => s.time).length;
        $('#status-line').textContent =
          `radiosondy.info: OK (próba ${attempt}, sondy: ${visibleCount})`;
        return;
      } catch (err) {
        lastErr = err;
        console.error('[radiosondy] błąd w próbie', attempt, err);
        await new Promise(r => setTimeout(r, 1200 * attempt));
      }
    }

    const msg = (lastErr && lastErr.name === 'AbortError')
      ? '(Przekroczony czas odpowiedzi radiosondy.info)'
      : String(lastErr);
    $('#status-line').textContent = `Błąd pobierania danych. ${msg}`;
  }

  // ======= CSV parsing =======
  function parseAndMergeCSV(csv) {
    if (!csv) return;
    const lines = csv.split(/\r?\n/).filter(l => l.trim().length);
    if (lines.length < 2) return;

    const sep = lines[0].includes(';') ? ';' : ',';
    const headers = lines[0].split(sep).map(h => h.trim().toLowerCase());

    console.log('[radiosondy] headers =', headers);

    function colIdx(names) {
      for (const name of names) {
        const i = headers.findIndex(h => h === name.toLowerCase());
        if (i !== -1) return i;
      }
      for (const name of names) {
        const i = headers.findIndex(h => h.includes(name.toLowerCase()));
        if (i !== -1) return i;
      }
      return -1;
    }

    const idx = {
      id: colIdx(['sonde', 'id', 'serial']),
      type: colIdx(['type', 'model']),
      lat: colIdx(['latitude', 'lat']),
      lon: colIdx(['longitude', 'lon', 'lng']),
      alt: colIdx(['altitude', 'alt']),
      temp: colIdx(['temp', 'temperature']),
      pressure: colIdx(['pres', 'pressure', 'p']),
      humidity: colIdx(['humi', 'rh']),
      windSpeed: colIdx(['speed', 'ws']),
      windDir: colIdx(['course', 'wd']),
      rssi: colIdx(['rssi']),
      time: colIdx(['datetime', 'time', 'timestamp']),
      desc: colIdx(['description', 'desc'])
    };

    // Fallback dla typowego układu CSV radiosondy.info:
    // SONDE;Type;QRG;StartPlace;DateTime;Latitude;Longitude;Course;Speed;Altitude;Description;Status;Finder
    if (idx.id === -1 && headers.length > 0) idx.id = 0;
    if (idx.type === -1 && headers.length > 1) idx.type = 1;
    if (idx.time === -1 && headers.length > 4) idx.time = 4;
    if (idx.lat === -1 && headers.length > 5) idx.lat = 5;
    if (idx.lon === -1 && headers.length > 6) idx.lon = 6;
    if (idx.alt === -1 && headers.length > 9) idx.alt = 9;
    if (idx.desc === -1 && headers.length > 10) idx.desc = 10;

    let debugCount = 0;

    const perSonde = new Map();

    for (let li = 1; li < lines.length; li++) {
      const row = lines[li].split(sep);

      const rec = i => {
        if (i < 0) return '';
        const v = row[i];
        return v == null ? '' : String(v).trim();
      };

      if (debugCount < 5) {
        console.log('[radiosondy] row raw', li, row);
      }

      const tRaw = rec(idx.time);
      let tms = NaN;

      if (/^[0-9]+$/.test(tRaw)) {
        const n = parseInt(tRaw, 10);
        tms = (tRaw.length < 11) ? n * 1000 : n;
      } else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(tRaw)) {
        const [datePart, timePart] = tRaw.split(' ');
        const [Y, M, D] = datePart.split('-').map(Number);
        const [h, m, s] = timePart.split(':').map(Number);
        const d = new Date(Y, M - 1, D, h, m, s);
        tms = d.getTime();
      } else if (tRaw) {
        const parsed = Date.parse(tRaw);
        if (Number.isFinite(parsed)) tms = parsed;
      }

      if (!Number.isFinite(tms)) {
        if (debugCount < 5) {
          console.log('[radiosondy] skip row (bad time)', li, 'tRaw=', tRaw);
        }
        continue;
      }

      const lat = parseFloat(rec(idx.lat));
      const lon = parseFloat(rec(idx.lon));
      if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
        if (debugCount < 5) {
          console.log('[radiosondy] skip row (no lat/lon)', li, 'lat=', rec(idx.lat), 'lon=', rec(idx.lon));
        }
        continue;
      }

      const id = rec(idx.id) || 'UNKNOWN';
      if (state.filterId && !id.toLowerCase().includes(state.filterId.toLowerCase())) {
        if (debugCount < 5) {
          console.log('[radiosondy] skip row (filterId mismatch)', li, 'id=', id);
        }
        continue;
      }

      const point = {
        time: new Date(tms),
        lat,
        lon,
        alt: toNum(rec(idx.alt)),
        temp: toNum(rec(idx.temp)),
        pressure: toNum(rec(idx.pressure)),
        humidity: toNum(rec(idx.humidity))
      };

      const desc = rec(idx.desc);

      const extra = {
        type: rec(idx.type),
        windSpeed: toNum(rec(idx.windSpeed)),
        windDir: toNum(rec(idx.windDir)),
        rssi: toNum(rec(idx.rssi)),
        description: desc
      };

      if (!perSonde.has(id)) perSonde.set(id, []);
      perSonde.get(id).push({ point, extra });

      if (debugCount < 5) {
        console.log(
          '[radiosondy] parsed point (raw)',
          'id=', id,
          'time=', point.time.toISOString(),
          'lat=', lat,
          'lon=', lon,
          'alt=', point.alt
        );
      }
      debugCount++;
    }

    for (const [id, arr] of perSonde.entries()) {
      arr.sort((a, b) => a.point.time - b.point.time);
      const s = getOrCreateSonde(id);
      for (const { point, extra } of arr) {
        mergePoint(s, point, extra);
      }
    }

    const now = Date.now();
    for (const [id, s] of state.sondes) {
      if (!s.time) continue;
      const ageSec = (now - s.time) / 1000;
      if (s.status === 'finished' && ageSec > VISIBILITY_WINDOW_SEC) {
        removeSonde(id);
      }
    }
  }

  function toNum(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  
function computeCapeCin(history) {
  // Proste obliczenie CAPE/CIN z profilu radiosondażu (parcel surface-based, pseudo-adiabatyczne).
  // Zwraca { cape, cin } w J/kg. Jeśli brak danych -> { cape: null, cin: null }.
  const levels = history
    .filter(h =>
      Number.isFinite(h.alt) &&
      Number.isFinite(h.temp) &&
      Number.isFinite(h.dew) &&
      Number.isFinite(h.pressure) && h.pressure > 0
    )
    .slice()
    .sort((a, b) => a.alt - b.alt);

  if (levels.length < 12) return { cape: null, cin: null };

  const g = 9.80665;
  const Rd = 287.05;
  const cp = 1004.0;
  const kappa = Rd / cp;
  const Lv = 2.5e6;
  const eps = 0.622;

  function es_hPa(Tc) {
    // Magnus-Tetens (hPa)
    return 6.112 * Math.exp((17.67 * Tc) / (Tc + 243.5));
  }
  function mixingRatio(p_hPa, TdC) {
    const e = es_hPa(TdC);
    const denom = Math.max(0.1, p_hPa - e);
    return eps * e / denom; // kg/kg
  }
  function wsat(p_hPa, Tc) {
    const e = es_hPa(Tc);
    const denom = Math.max(0.1, p_hPa - e);
    return eps * e / denom;
  }
  function virtTempK(Tc, w) {
    const Tk = Tc + 273.15;
    return Tk * (1 + 0.61 * (Number.isFinite(w) ? w : 0));
  }
  function boltonTlclK(Tk, Tdk) {
    // Bolton 1980
    return 1 / (1 / (Tdk - 56) + Math.log(Tk / Tdk) / 800) + 56;
  }
  function dryParcelTempC(thetaK, p_hPa) {
    const Tk = thetaK / Math.pow(1000 / p_hPa, kappa);
    return Tk - 273.15;
  }
  function dTdp_moist(Tk, p_Pa) {
    // Pseudo-adiabatyczne dT/dp w układzie ciśnieniowym (Euler)
    const p_hPa = p_Pa / 100;
    const Tc = Tk - 273.15;
    const ws = wsat(p_hPa, Tc);
    const num = kappa * Tk / p_Pa * (1 + (Lv * ws) / (Rd * Tk));
    const den = 1 + (Lv * Lv * ws * eps) / (cp * Rd * Tk * Tk);
    return num / den; // K/Pa
  }

  // Surface (najniższy poziom)
  const sfc = levels[0];
  const p0 = sfc.pressure; // hPa
  const T0 = sfc.temp;     // C
  const Td0 = sfc.dew;     // C

  const w0 = mixingRatio(p0, Td0);
  const theta0 = (T0 + 273.15) * Math.pow(1000 / p0, kappa);

  const TlclK = boltonTlclK(T0 + 273.15, Td0 + 273.15);
  const plcl = p0 * Math.pow(TlclK / (T0 + 273.15), 1 / kappa);

  let cape = 0;
  let cin = 0;

  // Parcel state for integration along observed levels
  let TpK = T0 + 273.15;
  let pPrev = p0;
  let zPrev = sfc.alt;

  // Environment virtual at prev
  let wEnvPrev = mixingRatio(pPrev, Td0);
  let TvEnvPrev = virtTempK(T0, wEnvPrev);
  let wParPrev = w0;
  let TvParPrev = virtTempK(T0, wParPrev);
  let Bprev = g * (TvParPrev - TvEnvPrev) / TvEnvPrev;

  for (let i = 1; i < levels.length; i++) {
    const lev = levels[i];
    const p = lev.pressure;      // hPa
    const z = lev.alt;
    const TenvC = lev.temp;
    const TdenvC = lev.dew;

    // Integrate parcel temp from pPrev -> p (pressure usually decreases with altitude)
    let p1Pa = pPrev * 100;
    let p2Pa = p * 100;
    // If pressure not monotonic, skip this segment
    if (!(p2Pa < p1Pa)) {
      pPrev = p;
      zPrev = z;
      continue;
    }

    const steps = 8;
    for (let s = 0; s < steps; s++) {
      const frac = (s + 1) / steps;
      const pStepPa = p1Pa + (p2Pa - p1Pa) * frac;
      const pStep = pStepPa / 100;

      if (pStep > plcl) {
        // dry
        const Tc = dryParcelTempC(theta0, pStep);
        TpK = Tc + 273.15;
      } else {
        // moist (Euler)
        const dp = (p2Pa - p1Pa) / steps; // negative
        TpK = TpK + dTdp_moist(TpK, pStepPa) * dp;
      }
    }

    const TpC = TpK - 273.15;

    // Parcel mixing ratio: below LCL constant, above saturated
    const wPar = (p > plcl) ? w0 : wsat(p, TpC);

    // Env mixing ratio from dewpoint
    const wEnv = mixingRatio(p, TdenvC);

    const TvPar = virtTempK(TpC, wPar);
    const TvEnv = virtTempK(TenvC, wEnv);

    const B = g * (TvPar - TvEnv) / TvEnv;

    // integrate buoyancy over dz using trapezoid
    const dz = z - zPrev;
    if (Number.isFinite(dz) && dz > 0 && Number.isFinite(Bprev) && Number.isFinite(B)) {
      const area = 0.5 * (Bprev + B) * dz;
      if (area > 0) cape += area;
      else cin += area; // negative
    }

    // update prev
    pPrev = p;
    zPrev = z;
    Bprev = B;
  }

  // CIN as negative magnitude (common convention is negative J/kg)
  return {
    cape: Number.isFinite(cape) ? cape : null,
    cin: Number.isFinite(cin) ? cin : null
  };
}

function getOrCreateSonde(id) {
    if (!state.sondes.has(id)) {
      state.sondes.set(id, {
        id,
        type: null,
        lat: null,
        lon: null,
        alt: null,
        temp: null,
        pressure: null,
        humidity: null,
        windSpeed: null,
        windDir: null,
        rssi: null,
        battery: null,
        time: null,
        dewPoint: null,
        horizontalSpeed: null,
        horizontalCourse: null,
        verticalSpeed: null,
        speed3d: null,
        distanceToRx: null,
        theta: null,
        lclHeight: null,
        zeroIsoHeight: null,
        ageSec: null,
        status: 'active',
        stabilityIndex: null,
        stabilityClass: null,
        cape: null,
        cin: null,
        history: [],
        marker: null,
        polyline: null,
        launchMarker: null,
        burstMarker: null
      });
    }
    return state.sondes.get(id);
  }

  function mergePoint(s, p, extra) {
    s.type = extra.type || s.type;

    const meta = parseDescription(extra.description);

    const merged = {
      time: p.time,
      lat: p.lat,
      lon: p.lon,
      alt: p.alt,
      temp: pickFirstFinite(p.temp, meta.temp),
      pressure: pickFirstFinite(p.pressure, meta.pressure),
      humidity: pickFirstFinite(p.humidity, meta.humidity)
    };
    const rssiVal = pickFirstFinite(extra.rssi);
    const batteryVal = pickFirstFinite(meta.battery);

    if (!s.time || p.time > s.time) {
      s.history.push({
        time: merged.time,
        lat: merged.lat,
        lon: merged.lon,
        alt: merged.alt,
        temp: merged.temp,
        pressure: merged.pressure,
        humidity: merged.humidity,
        rssi: rssiVal,
        battery: batteryVal
      });
      if (s.history.length > HISTORY_LIMIT) {
        s.history.splice(0, s.history.length - HISTORY_LIMIT);
      }
    }

    Object.assign(s, merged, {
      windSpeed: extra.windSpeed,
      windDir: extra.windDir,
      rssi: rssiVal,
      battery: batteryVal
    });

    s.time = merged.time;
    s.ageSec = (Date.now() - s.time) / 1000;
    s.status = (s.ageSec > ACTIVE_TIMEOUT_SEC) ? 'finished' : 'active';

    s.dewPoint = dewPoint(s.temp, s.humidity);
    s.theta = thetaK(s.temp, s.pressure);
    s.lclHeight = lclHeight(s.temp, s.dewPoint);
    s.zeroIsoHeight = zeroIsoHeight(s.history);
    s.distanceToRx =
      (Number.isFinite(s.lat) && Number.isFinite(s.lon))
        ? haversine(RX.lat, RX.lon, s.lat, s.lon)
        : null;

    const n = s.history.length;
    if (n >= 2) {
      const a = s.history[n - 2];
      const b = s.history[n - 1];
      const dt = clamp((b.time - a.time) / 1000, 0.5, 600);
      const dH = haversine(a.lat, a.lon, b.lat, b.lon);
      const vz = (Number.isFinite(a.alt) && Number.isFinite(b.alt))
        ? (b.alt - a.alt) / dt
        : null;

      s.horizontalSpeed = dH / dt;
      s.verticalSpeed = pickFirstFinite(meta.verticalSpeed, vz);
      s.speed3d =
        (Number.isFinite(s.horizontalSpeed) && Number.isFinite(s.verticalSpeed))
          ? Math.sqrt(dH * dH + (b.alt - a.alt) ** 2) / dt
          : null;
      s.horizontalCourse = bearing(a.lat, a.lon, b.lat, b.lon);
    } else {
      s.verticalSpeed = pickFirstFinite(meta.verticalSpeed, s.verticalSpeed);
    }

    const stab = computeStability(s.history);
    s.stabilityIndex = stab.gamma;
    s.stabilityClass = stab.cls;

    
    const cc = computeCapeCin(s.history);
    s.cape = cc.cape;
    s.cin = cc.cin;
ensureMapObjects(s);
    updateLaunchBurstMarkers(s);
  }

  function ensureMapObjects(s) {
    if (!state.map) return;

    if (!s.marker) {
      s.marker = L.circleMarker([s.lat, s.lon], {
        radius: 6,
        color: '#3dd4ff',
        fillColor: '#3dd4ff',
        fillOpacity: 0.9
      });
      s.marker.on('click', () => setActiveSonde(s.id, true));
      s.marker.addTo(state.map);
    } else {
      s.marker.setLatLng([s.lat, s.lon]);
    }

    if (!s.polyline) {
      s.polyline = L.polyline(
        s.history.map(h => [h.lat, h.lon]),
        { color: 'rgba(61,212,255,0.45)', weight: 2 }
      );
      s.polyline.addTo(state.map);
    } else {
      s.polyline.setLatLngs(s.history.map(h => [h.lat, h.lon]));
    }

    const label = `${s.type ? (s.type + ' ') : ''}${s.id}`;
    s.marker.bindTooltip(label, { direction: 'top', offset: [0, -8] });
  }

  function updateLaunchBurstMarkers(s) {
    if (!state.map || !s.history.length) return;

    const sorted = s.history.slice().sort((a, b) => a.time - b.time);
    const launch = sorted[0];

    let apex = null;
    for (const h of sorted) {
      if (!Number.isFinite(h.alt)) continue;
      if (!apex || h.alt > apex.alt) apex = h;
    }

    const last = sorted[sorted.length - 1];

    if (launch && Number.isFinite(launch.lat) && Number.isFinite(launch.lon)) {
      const latlng = [launch.lat, launch.lon];
      if (!s.launchMarker) {
        s.launchMarker = L.circleMarker(latlng, {
          radius: 5,
          color: '#7bffb0',
          fillColor: '#7bffb0',
          fillOpacity: 0.95
        }).addTo(state.map);
        s.launchMarker.bindTooltip('Start (launch)', { direction: 'top', offset: [0, -6] });
      } else {
        s.launchMarker.setLatLng(latlng);
      }
    }

    const HYST = 10;
    const canShowBurst =
      apex &&
      last &&
      Number.isFinite(apex.alt) &&
      Number.isFinite(last.alt) &&
      last.alt < apex.alt - HYST;

    if (canShowBurst) {
      const latlng2 = [apex.lat, apex.lon];
      if (!s.burstMarker) {
        s.burstMarker = L.circleMarker(latlng2, {
          radius: 5,
          color: '#ff5470',
          fillColor: '#ff5470',
          fillOpacity: 0.95
        }).addTo(state.map);
        s.burstMarker.bindTooltip('Burst (pęknięcie balonu)', { direction: 'top', offset: [0, -6] });
      } else {
        s.burstMarker.setLatLng(latlng2);
      }
    } else {
      if (s.burstMarker) {
        s.burstMarker.remove();
        s.burstMarker = null;
      }
    }
  }

  function removeSonde(id) {
    const s = state.sondes.get(id);
    if (!s) return;
    if (s.marker) s.marker.remove();
    if (s.polyline) s.polyline.remove();
    if (s.launchMarker) s.launchMarker.remove();
    if (s.burstMarker) s.burstMarker.remove();
    state.sondes.delete(id);
    if (state.activeId === id) state.activeId = null;
  }

  // ======= Renderowanie UI =======
  function render() {
    renderTabs();
    renderPanel();
    renderCharts();
  }

  function renderTabs() {
    const wrap = $('#sonde-tabs');
    if (!wrap) return;
    wrap.innerHTML = '';
    const list = [...state.sondes.values()];

    list.sort((a, b) => (b.time || 0) - (a.time || 0));

    for (const s of list) {
      const btn = document.createElement('button');
      btn.className = 'sonde-tab' + (s.id === state.activeId ? ' active' : '');
      btn.textContent = `${s.type ? (s.type + ' ') : ''}${s.id}`;
      btn.addEventListener('click', () => setActiveSonde(s.id, true));
      wrap.appendChild(btn);
    }

    if (!state.activeId && list.length) {
      setActiveSonde(list[0].id, false);
    }
  }

  function setActiveSonde(id, center) {
    state.activeId = id;
    renderTabs();
    renderPanel();
    if (center) {
      const s = state.sondes.get(id);
      if (s && Number.isFinite(s.lat) && Number.isFinite(s.lon)) {
        state.map.setView([s.lat, s.lon], Math.max(10, state.map.getZoom()));
      }
    }
  }

  function renderPanel() {
    const s = state.sondes.get(state.activeId);
    const panel = $('#sonde-panel');
    if (!panel) return;

    if (!s) {
      panel.innerHTML = '';
      return;
    }

    const t = translations[state.lang] || translations.pl;
    const timeStr = s.time ? new Date(s.time).toLocaleString() : '—';
    const statusStr = s.status === 'active'
      ? t.status_active
      : t.status_ended;

    const items = [
      { label: 'Wysokość [m]', value: fmt(s.alt, 0) },
      { label: 'Temperatura [°C]', value: fmt(s.temp, 1) },
      { label: 'Punkt rosy [°C]', value: fmt(s.dewPoint, 1) },
      { label: 'Ciśnienie [hPa]', value: fmt(s.pressure, 1) },
      { label: 'Wilgotność [%]', value: fmt(s.humidity, 0) },
      { label: 'Prędkość pionowa [m/s]', value: fmt(s.verticalSpeed, 1) },
      { label: 'Prędkość pozioma [m/s]', value: fmt(s.horizontalSpeed, 1) },
      { label: 'Kierunek lotu [°]', value: fmt(s.horizontalCourse, 0) },
      { label: 'Odległość od RX [m]', value: fmt(s.distanceToRx, 0) },
      { label: '0 °C izoterma [m]', value: fmt(s.zeroIsoHeight, 0) },
      { label: 'LCL [m]', value: fmt(s.lclHeight, 0) },
      { label: 'Θ potencjalna [K]', value: fmt(s.theta, 1) },
      { label: 'Stabilność Γ [K/km]', value: fmt(s.stabilityIndex, 1) }
    ];

    const stabilityTag = s.stabilityClass ? ` — ${s.stabilityClass}` : '';

    panel.innerHTML = `
      <div class="card" style="grid-column:1/-1">
        <div class="label">${s.type || ''}</div>
        <div class="value" style="font-weight:700;font-size:20px">${s.id}</div>
        <div class="sub">${timeStr} — ${statusStr}${stabilityTag}</div>
      </div>
      ${items.map(i => `
        <div class="card">
          <div class="label">${i.label}</div>
          <div class="value">${i.value}</div>
        </div>
      `).join('')}
    `;

    $$('.sonde-tab').forEach(el => {
      el.classList.toggle('active', el.textContent.endsWith(s.id));
    });
  }

  // ======= Wykresy =======
  function ensureChart(id, builder) {
    if (state.charts[id]) return state.charts[id];
    const ctx = document.getElementById(id);
    if (!ctx) return null;
    const cfg = builder(ctx);
    const chart = new Chart(ctx, cfg);
    state.charts[id] = chart;
    return chart;
  }

  function timeScaleOptions(label) {
    return {
      type: 'linear',
      title: { display: !!label, text: label, color: '#e6ebff' },
      grid: { color: 'rgba(134,144,176,.35)' },
      ticks: {
        color: '#e6ebff',
        callback: v => new Date(v).toLocaleTimeString()
      }
    };
  }

  function commonY(label) {
    return {
      title: { display: !!label, text: label, color: '#e6ebff' },
      grid: { color: 'rgba(134,144,176,.35)' },
      ticks: { color: '#e6ebff' }
    };
  }

  function tooltipWithAltitude() {
    return {
      callbacks: {
        label(ctx) {
          const label = ctx.dataset.label || '';
          const val = ctx.formattedValue;
          const raw = ctx.raw;
          const alt = raw && typeof raw === 'object' && Number.isFinite(raw.alt) ? raw.alt : null;
          if (alt != null) {
            return `${label}: ${val} (wys: ${alt.toFixed(0)} m)`;
          }
          return `${label}: ${val}`;
        }
      }
    };
  }

  // ========= Plugin: etykiety wysokości nad osią czasu =========
  const altitudeTopAxisPlugin = {
    id: 'altitudeTopAxis',
    afterDraw(chart) {
      const opts = chart.options?.plugins?.altitudeTopAxis;
      if (!opts || !opts.enabled) return;

      const datasetIndex = Number.isInteger(opts.datasetIndex) ? opts.datasetIndex : 0;
      const yOffset = Number.isFinite(opts.yOffsetPx) ? opts.yOffsetPx : 10; // trochę większy odstęp w dół

      const ds = chart.data?.datasets?.[datasetIndex];
      const scaleX = chart.scales?.x;
      const area = chart.chartArea;

      if (!ds || !Array.isArray(ds.data) || !ds.data.length) return;
      if (!scaleX || !scaleX.ticks || !scaleX.ticks.length) return;
      if (!area) return;

      const ctx = chart.ctx;
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = '#e6ebff';

      // rysuj NAD każdą godziną, ale wewnątrz pola wykresu
      const topY = area.top + yOffset;

      // marginesy poziome, żeby nie wchodzić na lewą/prawą oś
      const paddingLeft = area.left + 16;
      const paddingRight = area.right - 6;

      for (const tick of scaleX.ticks) {
        const xVal = tick.value;

        let bestAlt = null;
        let bestDx = Infinity;

        for (const p of ds.data) {
          if (!p || typeof p.x === 'undefined' || !Number.isFinite(p.alt)) continue;
          const dx = Math.abs(p.x - xVal);
          if (dx < bestDx) {
            bestDx = dx;
            bestAlt = p.alt;
          }
        }

        if (!Number.isFinite(bestAlt)) continue;

        let xPix = scaleX.getPixelForValue(xVal);

        // nie pozwól, żeby środek napisu był zbyt blisko lewej/prawej krawędzi
        if (xPix < paddingLeft) xPix = paddingLeft;
        if (xPix > paddingRight) xPix = paddingRight;

        ctx.fillText(bestAlt.toFixed(0) + ' m', xPix, topY);
      }

      ctx.restore();
    }
  };

  // ======= Skew-T Log-P diagram (z auto-fit T/p) =======
  function renderSkewT(s) {
    const canvas = document.getElementById('chart-skewt');
    if (!canvas) return;

    const layers = state.skewtLayers || {};
    const showBasic = layers.basic !== false;
    const showThermo = !!layers.thermo;
    const showConv = !!layers.conv;
    const showWind = !!layers.wind;
    const showMarine = !!layers.marine;

    const parent = canvas.parentElement || canvas;
    const width = parent.clientWidth || 600;
    const height = parent.clientHeight || 320;
    const dpr = window.devicePixelRatio || 1;

    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const left = 52;
    const right = 32;
    const top = 18;
    const bottom = 30;
    const plotW = width - left - right;
    const plotH = height - top - bottom;

    ctx.fillStyle = '#050814';
    ctx.fillRect(0, 0, width, height);

    if (!s || !s.history.length) {
      ctx.strokeStyle = 'rgba(134,144,176,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(left, top, plotW, plotH);

      ctx.fillStyle = '#8a94b0';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Brak danych radiosondy do wykreślenia profilu', left + 12, top + 24);
      return;
    }

    const hist = s.history
      .filter(h =>
        Number.isFinite(h.pressure) &&
        Number.isFinite(h.temp)
      )
      .slice()
      .sort((a, b) => b.pressure - a.pressure); // od dołu do góry

    if (!hist.length) {
      ctx.strokeStyle = 'rgba(134,144,176,0.7)';
      ctx.lineWidth = 1;
      ctx.strokeRect(left, top, plotW, plotH);

      ctx.fillStyle = '#8a94b0';
      ctx.font = '12px system-ui, sans-serif';
      ctx.fillText('Brak punktów z pełnymi danymi T/p', left + 12, top + 24);
      return;
    }

    // --- AUTO-FIT zakresu ciśnień i temperatury z marginesem ---
    let pMin = 100;
    let pMax = 1000;
    let tMin = -60;
    let tMax = 40;

    {
      let dataPMin = Infinity;
      let dataPMax = -Infinity;
      let dataTMin = Infinity;
      let dataTMax = -Infinity;

      for (const h of hist) {
        if (Number.isFinite(h.pressure)) {
          dataPMin = Math.min(dataPMin, h.pressure);
          dataPMax = Math.max(dataPMax, h.pressure);
        }
        if (Number.isFinite(h.temp)) {
          dataTMin = Math.min(dataTMin, h.temp);
          dataTMax = Math.max(dataTMax, h.temp);
        }
        const Td = dewPoint(h.temp, h.humidity);
        if (Number.isFinite(Td)) {
          dataTMin = Math.min(dataTMin, Td);
          dataTMax = Math.max(dataTMax, Td);
        }
      }

      if (dataPMin < Infinity && dataPMax > -Infinity) {
        pMin = Math.max(50, dataPMin - 50);
        pMax = Math.min(1050, dataPMax + 50);
        if (pMin >= pMax) {
          pMin = 100;
          pMax = 1000;
        }
      }

      if (dataTMin < Infinity && dataTMax > -Infinity) {
        const marginT = 10;
        tMin = dataTMin - marginT;
        tMax = dataTMax + marginT;

        tMin = Math.max(-90, tMin);
        tMax = Math.min(50, tMax);

        if (tMax - tMin < 40) {
          const mid = (tMax + tMin) / 2;
          tMin = mid - 20;
          tMax = mid + 20;
        }
      }
    }

    const logPmin = Math.log(pMin);
    const logPmax = Math.log(pMax);
    const yForP = p => {
      const lp = Math.log(clamp(p, pMin, pMax));
      const frac = (lp - logPmin) / (logPmax - logPmin);
      return top + frac * plotH;
    };

    const refLogP = Math.log(1000);
    const skew = 35;
    const xForT = (T, p) => {
      const lp = Math.log(clamp(p, pMin, pMax));
      const skewedT = T + (lp - refLogP) * skew;
      const frac = (skewedT - tMin) / (tMax - tMin);
      return left + frac * plotW;
    };

    const pStepMajor = 50;
    const pGridMin = Math.ceil(pMin / pStepMajor) * pStepMajor;
    const pGridMax = Math.floor(pMax / pStepMajor) * pStepMajor;

    const tStep = 10;
    const tGridMin = Math.ceil(tMin / tStep) * tStep;
    const tGridMax = Math.floor(tMax / tStep) * tStep;

    // ====== CLIP: wszystko wewnątrz ramki ======
    ctx.save();
    ctx.beginPath();
    ctx.rect(left, top, plotW, plotH);
    ctx.clip();

    // --- isobary ---
    ctx.font = '10px system-ui, sans-serif';
    ctx.strokeStyle = 'rgba(134,144,176,0.35)';
    ctx.lineWidth = 1;
    if (pGridMax >= pGridMin) {
      for (let p = pGridMax; p >= pGridMin; p -= pStepMajor) {
        const y = yForP(p);
        ctx.beginPath();
        ctx.moveTo(left, y);
        ctx.lineTo(left + plotW, y);
        ctx.stroke();
      }
    }

    // --- izotermy ---
    ctx.setLineDash([4, 4]);
    for (let T = tGridMin; T <= tGridMax; T += tStep) {
      let firstIso = true;
      ctx.beginPath();
      for (let p = pMax; p >= pMin; p -= 10) {
        const x = xForT(T, p);
        const y = yForP(p);
        if (firstIso) {
          ctx.moveTo(x, y);
          firstIso = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // --- profil temperatury ---
    if (showBasic) {
      ctx.strokeStyle = '#ffb86c';
      ctx.lineWidth = 2;
      ctx.beginPath();
      let firstT = true;
      for (const h of hist) {
        if (!Number.isFinite(h.pressure) || !Number.isFinite(h.temp)) continue;
        const x = xForT(h.temp, h.pressure);
        const y = yForP(h.pressure);
        if (firstT) {
          ctx.moveTo(x, y);
          firstT = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // --- profil punktu rosy ---
    if (showBasic) {
      ctx.strokeStyle = '#7bffb0';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      let firstD = true;
      for (const h of hist) {
        const Td = dewPoint(h.temp, h.humidity);
        if (!Number.isFinite(Td) || !Number.isFinite(h.pressure)) continue;
        const x = xForT(Td, h.pressure);
        const y = yForP(h.pressure);
        if (firstD) {
          ctx.moveTo(x, y);
          firstD = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
    }

    // --- suche adiabaty ---
    if (showThermo) {
      ctx.save();
      ctx.strokeStyle = 'rgba(255,184,108,0.45)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([6, 4]);

      for (let theta = 280; theta <= 360; theta += 10) {
        let first = true;
        ctx.beginPath();
        for (let p = pMax; p >= pMin; p -= 10) {
          const Tk = theta / Math.pow(1000 / p, 0.2854);
          const T = Tk - 273.15;
          const x = xForT(T, p);
          const y = yForP(p);
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      ctx.restore();
    }

    // --- linie mieszania (przybliżone) ---
    if (showThermo) {
      ctx.save();
      ctx.strokeStyle = 'rgba(123,255,176,0.35)';
      ctx.lineWidth = 0.8;
      ctx.setLineDash([2, 4]);

      const wValues = [2, 4, 8, 12, 16]; // g/kg
      const mixTop = Math.max(pMin, 400);
      const mixBottom = pMax;
      for (const w of wValues) {
        let first = true;
        ctx.beginPath();
        for (let p = mixBottom; p >= mixTop; p -= 10) {
          const Td = 5 + 8 * Math.log(w) - 0.005 * (p - 1000);
          const x = xForT(Td, p);
          const y = yForP(p);
          if (first) {
            ctx.moveTo(x, y);
            first = false;
          } else {
            ctx.lineTo(x, y);
          }
        }
        ctx.stroke();
      }

      ctx.restore();
    }

    // --- LCL ---
    if (showConv && Number.isFinite(s.lclHeight)) {
      const targetZ = s.lclHeight;
      let best = null;
      let bestDz = Infinity;
      for (const h of hist) {
        if (!Number.isFinite(h.alt)) continue;
        const dz = Math.abs(h.alt - targetZ);
        if (dz < bestDz) {
          bestDz = dz;
          best = h;
        }
      }

      if (best && Number.isFinite(best.pressure)) {
        const pLcl = best.pressure;
        const surface = hist[0];
        let tLcl = best.temp;
        if (surface && Number.isFinite(surface.temp) && Number.isFinite(surface.pressure)) {
          const theta = thetaK(surface.temp, surface.pressure);
          const TkLcl = theta / Math.pow(1000 / pLcl, 0.2854);
          tLcl = TkLcl - 273.15;
        }
        const xLcl = xForT(tLcl, pLcl);
        const yLcl = yForP(pLcl);

        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.strokeStyle = '#ffffff';
        ctx.lineWidth = 1;

        ctx.beginPath();
        ctx.arc(xLcl, yLcl, 4, 0, Math.PI * 2);
        ctx.stroke();

        ctx.font = '10px system-ui, sans-serif';
        ctx.textBaseline = 'bottom';
        ctx.fillText('LCL', xLcl + 6, yLcl - 2);
        ctx.restore();
      }
    }

    // --- 0°C izoterma ---
    if (showMarine || showConv) {
      ctx.save();
      ctx.strokeStyle = '#3dd4ff';
      ctx.lineWidth = 2;
      ctx.setLineDash([2, 2]);

      ctx.beginPath();
      let first = true;
      for (let p = pMax; p >= pMin; p -= 10) {
        const x = xForT(0, p);
        const y = yForP(p);
        if (first) {
          ctx.moveTo(x, y);
          first = false;
        } else {
          ctx.lineTo(x, y);
        }
      }
      ctx.stroke();
      ctx.restore();
    }

    ctx.restore(); // koniec clip

    // ====== ELEMENTY POZA RAMKĄ ======

    ctx.strokeStyle = 'rgba(134,144,176,0.7)';
    ctx.lineWidth = 1;
    ctx.strokeRect(left, top, plotW, plotH);

    ctx.font = '10px system-ui, sans-serif';
    ctx.fillStyle = '#8a94b0';
    if (pGridMax >= pGridMin) {
      for (let p = pGridMax; p >= pGridMin; p -= pStepMajor) {
        const y = yForP(p);
        ctx.fillText(p.toString(), 6, y + 3);
      }
    }

    for (let T = tGridMin; T <= tGridMax; T += tStep) {
      const xLabel = xForT(T, pMax);
      if (xLabel > left && xLabel < left + plotW) {
        ctx.fillText(T.toString(), xLabel - 8, height - 6);
      }
    }

    if (showWind) {
      ctx.save();
      ctx.font = '10px system-ui, sans-serif';
      ctx.fillStyle = '#e6ebff';
      ctx.strokeStyle = '#e6ebff';
      ctx.lineWidth = 1;

      const xWind = left + plotW + 4;
      const maxLen = 24;

      function drawArrow(y, speed, dirDeg) {
        const spd = clamp(speed || 0, 0, 60);
        const len = (spd / 60) * maxLen;

        const rad = (270 - dirDeg) * Math.PI / 180;
        const x1 = xWind;
        const y1 = y;
        const x2 = x1 + len * Math.cos(rad);
        const y2 = y1 + len * Math.sin(rad);

        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();

        const ang = Math.atan2(y2 - y1, x2 - x1);
        const a1 = ang + Math.PI * 0.75;
        const a2 = ang - Math.PI * 0.75;
        const r = 4;
        ctx.beginPath();
        ctx.moveTo(x2, y2);
        ctx.lineTo(x2 + r * Math.cos(a1), y2 + r * Math.sin(a1));
        ctx.lineTo(x2 + r * Math.cos(a2), y2 + r * Math.sin(a2));
        ctx.closePath();
        ctx.fill();
      }

      const levels = [1000, 900, 800, 700, 600, 500, 400, 300, 200];
      for (const p of levels) {
        let best = null;
        let bestDp = Infinity;
        for (const h of hist) {
          const dp = Math.abs(h.pressure - p);
          if (dp < bestDp) {
            bestDp = dp;
            best = h;
          }
        }
        if (!best) continue;

        let speed = best.windSpeed;
        let dir = best.windDir;

        if (!Number.isFinite(speed) || !Number.isFinite(dir)) {
          const idx = hist.indexOf(best);
          if (idx > 0) {
            const a = hist[idx - 1];
            const b = best;
            const dt = (b.time - a.time) / 1000;
            if (dt > 0 &&
              Number.isFinite(a.lat) && Number.isFinite(a.lon) &&
              Number.isFinite(b.lat) && Number.isFinite(b.lon)) {
              const dH = haversine(a.lat, a.lon, b.lat, b.lon);
              speed = dH / dt;
              dir = bearing(a.lat, a.lon, b.lat, b.lon);
            }
          }
        }

        if (!Number.isFinite(speed) || !Number.isFinite(dir)) continue;

        const y = yForP(best.pressure);
        drawArrow(y, speed, dir);
      }

      ctx.restore();
    }

    ctx.fillStyle = '#e6ebff';
    ctx.font = '11px system-ui, sans-serif';
    const legendY = top + 12;
    let lx = left + 8;

    const drawLegend = (color, label) => {
      ctx.fillStyle = color;
      ctx.fillRect(lx, legendY - 6, 14, 2);
      ctx.fillStyle = '#e6ebff';
      ctx.fillText(label, lx + 20, legendY);
      lx += ctx.measureText(label).width + 52;
    };

    if (showBasic) {
      drawLegend('#ffb86c', 'T');
      drawLegend('#7bffb0', 'Td');
    }
    if (showThermo) {
      drawLegend('rgba(255,184,108,0.7)', 'Suche adiabaty');
      drawLegend('rgba(123,255,176,0.7)', 'Linie mieszania');
    }
    if (showConv) {
      drawLegend('#ffffff', 'LCL');
    }
    if (showMarine || showConv) {
      drawLegend('#3dd4ff', '0°C');
    }
    if (showWind) {
      drawLegend('#e6ebff', 'Wiatr');
    }

    ctx.fillStyle = '#8a94b0';
    ctx.font = '10px system-ui, sans-serif';
    ctx.fillText('Skew-T log-p (T / Td vs p)', left + 8, top + plotH + 18);
  }

  function resizeCharts() {
    Object.values(state.charts).forEach(c => c && c.resize());
    if (state.miniMap) {
      setTimeout(() => state.miniMap.invalidateSize(), 80);
    }
    const s = state.sondes.get(state.activeId);
    renderSkewT(s);
  }

  function renderMiniMap(s, hist) {
    const mapEl = document.getElementById('mini-map');
    if (!mapEl) return;

    if (!state.miniMap) {
      state.miniMap = L.map('mini-map', {
        zoomControl: false,
        attributionControl: false
      });
      L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OSM contributors'
      }).addTo(state.miniMap);
    }

    if (!s || !hist.length) {
      state.miniMap.setView([RX.lat, RX.lon], 4);
      if (state.miniPolyline) state.miniPolyline.setLatLngs([]);
      if (state.miniMarker) {
        state.miniMarker.remove();
        state.miniMarker = null;
      }
      return;
    }

    const path = hist
      .filter(h => Number.isFinite(h.lat) && Number.isFinite(h.lon))
      .map(h => [h.lat, h.lon]);
    if (!path.length) return;

    if (!state.miniPolyline) {
      state.miniPolyline = L.polyline(path, {
        color: 'rgba(61,212,255,0.8)',
        weight: 2
      }).addTo(state.miniMap);
    } else {
      state.miniPolyline.setLatLngs(path);
    }

    const last = hist[hist.length - 1];
    if (!state.miniMarker) {
      state.miniMarker = L.circleMarker([last.lat, last.lon], {
        radius: 4,
        color: '#7bffb0',
        fillColor: '#7bffb0',
        fillOpacity: 0.95
      }).addTo(state.miniMap);
    } else {
      state.miniMarker.setLatLng([last.lat, last.lon]);
    }

    const bounds = L.latLngBounds(path);
    state.miniMap.fitBounds(bounds, { padding: [10, 10] });
  }

  function renderCharts() {
    const s = state.sondes.get(state.activeId);
    const hist = s ? s.history.slice().sort((a, b) => a.time - b.time) : [];

    renderMiniMap(s, hist);

    // 1) Temperatura vs wysokosc


    (function () {


      const id = 'chart-volt-temp';


      const chart = ensureChart(id, () => ({


        type: 'scatter',


        data: {


          datasets: [


            {


              label: 'Temperatura [C] vs wysokosc [m]',


              data: [],


              showLine: true,


              borderWidth: 1.5,


              pointRadius: 2


            }


          ]


        },


        options: {


          responsive: true,


          maintainAspectRatio: false,


          animation: false,


          parsing: false,


          scales: {


            x: {


              type: 'linear',


              title: { display: true, text: 'Temperatura [C]', color: '#e6ebff' },


              grid: { color: 'rgba(134,144,176,.35)' },


              ticks: { color: '#e6ebff' }


            },


            y: {


              type: 'linear',


              title: { display: true, text: 'Wysokosc [m]', color: '#e6ebff' },


              grid: { color: 'rgba(134,144,176,.35)' },


              ticks: { color: '#e6ebff' }


            }


          },


          plugins: {


            tooltip: {


              callbacks: {


                label(ctx) {


                  const p = ctx.raw || {};


                  const T = Number.isFinite(p.x) ? p.x.toFixed(1) : '—';


                  const z = Number.isFinite(p.y) ? p.y.toFixed(0) : '—';


                  const t = p.t ? new Date(p.t).toLocaleTimeString() : null;


                  return t


                    ? `T: ${T} C, z: ${z} m, t: ${t}`


                    : `T: ${T} C, z: ${z} m`;


                }


              }


            },


            legend: { labels: { color: '#e6ebff' } }


          }


        }


      }));


      if (!chart) return;



      const data = hist


        .filter(h => Number.isFinite(h.temp) && Number.isFinite(h.alt))


        .map(h => ({


          x: h.temp,


          y: h.alt,


          t: h.time.getTime()


        }))


        .sort((a, b) => a.y - b.y);



      chart.data.datasets[0].data = data;


      chart.update('none');


    })();// 2) GNSS – placeholder
    (function () {
      const id = 'chart-gnss';
      const chart = ensureChart(id, () => ({
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Liczba satelitów GNSS',
              data: [],
              borderWidth: 1.5,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: timeScaleOptions('Czas'),
            y: commonY('Liczba satelitów')
          },
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));
      if (!chart) return;

      chart.data.datasets[0].data = [];
      chart.update('none');
    })();

    // 3) Dane środowiskowe – T / RH / p
    // 3) Dane srodowiskowe – T / RH / p vs wysokosc

    (function () {

      const id = 'chart-env';

      const chart = ensureChart(id, () => ({

        type: 'scatter',

        data: {

          datasets: [

            {

              label: 'Temperatura [C]',

              xAxisID: 'xTemp',

              yAxisID: 'y',

              data: [],

              showLine: true,

              borderWidth: 1.2,

              pointRadius: 2

            },

            {

              label: 'Wilgotnosc [%]',

              xAxisID: 'xRH',

              yAxisID: 'y',

              data: [],

              showLine: true,

              borderWidth: 1.2,

              pointRadius: 2

            },

            {

              label: 'Cisnienie [hPa]',

              xAxisID: 'xP',

              yAxisID: 'y',

              data: [],

              showLine: true,

              borderWidth: 1.2,

              pointRadius: 2

            }

          ]

        },

        options: {

          responsive: true,

          maintainAspectRatio: false,

          animation: false,

          parsing: false,

          scales: {

            xTemp: {

              type: 'linear',

              position: 'bottom',

              title: { display: true, text: 'Temperatura [C]', color: '#e6ebff' },

              grid: { color: 'rgba(134,144,176,.35)' },

              ticks: { color: '#e6ebff' }

            },

            xRH: {

              type: 'linear',

              position: 'top',

              title: { display: true, text: 'Wilgotnosc [%]', color: '#e6ebff' },

              grid: { display: false },

              ticks: { color: '#e6ebff' }

            },

            xP: {

              type: 'linear',

              position: 'top',

              offset: true,

              title: { display: true, text: 'Cisnienie [hPa]', color: '#e6ebff' },

              grid: { display: false },

              ticks: { color: '#e6ebff' }

            },

            y: {

              type: 'linear',

              title: { display: true, text: 'Wysokosc [m]', color: '#e6ebff' },

              grid: { color: 'rgba(134,144,176,.35)' },

              ticks: { color: '#e6ebff' }

            }

          },

          plugins: {

            tooltip: tooltipWithAltitude(),

            legend: { labels: { color: '#e6ebff' } }

          }

        }

      }));

      if (!chart) return;


      const tempData = hist

        .filter(h => Number.isFinite(h.temp) && Number.isFinite(h.alt))

        .map(h => ({ x: h.temp, y: h.alt, alt: h.alt }));


      const rhData = hist

        .filter(h => Number.isFinite(h.humidity) && Number.isFinite(h.alt))

        .map(h => ({ x: h.humidity, y: h.alt, alt: h.alt }));


      const pData = hist

        .filter(h => Number.isFinite(h.pressure) && Number.isFinite(h.alt))

        .map(h => ({ x: h.pressure, y: h.alt, alt: h.alt }));


      chart.data.datasets[0].data = tempData;

      chart.data.datasets[1].data = rhData;

      chart.data.datasets[2].data = pData;

      chart.update('none');

    })();// 4) Prędkość pozioma vs czas
    (function () {
      const id = 'chart-hvel';
      const chart = ensureChart(id, () => ({
        type: 'line',
        data: {
          datasets: [
            {
              label: 'Prędkość pozioma [m/s]',
              data: [],
              borderWidth: 1.5,
              pointRadius: 0
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: timeScaleOptions('Czas'),
            y: commonY('Prędkość pozioma vₕ [m/s]')
          },
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } },
            altitudeTopAxis: {
              enabled: true,
              datasetIndex: 0,
              yOffsetPx: 8
            }
          }
        },
        plugins: [altitudeTopAxisPlugin]
      }));
      if (!chart) return;

      const hvData = [];
      if (s && s.history.length >= 2) {
        for (let i = 1; i < s.history.length; i++) {
          const a = s.history[i - 1];
          const b = s.history[i];
          const dt = (b.time - a.time) / 1000;
          if (dt <= 0) continue;
          const dH = haversine(a.lat, a.lon, b.lat, b.lon);
          const v = dH / dt;
          if (Number.isFinite(v)) {
            hvData.push({ x: b.time.getTime(), y: v, alt: b.alt });
          }
        }
      }

      chart.data.datasets[0].data = hvData;
      chart.update('none');
    })();

    // 4b) Profil wiatru – prędkość i kierunek vs wysokość
    (function () {
      const id = 'chart-wind-profile';
      const chart = ensureChart(id, () => ({
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'vₕ [m/s] (wznoszenie)',
              xAxisID: 'xSpd',
              yAxisID: 'y',
              data: [],
              showLine: true,
              pointRadius: 2,
              borderWidth: 1.2
            },
            {
              label: 'vₕ [m/s] (opadanie)',
              xAxisID: 'xSpd',
              yAxisID: 'y',
              data: [],
              showLine: true,
              pointRadius: 2,
              borderWidth: 1.2,
              borderDash: [4, 3]
            },
            {
              label: 'Kierunek [°] (wznoszenie)',
              xAxisID: 'xDir',
              yAxisID: 'y',
              data: [],
              showLine: false,
              pointRadius: 2,
              borderWidth: 1.2
            },
            {
              label: 'Kierunek [°] (opadanie)',
              xAxisID: 'xDir',
              yAxisID: 'y',
              data: [],
              showLine: false,
              pointRadius: 2,
              borderWidth: 1.2,
              borderDash: [4, 3]
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            xSpd: {
              type: 'linear',
              position: 'bottom',
              title: { display: true, text: 'Prędkość wiatru vₕ [m/s]', color: '#e6ebff' },
              grid: { color: 'rgba(134,144,176,.35)' },
              ticks: { color: '#e6ebff' }
            },
            xDir: {
              type: 'linear',
              position: 'top',
              min: 0,
              max: 360,
              title: { display: true, text: 'Kierunek wiatru [°]', color: '#e6ebff' },
              grid: { display: false },
              ticks: { color: '#e6ebff' }
            },
            y: commonY('Wysokość [m]')
          },
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));
      if (!chart) return;

      const speedUp = [];
      const speedDown = [];
      const dirUp = [];
      const dirDown = [];

      if (s && s.history.length >= 2) {
        const ordered = s.history.slice().sort((a, b) => a.time - b.time);

        let apexIndex = -1;
        let maxAlt = -Infinity;
        for (let i = 0; i < ordered.length; i++) {
          const z = ordered[i].alt;
          if (Number.isFinite(z) && z > maxAlt) {
            maxAlt = z;
            apexIndex = i;
          }
        }

        for (let i = 1; i < ordered.length; i++) {
          const a = ordered[i - 1];
          const b = ordered[i];

          if (!Number.isFinite(a.lat) || !Number.isFinite(a.lon) ||
              !Number.isFinite(b.lat) || !Number.isFinite(b.lon) ||
              !Number.isFinite(b.alt)) {
            continue;
          }

          const dt = (b.time - a.time) / 1000;
          if (dt <= 0) continue;

          const dH = haversine(a.lat, a.lon, b.lat, b.lon);
          const v = dH / dt;
          const dir = bearing(a.lat, a.lon, b.lat, b.lon);

          if (!Number.isFinite(v) || !Number.isFinite(dir)) continue;

          const isAscent = (apexIndex === -1) ? true : (i <= apexIndex);
          const pSpeed = { x: v, y: b.alt, alt: b.alt };
          const pDir = { x: dir, y: b.alt, alt: b.alt };

          if (isAscent) {
            speedUp.push(pSpeed);
            dirUp.push(pDir);
          } else {
            speedDown.push(pSpeed);
            dirDown.push(pDir);
          }
        }
      }

      chart.data.datasets[0].data = speedUp;
      chart.data.datasets[1].data = speedDown;
      chart.data.datasets[2].data = dirUp;
      chart.data.datasets[3].data = dirDown;

      const allSpeeds = [...speedUp, ...speedDown];
      let maxSpeed = 0;
      for (const p of allSpeeds) {
        if (p && Number.isFinite(p.x) && p.x > maxSpeed) maxSpeed = p.x;
      }
      if (chart.options.scales && chart.options.scales.xSpd) {
        if (maxSpeed > 0) {
          chart.options.scales.xSpd.min = 0;
          chart.options.scales.xSpd.max = maxSpeed * 1.1;
        } else {
          chart.options.scales.xSpd.min = undefined;
          chart.options.scales.xSpd.max = undefined;
        }
      }

      chart.update('none');
    })();

    // 5) Gęstość powietrza vs wysokość
    (function () {
      const id = 'chart-density';
      const chart = ensureChart(id, () => ({
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Gęstość powietrza [kg/m³]',
              data: [],
              borderWidth: 1.2,
              pointRadius: 3,
              showLine: true
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: 'Gęstość [kg/m³]', color: '#e6ebff' },
              grid: { color: 'rgba(134,144,176,.35)' },
              ticks: { color: '#e6ebff' }
            },
            y: commonY('Wysokość [m]')
          },
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));
      if (!chart) return;

      const R = 287;
      const densityData = hist
        .filter(h => Number.isFinite(h.pressure) && Number.isFinite(h.temp) && Number.isFinite(h.alt))
        .map(h => {
          const pPa = h.pressure * 100;
          const Tk = h.temp + 273.15;
          const rho = pPa / (R * Tk);
          return { x: rho, y: h.alt, alt: h.alt };
        });

      chart.data.datasets[0].data = densityData;
      chart.update('none');
    })();

    // 6) RSSI i napięcie vs temperatura
    (function () {
      const id = 'chart-signal-temp';
      const chart = ensureChart(id, () => ({
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'RSSI [dB]',
              yAxisID: 'yRssi',
              data: [],
              borderWidth: 1.2,
              pointRadius: 3,
              showLine: false
            },
            {
              label: 'Napięcie zasilania [V]',
              yAxisID: 'yU',
              data: [],
              borderWidth: 1.2,
              pointRadius: 3,
              showLine: false
            }
          ]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          parsing: false,
          scales: {
            x: {
              type: 'linear',
              title: { display: true, text: 'Temperatura [°C]', color: '#e6ebff' },
              grid: { color: 'rgba(134,144,176,.35)' },
              ticks: { color: '#e6ebff' }
            },
            yRssi: commonY('RSSI [dB]'),
            yU: { ...commonY('Napięcie [V]'), position: 'right' }
          },
          plugins: {
            tooltip: tooltipWithAltitude(),
            legend: { labels: { color: '#e6ebff' } }
          }
        }
      }));
      if (!chart) return;

      const rssiData = hist
        .filter(h => Number.isFinite(h.rssi) && Number.isFinite(h.temp))
        .map(h => ({ x: h.temp, y: h.rssi, alt: h.alt }));

      const uData = hist
        .filter(h => Number.isFinite(h.battery) && Number.isFinite(h.temp))
        .map(h => ({ x: h.temp, y: h.battery, alt: h.alt }));

      chart.data.datasets[0].data = rssiData;
      chart.data.datasets[1].data = uData;
      chart.update('none');
    })();

    updateStabilityBox(s);
    renderCapeCinCard(s);
    renderSkewT(s);
    renderVisibilityCard(s);
  }

  // ======= Wskaźnik stabilności =======
  function updateStabilityBox(s) {
    const canvas = document.getElementById('chart-stability');
    if (!canvas) return;
    const card = canvas.closest('.card');
    if (!card) return;

    canvas.style.display = 'none';

    let box = card.querySelector('.stability-box');
    if (!box) {
      box = document.createElement('div');
      box.className = 'stability-box';
      const body = card.querySelector('.card-body') || card;
      body.appendChild(box);
    }

    if (!s || !Number.isFinite(s.stabilityIndex)) {
      box.className = 'stability-box';
      box.innerHTML = `
        <div class="stability-box-head">
          <span class="gamma">Γ: —</span>
          <span class="class-label">Brak danych</span>
        </div>
        <div class="stability-bar">
          <div class="stability-bar-inner" style="width:0%"></div>
        </div>
        <div class="stability-legenda">
          <span>silnie stabilna</span>
          <span>obojętna</span>
          <span>silnie chwiejna</span>
        </div>
      `;
      return;
    }

    const gamma = s.stabilityIndex;
    const cls = s.stabilityClass || '—';

    const percent = Math.max(0, Math.min(100, (gamma / 12) * 100));

    let stateClass = '';
    if (gamma > 9.8) stateClass = 'stability--very-unstable';
    else if (gamma > 7) stateClass = 'stability--unstable';
    else if (gamma > 4) stateClass = 'stability--neutral';
    else stateClass = 'stability--stable';

    box.className = `stability-box ${stateClass}`;
    box.innerHTML = `
      <div class="stability-box-head">
        <span class="gamma">Γ: ${gamma.toFixed(1)} K/km</span>
        <span class="class-label">${cls}</span>
      </div>
      <div class="stability-bar">
        <div class="stability-bar-inner" style="width:${percent}%"></div>
      </div>
      <div class="stability-legenda">
        <span>silnie stabilna</span>
        <span>obojętna</span>
        <span>silnie chwiejna</span>
      </div>
    `;
  }

  // ======= Karta CAPE / CIN =======
  function renderCapeCinCard(s) {
    const chartsView = document.getElementById('view-charts');
    if (!chartsView) return;

    let card = document.getElementById('cape-cin-card');
    const grid = document.querySelector('#view-charts .charts-scroll');
    if (!grid) return;

    if (!card) {
      card = document.createElement('div');
      card.id = 'cape-cin-card';
      card.className = 'card wide cape-cin-card';
    }
    if (card.parentElement !== grid) grid.appendChild(card);

    if (!s) {
      card.innerHTML = `
        <div class="card-header">Energia konwekcji (CAPE / CIN)</div>
        <div class="card-body">
          <p>Brak wybranej aktywnej sondy.</p>
        </div>
      `;
      return;
    }

    const cape = s.cape;
    const cin = s.cin;
    const gamma = s.stabilityIndex;
    const cls = s.stabilityClass || '—';

    let capeLevel = 'brak danych';
    if (Number.isFinite(cape)) {
      if (cape < 100) capeLevel = 'bardzo mała';
      else if (cape < 500) capeLevel = 'mała';
      else if (cape < 1000) capeLevel = 'umiarkowana';
      else if (cape < 2000) capeLevel = 'duża';
      else capeLevel = 'bardzo duża';
    }

    let cinLevel = 'brak danych';
    if (Number.isFinite(cin)) {
      const absCin = Math.abs(cin);
      if (absCin < 25) cinLevel = 'słaba blokada';
      else if (absCin < 75) cinLevel = 'umiarkowana blokada';
      else cinLevel = 'silna blokada';
    }

    let summary;
    if (!Number.isFinite(cape)) {
      summary = 'Brak pełnych danych do obliczenia CAPE/CIN – wykorzystano jedynie wskaźnik stabilności.';
    } else if (cape < 100) {
      summary = 'Konwekcja praktycznie wykluczona.';
    } else if (cape < 500) {
      summary = 'Słaba, lokalna konwekcja możliwa.';
    } else if (cape < 1000) {
      summary = 'Umiarkowany potencjał burzowy.';
    } else if (cape < 2000) {
      summary = 'Duży potencjał burzowy, możliwe silniejsze komórki.';
    } else {
      summary = 'Bardzo duży potencjał burzowy – środowisko sprzyjające silnym burzom.';
    }

    const gammaStr = Number.isFinite(gamma) ? gamma.toFixed(1) + ' K/km' : '—';

    card.innerHTML = `
      <div class="card-head">
        <span>Energia konwekcji (CAPE / CIN)</span>
      </div>
      <div class="card-body cape-cin-body">
        <div class="cape-cin-main">
          <div class="cape-cin-block">
            <div class="cape-cin-label">CAPE</div>
            <div class="cape-cin-value">
              ${Number.isFinite(cape) ? cape.toFixed(0) + ' J/kg' : '—'}
            </div>
            <div class="cape-cin-level">${capeLevel}</div>
          </div>
          <div class="cape-cin-block">
            <div class="cape-cin-label">CIN</div>
            <div class="cape-cin-value">
              ${Number.isFinite(cin) ? cin.toFixed(0) + ' J/kg' : '—'}
            </div>
            <div class="cape-cin-level">${cinLevel}</div>
          </div>
        </div>
        <div class="cape-cin-extra">
          <div><strong>Stabilność (Γ):</strong> ${gammaStr} (${cls})</div>
          <div><strong>Szybka ocena:</strong> ${summary}</div>
          <div class="cape-cin-note">
            Uwaga: wartości CAPE/CIN są w tej chwili prototypowe – mogą być rozwinięte o pełne obliczenia z profilu
            radiosondażu.
          </div>
        </div>
      </div>
    `;
  }

  
  // ======= Wskaznik widzialnosci (szacunkowy, na podstawie warstwy przyziemnej) =======
  // Uwaga: to NIE jest oficjalny METAR/TAF. To heurystyka z danych radiosondy (T/RH).
  // Wynik traktuj jako orientacyjny.
  function estimateVisibilityKmFromTRH(Tc, RH) {
    if (!Number.isFinite(Tc) || !Number.isFinite(RH)) return { km: null, cls: 'brak danych', note: 'Missing T/RH' };

    // punkt rosy i "dewpoint depression"
    const Td = dewPoint(Tc, RH);
    const d = (Number.isFinite(Td)) ? (Tc - Td) : null;

    // proste progi: im wyzsze RH i mniejsza roznica T-Td, tym mniejsza widzialnosc (mgla / zamglenie)
    // Celowo ograniczamy zakres do 0.2 .. 50 km
    let km = 30;

    const rh = clamp(RH, 0, 100);
    const dd = Number.isFinite(d) ? clamp(d, 0, 20) : null;

    if (rh >= 99 || (dd != null && dd <= 0.5)) {
      km = 0.5; // bardzo gesta mgla
    } else if (rh >= 97 || (dd != null && dd <= 1.0)) {
      km = 1.0;
    } else if (rh >= 95 || (dd != null && dd <= 2.0)) {
      km = 2.0 + (dd != null ? (dd - 1.0) * 2.0 : 0); // ok. 2..4 km
    } else if (rh >= 90 || (dd != null && dd <= 4.0)) {
      km = 5.0 + (dd != null ? (dd - 2.0) * 2.5 : 0); // ok. 5..10+ km
    } else if (rh >= 80) {
      km = 12.0 + (dd != null ? dd * 2.0 : 0); // ok. 12..50 km
    } else {
      km = 20.0 + (dd != null ? dd * 2.0 : 10.0);
    }

    km = clamp(km, 0.2, 50);

    let cls = 'dobra';
    if (km < 1) cls = 'bardzo slaba';
    else if (km < 5) cls = 'slaba';
    else if (km < 10) cls = 'umiarkowana';
    else if (km < 20) cls = 'dobra';
    else cls = 'bardzo dobra';

    return { km, cls, note: (Number.isFinite(Td) ? `Td=${Td.toFixed(1)}C, dT=${(Tc - Td).toFixed(1)}C` : 'Td unavailable') };
  }

  function nmFromKm(km) {
    return Number.isFinite(km) ? (km / 1.852) : null;
  }

  // wybiera "warstwe przyziemna" jako punkty w zakresie [baseAlt .. baseAlt+rangeM]
  function pickNearSurfaceLayer(history, baseAlt, rangeM) {
    const out = [];
    if (!Array.isArray(history) || !history.length) return out;
    for (const h of history) {
      if (!h) continue;
      if (!Number.isFinite(h.alt)) continue;
      if (h.alt >= baseAlt && h.alt <= baseAlt + rangeM) out.push(h);
    }
    return out;
  }

  function summarizeLayer(layer) {
    // srednie z T/RH/p + zakres wysokosci, z jakiej wzieto probke
    let sumT = 0, nT = 0;
    let sumRH = 0, nRH = 0;
    let sumP = 0, nP = 0;

    let zMin = Infinity;
    let zMax = -Infinity;
    let zSum = 0;
    let zCount = 0;

    for (const h of layer) {
      if (Number.isFinite(h.temp)) { sumT += h.temp; nT++; }
      if (Number.isFinite(h.humidity)) { sumRH += h.humidity; nRH++; }
      if (Number.isFinite(h.pressure)) { sumP += h.pressure; nP++; }

      if (Number.isFinite(h.alt)) {
        zMin = Math.min(zMin, h.alt);
        zMax = Math.max(zMax, h.alt);
        zSum += h.alt;
        zCount++;
      }
    }

    const T = nT ? (sumT / nT) : null;
    const RH = nRH ? (sumRH / nRH) : null;
    const P = nP ? (sumP / nP) : null;

    const zAvg = zCount ? (zSum / zCount) : null;
    if (!Number.isFinite(zMin)) zMin = null;
    if (!Number.isFinite(zMax)) zMax = null;

    return { T, RH, P, n: layer.length, zMin, zMax, zAvg };
  }

  function renderVisibilityCard(s) {
    const chartsView = document.getElementById('view-charts');
    if (!chartsView) return;

    // Fix (UI): karta widzialnosci ma byc zwyklym elementem przeplywu (bez sticky/absolute),
    // bo inaczej moze zaslaniac wykresy (np. Skew-T).
    if (!document.getElementById('visibility-style-fix')) {
      const st = document.createElement('style');
      st.id = 'visibility-style-fix';
      st.textContent = `
      /* widzialnosc: karta ma byc w normalnym przeplywie (bez fixed/sticky/absolute) */
      .visibility-card{
        position: static !important;
        inset: auto !important;
        top: auto !important;
        right: auto !important;
        bottom: auto !important;
        left: auto !important;
        z-index: 0 !important;
      }
      /* Zostaw oddech na koncu listy wykresow */
      #view-charts .charts-scroll{
        padding-bottom: 28px !important;
      }
    `;
      document.head.appendChild(st);
    }

    // Doklej karte na koniec listy wykresow.
    const grid = document.querySelector('#view-charts .charts-scroll');
    if (!grid) return;
    let card = document.getElementById('visibility-card');
    if (!card) {
      card = document.createElement('div');
      card.id = 'visibility-card';
      card.className = 'card wide visibility-card';
    }

    // hard reset aby nigdy nie nachodzilo na inne karty (ani nie bylo sticky/fixed)
    card.style.position = 'static';
    card.style.inset = 'auto';
    card.style.top = 'auto';
    card.style.right = 'auto';
    card.style.bottom = 'auto';
    card.style.left = 'auto';
    card.style.zIndex = 'auto';
    card.style.marginTop = '12px';

    // Ustaw jako zwykla karte na koncu listy wykresow (tak jak CAPE/CIN).
    // To gwarantuje: brak zaslaniania innych wykresow i brak sztucznego odstepu.
        // Wstaw wskaźnik widzialności NAD kartą Skew‑T (najstabilniejsze miejsce)
    const skewCard = grid.querySelector('.skewt-card');
    if (skewCard) {
      grid.insertBefore(card, skewCard);
    } else {
      grid.appendChild(card);
    }

    if (!s || !Array.isArray(s.history) || !s.history.length) {
      card.innerHTML = `
        <div class="card-head"><span>Widzialnosc (szacunek)</span></div>
        <div class="card-body">
          <p>Brak danych radiosondy.</p>
        </div>
      `;
      return;
    }

    const ordered = s.history.slice().sort((a, b) => a.time - b.time);

    // baza startu: minimalna wysokosc z pierwszych 10 punktow (zwykle okolice gruntu)
    const firstN = ordered.slice(0, Math.min(10, ordered.length));
    let launchBase = Infinity;
    for (const h of firstN) {
      if (Number.isFinite(h.alt)) launchBase = Math.min(launchBase, h.alt);
    }
    if (!Number.isFinite(launchBase)) launchBase = ordered[0].alt;

    // baza ladowania: minimalna wysokosc z ostatnich 20 punktow
    const lastN = ordered.slice(Math.max(0, ordered.length - 20));
    let landBase = Infinity;
    for (const h of lastN) {
      if (Number.isFinite(h.alt)) landBase = Math.min(landBase, h.alt);
    }

    // czy jest faza opadania? (wtedy pokazujemy "landing")
    let maxAlt = -Infinity;
    let lastAlt = ordered[ordered.length - 1].alt;
    for (const h of ordered) {
      if (Number.isFinite(h.alt)) maxAlt = Math.max(maxAlt, h.alt);
    }
    const hasDescent = Number.isFinite(maxAlt) && Number.isFinite(lastAlt) && (lastAlt < maxAlt - 10);

    const LAYER_M = 100; // warstwa przyziemna 0..100 m nad baza
    const layerLaunch = pickNearSurfaceLayer(ordered, launchBase, LAYER_M);
    const sLaunch = summarizeLayer(layerLaunch);
    const estLaunch = estimateVisibilityKmFromTRH(sLaunch.T, sLaunch.RH);

    let estLand = { km: null, cls: 'brak danych', note: '' };
    let sLand = { T: null, RH: null, P: null, n: 0 };
    if (hasDescent && Number.isFinite(landBase)) {
      const layerLand = pickNearSurfaceLayer(lastN, landBase, LAYER_M);
      sLand = summarizeLayer(layerLand);
      estLand = estimateVisibilityKmFromTRH(sLand.T, sLand.RH);
    }

    const nmLaunch = nmFromKm(estLaunch.km);
    const nmLand = nmFromKm(estLand.km);

    const qLaunch = clamp((sLaunch.n || 0) / 6, 0, 1);
    const qLand = hasDescent ? clamp((sLand.n || 0) / 6, 0, 1) : 0;

    const visTag = (nm) => Number.isFinite(nm) ? `${nm.toFixed(1)} NM` : '—';
    const tTag = (v) => Number.isFinite(v) ? `${v.toFixed(1)} C` : '—';
    const rhTag = (v) => Number.isFinite(v) ? `${v.toFixed(0)} %` : '—';
    const pTag = (v) => Number.isFinite(v) ? `${v.toFixed(0)} hPa` : '—';
    const zTag = (a, b, avg) => {
      const okA = Number.isFinite(a);
      const okB = Number.isFinite(b);
      const okM = Number.isFinite(avg);
      if (okA && okB) return `z=${a.toFixed(0)}-${b.toFixed(0)} m` + (okM ? ` (sr ${avg.toFixed(0)} m)` : '');
      if (okM) return `z~${avg.toFixed(0)} m`;
      return 'z=—';
    };

    const barPct = Number.isFinite(nmLaunch) ? clamp((nmLaunch / (50 / 1.852)) * 100, 0, 100) : 0;

    // klasa do stylowania (opcjonalnie w CSS)
    let stateClass = 'vis--na';
    if (Number.isFinite(estLaunch.km)) {
      if (estLaunch.km < 1) stateClass = 'vis--very-bad';
      else if (estLaunch.km < 5) stateClass = 'vis--bad';
      else if (estLaunch.km < 10) stateClass = 'vis--ok';
      else if (estLaunch.km < 20) stateClass = 'vis--good';
      else stateClass = 'vis--very-good';
    }

    card.innerHTML = `
      <div class="card-head">
        <span>Widzialnosc (szacunek, warstwa 0-${LAYER_M} m)</span>
      </div>
      <div class="card-body ${stateClass}">
        <div style="display:flex;gap:18px;flex-wrap:wrap;align-items:flex-start">
          <div style="min-width:260px;flex:1">
            <div style="font-weight:700;font-size:18px;line-height:1.2">
              Start: ${visTag(nmLaunch)} <span style="font-weight:500;color:#8a94b0">(${estLaunch.cls})</span>
            </div>
            <div style="margin-top:6px;font-size:12px;color:#8a94b0">
              T=${tTag(sLaunch.T)}, RH=${rhTag(sLaunch.RH)}, p=${pTag(sLaunch.P)}, ${zTag(sLaunch.zMin, sLaunch.zMax, sLaunch.zAvg)} <span style="opacity:.8">| ${estLaunch.note || ''}</span>
            </div>
            <div style="margin-top:10px">
              <div class="stability-bar" style="height:10px">
                <div class="stability-bar-inner" style="width:${barPct}%;height:10px"></div>
              </div>
              <div style="margin-top:6px;font-size:12px;color:#8a94b0">
                Jakosc danych (start): ${(qLaunch*100).toFixed(0)}% (punkty w warstwie: ${sLaunch.n || 0})
              </div>
            </div>
          </div>

          <div style="min-width:260px;flex:1">
            <div style="font-weight:700;font-size:18px;line-height:1.2">
              Ladowanie: ${hasDescent ? visTag(nmLand) : '—'} <span style="font-weight:500;color:#8a94b0">(${hasDescent ? estLand.cls : 'brak opadania'})</span>
            </div>
            <div style="margin-top:6px;font-size:12px;color:#8a94b0">
              T=${tTag(sLand.T)}, RH=${rhTag(sLand.RH)}, p=${pTag(sLand.P)}, ${zTag(sLand.zMin, sLand.zMax, sLand.zAvg)} <span style="opacity:.8">${hasDescent ? ('| ' + (estLand.note || '')) : ''}</span>
            </div>
            <div style="margin-top:10px;font-size:12px;color:#8a94b0">
              Jakosc danych (ladowanie): ${hasDescent ? (qLand*100).toFixed(0) + '%' : '—'} ${hasDescent ? `(punkty w warstwie: ${sLand.n || 0})` : ''}
            </div>
          </div>
        </div>

      </div>
    `;
  }

// ======= Raport PDF =======
  async function generatePdfReport() {
    const jsPdfCtor =
      (window.jspdf && window.jspdf.jsPDF) ||
      window.jsPDF ||
      null;

    if (!jsPdfCtor || typeof html2canvas === 'undefined') {
      alert('PDF generator not available (jsPDF / html2canvas missing).');
      console.error('jsPdfCtor =', jsPdfCtor, 'html2canvas =', typeof html2canvas);
      return;
    }

    const s = state.sondes.get(state.activeId);
    if (!s) {
      alert('No active sonde selected.');
      return;
    }

    const viewTelemetry = document.getElementById('view-telemetry');
    const viewCharts = document.getElementById('view-charts');
    const chartsWasShown = viewCharts && viewCharts.classList.contains('show');

    if (viewTelemetry && viewCharts) {
      viewTelemetry.classList.remove('show');
      viewCharts.classList.add('show');
      renderCharts();
      await new Promise(r => setTimeout(r, 80));
    }

    const doc = new jsPdfCtor('p', 'mm', 'a4');
    let y = 15;

    doc.setFontSize(16);
    doc.text('Radiosonde telemetry report', 105, y, { align: 'center' });
    y += 10;

    doc.setFontSize(11);
    const timeStr = s.time ? new Date(s.time).toLocaleString() : '-';
    const statusAscii = (s.status === 'active') ? 'Active' : 'Finished';

    let stabAscii = '-';
    switch (s.stabilityClass) {
      case 'silnie chwiejna': stabAscii = 'Very unstable'; break;
      case 'chwiejna':        stabAscii = 'Unstable';      break;
      case 'obojętna':        stabAscii = 'Neutral';       break;
      case 'stabilna':        stabAscii = 'Stable';        break;
      case 'silnie stabilna': stabAscii = 'Very stable';   break;
      default:                stabAscii = '-';
    }

    doc.text(`Sonde ID: ${s.id}`, 14, y); y += 6;
    doc.text(`Type: ${s.type || '-'}`, 14, y); y += 6;
    doc.text(`Last fix: ${timeStr}`, 14, y); y += 6;
    doc.text(`Status: ${statusAscii}`, 14, y); y += 6;

    doc.text(`Alt [m]: ${fmt(s.alt, 0)}`, 14, y); y += 6;
    doc.text(`Temp [C]: ${fmt(s.temp, 1)}`, 14, y); y += 6;
    doc.text(`Dew point [C]: ${fmt(s.dewPoint, 1)}`, 14, y); y += 6;
    doc.text(`Pressure [hPa]: ${fmt(s.pressure, 1)}`, 14, y); y += 6;
    doc.text(`RH [%]: ${fmt(s.humidity, 0)}`, 14, y); y += 6;
    doc.text(`Vertical speed [m/s]: ${fmt(s.verticalSpeed, 1)}`, 14, y); y += 6;
    doc.text(`Horizontal speed [m/s]: ${fmt(s.horizontalSpeed, 1)}`, 14, y); y += 6;
    doc.text(`Distance to RX [m]: ${fmt(s.distanceToRx, 0)}`, 14, y); y += 6;
    doc.text(`Theta potential [K]: ${fmt(s.theta, 1)}`, 14, y); y += 6;
    doc.text(`Stability Gamma [K/km]: ${fmt(s.stabilityIndex, 1)}`, 14, y); y += 6;
    doc.text(`Stability class: ${stabAscii}`, 14, y); y += 8;

    function addChartImageByCanvasId(canvasId, label) {
      const canvas = document.getElementById(canvasId);
      if (!canvas) {
        console.warn('Canvas not found for PDF:', canvasId);
        return;
      }

      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width  = canvas.width;
      tmpCanvas.height = canvas.height;
      const ctx = tmpCanvas.getContext('2d');

      ctx.fillStyle = '#050922';
      ctx.fillRect(0, 0, tmpCanvas.width, tmpCanvas.height);

      ctx.drawImage(canvas, 0, 0);

      const imgData = tmpCanvas.toDataURL('image/png', 1.0);

      const pageWidth = 210;
      const margin = 15;
      const maxWidth = pageWidth - margin * 2;
      const aspect = tmpCanvas.height / tmpCanvas.width;
      const imgWidth = maxWidth;
      const imgHeight = imgWidth * aspect;

      if (y + imgHeight + 10 > 287) {
        doc.addPage();
        y = 15;
      }

      doc.setFontSize(11);
      doc.text(label, margin, y);
      y += 4;
      doc.addImage(imgData, 'PNG', margin, y, imgWidth, imgHeight);
      y += imgHeight + 8;
    }

    try { addChartImageByCanvasId('chart-volt-temp',   'Temperature vs time'); } catch (e) { console.error(e); }
    try { addChartImageByCanvasId('chart-hvel',        'Horizontal speed vs time'); } catch (e) { console.error(e); }
    try { addChartImageByCanvasId('chart-env',         'Environmental data (T, RH, p)'); } catch (e) { console.error(e); }
    try { addChartImageByCanvasId('chart-wind-profile','Wind profile'); } catch (e) { console.error(e); }
    try { addChartImageByCanvasId('chart-density',     'Air density vs altitude'); } catch (e) { console.error(e); }
    try { addChartImageByCanvasId('chart-signal-temp', 'RSSI and supply voltage vs temperature'); } catch (e) { console.error(e); }

    const miniEl = document.getElementById('mini-map');
    if (miniEl) {
      if (y + 70 > 287) {
        doc.addPage();
        y = 15;
      }
      doc.setFontSize(11);
      doc.text('Flight path (mini map)', 15, y);
      y += 4;

      try {
        const canvasMini = await html2canvas(miniEl, { useCORS: true, scale: 2 });
        const imgDataMini = canvasMini.toDataURL('image/png', 0.9);
        const pageWidth = 210;
        const margin = 15;
        const maxWidth = pageWidth - margin * 2;
        const aspect = canvasMini.height / canvasMini.width;
        const imgWidth = maxWidth;
        const imgHeight = imgWidth * aspect;

        if (y + imgHeight + 10 > 287) {
          doc.addPage();
          y = 15;
        }
        doc.addImage(imgDataMini, 'PNG', margin, y, imgWidth, imgHeight);
        y += imgHeight + 8;
      } catch (e) {
        console.error('Mini map to PDF error:', e);
      }
    }

    doc.save(`sonde_${s.id}_report.pdf`);

    if (viewTelemetry && viewCharts && !chartsWasShown) {
      viewCharts.classList.remove('show');
      viewTelemetry.classList.add('show');
      renderCharts();
    }
  }

  // ======= Boot =======
  window.addEventListener('DOMContentLoaded', () => {
    initLogin();
    initMap();
    initUI();
    restartFetching();
  });
})();

/* =========================================================
   TRYB PREZENTACJI SPLIT 50/50
   - Lewa: duża mapa + dane telemetryczne LIVE
   - Prawa: slajdy z kartami wykresów (bez mini-mapy)
   - Wskaźniki (Stabilność + CAPE/CIN + Widzialność) razem jako jeden slajd (3 karty naraz)
   - Bez fixed/sticky/absolute: używa osobnego widoku #view-presentation
   ========================================================= */
(function () {
  let active = false;
  let timer = null;
  let slideIndex = 0;
  let paused = false;

  const SLIDE_MS = 10000;
  let slidesCache = [];

// autoscroll telemetrii (dane pod mapą) — tylko w prezentacji
const TELEMETRY_SCROLL_MS = 40; // ms
const TELEMETRY_SCROLL_STEP = 0.5; // px
let telemetryScrollTimer = null;

  // zapamiętanie oryginalnych miejsc w DOM (żeby wszystko wróciło 1:1)
  const moved = new Map();

  function rememberAndMove(el, newParent, before = null) {
    if (!el || !newParent) return;
    if (!moved.has(el)) {
      moved.set(el, { parent: el.parentNode, next: el.nextSibling });
    }
    if (before) newParent.insertBefore(el, before);
    else newParent.appendChild(el);
  }

  function restoreAll() {
    for (const [el, info] of moved.entries()) {
      if (!info.parent) continue;
      if (info.next && info.next.parentNode === info.parent) info.parent.insertBefore(el, info.next);
      else info.parent.appendChild(el);
    }
    moved.clear();
  }

  function showOnlyPresentationView() {
    document.body.classList.add('presentation-mode');
  }

  function hidePresentationView() {
    document.body.classList.remove('presentation-mode');
  }

  function invalidateLeafletAndCharts() {
    try { (state && state.map) && state.map.invalidateSize && state.map.invalidateSize(); } catch (e) {}
    // Chart.js: spróbuj wywołać resize na znanych instancjach (bez grzebania w renderach)
    try {
      if (state && state.charts) {
        Object.values(state.charts).forEach((ch) => { try { ch && ch.resize && ch.resize(); } catch (e) {} });
      }
    } catch (e) {}
  }

  function getChartsCardsExcludingMiniMap() {
    const grid = document.querySelector('#view-charts .charts-scroll');
    if (!grid) return [];
    const cards = Array.from(grid.querySelectorAll(':scope > .card'));
    return cards.filter(card => !card.querySelector('#mini-map'));
  }

  function getIndicatorCards() {
    const indicators = [];
    // Stabilność: karta która zawiera canvas#chart-stability
    const stab = document.querySelector('#chart-stability')?.closest('.card');
    if (stab) indicators.push(stab);

    // CAPE/CIN: #cape-cin-card to już .card.wide
    const cape = document.getElementById('cape-cin-card');
    if (cape) indicators.push(cape);

    // Widzialność: szukamy po klasie używanej w Twoim kodzie
    const vis = document.querySelector('.visibility-card') || document.getElementById('visibility-card');
    if (vis) indicators.push(vis);

    return indicators;
  }

  function buildSlides() {
    const slides = [];

    // Slajdy wykresów: każda karta osobno (bez mini-mapy)
    const chartCards = getChartsCardsExcludingMiniMap();
    chartCards.forEach(card => slides.push({ type: 'card', nodes: [card] }));

    // Slajd wskaźników: 3 karty razem (jeśli są)
    const inds = getIndicatorCards();
    if (inds.length >= 2) {
      slides.push({ type: 'indicators', nodes: inds });
    }

    return slides;
  }

  function clearStage(stage) {
    while (stage.firstChild) stage.removeChild(stage.firstChild);
  }

  function renderSlide(stage, slide) {
    clearStage(stage);
    if (!slide) return;

    if (slide.type === 'indicators') {
      const wrap = document.createElement('div');
      wrap.className = 'presentation-indicators-stack';
      stage.appendChild(wrap);
      slide.nodes.forEach(node => rememberAndMove(node, wrap));
      return;
    }

    // single card
    rememberAndMove(slide.nodes[0], stage);
  }

  function stop() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  function scheduleNext() {
    stop();
    if (!active || paused) return;
    timer = setTimeout(() => {
      next();
      scheduleNext();
    }, SLIDE_MS);
  }

  function next() {
    const stage = document.getElementById('presentation-slide-stage');
    if (!stage) return;
    const slides = slidesCache && slidesCache.length ? slidesCache : buildSlides();
    if (!slides.length) return;
    // jeśli cache było puste, zapamiętaj je (ale tylko raz)
    if (!slidesCache || !slidesCache.length) slidesCache = slides;

    slideIndex = (slideIndex + 1) % slides.length;
    renderSlide(stage, slides[slideIndex]);
    invalidateLeafletAndCharts();
  }

  function prev() {
    const stage = document.getElementById('presentation-slide-stage');
    if (!stage) return;
    const slides = slidesCache && slidesCache.length ? slidesCache : buildSlides();
    if (!slides.length) return;
    if (!slidesCache || !slidesCache.length) slidesCache = slides;

    slideIndex = (slideIndex - 1 + slides.length) % slides.length;
    renderSlide(stage, slides[slideIndex]);
    invalidateLeafletAndCharts();
  }

  function togglePause() {
    paused = !paused;
    if (!paused) scheduleNext();
    else stop();
  }


function startTelemetryAutoScroll() {
  stopTelemetryAutoScroll();
  // przewijamy slot z panelem danych (on ma mieć overflow:auto w CSS; na wszelki wypadek ustawiamy inline)
  const panelSlot = document.getElementById('presentation-panel-slot');
  if (!panelSlot) return;

  // upewnij się, że da się przewijać
  panelSlot.style.overflowY = 'auto';
  panelSlot.style.maxHeight = '100%';
  panelSlot.style.minHeight = '0';

  telemetryScrollTimer = setInterval(() => {
    if (!active) return;
    const max = panelSlot.scrollHeight - panelSlot.clientHeight;
    if (max <= 2) return;
    panelSlot.scrollTop += TELEMETRY_SCROLL_STEP;
    if (panelSlot.scrollTop >= max) panelSlot.scrollTop = 0;
  }, TELEMETRY_SCROLL_MS);
}

function stopTelemetryAutoScroll() {
  if (!telemetryScrollTimer) return;
  clearInterval(telemetryScrollTimer);
  telemetryScrollTimer = null;
}

  async function enter() {
    if (active) return;
    active = true;

    // pokaż widok prezentacji
    showOnlyPresentationView();

    // przenieś mapę i panele telemetryczne do lewego slotu
    const mapSlot = document.getElementById('presentation-map-slot');

    // Guard: jeśli HTML nie zawiera widoku prezentacji, nie wchodź w tryb (żeby nie było czarnego ekranu)
    if (!mapSlot || !document.getElementById('view-presentation')) {
      console.warn('Brak #view-presentation lub slotów prezentacji w index.html.');
      hidePresentationView();
      active = false;
      stopTelemetryAutoScroll();
      return;
    }

    const panelSlot = document.getElementById('presentation-panel-slot');
    const sondesSlot = document.getElementById('presentation-sondes-slot');

    rememberAndMove(document.getElementById('map'), mapSlot);
    rememberAndMove(document.getElementById('sonde-panel'), panelSlot);
    // powolny autoscroll danych pod mapą
    startTelemetryAutoScroll();
    rememberAndMove(document.getElementById('sonde-tabs')?.closest('.card') || document.getElementById('sonde-tabs'), sondesSlot);

    // fullscreen (opcjonalnie, jak przeglądarka pozwoli)
    if (!document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen(); } catch (e) {}
    }

    // start: pierwszy slajd
    const stage = document.getElementById('presentation-slide-stage');
    const slides = buildSlides();
    slidesCache = slides;
    slideIndex = 0;
    paused = false;
    slidesCache = [];
    slideIndex = 0;

    if (!slidesCache.length) {
      console.warn('Brak slajdów do prezentacji.');
      return;
    }
    renderSlide(stage, slidesCache[0]);
    invalidateLeafletAndCharts();
    scheduleNext();
  }

  function exit() {
    if (!active) return;
    active = false;
    stop();
    stopTelemetryAutoScroll();
    paused = false;

    clearStage(document.getElementById('presentation-slide-stage'));
    restoreAll();
    hidePresentationView();
    invalidateLeafletAndCharts();

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  function bind() {
    const btn = document.getElementById('btn-present');
    if (btn) btn.addEventListener('click', () => (active ? exit() : enter()));

    document.addEventListener('fullscreenchange', () => {
      if (!document.fullscreenElement && active) exit();
    });

    document.addEventListener('keydown', (e) => {
      if (!active) return;

      const tag = (document.activeElement && document.activeElement.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea') return;

      if (e.code === 'Space') {
        e.preventDefault();
        togglePause();
      } else if (e.code === 'ArrowRight') {
        e.preventDefault();
        next();
        scheduleNext();
      } else if (e.code === 'ArrowLeft') {
        e.preventDefault();
        prev();
        scheduleNext();
      } else if (e.code === 'Escape') {
        e.preventDefault();
        exit();
      }
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind);
  else bind();
})();
