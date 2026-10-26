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
// One flyer per campaign: Khadya exhibitors, Khadya visitors, Khadya PharmaTech, Oman, Qatar, Vietnam.
const KKV_FLYER = `${SITE}/phe-khadya-visitors-flyer.jpg`;
const EC_FLYER = `${SITE}/phe-existing-customers-flyer.jpg`;
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

// Diwali greeting (owner, 26 Oct 2026): the same card on every list, and the email and the WhatsApp carry
// ONLY the card: no greeting text, no footer (bodyToHtml leaves the footer off an image-only email).
const DIWALI_CARD = `${SITE}/phe-diwali-card.jpg`;
const DIWALI = {
  key: 'diwali', label: 'Diwali greeting', day: '5 Nov', attach: '🪔 Diwali card', flyer: DIWALI_CARD, waImage: DIWALI_CARD,
  render: () => ({
    subject: 'Happy Diwali from all of us at Peena Heat Elements',
    body: `[[IMG:${DIWALI_CARD}|Happy Diwali and Saal Mubarak from all of us at Peena Heat Elements, Ahmedabad]]`,
    whatsapp: '',
  }),
};

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
    DIWALI,
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

// Khadya Khurak visitors (owner, 23 Oct 2026): equipment makers WITHOUT a stall — invite them to ours.
// Entry is free through our own invite page on the organiser's site (it credits PHE as the host).
const KK_PASS = 'https://khadhyakhurak.com/registration/peena_heat_elements_llp';
const PASS_LINE = `🎟️ Free entry — register as our guest: ${KK_PASS}`;
const KK_DAYS = 'Wednesday 16, Thursday 17, Friday 18 or Saturday 19 December';

const visitorsKK = {
  name: 'Khadya Khurak 2026 · Visitors to invite',
  regionLabel: 'area',
  apps: EXHIBITOR_APPS, all: EXHIBITOR_ALL,
  touches: [
    { key: 'invite', label: 'Invite', day: '27 Oct', attach: '🎟️ Free-entry link', waImage: KK_CARD,
      render: (p, ctx) => ({
        subject: `You're invited — Peena Heat Elements at ${KK} 2026, ${KK_STALL}`,
        body: bulletBody({ greet: greetEmail(ctx),
          intro: `We're exhibiting at ${KK} 2026 (${KK_WHEN}, ${KK_VENUE}, ${KK_HOURS}) and we'd love the team behind your ${p.eq} to visit us at ${KK_STALL}. Entry is free when you register as our guest: ${KK_PASS}`,
          supplyLabel: "What we'll show you", supply: [...p.supply, DRAWING],
          cta: `Which day suits you — ${KK_DAYS}? Reply and we'll keep time for you at the stall.` }),
        whatsapp: wa(helloWa(ctx), `Vama from *Peena Heat Elements*, Ahmedabad — you're invited to visit us at *${KK} 2026*!`, '', KK_BLOCK, '',
          "*What we'll show you*", p.supply.map(s => '• ' + s), `• ${DRAWING}`, '', PASS_LINE, '', "Which day suits you? Reply and we'll keep time for you.", '', LINK_CAT),
      }) },
    DIWALI,
    { key: 'flyer', label: 'Invitation flyer', day: '18 Nov', attach: '📄 Flyer', flyer: KKV_FLYER, waImage: KKV_FLYER,
      render: (p, ctx) => ({
        subject: `Your invitation — ${KK} 2026, ${KK_STALL}`,
        body: flyerBody({ greet: greetEmail(ctx), intro: `Four weeks to ${KK}. Here's your invitation — scan the QR on it for free entry:`, flyer: KKV_FLYER,
          cta: `Or register here: ${KK_PASS} — and tell us the day you'll come.` }),
        whatsapp: wa(helloWa(ctx), `Here's your invitation to *${KK} 2026* 👆`, '', KK_BLOCK, '', PASS_LINE, '', "Tell us the day you'll come and we'll keep time for you."),
      }) },
    { key: 'bring', label: 'Bring a drawing', day: '2 Dec', attach: '🖼️ Product image (their equipment)', waImage: KK_CARD,
      render: (p, ctx) => ({
        subject: `Bring a drawing to ${KK} — we'll go through it with you`,
        body: [`${greetEmail(ctx)},`, '', `Two weeks to ${KK}. To make your visit worth it, bring along:`, '',
          '→ Your drawing — or a photo of the element beside a measuring tape', `→ The element you use today in your ${p.eq}`, '→ Your rough yearly quantity, so we can price it properly', '',
          `We'll go through it with you at ${KK_STALL}. Can't make it? Courier us one element you use, or email a photo of it beside a measuring tape — we make it to match.`, '',
          `Free entry as our guest: ${KK_PASS}`, '', SIGN].join('\n'),
        whatsapp: wa(hiWa(ctx), `Two weeks to *${KK}*! To make your visit worth it, bring:`, '• Your drawing (or a photo of the element beside a measuring tape)',
          '• The element you use today', '• Your rough yearly quantity', '', `We'll go through it with you at *${KK_STALL}*.`, '', PASS_LINE),
      }) },
    { key: 'final', label: 'See you this week', day: '14 Dec', attach: '🎟️ Free-entry link', waImage: KK_CARD,
      render: (p, ctx) => ({
        subject: `See you at ${KK} this week — ${KK_STALL}`,
        body: [`${greetEmail(ctx)},`, '', `${KK} opens on Wednesday — we'd love to see you there.`, '',
          '**Where**', `→ ${KK_STALL} · ${KK_VENUE}`, '**When**', `→ ${KK_WHEN} · ${KK_HOURS}`, '**Entry**', `→ Free as our guest: ${KK_PASS}`, '',
          "Tell us your day and time, and we'll make sure the right person is at the stall.", '', SIGN_SHORT].join('\n'),
        whatsapp: wa(hiWa(ctx), `*${KK}* opens on Wednesday — see you there?`, '', KK_BLOCK, '', PASS_LINE, '', "Tell us your day and time and we'll be ready for you. — Vama"),
      }) },
    { key: 'atexpo', label: "We're open", day: '16 Dec', attach: '🖼️ Stall photo', waImage: KK_CARD,
      render: (p, ctx) => ({
        subject: `We're open at ${KK} — ${KK_STALL}`,
        body: [`${greetEmail(ctx)},`, '', `${KK} is on and we're at ${KK_STALL} (${KK_HOURS}, till Saturday 19 December).`, '',
          "Drop by whenever suits you — bring a drawing and we'll go through it together.", '', `Free entry as our guest: ${KK_PASS}`, '', SIGN_SHORT].join('\n'),
        whatsapp: wa(hiWa(ctx).replace('🙏', '🎉'), `We're live at *${KK}*!`, '', `📍 ${KK_STALL} — ${KK_HOURS}, till Sat 19 Dec`, '',
          "Drop by whenever suits you — bring a drawing and we'll go through it together.", '', PASS_LINE),
      }) },
    { key: 'after', label: 'After the show', day: '21 Dec', attach: '🖼️ Product image',
      render: (p, ctx) => ({
        subject: `Thank you from ${KK} — let's keep going`,
        body: bulletBody({ greet: greetEmail(ctx), intro: `Thank you if you came by our stall at ${KK} — and if we missed you, no problem.`,
          supply: [...p.supply.slice(0, 2), SAMPLE], cta: "Send one drawing and we'll quote." }),
        whatsapp: wa(hiWa(ctx), `Thank you from *${KK}*!`, '', '*Missed us? No problem:*', SAMPLE_WA, "— we'll make it to match.", '',
          "Or just send a drawing and we'll quote. — Vama, Peena Heat Elements"),
      }) },
  ],
  calls: (p, ctx) => {
    const co = ctx.company || 'the company';
    return [
      { label: 'Call #1 — invite', day: '5 Nov', script:
`CALL #1 — ${co} (invite to our stall)\n\n1) "Vama from Peena Heat Elements, Ahmedabad — we make the heating elements that go inside ${p.eq}. Have I caught you at an okay moment?"\n2) INVITE: "We're exhibiting at ${KK} — ${KK_STALL}, ${KK_WHEN}, ${KK_VENUE}. We'd love you to visit; entry is free as our guest — I'll WhatsApp you the link."\n3) ASK: "Which heating elements go into your ${p.eq} today, and who supplies them?"\n4) BOOK IT: "Which day suits you — 16, 17, 18 or 19 December? Bring a drawing and we'll go through it together."\n5) Close: WhatsApp the free-entry link and the invitation flyer: ${KK_PASS}` },
      { label: 'Call #2 — confirm', day: '15 Dec', script:
`CALL #2 — ${co} (confirm the visit)\n\n1) "Vama from Peena Heat Elements — ${KK} opens tomorrow."\n2) CONFIRM their day and time; remind them: ${KK_STALL}, ${KK_HOURS} — bring a drawing or the element they use.\n3) Re-send the free-entry link if needed: ${KK_PASS}` },
    ];
  },
};

