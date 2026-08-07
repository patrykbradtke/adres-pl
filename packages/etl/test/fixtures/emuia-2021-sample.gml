<?xml version="1.0" encoding="UTF-8"?>
<gml:FeatureCollection
  xmlns:ad="ewidencjaMiejscowosciUlicIAdresow:1.0"
  xmlns:gml="http://www.opengis.net/gml/3.2"
  xmlns:xlink="http://www.w3.org/1999/xlink"
  gml:id="fc">
  <gml:featureMember>
    <ad:AD_Miejscowosc gml:id="AD_M_0918123">
      <ad:idIIP>
        <ad:AD_IdentyfikatorIIP>
          <ad:lokalnyId>M-0918123</ad:lokalnyId>
          <ad:przestrzenNazw>PL.PZGIK.200</ad:przestrzenNazw>
          <ad:wersjaId>2026-03-14T10:00:00</ad:wersjaId>
        </ad:AD_IdentyfikatorIIP>
      </ad:idIIP>
      <ad:poczatekWersjiObiektu>2026-03-14T10:00:00</ad:poczatekWersjiObiektu>
      <ad:nazwa>WARSZAWA</ad:nazwa>
      <ad:rodzaj>miasto</ad:rodzaj>
      <ad:identyfikatorSIMC>0918123</ad:identyfikatorSIMC>
      <ad:identyfikatorPRNG>0123456</ad:identyfikatorPRNG>
      <ad:TERYTGminy>1465011</ad:TERYTGminy>
      <ad:georeferencja>
        <gml:Point srsName="urn:ogc:def:crs:EPSG::2180"><gml:pos>486000 637000</gml:pos></gml:Point>
      </ad:georeferencja>
    </ad:AD_Miejscowosc>
  </gml:featureMember>
  <gml:featureMember>
    <ad:AD_UlicaPlac gml:id="AD_U_19357">
      <ad:idIIP><ad:AD_IdentyfikatorIIP><ad:lokalnyId>U-19357</ad:lokalnyId><ad:wersjaId>2026-03-14T10:00:00</ad:wersjaId></ad:AD_IdentyfikatorIIP></ad:idIIP>
      <ad:nazwaPelna>Tadeusza Kosciuszki</ad:nazwaPelna>
      <ad:rodzaj>ulica</ad:rodzaj>
      <ad:TERYTNazwa1>Kosciuszki</ad:TERYTNazwa1>
      <ad:TERYTNazwa2>Tadeusza</ad:TERYTNazwa2>
      <ad:identyfikatorULIC>19357</ad:identyfikatorULIC>
      <ad:ulica1 xlink:href="#AD_M_0918123"/>
      <ad:geometria>
        <gml:LineString srsName="urn:ogc:def:crs:EPSG::2180"><gml:posList>486000 637000 486100 637100</gml:posList></gml:LineString>
      </ad:geometria>
    </ad:AD_UlicaPlac>
  </gml:featureMember>
  <gml:featureMember>
    <ad:AD_PunktAdresowy gml:id="AD_PA_000001">
      <ad:idIIP><ad:AD_IdentyfikatorIIP><ad:lokalnyId>PA-000001</ad:lokalnyId><ad:wersjaId>2026-03-14T10:00:00</ad:wersjaId></ad:AD_IdentyfikatorIIP></ad:idIIP>
      <ad:poczatekWersjiObiektu>2026-03-14T10:00:00</ad:poczatekWersjiObiektu>
      <ad:numerPorzadkowy>12A</ad:numerPorzadkowy>
      <ad:kodPocztowy>00-950</ad:kodPocztowy>
      <ad:dataNadania>2015-06-01</ad:dataNadania>
      <ad:miejsce xlink:href="#AD_M_0918123"/>
      <ad:ulica2 xlink:href="#AD_U_19357"/>
      <ad:georeferencja>
        <gml:Point srsName="urn:ogc:def:crs:EPSG::2180"><gml:pos>486987.65 637123.45</gml:pos></gml:Point>
      </ad:georeferencja>
    </ad:AD_PunktAdresowy>
  </gml:featureMember>
</gml:FeatureCollection>
