// ============================================================================
//  background.js — service worker (Manifest V3)
//
//  Otwiera ofertę w OSOBNYM, ZMINIMALIZOWANYM oknie (nie w pasku kart), udajac
//  telefon, czeka az Booking wyrenderuje cene, odczytuje ja i odsyla.
//
//  Dlaczego osobne zminimalizowane okno, a nie karta w tle:
//   - nie zasmieca paska kart uzytkownika;
//   - nieaktywna karta bywa usypiana przez Chrome i renderuje wolniej —
//     osobne okno renderuje normalnie, wiec cena pojawia sie szybciej.
//
//  Dlaczego PETLA ponawiania, a nie 2 proby:
//   - Booking dorabia cene JS-em z opoznieniem (zwlaszcza wylogowany, z
//     bannerem cookies). Odpytujemy co POLL_MS az cena sie pojawi, do
//     POLL_DEADLINE_MS. Lepiej poczekac kilka sekund niz zwrocic falszywy blad.
//
//  ODCZYT CENY (twardy): tylko cena calkowita pobytu (data-hotel-rounded-price
//  lub element-ceny w wierszu), filtr MIN_PLN odrzuca kwoty znizek, brak
//  fallbacku "pierwsza kwota". Dopasowanie po data-block-id.
// ============================================================================

const MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; SM-G998B) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36";

const DNR_RULE_ID = 4823;
const PROBE_MARKER = "bmpprobe";

const POLL_MS = 1200;            // co ile odpytujemy o cene
const POLL_DEADLINE_MS = 18000;  // jak dlugo maksymalnie probujemy odczytac cene
const HARD_TIMEOUT_MS = 30000;   // twardy limit calej sondy (bezpiecznik > deadline)

// tabId (karty w oknie-sondzie) -> stan sondy
const pendingProbes = new Map();

async function enableMobileRule() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [DNR_RULE_ID],
    addRules: [
      {
        id: DNR_RULE_ID,
        priority: 1,
        action: {
          type: "modifyHeaders",
          requestHeaders: [
            { header: "User-Agent", operation: "set", value: MOBILE_UA },
            { header: "Sec-CH-UA-Mobile", operation: "set", value: "?1" },
            { header: "Sec-CH-UA-Platform", operation: "set", value: '"Android"' }
          ]
        },
        condition: {
          urlFilter: "bmpprobe=1",
          requestDomains: ["booking.com"],
          resourceTypes: ["main_frame", "sub_frame", "xmlhttprequest"]
        }
      }
    ]
  });
}

async function disableMobileRule() {
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [DNR_RULE_ID] });
}

function markProbeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.set(PROBE_MARKER, "1");
    return u.toString();
  } catch (e) {
    return rawUrl + (rawUrl.includes("?") ? "&" : "?") + "bmpprobe=1";
  }
}

