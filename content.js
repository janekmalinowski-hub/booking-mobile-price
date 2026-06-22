// ============================================================================
//  content.js — panel "Cena mobilna" na stronie hotelu booking.com
//
//  PROSTA WERSJA: nie czytamy zadnych cen. Pytamy sonde (okno w tle udajace
//  telefon) o jeden fakt — czy jest oferta "tylko dla urzadzen mobilnych".
//   - jest  -> zielone kolko + "W aplikacji mobilnej jest tansza oferta"
//   - nie ma -> szare kolko + "Oferta mobilna niedostepna"
//
//  Jezeli to karta-sonda (URL z bmpprobe=1) — nic nie robimy.
// ============================================================================

(function () {
  "use strict";

  if (location.search.includes("bmpprobe=1")) return; // to karta-sonda
  if (window.__bmpInjected) return;
  window.__bmpInjected = true;

  const PANEL_ID = "bmp-panel";

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
        <button class="bmp-check">Sprawdź ofertę mobilną</button>
        <div class="bmp-hint">Sprawdzimy w tle, czy ten obiekt ma ofertę tylko dla telefonów.</div>
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
      <div class="bmp-loading-text">Sprawdzam…</div>
      <div class="bmp-hint">To trwa kilka sekund — otwieram ofertę jako telefon.</div>
    `;
  }

  // Wynik: jest oferta mobilna albo nie.
  function setResult(panel, hasMobileOffer) {
    if (hasMobileOffer) {
      panel.className = "bmp-panel bmp-state-win";
      panel.querySelector(".bmp-body").innerHTML = `
        <div class="bmp-result">
          <div class="bmp-big-dot bmp-big-dot-green"></div>
          <div class="bmp-result-text">
            <strong>W aplikacji mobilnej jest tańsza oferta</strong>
            <span>Ten obiekt ma cenę „tylko dla urządzeń mobilnych". Otwórz go w aplikacji Booking lub w przeglądarce na telefonie, żeby ją zobaczyć.</span>
          </div>
        </div>
        <button class="bmp-recheck">Sprawdź ponownie</button>
      `;
    } else {
      panel.className = "bmp-panel bmp-state-same";
      panel.querySelector(".bmp-body").innerHTML = `
        <div class="bmp-result">
          <div class="bmp-big-dot bmp-big-dot-grey"></div>
          <div class="bmp-result-text">
            <strong>Oferta mobilna niedostępna</strong>
            <span>Dla tego obiektu i terminu nie znaleźliśmy ceny tylko dla urządzeń mobilnych.</span>
          </div>
        </div>
        <button class="bmp-recheck">Sprawdź ponownie</button>
      `;
    }
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
  //  Przeplyw: popros sonde o sprawdzenie oferty mobilnej.
  // -------------------------------------------------------------------------
  function runCheck() {
    const panel = document.getElementById(PANEL_ID) || buildPanel();
    setLoading(panel);

    chrome.runtime.sendMessage(
      { type: "CHECK_MOBILE_PRICE", url: location.href },
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
          if (err === "timeout" || err === "not-loaded") {
            reason = "Nie udało się wczytać oferty w tle. Spróbuj ponownie za chwilę.";
          } else if (err === "no-tab-in-window" || err.indexOf("window-create-failed") === 0) {
            reason = "Nie udało się otworzyć okna w tle. Spróbuj ponownie.";
          } else {
            reason = "Nie udało się sprawdzić oferty mobilnej. Spróbuj ponownie.";
          }
          setError(p, reason);
          return;
        }
        setResult(p, resp.data && resp.data.mobileOffer === true);
      }
    );
  }

  // -------------------------------------------------------------------------
  //  Start: pokaz panel, gdy strona oferty jest gotowa.
  // -------------------------------------------------------------------------
  function pageHasOffers() {
    return document.querySelectorAll(
      "tr[data-block-id], [data-testid='room-card'], [data-room-id], span.prco-valign-middle-helper"
    ).length > 0;
  }

  function init() {
    if (pageHasOffers()) {
      buildPanel();
    } else {
      let tries = 0;
      const iv = setInterval(() => {
        tries++;
        if (pageHasOffers()) {
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