// Existing customers (owner, 21–23 Oct 2026): restock check, the Diwali card, the new fitted 2-in-1 / 3-in-1
// heaters + heater plates, new sizes by drawing, Khadya Khurak, January restock. Owner, 23 Oct: keep it casual
// ("we talk to them every day"), and customers who've ordered don't send drawings or photos — we tell them
// what they ordered and ask if they need to restock. Per-contact renders name their items (ctx.items, ctx.lastOrder).
// The list's application = how often they've ordered in the app.
const EC_APPS = {
  'Ordered 3+ times':         { kind: 'regular' },
  'Ordered 1–2 times':        { kind: 'recent' },
  'No orders in the app yet': { kind: 'lapsed' },
};
const EC_ALL = { kind: 'all' };
const EC_NEW = ['2-in-1 and 3-in-1 heaters, now supplied fully fitted — thermostat pocket, cap & sleeve, gasket and thermostat',
  'Heater plates: round, oval & square plates, 4-hole dishwasher flanges, SS plates', 'Made to your drawing — tested before dispatch'];
const EC_SIGN = '— Vama\nPeena Heat Elements · phe.co.in · WhatsApp +91 84520 55836';
const ecName = ctx => (ctx.company ? shortCompany(ctx.company) : '$[FNAME|there]$');
const ecMail = (ctx, ...lines) => [`Hi ${ecName(ctx)},`, '', ...lines.flat().filter(l => l !== null && l !== false), '', EC_SIGN].join('\n').replace(/\n{3,}/g, '\n\n');
const ecHi = ctx => (ctx.company ? `Hi ${shortCompany(ctx.company)} team 👋` : 'Hi 👋');
const bullets = (label, lines) => [`**${label}**`, ...lines.map(l => '→ ' + l), ''];
// What they ordered (per-contact renders only — Zoho can't merge it, so the list version stays general).
const ecItems = (ctx, bold) => (ctx.items && ctx.items.length ? ctx.items.map(i => (bold ? `*${i}*` : i)).join(', ') : null);
const ecLast = ctx => (ctx.lastOrder ? ` — last order on ${ctx.lastOrder}` : '');
const ecOrdered = (p, ctx, bold) => {
  const it = ecItems(ctx, bold);
  if (p.kind === 'lapsed') return "It's been a while — hope all's well!";
  if (p.kind === 'regular') return it ? `You've been taking ${it} from us regularly${ecLast(ctx)}.` : 'Thanks for ordering with us regularly!';
  return it ? `You took ${it} from us${ecLast(ctx)}.` : 'Thanks for your recent order!';
};
const ecRestock = p => (p.kind === 'lapsed'
  ? "Need anything? Just send us the requirement — or a drawing for anything new — and we'll quote."
  : 'Need to restock? Just let us know the quantity — we have your drawings on file.');

