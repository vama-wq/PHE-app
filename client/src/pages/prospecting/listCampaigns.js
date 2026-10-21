// List-level campaigns: one email + one WhatsApp per touch, per list. The copy follows the
// application (and, when one is picked, the region) on screen, so one Zoho upload plus the
// matching CSV export reaches a whole slice. Emails merge the company through Zoho's
// $[FNAME|…]$ (the CSV export puts the company in First Name); per-contact renders
// (the row modal / WhatsApp button) fill the company in directly.

const SITE = 'https://www.peenaheatelements.com';
const CAT = 'https://drive.google.com/file/d/11BAdVPcRV1NW3kz5E7EO55EeDu_veXU9/view';
const VIDEO = 'https://www.youtube.com/shorts/jnzHnPTTHXE';
const KK_FLYER = `${SITE}/phe-khadya-khurak-flyer.jpg`;
const KK_CARD = `${SITE}/phe-khadya-wa-invite.jpg`;
// One flyer per campaign: Khadya exhibitors, Khadya PharmaTech, Oman, Qatar, Vietnam.
const OMAN_FLYER = `${SITE}/phe-oman-flyer.jpg`;
const QATAR_FLYER = `${SITE}/phe-qatar-flyer.jpg`;
const PT_FLYER = `${SITE}/phe-pharmatech-khadya-flyer.jpg`;
const VN_FLYER = `${SITE}/phe-vietnam-flyer.jpg`;

const WHAT = 'Tubular, finned, immersion & cartridge heating elements — made to your drawing';
const WHY = ['Tested before dispatch · 6-month guarantee', '5–7 day dispatch · exported worldwide'];
const DRAWING = 'Made to your drawing — SS304 · SS316 · Incoloy 800';
// Owner's sample process: they courier an element, or email a photo of it beside a measuring tape.
const SAMPLE = 'Samples: courier us one element you use, or email a photo of it beside a measuring tape — we make it to match';
const SAMPLE_WA = ['• Courier us one element you use, or', '• Email a photo of it beside a measuring tape'];
const SIGN = `Warm regards,\nVama · Peena Heat Elements\nphe.co.in · vama@peenaheatelements.com\nCatalogue: ${CAT}`;
const SIGN_SHORT = 'Vama · Peena Heat Elements\nphe.co.in · vama@peenaheatelements.com';
const LINK_CAT = `📄 Catalogue: ${CAT}`;
const LINK_VIDEO = `🎬 How we make them: ${VIDEO}`;

const cap = s => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// Greeting-friendly company name: legal suffixes dropped.
export const shortCompany = s => String(s || '')
  .replace(/\b(pvt\.?|private|ltd\.?|limited|llp|opc|inc\.?|llc|wll)(?=[\s,.)]|$)/gi, '')
  .replace(/\s*\(\s*\)/g, '').replace(/[\s.,&-]+$/, '').replace(/\s{2,}/g, ' ').trim();

// Email: the company merges from Zoho's First Name; per-contact renders pass it in.
const coEmail = ctx => ctx.company || '$[FNAME|your company]$';
const greetEmail = ctx => `Dear team at ${coEmail(ctx)}`;
const helloWa = ctx => (ctx.company ? `Hello ${shortCompany(ctx.company)} team 🙏` : 'Hello 🙏');
const hiWa = ctx => (ctx.company ? `Hi ${shortCompany(ctx.company)} team 🙏` : 'Hi there 🙏');

// Bulleted email (owner, 19 Oct 2026): short intro → What we make / What we can supply you /
// Why Peena Heat Elements → one-line ask. bodyToHtml renders → as bullets, **x** as bold labels.
function bulletBody({ greet, intro, supply, supplyLabel = 'What we can supply you', why = [], cta, sign = SIGN }) {
  const L = [`${greet},`, ''];
  if (intro) L.push(intro, '');
  L.push('**What we make**', '→ ' + WHAT, '');
  L.push(`**${supplyLabel}**`, ...supply.map(s => '→ ' + s), '');
  L.push('**Why Peena Heat Elements**', ...WHY.map(w => '→ ' + w), ...why.map(w => '→ ' + w), '');
  if (cta) L.push(cta, '');
  L.push(sign);
  return L.join('\n');
}
// The flyer email carries only the flyer: one line, the image, a short close.
const flyerBody = ({ greet, intro, flyer, cta }) =>
  [`${greet},`, '', intro, '', `[[IMG:${flyer}]]`, '', cta, '', SIGN_SHORT].join('\n');
// WhatsApp: same structure, sized for a phone — *bold* header, • bullets, links on their own lines.
const wa = (...parts) => parts.flat().filter(p => p != null && p !== false).join('\n').replace(/\n{3,}/g, '\n\n').trim();

// ───────────────────────── Khadya Khurak 2026 ─────────────────────────
const KK = 'Khadya Khurak';
const KK_WHEN = '16–19 December';
const KK_VENUE = 'Helipad Exhibition Centre, Sector 17, Gandhinagar';
const KK_STALL = 'Stall 254, Hall 8';
const KK_HOURS = '10 AM – 6 PM';
const KK_BLOCK = [`📍 *${KK} 2026* — ${KK_STALL}`, KK_VENUE, `📅 ${KK_WHEN} · ${KK_HOURS}`];
const QUAL = ['Tubular & finned elements — for machines that heat, dry or cook', 'Cartridge heaters — for sealing jaws, moulds & dies', DRAWING];

