// ── Shop-floor Gujarati and Hindi, word by word ────────────────────────────
//
// The card and the material slip carry every instruction in three languages.
// Letter-by-letter transliteration is not good enough for that: "Nut" comes out
// as નઉત / नउत, which is not a word anyone reads. So this is a dictionary of
// the words that actually appear on these documents — seeded from the curated
// translations of the original inventory items and extended with the fixture
// vocabulary — and an unknown word is left in English rather than garbled.
//
// One entry per word, both scripts together, so the two can never drift apart.

const WORDS = {
  // ── parts ────────────────────────────────────────────────────────────────
  terminal: ['ટર્મિનલ', 'टर्मिनल'], pin: ['પિન', 'पिन'], pins: ['પિન', 'पिन'],
  nut: ['નટ', 'नट'], nuts: ['નટ', 'नट'], washer: ['વોશર', 'वॉशर'], washers: ['વોશર', 'वॉशर'],
  bolt: ['બોલ્ટ', 'बोल्ट'], bolts: ['બોલ્ટ', 'बोल्ट'], screw: ['સ્ક્રૂ', 'स्क्रू'], screws: ['સ્ક્રૂ', 'स्क्रू'],
  stud: ['સ્ટડ', 'स्टड'], studs: ['સ્ટડ', 'स्टड'], ceramic: ['સિરામિક', 'सिरेमिक'],
  bush: ['બુશ', 'बुश'], bushes: ['બુશ', 'बुश'], tube: ['ટ્યુબ', 'ट्यूब'], pipe: ['પાઇપ', 'पाइप'],
  nipple: ['નિપલ', 'निप्पल'], flange: ['ફ્લેંજ', 'फ्लैंज'], ring: ['રિંગ', 'रिंग'], rings: ['રિંગ', 'रिंग'],
  gasket: ['ગાસ્કેટ', 'गैसकेट'], bracket: ['બ્રેકેટ', 'ब्रैकेट'], clamp: ['ક્લેમ્પ', 'क्लैंप'],
  clamps: ['ક્લેમ્પ્સ', 'क्लैंप'], clip: ['ક્લિપ', 'क्लिप'], clips: ['ક્લિપ', 'क्लिप'],
  hook: ['હૂક', 'हुक'], collar: ['કોલર', 'कॉलर'], sleeve: ['સ્લીવ', 'स्लीव'], cap: ['કેપ', 'कैप'],
  caps: ['કેપ', 'कैप'], plate: ['પ્લેટ', 'प्लेट'], sheet: ['શીટ', 'शीट'], strip: ['સ્ટ્રીપ', 'स्ट्रिप'],
  band: ['બેન્ડ', 'बैंड'], patti: ['પટ્ટી', 'पट्टी'], rod: ['રોડ', 'रॉड'], lug: ['લગ', 'लग'],
  lugs: ['લગ્સ', 'लग्स'], cable: ['કેબલ', 'केबल'], connector: ['કનેક્ટર', 'कनेक्टर'],
  sensor: ['સેન્સર', 'सेंसर'], thermostat: ['થર્મોસ્ટેટ', 'थर्मोस्टेट'], wire: ['વાયર', 'वायर'],
  wires: ['વાયર', 'वायर'], coil: ['કોઈલ', 'कॉइल'], spring: ['સ્પ્રિંગ', 'स्प्रिंग'],
  fins: ['ફિન્સ', 'फिन्स'], finns: ['ફિન્સ', 'फिन्स'], fin: ['ફિન', 'फिन'], element: ['એલિમેન્ટ', 'एलिमेंट'],
  elements: ['એલિમેન્ટ', 'एलिमेंट'], heater: ['હીટર', 'हीटर'], heaters: ['હીટર', 'हीटर'],
  motor: ['મોટર', 'मोटर'], wheel: ['વ્હીલ', 'व्हील'], blade: ['બ્લેડ', 'ब्लेड'],
  drill: ['ડ્રિલ', 'ड्रिल'], chakti: ['ચકતી', 'चकती'], support: ['સપોર્ટ', 'सपोर्ट'],
  spare: ['સ્પેર', 'स्पेयर'], set: ['સેટ', 'सेट'], fixture: ['ફિક્સ્ચર', 'फिक्सचर'],
  fixtures: ['ફિક્સ્ચર', 'फिक्सचर'],

  // ── materials ────────────────────────────────────────────────────────────
  steel: ['સ્ટીલ', 'स्टील'], stainless: ['સ્ટેનલેસ', 'स्टेनलेस'], mild: ['માઈલ્ડ', 'माइल्ड'],
  copper: ['કોપર', 'कॉपर'], brass: ['બ્રાસ', 'ब्रास'], incoloy: ['ઇન્કોલોય', 'इनकोलॉय'],
  nickel: ['નિકલ', 'निकल'], silver: ['સિલ્વર', 'सिल्वर'], fecral: ['ફેક્રાલ', 'फेक्राल'],
  kanthal: ['કંથાલ', 'कंथाल'], glass: ['ગ્લાસ', 'ग्लास'], fiber: ['ફાઇબર', 'फाइबर'],
  fibre: ['ફાઇબર', 'फाइबर'], teflon: ['ટેફલોન', 'टेफ्लॉन'], plastic: ['પ્લાસ્ટિક', 'प्लास्टिक'],
  silicone: ['સિલિકોન', 'सिलिकॉन'], mgo: ['એમજીઓ', 'एमजीओ'], powder: ['પાવડર', 'पाउडर'],
  oil: ['ઓઈલ', 'ऑयल'], liquid: ['લિક્વિડ', 'लिक्विड'], flux: ['ફ્લક્સ', 'फ्लक्स'],
  sealant: ['સીલંટ', 'सीलेंट'], chemical: ['કેમિકલ', 'केमिकल'], paper: ['પેપર', 'पेपर'],
  tape: ['ટેપ', 'टेप'],

  // ── process and form ─────────────────────────────────────────────────────
  brazing: ['બ્રેઝિંગ', 'ब्रेजिंग'], sealing: ['સીલિંગ', 'सीलिंग'], filling: ['ફિલિંગ', 'फिलिंग'],
  plated: ['પ્લેટેડ', 'प्लेटेड'], crimped: ['ક્રિમ્પ્ડ', 'क्रिम्प्ड'], tinned: ['ટીન્ડ', 'टिन्ड'],
  cleaning: ['ક્લીનિંગ', 'क्लीनिंग'], packing: ['પેકિંગ', 'पैकिंग'], fixing: ['ફિક્સિંગ', 'फिक्सिंग'],
  defrost: ['ડિફ્રોસ્ટ', 'डिफ्रॉस्ट'], dishwasher: ['ડિશવોશર', 'डिशवॉशर'],
  resistance: ['રેઝિસ્ટન્સ', 'रेजिस्टेंस'], thread: ['થ્રેડ', 'थ्रेड'], gauge: ['ગેજ', 'गेज'],
  guage: ['ગેજ', 'गेज'], thickness: ['જાડાઈ', 'मोटाई'], seamless: ['સીમલેસ', 'सीमलेस'],
  bend: ['બેન્ડ', 'बेंड'], roll: ['રોલ', 'रोल'], bag: ['બેગ', 'बैग'], box: ['બોક્સ', 'बॉक्स'],

  // ── shape, size, position ────────────────────────────────────────────────
  hole: ['કાણું', 'छेद'], holes: ['કાણા', 'छेद'], round: ['ગોળ', 'गोल'],
  square: ['ચોરસ', 'चौकोर'], oval: ['ઓવલ', 'ओवल'], flat: ['ફ્લેટ', 'फ्लैट'],
  angle: ['એંગલ', 'एंगल'], straight: ['સ્ટ્રેટ', 'स्ट्रेट'], plain: ['પ્લેન', 'प्लेन'],
  head: ['હેડ', 'हेड'], end: ['એન્ડ', 'एंड'], post: ['પોસ્ટ', 'पोस्ट'], top: ['ટોપ', 'टॉप'],
  bottom: ['બોટમ', 'बॉटम'], mid: ['મિડ', 'मिड'], centre: ['વચ્ચે', 'बीच'], center: ['વચ્ચે', 'बीच'],
  side: ['બાજુ', 'तरफ'], sides: ['બાજુ', 'तरफ'], both: ['બંને', 'दोनों'],
  full: ['ફુલ', 'फुल'], half: ['અડધું', 'आधा'], short: ['શોર્ટ', 'शॉर्ट'], long: ['લાંબા', 'लंबा'],
  small: ['નાની', 'छोटा'], large: ['મોટી', 'बड़ा'], big: ['મોટો', 'बड़ा'],
  heavy: ['હેવી', 'हेवी'], double: ['ડબલ', 'डबल'], single: ['સિંગલ', 'सिंगल'],
  open: ['ઓપન', 'ओपन'], hex: ['હેક્સ', 'हेक्स'], type: ['ટાઈપ', 'टाइप'],

  // ── counts and joiners, which is most of a fixture line ──────────────────
  one: ['એક', 'एक'], two: ['બે', 'दो'], three: ['ત્રણ', 'तीन'], four: ['ચાર', 'चार'],
  five: ['પાંચ', 'पांच'], six: ['છ', 'छह'], eight: ['આઠ', 'आठ'], ten: ['દસ', 'दस'],
  and: ['અને', 'और'], with: ['સાથે', 'साथ'], without: ['વગર', 'बिना'], per: ['પ્રતિ', 'प्रति'],
  each: ['દરેક', 'प्रत्येक'], no: ['નહીં', 'नहीं'], none: ['કોઈ નહીં', 'कोई नहीं'],
  inch: ['ઇંચ', 'इंच'], inches: ['ઇંચ', 'इंच'],

  // ── colours ──────────────────────────────────────────────────────────────
  red: ['લાલ', 'लाल'], green: ['લીલી', 'हरा'], white: ['સફેદ', 'सफेद'],
  black: ['કાળું', 'काला'], blue: ['વાદળી', 'नीला'],

  // ── names ────────────────────────────────────────────────────────────────
  dubai: ['દુબઈ', 'दुबई'], peacock: ['પીકોક', 'पीकॉक'], new: ['નવું', 'नया'], old: ['જૂનું', 'पुराना'],
};

