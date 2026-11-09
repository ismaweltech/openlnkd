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
  // Only a fallback: searches resolve the location live through LocationsService.
  // Verified 2026-11 against LinkedIn's location filter. These are the metro geos
  // ("Madrid y alrededores"): people search ignores city geos, jobs take both.
  // The previous city IDs were stale — "madrid" (103435383) was a London postcode.
  madrid: '90009790',
  barcelona: '90009761',
  sevilla: '90009810',
  seville: '90009810',
  'sevilla y alrededores': '90009810',
  valencia: '90009816',
  bilbao: '90009763',
  málaga: '90009791',
  malaga: '90009791',
  zaragoza: '90009822',
  'palma de mallorca': '90009799',
  palma: '90009799',
  'las palmas': '105284277', // city: no metro geo
  'las palmas de gran canaria': '105284277',
  'san sebastián': '90009806',
  donostia: '90009806',
  murcia: '90009795',
  'la coruña': '90009753',
  'a coruña': '90009753',
  coruna: '90009753',
  valladolid: '90009817',
  granada: '90009778',
  vigo: '90009818',
  córdoba: '90009770',
  cordoba: '90009770',
  alicante: '101734461', // city: no metro geo
  oviedo: '90009797',
  tenerife: '90009807',
  'santa cruz de tenerife': '90009807',
  santander: '90009808',
  pamplona: '90009800',
  logroño: '90009788',
  logro: '90009788',
  albacete: '90009754',
  burgos: '90009764',
  salamanca: '90009805',
  toledo: '101598293', // city: "Toledo y alrededores" is Ohio
  huelva: '90009781',
  badajoz: '90009760',
  cáceres: '90009765',
  caceres: '90009765',
  lleida: '90009787',
  lérida: '90009787',
  tarragona: '90009812',
  girona: '90009777',
  gerona: '90009777',
  castellón: '90009768',
  castellon: '90009768',
  'san cugat': '100861588', // city: no metro geo
  'sant cugat': '100861588',
  reus: '90009803',
  jerez: '90009784',
  'jerez de la frontera': '90009784',
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