// Exhibitors: the application is what they make; each maps to the pitch from the outreach sheet.
const EXHIBITOR_APPS = {
  'Bakery Equipment':                  { mode: 'pitch', eq: 'bakery equipment', supply: ['Oven, proofer & finned tubular elements', 'Spares: flanges, brackets'] },
  'Dairy & Food Processing Machinery': { mode: 'pitch', eq: 'dairy & food processing machinery', supply: ['Immersion, process & CIP tubular elements', 'Flanges & immersion heater spares'] },
  'Refrigeration & Cold Chain':        { mode: 'pitch', eq: 'refrigeration & cold-chain equipment', supply: ['Defrost, drain-line & door-frame tubular heaters', 'Matching spares'] },
  'Kitchen & Catering Equipment':      { mode: 'pitch', eq: 'kitchen & catering equipment', supply: ['Bain-marie, fryer, griddle & oven tubular elements', 'Spares: ESB, brackets, steatite bushes'] },
  'Packaging & Filling Machinery':     { mode: 'pitch', eq: 'packaging & filling machines', supply: ['High-density cartridge heaters for sealing jaws, FFS & filling machines', 'Ceramic spares'] },
  'Packaging Materials / Films':       { mode: 'pitch', eq: 'sealing & pouching machines', supply: ['Cartridge heater replacements for your sealing & pouching machines'] },
  'Plastics & Polymer Products':       { mode: 'pitch', eq: 'moulding & extrusion machines', supply: ['New — ceramic spares for nozzle & band heaters on moulding & extrusion machines', 'Cartridge heaters'] },
  'Appliance / HVAC Major':            { mode: 'pitch', eq: 'appliances & HVAC units', supply: ['Volume defrost & tubular elements for OEM supply'] },
  'Steam & Thermal Systems':           { mode: 'pitch', eq: 'steam & thermal systems', supply: ['Flanged immersion heaters', 'Spares: flanges, ESB, steatite bushes'] },
  'Pharma / Healthcare Equipment':     { mode: 'pitch', eq: 'pharma & healthcare equipment', supply: ['Lab oven, autoclave & stability-chamber tubular elements'] },
  'Printing & Graphics':               { mode: 'pitch', eq: 'printing & coding machines', supply: ['Cartridge heaters for coding, marking & drying units'] },
  'General Engineering / Machinery':   { mode: 'qualify', eq: 'machines', supply: QUAL },
  'Controls & Instrumentation':        { mode: 'partner', eq: 'controllers & instruments', supply: ['A bundled offer — your controllers with our heating elements', 'Exchange OEM and dealer references'] },
};
const EXHIBITOR_ALL = { mode: 'pitch', eq: 'machines', supply: ['Tubular elements for ovens, fryers, proofers, dairy & CIP lines', 'Cartridge heaters for sealing jaws, FFS & filling machines', 'New — ceramic spares for nozzle & band heaters', 'Spares: flanges, brackets, ESB, steatite bushes'] };
const where = hall => (hall ? `you in ${hall}, us at ${KK_STALL}` : `us at ${KK_STALL}`);
const visit = hall => (hall === 'Hall 8' ? "We're in the same hall — I'll drop by your stall." : hall ? `I'll drop by your stall in ${hall}.` : "I'll drop by your stall during the show.");

const kkInvite = (intro, ctaEmail, waTail, flyer = KK_FLYER) => ({
  key: 'invite', label: 'Invite + flyer', day: '26 Nov', attach: '📄 Flyer', flyer, waImage: KK_CARD,
  render: (p, ctx) => ({
    subject: `Your invite to ${KK} — ${KK_STALL}`,
    body: flyerBody({ greet: greetEmail(ctx), intro, flyer, cta: ctaEmail(ctx) }),
    whatsapp: wa(hiWa(ctx), `*${KK}* is almost here — you're invited!`, '', KK_BLOCK, '', '*Want a sample before the show?*', SAMPLE_WA, "— we'll make it to match.", '', waTail(ctx)),
  }),
});
const kkFinal = (ctaEmail, waTail, flyer = KK_FLYER) => ({
  key: 'final', label: 'See you there', day: '11 Dec', attach: '📄 Flyer (stall details)', flyer, waImage: KK_CARD,
  render: (p, ctx) => ({
    subject: `See you at ${KK} this week — ${KK_STALL}`,
    body: flyerBody({ greet: greetEmail(ctx), intro: `${KK} opens this week — ${KK_WHEN}, ${KK_VENUE} (${KK_HOURS}). Our stall details are on the flyer:`, flyer, cta: ctaEmail(ctx) }),
    whatsapp: wa(hiWa(ctx), `We're at *${KK}* this week!`, '', KK_BLOCK, '', waTail(ctx), '— Vama, Peena Heat Elements'),
  }),
});