const existingCustomers = {
  name: 'Existing customers · reorder',
  regionLabel: 'country',
  apps: EC_APPS, all: EC_ALL,
  touches: [
    { key: 'thanks', label: 'Restock check', day: '28 Oct', attach: '',
      render: (p, ctx) => ({
        subject: p.kind === 'lapsed' ? "It's been a while — need anything?" : 'Need to restock?',
        body: ecMail(ctx, ecOrdered(p, ctx, false), '', ecRestock(p),
          p.kind === 'regular' ? "If you share your plan for the next 2–3 months, we'll line up your batches in advance." : null,
          '', 'Dispatch in 5–7 days, every element tested before it leaves.'),
        whatsapp: wa(ecHi(ctx), ecOrdered(p, ctx, true), '', ecRestock(p), '', '— Vama'),
      }) },
    DIWALI,
    { key: 'newproduct', label: 'New: fitted 2-in-1 / 3-in-1', day: '18 Nov', attach: '🖼️ Product image (fitted heater)',
      render: (p, ctx) => ({
        subject: 'New: fully fitted 2-in-1 & 3-in-1 heaters',
        body: ecMail(ctx, 'Something new you might like for your next order:', '', bullets('New from us', EC_NEW),
          "Want them fitted on your next order? Just reply and we'll quote."),
        whatsapp: wa(ecHi(ctx), 'Something new from us 🆕', '', '• 2-in-1 & 3-in-1 heaters, now supplied *fully fitted* — thermostat pocket, cap & sleeve, gasket and thermostat',
          '• Heater plates — round, oval & square, 4-hole dishwasher flanges, SS plates', '', "Want them fitted on your next order? Just reply and we'll quote."),
      }) },
    { key: 'flyer', label: "What's new — flyer", day: '26 Nov', attach: '📄 Flyer', flyer: EC_FLYER, waImage: EC_FLYER,
      render: (p, ctx) => ({
        subject: "What's new at Peena Heat Elements",
        body: flyerBody({ greet: `Hi ${ecName(ctx)}`, intro: 'Everything new from us, on one page:', flyer: EC_FLYER,
          cta: 'Need to restock? Just reply with the quantity.' }),
        whatsapp: wa(ecHi(ctx), "Here's what's new with us 👆", '', 'Need to restock? Just send the quantity.'),
      }) },
    { key: 'newsku', label: 'New sizes by drawing', day: '3 Dec', attach: '🖼️ Photo-beside-tape example',
      render: (p, ctx) => ({
        subject: "Need a new size? Send us a drawing",
        body: ecMail(ctx, "Got a new model coming, or need a size you haven't ordered from us before?", '',
          "Just send the drawing — or a photo of the element next to a measuring tape — and we'll make it to match. SS304 · SS316 · Incoloy 800, tested before dispatch, 6-month guarantee.", '',
          "No drawing? Courier us one element and we'll match it."),
        whatsapp: wa(ecHi(ctx), "Need a size you haven't ordered before? 📐", '', "Send the drawing — or a photo of the element next to a measuring tape — and we'll make it to match.",
          '', "No drawing? Courier us one element and we'll match it."),
      }) },
    { key: 'show', label: `${KK} invite`, day: '10 Dec', attach: '🎟️ Free-entry link',
      render: (p, ctx) => ({
        subject: `Come see us at ${KK} — ${KK_STALL}`,
        body: ecMail(ctx, `We're at ${KK} this year — our first time! Do drop by if you're around:`, '',
          '**Where**', `→ ${KK_STALL} · ${KK_VENUE}`, '**When**', `→ ${KK_WHEN} · ${KK_HOURS}`, '**Entry**', `→ Free as our guest: ${KK_PASS}`, '',
          "You'll see the new fitted heaters there too."),
        whatsapp: wa(ecHi(ctx), `We're at *${KK} 2026* — do drop by! 🙂`, '', KK_BLOCK, '', PASS_LINE, '', '— Vama'),
      }) },
    { key: 'yearend', label: 'January restock', day: '22 Dec', attach: '',
      render: (p, ctx) => {
        const it = ecItems(ctx, false), itb = ecItems(ctx, true);
        const ask = p.kind === 'lapsed' ? "Planning for January? Send us your requirement and we'll quote."
          : `Planning for January? Just send the quantities${it ? ` for ${it}` : ''} — we'll line them up.`;
        const askWa = p.kind === 'lapsed' ? ask : `Planning for January? Just send the quantities${itb ? ` for ${itb}` : ''} — we'll line them up.`;
        return {
          subject: 'Planning for January?',
          body: ecMail(ctx, 'Thanks for a great 2026!', '', ask, '', 'Happy New Year! 🎉'),
          whatsapp: wa(ecHi(ctx), 'Thanks for a great 2026! 🙏', '', askWa, '', 'Happy New Year! 🎉 — Vama'),
        };
      } },
  ],
  calls: (p, ctx) => {
    const co = ctx.company || 'the customer';
    const items = ecItems(ctx, false);
    const open = p.kind === 'regular' ? `"Any requirement coming up for November–December?${items ? ` Same ${items}?` : ''}"`
      : p.kind === 'recent' ? `"How did the last batch work out?${items ? ` Need more ${items}?` : ' Need to restock?'}"`
      : '"It\'s been a while — what are you using now, and can we quote your next requirement?"';
    return [
      { label: 'Call #1 — restock check', day: '30 Oct', script:
`CALL #1 — ${co} (existing customer · restock check)\n\n1) Friendly hello — "Vama from Peena Heat Elements."\n2) RESTOCK: ${open}\n3) EASY: "Just tell me the quantity — we have your drawings on file."\n4) Close: confirm the order or a date to check back.` },
      { label: 'Call #2 — new fitted heaters + show', day: '20 Nov', script:
`CALL #2 — ${co} (new product + ${KK})\n\n1) "Vama here — two quick things."\n2) NEW: "We now supply 2-in-1 and 3-in-1 heaters fully fitted — thermostat pocket, cap & sleeve, gasket and thermostat — plus heater plates. Want them on your next order?"\n3) SHOW: "We're at ${KK}, ${KK_STALL}, ${KK_WHEN}. Entry is free as our guest — I'll WhatsApp you the link: ${KK_PASS}"\n4) Close: interest + the day they might visit.` },
      { label: 'Call #3 — January requirement', day: '21 Dec', script:
`CALL #3 — ${co} (January requirement)\n\n1) "Vama here — thanks for this year!"\n2) PLAN: "What will you need in January?${items ? ` Same ${items}?` : ''} Tell me the quantities and we'll line them up."\n3) NEW SIZES: "Any new size coming? Send a drawing, or a photo beside a measuring tape."\n4) Close: confirm the order or a follow-up date.` },
    ];
  },
};

