// ── Gujarati name generation for inventory items ───────────────────────────────
// Word-level dictionary seeded from the curated translations of the original
// 214 inventory items (shopfloor Gujarati: technical terms transliterated,
// descriptors translated). Unknown words fall back to letter transliteration.
// Digits, inch marks and codes (M4, SS304 …) keep Latin digits to match the
// existing curated data.

const WORD_MAP = {
  terminal: 'ટર્મિનલ', pin: 'પિન', pins: 'પિન', plain: 'પ્લેન', head: 'હેડ',
  with: 'સાથે', without: 'વગર', filling: 'ફિલિંગ', bush: 'બુશ', tube: 'ટ્યુબ',
  thickness: 'જાડાઈ', seamless: 'સીમલેસ', incoloy: 'ઇન્કોલોય', copper: 'કોપર',
  mgo: 'એમજીઓ', powder: 'પાવડર', brass: 'બ્રાસ', nipple: 'નિપલ', nut: 'નટ',
  nuts: 'નટ', hex: 'હેક્સ', mild: 'માઈલ્ડ', steel: 'સ્ટીલ', nickel: 'નિકલ',
  plated: 'પ્લેટેડ', ring: 'રિંગ', rings: 'રિંગ', flange: 'ફ્લેંજ',
  hole: 'કાણું', holes: 'કાણા', double: 'ડબલ', stainless: 'સ્ટેનલેસ',
  gasket: 'ગાસ્કેટ', red: 'લાલ', green: 'લીલી', square: 'ચોરસ',
  brazing: 'બ્રેઝિંગ', rod: 'રોડ', liquid: 'લિક્વિડ', silver: 'સિલ્વર',
  flux: 'ફ્લક્સ', silicone: 'સિલિકોન', sealant: 'સીલંટ', sealing: 'સીલિંગ',
  oil: 'ઓઈલ', washer: 'વોશર', washers: 'વોશર', bracket: 'બ્રેકેટ', full: 'ફુલ',
  mid: 'મિડ', spring: 'સ્પ્રિંગ', gauge: 'ગેજ', guage: 'ગેજ', fecral: 'ફેક્રાલ',
  kanthal: 'કંથાલ', fins: 'ફિન્સ', fin: 'ફિન', thread: 'થ્રેડ', heavy: 'હેવી',
  set: 'સેટ', fiber: 'ફાઇબર', fibre: 'ફાઇબર', teflon: 'ટેફલોન', white: 'સફેદ',
  angle: 'એંગલ', lugs: 'લગ્સ', lug: 'લગ', centre: 'વચ્ચે', center: 'વચ્ચે',
  crimped: 'ક્રિમ્પ્ડ', open: 'ઓપન', dubai: 'દુબઈ', peacock: 'પીકોક',
  wire: 'વાયર', wires: 'વાયર', straight: 'સ્ટ્રેટ', post: 'પોસ્ટ', both: 'બંને',
  sides: 'બાજુ', side: 'બાજુ', cap: 'કેપ', caps: 'કેપ', thermostat: 'થર્મોસ્ટેટ',
  round: 'ગોળ', black: 'કાળું', patti: 'પટ્ટી', short: 'શોર્ટ', small: 'નાની',
  large: 'મોટી', big: 'મોટો', fixing: 'ફિક્સિંગ', defrost: 'ડિફ્રોસ્ટ',
  heater: 'હીટર', heaters: 'હીટર', sleeve: 'સ્લીવ', oval: 'ઓવલ',
  dishwasher: 'ડિશવોશર', element: 'એલિમેન્ટ', elements: 'એલિમેન્ટ',
  support: 'સપોર્ટ', chakti: 'ચકતી', tinned: 'ટીન્ડ', glass: 'ગ્લાસ',
  packing: 'પેકિંગ', roll: 'રોલ', plastic: 'પ્લાસ્ટિક', bag: 'બેગ',
  coil: 'કોઈલ', resistance: 'રેઝિસ્ટન્સ', sheet: 'શીટ', plate: 'પ્લેટ',
  strip: 'સ્ટ્રીપ', band: 'બેન્ડ', clamp: 'ક્લેમ્પ', clamps: 'ક્લેમ્પ્સ',
  cable: 'કેબલ', connector: 'કનેક્ટર', sensor: 'સેન્સર', spare: 'સ્પેર',
  chemical: 'કેમિકલ', cleaning: 'ક્લીનિંગ', tape: 'ટેપ', paper: 'પેપર',
  box: 'બોક્સ', screw: 'સ્ક્રૂ', screws: 'સ્ક્રૂ', bolt: 'બોલ્ટ', bolts: 'બોલ્ટ',
  pipe: 'પાઇપ', motor: 'મોટર', wheel: 'વ્હીલ', blade: 'બ્લેડ', drill: 'ડ્રિલ',
  end: 'એન્ડ', long: 'લાંબા', type: 'ટાઈપ', new: 'નવું', old: 'જૂનું',
};

function translateToken(token) {
  if (!token) return token;
  // Peel leading/trailing punctuation so "(Nipple" / "Red," still match
  const m = token.match(/^([("'\[]*)(.*?)([)"',\].]*)$/);
  const [, lead, core, trail] = m;
  if (!core) return token;

  const lower = core.toLowerCase();

  // Head shorthand
  if (['w/h', 'wh'].includes(lower)) return `${lead}હેડ સાથે${trail}`;
  if (['w/o', 'w/0', 'wo', 'w/oh'].includes(lower)) return `${lead}હેડ વગર${trail}`;
  // Codes: M4 → એમ4, SS/MS(+grade) → એસએસ304 / એમએસ
  let cm = lower.match(/^m(\d+)$/);
  if (cm) return `${lead}એમ${cm[1]}${trail}`;
  cm = lower.match(/^ss(\d*)$/);
  if (cm) return `${lead}એસએસ${cm[1]}${trail}`;
  cm = lower.match(/^ms(\d*)$/);
  if (cm) return `${lead}એમએસ${cm[1]}${trail}`;
  // 8mm → 8 મીમી
  cm = lower.match(/^(\d+(?:\.\d+)?)mm$/);
  if (cm) return `${lead}${cm[1]} મીમી${trail}`;
  if (lower === 'mm') return `${lead}મીમી${trail}`;
  if (lower === 'kg' || lower === 'kgs') return `${lead}કિલો${trail}`;
  // Pure numbers / sizes / ratios (3", 1/2, 0.6, 80:20, 12.76) stay as-is
  if (/^[\d.\/:x"'-]+$/i.test(core)) return token;

  const hit = WORD_MAP[lower];
  if (hit) return `${lead}${hit}${trail}`;
  // Unknown word: keep it as-is (readable English beats garbled letter-mapping);
  // the user can refine the Gujarati name via Edit Item.
  return token;
}

// "Terminal Pin 3\" with head" → "ટર્મિનલ પિન 3\" સાથે હેડ"-style word-by-word.
// ("with head"/"without head" get reordered to Gujarati order: હેડ સાથે)
function gujaratiName(name) {
  if (!name) return null;
  let text = String(name).trim();
  // Normalise "with head" / "without head" word order before tokenising
  text = text.replace(/with\s+head/gi, 'W/H').replace(/without\s+head/gi, 'W/O');
  return text.split(/\s+/).map(translateToken).join(' ');
}

module.exports = { gujaratiName };
