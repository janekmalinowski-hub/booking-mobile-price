# Cena mobilna na Booking

Rozszerzenie do Chrome, ktore na stronie hotelu w Booking.com sprawdza, czy ta
sama oferta ma nizsza cene "tylko dla urzadzen mobilnych", i pokazuje roznice w
malym panelu w rogu ekranu.

**Autor:** Jan Malinowski

## Jak dziala

1. Wchodzisz na ofertę hotelu na booking.com (na komputerze).
2. W rogu pojawia się panel "Cena mobilna" — klikasz "Sprawdź cenę dla telefonu".
3. Rozszerzenie otwiera tę samą ofertę w niewidocznym oknie w tle, udając telefon
   (zmienia User-Agent na Androida), odczytuje cenę mobilną i pokazuje porównanie
   z ceną z Twojego ekranu.

## Dwa tryby — zalogowany i niezalogowany

Okno w tle dziedziczy Twoją sesję z Chrome, więc:

- **Gdy jesteś zalogowany w Booking** → panel pokaże "Telefon (z Twoim Genius)" —
  to Twoja realna cena na telefonie, z rabatem Genius wliczonym.
- **Gdy jesteś wylogowany** → panel pokaże "Telefon (bez logowania)" — czystą cenę
  mobilną. Po zalogowaniu na telefonie Genius może zejść jeszcze niżej.

## Instalacja (tryb deweloperski — sideload)

1. Pobierz i rozpakuj folder `booking-mobile-price` na dysk.
2. W Chrome wejdź na `chrome://extensions`.
3. Włącz przełącznik **„Tryb dewelopera"** (prawy górny róg).
4. Kliknij **„Wczytaj rozpakowane"** i wskaż folder `booking-mobile-price`.
5. Gotowe — wejdź na dowolną ofertę hotelu na booking.com.

## Jesli przestanie dzialac (wazne)

To rozszerzenie odczytuje cenę z konkretnych elementów strony Booking.com.
Booking od czasu do czasu zmienia układ strony — gdy to zrobi, rozszerzenie może
przestać znajdować cenę i pokaże komunikat "Nie udało się odczytać ceny mobilnej".

**To nie jest awaria Twojego Chrome — to znak, że Booking zmienił stronę i kod
wymaga aktualizacji.** Napisz wtedy do autora.

Diagnostyka jest dostępna w `chrome://extensions` → przy rozszerzeniu kliknij
"Szczegóły" → "Sprawdź widoki: service worker" → zakładka Console. Pokaże tam
dokładnie, jakie ceny i elementy widzi na stronie — to pomaga szybko naprawić
selektory.

## Ograniczenia i zastrzezenia

- Cena pokazana w panelu to cena najtańszej dostępnej oferty w danym terminie.
- Sprawdzanie trwa kilka sekund (okno musi się załadować w tle).
- Narzędzie jest do użytku własnego / wąskiego grona zaufanych osób. Automatyczne
  pobieranie cen bywa niezgodne z regulaminem Booking.com — używasz na własną
  odpowiedzialność.

## Pliki

- `manifest.json` — definicja rozszerzenia (Manifest V3)
- `background.js` — service worker: podmiana User-Agent + okno w tle + odczyt ceny
- `content.js` — panel widoczny na stronie + odczyt ceny desktopowej
- `content.css` — wygląd panelu
- `icons/` — ikony