// Saudi customers get the campaign in Arabic (owner, 23 Oct 2026). On this list the region is the
// country, so picking "Saudi Arabia" shows the Arabic edition and its Zoho export is the Saudi slice.
// Not a word-for-word copy: the show touch is framed for visitors to India. The Diwali card (an image only)
// goes to them as it does to everyone (owner, 26 Oct 2026: "all our campaigns").
const EC_FLYER_AR = `${SITE}/phe-existing-customers-flyer-ar.jpg`;
const isArabicRegion = ctx => ctx.region === 'Saudi Arabia';
const AR_PROFILE = {
  regular: { thanks: 'شكرًا لثقتكم وطلباتكم المنتظمة معنا — وهذا يعني لنا الكثير.', ask: 'شاركونا احتياجاتكم للشهرين أو الثلاثة القادمة، وسنخطط دفعات الإنتاج مسبقًا.' },
  recent:  { thanks: 'شكرًا على طلبكم الأخير معنا.', ask: 'هل حان وقت تجديد المخزون؟ أخبرونا بالكمية فقط — رسوماتكم محفوظة لدينا.' },
  lapsed:  { thanks: 'مضى بعض الوقت منذ آخر تعامل بيننا — شكرًا لاختياركم لنا من قبل.', ask: 'يسعدنا أن نخدمكم مجددًا — أرسلوا احتياجاتكم الحالية أو رسمًا فنيًا.' },
  all:     { thanks: 'شكرًا لتعاملكم مع Peena Heat Elements.', ask: 'هل تحتاجون عناصركم المعتادة مجددًا؟ أرسلوا الكمية — بنفس الرسم الفني السابق.' },
};
const coAr = ctx => ctx.company || '$[FNAME|شركتكم]$';
const hiAr = ctx => (ctx.company ? `مرحبًا فريق ${shortCompany(ctx.company)} 🙏` : 'مرحبًا 🙏');
const SIGN_AR = `مع أطيب التحيات،\nفاما · Peena Heat Elements\nphe.co.in · vama@peenaheatelements.com\nالكتالوج: ${CAT}`;
const arBody = (ctx, ...blocks) => [`السادة / ${coAr(ctx)} المحترمين،`, 'تحية طيبة وبعد،', '', ...blocks.flat(), SIGN_AR].join('\n');
const AR_REORDER = ['أخبرونا بالصنف والكمية عبر واتساب — رسوماتكم محفوظة لدينا', 'نؤكد لكم السعر وموعد الشحن', 'الشحن خلال 5 إلى 7 أيام · كل عنصر يُختبر قبل الشحن'];
const AR_NEW = ['سخانات 2 في 1 و3 في 1، تُورَّد الآن مجهزة بالكامل — جيب الثرموستات، الغطاء والجلبة، الحشية والثرموستات',
  'ألواح تثبيت السخانات: ألواح دائرية وبيضاوية ومربعة، فلنجات غسالات الصحون بأربع فتحات، وألواح من الستانلس ستيل', 'مصنوعة حسب رسوماتكم الفنية — ومختبرة قبل الشحن'];