// ---------------------------------------------------------------------------
//  Glowny przeplyw: otworz zminimalizowane okno, odpytuj w petli, posprzataj.
// ---------------------------------------------------------------------------
async function probeMobilePrice(rawUrl) {
  await enableMobileRule();
  const probeUrl = markProbeUrl(rawUrl);

  // Otwieramy osobne okno. Probujemy je schowac, ale NIE polegamy na pozycji
  // poza ekranem przy create (czesc wersji Chrome odrzuca takie wspolrzedne
  // albo nie dolacza tablicy tabs). Wspolrzedne ustawiamy dopiero po fakcie.
  let win;
  try {
    win = await chrome.windows.create({
      url: probeUrl,
      focused: false,
      width: 420,
      height: 900
    });
  } catch (e) {
    await disableMobileRuleIfIdle();
    throw new Error("window-create-failed: " + (e && e.message ? e.message : e));
  }

  const winId = win.id;

  // Karte pobieramy z odpowiedzi, a jak jej nie ma — dopytujemy o nia osobno.
  let tabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  if (tabId == null) {
    try {
      const tabs = await chrome.tabs.query({ windowId: winId });
      if (tabs && tabs[0]) tabId = tabs[0].id;
    } catch (e) {}
  }

  if (tabId == null) {
    try { await chrome.windows.remove(winId); } catch (e) {}
    await disableMobileRuleIfIdle();
    throw new Error("no-tab-in-window");
  }

  // Chowamy okno PRZESUWAJAC JE POZA EKRAN — ale NIE minimalizujemy.
  // Zminimalizowane okno Chrome usypia i nie renderuje (cena sie nie doczytuje).
  // Okno poza ekranem renderuje normalnie, a uzytkownik go nie widzi.
  try { await chrome.windows.update(winId, { left: -2400, top: -2400, focused: false }); } catch (e) {}

  return new Promise((resolve, reject) => {
    const state = {
      winId: winId,
      tabId: tabId,
      polling: false,
      done: false,
      pollTimer: null,
      hardTimer: null
    };

    function finish() {
      if (state.done) return;
      state.done = true;
      if (state.pollTimer) clearTimeout(state.pollTimer);
      if (state.hardTimer) clearTimeout(state.hardTimer);
      cleanup(winId, tabId);
    }
    state.resolve = (data) => { finish(); resolve(data); };
    state.reject = (err) => { finish(); reject(err); };

    state.hardTimer = setTimeout(() => {
      if (!state.done) state.reject(new Error("timeout"));
    }, HARD_TIMEOUT_MS);

    pendingProbes.set(tabId, state);

    // Start petli NIE czeka tylko na zdarzenie "complete" (ktore dla okna poza
    // ekranem bywa zawodne). Odpalamy ja po krotkiej chwili — petla i tak sama
    // ponawia odczyt, dopoki cena sie nie pojawi.
    setTimeout(() => {
      if (!state.polling && !state.done) {
        state.polling = true;
        pollForPrice(state, Date.now());
      }
    }, 2500);
  });
}

async function cleanup(winId, tabId) {
  if (tabId != null) pendingProbes.delete(tabId);
  try { await chrome.windows.remove(winId); } catch (e) {}
  await disableMobileRuleIfIdle();
}

async function disableMobileRuleIfIdle() {
  if (pendingProbes.size === 0) {
    try { await disableMobileRule(); } catch (e) {}
  }
}

function spoofNavigatorUA(ua) {
  try {
    Object.defineProperty(navigator, "userAgent", { get: () => ua, configurable: true });
    Object.defineProperty(navigator, "platform", { get: () => "Linux armv8l", configurable: true });
    Object.defineProperty(navigator, "maxTouchPoints", { get: () => 5, configurable: true });
  } catch (e) {}
}