const exhibitors = {
  name: 'Khadya Khurak 2026 · Exhibitors',
  regionLabel: 'hall',
  apps: EXHIBITOR_APPS, all: EXHIBITOR_ALL,
  touches: [
    { key: 'awareness', label: 'Awareness', day: '22 Oct', attach: '🎬 Manufacturing video', waImage: KK_CARD,
      render: (p, ctx) => {
        const hall = ctx.region;
        if (p.mode === 'qualify') return {
          subject: `Fellow exhibitor at ${KK} — do your machines heat, dry, seal or cook?`,
          body: bulletBody({ greet: greetEmail(ctx), intro: `We'll both be exhibiting at ${KK} (${KK_WHEN}, ${KK_VENUE}) — ${where(hall)}. If your machines heat, dry, seal or cook, we make the elements inside them:`,
            supply: QUAL, cta: `Do your machines use heating elements? Reply and I'll bring the right samples. ${visit(hall)}` }),
          whatsapp: wa(helloWa(ctx), `Vama from *Peena Heat Elements*, Ahmedabad — we're fellow exhibitors at *${KK}*!`, '', '*If your machines heat, dry, seal or cook:*', '• Tubular & finned elements — heating, drying, cooking', '• Cartridge heaters — sealing jaws, moulds & dies', '• Made to your drawing · tested before dispatch', '', KK_BLOCK, '', `Do your machines use heating elements? ${visit(hall)}`, '', LINK_CAT),
        };
        if (p.mode === 'partner') return {
          subject: `${KK}: a partnership idea — your ${p.eq} + our heating elements`,
          body: bulletBody({ greet: greetEmail(ctx), intro: `We'll both be exhibiting at ${KK} — ${where(hall)}. Your ${p.eq} pair naturally with what we make, so a partnership could suit us both:`,
            supplyLabel: 'How we could work together', supply: [...p.supply, "Made-to-drawing elements for your customers' machines"], cta: `Shall we meet at the show? ${visit(hall)}` }),
          whatsapp: wa(helloWa(ctx), `Vama from *Peena Heat Elements* — we're fellow exhibitors at *${KK}*!`, '', '*A partnership idea*', p.supply.map(s => '• ' + s), '', KK_BLOCK, '', `Shall we meet? ${visit(hall)}`),
        };
        return {
          subject: `Fellow exhibitor at ${KK} — heating elements for your ${p.eq}`,
          body: bulletBody({ greet: greetEmail(ctx), intro: `We'll both be exhibiting at ${KK} (${KK_WHEN}, ${KK_VENUE}) — ${where(hall)}. A quick note on what we make for your ${p.eq}:`,
            supply: [...p.supply, DRAWING], cta: `${visit(hall)} Do visit us at ${KK_STALL} too.` }),
          whatsapp: wa(helloWa(ctx), `Vama from *Peena Heat Elements*, Ahmedabad — we're fellow exhibitors at *${KK}*!`, '', '*What we make for you*', p.supply.map(s => '• ' + s), `• ${DRAWING}`, '• Tested before dispatch · 6-month guarantee', '', KK_BLOCK, '', visit(hall), '', LINK_CAT, LINK_VIDEO),
        };
      } },
    { key: 'product', label: 'Product', day: '12 Nov', attach: '🖼️ Product image (their equipment)', waImage: KK_CARD,
      render: (p, ctx) => {
        const supply = p.mode === 'qualify' ? [QUAL[0], QUAL[1]] : p.supply;
        const subject = p.mode === 'qualify' ? 'Heating elements for machines like yours'
          : p.mode === 'partner' ? `Working together — your ${p.eq} + our heating elements` : `What we can supply for your ${p.eq}`;
        return {
          subject,
          body: bulletBody({ greet: greetEmail(ctx), intro: `Here's exactly where we fit ${coEmail(ctx)}:`,
            supplyLabel: p.mode === 'partner' ? 'How we could work together' : undefined,
            supply: p.mode === 'partner' ? supply : [...supply, 'Built precisely to your drawing — tested before dispatch', SAMPLE],
            cta: `Share one drawing and we'll quote — or let's talk at ${KK} (${KK_STALL}).` }),
          whatsapp: wa(hiWa(ctx), `Here's where *Peena Heat Elements* fits you:`, '', supply.map(s => '• ' + s), '• Made to your drawing · tested before dispatch', '• 6-month guarantee · 5–7 day dispatch', '', `Let's talk at *${KK}* — ${KK_STALL}, ${KK_WHEN}.`, '', LINK_VIDEO, LINK_CAT),
        };
      } },
    kkInvite(`Three weeks to ${KK} (${KK_WHEN}, ${KK_VENUE}). Here's our flyer — everything in brief:`,
      ctx => `${visit(ctx.region)} And you're welcome at ${KK_STALL} anytime.`, ctx => visit(ctx.region)),
    kkFinal(ctx => `See you on the floor. ${visit(ctx.region)}`, ctx => `Come see our elements — ${visit(ctx.region)}`),
    { key: 'atexpo', label: "We're here", day: '16 Dec', attach: '🖼️ Product image / stall photo', waImage: KK_CARD,
      render: (p, ctx) => ({
        subject: `We're both at ${KK} — ${KK_STALL}`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `${KK} is on — we're at ${KK_STALL} (${KK_HOURS}, till 19 Dec). ${visit(ctx.region)}`,
          supply: [...p.supply, 'Our full range on display — tubular, finned, immersion, cartridge'], cta: `If it's easier, drop by ${KK_STALL} whenever you get a break.` }),
        whatsapp: wa(hiWa(ctx).replace('🙏', '🎉'), `We're live at *${KK}*!`, '', `📍 ${KK_STALL} — all four days, ${KK_HOURS}`, '', `${visit(ctx.region)} Or drop in on us whenever you get a break.`, '— Vama, Peena Heat Elements'),
      }) },
    { key: 'lastday', label: 'Last day / continue', day: '19 Dec', attach: '🖼️ Product image', waImage: KK_CARD,
      render: (p, ctx) => ({
        subject: `Last day at ${KK} — let's keep in touch`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `Today's the last day of ${KK} — if we missed each other, no worries.`,
          supply: [...p.supply.slice(0, 2), SAMPLE], cta: "Send one over and we'll make a sample for your team to test. Great to exhibit alongside you!" }),
        whatsapp: wa(hiWa(ctx), `Last day of *${KK}* today — ${KK_STALL}!`, '', '*Missed each other? No worries:*', SAMPLE_WA, "— we'll make you a sample to test.", '', 'Great exhibiting alongside you! — Vama, Peena Heat Elements'),
      }) },
  ],
  calls: (p, ctx) => {
    const co = ctx.company || 'the company', hall = ctx.region || 'their hall';
    if (p.mode === 'qualify') return [{ label: 'Call — qualify', day: '1 Dec', script:
`CALL — ${co} (qualify · fellow exhibitor)\n\n1) "Vama from Peena Heat Elements — we're both exhibiting at ${KK} (you in ${hall}, us at ${KK_STALL})."\n2) QUALIFY: "Do any of your machines heat, dry, seal or cook?"\n   → YES: "Which element types — tubular, finned, cartridge? Who supplies them?" Offer a sample (courier one, or a photo beside a measuring tape).\n   → NO: "No problem — great to connect; see you at the show."\n3) Close: best contact + "I'll drop by your stall in ${hall}."` }];
    if (p.mode === 'partner') return [{ label: 'Call — partnership', day: '14 Nov', script:
`CALL — ${co} (partnership)\n\n1) "Vama from Peena Heat Elements — we're both at ${KK}; your ${p.eq} pair naturally with our heating elements."\n2) IDEA: a bundled offer, or exchanging OEM/dealer references.\n3) Close: a time to meet at the show — your stall in ${hall} or ours at ${KK_STALL}.` }];
    const sell = p.supply.join('; ');
    return [
      { label: 'Call #1 — fellow exhibitor', day: '14 Nov', script:
`CALL #1 — ${co} (fellow exhibitor · intro)\n\n1) "Vama from Peena Heat Elements, Ahmedabad — we're both exhibiting at ${KK}: you in ${hall}, us at ${KK_STALL}. Have I caught you at an okay moment?"\n2) WHAT WE MAKE FOR THEM: ${sell} — made to drawing, tested before dispatch, 6-month guarantee.\n3) ASK: "Which heating elements go into your ${p.eq} today, and who supplies them?"\n4) SAMPLE: "If it helps, courier us one element, or email a photo of it beside a measuring tape — we'll make a sample to match before the show."\n5) Close: the right technical/purchase contact + best email/WhatsApp; "I'll come by your stall in ${hall}."` },
      { label: 'Call #2 — sample + a time', day: '1 Dec', script:
`CALL #2 — ${co} (sample + a time at the show)\n\n1) "Vama from Peena Heat Elements — ${KK} is two weeks away."\n2) THE OFFER: "Courier us one element you use, or email me a photo of it beside a measuring tape — we'll make a sample to match for your team to test."\n3) BOOK IT: "Which day can I come by your stall in ${hall} — 16, 17, 18 or 19 December?"\n4) Close: confirm the sample is in motion + the day.` },
      { label: 'Call #3 — confirm', day: '15 Dec', script:
`CALL #3 — ${co} (confirm before the show)\n\n1) "Vama from Peena Heat Elements — we open tomorrow."\n2) CONFIRM the time I'll come by ${hall}; invite them to ${KK_STALL} (${KK_HOURS}).\n3) Close: "See you on the floor."` },
    ];
  },
};