const EC_AR = {
  thanks: (a, ctx) => ({
    subject: 'شكرًا من Peena Heat Elements — أعيدوا الطلب برسالة واحدة',
    body: arBody(ctx, a.thanks, '', bullets('أعيدوا الطلب برسالة واحدة', AR_REORDER), a.ask, ''),
    whatsapp: wa(hiAr(ctx), `معكم فاما من *Peena Heat Elements*. ${a.thanks}`, '', '*أعيدوا الطلب برسالة واحدة:*', '• الصنف + الكمية — رسوماتكم محفوظة لدينا',
      '• نؤكد السعر وموعد الشحن', '• الشحن خلال 5 إلى 7 أيام، بعد الاختبار', '', a.ask, '', 'يكفي الرد هنا 🙏'),
  }),
  newproduct: (a, ctx) => ({
    subject: 'جديد: سخانات 2 في 1 و3 في 1 مجهزة بالكامل',
    body: arBody(ctx, 'منتج جديد لطلبكم القادم:', '', bullets('جديد من Peena Heat Elements', AR_NEW),
      'هل ترغبون بإضافتها إلى طلبكم القادم؟ أرسلوا الرسم الفني وسنرسل لكم عرض سعر للنسخة المجهزة بالكامل.', ''),
    whatsapp: wa(hiAr(ctx), '*جديد من Peena Heat Elements* 🆕', '', '• سخانات 2 في 1 و3 في 1 تُورَّد الآن *مجهزة بالكامل* — جيب الثرموستات، الغطاء والجلبة، الحشية والثرموستات',
      '• ألواح تثبيت السخانات — دائرية وبيضاوية ومربعة، فلنجات غسالات الصحون بأربع فتحات، وألواح ستانلس ستيل', '• حسب رسوماتكم الفنية · مختبرة قبل الشحن', '',
      'أرسلوا الرسم الفني وسنرسل عرض سعر للنسخة المجهزة بالكامل.'),
  }),
  flyer: (a, ctx) => ({
    flyer: EC_FLYER_AR, waImage: EC_FLYER_AR,
    subject: 'كل جديد Peena Heat Elements في صفحة واحدة',
    body: [`السادة / ${coAr(ctx)} المحترمين،`, 'تحية طيبة وبعد،', '', 'كل جديدنا في صفحة واحدة — إعادة الطلب برسالة واحدة، المقاسات الجديدة، وسخانات 2 في 1 و3 في 1 المجهزة بالكامل:', '',
      `[[IMG:${EC_FLYER_AR}]]`, '', 'للطلب، يكفي الرد على هذه الرسالة أو مراسلتنا عبر واتساب.', '', 'فاما · Peena Heat Elements\nphe.co.in · vama@peenaheatelements.com'].join('\n'),
    whatsapp: wa(hiAr(ctx), 'إليكم كل جديد *Peena Heat Elements* في صفحة واحدة 👆', '', 'أعيدوا الطلب برسالة واحدة — يكفي الرد بالصنف والكمية.'),
  }),
  newsku: (a, ctx) => ({
    subject: 'تحتاجون مقاسًا جديدًا؟ أرسلوا الرسم الفني ونصنعه مطابقًا',
    body: arBody(ctx, 'هل تضيفون طرازًا جديدًا، أو تحتاجون مقاسًا لم تطلبوه منا من قبل؟ الأمر سهل:', '',
      bullets('مقاس جديد في ثلاث خطوات', ['أرسلوا الرسم الفني — أو صورة للعنصر بجانب شريط قياس', 'نؤكد السعر ونصنعه مطابقًا — SS304 · SS316 · Incoloy 800', 'مختبر قبل الشحن · ضمان لمدة ستة أشهر']),
      'لا يتوفر رسم فني؟ أرسلوا لنا عنصرًا واحدًا بالبريد السريع وسنصنع مثله.', ''),
    whatsapp: wa(hiAr(ctx), '*تحتاجون مقاسًا جديدًا؟* 📐', '• أرسلوا الرسم الفني — أو صورة للعنصر بجانب شريط قياس', '• نؤكد السعر ونصنعه مطابقًا',
      '• مختبر قبل الشحن · ضمان ستة أشهر', '', 'لا يتوفر رسم فني؟ أرسلوا لنا عنصرًا واحدًا وسنصنع مثله.'),
  }),
  show: (a, ctx) => ({
    subject: 'نشارك في معرض خاديا خوراك 2026 في الهند',
    body: arBody(ctx, 'نشارك لأول مرة في معرض خاديا خوراك 2026 للصناعات الغذائية في غانديناغار، الهند.', '',
      '**المكان**', '→ الجناح 254، القاعة 8 · Helipad Exhibition Centre, Sector 17, Gandhinagar', '**الموعد**', '→ من 16 إلى 19 ديسمبر · من 10 صباحًا حتى 6 مساءً',
      '**الدخول**', `→ مجاني كضيوف لدينا: ${KK_PASS}`, '', 'إن كنتم في الهند خلال تلك الفترة يسعدنا لقاؤكم — وإلا فنحن متاحون دائمًا عبر واتساب.', ''),
    whatsapp: wa(hiAr(ctx), 'نشارك في *معرض خاديا خوراك 2026* في الهند 🇮🇳', '', '📍 الجناح 254، القاعة 8 · غانديناغار', '📅 من 16 إلى 19 ديسمبر · من 10 صباحًا حتى 6 مساءً', '',
      `🎟️ الدخول مجاني كضيوف لدينا: ${KK_PASS}`, '', 'إن كنتم في الهند يسعدنا لقاؤكم — وإلا فنحن على واتساب دائمًا. — فاما'),
  }),
  yearend: (a, ctx) => ({
    subject: 'تخططون لشهر يناير؟ أعيدوا الطلب برسالة واحدة',
    body: arBody(ctx, `شكرًا لكم على عام 2026. تخططون لشهر يناير؟ ${a.ask}`, '', bullets('أعيدوا الطلب برسالة واحدة', AR_REORDER), 'نتمنى لكم عامًا جديدًا سعيدًا!', ''),
    whatsapp: wa(hiAr(ctx), 'شكرًا لكم على عام 2026! 🙏', '', `*تخططون لشهر يناير؟* ${a.ask}`, '', '• الصنف + الكمية', '• الشحن خلال 5 إلى 7 أيام، بعد الاختبار',
      '', 'كل عام وأنتم بخير — فاما، Peena Heat Elements'),
  }),
};
existingCustomers.touches = existingCustomers.touches.map(t => ({
  ...t,
  render: (p, ctx) => (isArabicRegion(ctx) && EC_AR[t.key] ? EC_AR[t.key](AR_PROFILE[p.kind] || AR_PROFILE.all, ctx) : t.render(p, ctx)),
}));
existingCustomers.regionLabel = 'country';

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
    DIWALI,
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
    DIWALI,
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

