/**
 * LinkedIn geographic URN IDs for common Spanish cities and regions.
 * Used in people search (geoUrn param) and jobs search (geoId param).
 *
 * If a location is not in this map:
 *   - people search: location filter is skipped (better than showing wrong country)
 *   - jobs search: text-based location param is used as fallback
 */
export const LOCATION_URNS: Record<string, string> = {
  // ── Country ───────────────────────────────────────────────────────────────
  // Authoritative geoId from LinkedIn's own typeahead (GET /locations/typeahead?q=España).
  spain: '105646813',
  españa: '105646813',

  // ── Autonomous communities ────────────────────────────────────────────────
  // Verified 2026-10 against LinkedIn's own typeahead (GET /locations/typeahead).
  // The previous sequential IDs (100994331…) were wrong — e.g. "Andalucía" searched Madrid.
  andalucía: '106151489',
  andalucia: '106151489',
  cataluña: '100377885',
  catalunya: '100377885',
  cataluna: '100377885',
  'comunidad de madrid': '103335767',
  'comunitat valenciana': '100076887',
  'comunidad valenciana': '100076887',
  'país vasco': '104405604',
  'pais vasco': '104405604',
  euskadi: '104405604',
  galicia: '103189018',
  'castilla y león': '104802667',
  'castilla y leon': '104802667',
  'castilla-la mancha': '100096545',
  'castilla la mancha': '100096545',
  canarias: '102102005',
  'islas canarias': '102102005',
  'región de murcia': '106901295',
  'region de murcia': '106901295',
  aragón: '102312719',
  aragon: '102312719',
  extremadura: '102727695',
  'islas baleares': '101388828',
  baleares: '101388828',
  'la rioja': '102952772',
  navarra: '102688677',
  cantabria: '106413664',
  asturias: '104351060',

  // ── Major cities ──────────────────────────────────────────────────────────
  madrid: '103435383',
  barcelona: '101290685',
  // Verified 2026-08 via the jobs UI location chip (the old 106571572 resolved
  // to Ballygasty, Ireland). 102187989 = city, 90009810 = metro area.
  sevilla: '102187989',
  seville: '102187989',
  'sevilla y alrededores': '90009810',
  valencia: '101246109',
  bilbao: '106749819',
  málaga: '103740976',
  malaga: '103740976',
  zaragoza: '103353069',
  'palma de mallorca': '100395016',
  palma: '100395016',
  'las palmas': '106024447',
  'las palmas de gran canaria': '106024447',
  'san sebastián': '104311248',
  donostia: '104311248',
  murcia: '103566630',
  'la coruña': '104294895',
  'a coruña': '104294895',
  coruna: '104294895',
  valladolid: '102382982',
  granada: '104154839',
  vigo: '100877458',
  córdoba: '106834091',
  cordoba: '106834091',
  alicante: '103393428',
  oviedo: '101070313',
  tenerife: '105138015',
  'santa cruz de tenerife': '105138015',
  santander: '104765203',
  pamplona: '104311247',
  logroño: '104622563',
  logro: '104622563',
  albacete: '104064068',
  burgos: '105254095',
  salamanca: '103226082',
  toledo: '105462067',
  huelva: '103808456',
  badajoz: '103440424',
  cáceres: '104754234',
  caceres: '104754234',
  lleida: '101453491',
  tarragona: '103890671',
  girona: '101890491',
  castellón: '103611019',
  castellon: '103611019',
  'san cugat': '103826628',
  reus: '104695649',
  jerez: '104117467',
};

/**
 * Resolve a human-readable location string to a LinkedIn geoUrn ID.
 * Normalises case and strips accents for matching.
 * Returns undefined if the location is not in the map.
 */
export function resolveGeoUrn(location: string): string | undefined {
  const key = location.toLowerCase().trim();
  // Direct match
  if (LOCATION_URNS[key]) return LOCATION_URNS[key];
  // Accent-stripped match (e.g. "malaga" matches "málaga")
  const stripped = key.normalize('NFD').replace(/[̀-ͯ]/g, '');
  return LOCATION_URNS[stripped];
}
