/**
 * iMPA / Geo-System - jedyne realnie niezalezne zrodlo zapasowe.
 *
 * DLACZEGO WLASNIE TO ZRODLO:
 * Overture Maps, OpenAddresses i w duzej czesci OpenStreetMap dla Polski
 * pobieraja dane z tego samego pliku PRG. To nie sa zrodla niezalezne,
 * tylko trzy pamieci podreczne jednego zrodla - gdy PRG zniknie, zamroza
 * sie na ostatniej pobranej wersji.
 *
 * iMPA to system, w ktorym okolo 1400 gmin FAKTYCZNIE PROWADZI ewidencje
 * adresowa. Jest wiec zrodlem ZASILAJACYM rejestr PRG, a nie jego kopia.
 * Prowadzi go podmiot komercyjny, wiec profil ryzyka jest inny niz po
 * stronie administracji - i o to chodzi w dywersyfikacji.
 *
 * STAN WIEDZY
 *  - `danepubliczne.punktyadresowe.pl` udostepnia `Polska.zip` (GML, ~918 MB)
 *    oraz `adruni.zip` (~100 MB) w strukturze "adresu uniwersalnego",
 *    znacznie wygodniejszej do importu
 *  - dokladny uklad kolumn `adruni` NIE jest publicznie udokumentowany
 *  - licencja NIE jest jasno okreslona i wymaga pisemnego potwierdzenia
 *    od Geo-System przed wykorzystaniem komercyjnym
 *
 * Dlatego profil ponizej zawiera SZEROKI zestaw kandydujacych nazw kolumn,
 * a przy pierwszym uruchomieniu nalezy uzyc trybu rozpoznawania:
 *
 *     npm run etl -- impa discover <plik.csv>
 */
import type { TabularProfile } from './tabular.ts';

export const IMPA_BASE = 'https://danepubliczne.punktyadresowe.pl/';

/**
 * Profil "adresu uniwersalnego" iMPA.
 *
 * Kandydujace nazwy kolumn zebrane z konwencji spotykanych w polskich
 * zbiorach adresowych (EMUiA, eksporty gminne, SHP). Lista jest celowo
 * szeroka - nadmiarowy kandydat nic nie kosztuje, brakujacy oznacza
 * ciche zgubienie kolumny.
 *
 * WSZYSTKIE POZYCJE SA HIPOTEZAMI do potwierdzenia trybem rozpoznawania.
 */
export const IMPA_ADRUNI: TabularProfile = {
  name: 'impa-adruni',
  defaultSrid: 2180,
  columns: {
    id:            ['ID', 'IDENTYFIKATOR', 'GML_ID', 'LOKALNYID', 'IDPUNKTU', 'ID_PUNKTU'],
    simc:          ['SIMC', 'IDTERYT', 'TERYT_SIMC', 'ID_SIMC', 'SYM', 'IDENTYFIKATORSIMC'],
    miejscowosc:   ['MIEJSCOWOSC', 'MIEJSC', 'NAZWA_MIEJSCOWOSCI', 'CITY', 'MIASTO'],
    czescMiejscowosci: ['CZESCMIEJSCOWOSCI', 'CZESC_MIEJSC', 'CZESCMIEJSC'],
    symUl:         ['SYMUL', 'SYM_UL', 'ULIC', 'TERYT_ULIC', 'IDENTYFIKATORULIC', 'ID_ULICY'],
    cecha:         ['CECHA', 'TYP_ULICY', 'RODZAJ', 'PRZEDROSTEK', 'TYP'],
    ulica:         ['ULICA', 'NAZWA_ULICY', 'STREET', 'NAZWAULICY', 'NAZWA_UL'],
    nrBudynku:     ['NUMER', 'NR', 'NUMERPORZADKOWY', 'NR_PORZADKOWY', 'HOUSENUMBER', 'NR_DOMU', 'NRDOMU'],
    nrLokalu:      ['NRLOKALU', 'NR_LOKALU', 'LOKAL', 'MIESZKANIE'],
    kodPocztowy:   ['KODPOCZTOWY', 'KOD_POCZTOWY', 'KOD', 'PNA', 'POSTCODE', 'KODPOCZ'],
    terc:          ['TERC', 'TERYT_TERC', 'IDGMINY', 'ID_GMINY', 'TERYTGMINY'],
    gmina:         ['GMINA', 'NAZWA_GMINY'],
    powiat:        ['POWIAT', 'NAZWA_POWIATU'],
    wojewodztwo:   ['WOJEWODZTWO', 'WOJ', 'NAZWA_WOJEWODZTWA'],
    x:             ['X', 'WSP_X', 'EASTING', 'X_1992', 'WSPX'],
    y:             ['Y', 'WSP_Y', 'NORTHING', 'Y_1992', 'WSPY'],
    lat:           ['LAT', 'SZEROKOSC', 'LATITUDE', 'B'],
    lon:           ['LON', 'LNG', 'DLUGOSC', 'LONGITUDE', 'L'],
    srid:          ['SRID', 'EPSG', 'UKLAD'],
    status:        ['STATUS', 'STATUSBUDYNKU', 'STAN'],
    dataAktualizacji: ['DATAAKTUALIZACJI', 'DATA_AKTUALIZACJI', 'DATA', 'WERSJA', 'DATAMODYFIKACJI'],
  },
};

/**
 * Reguly precedencji przy uzgadnianiu iMPA z PRG.
 *
 * PRG jest rejestrem panstwowym i domyslnie wygrywa. Ale iMPA jest
 * systemem ZRODLOWYM dla znaczacej czesci gmin, wiec bywa swiezsze.
 * Stad wyjatek: jesli iMPA ma punkt, ktorego PRG nie ma, przyjmujemy go -
 * z wyraznym oznaczeniem zrodla, zeby dalo sie to pozniej rozliczyc.
 */
export const IMPA_PRECEDENCE = {
  /** Punkt obecny w obu zrodlach: wygrywa PRG. */
  wObu: 'prg' as const,
  /** Punkt tylko w iMPA: przyjmujemy, ale oznaczamy zrodlo. */
  tylkoImpa: 'przyjmij-oznacz' as const,
  /** Punkt tylko w PRG: zostaje bez zmian. */
  tylkoPrg: 'zostaw' as const,
  /**
   * Geometria: zawsze z PRG, gdy dostepna.
   * iMPA bywa w ukladach lokalnych PL-2000, co zwieksza ryzyko bledu
   * przy przeliczaniu.
   */
  geometria: 'prg' as const,
};

/**
 * Ile punktow z iMPA moze byc nieobecnych w PRG, zanim uznamy to za
 * anomalie wymagajaca weryfikacji, a nie za realna luke w rejestrze.
 *
 * iMPA deklaruje ~6,3 mln punktow wobec 8,56 mln w PRG, wiec iMPA jest
 * PODZBIOREM pod wzgledem zasiegu (obejmuje ~1400 z 2477 gmin).
 * Punktow obecnych wylacznie w iMPA powinno byc niewiele - jesli nagle
 * jest ich duzo, najprawdopodobniej rozjechalo sie dopasowanie kluczy,
 * a nie rejestr panstwowy przestal nadazac.
 */
export const IMPA_MAX_ONLY_FRAC = 0.05;

export function impaUrl(plik = 'adruni.zip'): string {
  return IMPA_BASE + plik;
}