// ───────────────────────── Vietnam — in Vietnamese ─────────────────────────
// Owner, 26 Oct 2026: "revamp the vietnam campaign … in their local language, every flyer, written content, everything".
// Copy by a Vietnamese B2B writer, then three independent reviews (native tone · industrial terms · fidelity to PHE's
// facts) and a revision. Register: emails "Kính gửi … / Trân trọng"; WhatsApp/Zalo and calls "Anh/Chị". Most Vietnamese
// buyers chat on Zalo: the same number is on Zalo and the row pop-up offers "Zalo this". English copy: git history before 26 Oct.
const VN_FLYER_VI = `${SITE}/phe-vietnam-flyer-vi.jpg`;
const DIWALI_CARD_VI = `${SITE}/phe-diwali-card-vi.jpg`;
// The list stores provinces in English; the letters name them the Vietnamese way.
const VN_PROVINCE = {"Ho Chi Minh City": "TP. Hồ Chí Minh", "Hanoi": "Hà Nội", "Binh Duong": "Bình Dương", "Da Nang": "Đà Nẵng", "Dong Nai": "Đồng Nai", "Tay Ninh": "Tây Ninh", "Hai Phong": "Hải Phòng", "Vinh Long": "Vĩnh Long", "Ninh Binh": "Ninh Bình", "Khanh Hoa": "Khánh Hòa", "Phu Tho": "Phú Thọ", "Ca Mau": "Cà Mau", "Hai Duong": "Hải Dương", "Bac Ninh": "Bắc Ninh", "Long An": "Long An", "Can Tho": "Cần Thơ", "Ba Ria - Vung Tau": "Bà Rịa – Vũng Tàu", "Bac Giang": "Bắc Giang", "Hung Yen": "Hưng Yên", "Vinh Phuc": "Vĩnh Phúc", "Quang Ninh": "Quảng Ninh"};
const vnWhere = ctx => VN_PROVINCE[ctx.region] || ctx.region || 'Việt Nam';
// Keys stay the list's English application names; their/elem/short are the Vietnamese phrases.
const VN_APPS = {
  "Autoclaves & sterilizers": { their: "nồi hấp tiệt trùng và thiết bị tiệt trùng", elem: "điện trở nhúng và điện trở dạng ống Inox 316 / Incoloy cho bộ tạo hơi và buồng hấp", short: "nồi hấp" },
  "Boilers & steam": { their: "nồi hơi điện và hệ thống nhiệt", elem: "cụm điện trở nhúng mặt bích và đầu ren (screw-plug)", short: "nồi hơi" },
  "Catering & bakery ovens": { their: "thiết bị bếp công nghiệp và lò nướng bánh", elem: "điện trở dạng ống cho lò nướng, bếp chiên nhúng và tủ hâm nóng (bain-marie)", short: "lò và bếp" },
  "Dissolution & water baths": { their: "hệ thống bể ổn nhiệt và gia nhiệt công nghiệp", elem: "điện trở nhúng và điện trở bể ổn nhiệt Inox 316", short: "bể ổn nhiệt" },
  "Fluid bed dryers & granulation": { their: "máy sấy và máy tạo hạt", elem: "điện trở sấy khí cánh tản nhiệt cho gió cấp đầu vào và điện trở nhúng cho phần vỏ áo gia nhiệt (jacket)", short: "máy sấy" },
  "Furnaces & kilns": { their: "lò nung và lò công nghiệp", elem: "dây điện trở xoắn lò xo và điện trở dạng ống uốn theo hình buồng lò", short: "lò nung" },
  "Geysers & water heaters": { their: "máy nước nóng", elem: "điện trở nhúng đầu ren và điện trở dạng ống", short: "máy nước nóng" },
  "Heating elements & distribution": { their: "danh mục điện trở nhiệt", elem: "điện trở dạng ống, điện trở đũa (cartridge) và điện trở vòng (band) làm theo bản vẽ, để nhập kho hoặc phân phối lại", short: "danh mục hàng" },
  "Industrial & curing ovens": { their: "lò sấy, máy sấy và dây chuyền sấy sơn / sấy đóng rắn (curing)", elem: "điện trở sấy khí cánh tản nhiệt, lắp thẳng vào ống gió hoặc luồng khí trong lò", short: "lò sấy" },
  "Plastics machinery": { their: "máy ngành nhựa và bao bì", elem: "điện trở đũa (cartridge), điện trở vòng (band) và điện trở hot runner cho xi lanh, thanh hàn nhiệt và khuôn", short: "máy" },
  "Incubators & lab ovens": { their: "tủ sấy phòng thí nghiệm và tủ ấm", elem: "điện trở cánh tản nhiệt và điện trở dạng ống mật độ công suất thấp", short: "tủ sấy" },
  "Stability chambers & incubators": { their: "tủ vi khí hậu (stability chamber) và tủ ấm", elem: "điện trở dạng ống và điện trở cánh tản nhiệt mật độ công suất thấp", short: "tủ" },
};
const VN_ALL = { their: "các thiết bị công nghiệp", elem: "điện trở dạng ống, điện trở cánh tản nhiệt, điện trở nhúng và điện trở đũa (cartridge) làm theo bản vẽ", short: "thiết bị" };
const VN_LBL = {"what_we_make": "Chúng tôi sản xuất", "supply": "Chúng tôi có thể cung cấp cho Quý công ty", "why": "Vì sao chọn Peena Heat Elements", "where_we_fit": "Sản phẩm phù hợp với Quý công ty", "new_ranges": "Dòng sản phẩm mới", "how_trial": "Cách thử mẫu"};
const VN_WHAT = "Điện trở nhiệt dạng ống, điện trở cánh tản nhiệt, điện trở nhúng và điện trở đũa (cartridge) — sản xuất theo bản vẽ của Quý công ty";
const VN_WHY = ["Kiểm tra từng chiếc trước khi xuất xưởng · Bảo hành 6 tháng", "Xuất hàng trong 5–7 ngày · Xuất khẩu toàn cầu"];
const VN_SIGN = `Trân trọng,\nVama · Peena Heat Elements\nphe.co.in · vama@peenaheatelements.com\nWhatsApp / Zalo: +91 84520 55836\nCatalogue (PDF): ${CAT}`;
const VN_SIGN_SHORT = "Trân trọng,\nVama · Peena Heat Elements";
const VN_IMG_ALT = "Tờ giới thiệu Peena Heat Elements";
const vnCo = ctx => ctx.company || '$[FNAME|Quý công ty]$';
// "Kính gửi <name>," reads right whether the name already starts with "Công ty …" or not; blank → "Quý công ty"
const vnGreet = ctx => `Kính gửi ${vnCo(ctx)},`;
const vnHi = ctx => (ctx.company ? `Chào Anh/Chị bên ${shortCompany(ctx.company)} 🙏` : 'Chào Anh/Chị 🙏');
const vnFill = (s, m, ctx) => String(s).replace(/\{their\}/g, m.their).replace(/\{elem\}/g, m.elem).replace(/\{short\}/g, m.short)
  .replace(/\{company\}/g, vnCo(ctx)).replace(/\{region\}/g, vnWhere(ctx)).replace(/\{greeting\}/g, vnHi(ctx))
  .replace(/\{CAT\}/g, CAT).replace(/\{VIDEO\}/g, VIDEO);