// PharmaTech Expo contacts → Khadya Khurak invite.
const PT_APPS = {
  'Fluid bed dryers & granulation': { their: 'your fluid bed dryers, granulators and process machines', elem: 'finned tubular air heaters and jacketed immersion heaters', short: 'dryer' },
  'Tablet coating & drying':        { their: 'your coating and tablet-processing machines', elem: 'finned air heaters and cartridge heaters', short: 'coating-line' },
  'Industrial & curing ovens':      { their: 'your dehumidifiers, ovens and air-handling units', elem: 'finned tubular reactivation / air heaters', short: 'air-heater' },
  'Autoclaves & sterilizers':       { their: 'your autoclaves and sterilizers', elem: 'SS316 / Incoloy immersion and tubular elements for the steam generator and chamber', short: 'immersion' },
  'Stability chambers & incubators':{ their: 'your stability chambers and incubators', elem: 'low-watt-density tubular and finned elements', short: 'chamber' },
  'Boilers & steam':                { their: 'your electric boilers and thermal systems', elem: 'flanged and screw-plug immersion heater bundles', short: 'immersion' },
};
const PT_ALL = { their: 'your pharma process equipment', elem: 'tubular, finned and immersion elements made to your drawing', short: 'heating' };
const inRegion = ctx => (ctx.region ? ` in ${ctx.region}` : '');

