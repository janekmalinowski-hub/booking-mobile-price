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
async function probeMobilePrice(rawUrl, targetBlockId) {
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
      targetBlockId: targetBlockId || null,
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

// Wykonywane w stronie: zamyka banner cookies i odczytuje najnizsza cene.
// MOBILNA wersja Bookinga nie ma tabeli tr[data-block-id] — ceny siedza w
// span.prco-valign-middle-helper. Plakietki "X zl taniej" (bui-badge__text) i
// ceny przekreslone (js-strikethrough-price) IGNORUJEMY.
function readPriceFromPage(targetBlockId) {
  const MIN_PLN = 300;

  // Zamknij banner zgody (rozne warianty selektorow).
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

  function toAmount(text) {
    if (!text) return null;
    const m = text.replace(/\u00a0/g, " ").match(/(\d[\d  .]*)\s*(z[\u0142l]|PLN)?/);
    if (!m) return null;
    const d = m[1].replace(/[^\d]/g, "");
    if (!d) return null;
    const n = parseInt(d, 10);
    return n >= MIN_PLN ? n : null;
  }

  // Czy element jest cena przekreslona / plakietka rabatu? Jesli tak — pomijamy.
  function isExcluded(el) {
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      const c = (node.className || "").toString();
      if (/strikethrough|bui-badge|sr-only|bui-u-sr-only/i.test(c)) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Wykrycie, czy sonda jest ZALOGOWANA (czy ceny zawieraja juz Genius).
  // Sygnaly negatywne (niezalogowany): zacheta "Zaloguj sie, aby sprawdzic
  // znizke Genius". Sygnaly pozytywne (zalogowany): zastosowany rabat Genius.
  function detectLoggedIn() {
    const txt = (document.body.innerText || "");
    // Negatywny: strona prosi o zalogowanie dla Genius.
    const promptsLogin = /Zaloguj si\u0119, aby sprawdzi\u0107|aby sprawdzi\u0107, czy obowi\u0105zuj|aby zobaczy\u0107 ceny Genius/i.test(txt);
    // Pozytywny: rabat Genius juz zastosowany do ceny.
    const geniusApplied = /Zastosowano\s+\d+%\s+zni\u017cki Genius|zni\u017cki Genius w odniesieniu/i.test(txt);
    if (geniusApplied && !promptsLogin) return true;
    if (promptsLogin) return false;
    // Niejednoznaczne — zwroc null (panel pokaze ostrozny komunikat).
    return null;
  }

  const loggedIn = detectLoggedIn();

  // 1) Glowne zrodlo: span.prco-valign-middle-helper (realna cena oferty).
  const priceSpans = Array.from(
    document.querySelectorAll(
      "span.prco-valign-middle-helper, [data-testid='price-and-discounted-price']"
    )
  );

  let best = null;
  const seen = [];
  for (const el of priceSpans) {
    if (isExcluded(el)) continue;
    const a = toAmount(el.textContent);
    if (a != null) {
      seen.push(a);
      if (best === null || a < best) best = a;
    }
  }

  if (best != null) {
    return {
      price: best,
      blockId: null,
      matched: false,
      loggedIn: loggedIn,
      mobileLabel: /tylko dla urz/i.test(document.body.innerText),
      allPrices: seen,
      ua: navigator.userAgent
    };
  }

  // --- DIAGNOSTYKA: nadal nic. Zbierz, co widac na stronie. ---
  const diag = {
    rows: document.querySelectorAll("tr[data-block-id]").length,
    spans: priceSpans.length,
    isMobileUA: /Mobile|Android/i.test(navigator.userAgent)
  };
  const moneyEls = [];
  try {
    const all = document.querySelectorAll("*");
    for (let i = 0; i < all.length && moneyEls.length < 12; i++) {
      const el = all[i];
      if (el.children.length === 0) {
        const t = (el.textContent || "").replace(/\u00a0/g, " ").trim();
        if (/\d[\d  .]*\s*(z[\u0142l]|PLN)/i.test(t) && t.length < 40) {
          moneyEls.push({
            cls: (el.className || "").toString().slice(0, 60),
            tag: el.tagName,
            txt: t.slice(0, 30)
          });
        }
      }
    }
  } catch (e) {}
  diag.money = moneyEls;
  diag.captcha = /captcha|jeste\u015b robotem|unusual traffic|px-captcha/i.test(
    document.body.innerText.slice(0, 2000)
  );
  diag.title = (document.title || "").slice(0, 60);

  return { price: null, blockId: null, matched: false, ua: navigator.userAgent, diag: diag };
}

// ---------------------------------------------------------------------------
//  Petla odpytywania: wola readPriceFromPage co POLL_MS az do skutku/deadline.
// ---------------------------------------------------------------------------
async function pollForPrice(state, startedAt) {
  if (state.done) return;
  state.pollCount = (state.pollCount || 0) + 1;
  let result = null;
  let lastErr = "";
  try {
    const r = await chrome.scripting.executeScript({
      target: { tabId: state.tabId },
      func: readPriceFromPage,
      args: [state.targetBlockId],
      world: "MAIN"
    });
    result = r && r[0] && r[0].result;
    if (result && result.diag) state.lastDiag = result.diag;
  } catch (e) {
    lastErr = e && e.message ? e.message : String(e);
    // strona moze jeszcze nie byc gotowa do wstrzykniecia — sprobujemy znow
  }
  state.lastPollErr = lastErr;

  if (result && result.price) { state.resolve(result); return; }

  if (Date.now() - startedAt >= POLL_DEADLINE_MS) {
    // Pelna diagnostyka -> konsola rozszerzenia (chrome://extensions -> bledy).
    // Do uzytkownika trafia tylko czysty kod bledu (content.js pokaze ludzki tekst).
    let diag = "proby=" + state.pollCount + (lastErr ? (", inject-err=" + lastErr) : "");
    if (state.lastDiag) {
      const d = state.lastDiag;
      diag += " | wierszy=" + d.rows + ", spans=" + d.spans + ", mobUA=" + d.isMobileUA + ", captcha=" + d.captcha;
      diag += ", tytul='" + (d.title || "") + "'";
      if (d.money && d.money.length) {
        diag += " | kwoty: " + d.money.map((m) => m.txt + "(" + m.tag + "." + m.cls + ")").join(" ; ");
      } else {
        diag += " | brak kwot na stronie";
      }
    }
    try { console.warn("[Cena mobilna] price-not-found:", diag); } catch (e) {}
    state.reject(new Error("price-not-found"));
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
    probeMobilePrice(msg.url, msg.targetBlockId)
      .then((data) => sendResponse({ ok: true, data }))
      .catch((err) => sendResponse({ ok: false, error: String(err.message || err) }));
    return true;
  }
});