// Placeholders in the copy: {their} {elem} {short} {company} {region} {greeting} {CAT} {VIDEO}
const VN_COPY = {
  intro: {
    subject: "Điện trở nhiệt cho {their} — Peena Heat Elements, Ấn Độ",
    intro: "Tôi là Vama từ Peena Heat Elements (Ahmedabad, Ấn Độ). Chúng tôi đang cung cấp điện trở nhiệt cho các nhà sản xuất thiết bị tại Ấn Độ, các nước vùng Vịnh (Trung Đông), châu Phi, Úc và nhiều thị trường khác — và rất mong được đồng hành cùng các nhà sản xuất tại {region}.",
    supplyLabel: "Chúng tôi có thể cung cấp cho Quý công ty",
    supply: ["Dành cho {their} của Quý công ty: {elem}", "Vật liệu vỏ: Inox 304 (SS304) · Inox 316 (SS316) · Incoloy 800", "Mẫu mới — Quý công ty chỉ cần gửi bản vẽ, chúng tôi sẽ sản xuất đúng theo bản vẽ"],
    cta: "Xin hỏi ai là người phụ trách mua điện trở nhiệt tại {company}? Tôi rất sẵn lòng gửi catalogue và báo giá.",
    whatsapp: "{greeting}\nTôi là Vama từ *Peena Heat Elements*, Ahmedabad, Ấn Độ.\n\n*Sản phẩm phù hợp với bên Anh/Chị*\n• Dành cho {their}: {elem}\n• Làm theo bản vẽ — Inox 304 · Inox 316 · Incoloy 800\n• Kiểm tra từng chiếc trước khi xuất xưởng · Bảo hành 6 tháng · Xuất hàng trong 5–7 ngày\n\nBên Anh/Chị ai phụ trách mua điện trở nhiệt ạ? Tôi sẵn sàng gửi báo giá. Số này cũng dùng Zalo.\n\n📄 Catalogue: {CAT}\n🎬 Video quy trình sản xuất: {VIDEO}",
  },
  product: {
    subject: "Điện trở nhiệt cho {their} — làm đúng theo bản vẽ",
    intro: "Tiếp theo email trước, tôi xin nói cụ thể hơn về những sản phẩm chúng tôi có thể cung cấp cho {company}:",
    supplyLabel: "Sản phẩm phù hợp với Quý công ty",
    supply: ["Dành cho {their} của Quý công ty: {elem}", "Sản xuất chính xác theo bản vẽ — uốn CNC ngay tại xưởng, lắp sẵn đầu cực đấu điện", "Vật liệu vỏ: Inox 304 · Inox 316 · Incoloy 800"],
    cta: "Quý công ty chỉ cần gửi một bản vẽ hoặc một mẫu điện trở đang dùng — chúng tôi sẽ báo giá sản phẩm tương đương.",
    whatsapp: "{greeting}\nVama từ *Peena Heat Elements* đây ạ. Tôi xin nói rõ hơn những sản phẩm chúng tôi có thể làm cho bên Anh/Chị:\n\n• Dành cho {their}: {elem}\n• Làm chính xác theo bản vẽ — uốn CNC tại xưởng, lắp sẵn đầu cực đấu điện\n• Inox 304 · Inox 316 · Incoloy 800\n\nAnh/Chị gửi tôi 1 bản vẽ hoặc 1 mẫu điện trở đang dùng, tôi sẽ báo giá sản phẩm tương đương.\n\n📄 Catalogue: {CAT}\n🎬 Video quy trình sản xuất: {VIDEO}",
  },
  flyer: {
    subject: "Tổng quan sản phẩm trong 1 trang — Peena Heat Elements",
    intro: "Xin gửi Quý công ty tờ giới thiệu một trang — các loại điện trở nhiệt chúng tôi sản xuất cho các nhà sản xuất thiết bị tại {region}:",
    supplyLabel: "Chúng tôi có thể cung cấp cho Quý công ty",
    supply: [],
    cta: "Nếu có sản phẩm nào phù hợp, Quý công ty vui lòng trả lời email hoặc nhắn WhatsApp/Zalo cho tôi — hoặc gửi bản vẽ để chúng tôi báo giá.",
    whatsapp: "Xin gửi Anh/Chị tờ giới thiệu một trang của *Peena Heat Elements* 👆\n• Dành cho {their}: {elem}\n• Làm theo bản vẽ — Inox 304 · Inox 316 · Incoloy 800\n• Kiểm tra từng chiếc trước khi xuất xưởng · Bảo hành 6 tháng\n\nAnh/Chị gửi bản vẽ, chúng tôi sẽ báo giá ạ.\n📄 Catalogue: {CAT}",
  },
  newparts: {
    subject: "Dòng sản phẩm mới phù hợp với {their} — Peena Heat Elements",
    intro: "Chúng tôi vừa có thêm một vài dòng sản phẩm rất phù hợp với {their} của Quý công ty:",
    supplyLabel: "Dòng sản phẩm mới",
    supply: ["{elem} — phiên bản mật độ công suất thấp, tuổi thọ cao hơn", "Vỏ Incoloy 800 cho các ứng dụng nhiệt độ cao", "Mặt bích, phụ kiện và đầu cực đấu điện làm riêng — lắp thẳng vào {short} của Quý công ty"],
    cta: "Quý công ty muốn nhận mẫu thử hay báo giá? Chỉ cần trả lời email này, tôi sẽ gửi.",
    whatsapp: "{greeting}\nVama từ *Peena Heat Elements* đây ạ. Chúng tôi có vài dòng mới phù hợp với {their}:\n\n• {elem} — phiên bản mật độ công suất thấp, tuổi thọ cao hơn\n• Vỏ Incoloy 800 cho nhiệt độ cao\n• Mặt bích, phụ kiện và đầu cực đấu điện làm riêng — lắp thẳng vào {short}\n\nAnh/Chị muốn nhận mẫu hay báo giá ạ?\n📄 Catalogue: {CAT}",
  },
  client: {
    subject: "Đề xuất thử mẫu không ràng buộc — một điện trở cho {their}",
    intro: "Tôi xin đề xuất với {company} một cách thử mẫu hoàn toàn không ràng buộc:",
    supplyLabel: "Cách thử mẫu",
    supply: ["Quý công ty gửi một bản vẽ của điện trở đang mua cho {their}", "Chúng tôi sản xuất một mẫu thử", "Bộ phận kỹ thuật của Quý công ty thử nghiệm và so sánh với hàng đang dùng", "Nếu mẫu đạt — chúng tôi trở thành nhà cung cấp của Quý công ty; nếu không — Quý công ty không mất gì"],
    cta: "Quý công ty vui lòng cho tôi xin email hoặc số WhatsApp/Zalo của bộ phận kỹ thuật hoặc thu mua để tôi trao đổi chi tiết về mẫu thử.",
    whatsapp: "{greeting}\nVama từ *Peena Heat Elements* đây ạ. Xin đề xuất một cách *thử mẫu không ràng buộc*:\n\n• Anh/Chị gửi 1 bản vẽ điện trở đang mua cho {their}\n• Chúng tôi làm 1 mẫu thử\n• Bộ phận kỹ thuật bên Anh/Chị thử và so với hàng đang dùng\n• Đạt thì chúng tôi làm nhà cung cấp — không đạt thì Anh/Chị không mất gì\n\nAnh/Chị cho tôi xin email hoặc số WhatsApp/Zalo của bộ phận kỹ thuật/thu mua được không ạ?\n📄 Catalogue: {CAT}",
  },
};
const vnBody = (m, ctx, t) => [vnGreet(ctx), '', vnFill(t.intro, m, ctx), '',
  `**${VN_LBL.what_we_make}**`, '→ ' + VN_WHAT, '',
  `**${t.supplyLabel}**`, ...t.supply.map(s => '→ ' + vnFill(s, m, ctx)), '',
  `**${VN_LBL.why}**`, ...VN_WHY.map(w => '→ ' + w), '',
  vnFill(t.cta, m, ctx), '', VN_SIGN].join('\n');