const pharmaTech = {
  name: 'Khadya Khurak 2026 · PharmaTech contacts',
  regionLabel: 'state',
  apps: PT_APPS, all: PT_ALL,
  touches: [
    { key: 'awareness', label: 'Awareness', day: '22 Oct', attach: '🎬 Manufacturing video', waImage: KK_CARD,
      render: (m, ctx) => ({
        subject: `Great meeting you at PharmaTech — an invite to our ${KK} stall`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `It was a pleasure meeting your team at PharmaTech Expo. A quick note on what we do — and we're exhibiting at ${KK} (${KK_WHEN}, ${KK_VENUE} · ${KK_STALL}).`,
          supply: [`For ${m.their}: ${m.elem}`, 'Materials: SS304 · SS316 · Incoloy 800', 'New parts — just send a drawing and we make it'], cta: "I'll share stall details closer to the date — do plan a visit." }),
        whatsapp: wa(helloWa(ctx), 'Vama from *Peena Heat Elements*, Ahmedabad — great meeting your team at PharmaTech!', '', '*What we make for you*', `• For ${m.their}: ${m.elem}`, `• ${DRAWING}`, '• Tested before dispatch · 6-month guarantee', '', "We're exhibiting — do visit us:", KK_BLOCK, '', LINK_CAT, LINK_VIDEO),
      }) },
    { key: 'product', label: 'Product', day: '12 Nov', attach: '🖼️ Product image (their equipment)', waImage: KK_CARD,
      render: (m, ctx) => ({
        subject: `The elements we make for ${m.their}`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `Here's exactly where we fit your team${inRegion(ctx)}:`,
          supply: [cap(m.elem), 'Built precisely to your drawing — SS304 · SS316 · Incoloy 800', SAMPLE], cta: `Share one drawing and we'll quote — or see them live at ${KK}, ${KK_STALL}.` }),
        whatsapp: wa(hiWa(ctx), `Here's where *Peena Heat Elements* fits you:`, '', `• ${cap(m.elem)}`, `• ${DRAWING}`, '• Tested before dispatch · 6-month guarantee · 5–7 day dispatch', '', `See them live at *${KK}* — ${KK_STALL}, ${KK_WHEN}.`, '', LINK_VIDEO, LINK_CAT),
      }) },
    kkInvite(`We're three weeks from ${KK} (${KK_WHEN}, ${KK_VENUE}). Here's our flyer — everything in brief:`,
      () => 'Shall I pencil you in for a stall visit?', () => 'Shall I pencil you in for a visit?', PT_FLYER),
    kkFinal(() => 'Looking forward to seeing you at the stall.', () => 'Come see our elements. See you there!', PT_FLYER),
    { key: 'atexpo', label: "We're here", day: '16 Dec', attach: '🖼️ Product image / stall photo', waImage: KK_CARD,
      render: (m, ctx) => ({
        subject: `We're at ${KK} now — ${KK_STALL}`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `${KK} is on now — find us at ${KK_STALL}, ${KK_VENUE} (${KK_HOURS}, till 19 Dec).`,
          supply: [`For ${m.their}: ${m.elem}`, 'Our full range on display — tubular, finned, immersion, cartridge', 'New parts — bring or send a drawing'], cta: "Drop by whenever you get a moment — or message me and I'll find you on the floor." }),
        whatsapp: wa(hiWa(ctx).replace('🙏', '🎉'), `We're live at *${KK}*!`, '', `📍 ${KK_STALL} — all four days, ${KK_HOURS}`, KK_VENUE, '', "Come by whenever you get a moment — or message me and I'll find you on the floor.", '— Vama, Peena Heat Elements'),
      }) },
    { key: 'lastday', label: 'Last day / continue', day: '19 Dec', attach: '🖼️ Product image', waImage: KK_CARD,
      render: (m, ctx) => ({
        subject: `Last day at ${KK} — let's keep this going`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `Today's the last day of ${KK} — if we missed each other, no worries.`,
          supply: [`For ${m.their}: ${m.elem}`, SAMPLE, 'Regular repeat orders + new parts from a drawing'], cta: "Send one over and we'll make a sample for your team to test. Thank you for following along!" }),
        whatsapp: wa(hiWa(ctx), `Last day of *${KK}* today — ${KK_STALL}!`, '', '*Missed each other? No worries:*', SAMPLE_WA, "— we'll make you a sample to test.", '', 'Thank you! — Vama, Peena Heat Elements'),
      }) },
  ],
  calls: (m, ctx) => {
    const co = ctx.company || 'the company';
    return [
      { label: 'Call #1 — invite', day: '14 Nov', script:
`CALL #1 — ${co} (invite + gauge interest)\n\n1) "Vama from Peena Heat Elements — we met at PharmaTech. Have I caught you at an okay moment?"\n2) "I've shared a bit about the heating elements we make for ${m.their} — did the catalogue and video reach you?"\n3) THE INVITE: "We're exhibiting at ${KK} — ${KK_WHEN}, ${KK_VENUE}, ${KK_STALL}. I'd really like to have you, or your technical/purchase team, visit."\n4) GAUGE: "Would a visit work for you? And is there a current element or machine where we could be useful?"\n5) TEE UP SAMPLING: "If it helps, courier us one element you use, or email a photo of it next to a measuring tape — we'll make a sample to match before the expo."\n6) Close: confirm interest + the best contact to coordinate with.` },
      { label: 'Call #2 — sample + slot', day: '1 Dec', script:
`CALL #2 — ${co} (arrange sample + book a stall slot)\n\n1) "Vama from Peena Heat Elements — ${KK} is in a couple of weeks."\n2) THE OFFER: "Courier us one ${m.short} element you use, or email me a photo of it beside a measuring tape — we'll make a sample to match for your team to test."\n3) BOOK IT: "Which day suits you to visit — 16, 17, 18 or 19 December? We're open ${KK_HOURS} at ${KK_STALL}."\n4) LOGISTICS: how they'll send it (courier / photo) / the right technical contact / the chosen day.\n5) Close: confirm the sample is in motion + the visit day.` },
      { label: 'Call #3 — confirm', day: '15 Dec', script:
`CALL #3 — ${co} (confirm the meeting)\n\n1) "Vama from Peena Heat Elements — we open tomorrow at ${KK}."\n2) CONFIRM: "Are you able to visit — which day and roughly what time? We're at ${KK_STALL}, ${KK_VENUE}, ${KK_HOURS}."\n3) REMIND THE VALUE: "I'll have our full range for ${m.their} to show you — and an update on your sample if we're making one."\n4) LOCK: get the day/time; offer to meet them at the entrance if that's easier.\n5) Close: "Looking forward — see you at the stall."` },
      { label: 'Call #4 — at the expo', day: '17 Dec', script:
`CALL #4 — ${co} (during the expo, both on the floor)\n\n1) "Vama from Peena Heat Elements — we're both at ${KK}! Are you on the floor today?"\n2) "Come by ${KK_STALL} whenever you get a break — I'll have our range for ${m.their} ready to show you."\n3) IF THEY'RE AT THEIR OWN STALL: "I can come to you instead — where are you located? Happy to walk over."\n4) LOCK A MOMENT: "What time works today or tomorrow? Even a quick hello."\n5) Close: confirm a meet-up time and place.` },
    ];
  },
};

