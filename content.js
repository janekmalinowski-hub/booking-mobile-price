// ============================================================================
//  content.js — dziala na stronie hotelu booking.com (karta uzytkownika)
//
//  Odczytuje najtansza cene desktopowa z tabeli ofert (wraz z jej
//  data-block-id), prosi service worker o sprawdzenie ceny mobilnej dla
//  TEJ SAMEJ oferty i pokazuje porownanie w pływającym panelu.
// ============================================================================

(function () {
  "use strict";

  if (location.search.includes("bmpprobe=1")) return; // to karta-sonda
  if (window.__bmpInjected) return;
  window.__bmpInjected = true;

  const PANEL_ID = "bmp-panel";

  // -------------------------------------------------------------------------
  //  Odczyt najtanszej oferty z tabeli: zwraca { price, blockId }.
  //  Ta sama logika co w sondzie — czytamy ceny ze spanow
  //  prco-valign-middle-helper, ignorujac rabaty i ceny przekreslone.
  // -------------------------------------------------------------------------
  var MIN_PLN = 300;

  function toAmount(text) {
    if (!text) return null;
    const m = text.replace(/\u00a0/g, " ").match(/(\d[\d  .]*)\s*(z[\u0142l]|PLN)?/);
    if (!m) return null;
    const d = m[1].replace(/[^\d]/g, "");
    if (!d) return null;
    const n = parseInt(d, 10);
    return n >= MIN_PLN ? n : null;
  }

  // Pomijamy ceny przekreslone i plakietki rabatu.
  function isExcluded(el) {
    let node = el;
    for (let i = 0; i < 4 && node; i++) {
      const c = (node.className || "").toString();
      if (/strikethrough|bui-badge|sr-only|bui-u-sr-only/i.test(c)) return true;
      node = node.parentElement;
    }
    return false;
  }

  // Najnizsza realna cena oferty na stronie. Zwraca { price } albo null.
  function readDesktopOffer() {
    const spans = Array.from(
      document.querySelectorAll(
        "span.prco-valign-middle-helper, [data-testid='price-and-discounted-price']"
      )
    );
    let best = null;
    for (const el of spans) {
      if (isExcluded(el)) continue;
      const a = toAmount(el.textContent);
      if (a != null && (best === null || a < best)) best = a;
    }
    if (best != null) return { price: best, blockId: null };
    return null;
  }

  function fmt(n) {
    return n.toLocaleString("pl-PL") + " zł";
  }

  // -------------------------------------------------------------------------
  //  Panel.
  // -------------------------------------------------------------------------
  function buildPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) existing.remove();

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.className = "bmp-panel bmp-state-idle";
    panel.innerHTML = `
      <div class="bmp-head">
        <div class="bmp-dot"></div>
        <div class="bmp-title">Cena mobilna</div>
        <button class="bmp-close" title="Zamknij" aria-label="Zamknij">×</button>
      </div>
      <div class="bmp-body">
        <button class="bmp-check">Sprawdź cenę dla telefonu</button>
        <div class="bmp-hint">Otworzymy tę ofertę w tle jako telefon i porównamy.</div>
      </div>
    `;
    document.body.appendChild(panel);
    panel.querySelector(".bmp-close").addEventListener("click", () => panel.remove());
    panel.querySelector(".bmp-check").addEventListener("click", runCheck);
    return panel;
  }

  function setLoading(panel) {
    panel.className = "bmp-panel bmp-state-loading";
    panel.querySelector(".bmp-body").innerHTML = `
      <div class="bmp-spinner"></div>
      <div class="bmp-loading-text">Sprawdzam cenę mobilną…</div>
      <div class="bmp-hint">To trwa kilka sekund — otwieram ofertę jako telefon.</div>
    `;
  }

  function setResult(panel, desktop, mobileData) {
    const mobile = mobileData.price;
    const diff = desktop - mobile;
    const pct = desktop > 0 ? Math.round((diff / desktop) * 100) : 0;
    const cheaper = diff > 0;
    const same = Math.abs(diff) < 1;

    panel.className =
      "bmp-panel " + (same ? "bmp-state-same" : cheaper ? "bmp-state-win" : "bmp-state-lose");

    let verdict;
    if (same) {
      verdict = `<div class="bmp-verdict">Ta sama cena na telefonie.</div>`;
    } else if (cheaper) {
      verdict = `
        <div class="bmp-verdict">Na telefonie taniej o <strong>${fmt(diff)}</strong> (${pct}%)</div>
        ${mobileData.mobileLabel ? '<div class="bmp-badge-mobile">Oferta „tylko dla urządzeń mobilnych"</div>' : ""}
      `;
    } else {
      verdict = `<div class="bmp-verdict">Na telefonie drożej o ${fmt(-diff)}.</div>`;
    }

    // Etykieta telefonu i komunikat zaleza od tego, czy sonda byla zalogowana.
    // loggedIn: true = ceny z Genius; false = bez Genius; null = niejednoznaczne.
    let mobileLabelText, footnote;
    if (mobileData.loggedIn === true) {
      mobileLabelText = "Telefon (z Twoim Genius)";
      footnote = "To Twoja realna cena na telefonie po zalogowaniu — z rabatem Genius.";
    } else if (mobileData.loggedIn === false) {
      mobileLabelText = "Telefon (bez logowania)";
      footnote = "Cena mobilna bez logowania. Po zalogowaniu na telefonie Genius może zejść jeszcze niżej.";
    } else {
      mobileLabelText = "Telefon";
      footnote = "Cena mobilna z tej samej oferty. Logowanie i Genius mogą jeszcze zmienić kwotę.";
    }

    panel.querySelector(".bmp-body").innerHTML = `
      <div class="bmp-rows">
        <div class="bmp-row">
          <span class="bmp-label">Ten ekran (desktop)</span>
          <span class="bmp-price">${fmt(desktop)}</span>
        </div>
        <div class="bmp-row bmp-row-mobile">
          <span class="bmp-label">${mobileLabelText}</span>
          <span class="bmp-price">${fmt(mobile)}</span>
        </div>
      </div>
      ${verdict}
      <button class="bmp-recheck">Sprawdź ponownie</button>
      <div class="bmp-disclaimer">${footnote}</div>
    `;
    panel.querySelector(".bmp-recheck").addEventListener("click", runCheck);
  }

  function setError(panel, message) {
    panel.className = "bmp-panel bmp-state-error";
    panel.querySelector(".bmp-body").innerHTML = `
      <div class="bmp-error-text">${message}</div>
      <button class="bmp-recheck">Spróbuj ponownie</button>
    `;
    panel.querySelector(".bmp-recheck").addEventListener("click", runCheck);
  }

  // -------------------------------------------------------------------------
  //  Przeplyw.
  // -------------------------------------------------------------------------
  function runCheck() {
    const panel = document.getElementById(PANEL_ID) || buildPanel();
    const desktop = readDesktopOffer();

    if (!desktop) {
      setError(panel, "Nie udało się odczytać ceny na tej stronie. Otwórz konkretną ofertę z datami.");
      return;
    }
    setLoading(panel);

    chrome.runtime.sendMessage(
      { type: "CHECK_MOBILE_PRICE", url: location.href, targetBlockId: desktop.blockId },
      (resp) => {
        const p = document.getElementById(PANEL_ID);
        if (!p) return;
        if (chrome.runtime.lastError) {
          setError(p, "Błąd komunikacji z rozszerzeniem. Odśwież stronę.");
          return;
        }
        if (!resp || !resp.ok) {
          const err = resp && resp.error ? resp.error : "";
          let reason;
          if (err.indexOf("price-not-found") === 0) {
            reason = "Nie udało się odczytać ceny mobilnej. Spróbuj ponownie za chwilę.";
          } else if (err === "timeout") {
            reason = "Sprawdzanie trwało zbyt długo. Spróbuj ponownie.";
          } else if (err === "no-tab-in-window" || err.indexOf("window-create-failed") === 0) {
            reason = "Nie udało się otworzyć okna w tle. Spróbuj ponownie.";
          } else {
            reason = "Nie udało się sprawdzić ceny mobilnej. Spróbuj ponownie.";
          }
          setError(p, reason);
          return;
        }
        setResult(p, desktop.price, resp.data);
      }
    );
  }

  function init() {
    if (readDesktopOffer()) {
      buildPanel();
    } else {
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        if (readDesktopOffer()) {
          clearInterval(iv);
          buildPanel();
        } else if (tries > 10) {
          clearInterval(iv);
        }
      }, 1000);
    }
  }

  if (document.readyState === "complete" || document.readyState === "interactive") {
    init();
  } else {
    window.addEventListener("DOMContentLoaded", init);
  }
})();