const vnTouch = (key, label, day, extra = {}) => ({ key, label, day, attach: '', ...extra,
  render: (m, ctx) => {
    const t = VN_COPY[key];
    return {
      subject: vnFill(t.subject, m, ctx),
      body: key === 'flyer'
        ? [vnGreet(ctx), '', vnFill(t.intro, m, ctx), '', `[[IMG:${VN_FLYER_VI}|${VN_IMG_ALT}]]`, '', vnFill(t.cta, m, ctx), '', VN_SIGN_SHORT].join('\n')
        : vnBody(m, ctx, t),
      whatsapp: vnFill(t.whatsapp, m, ctx),
    };
  } });
// Vama calls in English; each step carries the Vietnamese line to read or to send on WhatsApp/Zalo afterwards.
const VN_CALL = "1. Warm open — Good morning, this is Vama calling from Peena Heat Elements in India. Is this a good time for two minutes?\n   Xin chào, tôi là Vama, gọi từ Peena Heat Elements, Ấn Độ. Anh/Chị có tiện nói chuyện hai phút không ạ?\n\n2. Who we are — We make tubular, finned, immersion and cartridge heating elements to the customer's drawing, in Ahmedabad, and we already supply equipment builders in India, the Gulf, Africa and Australia.\n   Chúng tôi sản xuất điện trở nhiệt dạng ống, điện trở cánh tản nhiệt, điện trở nhúng và điện trở đũa (cartridge) theo bản vẽ khách hàng tại Ahmedabad, và đang cung cấp cho các nhà sản xuất thiết bị ở Ấn Độ, các nước vùng Vịnh (Trung Đông), châu Phi và Úc.\n\n3. The fit — I understand you build {their}. For those we make {elem}, bent on CNC in-house, in SS304, SS316 or Incoloy 800, tested before dispatch with a 6-month guarantee.\n   Tôi được biết Anh/Chị chế tạo {their}. Cho các thiết bị này chúng tôi làm {elem}, uốn CNC tại xưởng, vỏ Inox 304, Inox 316 hoặc Incoloy 800, lắp sẵn đầu cực đấu điện, kiểm tra từng chiếc trước khi xuất xưởng và bảo hành 6 tháng.\n\n4. Who looks after sourcing — Who looks after heating-element sourcing on your side? May I send them our catalogue?\n   Bên Anh/Chị ai phụ trách mua điện trở nhiệt ạ? Tôi có thể gửi catalogue cho người đó được không?\n\n5. Sample offer — If you send us one drawing, or a photo of an element beside a measuring tape, we make a trial piece for your team to test against your current supply.\n   Nếu Anh/Chị gửi một bản vẽ, hoặc một tấm ảnh điện trở chụp cạnh thước dây, chúng tôi sẽ làm một mẫu thử để bộ phận kỹ thuật so sánh với hàng đang dùng.\n\n6. Close — What is the best email or WhatsApp/Zalo number to send the catalogue and the sample details to? Thank you for your time.\n   Tôi nên gửi catalogue và thông tin mẫu thử đến email hoặc số WhatsApp/Zalo nào thuận tiện nhất ạ? Cảm ơn Anh/Chị đã dành thời gian.";

const vietnam = {
  name: 'Vietnam · Tiếng Việt',
  regionLabel: 'province',
  apps: VN_APPS, all: VN_ALL,
  zalo: true,
  touches: [
    vnTouch('intro', 'Intro', 0, { attach: '🎬 Manufacturing video' }),
    vnTouch('product', 'Product', 3, { attach: '🖼️ Product image (their equipment)' }),
    vnTouch('flyer', 'Product flyer', 5, { attach: '📄 Flyer (Vietnamese)', flyer: VN_FLYER_VI, waImage: VN_FLYER_VI }),
    { ...DIWALI, flyer: DIWALI_CARD_VI, waImage: DIWALI_CARD_VI,
      render: () => ({ subject: 'Chúc mừng Lễ hội Ánh sáng Diwali — Peena Heat Elements',
        body: `[[IMG:${DIWALI_CARD_VI}|Chúc mừng Lễ hội Ánh sáng Diwali — Peena Heat Elements, Ahmedabad, Ấn Độ]]`, whatsapp: '' }) },
    vnTouch('newparts', 'New parts', 10, { attach: '🖼️ Product image (new range)' }),
    vnTouch('client', 'Become our client', 18, { attach: '🖼️ Product / sample image' }),
  ],
  calls: (m, ctx) => [{ label: 'Call — intro (EN + VI)', day: '3–5', script:
    `GỌI ĐIỆN / CALL — ${ctx.company || 'the company'} (${vnWhere(ctx)})\n\n` + vnFill(VN_CALL, m, ctx) }],
};

const CAMPAIGNS = {
  'khadya-khurak-exhibitors': exhibitors,
  'khadya-khurak-visitors': visitorsKK,
  'existing-customers': existingCustomers,
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