// ───────────────────────── Gulf (Oman / Qatar) ─────────────────────────
const GULF_APPS = {
  'Catering & bakery ovens':         { their: 'your commercial kitchen and bakery equipment', elem: 'tubular oven, fryer and bain-marie elements', short: 'kitchen equipment' },
  'Industrial & curing ovens':       { their: 'your HVAC/AHU, ducting and curing equipment', elem: 'finned tubular air-heater batteries for duct and AHU reheat', short: 'air-heating units' },
  'Geysers & water heaters':         { their: 'your water heaters', elem: 'screw-plug and flanged tubular immersion elements', short: 'water heaters' },
  'Boilers & steam':                 { their: 'your boilers, process skids and heated vessels', elem: 'flanged and screw-plug immersion heater bundles', short: 'heated vessels' },
  'Furnaces & kilns':                { their: 'your furnaces, ovens and heat-treatment lines', elem: 'coil and tubular resistance elements formed to your chamber', short: 'furnaces' },
  'Plastics machinery':              { their: 'your plastics and packaging machinery', elem: 'cartridge, band and hot-runner heaters', short: 'machines' },
  'Heating elements & distribution': { their: 'the heating elements you stock and resell', elem: 'made-to-drawing tubular, cartridge, band and immersion elements at distributor pricing', short: 'product range', dist: true },
  'Dissolution & water baths':       { their: 'your process-heating and water-bath systems', elem: 'SS316 immersion and water-bath elements', short: 'systems' },
  'Autoclaves & sterilizers':        { their: 'your autoclaves and sterilizers', elem: 'SS316/Incoloy immersion and tubular elements', short: 'sterilizers' },
};
const GULF_ALL = { their: 'your equipment', elem: 'tubular, finned, immersion and cartridge elements made to your drawing', short: 'equipment' };
const uae = ctx => `UAE stock at our Sharjah distributor, Peena Trading LLC — fast delivery${ctx.region ? ` to ${ctx.region}` : ''}, low freight (Nilesh Shah: +971 55 667 4956 / +971 50 450 9956)`;
const uaeWa = ctx => `• UAE stock at Peena Trading LLC, Sharjah — fast delivery${ctx.region ? ` to ${ctx.region}` : ''}, low freight`;