// ============================================================================
//  detectMobileOffer — JEDYNE zadanie sondy: sprawdzic, czy na stronie jest
//  oferta oznaczona jako "tylko dla urzadzen mobilnych".
//
//  Celowo NIE czytamy cen, pojemnosci, rabatow — to bylo zbyt kruche i Booking
//  latwo to psul. Sprawdzamy jeden, stabilny fakt: obecnosc plakietki, ktora
//  uzytkownik realnie widzi. Szukamy po tekscie (PL+EN) i po aria-label.
// ============================================================================
function detectMobileOffer() {
  // Zamknij banner zgody (gdyby zaslanial tresc).
  try {
    const consentSel = [
      "#onetrust-accept-btn-handler",
      "[id*='accept'][id*='cookie']",
      "button[aria-label*='Akcept']",
      "button[aria-label*='Accept']"
    ];
    for (const s of consentSel) {
      const b = document.querySelector(s);
      if (b) { b.click(); break; }
    }
  } catch (e) {}

  // Wzorce tekstu plakietki (PL + EN, rozne warianty).
  const patterns = [
    /cena tylko dla urz\u0105dze\u0144 mobilnych/i,
    /tylko dla urz\u0105dze\u0144 mobilnych/i,
    /mobile[-\s]?only price/i,
    /mobile[-\s]?only rate/i,
    /mobile[-\s]?only deal/i,
    /cena mobilna/i // dodatkowy wariant, jaki Booking bywa uzywa
  ];

  function matchesAny(text) {
    if (!text) return false;
    for (const re of patterns) if (re.test(text)) return true;
    return false;
  }

  // 1) Najpewniej: dedykowana plakietka badge.
  const badges = document.querySelectorAll(
    ".bui-badge, .bui-badge__text, [class*='badge'], [data-bui-component='Badge']"
  );
  for (const b of badges) {
    if (matchesAny(b.textContent) || matchesAny(b.getAttribute && b.getAttribute("aria-label"))) {
      return { mobileOffer: true, via: "badge", ua: navigator.userAgent };
    }
  }

  // 2) Dowolny element z aria-label pasujacym do wzorca.
  const labeled = document.querySelectorAll("[aria-label]");
  for (const el of labeled) {
    if (matchesAny(el.getAttribute("aria-label"))) {
      return { mobileOffer: true, via: "aria", ua: navigator.userAgent };
    }
  }

  // 3) Ostatecznosc: szukaj frazy w widocznym tekscie strony.
  //    (Ograniczamy do rozsadnej dlugosci, zeby nie skanowac w nieskonczonosc.)
  const bodyText = (document.body && document.body.innerText) ? document.body.innerText : "";
  if (matchesAny(bodyText)) {
    return { mobileOffer: true, via: "text", ua: navigator.userAgent };
  }

  // Sprawdzmy tez, czy strona w ogole sie zaladowala z oferta (sa ceny/pokoje),
  // zeby odroznic "brak oferty mobilnej" od "strona jeszcze sie laduje".
  const hasContent =
    document.querySelectorAll("tr[data-block-id], [data-testid='room-card'], [data-room-id], span.prco-valign-middle-helper").length > 0;

  return { mobileOffer: false, loaded: hasContent, ua: navigator.userAgent };
}
async function pollForPrice(state, startedAt) {
  if (state.done) return;
  state.pollCount = (state.pollCount || 0) + 1;
  let result = null;
  let lastErr = "";
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: detectMobileOffer,
      world: "MAIN"
    });
    result = r && r[0] && r[0].result;
  } catch (e) {
    lastErr = e && e.message ? e.message : String(e);
    // strona moze jeszcze nie byc gotowa do wstrzykniecia — sprobujemy znow
  }
  state.lastPollErr = lastErr;

  if (result) {
    // Wykryto oferte mobilna -> sukces od razu.
    if (result.mobileOffer === true) {
      try {
        console.warn("[Cena mobilna] OK: oferta mobilna ZNALEZIONA (via " +
          (result.via || "?") + "), proby=" + state.pollCount);
      } catch (e) {}
      state.resolve({ mobileOffer: true, via: result.via });
      return;
    }
    // Brak oferty, ale strona ZALADOWANA (sa pokoje/ceny) -> pewna odpowiedz "nie ma".
    if (result.loaded === true) {
      try {
        console.warn("[Cena mobilna] OK: brak oferty mobilnej (strona zaladowana), proby=" + state.pollCount);
      } catch (e) {}
      state.resolve({ mobileOffer: false });
      return;
    }
    // result.loaded === false -> strona jeszcze sie laduje, ponawiamy ponizej.
  }

  if (Date.now() - startedAt >= POLL_DEADLINE_MS) {
    // Deadline: jezeli ostatni odczyt mowil "brak oferty" (choc loaded=false),
    // bezpieczniej zwrocic "nie ma" niz blad — ale logujemy do diagnostyki.
    try {
      console.warn("[Cena mobilna] deadline: proby=" + state.pollCount +
        (lastErr ? (", inject-err=" + lastErr) : "") +
        ", ostatni=" + JSON.stringify(result || null));
    } catch (e) {}
    if (result && result.mobileOffer === false) {
      state.resolve({ mobileOffer: false });
    } else {
      state.reject(new Error("not-loaded"));
    }
    return;
  }
  state.pollTimer = setTimeout(() => pollForPrice(state, startedAt), POLL_MS);
}

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  const state = pendingProbes.get(tabId);
  if (!state) return;

  // Spoof UA najwczesniej jak sie da.
  if (changeInfo.status === "loading" && tab.url && tab.url.includes("bmpprobe=1")) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId }, func: spoofNavigatorUA, args: [MOBILE_UA],
        world: "MAIN", injectImmediately: true
      });
    } catch (e) {}
  }

  // Po zaladowaniu startujemy PETLE odpytywania (raz).
  if (changeInfo.status === "complete" && !state.polling && !state.done) {
    state.polling = true;
    pollForPrice(state, Date.now());
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === "CHECK_MOBILE_PRICE") {
    probeMobilePrice(msg.url)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
});
