# Cena mobilna na Booking

Rozszerzenie do Chrome, ktore na stronie hotelu w Booking.com sprawdza, czy
dany obiekt ma ofertę dostępną **tylko dla urządzeń mobilnych** (taką, której
nie widać na komputerze).

**Autor:** Jan Malinowski

## Jak dziala

1. Wchodzisz na ofertę hotelu na booking.com (na komputerze).
2. W rogu pojawia się panel "Cena mobilna" — klikasz "Sprawdź ofertę mobilną".
3. Rozszerzenie otwiera tę samą ofertę w niewidocznym oknie w tle, udając
   telefon, i sprawdza, czy jest tam plakietka "Cena tylko dla urządzeń
   mobilnych".
4. Wynik:
   - **Zielone kółko** → obiekt ma tańszą ofertę dostępną tylko na telefonie.
     Otwórz go w aplikacji Booking lub w przeglądarce na telefonie.
   - **Szare kółko** → dla tego obiektu i terminu nie ma oferty mobilnej.

Rozszerzenie **nie pokazuje konkretnych cen** ani nie liczy oszczędności —
sprawdza tylko, czy oferta mobilna istnieje. To celowe: takie proste sprawdzenie
jest znacznie odporniejsze na zmiany układu strony Booking.com.

## Instalacja (tryb deweloperski — sideload)

1. Pobierz i rozpakuj folder `booking-mobile-price` na dysk.
2. W Chrome wejdź na `chrome://extensions`.
3. Włącz przełącznik **„Tryb dewelopera"** (prawy górny róg).
4. Kliknij **„Wczytaj rozpakowane"** i wskaż folder `booking-mobile-price`.
5. Gotowe — wejdź na dowolną ofertę hotelu na booking.com.

## Jesli przestanie dzialac

Rozszerzenie szuka na stronie tekstu "Cena tylko dla urządzeń mobilnych"
(lub "Mobile-only price"). Gdyby Booking zmienił to sformułowanie, wykrywanie
może przestać działać — wtedy trzeba zaktualizować wzorce w `background.js`
(funkcja `detectMobileOffer`). Diagnostyka jest w `chrome://extensions` →
"Szczegóły" → "Sprawdź widoki: service worker" → Console.

## Pliki

- `manifest.json` — definicja rozszerzenia (Manifest V3)
- `background.js` — service worker: okno w tle + wykrycie plakietki mobilnej
- `content.js` — panel widoczny na stronie
- `content.css` — wygląd panelu
- `icons/` — ikony