const gulf = country => { const FLYER = country === 'Oman' ? OMAN_FLYER : QATAR_FLYER; return {
  name: country === 'Oman' ? 'Oman (Gulf)' : 'Qatar (Gulf)',
  regionLabel: 'city',
  apps: GULF_APPS, all: GULF_ALL,
  touches: [
    { key: 'discovery', label: 'Discovery', day: 0, attach: '🎬 Manufacturing video',
      render: (m, ctx) => ({
        subject: `Heating elements for ${m.their} — hello from Peena Heat Elements, India`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `Greetings from Peena Heat Elements, Ahmedabad, India — a heating-element partner for builders across ${ctx.region || country}.`,
          supply: [`For ${m.their}: ${m.elem}`, 'Materials: SS304 · SS316 · Incoloy 800', 'New parts — just send a drawing and we make it'], why: [uae(ctx)],
          cta: `Who looks after heating-element sourcing at ${coEmail(ctx)}? I'd be glad to send our catalogue and a quote.` }),
        whatsapp: wa(helloWa(ctx), 'Vama from *Peena Heat Elements*, Ahmedabad, India.', '', '*What we make for you*', `• For ${m.their}: ${m.elem}`, `• ${DRAWING}`, '• Tested before dispatch · 6-month guarantee', uaeWa(ctx), '', 'Who looks after heating-element sourcing on your side?', '', LINK_CAT, LINK_VIDEO),
      }) },
    { key: 'product', label: 'Product', day: 3, attach: '🖼️ Product image (their equipment)',
      render: (m, ctx) => ({
        subject: `The right element for ${m.short} — made to your drawing`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `Here's exactly where we fit ${m.their}:`,
          supply: [cap(m.elem), 'Made precisely to your drawing — in-house custom CNC bending', 'Competitive Indian pricing'], why: [uae(ctx)],
          cta: "Share one drawing or a sample element and we'll quote like-for-like — often better on lead time and price." }),
        whatsapp: wa(helloWa(ctx), 'A quick follow-up from *Peena Heat Elements*.', '', `*Where we fit your ${m.short}*`, `• ${cap(m.elem)}`, '• Made exactly to your drawing — SS316 / Incoloy 800', '• Tested before dispatch · 6-month guarantee · 5–7 day dispatch', '', "Share one drawing or a sample and we'll quote like-for-like.", '', LINK_CAT),
      }) },
    { key: 'newparts', label: 'New parts', day: 8, attach: '🖼️ Product image (new range)',
      render: (m, ctx) => ({
        subject: `New element ranges that suit ${m.short}`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `New ranges we're now making that suit ${m.their}:`, supplyLabel: 'New ranges we can supply you',
          supply: [`Longer-life, low-watt-density ${m.elem}`, 'Incoloy 800 sheaths for high-temperature or aggressive service', `Custom flanges, fittings & terminals — drops straight into your ${m.short}`], why: [uae(ctx)],
          cta: 'Want a sample or a quote on any of these?' }),
        whatsapp: wa(helloWa(ctx), `*New from Peena Heat Elements* for your ${m.short}:`, '', `• Longer-life ${m.elem}`, '• Incoloy 800 for high temperature', '• Custom flanges & terminals — drops straight in', '', 'Want a sample or a quote?', '', LINK_CAT),
      }) },
    { key: 'usp', label: 'USP + flyer', day: 12, attach: '📄 Flyer', flyer: FLYER, waImage: FLYER,
      render: (m, ctx) => ({
        subject: `Why builders across the Gulf choose Peena Heat Elements`,
        body: flyerBody({ greet: greetEmail(ctx), intro: "Here's our one-page flyer — everything we make, in brief:", flyer: FLYER,
          cta: `UAE stock via Peena Trading LLC, Sharjah — fast delivery${ctx.region ? ` to ${ctx.region}` : ''} (Nilesh Shah: +971 55 667 4956). Reply or WhatsApp if anything fits.` }),
        whatsapp: wa(helloWa(ctx), '*Why builders across the Gulf choose Peena Heat Elements*', '', '• Made to your drawing', '• Every element tested before dispatch · 6-month guarantee', '• Competitive pricing', uaeWa(ctx), '', `Sharing our one-page flyer — happy to quote a trial for your ${m.short}.`, '', '📞 Peena Trading (Nilesh Shah): +971 55 667 4956'),
      }) },
    { key: 'client', label: 'Become our client', day: 18, attach: '🖼️ Product / sample image',
      render: (m, ctx) => ({
        subject: `A trial element for ${m.short} — no risk to you`,
        body: bulletBody({ greet: greetEmail(ctx), intro: 'A simple, no-risk way to try us:', supplyLabel: 'How the trial works',
          supply: [`Send one drawing of an element you buy for ${m.their} — we make a trial piece to it`, 'Your team fits and tests it against your current supply', 'Once we start, we can hold your regular elements in stock in Sharjah'], why: [uae(ctx)],
          cta: `If it performs, we become your supplier — if not, you've lost nothing. Best email or WhatsApp for your ${m.dist ? 'purchase' : 'technical/purchase'} team?` }),
        whatsapp: wa(helloWa(ctx), '*A no-risk trial from Peena Heat Elements*', '', `• Send one drawing of an element you buy for your ${m.short}`, '• We make a trial piece to it', '• Your team tests it against your current supply', '', "If it performs, we're your supplier — if not, no loss. Shall I set it up?", '', LINK_CAT),
      }) },
  ],
  calls: (m, ctx) => {
    const co = ctx.company || 'the company';
    return [
      { label: 'Call #1 — intro', day: '4–5', script:
`CALL #1 — ${co} (after Discovery + Product emails)\n\n1) "Hello, this is Vama from Peena Heat Elements in India — have I caught you at an okay moment?"\n2) "We manufacture heating elements — tubular, finned, immersion, cartridge — all made to drawing, tested before dispatch, 6-month guarantee. We supply builders and distributors across the Gulf."\n3) "For ${m.their}, our ${m.elem} usually fit really well. I sent a note and our catalogue — did it reach the right person?"\n4) ASK: "Who looks after heating-element sourcing for your ${m.short} — purchase or technical? I'd love to send them a quote against one of your drawings."\n5) LISTEN: what elements do they use now, who supplies them, lead-time/price pain, volumes.\n6) Close: "May I take the best email/WhatsApp so I can send a like-for-like quote?"` },
      { label: 'Call #2 — sample offer', day: '13–14', script:
`CALL #2 — ${co} (after New-parts + USP emails)\n\n1) Warm reopen: "Vama from Peena Heat Elements again — thanks for your time last week."\n2) "If you share one drawing of an element you use in your ${m.short}, we'll make a sample to it — your team tests it against your current one, no obligation."\n3) Reinforce USP: made to drawing, tested before dispatch, 6-month guarantee — and our Sharjah (UAE) distributor Peena Trading LLC holds stock, so lower freight and faster delivery${ctx.region ? ` to ${ctx.region}` : ''}.\n4) Handle price/lead-time: "That's exactly where we tend to win — share a current price and we'll show you like-for-like."\n5) ASK: "Can you send me one drawing today, or shall I call your technical person directly?"\n6) Close: confirm next step + the drawing.` },
      { label: 'Call #3 — close', day: '21', script:
`CALL #3 — ${co} (after Become-our-client email)\n\n1) "Vama from Peena Heat Elements — I'll keep this short."\n2) The ask: "Send one drawing, we make a trial element to it, your team tests it in your ${m.short}. If it performs, we become your supplier."\n3) Make it easy: "We hold stock at our Sharjah distributor, Peena Trading LLC — so once we start, your lead times get shorter and your freight lower."\n4) Get commitment: "Shall we do the trial? Who should I coordinate the drawing and delivery with?"\n5) Lock: confirm contact + email/WhatsApp + expected drawing.` },
    ];
  },
}; };