// Script-specific renderings of the code shapes that run through these strings.
const FORMS = {
  gu: { withHead: 'હેડ સાથે', withoutHead: 'હેડ વગર', m: 'એમ', ss: 'એસએસ', ms: 'એમએસ', mm: 'મીમી', kg: 'કિલો' },
  hi: { withHead: 'हेड के साथ', withoutHead: 'हेड के बिना', m: 'एम', ss: 'एसएस', ms: 'एमएस', mm: 'मिमी', kg: 'किलो' },
};

function translateToken(token, lang) {
  if (!token) return token;
  // Peel leading/trailing punctuation so "(Nipple" / "Red," still match
  const m = token.match(/^([("'[]*)(.*?)([)"',\].]*)$/);
  const [, lead, core, trail] = m;
  if (!core) return token;

  const f = FORMS[lang];
  const lower = core.toLowerCase();

  if (['w/h', 'wh'].includes(lower)) return `${lead}${f.withHead}${trail}`;
  if (['w/o', 'w/0', 'wo', 'w/oh'].includes(lower)) return `${lead}${f.withoutHead}${trail}`;

  // Codes: M4 → એમ4 / एम4, SS/MS (+grade), 8mm → 8 મીમી / 8 मिमी
  let cm = lower.match(/^m(\d+)$/);
  if (cm) return `${lead}${f.m}${cm[1]}${trail}`;
  cm = lower.match(/^ss(\d*)$/);
  if (cm) return `${lead}${f.ss}${cm[1]}${trail}`;
  cm = lower.match(/^ms(\d*)$/);
  if (cm) return `${lead}${f.ms}${cm[1]}${trail}`;
  cm = lower.match(/^(\d+(?:\.\d+)?)mm$/);
  if (cm) return `${lead}${cm[1]} ${f.mm}${trail}`;
  if (lower === 'mm') return `${lead}${f.mm}${trail}`;
  if (lower === 'kg' || lower === 'kgs') return `${lead}${f.kg}${trail}`;

  // Pure numbers / sizes / ratios (3", 1/2, 0.6, 80:20, 12.76) stay as-is
  if (/^[\d./:x"'-]+$/i.test(core)) return token;

  const hit = WORDS[lower];
  if (hit) return `${lead}${lang === 'gu' ? hit[0] : hit[1]}${trail}`;

  // Compounds joined by / or -: "Clamps/Mid", "U-clamp", "Nut-Washer". Split,
  // translate what is known, and keep the separator — otherwise the whole
  // compound falls through untranslated because of one character.
  if (/[/-]/.test(core)) {
    const parts = core.split(/([/-])/);
    if (parts.some(pt => WORDS[pt.toLowerCase()])) {
      const out = parts.map(pt => {
        const w = WORDS[pt.toLowerCase()];
        return w ? (lang === 'gu' ? w[0] : w[1]) : pt;
      }).join('');
      return `${lead}${out}${trail}`;
    }
  }

  // Unknown word: keep the English. Readable English beats a garbled
  // letter-mapping on a document someone has to work from.
  return token;
}

function translate(name, lang) {
  if (!name) return '';
  let text = String(name).trim();
  if (!text) return '';
  // Normalise "with head" / "without head" before tokenising, so the pair is
  // rendered in the target language's order rather than word for word.
  text = text.replace(/with\s+head/gi, 'W/H').replace(/without\s+head/gi, 'W/O');
  return text.split(/\s+/).map(t => translateToken(t, lang)).join(' ');
}

const toGujarati = (name) => translate(name, 'gu');
const toHindi = (name) => translate(name, 'hi');

// True when the result actually says something different from the input —
// an all-English line back from the dictionary is not worth printing twice.
const isTranslated = (src, out) => !!out && out !== String(src || '').trim();

module.exports = { toGujarati, toHindi, translate, isTranslated, WORDS };