// ───────────────────────── Vietnam ─────────────────────────
// Wording per application kept from the original researched copy.
const VN_APPS = {
  'Autoclaves & sterilizers':        { their: 'your autoclaves and sterilizers', elem: 'SS316 / Incoloy immersion and tubular elements for the steam generator and chamber' },
  'Boilers & steam':                 { their: 'your electric boilers and thermal systems', elem: 'flanged and screw-plug immersion heater bundles' },
  'Catering & bakery ovens':         { their: 'your commercial kitchen and bakery equipment', elem: 'tubular oven, fryer and bain-marie elements' },
  'Dissolution & water baths':       { their: 'your water-bath and process-heating systems', elem: 'SS316 immersion and water-bath elements' },
  'Fluid bed dryers & granulation':  { their: 'your drying and granulation machines', elem: 'finned tubular air heaters for the inlet and immersion heaters for jacketed sections' },
  'Furnaces & kilns':                { their: 'your furnaces and kilns', elem: 'coil and tubular resistance elements formed to your chamber' },
  'Geysers & water heaters':         { their: 'your water heaters', elem: 'screw-plug and tubular immersion elements' },
  'Heating elements & distribution': { their: 'your heating-element range', elem: 'made-to-drawing tubular, cartridge and band elements you can stock or resell' },
  'Industrial & curing ovens':       { their: 'your ovens, dryers and curing lines', elem: 'finned tubular air heaters that drop straight into your duct or oven airflow' },
  'Plastics machinery':              { their: 'your plastics and packaging machinery', elem: 'cartridge, band and hot-runner heaters for your barrels, sealing bars and moulds' },
  'Incubators & lab ovens':          { their: 'your lab ovens and incubators', elem: 'low-watt-density finned and tubular elements' },
  'Stability chambers & incubators': { their: 'your stability chambers and incubators', elem: 'low-watt-density tubular and finned elements' },
};
const VN_ALL = { their: 'the equipment you build', elem: 'tubular, finned, immersion and cartridge elements made to your drawing' };

const vietnam = {
  name: 'Vietnam',
  regionLabel: 'province',
  apps: VN_APPS, all: VN_ALL,
  touches: [
    { key: 'intro', label: 'Intro', day: 0, attach: '🎬 Manufacturing video',
      render: (m, ctx) => ({
        subject: `Heating elements for ${m.their} — hello from Peena Heat Elements, India`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `Greetings from Peena Heat Elements, Ahmedabad, India — we supply equipment builders across India, the Gulf, Africa, Australia and beyond, and we'd love to support builders in ${ctx.region || 'Vietnam'}.`,
          supply: [`For ${m.their}: ${m.elem}`, 'Materials: SS304 · SS316 · Incoloy 800', 'New parts — just send a drawing and we make it'],
          cta: `Who looks after heating-element sourcing at ${coEmail(ctx)}? I'd be glad to send our catalogue and a quote.` }),
        whatsapp: wa(helloWa(ctx), 'Vama from *Peena Heat Elements*, Ahmedabad, India.', '', '*What we make for you*', `• For ${m.their}: ${m.elem}`, `• ${DRAWING}`, '• Tested before dispatch · 6-month guarantee · 5–7 day dispatch', '', 'Who looks after heating-element sourcing on your side? Happy to send a quote.', '', LINK_CAT, LINK_VIDEO),
      }) },
    { key: 'flyer', label: 'Product flyer', day: 5, attach: '📄 Flyer', flyer: VN_FLYER, waImage: VN_FLYER,
      render: (m, ctx) => ({
        subject: 'Our range at a glance — Peena Heat Elements',
        body: flyerBody({ greet: greetEmail(ctx), intro: `Here's our one-page flyer — the elements we make for builders in ${ctx.region || 'Vietnam'}:`, flyer: VN_FLYER,
          cta: "Reply or WhatsApp if anything fits — or send us a drawing and we'll quote." }),
        whatsapp: wa(helloWa(ctx), 'Sharing our one-page flyer from *Peena Heat Elements* 👆', '', `• For ${m.their}: ${m.elem}`, `• ${DRAWING}`, '• Tested before dispatch · 6-month guarantee', '', "Send us a drawing and we'll quote.", '', LINK_CAT),
      }) },
  ],
  calls: (m, ctx) => [{ label: 'Call — intro', day: '3–5', script:
`CALL TALKING POINTS — ${ctx.company || 'the company'}${ctx.region ? ` (${ctx.region})` : ''}\n\n1) Warm open\n"Hello, this is Vama from Peena Heat Elements in India — have I caught you at an okay moment?"\n\n2) Who we are\n"We manufacture heating elements — tubular, finned, immersion and cartridge — all made to our customers' drawings, tested before dispatch, with a 6-month guarantee. We supply equipment builders across India, the Gulf and Africa."\n\n3) The fit with what you build\n"For ${m.their}, our ${m.elem} usually fit really well — in SS304, SS316 or Incoloy 800 to suit your process."\n\n4) Ask\n"Who looks after heating-element sourcing on your side? I'd love to send our catalogue and quote against one of your drawings."\n\n5) Offer\n"If it helps, share one drawing — or courier us one element, or email a photo of it beside a measuring tape — and we'll make a sample to match."\n\n6) Close\n"May I take the best email or WhatsApp to send the catalogue?"` }],
};

const CAMPAIGNS = {
  'khadya-khurak-exhibitors': exhibitors,
  'pharma-tech-expo': pharmaTech,
  'oman': gulf('Oman'),
  'qatar': gulf('Qatar'),
  'vietnam': vietnam,
};

export const campaignFor = segment => CAMPAIGNS[segment] || null;
// Which copy the application gets: its own profile, or the list-wide one.
export const tailoredTo = (campaign, app) => (app && campaign.apps[app] ? app : '');
const profileFor = (campaign, app) => (app && campaign.apps[app]) || campaign.all;

// ctx = { app, region, company } — company null for the list-wide Zoho version (merges $[FNAME]$).
export function renderTouch(campaign, index, ctx) {
  const t = campaign.touches[Math.min(index, campaign.touches.length - 1)];
  return { key: t.key, label: t.label, day: t.day, attach: t.attach, flyer: t.flyer || null, waImage: t.waImage || null,
    ...t.render(profileFor(campaign, ctx.app), ctx) };
}
export const renderCalls = (campaign, ctx) => campaign.calls(profileFor(campaign, ctx.app), ctx);
